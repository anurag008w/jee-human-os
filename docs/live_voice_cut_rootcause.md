# Live call: "awaz cut-cut ke aati hai" — root-cause analysis (2026-09-12)

Symptom: Misa ki live-call voice beech mein bar-bar kat'ti hai (stutter/chop), mostly har reply pe,
Android app me. Niche 4 independent causes, ranked by how much of the symptom each explains, with
file:line proof. Nothing here is device-luck: cause #1 fires on every call.

Quick map of the path:

```
mic (getUserMedia, echoCancellation:true)                     ChatScreen.tsx:717-724
  → AudioWorklet capture (RMS + 16k downsample + base64)      audio-worklet-processor.ts
  → live-client.sendAudioChunk (RMS gates, barge-in)          live-client.ts:2586-2680
  ⇅ Gemini Live WS
model audio parts (24kHz PCM base64)                          live-client.ts:1560-1595
  → AudioStreamer.playAudioChunk
      ├─ native: GaplessAudioTrack.write (AudioTrack)          audio-streamer.ts:427-462
      └─ web:    WebAudio jitter buffer + scheduler            audio-streamer.ts:464-512
  → flushPlayback() ← called from 7 places                     live-client.ts:1541,1574,1786,1857,2492,2628,2807
```

---

## Cause #1 (PRIMARY, deterministic): barge-in VAD is fed a garbage level metric → playback is flushed every ~200ms while Misa speaks

The "voice cutting fix" is the 200ms barge-in debounce:

```ts
// src/core/domain/audio-streamer.ts:712-719  (startLevelMonitoring, every 80ms)
this.inputAnalyser.getByteFrequencyData(inputData);
let sum = 0;
for (let i = 0; i < inputData.length; i++) sum += inputData[i];
const avg = sum / inputData.length / 255;
this.onInputLevel(this.isMuted ? 0 : avg);
```

```ts
// src/core/domain/live-client.ts:2481-2496
(inputLevel) => {
  const talking = inputLevel > 0.035;
  this.isUserTalkingOverThreshold = talking;
  if (talking) {
    if (!this.userInterruptStreakStartedAt) this.userInterruptStreakStartedAt = Date.now();
    if (this.status === 'speaking' && Date.now() - this.userInterruptStreakStartedAt >= 200) {
      this.userInterruptStreakStartedAt = Date.now();
      this.audioStreamer.flushPlayback();     // ← kills her own voice, mid-word
      this.setStatus('listening');
    }
  } else { this.userInterruptStreakStartedAt = 0; }
```

`inputAnalyser.fftSize = 256` (`audio-streamer.ts:281`) → 128 bins of **frequency** data.
`getByteFrequencyData` is not an amplitude meter: per spec each bin is a **dB value mapped from
`[minDecibels=-100, maxDecibels=-30]` onto 0…255**. So:

* −84 dBFS (a near-silent room, ADC noise floor) → `bin ≈ 58`
* −65 dBFS (speaker playing Misa at normal volume, 30–60 cm away) → `bin ≈ 127`
* The code then averages over 128 bins and divides by 255, and compares with a threshold (`0.035`)
  that was clearly written for a **time-domain RMS**.

`avg > 0.035` ⇔ `Σ(bins) > 1142` ⇔ roughly **20 bins sitting at −84 dBFS**. i.e. the "user is talking"
detector trips on the noise floor, and sits far above it whenever the loudspeaker is playing.

Result while Misa speaks (mic is open — it must stay open for barge-in):

1. `talking === true` continuously → every 200 ms: `flushPlayback()` + `setStatus('listening')`.
2. Next audio part arrives → `setStatus('speaking')` (`live-client.ts:1551`) → 200 ms later flush again.
3. `flushPlayback()` empties the whole queue (`pendingChunks = []`), stops every scheduled source and
   hard-cuts the native track → the listener hears ~1 chunk (100–200 ms) of speech, then a hole,
   then ~1 chunk, then a hole. **That is the "cut-cut".**
4. Because `userInterruptStreakStartedAt` is re-armed on each flush, it never "settles" — the chopping
   continues for as long as the reply plays.

