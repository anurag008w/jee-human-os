package com.anurag.levelup;

import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioTrack;
import android.util.Base64;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Misa Live — Gapless Native Audio Track Plugin
 *
 * Plays the Gemini Live 24kHz mono linear PCM reply stream through Android's
 * {@link AudioTrack} in MODE_STREAM — the platform's gapless-native audio
 * output. This is the TRUE fix for the "bubble-end / cut-cut" stutter:
 *
 *   • WebAudio's AudioBufferSourceNode is NOT guaranteed gapless (MDN spec +
 *     community confirmed). Every ~133ms streamed chunk scheduled as a fresh
 *     source.start() creates a hardware DAC boundary that can click/hitch —
 *     worst right where a long reply's last chunk ends ("bubble khatam").
 *   • AudioTrack MODE_STREAM with blocking write() lets the app push a
 *     continuous stream of PCM into the OS audio sink. The OS glues consecutive
 *     writes together itself (net-queue gapless), so there are NO per-chunk
 *     boundaries and NO stutter — independent of the WebSocket burstiness.
 *
 * The plugin owns a background writer thread so blocking write() never
 * touches the Android main/UI thread. JS pushes decoded PCM chunks; the queue
 * drains on the writer thread and the OS plays them back-to-back as a single
 * gapless stream.
 *
 * Web/browser and Node (tests) have no native AudioTrack — the JS bridge
 * transparently falls back to the existing WebAudio AudioStreamer there.
 *
 * Format fixed to Gemini Live: 24 000 Hz, mono, 16-bit PCM (PCM_16BIT).
 * Verified against Android 7+ (AudioTrack is API 3+).
 */
@CapacitorPlugin(name = "GaplessAudioTrack")
public class GaplessAudioTrackPlugin extends Plugin {

    private static final String TAG = "GaplessAudioTrack";
    private static final int SAMPLE_RATE_HZ = 24000;
    private static final int CHANNEL_CONFIG = AudioFormat.CHANNEL_OUT_MONO;
    private static final int ENCODING = AudioFormat.ENCODING_PCM_16BIT;

    private AudioTrack audioTrack;
    /**
     * Bounded on purpose. The queue used to be an unbounded LinkedBlockingQueue
     * and write() always offered: on a network stall the JS side keeps pushing
     * 24kHz PCM, so native memory grew without limit and the audio that finally
     * played was seconds stale. 48 chunks ≈ 6.4s at a 133ms cadence is already far
     * more than any legitimate burst; beyond it the OLDEST audio is dropped.
     */
    private static final int PENDING_CAPACITY_CHUNKS = 48;
    private final LinkedBlockingQueue<short[]> pending = new LinkedBlockingQueue<>(PENDING_CAPACITY_CHUNKS);
    private Thread writerThread;
    private final AtomicBoolean closed = new AtomicBoolean(true);
    /**
     * Guards hand-offs of {@link #audioTrack} and {@link #writerThread}. The writer
     * thread takes the lock only to READ the reference (never around the blocking
     * write), so flush() stays instant; teardown takes it, flips state, then JOINS
     * the writer before release() — which is what was missing when closeTrackInternal
     * could release() a track another thread was blocked writing into.
     */
    private final Object sinkLock = new Object();
    /** Samples still to ramp up after a flush, so a resumed reply doesn't click. */
    private volatile int fadeInRemaining = 0;
    /** Number of ramp samples at 24kHz for ~8ms. */
    private static final int FADE_IN_SAMPLES = 192;
    /** Track-level output volume — the native sink bypasses WebAudio's gain node. */
    private volatile float trackVolume = 1f;

