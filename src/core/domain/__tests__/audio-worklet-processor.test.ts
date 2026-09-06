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

  it('accumulates render quanta and emits ONE 16k PCM chunk per 2048 input frames', () => {
    const { Processor, posts } = loadWorkletClass(48000);
    pump(Processor, 128, 2048, 0.5);
    expect(posts).toHaveBeenCalledTimes(1);
    const msg = posts.mock.calls[0][0];
    expect(msg.kind).toBe('chunk');
    // 2048 @48kHz → 683 samples @16kHz.
    expect(msg.outLen).toBe(683);
    expect(msg.rms).toBeCloseTo(0.5, 5);
    // Transferred buffer is the (ring-sized) PCM ArrayBuffer.
    expect(msg.pcm).toBeInstanceOf(ArrayBuffer);
    const transfer = posts.mock.calls[0][1];
    expect(transfer).toContain(msg.pcm);
  });

  it('does not emit before a full block accumulates', () => {
    const { Processor, posts } = loadWorkletClass(48000);
    pump(Processor, 128, 2048 - 128, 0.3); // 15 quanta < 2048 threshold
    expect(posts).not.toHaveBeenCalled();
  });

  it('emits identical little-endian PCM as the ScriptProcessor fallback encoder', () => {
    const { Processor, posts } = loadWorkletClass(48000);
    pump(Processor, 128, 2048, 0.5);
    const msg = posts.mock.calls[0][0];
    const bytes = new Uint8Array(msg.pcm, 0, msg.outLen * 2);
    // float 0.5 → 0.5 * 0x7fff = 16383 (0x3FFF), little-endian [0xFF, 0x3F].
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0x3f);
    for (let i = 2; i < bytes.length; i += 2) {
      expect(bytes[i]).toBe(0xff);
      expect(bytes[i + 1]).toBe(0x3f);
    }
  });

  it('re-arms a FRESH buffer per chunk — a reused transferred buffer throws DataCloneError (real MessagePort)', async () => {
    // Two full 2048-frame blocks → two postMessage transfers. The browser
    // detaches the transferred ArrayBuffer; the old code kept writing+sending
    // the same reusable PCM array and the SECOND transfer threw
    // "DataCloneError: ArrayBuffer at index 0 is already detached".
    const { Processor, posts, received } = loadWorkletClass(48000, true);
    const inst = new Processor();
    for (let block = 0; block < 2; block++) {
      for (let q = 0; q < 16; q++) {
        inst.process([[new Float32Array(128).fill(0.5)]]);
      }
    }
    expect(posts).toHaveBeenCalledTimes(2);
    // The recorded (sender-side) buffers are both detached by real transfers,
    // but they must be DIFFERENT ArrayBuffer objects — never a reused one.
    expect(posts.mock.calls[1][0].pcm).not.toBe(posts.mock.calls[0][0].pcm);
    // The receiving end sees two fully intact 683-sample PCM chunks.
    const msgs = await received();
    expect(msgs).toHaveLength(2);
    expect(msgs[1].pcm.byteLength).toBe(683 * 2);
    const bytes = new Uint8Array(msgs[1].pcm);
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0x3f);
  });

  it('downsamples non-48k contexts by the same average-grouping rule', () => {
    const { Processor, posts } = loadWorkletClass(44100);
    pump(Processor, 128, 2048, 0.5);
    expect(posts).toHaveBeenCalledTimes(1);
    const msg = posts.mock.calls[0][0];
    // 2048 @44.1kHz → round(2048 / (44100/16000)) = round(743.2) = 743.
    expect(msg.outLen).toBe(743);
  });

  it('silently survives an empty input quantum', () => {
    const { Processor, posts } = loadWorkletClass(48000);
    const inst = new Processor();
    expect(inst.process([])).toBe(true);
    expect(inst.process([[]])).toBe(true);
    expect(posts).not.toHaveBeenCalled();
  });
});