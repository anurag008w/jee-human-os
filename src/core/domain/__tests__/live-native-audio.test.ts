/**
 * Native gapless sink — pre-roll, fallback and level-meter regressions.
 *
 * These are the three things that made live-call voice arrive "cut-cut":
 *   1. the level meter fed the barge-in gate a dB-scaled FREQUENCY average while
 *      the gate's threshold was written for a time-domain RMS, so playback was
 *      flushed ~every 200ms;
 *   2. the native AudioTrack path bypassed the WebAudio jitter buffer entirely,
 *      leaving only the (previously ~250ms) track buffer between a network gap
 *      and an underrun;
 *   3. a failed native write was fire-and-forget, so a dead sink silently ate the
 *      rest of every reply instead of falling back.
 *
 * Node test env (no jsdom), so the Web/window globals the streamer touches are
 * stubbed the same way audio-streamer.test.ts does it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const native = vi.hoisted(() => ({
  isNative: vi.fn(() => true),
  ensureNativeAudioTrack: vi.fn(async () => true),
  writeNativeAudioChunk: vi.fn(async (_b64: string) => true),
  flushNativeAudioTrack: vi.fn(async () => {}),
  closeNativeAudioTrack: vi.fn(async () => {}),
  setNativeAudioTrackVolume: vi.fn(async () => {}),
  nativeGaplessActive: vi.fn(() => true),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => native.isNative() },
  registerPlugin: () => ({}),
}));

vi.mock('../../../lib/gapless-audio-native', () => ({
  ensureNativeAudioTrack: native.ensureNativeAudioTrack,
  writeNativeAudioChunk: native.writeNativeAudioChunk,
  flushNativeAudioTrack: native.flushNativeAudioTrack,
  closeNativeAudioTrack: native.closeNativeAudioTrack,
  setNativeAudioTrackVolume: native.setNativeAudioTrackVolume,
  nativeGaplessActive: native.nativeGaplessActive,
}));

import { AudioStreamer } from '../audio-streamer';

/** 24kHz mono int16 PCM as base64; `samples` ≈ `samples / 24` ms of audio. */
function pcm(samples: number, amplitude = 0.2): string {
  const bytes = new Uint8Array(samples * 2);
  for (let i = 0; i < samples; i++) {
    const v = Math.round(amplitude * 32767 * Math.sin(i * 0.35));
    bytes[i * 2] = v & 0xff;
    bytes[i * 2 + 1] = (v >> 8) & 0xff;
  }
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/** ~133ms of audio — the size Gemini Live chunks arrive in. */
const CHUNK = 3200;

function makeContext() {
  const sources: Array<{ start: (t: number) => void; stop: () => void; disconnect: () => void; onended: null | (() => void) }> = [];
  return {
    sources,
    ctx: {
      state: 'running',
      currentTime: 0,
      sampleRate: 48000,
      destination: {},
      createBuffer: (_ch: number, length: number, rate: number) => ({
        length,
        sampleRate: rate,
        duration: length / rate,
        getChannelData: () => new Float32Array(length),
      }),
      createBufferSource: () => {
        const node = {
          buffer: null as unknown,
          playbackRate: { value: 1 },
          connect: vi.fn(),
          disconnect: vi.fn(),
          stop: vi.fn(),
          onended: null as null | (() => void),
          start: vi.fn(),
        };
        sources.push(node);
        return node;
      },
      createGain: () => ({ gain: { value: 1, setValueAtTime: vi.fn() }, connect: vi.fn(), disconnect: vi.fn() }),
      createAnalyser: () => ({
        fftSize: 256,
        smoothingTimeConstant: 0.8,
        connect: vi.fn(),
        disconnect: vi.fn(),
        getByteTimeDomainData: vi.fn(),
        getByteFrequencyData: vi.fn(),
      }),
      resume: () => Promise.resolve(),
    },
  };
}

/**
 * `nativeReady === null` means "first chunk, still opening the plugin" — that
 * chunk deliberately falls through to WebAudio. Tests that exercise the sink
 * itself start with the sink already confirmed.
 */
function makeStreamer(nativeReady: boolean | null = true) {
  const { ctx, sources } = makeContext();
  const streamer = new AudioStreamer();
  Object.assign(streamer as unknown as Record<string, unknown>, { audioContext: ctx, nativeReady });
  return { streamer, sources, ctx };
}

/** Let the awaited `ensureNativeAudioTrack()` + promise chains settle. */
async function settle() {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

describe('AudioStreamer — native gapless sink', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as unknown as { window: unknown }).window = {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      setInterval: globalThis.setInterval,
      clearInterval: globalThis.clearInterval,
    };
    native.ensureNativeAudioTrack.mockClear();
    native.writeNativeAudioChunk.mockClear().mockImplementation(async () => true);
    native.flushNativeAudioTrack.mockClear();
    native.closeNativeAudioTrack.mockClear();
    native.setNativeAudioTrackVolume.mockClear();
    native.nativeGaplessActive.mockReturnValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as unknown as { window?: unknown }).window;
  });

  it('holds the cold start until a burst is buffered, then writes it in order', () => {
    const { streamer } = makeStreamer();
    const first = pcm(CHUNK);
    const second = pcm(CHUNK, 0.1);

    streamer.playAudioChunk(first); // ~133ms is not enough cushion to start on
    expect(native.writeNativeAudioChunk).not.toHaveBeenCalled();

    streamer.playAudioChunk(second); // ≈266ms ≥ NATIVE_PREROLL_MS → both flush at once
    expect(native.writeNativeAudioChunk).toHaveBeenCalledTimes(2);
    expect(native.writeNativeAudioChunk.mock.calls[0][0]).toBe(first);
    expect(native.writeNativeAudioChunk.mock.calls[1][0]).toBe(second);
  });

  it('releases a lone first chunk on a timer instead of stalling the reply forever', () => {
    const { streamer } = makeStreamer();
    streamer.playAudioChunk(pcm(CHUNK));
    expect(native.writeNativeAudioChunk).not.toHaveBeenCalled();

    vi.advanceTimersByTime(400);
    expect(native.writeNativeAudioChunk).toHaveBeenCalledTimes(1);
  });

  it('does not delay a mid-reply chunk once the sink is primed', () => {
    const { streamer } = makeStreamer();
    streamer.playAudioChunk(pcm(CHUNK));
    streamer.playAudioChunk(pcm(CHUNK)); // prime
    expect(native.writeNativeAudioChunk).toHaveBeenCalledTimes(2);

    streamer.playAudioChunk(pcm(CHUNK)); // streams straight through, no hold
    expect(native.writeNativeAudioChunk).toHaveBeenCalledTimes(3);
  });

  it('flushPlayback drops held chunks so a cut reply cannot leak into the next one', () => {
    const { streamer } = makeStreamer();
    streamer.playAudioChunk(pcm(CHUNK));
    streamer.flushPlayback(false);
    vi.advanceTimersByTime(1000);

    expect(native.writeNativeAudioChunk).not.toHaveBeenCalled();
    expect(native.flushNativeAudioTrack).toHaveBeenCalled();
  });

  it('falls back to WebAudio after repeated native write failures, and releases the dead sink', async () => {
    native.writeNativeAudioChunk.mockImplementation(async () => false);
    const { streamer, sources } = makeStreamer();

    streamer.playAudioChunk(pcm(CHUNK));
    streamer.playAudioChunk(pcm(CHUNK)); // primes → two writes → both fail
    await settle();

    expect((streamer as unknown as { nativeReady: boolean }).nativeReady).toBe(false);
    expect(native.closeNativeAudioTrack).toHaveBeenCalled();

    // New audio must now reach the WebAudio scheduler (3 chunks = its own
    // cold-start hold) instead of vanishing into a dead sink for the rest of the call.
    streamer.playAudioChunk(pcm(CHUNK));
    streamer.playAudioChunk(pcm(CHUNK));
    streamer.playAudioChunk(pcm(CHUNK));
    vi.advanceTimersByTime(20);
    expect(sources.length).toBeGreaterThanOrEqual(3);
    expect(native.writeNativeAudioChunk).toHaveBeenCalledTimes(2); // no further native writes
  });

  it('counts audio still inside the pre-roll hold as pending playback', () => {
    const { streamer } = makeStreamer();
    streamer.playAudioChunk(pcm(CHUNK));
    // A hang-up must wait for a held chunk too, or the goodbye loses its last words.
    expect(streamer.getPendingPlaybackMs()).toBeGreaterThanOrEqual(100);
  });

  it('applies the output volume to the native track (the WebAudio gain node is not the sink)', () => {
    const { streamer } = makeStreamer();
    streamer.playAudioChunk(pcm(CHUNK));
    streamer.setOutputVolume(0.5);
    expect(native.setNativeAudioTrackVolume).toHaveBeenCalledWith(0.5);
  });

  it('the very first chunk still falls through to WebAudio while the plugin opens', async () => {
    const { streamer, sources } = makeStreamer(null);
    streamer.playAudioChunk(pcm(CHUNK));
    streamer.playAudioChunk(pcm(CHUNK));
    streamer.playAudioChunk(pcm(CHUNK)); // WebAudio needs 3 to start
    await settle();
    vi.advanceTimersByTime(20);

    expect(native.ensureNativeAudioTrack).toHaveBeenCalledTimes(1);
    expect(sources.length).toBeGreaterThanOrEqual(3);
    expect(native.writeNativeAudioChunk).not.toHaveBeenCalled();
  });

  it('close() releases the native sink so the next call starts from an empty queue', async () => {
    const { streamer } = makeStreamer();
    streamer.playAudioChunk(pcm(CHUNK));
    streamer.playAudioChunk(pcm(CHUNK));
    await settle();
    streamer.close();
    await settle();

    expect(native.closeNativeAudioTrack).toHaveBeenCalledTimes(1);
    expect((streamer as unknown as { nativeReady: boolean | null }).nativeReady).toBeNull();
  });
});