    /**
     * Open a MODE_STREAM AudioTrack and start the background writer thread.
     * Repeated calls (e.g. reconnect) tear down any previous track first so we
     * never leak native audio resources. Uses USAGE_VOICE_COMMUNICATION so the
     * track plays under the same audio-focus (voice-communication) the live call
     * already holds — a USAGE_MEDIA track would be silenced because the call's
     * full AUDIOFOCUS_GAIN on voice-communication blocks the media stream.
     */
    @PluginMethod
    public void open(PluginCall call) {
        try {
            closeTrackInternal();
            closed.set(false);
            pending.clear();

            int sampleRate = call.getInt("sampleRate", SAMPLE_RATE_HZ);
            // Buffer = ~500ms of PCM (24000 bytes ÷ 2 bytes/sample = 12000 samples
            // at 24kHz). MODE_STREAM starts rendering as soon as data arrives, so a
            // bigger buffer is pure jitter cushion and costs no latency — it is the
            // ONLY thing between a network hiccup and an underrun (each underrun =
            // one audible hole in the voice). The previous ~250ms cushion was
            // smaller than a single weak-network gap, which is why the stream cut.
            int minBuf = AudioTrack.getMinBufferSize(sampleRate, CHANNEL_CONFIG, ENCODING);
            int bufSize = Math.max(minBuf, sampleRate);

            AudioTrack track = new AudioTrack.Builder()
                .setAudioAttributes(new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build())
                .setAudioFormat(new AudioFormat.Builder()
                    .setSampleRate(sampleRate)
                    .setChannelMask(CHANNEL_CONFIG)
                    .setEncoding(ENCODING)
                    .build())
                .setBufferSizeInBytes(bufSize)
                .setTransferMode(AudioTrack.MODE_STREAM)
                .build();

            if (track.getState() != AudioTrack.STATE_INITIALIZED) {
                try { track.release(); } catch (Exception ignored) { }
                synchronized (sinkLock) { audioTrack = null; }
                closed.set(true);
                call.reject("AudioTrack failed to initialize");
                return;
            }

            try { track.setVolume(trackVolume); } catch (Exception ignored) { }
            track.play();
            // Ramp the first samples in: a reply that starts (or resumes after an
            // interruption) at full amplitude from a silent buffer is an audible
            // click — every flush used to land exactly one of those.
            fadeInRemaining = FADE_IN_SAMPLES;

            synchronized (sinkLock) { audioTrack = track; }

            // Writer thread: blocking AudioTrack.write() runs on its own thread so
            // the JS bridge never stalls. THREAD_PRIORITY_AUDIO raises the Linux
            // nice level so the OS schedules the writer tightly — the DAC never
            // underruns even under WebView main-thread / GC load, which is what
            // used to drop chunks and produce the "atak atak" stutter.
            Thread worker = new Thread(() -> {
                android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_AUDIO);
                drainLoop();
            }, "gapless-audio-writer");
            synchronized (sinkLock) { writerThread = worker; }
            worker.start();

            JSObject ret = new JSObject();
            ret.put("ok", true);
            ret.put("sampleRate", sampleRate);
            ret.put("channels", 1);
            ret.put("minBufferSize", minBuf);
            call.resolve(ret);
        } catch (Exception e) {
            Log.e(TAG, "open failed: " + e.getMessage(), e);
            closed.set(true);
            call.reject("open failed: " + e.getMessage());
        }
    }

    /**
     * Queue a PCM chunk (base64, mono/int16 little-endian) for gapless playback.
     * Blocks the JS bridge only to enqueue — the blocking write() happens on
     * the background writer thread.
     */
    @PluginMethod
    public void write(PluginCall call) {
        AudioTrack track;
        synchronized (sinkLock) { track = audioTrack; }
        if (track == null || closed.get()) {
            // Rejecting is correct and now ACTIONABLE: the JS side counts these and
            // hands playback back to WebAudio. Before that fallback existed, a dead
            // sink swallowed the rest of every reply in silence.
            call.reject("not open");
            return;
        }
        String data = call.getString("data");
        if (data == null || data.isEmpty()) {
            call.resolve();
            return;
        }
        try {
            byte[] bytes = Base64.decode(data, Base64.NO_WRAP);
            // 16-bit mono → samples = byteCount/2
            short[] samples = new short[bytes.length / 2];
            for (int i = 0; i < samples.length; i++) {
                samples[i] = (short) ((bytes[i * 2] & 0xFF) | (bytes[i * 2 + 1] << 8));
            }
            // Bounded enqueue — drop the OLDEST when the sink can't keep up instead
            // of growing native memory forever during a network stall.
            while (!pending.offer(samples)) {
                if (pending.poll() == null) break;
            }
            call.resolve();
        } catch (Exception e) {
            Log.w(TAG, "write decode failed: " + e.getMessage());
            call.resolve(); // never reject mid-stream; drop the bad chunk
        }
    }

    /** Discard queued PCM (hard cut) and restart the sink for the next reply. */
    @PluginMethod
    public void flush(PluginCall call) {
        try {
            pending.clear();
            AudioTrack t;
            synchronized (sinkLock) { t = audioTrack; }
            if (t != null && t.getState() == AudioTrack.STATE_INITIALIZED) {
                t.pause();
                t.flush();
                t.play();
                // An interruption ends the previous sound on a sample discontinuity;
                // without a ramp the resume is a click on top of the cut.
                fadeInRemaining = FADE_IN_SAMPLES;
            }
            call.resolve();
        } catch (Exception e) {
            Log.w(TAG, "flush failed: " + e.getMessage());
            call.resolve();
        }
    }

    /**
     * Track-level output volume (0..1).
     *
     * The gapless sink bypasses the WebAudio graph entirely, so AudioStreamer's gain
     * node — the user's volume setting AND the AUDIOFOCUS_GAIN_CAN_DUCK ducking — did
     * nothing to the audio that is actually audible on Android. This is the matching
     * control for that path.
     */
    @PluginMethod
    public void setVolume(PluginCall call) {
        try {
            // getFloat throws on a malformed payload — must not escape a plugin method.
            float volume = call.getFloat("volume", 1f);
            if (Float.isNaN(volume)) volume = 1f;
            trackVolume = Math.max(0f, Math.min(1f, volume));
            AudioTrack t;
            synchronized (sinkLock) { t = audioTrack; }
            if (t != null && t.getState() == AudioTrack.STATE_INITIALIZED) {
                t.setVolume(trackVolume);
            }
            call.resolve();
        } catch (Exception e) {
            Log.w(TAG, "setVolume failed: " + e.getMessage());
            call.resolve();
        }
    }

    /** Stop the writer thread, release the AudioTrack, free all resources. */
    @PluginMethod
    public void close(PluginCall call) {
        closeTrackInternal();
        call.resolve();
    }

    private void closeTrackInternal() {
        closed.set(true);
        pending.clear();
        Thread worker;
        synchronized (sinkLock) { worker = writerThread; writerThread = null; }
        if (worker != null) {
            worker.interrupt();
            // WAIT for the writer to leave AudioTrack.write() before release():
            // releasing a track another thread is blocked writing into is an
            // IllegalStateException at best and a native abort on some OEM HALs.
            try {
                worker.join(250);
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
            }
        }
        AudioTrack t;
        synchronized (sinkLock) { t = audioTrack; audioTrack = null; }
        if (t != null) {
            try {
                t.pause();
                t.flush();
            } catch (Exception ignored) { }
            try {
                t.stop();
            } catch (Exception ignored) { }
            try {
                t.release();
            } catch (Exception ignored) { }
        }
    }

    /**
     * Writer loop: blocking write() to the AudioTrack for true gapless output.
     *
     * Uses LinkedBlockingQueue.take() (not sleep-polling) so the writer wakes
     * the INSTANT a chunk arrives — no 10ms idle poll lag. The OS audio sink
     * glues consecutive blocking writes together, so there are none of the
     * per-chunk DAC boundaries that WebAudio's AudioBufferSourceNode chaining
     * produces. Combined with THREAD_PRIORITY_AUDIO the writer is scheduled
     * tightly enough to keep the buffer fed even under main-thread load.
     */
    private void drainLoop() {
        while (!closed.get()) {
            short[] chunk;
            try {
                chunk = pending.take(); // blocks until data — instant wakeup
            } catch (InterruptedException ie) {
                return;
            }
            if (closed.get()) return;
            AudioTrack t;
            synchronized (sinkLock) { t = audioTrack; }
            if (t == null || t.getState() != AudioTrack.STATE_INITIALIZED) {
                pending.clear();
                continue;
            }
            applyFadeIn(chunk);
            int written = 0;
            // Bounded retry: a 0/short write means the sink was paused/flushed by an
            // interruption or underran. The old code did `break`, which THREW AWAY the
            // rest of the chunk — so every interrupt deleted up to ~130ms of speech on
            // top of the cut. Restart the sink and push the remaining samples instead.
            int attempts = 0;
            while (written < chunk.length && !closed.get() && attempts++ < 64) {
                int n;
                try {
                    n = t.write(chunk, written, chunk.length - written);
                } catch (Exception e) {
                    Log.w(TAG, "write failed: " + e.getMessage());
                    break;
                }
                if (n > 0) {
                    written += n;
                    continue;
                }
                try {
                    if (t.getPlayState() != AudioTrack.PLAYSTATE_PLAYING) {
                        t.play();
                    } else {
                        Thread.sleep(4);
                    }
                } catch (InterruptedException ie) {
                    return;
                } catch (Exception ignored) { }
            }
        }
    }

    /** Linear ramp over the head of a chunk right after a flush/resume (anti-click). */
    private void applyFadeIn(short[] chunk) {
        int need = fadeInRemaining;
        if (need <= 0 || chunk.length == 0) return;
        int n = Math.min(need, chunk.length);
        for (int i = 0; i < n; i++) {
            chunk[i] = (short) (chunk[i] * ((i + 1) / (float) need));
        }
        fadeInRemaining = Math.max(0, need - n);
    }

    @Override
    protected void handleOnDestroy() {
        closeTrackInternal();
        super.handleOnDestroy();
    }
}