Same garbage metric also breaks the two-tier echo gate that was supposed to protect playback:

```ts
// live-client.ts:2613-2617
const inPlaybackCooldown = now < this.playbackCooldownUntil;
const isSpeech = inPlaybackCooldown
  ? rmsLevel > 0.055 || this.isUserTalkingOverThreshold   // ← 0.035-based flag ORed in
  : rmsLevel > 0.032 || this.isUserTalkingOverThreshold;
```

`isUserTalkingOverThreshold` is derived from the same inflated metric, so raising the threshold to
0.055 during the 1.5 s post-playback echo cooldown **changes nothing** — `isSpeech` is true either way.
Consequences: echo/noise is uploaded to the model as if it were the user (⇒ she hears herself, answers
herself), `lastUserVoiceTime`/`silenceStateMachine.onSpeechActivity()` are refreshed forever (⇒ silence
nudges never fire), and the server VAD starts its own interruptions →
`serverContent.interrupted` → another `flushPlayback()` (`:1541`) + `[interrupted]` in the transcript.
So each syllable can be cut twice.

Why nobody caught it: no test touches `onInputLevel`/`0.035` (`grep` in `src/core/domain/__tests__` → zero
hits), and `audio-streamer.test.ts` covers only the WebAudio scheduler. The metric also drives the UI
level meter (`updateStats(inputLevel, 0)`, `:2502`), which is why the orb/wave jumps even when nobody speaks.

### Patch #1 (minimal, high confidence)

**Preferred shape — delete the duplicate barge-in instead of tuning it.** `live-client.ts:2481-2496`
(analyser-driven) and `:2613-2632` (`sendAudioChunk`, worklet-RMS-driven) implement the *same* 200 ms
debounce, but only the second one has a trustworthy signal: the worklet computes a real time-domain RMS
on the audio thread (`audio-worklet-processor.ts` → `onAudioChunk(wire, d.rms)`) and it is the value the
thresholds (0.032 / 0.055) were written for. The analyser copy is both redundant and built on the wrong
metric. So: drop the flush at `:2492` (keep the analyser level for the UI meter only), and keep the
`sendAudioChunk` path as the single barge-in decision.

```ts
// audio-streamer.ts — if the meter itself is kept, measure what the threshold assumes:
const timeData = new Uint8Array(analyser.fftSize);          // 256, not 128!
this.inputAnalyser.getByteTimeDomainData(timeData);          // NOT getByteFrequencyData
let sumSq = 0;
for (let i = 0; i < timeData.length; i++) { const v = (timeData[i] - 128) / 128; sumSq += v * v; }
const level = Math.sqrt(sumSq / timeData.length);            // real 0..1 RMS
// same treatment for outputAnalyser → onOutputLevel (currently always 0 on native — see Patch #4)
```

**Then add a far-end reference so echo can't interrupt (this is the part that actually fixes the
device-dependent half).** While she is speaking we have her own PCM in hand: `playAudioChunk` already
`atob()`-decodes every chunk just to estimate duration (`audio-streamer.ts:453-456`), so an RMS of the
far-end signal is ~free there:

```ts
// audio-streamer.ts, inside the nativeReady branch (replace the throwaway atob):
const bin = atob(pcm24kBase64);
let sq = 0; const n = Math.floor(bin.length / 2);
for (let i = 0; i < n; i++) {
  let s = bin.charCodeAt(i * 2) | (bin.charCodeAt(i * 2 + 1) << 8);
  if (s >= 32768) s -= 65536;
  sq += (s / 32768) ** 2;
}
this.noteOutputRms(Math.sqrt(sq / Math.max(1, n)));   // rolling ~150ms window, also fixes the dead orb meter
```

```ts
// live-client.ts — barge-in only when the near-end clearly dominates the far-end
const farEnd = this.audioStreamer.getRecentOutputRms();        // 0 when she is not playing
const dominates = rmsLevel > Math.max(0.06, farEnd * 2.5);     // echo ≈ farEnd → never passes
const inCooldown = now < this.playbackCooldownUntil;
const isSpeech = dominates && !inCooldown;                      // drop the meter-flag OR entirely
// sustain 200ms → 320ms, and never re-arm a flush faster than every 400ms
```

