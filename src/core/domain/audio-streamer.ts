import { Capacitor } from '@capacitor/core';
import {
  ensureNativeAudioTrack,
  flushNativeAudioTrack,
  writeNativeAudioChunk,
} from '../../lib/gapless-audio-native';
import { WORKLET_PROCESSOR_NAME, WORKLET_SOURCE } from './audio-worklet-processor';

// WebAudio Streamer for Gemini Live
// High-performance real-time audio pipeline:
// - 16kHz 16-bit Mono Linear PCM recording (optimized for Gemini input)
// - 24kHz 16-bit Mono Linear PCM playback (Gemini native audio response)
// - Android 7+ (Chromium WebView) compatible (Dual engine: AudioWorklet + ScriptProcessor fallback)
// - Real-time Audio Analyser for audio reactive UI waves and visualizer orb
//
// Capture engine (recording side): the BILLION-DOLLAR reason the live call used
// to hang is that every ~43ms (≈23 chunks/sec) the OLD ScriptProcessor ran the
// whole DSP — RMS, downsample-to-16k, float→PCM, base64 — on the single
// Capacitor WebView main thread, alongside typing, scrolling and React.
// Today the primary engine is a REAL AudioWorklet — the ENTIRE per-chunk DSP
// (RMS + downsample + float→PCM + base64, hang-fix P4) runs on the audio
// render thread; the main thread only forwards the ready base64 string.
// AudioWorklet predates some old WebViews, so ScriptProcessor remains as a
// silent fallback (with the heavy spots micro-optimized and buffer-reused).

export class AudioStreamer {
  // Do not let bursty network delivery turn into seconds of stale speech.
  // 2.5s (up from 1.25s): a short network burst no longer snips mid-word —
  // the queue is purged only when the backlog is genuinely stale.
  // A single long model reply can stream a lot of audio much faster than
  // real-time playback. Previously 2.5s: whenever the queued backlog grew past
  // that (i.e. any answer longer than ~2.5s of speech), the WHOLE queue was
  // flushed/dropped — so long spoken answers got cut after a couple of words /
  // sentences ("bada para aata hai par voice me bas kuch hi words"). That
  // suppression only made sense for genuinely stale audio, which is already
  // purged on every turn boundary / interruption via explicit flushPlayback()
  // calls. Bump the window high enough (60s) to cover any legitimately long
  // spoken reply without cutting it mid-sentence.
  private static readonly MAX_PLAYBACK_BACKLOG_SECONDS = 60;
  // ── Weak-network / long-reply stutter guard ──
  // Gemini streams audio as many small PCM chunks split across many WebSocket
  // messages. On a weak link those messages arrive in bursts with silent gaps.
  // If we schedule each chunk back-to-back off a single `nextPlayTime` chain,
  // the queue drains to `currentTime` mid-gap, then the next burst re-starts
  // with only ~25ms of lead → the hardware DAC underruns and you hear the
  // "cut cut" clicks, worst on long replies that span many messages.
  //
  // Proven architecture (community / WebAudio spec / Google Live API docs):
  //   • MDN: AudioBufferSourceNode is NOT built for network streaming; gapless
  //     joining of separate sources is not spec-guaranteed.
  //   • Use a receiver-side JITTER BUFFER: queue incoming chunks, feed the
  //     hardware on a smooth clock so irregular network arrival becomes uniform
  //     playback (WebRTC NetEQ pattern).
  //   • Startup/underrun guard: don't schedule a chunk that will end before the
  //     next one is ready — that clicks on every chunk boundary. Buffer a
  //     minimum first, then run with a comfortable lead over the DAC.
  private static readonly PRE_ROLL_MS = 60; // small initial lead so the DAC ramps smoothly
  private static readonly MIN_CHAIN_LEAD_MS = 20; // never schedule a burst dead-on `now`
  private static readonly SCHEDULE_AHEAD_SECONDS = 1.2; // keep ~1.2s of audio pre-scheduled
  private static readonly STARTUP_BUFFER_COUNT = 1; // start as soon as the first chunk is decoded
  // ── Adaptive weak-network buffering (low-bandwidth voice fix) ──
  // On a slow link the server's audio chunks arrive in bursts with silent gaps.
  // We LEARN the link is weak (repeated playback under-runs) and then:
  //   • hold the cold start until a small burst (~400ms) is queued, so the very
  //     first words of a reply never play into an empty buffer (the old "pehle
  //     ke words cutte hain" — STARTUP_BUFFER_COUNT=1 fired on the FIRST chunk);
  //   • on an under-run, wait for a short burst (~260ms) before resuming with a
  //     slightly larger lead — fewer, longer audio runs instead of word-level
  //     "atak atak" clipping. On a healthy link everything stays as before
  //     (immediate start, 20ms lead) so latency never regresses.
  // Native (Android GaplessAudioTrack) has no WebAudio scheduler — the track's
  // own internal buffer absorbs jitter, but a reply that STARTS with one lonely
  // chunk on a slow link still cuts the opening words. Hold the first write
  // until a small burst is buffered (or a hard cap passes — never stall longer
  // than this on a reply that genuinely wants to start).

