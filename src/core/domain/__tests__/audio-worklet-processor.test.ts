/**
 * AudioWorklet processor — hermetic unit tests.
 *
 * The worklet source is a plain-JS string (loaded at runtime via addModule from
 * a Blob URL). We evaluate it here with new Function in a fake AudioWorklet
 * global scope, then drive the processor through 128-frame render quanta and
 * assert on the postMessage PCM contract.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WORKLET_PROCESSOR_NAME, WORKLET_SOURCE } from '../audio-worklet-processor';

// ── Hermetic AudioWorklet global scope ────────────────────────────────────
function loadWorkletClass(sampleRate = 48000, realMessageChannel = false): {
  Processor: any;
  posts: ReturnType<typeof vi.fn>;
  name: string;
  /** Resolves once ≥2 messages arrive on the far end (realMessageChannel only). */
  received: () => Promise<any[]>;
} {
  const posts = vi.fn();
  const registered: Array<[string, unknown]> = [];
  let far: MessagePort | null = null;

  // fake base port: a vi.fn() (postMessage never detaches).
  // realMessageChannel: a genuine MessageChannel — transfers REALLY detach the
  // buffer, exactly like the browser worklet's MessagePort. This catches the
  // "reuse transferred buffer → DataCloneError" regression.
  class FakeProcessorBase {
    port = realMessageChannel
      ? (() => {
          const { port1, port2 } = new MessageChannel();
          far = port1;
          const farMsgs: any[] = [];
          port1.onmessage = (ev: MessageEvent) => farMsgs.push(ev.data);
          port1.start();
          return {
            postMessage: (msg: unknown, transfer?: Transferable[]) => {
              port2.postMessage(msg as any, transfer ?? []);
              posts(msg, transfer);
              void farMsgs; // farMsgs collected for `received()`
            },
          };
        })()
      : { postMessage: posts };
  }

  // Evaluate the worklet source with fake AudioWorklet globals. registerProcessor
  // stores the class so we can instantiate and drive it like the audio thread.
  const scopeFn = new Function(
    'AudioWorkletProcessor',
    'registerProcessor',
    'sampleRate',
    'reg',
    `
      reg.register = (name, cls) => reg.registered.push([name, cls]);
      ${WORKLET_SOURCE}
    `,
  );
  const reg: { register: (n: string, c: unknown) => void; registered: Array<[string, unknown]> } = {
    register: () => {},
    registered,
  };
  scopeFn(FakeProcessorBase, (name: string, cls: unknown) => reg.register(name, cls), sampleRate, reg);

  const [name, Processor] = reg.registered[0];
  const received = realMessageChannel
    ? () =>
        new Promise<any[]>((resolve) => {
          if (!far) return resolve([]);
          const msgs: any[] = [];
          far.onmessage = (ev: MessageEvent) => {
            msgs.push(ev.data);
            if (msgs.length >= 2) resolve(msgs);
          };
        })
    : () => Promise.resolve([]);
  return { Processor, posts, name, received };
}

function pump(Processor: any, samplesPerQuantum: number, totalFrames: number, value = 0.5) {
  const inst = new Processor();
  const frames: Float32Array[] = [];
  for (let off = 0; off < totalFrames; off += samplesPerQuantum) {
    const n = Math.min(samplesPerQuantum, totalFrames - off);
    frames.push(new Float32Array(n).fill(value));
  }
  for (const f of frames) {
    inst.process([[f]]);
  }
  return inst;
}

describe('MisaAudioProcessor worklet source', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('registers under the worklet processor name', () => {
    const { name } = loadWorkletClass();
    expect(name).toBe(WORKLET_PROCESSOR_NAME);
  });

  it('accumulates render quanta and emits ONE 16k PCM chunk per ~40ms block', () => {
    const { Processor, posts } = loadWorkletClass(48000);
    // 48000 * 0.04s = 1920 frames per block.
    pump(Processor, 128, 1920, 0.5);
    expect(posts).toHaveBeenCalledTimes(1);
    const msg = posts.mock.calls[0][0];
    expect(msg.kind).toBe('chunk');
    // 1920 @48kHz → 640 samples @16kHz (≈40ms input chunk, Google guidance).
    expect(msg.outLen).toBe(640);
    expect(msg.rms).toBeCloseTo(0.5, 5);
    // Hang-fix P4: the worklet posts the READY base64 string — never a raw
    // ArrayBuffer, and no transfer list (strings are cloneable by value).
    expect(typeof msg.b64).toBe('string');
    expect(msg.pcm).toBeUndefined();
    expect(posts.mock.calls[0][1]).toBeUndefined();
  });

  it('does not emit before a full block accumulates', () => {
    const { Processor, posts } = loadWorkletClass(48000);
    pump(Processor, 128, 1920 - 128, 0.3); // 14 quanta < 1920 threshold
    expect(posts).not.toHaveBeenCalled();
  });

  it('emits identical little-endian PCM as the ScriptProcessor fallback encoder', () => {
    const { Processor, posts } = loadWorkletClass(48000);
    pump(Processor, 128, 1920, 0.5);
    const msg = posts.mock.calls[0][0];
    const bytes = Uint8Array.from(atob(msg.b64), (c) => c.charCodeAt(0));
    // float 0.5 → 0.5 * 0x7fff = 16383 (0x3FFF), little-endian [0xFF, 0x3F].
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0x3f);
    for (let i = 2; i < bytes.length; i += 2) {
      expect(bytes[i]).toBe(0xff);
      expect(bytes[i + 1]).toBe(0x3f);
    }
  });

  it('posts cloneable b64 strings over a REAL MessagePort — every chunk intact, no DataCloneError', async () => {
    // Two full ~40ms blocks → two postMessage calls. With the old
    // ArrayBuffer-transfer contract the browser DETACHED the transferred
    // buffer and a reused PCM array threw "DataCloneError" on the second
    // chunk. P4 posts strings (cloneable by value) — no transfer list, so the
    // receiver must get two fully intact, identical 640-sample chunks.
    const { Processor, posts, received } = loadWorkletClass(48000, true);
    const inst = new Processor();
    for (let block = 0; block < 2; block++) {
      for (let q = 0; q < 15; q++) {
        inst.process([[new Float32Array(128).fill(0.5)]]);
      }
    }
    expect(posts).toHaveBeenCalledTimes(2);
    expect(posts.mock.calls[0][1]).toBeUndefined(); // no transfer list at all
    const msgs = await received();
    expect(msgs).toHaveLength(2);
    const bytes = Uint8Array.from(atob(msgs[1].b64), (c) => c.charCodeAt(0));
    expect(bytes).toHaveLength(640 * 2);
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0x3f);
  });

  it('downsamples non-48k contexts by the same average-grouping rule', () => {
    const { Processor, posts } = loadWorkletClass(44100);
    // 44100 * 0.04s = 1764 → round(1764 / (44100/16000)) = round(640) = 640.
    pump(Processor, 128, 1764, 0.5);
    expect(posts).toHaveBeenCalledTimes(1);
    const msg = posts.mock.calls[0][0];
    expect(msg.outLen).toBe(640);
  });

  it('silently survives an empty input quantum', () => {
    const { Processor, posts } = loadWorkletClass(48000);
    const inst = new Processor();
    expect(inst.process([])).toBe(true);
    expect(inst.process([[]])).toBe(true);
    expect(posts).not.toHaveBeenCalled();
  });
});