Also: stop ORing `isUserTalkingOverThreshold` into `isSpeech` (`:2616-2617`) — it silently defeats the
0.055 cooldown threshold that the comment above it advertises.

---

## Cause #2: the native playback path has **no jitter buffer at all** — the anti-stutter machinery exists but Android bypasses it

`playAudioChunk` routes to the native track and returns *before* the WebAudio scheduler:

```ts
// audio-streamer.ts:427-462
if (Capacitor.isNativePlatform()) {
  …
  } else if (this.nativeReady) {
    …
    void writeNativeAudioChunk(pcm24kBase64);
    return;                       // ← PRE_ROLL / STARTUP_BUFFER_COUNT / MIN_CHAIN_LEAD / SCHEDULE_AHEAD all skipped
  }
}
```

Those constants (`audio-streamer.ts:57-60`) and the adaptive weak-network recovery were written exactly
for the "cut cut clicks" symptom — their own comment says so: *"the queue drains to `currentTime`
mid-gap … the hardware DAC underruns and you hear the 'cut cut' clicks, worst on long replies"*. On
Android the fix is inert, and the only cushion left is the AudioTrack buffer:

```java
// GaplessAudioTrackPlugin.java:76-77
int minBuf = AudioTrack.getMinBufferSize(sampleRate, CHANNEL_CONFIG, ENCODING);
int bufSize = Math.max(minBuf, sampleRate / 2);   // ~250ms of PCM
```