  private audioContext: AudioContext | null = null;
  private micStream: MediaStream | null = null;
  private inputSource: MediaStreamAudioSourceNode | null = null;
  private inputAnalyser: AnalyserNode | null = null;
  // AUDIT FIX (round 2, MEDIUM): acquisition generation token. Two overlapping
  // startRecording() calls can interleave inside the `await ensureRunning()` /
  // `await tryInitWorklet()` windows — each wires its OWN capture nodes while
  // only the LAST refs are stored, so stopRecording() never detaches the first
  // graph and BOTH graphs stream (duplicate audio on the wire). Captured at
  // entry, checked after every await; a superseded acquisition tears down only
  // the nodes IT created and returns.
  private acquisitionGen = 0;
  private outputAnalyser: AnalyserNode | null = null;
  private scriptProcessor: ScriptProcessorNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  /** The AudioContext whose AudioWorkletGlobalScope already has our processor registered. */
  private workletModuleLoadedCtx: AudioContext | null = null;
  /** Which capture engine is live — 'worklet' (primary) or 'scriptprocessor' (fallback). */
  private captureEngine: 'worklet' | 'scriptprocessor' | 'idle' = 'idle';
  // Reusable scratch buffers for the ScriptProcessor fallback so a chunk never
  // allocates mid-capture (the old path churned 3 arrays + 2 strings × 23/sec).
  private downsampleScratch: Float32Array | null = null;
  private pcmScratch: Int16Array | null = null;

  private isRecording = false;
  private isMuted = false;
  private playbackSpeed = 1.0;
  private onAudioChunk?: (pcm16Base64: string, rmsLevel?: number) => void;
  private onInputLevel?: (level: number) => void;
  private onOutputLevel?: (level: number) => void;

  private nextPlayTime = 0;
  private activeSources: AudioBufferSourceNode[] = [];
  private levelInterval: number | null = null;
  private onPlaybackEnded?: () => void;
  private outputVolume = 1;
  private outputGainNode: GainNode | null = null;
  // Track whether the native gapless AudioTrack path is active (true when the
  // native plugin opened successfully and is the current playback sink). A null
  // means "not yet decided" — we try native on the first chunk, then commit.
  private nativeReady: boolean | null = null;
  // Receive-side jitter buffer: incoming decoded chunks wait here until the
  // scheduler feeds them to the DAC gaplessly. Absorbs weak-network gaps.
  private pendingChunks: AudioBuffer[] = [];
  private scheduleTimer: number | null = null;
  // ── Pending playback tracker (drain-aware hang-up: P10) ──
  // WebAudio is EXACT: incremented on schedule, decremented in each
  // source.onended — no wall-clock guessing, so a goodbye is never cut early.
  private pendingPlaybackMs = 0;
  // Native GaplessAudioTrack has no per-chunk end signal; instead of summing
  // durations (which over-counts when the decoder bursts faster than realtime
  // and would make waitForAudioDrained block the FULL 8s every native call),
  // we keep a rolling wall-clock DEADLINE: each write extends it to
  // now+chunkDur, and MODE_STREAM drains each chunk at DAC rate, so the tail
  // finishes ~one chunk after the last write. Best-effort, deliberate.
  private nativePlaybackDeadline = 0;

  setOutputVolume(volume: number): void {
    this.outputVolume = Math.max(0, Math.min(1, volume));
    if (this.outputGainNode && this.audioContext) {
      try {
        this.outputGainNode.gain.setValueAtTime(this.outputVolume, this.audioContext.currentTime);
      } catch {}
    }
  }

  setOnPlaybackEnded(cb?: () => void): void {
    this.onPlaybackEnded = cb;
  }

  constructor() {}

  setPlaybackSpeed(speed: number): void {
    if (speed >= 0.4 && speed <= 2.5) {
      this.playbackSpeed = speed;
    }
  }

  getPlaybackSpeed(): number {
    return this.playbackSpeed;
  }

  /**
   * AudioContext ko running banaye (autoplay unlock). Web Audio bina user-gesture
   * pe "suspended" hota hai — Android WebView me Capacitor default
   * mediaPlaybackRequiresUserGesture=false, par kuch ROMs/versions phir bhi
   * suspend reht hain. resume() ko await karke karte hain aur first call par
   * daur baar retry, taaki live-call ka mic + speaker kabhi silent na rahe.
   */
  private async ensureRunning(): Promise<void> {
    await this.getContext();
    if (this.audioContext && this.audioContext.state === 'suspended') {
      try {
        await this.audioContext.resume();
      } catch {
        // resume fail (policy) — dom first call par chalne denge
      }
      // Thoda sa rollback-resume retry: kuch devices pe resume promise resolve
      // hota hai par state 'running' nahi hota first-baar. 150ms pe dobara try.
      if (this.audioContext && this.audioContext.state === 'suspended') {
        await new Promise((r) => setTimeout(r, 150));
        try {
          await this.audioContext.resume();
        } catch {
          // no-op
        }
      }
    }
  }

