/**
 * Misa AudioWorklet processor — recording-side DSP off the main thread.
 *
 * The old capture pipeline used ScriptProcessorNode(2048, 1, 1) whose
 * onaudioprocess ran RMS + downsample + float→PCM + base64 on the MAIN thread
 * at ~23 chunks/sec. On the single Capacitor WebView JS thread that competed
 * against typing, scrolling, animations and React re-renders -> the visible
 * "hang".
 *
 * This module is the REAL AudioWorklet engine. It runs on the audio render
 * thread and does everything except the final base64 string:
 *   - accumulates the mic render quanta (128 frames) into a 2048-sample ring,
 *   - computes RMS,
 *   - downsamples to 16kHz (same average-grouping algorithm as the fallback),
 *   - converts float → 16-bit PCM,
 *   - transfers the PCM buffer to the main thread (base64 encode is trivial on
 *     ~683 samples; the transfer is a zero-copy ownership hand-off).
 *
 * AudioWorklet modules must be loaded from a URL, and we don't want a build
 * plugin / public asset dependency for one small class. So the processor is
 * kept as a self-contained plain-JS source string (ES2019 only — no TS syntax,
 * no imports) and loaded addModule(new Blob([WORKLET_SOURCE])) with a silent
 * ScriptProcessor fallback when the WebView predates AudioWorklet.
 *
 * The source is a normal template literal so the test suite can evaluate it in
 * a hermetically sealed scope and assert on the postMessage contract.
 */
export const WORKLET_PROCESSOR_NAME = 'misa-audio-processor';

export const WORKLET_SOURCE = `
'use strict';
const MisaAudioProcessor = class extends AudioWorkletProcessor {
  constructor() {
    super();
    // Ring accumulates 128-frame render quanta up to a full 2048-sample block.
    this.ring = new Float32Array(4096);
    this.out16k = new Float32Array(2048);
    this.fill = 0;
  }

  process(inputs) {
    const input = inputs[0];
    const ch = input ? input[0] : null;
    if (!ch || ch.length === 0) return true;

    const ring = this.ring;
    let fill = this.fill;
    if (fill + ch.length > ring.length) {
      // Safety net: shouldn't happen with 128-frame quanta + 2048 threshold.
      fill = 0;
    }
    ring.set(ch, fill);
    fill += ch.length;
    this.fill = fill;

    // Only emit a chunk once a full block has accumulated (~23 chunks/sec).
    if (fill < 2048) return true;

    const block = ring.subarray(0, fill);
    const n = block.length;

    // RMS (root mean square) amplitude for the live voice meter.
    let sumSq = 0;
    for (let i = 0; i < n; i++) sumSq += block[i] * block[i];
    const rms = Math.sqrt(sumSq / n);

    // Downsample to 16kHz mono with the same average-grouping used by the
    // ScriptProcessor fallback, so both engines emit numerically-identical PCM.
    const ratio = sampleRate / 16000;
    const outLen = Math.round(n / ratio);
    const out16k = this.out16k;
    let oi = 0;
    let ii = 0;
    while (oi < outLen) {
      const next = Math.round((oi + 1) * ratio);
      let acc = 0;
      let cnt = 0;
      for (let i = ii; i < next && i < n; i++) {
        acc += block[i];
        cnt++;
      }
      out16k[oi] = cnt > 0 ? acc / cnt : 0;
      oi++;
      ii = next;
    }

// Float → 16-bit signed PCM (same clamping as the fallback path).
    // IMPORTANT: use a FRESH buffer per chunk. postMessage(msg, [buffer])
    // TRANSFERS (detaches) the ArrayBuffer — a long-lived reusable PCM array
    // here would be sent already-detached on the next chunk and throw
    // "DataCloneError: ArrayBuffer at index 0 is already detached". ~1.3KB per
    // chunk at ~23 chunks/sec is negligible on the audio thread.
    const send = new Int16Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const s = Math.max(-1, Math.min(1, out16k[i]));
      send[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }

    // Zero-copy hand-off: transfer the fresh buffer; the main thread reads
    // only the used outLen samples.
    this.port.postMessage(
      { kind: 'chunk', pcm: send.buffer, outLen: outLen, rms: rms },
      [send.buffer],
    );
    this.fill = 0;
    return true;
  }
};

registerProcessor('misa-audio-processor', MisaAudioProcessor);
`;