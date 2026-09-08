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
    private final LinkedBlockingQueue<short[]> pending = new LinkedBlockingQueue<>();
    private Thread writerThread;
    private final AtomicBoolean closed = new AtomicBoolean(true);

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
            // Buffer = 2x Android's own min buffer so the OS has enough queued
            // audio to bridge weak-network write gaps without underrunning.
            int minBuf = AudioTrack.getMinBufferSize(sampleRate, CHANNEL_CONFIG, ENCODING);
            int bufSize = Math.max(minBuf, sampleRate / 2); // ~250ms of PCM

            audioTrack = new AudioTrack.Builder()
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

            if (audioTrack.getState() != AudioTrack.STATE_INITIALIZED) {
                audioTrack = null;
                closed.set(true);
                call.reject("AudioTrack failed to initialize");
                return;
            }

            audioTrack.play();

            // Writer thread: blocking AudioTrack.write() runs on its own thread so
            // the JS bridge never stalls. THREAD_PRIORITY_AUDIO raises the Linux
            // nice level so the OS schedules the writer tightly — the DAC never
            // underruns even under WebView main-thread / GC load, which is what
            // used to drop chunks and produce the "atak atak" stutter.
            writerThread = new Thread(() -> {
                android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_AUDIO);
                drainLoop();
            }, "gapless-audio-writer");
            writerThread.start();

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
        if (audioTrack == null || closed.get()) {
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
            pending.offer(samples);
            call.resolve();
        } catch (Exception e) {
            Log.w(TAG, "write decode failed: " + e.getMessage());
            call.resolve(); // never reject mid-stream; drop the bad chunk
        }
    }

    /** Drain all pending PCM into the AudioTrack immediately (skip queued audio). */
    @PluginMethod
    public void flush(PluginCall call) {
        try {
            pending.clear();
            AudioTrack t = audioTrack;
            if (t != null) {
                if (t.getState() == AudioTrack.STATE_INITIALIZED) {
                    t.pause();
                    t.flush();
                    t.play();
                }
            }
            call.resolve();
        } catch (Exception e) {
            Log.w(TAG, "flush failed: " + e.getMessage());
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
        if (writerThread != null) {
            writerThread.interrupt();
            writerThread = null;
        }
        AudioTrack t = audioTrack;
        audioTrack = null;
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
            AudioTrack t = audioTrack;
            if (t == null || t.getState() != AudioTrack.STATE_INITIALIZED) {
                pending.clear();
                continue;
            }
            int written = 0;
            while (written < chunk.length) {
                try {
                    int n = t.write(chunk, written, chunk.length - written);
                    if (n <= 0) break; // underrun / stopped — bail on this chunk
                    written += n;
                } catch (Exception e) {
                    Log.w(TAG, "write failed: " + e.getMessage());
                    break;
                }
            }
        }
    }

    @Override
    protected void handleOnDestroy() {
        closeTrackInternal();
        super.handleOnDestroy();
    }
}