So any >250 ms gap in WS delivery (normal on mobile data / a bursty gateway) = underrun = silence hole.
There is also no pre-roll on the first chunks of a reply (WebAudio holds `STARTUP_BUFFER_COUNT = 3`
chunks first; native plays chunk #1 straight into a nearly empty track) → the opening syllable of each
reply is the most likely to be mangled — matching "pehle ke words katte hain".

### Patch #2 — give the native sink the same buffering

```ts
// audio-streamer.ts, in the nativeReady branch: hold until ~250ms is queued, and
// after an underrun (measured by pendingPlaybackMs hitting 0 mid-turn) re-prime.
if (this.nativeReady) {
  this.nativePending.push(pcm24kBase64);                    // small JS-side pre-roll ring
  const queuedMs = this.nativePending.reduce(msOf, 0);
  if (queuedMs < (this.nativePrimed ? 120 : 260)) return;    // cold start: 260ms, resume: 120ms
  while (this.nativePending.length) void writeNativeAudioChunk(this.nativePending.shift()!);
  this.nativePrimed = true;
  return;
}
```
(and on `flushPlayback()` / turn end: `nativePrimed = false`, `nativePending.length = 0`.)

Optionally raise `bufSize` to `sampleRate` (~500 ms) in `GaplessAudioTrackPlugin.open()` — latency cost
is only paid on the *buffer*, `MODE_STREAM` writes still start immediately; 500 ms is the right trade
for a voice call over mobile data if barge-in latency is handled by the flush instead.

---

## Cause #3: every cut is harsher than it needs to be — flush is a hard digital cut, and short writes throw away the rest of the chunk

* `flushNativeAudioTrack()` → `t.pause(); t.flush(); t.play()` (`GaplessAudioTrackPlugin.java:157-171`).
  `AudioTrack.flush()` discards everything already written but not yet rendered (up to the full 250 ms
  buffer) and there is **no gain ramp anywhere** → each cut is an instant discontinuity = audible click
  + lost words, not a clean fade.
* `drainLoop()` treats a short/zero write as fatal **for that chunk**:

```java
int n = t.write(chunk, written, chunk.length - written);
if (n <= 0) break;   // ← drops the remainder of the 100ms of speech, instead of retrying
```

`write()` in blocking mode returns 0/short exactly when the track was paused/stopped or underran —
i.e. concurrently with `flush()` (there is **no lock** between the flush path and the writer thread).
So every flush also *deletes* part of the reply that was already handed to the sink. That converts a
200 ms cut into "200 ms cut + up to 130 ms of discarded speech" per event.

### Patch #3
```java
// retry a short write instead of bailing; and make flush() not race the writer
int guard = 0;
while (written < chunk.length && !closed.get() && guard++ < 8) {
    int n = t.write(chunk, written, chunk.length - written);
    if (n > 0) { written += n; continue; }
    if (t.getPlayState() != AudioTrack.PLAYSTATE_PLAYING) { t.play(); }
    try { Thread.sleep(4); } catch (InterruptedException ie) { return; }
}
```
* `flush()`/`closeTrackInternal()` must take the same monitor the writer uses (or use a generation
  counter and let the writer skip stale chunks) — this also removes the `release()`-while-writing crash.
* Ramp the last/first 5 ms to zero (multiply the int16 window) around every flush+resume so cuts don't click.

---

## Cause #4: the native sink is a process-wide singleton that is never closed, never re-opened, and never falls back

* `closeNativeAudioTrack()` (`src/lib/gapless-audio-native.ts:111-119`) **has zero callers.** The Java track
  is therefore opened once (first chunk of the first call) and reused for the life of the process; the
  writer thread and `pending` queue are never torn down.
* `AudioStreamer.nativeReady` is per-instance (a new `AudioStreamer` per `GeminiLiveClient`,
  `live-client.ts:138`), while `nativeOpened` is module-global. So `flushPlayback()` skips the native
  flush whenever `nativeReady` is falsy on the *current* instance
  (`audio-streamer.ts:669: if (this.nativeReady) { void flushNativeAudioTrack(); }`) — which is exactly
  the case right after a reconnect/new call. Leftover PCM from the previous turn/call stays in the Java
  `pending` queue and is played **at the start of the next reply** → garbled/cut opening + a burst that
  floods the 250 ms buffer.
* A failed native write is swallowed and the chunk is lost: `playAudioChunk` does
  `void writeNativeAudioChunk(…); return;` (`:458-460`) even though the helper returns `false` on
  `!nativeOpened` or on a plugin error, and the comment in `gapless-audio-native.ts:88-91` claims
  "we drop back to WebAudio" — that fallback does not exist. Any hiccup (or `handleOnDestroy()`
  releasing the track after an Activity recreation — PiP/rotation during a call, see MainActivity finding
  in the main scan) ⇒ **all remaining audio for the call goes to a dead sink**: intermittent/partial
  audio rather than clean silence.
* `setOutputVolume()` (`audio-streamer.ts:134-142`) and the ducking calls (`live-client.ts:2832,2850`)
  only touch `outputGainNode` in the WebAudio graph — on the native path the signal never passes through
  it, so ducking/volume are no-ops on Android (the CAN_DUCK handler even comments "so AI speech remains
  audible and doesn't sound chopped" while doing nothing).

### Patch #4
* Call `closeNativeAudioTrack()` on hangup (`LiveCompanionOverlay` teardown / `AudioStreamer.close()`),
  and make `ensureNativeAudioTrack()` re-open per call so `pending` starts empty.
* Have `flushPlayback()` flush the native sink unconditionally when `Capacitor.isNativePlatform()`
  (`nativeGaplessActive()`), not only when this instance's `nativeReady` is true.
* If `writeNativeAudioChunk()` resolves `false` twice in a row, set `this.nativeReady = false` and let
  the WebAudio path take over for the rest of the call (that is what the comment promises).
* Route native volume through a real control: either `AudioTrack.setVolume()` on the track, or keep the
  WebAudio graph as the sole output when ducking/volume matters.

---

## Cause #5 (why echo makes it much worse, and why it varies per phone)

`getUserMedia` is opened with `echoCancellation: true` (`ChatScreen.tsx:721-723`,
`LivePermissionModal.tsx:59-61`) — but Chromium's AEC can only cancel what **it** renders. Since the TTS
output is a *separate native AudioTrack*, the AEC has no reference signal; and the app never installs a
platform canceler either — `AudioRoutePlugin` handles focus/mode/route only (no
`AcousticEchoCanceler`/`NoiseSuppressor` on the capture session), and `GaplessAudioTrackPlugin.open()`
builds the track without sharing the capture audio session
(`AudioAttributes` has no `setSessionId(...)`, no `setPerformanceMode(PERFORMANCE_MODE_LOW_LATENCY)`).
So echo cancellation is entirely up to whether the HAL applies its comm-mode AEC to a
`USAGE_VOICE_COMMUNICATION` track while `setCommunicationDevice(built-in speaker)` is active —
device-dependent. That is exactly the pattern reported: some phones "sound fine-ish", others chop constantly.
Cause #1 is what turns that echo into a guaranteed 5 Hz cut loop; on a phone where the HAL does cancel the
echo, #1 still fires (noise floor alone crosses 0.035 in that metric), just less aggressively.

Cheap robust mitigations, in order of effort:
1. Patch #1 (correct metric + output-referenced gating) — kills the self-interrupt loop on every device.
2. While `status === 'speaking'`, require the *near-end to dominate the far-end* (compare `onInputLevel`
   with `onOutputLevel` — fix the output analyser first, Patch #4) instead of a fixed absolute threshold.
3. Give the WebView an AEC reference: play the reply through WebAudio *and* keep the native track muted as
   the audible sink is impossible; so instead either (a) keep WebAudio as the only output on Android and
   use the native track only when the WebAudio context is suspended/background, or (b) create the
   AudioTrack with `setPerformanceMode(MODE_LOW_LATENCY)` + capture `AudioRecord` session sharing is not
   available from a WebView — so (a) is the pragmatic route; or (c) add a native `AcousticEchoCanceler`
   on whatever session `AudioManager.generateAudioSessionId()` you attach to **both** the track and a
   native `AudioRecord`-based capture (bigger change, replaces WebView capture).
4. UX guard rail while all this is fixed: a "Tap to interrupt" mode (disable the automatic local flush
   entirely, keep server VAD). One boolean in `config` — worth shipping behind Live Settings immediately.

---

## 30-second field confirmation (no rebuild needed for #1)

1. **A/B the metric:** temporarily set `const talking = inputLevel > 0.9;` (`live-client.ts:2482`) and
   comment out the `flushPlayback()` at `:2492`. Rebuild → speak over her reply on purpose: if the
   chopping is gone (and only real, loud interruptions cut her), Cause #1 is confirmed as primary.
2. **A/B the sink:** set `NATIVE_GAPLESS_ENABLED = false` (`src/lib/gapless-audio-native.ts:44`).
   If the stutter pattern changes (holes become smaller/less frequent, or long replies get smoother),
   Causes #2/#3/#4 are contributing on that device.
3. **Check the meter while silent:** if the input-level UI (`updateStats`) moves while nobody speaks,
   the metric is inflated — Cause #1, no build needed.
4. Log `this.audioStreamer.getCaptureEngine()`: `scriptprocessor` on a low-end device adds main-thread
   pressure per chunk and worsens #2's underruns (that is the documented hang path).

## Test plan for the fix

* Unit: fake `AnalyserNode.getByteTimeDomainData` returning silence (128) → `onInputLevel` must be ~0 and
  `talking` false; returning a speech-like wave → level ~0.1-0.3, `talking` true. (Locks Patch #1.)
* Unit: drive `onInputLevel(0.4)` at 80 ms intervals while `status === 'speaking'` with output level 0
  → expect at most ONE flush per 400 ms window, and zero flushes while `playbackCooldownUntil` is active
  and output is non-zero. (Locks Patch #1's gating.)
* Unit: `writeNativeAudioChunk` resolving `false` twice → `nativeReady` becomes false and the next chunk
  reaches `ctx.createBuffer` (Patch #4 fallback).
* Unit (native-side logic, JS mirror): with `nativePending` mocked, a 500 ms arrival gap must not produce
  a write until 260 ms is queued, and must re-prime after underrun (Patch #2).
* Device matrix (from the last audit's plan): quiet room / TV playing / speakerphone on / BT SCO /
  rotation mid-call / PiP background 30 s / hangup + immediate re-launch (the stale-`pending` case).