  /**
   * AudioContext ko running banaye (autoplay unlock). Web Audio bina user-gesture
   * pe "suspended" hota hai — Android WebView me Capacitor default
   * mediaPlaybackRequiresUserGesture=false, par kuch ROMs/versions phir bhi
   * suspend rehte hain. Verified (web/webview reports): kuch Android WebViews me
   * AudioContext tab tak silent rehta hai jab tak koi HTML5 <audio> element
   * pehle na chalaya jaye. Isliye hum ek silent <audio> element (tiny silent
   * WAV data URI) play karke AudioContext ko unlock karte hain — versatile.
   */
  private htmlAudioUnlocked = false;
  private unlockViaHtmlAudio(): void {
    // CRITICAL (Android audio focus collision fix): On native Android (Capacitor),
    // playing an HTML5 <audio> element makes Chromium create an Android MediaPlayer
    // instance with USAGE_MEDIA audio focus. This conflicts directly with our
    // AudioRoutePlugin (USAGE_VOICE_COMMUNICATION) and causes Android to send an
    // AUDIOFOCUS_LOSS (-1) event that instantly killed the live call session!
    // On native, AudioRoutePlugin already acquired communication focus and
    // audioContext.resume() on user gesture is 100% sufficient without colliding.
    if (this.htmlAudioUnlocked || typeof window === 'undefined' || Capacitor.isNativePlatform()) return;
    try {
      // 20ms silent WAV — zero audible but counts as an audio-gesture playback,
      // aur browser WebView ke audio subsystem ko wake karta hai taaki baad ke
      // AudioContext nodes bhi reliably fire (browser fallback).
      const silentWav = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
      const el = new Audio(silentWav);
      el.volume = 0;
      void el.play().then(() => {
        this.htmlAudioUnlocked = true;
        // Audio element ka kaam bas unlock karna hai — turant pause karo.
        try { el.pause(); } catch {}
        // AudioContext agar abhi bhi suspended hai toh ab resume leke karo.
        if (this.audioContext && this.audioContext.state === 'suspended') {
          void this.audioContext.resume();
        }
      }).catch(() => {});
    } catch {
      // no-op — fallback abhi bhi (direct resume) kaam karega
    }
  }

  /** Get or create a unified AudioContext with native DAC scheduling. */
  private getContext(): AudioContext {
    this.unlockViaHtmlAudio();
    if (!this.audioContext || this.audioContext.state === 'closed') {
      const AudioContextClass =
        window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      // Use native device hardware sample rate (auto-resampling) for maximum compatibility on Android & Web
      this.audioContext = new AudioContextClass();

      this.outputAnalyser = this.audioContext.createAnalyser();
      this.outputAnalyser.fftSize = 256;
      this.outputAnalyser.smoothingTimeConstant = 0.8;
      this.outputAnalyser.connect(this.audioContext.destination);

      this.outputGainNode = this.audioContext.createGain();
      this.outputGainNode.gain.value = this.outputVolume;
      this.outputGainNode.connect(this.outputAnalyser);
    }
    if (this.audioContext.state === 'suspended') {
      void this.audioContext.resume();
    }
    return this.audioContext;
  }

