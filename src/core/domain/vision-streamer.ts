// Vision & Screen Streamer for Gemini Live
// Captures video frames from Front/Back camera or Live Screen Share
// Encodes frames to low-latency compressed JPEG (1-5 FPS) for Gemini Live multimodal vision.

import type { LiveCameraLens } from './live-types';
import { NativeScreenShare } from '../../lib/native-screen-share';

export class VisionStreamer {
  private videoStream: MediaStream | null = null;
  private videoElement: HTMLVideoElement | null = null;
  private canvasElement: HTMLCanvasElement | null = null;
  private canvasCtx: CanvasRenderingContext2D | null = null;
  private frameInterval: number | null = null;

  private currentLens: LiveCameraLens = 'environment';
  private isScreenSharing = false;
  private isCameraActive = false;
  /** AUDIT FIX (round 1, MEDIUM): acquisition generation. startCamera /
   *  startScreenShare are ASYNC — a second start while the first is still
   *  inside getUserMedia used to overwrite frameInterval/videoStream, leaking
   *  the first stream (camera LED stayed on) and double-harvesting frames.
   *  stop() and each new start bump the generation; a stale acquisition that
   *  resolves later stops its orphaned stream and aborts without touching the
   *  current owner's state. */
  private acquisitionGen = 0;
  /**
   * Frames skipped right after a NEW source starts (camera switch / screen
   * share). The very first frames of a fresh display-capture or camera stream
   * are often blank, stale, or a transition flash — if they are sent to the
   * model, its FIRST observation is garbage and it confidently describes
   * hallucinated content ("YouTube chalu kiya kya?", "kinematics solve kar
   * rahe ho?") in the first message. We only forward a frame once the source
   * has had TIME to produce real pixels.
   */
  private warmupFramesRemaining = 0;

  constructor() {}

  /** Start camera video stream (front or back lens). */
  async startCamera(
    lens: LiveCameraLens,
    fps: number,
    onFrame: (jpegBase64: string) => void,
  ): Promise<MediaStream> {
    this.stop();
    const gen = this.acquisitionGen; // captured AFTER stop()'s bump
    this.currentLens = lens;
    this.isScreenSharing = false;
    // A fresh camera stream needs a few frames before pixels are real
    // (focus/exposure settle, device switch) — skip the garbage frames so the
    // model's first observation is actual content, never a blank guess.
    this.warmupFramesRemaining = 3;

    // Android WebView camera-flip race: re-acquiring getUserMedia in the same
    // synchronous turn after stop() can keep the OLD camera device (the "front
    // camera sometimes doesn't switch" bug) because the previous device isn't
    // released yet. Yield a macrotask so the WebView actually frees the camera
    // before we request a new one.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    // A newer start/stop landed while we yielded — this attempt is stale.
    if (gen !== this.acquisitionGen) throw new Error('Camera acquisition superseded.');

    const baseVideo: MediaTrackConstraints = {
      width: { ideal: 640, max: 1280 },
      height: { ideal: 480, max: 720 },
      frameRate: { ideal: 15, max: 30 },
    };

    // Request the intended lens with an EXACT facingMode so the WebView is
    // forced to switch cameras (or throw) instead of silently returning the
    // currently-held one. Fall back to ideal-only for WebViews/OEMs that do
    // not support exact facingMode constraints.
    const stream = await this.acquireCamera(lens, baseVideo);

    if (gen !== this.acquisitionGen) {
      // A newer start/stop landed while getUserMedia was in flight — release
      // the orphaned stream so the camera LED never stays on, and do NOT touch
      // the current owner's state (videoStream/interval/sourceObject).
      stream.getTracks().forEach((t) => t.stop());
      throw new Error('Camera acquisition superseded.');
    }

    this.videoStream = stream;
    this.isCameraActive = true;
    this.setupVideoProcessing(stream, fps, onFrame);
    return stream;
  }

  private async acquireCamera(
    lens: LiveCameraLens,
    baseVideo: MediaTrackConstraints,
  ): Promise<MediaStream> {
    const desired = lens === 'user' ? 'user' : 'environment';
    try {
      return await navigator.mediaDevices.getUserMedia({
        video: { ...baseVideo, facingMode: { exact: desired } },
        audio: false,
      });
    } catch {
      // Some WebViews expose facingMode only as a soft hint (or not at all) —
      // exact throws OverconstrainedError there. Retry with ideal so switching
      // still works on those devices.
      return await navigator.mediaDevices.getUserMedia({
        video: { ...baseVideo, facingMode: lens === 'user' ? 'user' : { ideal: 'environment' } },
        audio: false,
      });
    }
  }

