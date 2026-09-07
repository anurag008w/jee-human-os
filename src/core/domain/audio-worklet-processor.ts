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
 * thread, and since hang-fix P4 it does the WHOLE per-chunk DSP:
 *   - accumulates the mic render quanta (128 frames) into a 2048-sample ring,
 *   - computes RMS,
 *   - downsamples to 16kHz (same average-grouping algorithm as the fallback),
 *   - converts float → 16-bit PCM,
 *   - base64-encodes the PCM into the wire-ready string (P4 — this used to be
 *     built on the MAIN thread, one ~1.3KB string × 23 chunks/sec, on the same
 *     thread as typing/scrolling/React: a live-call hang + robotic-glitch
 *     contributor),
 *   - posts only the string to the main thread, which merely forwards it.
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
    // Block = ~40ms of capture (Google Live guidance: 20–40ms input chunks).
    // Sample-rate-aware so 24k contexts (85ms chunks with the old fixed 2048)
    // and 44.1k/48k contexts all stay inside the recommended window.
    this.block = Math.max(640, Math.round(sampleRate * 0.04));
    // Ring accumulates 128-frame render quanta up to one full block.
    this.ring = new Float32Array(4096);
    this.out16k = new Float32Array(this.block + 128);
    this.fill = 0;
  }

  process(inputs) {
    const input = inputs[0];
    const ch = input ? input[0] : null;
    if (!ch || ch.length === 0) return true;

    const blockLen = this.block;
    const ring = this.ring;
    let fill = this.fill;
    if (fill + ch.length > ring.length) {
      // Safety net: shouldn't happen with 128-frame quanta + block threshold.
      fill = 0;
    }
    ring.set(ch, fill);
    fill += ch.length;
    this.fill = fill;

    // Only emit a chunk once a full block has accumulated (~25 chunks/sec).
    if (fill < blockLen) return true;

    const n = fill;
    const block = ring.subarray(0, n);

    // RMS (root mean square) amplitude for the live voice meter.
    let sumSq = 0;
    for (let i = 0; i < n; i++) sumSq += block[i] * block[i];
    const rms = Math.sqrt(sumSq / n);

    // Downsample to 16kHz mono with the same average-grouping used by the
    // ScriptProcessor fallback, so both engines emit numerically-identical PCM.
    const ratio = sampleRate / 16000;
    const out16k = this.out16k;
    // Clamp: never write past the scratch even on unusual sample rates.
    const outLen = Math.min(Math.round(n / ratio), out16k.length - 1);
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

    // Hang-fix P4: base64 ENCODE HERE, on the audio render thread, so the main
    // (UI) thread never builds a string per chunk during a live call. ~683
    // samples → ~1.3KB string; plain string concatenation is fine at 23/sec.
    // The main thread now only forwards the ready string to the WebSocket.
    const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const bytes = new Uint8Array(send.buffer, 0, outLen * 2);
    let b64 = '';
    let bi = 0;
    for (; bi + 2 < bytes.length; bi += 3) {
      const num = (bytes[bi] << 16) | (bytes[bi + 1] << 8) | bytes[bi + 2];
      b64 +=
        B64[(num >> 18) & 63] +
        B64[(num >> 12) & 63] +
        B64[(num >> 6) & 63] +
        B64[num & 63];
    }
    const rem = bytes.length - bi;
    if (rem === 1) {
      const num = bytes[bi] << 16;
      b64 += B64[(num >> 18) & 63] + B64[(num >> 12) & 63] + '==';
    } else if (rem === 2) {
      const num = (bytes[bi] << 16) | (bytes[bi + 1] << 8);
      b64 += B64[(num >> 18) & 63] + B64[(num >> 12) & 63] + B64[(num >> 6) & 63] + '=';
    }

    this.port.postMessage({ kind: 'chunk', b64: b64, outLen: outLen, rms: rms });
    this.fill = 0;
    return true;
  }
};

registerProcessor('misa-audio-processor', MisaAudioProcessor);
`;