  /** Start recording from microphone and stream 16kHz PCM chunks. */
  async startRecording(
    stream: MediaStream,
    onChunk: (pcm16Base64: string, rmsLevel?: number) => void,
    onInputLevel?: (level: number) => void,
    onOutputLevel?: (level: number) => void,
  ): Promise<void> {
    // The caller owns the MediaStream. Reconnects must detach nodes without
    // stopping the microphone tracks, otherwise the replacement session gets
    // a permanently ended stream.
    this.stopRecording(false);
    // AUDIT FIX (round 2): invalidate any previous in-flight acquisition BEFORE
    // the awaits below (a concurrent startRecording now supersedes us).
    this.acquisitionGen += 1;
    const gen = this.acquisitionGen;
    this.micStream = stream;
    this.onAudioChunk = onChunk;
    this.onInputLevel = onInputLevel;
    this.onOutputLevel = onOutputLevel;

    // Autoplay unlock — mic streaming ke liye AudioContext ko running hone do.
    await this.ensureRunning();
    const ctx = this.audioContext!;
    // A newer startRecording() (or stopRecording) landed while we awaited.
    if (gen !== this.acquisitionGen) return;

    // Local refs to the nodes THIS acquisition creates — a superseded call
    // must tear down exactly its own graph, never the successor's.
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    this.inputSource = source;
    this.inputAnalyser = analyser;

    // ── Capture engine ──
    const workletOk = await this.tryInitWorklet(ctx);
    // A newer acquisition (or a stop) landed while we booted the worklet —
    // detach our graph so the successor owns capture alone.
    if (gen !== this.acquisitionGen) {
      try { source.disconnect(); } catch {}
      return;
    }
    // The capture node (worklet or scriptprocessor) THIS acquisition creates.
    let localCaptureNode: AudioWorkletNode | ScriptProcessorNode | null = null;
    if (workletOk) {
      const workletNode = new AudioWorkletNode(ctx, WORKLET_PROCESSOR_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
      });
      localCaptureNode = workletNode;
      workletNode.port.onmessage = (e: MessageEvent) => {
        if (!this.isRecording || this.isMuted) return;
        const d = e.data as { kind?: string; b64?: string; pcm?: ArrayBuffer; outLen?: number; rms?: number };
        if (!d || d.kind !== 'chunk') return;
        // Hang-fix P4 primary contract: the processor posts the READY base64
        // string (encoded on the audio render thread). Backward-compat fallback
        // below also accepts the OLD `pcm`-transfer contract so a stale cached
        // worklet module (HMR/old WebView cache) can NEVER silently kill
        // capture — a mismatch here previously meant "Misa hears nothing".
        let wire = d.b64;
        if (!wire && d.pcm && d.outLen) {
          const bytes = new Uint8Array(d.pcm, 0, d.outLen * 2);
          if (bytes.byteLength === 0) return;
          wire = this.arrayBufferToBase64(bytes);
        }
        if (!wire) return;
        if (this.onAudioChunk) {
          this.onAudioChunk(wire, d.rms ?? 0);
        }
      };
      source.connect(workletNode);
      // Keep the graph pulling data through a zero-gain tap (same trick as the
      // ScriptProcessor path below: never route mic audio to the speakers).
      const zeroGain = ctx.createGain();
      zeroGain.gain.value = 0;
      workletNode.connect(zeroGain);
      zeroGain.connect(ctx.destination);
      this.workletNode = workletNode;
      this.captureEngine = 'worklet';
    } else {
      // ~43ms at 48kHz: substantially better turn-taking latency than 4096 while
      // still keeping message rate manageable for the Live WebSocket.
      const bufferSize = 2048;
      const scriptProcessor = ctx.createScriptProcessor(bufferSize, 1, 1);
      localCaptureNode = scriptProcessor;

      scriptProcessor.onaudioprocess = (e) => {
        if (!this.isRecording || this.isMuted) return;
        const inputData = e.inputBuffer.getChannelData(0);
        let sumSq = 0;
        for (let i = 0; i < inputData.length; i++) {
          sumSq += inputData[i] * inputData[i];
        }
        const rms = Math.sqrt(sumSq / inputData.length);
        const downsampled16k = this.downsampleTo16k(inputData, ctx.sampleRate);
        const pcm16 = this.floatTo16BitPCM(downsampled16k);
        // Reused scratch buffers: read views (no copies) straight into base64.
        const base64 = this.arrayBufferToBase64(
          new Uint8Array(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength),
        );
        if (this.onAudioChunk && base64) {
          this.onAudioChunk(base64, rms);
        }
      };

      source.connect(scriptProcessor);
      const zeroGain = ctx.createGain();
      zeroGain.gain.value = 0;
      scriptProcessor.connect(zeroGain);
      zeroGain.connect(ctx.destination);
      this.scriptProcessor = scriptProcessor;
      this.captureEngine = 'scriptprocessor';
    }