  /** Start screen sharing stream (displays PDF, coaching apps, browser, etc.). */
  async startScreenShare(
    fps: number,
    onFrame: (jpegBase64: string) => void,
    onEnded?: () => void,
  ): Promise<MediaStream | null> {
    this.stop();
    const gen = this.acquisitionGen; // captured AFTER stop()'s bump
    this.isScreenSharing = true;
    this.isCameraActive = false;
    this.warmupFramesRemaining = 3;

    // 1. Android Native MediaProjection support
    if (NativeScreenShare.isNative()) {
      await NativeScreenShare.start(fps, onFrame, () => {
        this.stop();
        if (onEnded) onEnded();
      });
      return null;
    }

    // 2. Web browser getDisplayMedia fallback
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      throw new Error('Screen sharing is not supported by your current browser.');
    }

    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        width: { ideal: 1280, max: 1920 },
        height: { ideal: 720, max: 1080 },
        frameRate: { ideal: 5, max: 15 },
      },
      audio: false,
    });

    if (gen !== this.acquisitionGen) {
      // A newer start/stop landed while the picker was open — release the
      // orphaned display stream instead of leaking it.
      stream.getTracks().forEach((t) => t.stop());
      throw new Error('Screen share superseded.');
    }

    this.videoStream = stream;
    const videoTrack = stream.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.onended = () => {
        this.stop();
        if (onEnded) onEnded();
      };
    }

    this.setupVideoProcessing(stream, fps, onFrame);
    return stream;
  }

  /** Switch between Front ('user') and Back ('environment') camera. */
  async switchLens(
    fps: number,
    onFrame: (jpegBase64: string) => void,
  ): Promise<MediaStream> {
    const nextLens: LiveCameraLens = this.currentLens === 'user' ? 'environment' : 'user';
    return this.startCamera(nextLens, fps, onFrame);
  }

  getCurrentLens(): LiveCameraLens {
    return this.currentLens;
  }

  getIsCameraActive(): boolean {
    return this.isCameraActive;
  }

  getIsScreenSharing(): boolean {
    return this.isScreenSharing;
  }

  getStream(): MediaStream | null {
    return this.videoStream;
  }

  private setupVideoProcessing(
    stream: MediaStream,
    fps: number,
    onFrame: (jpegBase64: string) => void,
  ): void {
    // AUDIT FIX: defensive — never layer a second interval on top of a live one.
    if (this.frameInterval !== null) {
      clearInterval(this.frameInterval);
      this.frameInterval = null;
    }
    if (!this.videoElement) {
      this.videoElement = document.createElement('video');
      this.videoElement.autoplay = true;
      this.videoElement.playsInline = true;
      this.videoElement.muted = true;
    }

    if (!this.canvasElement) {
      this.canvasElement = document.createElement('canvas');
      this.canvasCtx = this.canvasElement.getContext('2d', { willReadFrequently: true });
    }

    this.videoElement.srcObject = stream;
    void this.videoElement.play();

    const intervalMs = Math.max(200, Math.floor(1000 / Math.max(1, fps)));

    this.frameInterval = window.setInterval(() => {
      if (!this.videoElement || !this.canvasElement || !this.canvasCtx || this.videoElement.readyState < 2) {
        return;
      }

      // First-message guard: skip the warm-up frames of a brand-new source and
      // any essentially-blank frame. Sending a blank/stale first frame is what
      // made the model "see" a YouTube video / kinematics problem that wasn't
      // there and describe it in the FIRST message (the rest stayed fine).
      if (this.warmupFramesRemaining > 0) {
        this.warmupFramesRemaining -= 1;
        return;
      }

      const videoWidth = this.videoElement.videoWidth || 640;
      const videoHeight = this.videoElement.videoHeight || 480;

      // Scale to max width 640px for fast transmission
      const maxDim = 640;
      const scale = Math.min(1, maxDim / Math.max(videoWidth, videoHeight));
      const targetWidth = Math.round(videoWidth * scale);
      const targetHeight = Math.round(videoHeight * scale);

      if (this.canvasElement.width !== targetWidth || this.canvasElement.height !== targetHeight) {
        this.canvasElement.width = targetWidth;
        this.canvasElement.height = targetHeight;
      }

      this.canvasCtx.drawImage(this.videoElement, 0, 0, targetWidth, targetHeight);
      if (this.isFrameBlank()) return; // jump-cut: no real content to describe
      const dataUrl = this.canvasElement.toDataURL('image/jpeg', 0.6);
      const base64 = dataUrl.split(',')[1];
      if (base64) {
        onFrame(base64);
      }
    }, intervalMs);
  }

  /**
   * Cheap luminance sample over a coarse grid. Returns true when the captured
   * frame is essentially black/blank — such frames are skipped so the model
   * never interprets "nothing" as content.
   */
  private isFrameBlank(): boolean {
    if (!this.canvasCtx || !this.canvasElement) return false;
    const w = this.canvasElement.width;
    const h = this.canvasElement.height;
    if (w === 0 || h === 0) return true;
    const stepX = Math.max(1, Math.floor(w / 16));
    const stepY = Math.max(1, Math.floor(h / 16));
    let sum = 0;
    let count = 0;
    for (let y = 0; y < h; y += stepY) {
      for (let x = 0; x < w; x += stepX) {
        const d = this.canvasCtx.getImageData(x, y, 1, 1).data;
        sum += (d[0] + d[1] + d[2]) / 3;
        count += 1;
      }
    }
    if (count === 0) return true;
    return sum / count < 6; // essentially black (a genuinely dark share is rare)
  }

  stop(): void {
    // AUDIT FIX: bump the generation FIRST so any still-in-flight acquisition
    // (getUserMedia/getDisplayMedia pending) becomes stale and releases its
    // own orphaned stream when it resolves.
    this.acquisitionGen += 1;
    if (this.isScreenSharing && NativeScreenShare.isNative()) {
      void NativeScreenShare.stop();
    }
    if (this.frameInterval !== null) {
      clearInterval(this.frameInterval);
      this.frameInterval = null;
    }
    if (this.videoStream) {
      this.videoStream.getTracks().forEach((track) => track.stop());
      this.videoStream = null;
    }
    if (this.videoElement) {
      this.videoElement.srcObject = null;
    }
    this.isCameraActive = false;
    this.isScreenSharing = false;
  }
}
