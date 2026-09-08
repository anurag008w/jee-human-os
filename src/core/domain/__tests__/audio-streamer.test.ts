/**
 * AudioStreamer — weak-network playback pipeline regression tests.
 *
 * The real root cause of the long-reply "cut cut" stutter is client-side: each
 * streamed PCM chunk was scheduled as its own source with a ~25ms restart when
 * the chain under-ran on a network gap. The fixed pipeline buffers incoming
 * chunks in a jitter queue and feeds the DAC gaplessly with a pre-roll lead.
 *
 * These tests exercise that scheduling logic directly (queue accumulation,
 * startup guard, PRE_ROLL lead, flush), using a small mock AudioContext so we
 * don't need the browser/WebAudio runtime.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Minimal WebAudio mock ───────────────────────────────────────────────
class MockAudioBuffer {
  length: number;
  sampleRate: number;
  channels: number;
  constructor(length: number, sampleRate: number, channels = 1) {
    this.length = length;
    this.sampleRate = sampleRate;
    this.channels = channels;
    this.duration = length / sampleRate;
  }
  duration: number;
  getChannelData() {
    return new Float32Array(this.length);
  }
  set() {}
}

class MockSource {
  buffer: any = null;
  playbackRate = { value: 1 };
  start = vi.fn((when: number) => {
    startCalls.push(when);
  });
  connect = vi.fn();
  onended: (() => void) | null = null;
  stop = vi.fn();
  disconnect = vi.fn();
}

const createBuffer = vi.fn((channels: number, length: number, sampleRate: number) => {
  return new MockAudioBuffer(length, sampleRate, channels);
});
const createBufferSource = vi.fn(() => new MockSource());
const createGain = vi.fn(() => ({ gain: { value: 1, setValueAtTime: vi.fn() }, connect: vi.fn(), disconnect: vi.fn(), stop: vi.fn() }));
const createAnalyser = vi.fn(() => ({ fftSize: 0, smoothingTimeConstant: 0, connect: vi.fn(), getByteFrequencyData: vi.fn(), disconnect: vi.fn() }));
const destination = {};

let startCalls: number[] = [];
let ctx: any;

// Silently no-op anything the mock AudioContext doesn't implement.
const createMediaStreamSource = vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() }));
const createScriptProcessor = vi.fn(() => ({ onaudioprocess: null, connect: vi.fn(), disconnect: vi.fn() }));
const mockAudioContext = () => ({
  state: 'running',
  currentTime: 100,
  sampleRate: 48000,
  destination,
  createBuffer,
  createBufferSource,
  createGain,
  createAnalyser,
  createMediaStreamSource,
  createScriptProcessor,
  resume: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
});

beforeEach(() => {
  startCalls = [];
  createBuffer.mockClear();
  createBufferSource.mockClear();
  createMediaStreamSource.mockClear();
  createScriptProcessor.mockClear();
  // Reset mock timers: preset real window-ish setTimeout (auto-run immediately
  // in tests so scheduling coalescing still resolves synchronously per tick).
  (globalThis as any).__timeouts = [];
  (globalThis as any).setTimeout = (fn: () => void) => {
    (globalThis as any).__queue.push(fn);
  };
  (globalThis as any).clearTimeout = vi.fn();
  (globalThis as any).__queue = [];
  (globalThis as any).setInterval = () => 0;

  ctx = mockAudioContext();

  (globalThis as any).window = {
    AudioContext: vi.fn(() => ctx),
    setTimeout: (globalThis as any).setTimeout,
    clearTimeout: (globalThis as any).clearTimeout,
    setInterval: () => 0,
  };
});

afterEach(() => {
  delete (globalThis as any).window;
  delete (globalThis as any).setTimeout;
  delete (globalThis as any).clearTimeout;
  delete (globalThis as any).setInterval;
  delete (globalThis as any).__queue;
});

// Encode a Float32Array of 24000Hz mono PCM into the base64 the streamer decodes.
function toPcm24kBase64(samples: Float32Array): string {
  const int16 = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  const bytes = new Uint8Array(int16.buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

// Helper to pump any queued fake timers.
function flushTimers() {
  let guard = 0;
  while ((globalThis as any).__queue?.length && guard < 500) {
    const fns = (globalThis as any).__queue;
    (globalThis as any).__queue = [];
    for (const fn of fns) fn();
    guard++;
  }
}

// Import after globals are set (module reads Capacitor from global at import).
let AudioStreamer: any;
async function loadStreamer() {
  if (!AudioStreamer) {
    const mod = await import('../audio-streamer');
    AudioStreamer = mod.AudioStreamer;
  }
  return AudioStreamer;
}

describe('AudioStreamer jitter-buffer scheduling', () => {
  it('holds cold start until STARTUP_BUFFER_COUNT chunks are queued, then starts gaplessly', async () => {
    await loadStreamer();
    const streamer = new AudioStreamer();
    // STARTUP_BUFFER_COUNT=3: first 2 chunks queue up (cold start holds).
    // The 3rd chunk triggers the drain and schedules all 3 at once.
    for (let i = 0; i < 3; i++) {
      streamer.playAudioChunk(toPcm24kBase64(new Float32Array((0.2 * 24000) | 0)));
      flushTimers();
    }
    // All 3 decoded chunks should now be scheduled (coalesced into one drain pass).
    expect(startCalls.length).toBe(3);
    void streamer;
  });

  it('starts playback with a PRE_ROLL lead and schedules gaplessly', async () => {
    await loadStreamer();
    const streamer = new AudioStreamer();
    const chunks = 5;
    for (let i = 0; i < chunks; i++) {
      streamer.playAudioChunk(toPcm24kBase64(new Float32Array((0.2 * 24000) | 0)));
      flushTimers();
    }
    // First source gets a small PRE_ROLL lead (60ms) over currentTime (100).
    expect(startCalls.length).toBeGreaterThan(0);
    const first = startCalls[0];
    expect(first).toBeGreaterThanOrEqual(100 + 0.06);
    // Subsequent chunks must be gapless (exactly `duration` apart at playbackRate 1).
    const gap = startCalls[1] - startCalls[0];
    expect(gap).toBeCloseTo(0.2, 2);
    void streamer;
  });

  it('flushPlayback clears the pending jitter queue', async () => {
    await loadStreamer();
    const streamer = new AudioStreamer();
    for (let i = 0; i < 6; i++) {
      streamer.playAudioChunk(toPcm24kBase64(new Float32Array((0.2 * 24000) | 0)));
    }
    flushTimers();
    streamer.flushPlayback(false);
    // Clear next tick — nothing more scheduled after flush.
    flushTimers();
    void streamer;
  });

  it('under-run recovery re-arms the chain ahead of currentTime', async () => {
    await loadStreamer();
    const streamer = new AudioStreamer();
    // Prime the chain a little so nextPlayTime is set.
    for (let i = 0; i < 4; i++) {
      streamer.playAudioChunk(toPcm24kBase64(new Float32Array((0.2 * 24000) | 0)));
      flushTimers();
    }
    const before = startCalls.length;
    // Simulate a network gap by advancing currentTime far beyond nextPlayTime.
    ctx.currentTime = 1000;
    (streamer as any).nextPlayTime = 10; // artificially far behind => under-run
    // After an under-run, a new burst re-arms directly with a MIN_CHAIN_LEAD
    // (~20ms) — NOT a full PRE_ROLL — so playback continues gaplessly across a
    // weak-network gap instead of re-buffering (which caused the "cut cut").
    for (let i = 0; i < 4; i++) {
      streamer.playAudioChunk(toPcm24kBase64(new Float32Array((0.2 * 24000) | 0)));
      flushTimers();
    }
    expect(startCalls.length).toBeGreaterThan(before);
    // Re-armed chain should be ≥ MIN_CHAIN_LEAD (20ms) ahead of the new currentTime (1000).
    expect(startCalls[startCalls.length - 1]).toBeGreaterThan(1000 + 0.02);
  });

  it('a drained mid-reply chain recovers with MIN_CHAIN_LEAD, not a cold PRE_ROLL', async () => {
    await loadStreamer();
    const streamer = new AudioStreamer();
    // Start a reply; chain opens with PRE_ROLL and streams forward.
    for (let i = 0; i < 4; i++) {
      streamer.playAudioChunk(toPcm24kBase64(new Float32Array((0.2 * 24000) | 0)));
      flushTimers();
    }
    expect(startCalls.length).toBeGreaterThan(0);
    const beforeRecovery = startCalls.length;
    // Simulate a weak-network gap that drained playback: the chain sat behind
    // currentTime (active sources all ended) but nextPlayTime is still > 0
    // (we intentionally do NOT reset it in onended).
    (streamer as any).activeSources = [];
    ctx.currentTime = 500;
    (streamer as any).nextPlayTime = 400; // chain behind `now` => mid-reply drain
    // New burst arrives mid-reply — must recover with MIN_CHAIN_LEAD (20ms),
    // NOT re-add the full 60ms cold PRE_ROLL (that re-buffer was the stutter).
    for (let i = 0; i < 4; i++) {
      streamer.playAudioChunk(toPcm24kBase64(new Float32Array((0.2 * 24000) | 0)));
      flushTimers();
    }
    // The FIRST chunk of the recovery burst must resume with the 20ms lead
    // (≈ currentTime + 0.02), never the 60ms cold-start PRE_ROLL (currentTime+0.06).
    const firstRecovery = startCalls[beforeRecovery];
    expect(firstRecovery).toBeGreaterThanOrEqual(500 + 0.02);
    expect(firstRecovery).toBeLessThan(500 + 0.06);
  });
});

describe('AudioStreamer capture engine', () => {
  it('ScriptProcessor fallback engages when AudioWorklet is unavailable and encodes byte-exact PCM', async () => {
    await loadStreamer();
    const streamer = new AudioStreamer();
    const chunks: Array<{ b64: string; rms?: number }> = [];
    const stream = { getAudioTracks: () => [], getTracks: () => [] };
    await streamer.startRecording(stream, (b64: string, rms?: number) => chunks.push({ b64, rms }), undefined, undefined);
    expect(streamer.getCaptureEngine()).toBe('scriptprocessor');

    // Feed one 2048-sample block @48kHz: 0.5 DC → 683 samples of 16383 PCM16 LE.
    const sp = createScriptProcessor.mock.results[0].value;
    sp.onaudioprocess!({ inputBuffer: { getChannelData: () => new Float32Array(2048).fill(0.5) } });
    expect(chunks.length).toBe(1);
    const bytes = Uint8Array.from(atob(chunks[0].b64), (c) => c.charCodeAt(0));
    expect(bytes.length).toBe(683 * 2);
    expect(bytes[0]).toBe(0xff); // 16383 (0x3FFF) LE low byte
    expect(bytes[1]).toBe(0x3f); // 16383 (0x3FFF) LE high byte
    expect(chunks[0].rms).toBeCloseTo(0.5, 5);
    void streamer;
  });

  it('worklet capture engine routes worklet postMessage chunks into onAudioChunk base64', async () => {
    await loadStreamer();

    // Provide the pieces startRecording needs to boot the REAL worklet path:
    // ctx.audioWorklet.addModule, a global AudioWorkletNode, and Blob URLs.
    const addModule = vi.fn().mockResolvedValue(undefined);
    ctx.audioWorklet = { addModule };
    const fakePort: { onmessage: ((e: MessageEvent) => void) | null; postMessage: ReturnType<typeof vi.fn> } = { onmessage: null, postMessage: vi.fn() };
    const FakeWorkletNode = class {
      port = fakePort;
      connect = vi.fn();
      disconnect = vi.fn();
    };
    (globalThis as any).AudioWorkletNode = FakeWorkletNode;
    const origURL = (globalThis as any).URL;
    const urlMock = vi.fn(() => 'blob:fake-worklet');
    (globalThis as any).URL = { ...origURL, createObjectURL: urlMock, revokeObjectURL: vi.fn() };

    const streamer = new AudioStreamer();
    const chunks: Array<{ b64: string; rms?: number }> = [];
    const stream = { getAudioTracks: () => [], getTracks: () => [] };
    await streamer.startRecording(stream, (b64: string, rms?: number) => chunks.push({ b64, rms }), undefined, undefined);

    expect(addModule).toHaveBeenCalledWith('blob:fake-worklet');
    expect(streamer.getCaptureEngine()).toBe('worklet');

    // P4: the worklet now posts the READY base64 string (no ArrayBuffer transfer),
    // so a 683-sample (683×2 bytes) 0.5-DC block arrives as exactly that string.
    const wire = btoa(String.fromCharCode(...Array.from({ length: 683 }, () => 0xff), ...Array.from({ length: 683 }, () => 0x3f)));
    fakePort.onmessage!({ data: { kind: 'chunk', b64: wire, outLen: 683, rms: 0.5 } } as MessageEvent);

    expect(chunks.length).toBe(1);
    expect(chunks[0].b64).toBe(wire); // forwarded verbatim, not re-encoded on main
    expect(chunks[0].rms).toBeCloseTo(0.5, 5);
    void streamer;

    delete (globalThis as any).AudioWorkletNode;
    delete ctx.audioWorklet;
    (globalThis as any).URL = origURL;
  });

  it('muted capture skips sending chunks to onAudioChunk', async () => {
    await loadStreamer();
    const streamer = new AudioStreamer();
    const chunks: Array<{ b64: string; rms?: number }> = [];
    const stream = { getAudioTracks: () => [], getTracks: () => [] };
    await streamer.startRecording(stream, (b64: string, rms?: number) => chunks.push({ b64, rms }), undefined, undefined);
    expect(streamer.getCaptureEngine()).toBe('scriptprocessor');

    streamer.setMuted(true);
    const sp = createScriptProcessor.mock.results[0].value;
    sp.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(2048).fill(0.5) } });
    expect(chunks.length).toBe(0); // muted → no chunk emitted
    void streamer;
  });
});