    // Final supersede check — a stop/restart landing during the wiring above
    // must not flip recording on for an already-replaced acquisition, and the
    // locally-created graph is detached so no orphaned node streams.
    if (gen !== this.acquisitionGen) {
      try { source.disconnect(); } catch {}
      if (localCaptureNode) { try { localCaptureNode.disconnect(); } catch {} }
      return;
    }
    this.isRecording = true;
    this.startLevelMonitoring();
  }

  /**
   * Try to boot the AudioWorklet capture engine.
   * Returns false (→ ScriptProcessor fallback) when the WebView doesn't expose
   * audioWorklet / AudioWorkletNode or addModule() fails for any reason.
   */
  private async tryInitWorklet(ctx: AudioContext): Promise<boolean> {
    try {
      const audioWorklet = (ctx as unknown as { audioWorklet?: { addModule?: (url: string) => Promise<void> } }).audioWorklet;
      if (!audioWorklet || typeof audioWorklet.addModule !== 'function') return false;
      if (typeof AudioWorkletNode === 'undefined') return false;
      if (typeof Blob === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return false;
      // Same context, already registered → skip addModule. Re-registering on
      // one scope throws NotSupportedError ("An AudioWorkletProcessor with
      // name:misa-audio-processor is already registered") and forces the
      // ScriptProcessor fallback — exactly the "worklet broke after reconnect"
      // regression seen in the field.
      if (this.workletModuleLoadedCtx === ctx) return true;
      const blob = new Blob([WORKLET_SOURCE], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      try {
        await audioWorklet.addModule(url);
        this.workletModuleLoadedCtx = ctx;
      } finally {
        URL.revokeObjectURL(url);
      }
      return true;
    } catch {
      return false;
    }
  }

  setMuted(muted: boolean): void {
    this.isMuted = muted;
    if (this.micStream) {
      this.micStream.getAudioTracks().forEach((track) => {
        track.enabled = !muted;
      });
    }
  }

  /** Direct hardware DAC scheduling with clean linear PCM streaming. */
  playAudioChunk(pcm24kBase64: string): void {
    // ── Native gapless path (Android) ──
    // On native, route the PCM to our GaplessAudioTrack plugin. AudioTrack
    // MODE_STREAM glues consecutive writes together so there are NO per-chunk
    // boundaries — the real "bubble-end / bade messages" stutter fix, which
    // WebAudio AudioBufferSourceNode chaining can not guarantee. Once native is
    // confirmed we deliberately bypass the WebAudio scheduler + jitter-buffer.
    if (Capacitor.isNativePlatform()) {
      if (this.nativeReady === null) {
        // First chunk on native: kick off the plugin open. Until it resolves we
        // fall through to WebAudio below so nothing is lost; once open, future
        // chunks stream gaplessly through native.
        this.nativeReady = false;
        void ensureNativeAudioTrack()
          .then((ok) => {
            this.nativeReady = ok;
            if (ok) {
              // AUDIT FIX (round 1, MEDIUM): do NOT drain pendingChunks here.
              // The WebAudio scheduler SHIFTS entries out as it hands them to an
              // AudioBufferSourceNode, so an entry still in the queue has NOT
              // been played yet — wiping the queue on a late native open clipped
              // the first ~0.2–1.5s of the opening reply. Leaving them lets the
              // scheduler finish them through the fallback (no double-play: the
              // queue is shift-exclusive; new chunks already go native).
            }
          })
          .catch(() => { this.nativeReady = false; });
      } else if (this.nativeReady) {
        // Native is live: enqueue fire-and-forget. If a write happens to fail,
        // the module already logged it; we keep the native path (best-effort).
        // No end-event from the AudioTrack → extend a rolling deadline so the
        // drain wait finishes ~one chunk after the last write, never a whole
        // reply duration later.
        const spent = atob(pcm24kBase64);
        const numSamples = Math.floor(spent.length / 2);
        if (numSamples > 0) {
          const speed = this.playbackSpeed && this.playbackSpeed > 0 ? this.playbackSpeed : 1.0;
          const nativeDurMs = (numSamples / 24000) * 1000 * (1 / speed);
          const deadline = Date.now() + nativeDurMs;
          this.nativePlaybackDeadline = Math.max(this.nativePlaybackDeadline, deadline);
        }
        void writeNativeAudioChunk(pcm24kBase64);
        return;
      }
    }

    const ctx = this.audioContext || this.getContext();
    if (!ctx || ctx.state === 'closed') return;

    let binary: string;
    try {
      binary = atob(pcm24kBase64);
    } catch {
      // Malformed server chunk — drop it instead of crashing playback.
      console.warn('[AudioStreamer] Dropping malformed audio chunk (bad base64).');
      return;
    }
    const numSamples = Math.floor(binary.length / 2);
    if (numSamples <= 0) return;

    // Decode straight into the AudioBuffer channel — one allocation + one loop,
    // no intermediate Float32Array + set() copy. Runs on the main thread but is
    // cheap on modern CPUs; the REAL cost on native is already bypassed by the
    // gapless AudioTrack path above, and this WebAudio path only serves the
    // web/browser fallback.
    const audioBuffer = ctx.createBuffer(1, numSamples, 24000);
    const channel = audioBuffer.getChannelData(0);
    let o = 0;
    for (let i = 0; i < numSamples; i++) {
      let sample = binary.charCodeAt(o) | (binary.charCodeAt(o + 1) << 8);
      o += 2;
      if (sample >= 32768) sample -= 65536;
      channel[i] = sample / 32768;
    }

    // Autoplay / background-tab safety: if the context is suspended (hidden
    // tab) the clock is frozen — queue the chunk anyway and re-kick the drain
    // once the context actually resumes (drainPendingChunks backs off until
    // the state is 'running', so nothing piles against a frozen clock).
    if (ctx.state === 'suspended') {
      void ctx.resume().then(() => this.kickScheduler()).catch(() => {});
    }

    // Jitter-buffer: decoded inline, then queued and fed to the DAC gaplessly by
    // the scheduler. The DRAINT-to-underrun scheduling (not the decode) was the
    // stutter culprit — that is what the queue + PRE_ROLL chain below fixes.
    this.pendingChunks.push(audioBuffer);
    this.kickScheduler();
  }

  // Schedule queued chunks onto the hardware clock. Runs the actual
  // source.start() work on a short timer so bursts of WebSocket messages that
  // arrive in the same tick are coalesced into ONE scheduling pass (fewer
  // source nodes, fewer boundaries) instead of one pass per chunk.
  private kickScheduler(): void {
    if (this.scheduleTimer !== null) return;
    this.scheduleTimer = window.setTimeout(() => {
      this.scheduleTimer = null;
      this.drainPendingChunks();
    }, 8);
  }

  private drainPendingChunks(): void {
    if (this.pendingChunks.length === 0) return;
    const ctx = this.audioContext;
    if (!ctx || ctx.state === 'closed') return;
    // Background-tab fix: a hidden tab SUSPENDS the AudioContext — the clock is
    // frozen, so scheduling ahead would either stack stale sources or burst-gibberish
    // on resume. Wait until the context is running again (resumeForVisibility()
    // re-kicks this drain from the visibilitychange handler).
    if (ctx.state !== 'running') return;

    const speed = this.playbackSpeed && this.playbackSpeed > 0 ? this.playbackSpeed : 1.0;

    if (!this.outputGainNode) {
      this.outputGainNode = ctx.createGain();
      this.outputGainNode.gain.value = this.outputVolume;
      this.outputGainNode.connect(this.outputAnalyser!);
    }

    const now = ctx.currentTime;
    // Stale-backlog safety: never play audio that is absurdly far behind.
    if (this.nextPlayTime - now > AudioStreamer.MAX_PLAYBACK_BACKLOG_SECONDS) {
      this.flushPlayback(false);
    }

    // ── Cold start vs. recovery ──
    // Cold start = a brand new reply: nextPlayTime was zeroed — either never
    // started, or the previous reply was flushed/interrupted/hung-up
    // (flushPlayback() zeroes it on turn boundary / interruption / hang-up).
    // Recovery = the ACTIVE chain drained below `now` mid-reply on a weak
    // network. The two differ: a fresh reply opens the DAC with a short PRE_ROLL
    // to avoid the very first click; a drained mid-reply CONTINUES with only a
    // minimal MIN_CHAIN_LEAD, deliberately NOT re-adding the full PRE_ROLL —
    // re-buffering on every gap was exactly what caused the mid-stream "cut cut".
    // Crucially, a drained mid-reply still has nextPlayTime > 0 (we never reset
    // it in onended), so it is NOT a cold start even though it is behind `now`.
    const isColdStart = this.nextPlayTime <= 0;

    // Don't fire a lone cold-start chunk until we're confident the next WS message
    // is coming — otherwise one chunk plays-and-ends before the next arrives.
    // (weak-network mid-reply recovery still starts immediately from `now`.)
    if (isColdStart && !this.activeSources.length && this.pendingChunks.length < AudioStreamer.STARTUP_BUFFER_COUNT) {
      return; // hold; kickScheduler() re-fires when more chunks arrive
    }

    if (isColdStart) {
      // Fresh reply: open the chain with a short PRE_ROLL so the DAC output graph
      // warms up smoothly and the very first source.start() doesn't click.
      this.nextPlayTime = now + AudioStreamer.PRE_ROLL_MS / 1000;
    } else if (this.nextPlayTime < now + AudioStreamer.MIN_CHAIN_LEAD_MS / 1000) {
      // Weak-network recovery: the chain drained to (or near) `now`. Re-open
      // directly with a small MIN_CHAIN_LEAD — we deliberately do NOT re-add the
      // full PRE_ROLL here, because re-buffering on every gap is what caused the
      // mid-stream "cut cut". Continuing with minimal lead keeps playback gapless.
      this.nextPlayTime = now + AudioStreamer.MIN_CHAIN_LEAD_MS / 1000;
    }

    // Feed the DAC at most SCHEDULE_AHEAD_SECONDS into the future so we never
    // over-buffer a long reply; remaining chunks stay in the jitter queue until
    // the next scheduling pass (which the natural beat of incoming WS messages
    // or a trailing timer re-triggers).
    let scheduled = 0;
    while (this.pendingChunks.length > 0) {
      // The while-guard guarantees a chunk exists; shift() still types undefined.
      const audioBuffer = this.pendingChunks.shift();
      if (!audioBuffer) break;
      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.playbackRate.value = speed;
      source.connect(this.outputGainNode);

      const playDuration = audioBuffer.duration / speed;
      // Background-tab fix: if source.start() throws (the hidden-tab clock froze
      // and this start time is already stale), DROP the chunk and continue with
      // the rest of the queue instead of crashing the whole drain — a stale
      // burst would be worse than one skipped chunk.
      try {
        source.start(this.nextPlayTime);
      } catch {
        try { source.stop(); } catch {}
        try { source.disconnect(); } catch {}
        continue;
      }
      this.nextPlayTime += playDuration;
      this.pendingPlaybackMs += playDuration * 1000;
      scheduled += playDuration;

      this.activeSources.push(source);
      source.onended = () => {
        const idx = this.activeSources.indexOf(source);
        // The source was already removed by flushPlayback() — never double-fire
        // onPlaybackEnded for the same stop (hidden-tab flush fires N+1 times
        // otherwise).
        if (idx === -1) return;
        this.activeSources.splice(idx, 1);
        // NOTE: we intentionally do NOT reset nextPlayTime here. The gapless chain
        // timeline (`nextPlayTime`) stays monotonic across the whole reply so a
        // weak-network gap doesn't force a cold re-buffer mid-stream (the cause of
        // stutter). nextPlayTime is only zeroed by flushPlayback() (interruption,
        // turn boundary, hang-up) — the correct place to reset the timeline.
        this.pendingPlaybackMs = Math.max(0, this.pendingPlaybackMs - playDuration * 1000);
        if (this.activeSources.length === 0) {
          this.onPlaybackEnded?.();
        }
      };

      if (scheduled >= AudioStreamer.SCHEDULE_AHEAD_SECONDS) break;
    }

    // If more audio remains queued, keep draining on a short timer.
    if (this.pendingChunks.length > 0 && this.scheduleTimer === null) {
      this.scheduleTimer = window.setTimeout(() => {
        this.scheduleTimer = null;
        this.drainPendingChunks();
      }, 16);
    }
  }

  /**
   * Background-tab recovery. The browser suspends the AudioContext while the
   * tab is hidden: `currentTime` freezes, so already-scheduled chunks are
   * stale and `onended` never fires (Misa's status stays stuck on
   * 'speaking'). When the user returns: flush the stale scheduled audio,
   * resume the context, and re-kick the drain so NEW replies play normally.
   */
  resumeForVisibility(): void {
    const ctx = this.audioContext;
    if (!ctx || ctx.state === 'closed') return;
    if (ctx.state !== 'running') {
      // Hidden-tab freeze: drop anything scheduled against the frozen clock
      // AND fire onPlaybackEnded so the caller's status returns to 'listening'.
      // A partial reply cut here is deliberate — a stale burst is far worse.
      this.flushPlayback(true);
      ctx
        .resume()
        .then(() => this.kickScheduler())
        .catch(() => {
          // Context may still be blocked (autoplay policy) — leave pending
          // chunks queued; a later visibility/input event re-kicks.
        });
    } else {
      this.kickScheduler();
    }
  }

  /** Immediately flush and stop active playback (e.g. on user interruption). */
  flushPlayback(notifyEnded = true): void {
    // Native gapless path: drop any PCM still queued on the AudioTrack and
    // reset the sink so a new reply starts from a clean gapless stream.
    if (this.nativeReady) {
      void flushNativeAudioTrack();
    }
    if (this.scheduleTimer !== null) {
      clearTimeout(this.scheduleTimer);
      this.scheduleTimer = null;
    }
    this.pendingChunks = [];
    for (const source of this.activeSources) {
      try {
        source.stop();
        source.disconnect();
      } catch {
        // Ignored
      }
    }
    this.activeSources = [];
    this.nextPlayTime = 0;
    this.pendingPlaybackMs = 0;
    this.nativePlaybackDeadline = 0;
    if (notifyEnded) this.onPlaybackEnded?.();
  }

  /**
   * Kitna Misa audio abhi bhi play hone ko baaki hai (ms).
   * - WebAudio path is EXACT (onended decrements).
   * - Native AudioTrack path is best-effort: a rolling deadline extended by
   *   each write — resolves ~one chunk after the last write (never the full
   *   reply duration, which would stall hang-ups by seconds).
   * Used by liveClient.waitForAudioDrained() to hang up only after the goodbye
   * audio has actually finished — never mid-word.
   */
  getPendingPlaybackMs(): number {
    const native = this.nativePlaybackDeadline > 0 ? this.nativePlaybackDeadline - Date.now() : 0;
    return Math.max(0, this.pendingPlaybackMs) + Math.max(0, native);
  }

  private startLevelMonitoring(): void {
    if (this.levelInterval !== null) return;
    const inputData = new Uint8Array(128);
    const outputData = new Uint8Array(128);

    this.levelInterval = window.setInterval(() => {
      if (this.inputAnalyser && this.onInputLevel) {
        this.inputAnalyser.getByteFrequencyData(inputData);
        let sum = 0;
        for (let i = 0; i < inputData.length; i++) sum += inputData[i];
        const avg = sum / inputData.length / 255;
        this.onInputLevel(this.isMuted ? 0 : avg);
      }
      if (this.outputAnalyser && this.onOutputLevel) {
        this.outputAnalyser.getByteFrequencyData(outputData);
        let sum = 0;
        for (let i = 0; i < outputData.length; i++) sum += outputData[i];
        const avg = sum / outputData.length / 255;
        this.onOutputLevel(avg);
      }
    }, 80);
  }

  stopRecording(stopTracks = false): void {
    // AUDIT FIX (round 2): stop() must void any in-flight startRecording() too.
    // Without the bump, a stop landing while startRecording awaited could let
    // the stale acquisition re-enable capture right after teardown.
    this.acquisitionGen += 1;
    this.isRecording = false;
    this.captureEngine = 'idle';
    if (this.levelInterval !== null) {
      clearInterval(this.levelInterval);
      this.levelInterval = null;
    }
    if (this.workletNode) {
      try {
        this.workletNode.port.onmessage = null;
        this.workletNode.disconnect();
      } catch {
        // already detached
      }
      this.workletNode = null;
    }
    if (this.scriptProcessor) {
      this.scriptProcessor.disconnect();
      this.scriptProcessor = null;
    }
    if (this.inputSource) {
      this.inputSource.disconnect();
      this.inputSource = null;
    }
    if (this.micStream && stopTracks) {
      this.micStream.getTracks().forEach((t) => t.stop());
    }
    this.micStream = null;
    // Orphan analyser node cleanup (never disconnected on stop before).
    if (this.inputAnalyser) {
      try { this.inputAnalyser.disconnect(); } catch {}
      this.inputAnalyser = null;
    }
    this.flushPlayback();
  }

  close(): void {
    this.stopRecording(true);
    if (this.outputGainNode) {
      try { this.outputGainNode.disconnect(); } catch {}
      this.outputGainNode = null;
    }
    if (this.outputAnalyser) {
      try { this.outputAnalyser.disconnect(); } catch {}
      this.outputAnalyser = null;
    }
    if (this.inputAnalyser) {
      try { this.inputAnalyser.disconnect(); } catch {}
      this.inputAnalyser = null;
    }
    if (this.audioContext && this.audioContext.state !== 'closed') {
      try { void this.audioContext.close(); } catch {}
      this.audioContext = null;
    }
    this.htmlAudioUnlocked = false;
    // Never re-validate `tryInitWorklet` against a dead context on a NEW one.
    this.workletModuleLoadedCtx = null;
  }

  // ===== Helper conversions =====

  /** Which capture DSP engine is live ('worklet' = primary, off-thread). */
  getCaptureEngine(): 'worklet' | 'scriptprocessor' | 'idle' {
    return this.captureEngine;
  }

  private downsampleTo16k(input: Float32Array, inputSampleRate: number): Float32Array {
    if (inputSampleRate === 16000) return input;
    const ratio = inputSampleRate / 16000;
    const newLength = Math.round(input.length / ratio);
    // Reuse one scratch buffer across chunks (fallback path) → zero GC churn.
    if (!this.downsampleScratch || this.downsampleScratch.length < newLength) {
      this.downsampleScratch = new Float32Array(newLength);
    }
    const result = this.downsampleScratch;
    let offsetResult = 0;
    let offsetInput = 0;
    while (offsetResult < newLength) {
      const nextOffsetInput = Math.round((offsetResult + 1) * ratio);
      let accum = 0;
      let count = 0;
      for (let i = offsetInput; i < nextOffsetInput && i < input.length; i++) {
        accum += input[i];
        count++;
      }
      result[offsetResult] = count > 0 ? accum / count : 0;
      offsetResult++;
      offsetInput = nextOffsetInput;
    }
    return result;
  }

  private floatTo16BitPCM(input: Float32Array): Int16Array {
    // Reuse one scratch buffer across chunks (fallback path) → zero GC churn.
    if (!this.pcmScratch || this.pcmScratch.length < input.length) {
      this.pcmScratch = new Int16Array(input.length);
    }
    const output = this.pcmScratch;
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      output[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return output.subarray(0, input.length);
  }

  /**
   * Uint8Array (typically a view over a reused PCM scratch) → base64 string.
   * Avoids the slow Array.from + String.fromCharCode.apply spread: apply works
   * directly on a TypedArray subarray, so no intermediate JS array is created.
   */
  private arrayBufferToBase64(bytes: Uint8Array): string {
    let binary = '';
    const len = bytes.byteLength;
    // apply accepts any array-like — typed-array subarray works without copying
    // into a plain JS array (lib.dom types it as number[]; the cast is sound).
    for (let i = 0; i < len; i += 8192) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192) as unknown as number[]);
    }
    return btoa(binary);
  }
}