describe('AudioStreamer — level meter (the metric the barge-in gate is built on)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function withAnalyser(fill: (out: Uint8Array) => void, opts: { muted?: boolean } = {}) {
    vi.useFakeTimers();
    (globalThis as unknown as { window: unknown }).window = {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      setInterval: globalThis.setInterval,
      clearInterval: globalThis.clearInterval,
    };
    const streamer = new AudioStreamer();
    const analyser = {
      fftSize: 256,
      getByteTimeDomainData: vi.fn(fill),
      getByteFrequencyData: vi.fn(),
      disconnect: vi.fn(),
    };
    const levels: number[] = [];
    Object.assign(streamer as unknown as Record<string, unknown>, {
      inputAnalyser: analyser,
      onInputLevel: (level: number) => levels.push(level),
      isMuted: opts.muted === true,
      isRecording: true,
    });
    (streamer as unknown as { startLevelMonitoring: () => void }).startLevelMonitoring();
    vi.advanceTimersByTime(80);
    delete (globalThis as unknown as { window?: unknown }).window;
    return { analyser, levels };
  }

  it('silence reads 0 — not the ~0.2 that a dB-scaled frequency average reported', () => {
    const { analyser, levels } = withAnalyser((out) => out.fill(128));

    expect(levels.length).toBe(1);
    expect(levels[0]).toBeCloseTo(0, 6);
    expect(analyser.getByteTimeDomainData).toHaveBeenCalled();
    // The metric that made every frame look like "the user is talking" is gone.
    expect(analyser.getByteFrequencyData).not.toHaveBeenCalled();
  });

  it('reads the true RMS of the waveform', () => {
    const { levels } = withAnalyser((out) => out.fill(128 + 45));

    expect(levels[0]).toBeCloseTo(45 / 128, 3);
    expect(levels[0]).toBeLessThan(0.4);
  });

  it('a muted mic must read exactly zero so it can never interrupt her', () => {
    const loud: number[] = [];
    const mutedStream = new AudioStreamer();
    Object.assign(mutedStream as unknown as Record<string, unknown>, {
      inputAnalyser: { fftSize: 256, getByteTimeDomainData: (out: Uint8Array) => out.fill(220), disconnect: vi.fn() },
      onInputLevel: (level: number) => loud.push(level),
      isMuted: true,
      isRecording: true,
    });
    vi.useFakeTimers();
    (globalThis as unknown as { window: unknown }).window = {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      setInterval: globalThis.setInterval,
      clearInterval: globalThis.clearInterval,
    };
    (mutedStream as unknown as { startLevelMonitoring: () => void }).startLevelMonitoring();
    vi.advanceTimersByTime(240);
    delete (globalThis as unknown as { window?: unknown }).window;

    expect(loud).toEqual([0, 0, 0]);
  });
});
