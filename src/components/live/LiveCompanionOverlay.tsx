import { useEffect, useRef, useState, useMemo, useCallback, memo, type MutableRefObject } from 'react';
import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Mic,
  MicOff,
  Camera,
  CameraOff,
  SwitchCamera,
  Monitor,
  PhoneOff,
  PhoneCall,
  Volume2,
  Minimize2,
  Settings,
  Sparkles,
  Check,
  MessageSquare,
  Send,
  X,
  EyeOff,
  ChevronDown,
  Wrench,
} from 'lucide-react';
import type { ChatMessage, ChatToolCallRecord } from '../../core/domain/chat';
import { isPureSilenceToken } from '../../core/domain/chat';
import { TOOL_LABELS, type ChatToolMeta } from '../../core/domain/chat-tools';
import { sanitizeControlTokens } from '../../features/chat/leak-sanitizer';
import type {
  LiveAudioRoute,
  LiveCameraLens,
  LiveCallOrigin,
  LiveSessionStatus,
  LiveSettingsConfig,
  LiveStreamStats,
  LiveTranscriptItem,
} from '../../core/domain/live-types';
import { requiresLiveReconnect } from '../../core/domain/live-types';
import { GeminiLiveClient, type LiveClientCallbacks } from '../../core/domain/live-client';
import { proactiveAgentService } from '../../features/ai/proactive-agent.service';
import { setLiveCallActive } from '../../features/ai/live-call-state';
import { haptic, hapticError } from '../../lib/haptics';
import ChatMarkdown from '../ChatMarkdown';
import StreamingText from '../StreamingText';
import LiveSettingsModal from './LiveSettingsModal';
import {
  stopLiveCompanionService,
  armLiveCall,
  markLiveCallConnected,
  isLiveCompanionServiceActive,
  clearLiveCallInterrupted,
  onPiPModeChanged,
} from '../../lib/live-companion-service';
import { setLiveCallReplyHandler, LIVE_CALL_SESSION_ID } from '../../lib/notification-actions';
import { notifyAiReply, LIVE_CHANNEL_ID, isAppActive, type NotificationBubble } from '../../lib/notifications';
import { resetNativeAudioRoute } from '../../lib/native-audio-route';

// The call belongs to this module-level runtime, not to a particular overlay
// instance. Navigation/minimising may unmount the observer without hanging up.
let activeLiveClient: GeminiLiveClient | null = null;

// Ever-increasing overlay generation. Every overlay mount captures `++overlayEpoch`
// as its own epoch. Global native teardown calls (stopLiveCompanionService,
// clearLiveCallInterrupted) are SHARED — a stale/cancelled mount must never tear
// down the FGS/lifecycle that a NEWER mount (a fresh call started while the old
// one was still cleaning up) has already armed. Gating those global calls on
// `myEpoch === overlayEpoch` makes the global FGS/lifecycle ownership
// generation-scoped: only the newest overlay may touch the shared service.
let overlayEpoch = 0;

/**
 * AUDIT FIX (round 3, SEVERE): scrub secrets + raw SDK internals out of a live
 * error message before it is rendered in the student-facing banner. Without
 * this, a gateway/provider error string could surface the configured baseUrl
 * (e.g. `wss://my-gateway.box/ws/...BidiGenerateContent`) or a pasted API key
 * verbatim. Chat messages are already leak-sanitized; live errors were the gap.
 */
function scrubLiveErrorMessage(message: string, secrets: { baseUrl?: string; apiKey?: string }): string {
  let out = message;
  const base = secrets.baseUrl?.trim();
  const key = secrets.apiKey?.trim();
  if (base) {
    try {
      const u = new URL(base);
      // Replace both the full URL and its bare host so partial echoes are caught.
      out = out.split(base.replace(/\/+$/, '')).join('[your-gateway]');
      out = out.split(u.host).join('[your-gateway-host]');
    } catch {
      out = out.split(base).join('[your-gateway]');
    }
  }
  if (key && key.length >= 4) out = out.split(key).join('***');
  // Mask any `key=...` query param that may appear in a echoed SDK URL.
  out = out.replace(/([?&]key=)[^&\s"'<>]+/gi, '$1***');
  return sanitizeControlTokens(out).trim();
}

function ThinkingBlock({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mb-2 overflow-hidden rounded-lg border border-peak/20 bg-peak/5">
      <button
        type="button"
        onClick={() => {
          haptic();
          setOpen((v) => !v);
        }}
        className="flex w-full items-center justify-between px-2.5 py-1.5 text-[10px] font-semibold text-muted transition-colors hover:text-text"
      >
        <span>AI soch raha hai ({text.length} chars)</span>
        <ChevronDown size={11} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="max-h-48 overflow-y-auto border-t border-peak/15 px-2.5 py-2 text-[11px] leading-relaxed text-muted">
          {streaming ? <StreamingText text={text} /> : <ChatMarkdown text={text} />}
        </div>
      )}
    </div>
  );
}

function ToolCallsBlock({ calls }: { calls: ChatToolCallRecord[] }) {
  const [open, setOpen] = useState(false);
  const okCount = calls.filter((c) => c.ok).length;
  return (
    <div className="mb-2 overflow-hidden rounded-lg border border-peak/20 bg-peak/5">
      <button
        type="button"
        onClick={() => {
          haptic();
          setOpen((v) => !v);
        }}
        className="flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-[10px] font-semibold text-muted transition-colors hover:text-text"
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <Wrench size={11} className="shrink-0 text-peak" />
          <span className="truncate">
            {calls.length} tool{calls.length > 1 ? 's' : ''} use kiye
            {okCount !== calls.length ? ` — ${calls.length - okCount} fail` : ''}
          </span>
        </span>
        <ChevronDown size={11} className={`shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="max-h-72 overflow-y-auto border-t border-peak/15 px-2.5 py-2 text-[11px] leading-relaxed">
          {calls.map((c, i) => (
            <div key={i} className="mb-2 last:mb-0">
              <div className="flex items-center gap-1.5 font-semibold text-text">
                <span className="shrink-0">{c.ok ? '✅' : '❌'}</span>
                <span className="truncate">{TOOL_LABELS[c.action] ?? c.action}</span>
              </div>
              <div className="mt-1 pl-5 text-muted text-xs markdown-body">
                <ChatMarkdown text={c.message || ''} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ToolChip({ id, catalog, onRemove }: { id: string; catalog: ChatToolMeta[]; onRemove: () => void }) {
  const tool = catalog.find((t) => t.id.toLowerCase() === id.toLowerCase());
  return (
    <div className="flex min-w-0 shrink-0 items-center gap-1.5 rounded-xl border border-l/35 bg-l/10 px-2 py-1">
      <span className="text-[10px] font-bold leading-tight text-l">@{id}</span>
      {tool && <span className="hidden text-[9px] text-muted sm:inline">{tool.label}</span>}
      <button
        type="button"
        onClick={onRemove}
        className="rounded-full p-0.5 text-muted hover:bg-danger/10 hover:text-danger"
        aria-label={`Remove ${id} from tools`}
      >
        <X size={11} />
      </button>
    </div>
  );
}

interface LiveCompanionOverlayProps {
  isOpen: boolean;
  onClose: (transcripts: LiveTranscriptItem[]) => void;
  apiKey: string;
  systemPrompt: string;
  userPersona?: string;
  memoryContext: string;
  initialMicStream: MediaStream;
  initialCameraStream?: MediaStream;
  initialMessages?: ChatMessage[];
  toolCatalog?: ChatToolMeta[];
  config: LiveSettingsConfig;
  onUpdateConfig: (newConfig: LiveSettingsConfig) => void;
  onExecuteTool?: (name: string, args: Record<string, unknown>) => Promise<any>;
  onTranscriptUpdate?: (transcripts: LiveTranscriptItem[]) => void;
  /** Incoming-call meta — AI ko batata hai ki usne call ki hai (nahi toh "student called you"). */
  incomingCallMeta?: { isIncomingCall: boolean; reason?: string; origin?: LiveCallOrigin };
  /** True when the pre-capture path (permission modal / fast path) already acquired native audio focus. */
  audioFocusAlreadyGranted?: boolean;
  /** Imperative handle: ChatScreen sets this to the overlay's hang-up routine so
   *  the `endLiveCall` live tool can programmatically end the call. */
  endLiveCallRef?: MutableRefObject<(() => void) | null>;
}

export default function LiveCompanionOverlay({
  isOpen,
  onClose,
  apiKey,
  systemPrompt,
  userPersona = '',
  memoryContext,
  initialMicStream,
  initialCameraStream,
  initialMessages = [],
  toolCatalog = [],
  config,
  onUpdateConfig,
  incomingCallMeta,
  onExecuteTool,
  onTranscriptUpdate,
  audioFocusAlreadyGranted = false,
  endLiveCallRef,
}: LiveCompanionOverlayProps) {
  const [status, setStatus] = useState<LiveSessionStatus>('connecting');
  const [transcripts, setTranscripts] = useState<LiveTranscriptItem[]>([]);
  const [showChatInput, setShowChatInput] = useState(false);
  const [isExecutingTool, setIsExecutingTool] = useState(false);
  const [stats, setStats] = useState<LiveStreamStats>({
    latencyMs: 24,
    inputVolume: 0,
    outputVolume: 0,
    fps: 0,
    framesSent: 0,
  });

  const [isMuted, setIsMuted] = useState(false);
  const [isCameraActive, setIsCameraActive] = useState(Boolean(initialCameraStream));
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [isVisionPreviewVisible, setIsVisionPreviewVisible] = useState(true);
  const [cameraLens, setCameraLens] = useState<LiveCameraLens>('environment');
  const [audioRoute, setAudioRoute] = useState<LiveAudioRoute>(config.defaultAudioRoute);
  const [showAudioMenu, setShowAudioMenu] = useState(false);

  const [isMinimized, setIsMinimized] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  /** Review-10 P1: the Live FGS died right after commit — background/PiP continuation is no longer guaranteed. */
  const [fgsDegraded, setFgsDegraded] = useState(false);
  const [activeTool, setActiveTool] = useState<{ name: string; args: any; status: 'running' | 'done' } | null>(null);

  const isProactiveEnabled = proactiveAgentService.getPreferences().enabled;
  const [callDurationSeconds, setCallDurationSeconds] = useState(0);

  useEffect(() => {
    const isLive = status === 'connected' || status === 'listening' || status === 'speaking' || status === 'thinking' || status === 'background-pip-active';
    if (!isOpen || !isLive) {
      if (!isOpen || status === 'connecting' || status === 'error') setCallDurationSeconds(0);
      return;
    }
    const timer = setInterval(() => {
      setCallDurationSeconds((prev) => prev + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, [isOpen, status]);

  const formatDuration = (totalSec: number) => {
    const mins = Math.floor(totalSec / 60);
    const secs = totalSec % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const clientRef = useRef<GeminiLiveClient | null>(null);
  /** AUDIT FIX (round 1, MEDIUM): while a settings-change reconnect tears the
   *  session down (reconnectWithNewConfig → disconnect(true) → status
   *  'disconnected'), the status mapper must NOT flash the red
   *  "Call disconnected unexpectedly." banner — this teardown is expected and
   *  user-initiated, not a failure. Cleared when the replacement connects. */
  const suppressingDisconnectErrorRef = useRef(false);
  // AUDIT FIX (round 2): generation token so a STALE settings-reconnect promise
  // can never stamp error/suppressing state over a newer reconnect attempt.
  const settingsReconnectGenRef = useRef(0);
  // AUDIT FIX (round 2): tool-reveal clear timer, cancelled on teardown.
  const activeToolTimerRef = useRef<number | null>(null);  const videoPreviewRef = useRef<HTMLVideoElement | null>(null);
  // Debounce handle for the live-call reply notification: coalesces the many
  // per-audio-chunk transcript updates into a clean same-id refresh (so the
  // drawer notification grows with the full long reply instead of being
  // flooded with schedule() calls that can drop / stall).
  const liveNotifTimerRef = useRef<number | null>(null);
  // Live-call stat tick throttle. `live-client` pushes `onStatsUpdate` from the
  // main-thread analyser path about every 80ms (12.5Hz). Committing straight to
  // `setStats` re-renders this whole overlay that fast, which competes with
  // keystrokes (typing delay / hang). We buffer the LATEST stats and only commit
  // to React at ~5Hz (200ms) — the visualizer stays smooth but re-render churn
  // drops ~60%, freeing the shared main thread for typing + voice scheduling.
  const statsThrottleMs = 200;
  const statsTimerRef = useRef<number | null>(null);
  const statsPendingRef = useRef<LiveStreamStats | null>(null);
  // Transcript commit coalesce: Gemini live pushes transcript chunks MANY times
  // per second. Committing each one straight to setTranscripts re-renders the
  // whole overlay per chunk (visualizer + list + composer). Keep the latest
  // snapshot and commit at ~200ms (5Hz) — same cadence as stats — so the text
  // still feels live while render churn drops ~80%.
  const transcriptsTimerRef = useRef<number | null>(null);
  const transcriptsPendingRef = useRef<LiveTranscriptItem[] | null>(null);

  // Initialize and connect Gemini Live
  useEffect(() => {
    if (!isOpen) return;

    // P5 (hang-fix): while the live call overlay is open, the proactive agent
    // must not dispatch scheduled/inactivity incoming calls or nudges — a
    // second call modal on top of a running call is jarring. Cleared in the
    // cleanup below only when no other overlay owns the call anymore.
    setLiveCallActive(true);

    // Expose the hang-up routine to ChatScreen so the `endLiveCall` live tool
    // can end the call programmatically. Cleared in the cleanup below.
    // P10 drain-aware: the TOOL path first lets Misa's goodbye audio finish
    // (0-8s, real pending playback — no fixed guess) before the line drops.
    // The manual hang-up button keeps calling handleEndCall() DIRECTLY → instant.
    if (endLiveCallRef) {
      endLiveCallRef.current = () => {
        void (async () => {
          try {
            await clientRef.current?.waitForAudioDrained();
          } catch {}
          handleEndCall();
        })();
      };
    }

    const callbacks: LiveClientCallbacks = {
      onStatusChange: (newStatus) => {
        if (newStatus === 'idle' || newStatus === 'disconnected') {
          // AUDIT FIX: an expected teardown during a settings-change reconnect
          // is NOT an error — keep the UI in a neutral reconnecting state.
          if (suppressingDisconnectErrorRef.current) {
            setStatus('reconnecting');
            return;
          }
          if (!cancelled) {
            setStatus('error');
            setErrorMessage((prev) => prev || 'Call disconnected unexpectedly.');
          }
          return;
        }
        setStatus(newStatus);
        if (newStatus === 'connected') {
          setErrorMessage(null);
          suppressingDisconnectErrorRef.current = false;
        }
      },
      onTranscriptUpdate: (newTranscripts) => {
        // Parent (chat history sink) + notification debounce get every update
        // immediately; only THIS overlay's DOM commit is coalesced below.
        onTranscriptUpdate?.(newTranscripts);
        // Notification chat trick: sirf assistant ka latest message notification
        // me dikhao (WhatsApp style), aur jaise-jaise reply stream hota hai
        // same-id se update karke poora text dikhao.
        const lastAssistant = [...newTranscripts].reverse().find((t) => t.role === 'assistant');
        if (!lastAssistant?.text) return;
        // Collapsed preview + expanded full response: Markdown preserved,
        // math formulas rendered in Unicode, code blocks readable, expandable
        // without truncation ("long responses expandable, truncated nahi").
        const assistantText = lastAssistant.text;
        const messages: NotificationBubble[] = newTranscripts.slice(-20).map((t) => ({
          text: t.text || '',
          at: t.timestamp ? new Date(t.timestamp).getTime() : Date.now(),
          sender: t.role === 'assistant' ? 'ai' : 'user',
        }));
        // force=true: PiP mode me appActive still true hota hai, force
        // bypasses the chatTabActive skip so notification aati hai.
        // LIVE_CHANNEL_ID: silent channel (no popup/sound) — live-call chat
        // notifications show in the drawer even while the app is foreground,
        // without disturbing the call. (Contrast: normal chat replies use the
        // HIGH-importance channel only when the chat tab is NOT being watched.)
        //
        // Trailing debounce: har audio chunk pe schedule() flood na karo —
        // foreground me ~2.5s ke settle hone par ek hi same-id refresh do taaki sentence
        // ke beech me IPC churn na ho, background me fast 300ms debounce do taaki throttled timers se drop na ho.
        const notifDelay = isAppActive() ? 2500 : 300;
        if (liveNotifTimerRef.current !== null) window.clearTimeout(liveNotifTimerRef.current);
        liveNotifTimerRef.current = window.setTimeout(() => {
          liveNotifTimerRef.current = null;
          void notifyAiReply('Misa Live', assistantText, LIVE_CALL_SESSION_ID, 0, true, assistantText, messages, {
            channelId: LIVE_CHANNEL_ID,
            preferBigText: true,
          });
        }, notifDelay);

        // Coalesced commit to the overlay's own transcript DOM.
        transcriptsPendingRef.current = newTranscripts;
        if (transcriptsTimerRef.current === null) {
          transcriptsTimerRef.current = window.setTimeout(() => {
            transcriptsTimerRef.current = null;
            const latest = transcriptsPendingRef.current;
            transcriptsPendingRef.current = null;
            if (latest) setTranscripts(latest);
          }, 200);
        }
      },
      onStatsUpdate: (newStats) => {
        // Throttle: keep the latest, but flush to React at statsThrottleMs ticks.
        statsPendingRef.current = newStats;
        if (statsTimerRef.current === null) {
          statsTimerRef.current = window.setTimeout(() => {
            statsTimerRef.current = null;
            if (statsPendingRef.current) setStats(statsPendingRef.current);
          }, statsThrottleMs);
        }
      },
      onExecuteTool: onExecuteTool ? (name, args) => onExecuteTool(name, args) : undefined,
      onToolCall: (name, args) => {
        setActiveTool({ name, args, status: 'running' });
      },
      onToolResult: (name) => {
        setActiveTool({ name, args: {}, status: 'done' });
        // AUDIT FIX (round 2, LOW): track the reveal timer so teardown can
        // cancel it — previously it fired untracked after unmount.
        if (activeToolTimerRef.current !== null) window.clearTimeout(activeToolTimerRef.current);
        activeToolTimerRef.current = window.setTimeout(() => {
          activeToolTimerRef.current = null;
          setActiveTool(null);
        }, 3500);
      },
      onError: (err) => {
        hapticError();
        setStatus('error');
        setErrorMessage(scrubLiveErrorMessage(String(err || ''), { baseUrl: config.baseUrl, apiKey }));
      },
    };
    const existingClient = activeLiveClient;
    const liveClient = existingClient || new GeminiLiveClient(config, callbacks);
    liveClient.setCallbacks(callbacks);
    if (!existingClient) {
      liveClient.setPrompts(systemPrompt, memoryContext, userPersona);
      // ChatScreen already caps initialMessages at 25 (conversationHistoryLength);
      // tell the client to keep that cap instead of its default 15.
      liveClient.setRecentChatHistory(initialMessages, 25);
    }
    clientRef.current = liveClient;
    let cancelled = false;
    // This mount's generation: only the newest overlay may run the SHARED native
    // teardown (FGS stop / lifecycle clear). See module-level `overlayEpoch`.
    const myEpoch = ++overlayEpoch;

    // Review-9 P0.1: single rollback for a CANCELLED startup (not just an
    // error). A cancelled/unmounted startup that has NOT committed must not
    // leave any resource behind: stop the handed-off mic/camera tracks, tear
    // down the client session + audio focus/route, stop the FGS (which also
    // clears the persisted ARMED marker), and release the module-level
    // singleton only when THIS mount started the call.
    //
    // Review-11 P1 (ownership-aware): the ENTIRE rollback is gated on
    // `!existing`. When this mount is re-attaching to an ALREADY-established
    // singleton call (existingClient), this component does NOT own the
    // mic/camera streams — they belong to the running call the user is on. A
    // cancelled idempotent arm(), a stale post-commit gate, or a transient
    // startup error in the reattach path must NEVER call t.stop() on those
    // streams, or the user's live audio dies mid-call while the call keeps
    // running. Stopping tracks + disconnect + FGS release ALL belong to THIS
    // mount's startup only.
    function rollbackStartup(c: typeof liveClient, existing: typeof existingClient, mic: MediaStream, cam?: MediaStream, keepMic = false) {
      if (existing) return; // this mount doesn't own the streams/session — never touch them
      if (!keepMic) mic.getTracks().forEach((t) => t.stop());
      cam?.getTracks().forEach((t) => t.stop());
      c.disconnect();
      if (activeLiveClient === c) activeLiveClient = null;
      // Global FGS teardown is SHARED + generation-scoped: if a newer overlay
      // (a fresh call) has already armed the service during our cleanup, we
      // must NOT stop it. Only the newest mount may tear down the shared FGS.
      if (myEpoch === overlayEpoch) {
        void stopLiveCompanionService();
        void resetNativeAudioRoute().catch(() => undefined);
      }
    }

    (async () => {
      try {
        // P2 + P8: arm is AWAITED and runs on EVERY overlay mount (idempotent
        // natively). This closes the connecting-window race (the old
        // `void armLiveCall()` could still lose a Home press taken before the
        // native bridge round-trip finished) AND re-arms a recreated Activity:
        // after Activity recreation the singleton live client survives but
        // MainActivity.onDestroy() reset liveCallActive — onUserLeaveHint would
        // otherwise silently skip auto-PiP for the whole revived call.
        //
        // Review-7 P0/P1 + review-9 P0.1: the startup is ONE TRANSACTION.
        // arm → connect → voice → camera → markLiveCallConnected either all
        // succeed (commit) or the single rollback below undoes EVERYTHING.
        // Review-9 hardens it: `startupAttempt` is captured from the client's
        // authoritative generation token after connect, and EVERY awaited step
        // is gated on `!cancelled` AND `activeAttempt(startupAttempt)`. If the
        // user cancels/mount unmounts mid-flight, the remaining awaited work is
        // dropped and the rollback stops the mic/camera streams + tears down the
        // session + FGS + ARMED marker — a cancelled startup can never commit a
        // late markCallConnected or leave a half-armed service behind.
        await armLiveCall();
        // Review-10 P0 (arm→connect gate): if the user cancelled / unmounted
        // DURING the arm native round-trip, do NOT proceed into connect() —
        // otherwise a cancelled startup would still open a Gemini session
        // (short-lived, torn down by rollback, but wasted + a visible blip).
        // Gate here so a cancelled startup never even begins socket/audio setup.
        if (cancelled) {
          rollbackStartup(liveClient, existingClient, initialMicStream, initialCameraStream);
          return;
        }

        if (!existingClient) {
          // P1: the pre-capture path (permission modal / remembered fast path)
          // already acquired native audio focus before getUserMedia. Hand that
          // fact in so connect() does NOT request focus a second time — focus
          // stays single-owner; connect only applies the route.
          await liveClient.connect(apiKey, incomingCallMeta, { audioFocusAlreadyGranted, baseUrl: config.baseUrl });
          if (cancelled || liveClient.isClosed()) {
            rollbackStartup(liveClient, existingClient, initialMicStream, initialCameraStream);
            if (!cancelled) {
              setStatus('error');
              setErrorMessage('Call disconnected.');
            }
            return;
          }

          await liveClient.startVoiceStreaming(initialMicStream);
          if (cancelled || liveClient.isClosed()) {
            rollbackStartup(liveClient, existingClient, initialMicStream, initialCameraStream);
            if (!cancelled) {
              setStatus('error');
              setErrorMessage('Call disconnected.');
            }
            return;
          }

          if (initialCameraStream) {
            const stream = await liveClient.startCameraStream('environment');
            if (cancelled || liveClient.isClosed()) {
              rollbackStartup(liveClient, existingClient, initialMicStream, initialCameraStream);
              if (!cancelled) {
                setStatus('error');
                setErrorMessage('Call disconnected.');
              }
              return;
            }
            setIsCameraActive(true);
            setIsVisionPreviewVisible(true);
            if (videoPreviewRef.current) {
              videoPreviewRef.current.srcObject = stream;
            }
          }
        }

        // Review-8 P1 + review-9 P0.2: the Gemini session has committed —
        // promote the persisted process-death lifecycle from ARMED to CONNECTED
        // so a later kill surfaces the interruption banner accurately (never for
        // an unfinished startup). AWAITED + generation-gated: the commit only
        // runs while `!cancelled` AND client is not closed.
        if (!cancelled && !liveClient.isClosed()) {
          await markLiveCallConnected();
          if (cancelled || liveClient.isClosed()) {
            if (myEpoch === overlayEpoch) await clearLiveCallInterrupted();
            rollbackStartup(liveClient, existingClient, initialMicStream, initialCameraStream);
            if (!cancelled) {
              setStatus('error');
              setErrorMessage('Call disconnected.');
            }
            return;
          }
          // Review-9 P1.4: verify the foreground service is ACTUALLY running
          // (onCreate→true, onDestroy→false — clears if the OS killed it). If
          // startForegroundService() was requested but the service died, we
          // must not continue to claim FGS-backed background/audio-continue
          // support. Best-effort: surface a warning instead of fabricating a
          // background contract we no longer have.
          const fgsActive = await isLiveCompanionServiceActive();
          if (fgsActive === false) {
            console.warn('[LiveCompanion] FGS not active after startup commit — background audio/PiP persistence not guaranteed.');
            // Review-10 P1 (degraded state, not just a console warning): make the
            // loss of FGS-backed background/PiP capability VISIBLE to the user,
            // so they aren't surprised when audio/persistence lapses the moment
            // they leave the app. The foreground call still works; only the
            // background contract is revoked.
            setFgsDegraded(true);
          }
        }
        if (!cancelled) {
          setErrorMessage(null);
        }
      } catch (err: any) {
        // SINGLE ROLLBACK FINALIZER for every uncommitted startup path.
        //   - stopLiveCompanionService(): clears the FGS + liveCallActive AND
        //     the was_interrupted intent — a failed attempt never surfaces a
        //     false "call was interrupted" banner on next launch.
        //   - liveClient.disconnect(): tears down socket + audio focus + route.
        // Only roll back when THIS mount started the call. Re-attaching to an
        // established singleton call (existingClient) must never kill it just
        // because the idempotent arm() hiccuped.
        // AUTO-RETRY (production hardening): when the Gemini handshake itself
        // failed (session never established), DO NOT stop the mic — hand it to
        // the client so the user's next text/speech retries the SAME selected
        // model automatically instead of forcing a manual re-tap of Live Call.
        const sessionEstablished =
          liveClient.getStatus() === 'connected' ||
          liveClient.getStatus() === 'listening' ||
          liveClient.getStatus() === 'speaking' ||
          liveClient.getStatus() === 'thinking' ||
          liveClient.getStatus() === 'background-active' ||
          liveClient.getStatus() === 'background-pip-active';
        const keepMicForRetry = !existingClient && !cancelled && !sessionEstablished;
        if (keepMicForRetry) {
          liveClient.stashRetryMicStream(initialMicStream);
        }
        rollbackStartup(liveClient, existingClient, initialMicStream, initialCameraStream, keepMicForRetry);
        // AUDIT FIX (round 1, MEDIUM): surface the error on the re-attach path
        // too (existingClient). Before, any throw while re-attaching to an
        // established call left the overlay silently stuck on a stale status
        // with no message and no retry affordance. Rollback stays gated on
        // !existingClient (never kill a healthy call); the ERROR TEXT is shown
        // whenever the user is still here.
        if (!cancelled) {
          hapticError();
          setStatus('error');
          setErrorMessage(scrubLiveErrorMessage(err?.message || 'Connection to Gemini Live failed', { baseUrl: config.baseUrl, apiKey }));
        }
      }
    })();
    activeLiveClient = liveClient;

    // Capacitor lifecycle is authoritative on Android.  This is intentionally
    // separate from browser visibilitychange and does not itself reconnect.
    // KEY FIX: When the app goes to background during an active call, we
    // auto-enter PiP — this keeps the AudioContext alive, so mic + WebSocket
    // + Gemini Live audio all continue in the background (WhatsApp-style).
    let appStateListener: { remove: () => Promise<void> } | null = null;
    let pipListener: (() => void) | null = null;
    let released = false;
    if (Capacitor.isNativePlatform()) {
      void App.addListener('appStateChange', ({ isActive }) => {
        if (isActive) {
          liveClient.setBackgroundActive(false);
        } else {
          // App background me ja raha hai. PiP entry ab NATIVE
          // MainActivity.onUserLeaveHint se handle hoti hai (reliable, exact
          // lifecycle moment pe) — yahan sirf audio-continue state set karte
          // hain. Isse dono paths ka duplicate/racy PiP entry khatam. PiP me
          // user abhi "call me" hota hai, isliye audio CONTINUE hota hai
          // (WhatsApp-style, keepAudioPlaying=true). Sirf fully-hidden me
          // audio discard hota hai.
          liveClient.setBackgroundActive(true, true);
          // Review-9 P1.5 (ENFORCED background camera contract, option A —
          // voice-only in background): the Live FGS is MICROPHONE|MEDIA_PLAYBACK
          // and does NOT grant background camera capture, so camera/video is
          // supported ONLY while the app is on-screen. On leaving the visible
          // lifecycle (background OR PiP) we STOP any running camera/screen-share
          // — not merely "not start it" — so the raw capture track can never run
          // outside the visible window (a privacy + Android while-in-use policy
          // boundary; no camera-type FGS is declared). Voice continues via the
          // PiP AudioContext (keepAudioPlaying=true). Camera resumes when the
          // user returns to the full-screen call. Screen share / MediaProjection
          // is treated as a separate lifecycle and is stopped here too (it cannot
          // run backgrounded without its own FGS).
          liveClient.stopVision();
        }
      }).then(listener => {
        if (released) void listener.remove();
        else appStateListener = listener;
      });

      // PiP mode change listener — log karo aur future UI ke liye state track.
      pipListener = onPiPModeChanged((inPiP) => {
        if (inPiP) {
          // PiP mode entered — mic + audio naturally continue (AudioContext alive).
        } else {
          // PiP se wapas aaya — full screen restore, normal UI.
        }
      });
    }

    return () => {
      cancelled = true;
      released = true;
      if (endLiveCallRef) endLiveCallRef.current = null;
      if (liveNotifTimerRef.current !== null) {
        window.clearTimeout(liveNotifTimerRef.current);
        liveNotifTimerRef.current = null;
      }
      if (statsTimerRef.current !== null) {
        window.clearTimeout(statsTimerRef.current);
        statsTimerRef.current = null;
      }
      statsPendingRef.current = null;
      if (transcriptsTimerRef.current !== null) {
        window.clearTimeout(transcriptsTimerRef.current);
        transcriptsTimerRef.current = null;
      }
      if (activeToolTimerRef.current !== null) {
        window.clearTimeout(activeToolTimerRef.current);
        activeToolTimerRef.current = null;
      }
      transcriptsPendingRef.current = null;
      if (appStateListener) void appStateListener.remove();
      if (pipListener) pipListener();
      // Do not make React ownership equal call ownership. Explicit hangup is
      // the only teardown path; a remounted overlay reattaches its callbacks.
      if (clientRef.current === liveClient) {
        clientRef.current = null;
      }
      // P5 (hang-fix): release the live-call-active flag for the proactive
      // agent — but only when NO overlay still owns a live call (a reattach
      // remount must not clear it mid-call).
      if (!activeLiveClient) setLiveCallActive(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, apiKey]);

  // Dynamically update audio playback speed on the active live client
  useEffect(() => {
    if (clientRef.current && config.playbackSpeed) {
      clientRef.current.setPlaybackSpeed(config.playbackSpeed);
    }
  }, [config.playbackSpeed]);

  // Audio mute toggle
  function handleToggleMute() {
    haptic();
    const nextMuted = !isMuted;
    setIsMuted(nextMuted);
    clientRef.current?.setMuted(nextMuted);
  }

  // Stop Vision completely (Camera or Screen Share) and return to voice hologram
  function handleStopVision() {
    haptic();
    const client = clientRef.current;
    if (client) {
      client.stopVision();
    }
    setIsCameraActive(false);
    setIsScreenSharing(false);
    setIsVisionPreviewVisible(true);
    if (videoPreviewRef.current) {
      videoPreviewRef.current.srcObject = null;
    }
  }

  // Camera toggle (Start / Stop)
  async function handleToggleCamera() {
    haptic();
    const client = clientRef.current;
    if (!client) return;

    if (isCameraActive) {
      handleStopVision();
    } else {
      try {
        if (isScreenSharing) {
          client.stopVision();
          setIsScreenSharing(false);
        }
        const stream = await client.startCameraStream(cameraLens);
        setIsCameraActive(true);
        setIsVisionPreviewVisible(true);
        if (videoPreviewRef.current) {
          videoPreviewRef.current.srcObject = stream;
        }
      } catch (err: any) {
        hapticError();
        setErrorMessage(err?.message || 'Camera access permission nahi mili');
      }
    }
  }

  // Camera lens flip (Front <-> Back)
  async function handleFlipCamera() {
    haptic();
    const client = clientRef.current;
    if (!client || !isCameraActive) return;
    try {
      const stream = await client.flipCamera();
      const nextLens: LiveCameraLens = cameraLens === 'environment' ? 'user' : 'environment';
      setCameraLens(nextLens);
      if (videoPreviewRef.current) {
        videoPreviewRef.current.srcObject = stream;
      }
    } catch (err: any) {
      hapticError();
      setErrorMessage(err?.message || 'Camera flip nahi ho saka');
    }
  }

  // Screen share toggle (Start / Stop)
  async function handleToggleScreenShare() {
    haptic();
    const client = clientRef.current;
    if (!client) return;

    if (isScreenSharing) {
      handleStopVision();
    } else {
      try {
        if (isCameraActive) {
          client.stopVision();
          setIsCameraActive(false);
        }
        const stream = await client.startScreenStream(() => {
          setIsScreenSharing(false);
          setIsVisionPreviewVisible(true);
          if (videoPreviewRef.current) {
            videoPreviewRef.current.srcObject = null;
          }
        });
        setIsScreenSharing(true);
        setIsVisionPreviewVisible(true);
        if (videoPreviewRef.current) {
          videoPreviewRef.current.srcObject = stream;
        }
      } catch (err: any) {
        hapticError();
        setErrorMessage(err?.message || 'Screen share start nahi ho saka');
      }
    }
  }

  // Audio route switch
  async function handleSelectAudioRoute(route: LiveAudioRoute) {
    haptic();
    // Optimistic label so the menu Check moves instantly, then reconcile with
    // the ACTUAL applied route (setAudioRoute is transactional: it falls back
    // to the loudspeaker and reports reality if Bluetooth SCO can't confirm,
    // so we never show "Bluetooth" while audio is still on the phone speaker).
    setAudioRoute(route);
    setShowAudioMenu(false);
    const actual = await clientRef.current?.setAudioRoute(route);
    if (actual) setAudioRoute(actual);
  }

  // In-Call Live Text Message with Tool Execution
  // Stable identity (useCallback) so the memoized LiveChatComposer — the Live
  // textbox — does NOT re-render on the high-frequency overlay re-renders that
  // the live stats/analyser ticks and per-chunk transcript updates trigger.
  // Keystrokes then only re-render the composer subtree, keeping typing
  // responsive while the call streams.
  const handleSendChatMessage = useCallback(async (rawText: string, selectedTools: string[]) => {
    const text = rawText.trim();
    if (!text && selectedTools.length === 0) return;
    haptic();

    let cleanPrompt = text;
    const words = text.split(/\s+/);
    for (const w of words) {
      if (w.startsWith('@')) {
        const id = w.slice(1);
        if (toolCatalog.some((t) => t.id.toLowerCase() === id.toLowerCase()) || id.toLowerCase() === 'websearch') {
          if (!selectedTools.includes(id)) {
            selectedTools.push(id);
          }
          cleanPrompt = cleanPrompt.replace(w, '').trim();
        }
      }
    }

    // If tools were selected, execute them immediately!
    const toolCalls: ChatToolCallRecord[] = [];
    let toolContextInjection = '';

    if (selectedTools.length > 0) {
      setIsExecutingTool(true);
      setActiveTool({ name: selectedTools[0], args: { query: cleanPrompt }, status: 'running' });

      for (const toolId of selectedTools) {
        if (toolId.toLowerCase() === 'websearch') {
          if (onExecuteTool) {
            const res = await onExecuteTool('webSearch', { query: cleanPrompt || text });
            const searchResultText = res?.searchResult || res?.result || 'Web search complete';
            toolCalls.push({
              action: 'websearch',
              ok: Boolean(res?.searchResult),
              message: searchResultText,
            });
            toolContextInjection += `\n[LIVE WEB SEARCH RESULTS]:\n${searchResultText}\n`;
          }
        } else if (onExecuteTool) {
          const res = await onExecuteTool(toolId, { query: cleanPrompt, day: 1 });
          let displayMsg = '';
          if (res && typeof res === 'object') {
            displayMsg =
              res?.summary ||
              res?.result ||
              res?.plan ||
              res?.searchResult ||
              res?.context ||
              res?.tests ||
              res?.routine ||
              res?.todos ||
              res?.vaultResources ||
              res?.chatSearchResults ||
              res?.chatSessions ||
              res?.chatTranscript ||
              res?.memorySearchResults ||
              res?.memory ||
              (res?.currentTime ? `Current Time: ${res.currentTime}, Date: ${res.currentDate || ''}` : '') ||
              'Tool executed';
          } else if (typeof res === 'string') {
            displayMsg = res;
          } else {
            displayMsg = 'Tool executed';
          }
          toolCalls.push({
            action: toolId,
            ok: !res?.error,
            message: displayMsg,
          });
          toolContextInjection += `\n[TOOL @${toolId} RESULT]:\n${displayMsg}\n`;
        }
      }

      setIsExecutingTool(false);
      setActiveTool(null);
    }

    // Now send the turn to Gemini Live WebSocket:
    // Clean user prompt is displayed in user bubble, tool context is fed to AI,
    // and toolCalls are rendered inside the assistant's collapsible card box!
    if (clientRef.current) {
      const userPrompt = cleanPrompt || rawText;
      if (toolContextInjection) {
        clientRef.current.sendTextMessage(
          `${toolContextInjection}\nStudent Doubt/Question: ${userPrompt}`,
          userPrompt,
          toolCalls,
        );
      } else {
        clientRef.current.sendTextMessage(userPrompt, userPrompt);
      }
    }
  }, [toolCatalog, onExecuteTool]);

  // End Call & Return Transcripts
  function handleEndCall() {
    haptic();
    const currentTranscripts = clientRef.current?.getTranscripts() || transcripts;
    clientRef.current?.disconnect();
    void stopLiveCompanionService();
    activeLiveClient = null;
    void resetNativeAudioRoute().catch(() => undefined);
    onClose(currentTranscripts);
  }

  // Typing in the live composer = real activity: restart the silence timeline
  // (no "arey suno" mid-composition) WITHOUT stopping her current speech.
  // Throttled so a keystroke storm doesn't spam the client.
  const composerTypingAtRef = useRef(0);
  const handleComposerTyping = useCallback(() => {
    const now = Date.now();
    if (now - composerTypingAtRef.current < 1500) return;
    composerTypingAtRef.current = now;
    clientRef.current?.reportUserTyping();
  }, []);

  // Quick-reply from the live-call notification: type in the shade, and the
  // message lands straight in the Gemini Live session (and shows in the in-app
  // chat) exactly as if it had been typed in the call UI.
  useEffect(() => {
    if (!isOpen) return;
    // Register the handler: when user replies from notification shade, the
    // message routes to the active live session (same as in-app chat send).
    setLiveCallReplyHandler((text) => {
      const msg = (text || '').trim();
      if (!msg) return;
      if (clientRef.current) clientRef.current.sendTextMessage(msg, msg);
    });
    return () => setLiveCallReplyHandler(null);
  }, [isOpen]);

  if (!isOpen) return null;

  // Active latest subtitle
  const latestMessage = transcripts.at(-1);
  // The transcript tail is a live, still-growing assistant reply. It renders
  // as cheap plain text — the full markdown parse happens exactly once, when
  // the tail is superseded (user turn) or the call ends. Kills the per-chunk
  // ChatMarkdown re-parse inside this overlay (the SAME streaming hang fixed
  // for the chat bubbles, now covered on the overlay's own transcript list).
  const streamTailId = latestMessage && latestMessage.role === 'assistant' ? latestMessage.id : null;
  const isStreamingTail = (t: LiveTranscriptItem) => t.id === streamTailId;

  // Dynamic visualizer size from audio output/input levels
  const glowScale = 1 + Math.max(stats.inputVolume, stats.outputVolume) * 0.45;
  const isSpeaking = status === 'speaking';

  // PiP Floating Bubble Mode
  if (isMinimized) {
    return (
      <div className="fixed bottom-24 right-4 z-50">
        <motion.button
          drag
          dragConstraints={{ left: -250, right: 0, top: -450, bottom: 0 }}
          onClick={() => {
            haptic();
            setIsMinimized(false);
          }}
          className="relative flex h-16 w-16 items-center justify-center rounded-full border-2 border-l bg-card shadow-2xl transition-transform active:scale-95"
          style={{ transform: `scale(${glowScale})` }}
        >
          <Sparkles size={24} className="text-l animate-pulse" />
          <span className="absolute -bottom-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full bg-l text-[10px] font-bold text-bg">
            Live
          </span>
        </motion.button>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-bg/95 backdrop-blur-xl text-text select-none">
      {/* Top Floating Bar */}
      <div className="flex items-center justify-between p-4 px-6 z-10">
        <div className="flex items-center gap-2">
          {/* PiP Button */}
          <button
            type="button"
            onClick={() => {
              haptic();
              setIsMinimized(true);
            }}
            className="icon-btn h-9 w-9 rounded-full border border-white/10 bg-white/5"
            aria-label="Minimize to PiP"
          >
            <Minimize2 size={16} />
          </button>

          {/* Connection Status Pill */}
          <div className="flex items-center gap-2 rounded-full border border-white/10 bg-card/80 px-3 py-1 text-xs backdrop-blur">
            <span
              className={`h-2 w-2 rounded-full ${
                status === 'connected' || status === 'background-pip-active'
                  ? 'bg-emerald-400 animate-pulse'
                  : status === 'reconnecting' || status === 'background-active'
                  ? 'bg-amber-400 animate-pulse'
                  : status === 'speaking'
                  ? 'bg-cyan-400 animate-ping'
                  : status === 'listening'
                  ? 'bg-amber-400'
                  : status === 'thinking'
                  ? 'bg-purple-400 animate-spin'
                  : 'bg-red-400'
              }`}
            />
            <span className="font-semibold capitalize text-text">
              {status === 'thinking'
                ? 'Thinking'
                : status === 'reconnecting'
                ? 'Reconnecting'
                : status === 'background-active'
                ? 'Audio paused'
                : status === 'background-pip-active'
                ? 'Live (PiP)'
                : status === 'idle' || status === 'disconnected'
                ? 'Disconnected'
                : status}
            </span>
            {isProactiveEnabled ? (
              <span className="font-mono text-[11px] text-emerald-400 font-medium">{formatDuration(callDurationSeconds)}</span>
            ) : (
              <span className="text-[10px] text-muted">{stats.latencyMs}ms</span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Audio Route Selector */}
          <div className="relative">
            <button
              type="button"
              onClick={() => {
                haptic();
                setShowAudioMenu(!showAudioMenu);
              }}
              className="icon-btn flex items-center gap-1 px-2.5 rounded-full border border-white/10 bg-white/5 text-xs text-text"
            >
              <Volume2 size={15} />
              <span className="capitalize text-[11px]">{audioRoute}</span>
            </button>

            {showAudioMenu && (
              <div className="absolute right-0 mt-2 w-36 overflow-hidden rounded-2xl border border-white/15 bg-card p-1 shadow-2xl z-20">
                <button
                  type="button"
                  onClick={() => handleSelectAudioRoute('speaker')}
                  className="flex w-full items-center justify-between px-3 py-2 text-left text-xs hover:bg-white/5 rounded-xl"
                >
                  <span>📢 Speaker</span>
                  {audioRoute === 'speaker' && <Check size={13} className="text-l" />}
                </button>
                <button
                  type="button"
                  onClick={() => handleSelectAudioRoute('earpiece')}
                  className="flex w-full items-center justify-between px-3 py-2 text-left text-xs hover:bg-white/5 rounded-xl"
                >
                  <span>📞 Earpiece</span>
                  {audioRoute === 'earpiece' && <Check size={13} className="text-l" />}
                </button>
                <button
                  type="button"
                  onClick={() => handleSelectAudioRoute('bluetooth')}
                  className="flex w-full items-center justify-between px-3 py-2 text-left text-xs hover:bg-white/5 rounded-xl"
                >
                  <span>🎧 Headset</span>
                  {audioRoute === 'bluetooth' && <Check size={13} className="text-l" />}
                </button>
              </div>
            )}
          </div>

          {/* Settings button */}
          <button
            type="button"
            onClick={() => {
              haptic();
              setShowSettings(true);
            }}
            className="icon-btn h-9 w-9 rounded-full border border-white/10 bg-white/5"
            aria-label="Live Settings"
          >
            <Settings size={16} />
          </button>
        </div>
      </div>

      {/* Main Companion Display (Audio Visualizer OR Video Preview) */}
      <div className="flex-1 flex flex-col items-center justify-center p-6 relative overflow-hidden">
        {errorMessage && (
          <div className="absolute top-4 mx-auto max-w-sm rounded-2xl border border-danger/40 bg-danger/20 p-3 text-xs text-danger text-center">
            {errorMessage}
          </div>
        )}
        {fgsDegraded && !errorMessage && (
          <div className="absolute top-4 mx-auto max-w-sm rounded-2xl border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-400 text-center">
            Background call continuation ab guaranteed nahi hai (system foreground service start nahi ho saki).
          </div>
        )}

        {/* Video / Screen Share Viewport */}
        {(isCameraActive || isScreenSharing) && isVisionPreviewVisible ? (
          <div className="relative w-full max-w-md aspect-[4/3] rounded-3xl overflow-hidden border border-white/15 bg-black shadow-2xl">
            {isScreenSharing && !videoPreviewRef.current?.srcObject ? (
              <div className="flex flex-col items-center justify-center h-full w-full bg-gradient-to-br from-cyan-950/40 via-bg to-bg/90 p-6 text-center">
                <div className="relative mb-3 flex h-16 w-16 items-center justify-center rounded-2xl bg-cyan-500/20 text-cyan-400 border border-cyan-500/30">
                  <Monitor size={32} className="animate-pulse" />
                  <span className="absolute -top-1 -right-1 flex h-3 w-3">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75" />
                    <span className="relative inline-flex rounded-full h-3 w-3 bg-cyan-500" />
                  </span>
                </div>
                <p className="text-xs font-bold text-text mb-1">Live Screen Stream Active</p>
                <p className="text-[10px] text-muted max-w-[220px] leading-relaxed">
                  Misa aapki screen real-time dekh rahi hai. PDFs, coaching apps ya notes open karo.
                </p>
              </div>
            ) : (
              <video
                ref={videoPreviewRef}
                autoPlay
                playsInline
                muted
                className={`h-full w-full object-cover ${cameraLens === 'user' && isCameraActive ? 'scale-x-[-1]' : ''}`}
              />
            )}
            {/* Overlay Top Controls: Hide Preview vs Stop Sharing */}
            <div className="absolute top-3 left-3 right-3 flex items-center justify-between z-10">
              <span className="rounded-full bg-black/60 px-2.5 py-1 text-[10px] font-bold text-white backdrop-blur">
                {isScreenSharing ? '🖥️ Screen Sharing' : cameraLens === 'user' ? 'Front Cam' : 'Back Cam'}
              </span>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => {
                    haptic();
                    setIsVisionPreviewVisible(false);
                  }}
                  className="flex items-center gap-1 rounded-full bg-black/60 px-2.5 py-1 text-[10px] font-bold text-text hover:bg-black/80 backdrop-blur"
                  title="Hide preview to view notes/screen while keeping stream active"
                >
                  <EyeOff size={11} /> Hide Preview
                </button>
                <button
                  type="button"
                  onClick={handleStopVision}
                  className="rounded-full bg-danger/80 px-2.5 py-1 text-[10px] font-bold text-white hover:bg-danger"
                  title="Stop sharing video entirely"
                >
                  ✕ Stop
                </button>
              </div>
            </div>

            {/* Lens Switch button for camera */}
            {isCameraActive && (
              <button
                type="button"
                onClick={handleFlipCamera}
                className="absolute bottom-3 right-3 icon-btn h-9 w-9 rounded-full bg-black/60 text-white backdrop-blur hover:bg-black/80"
                aria-label="Flip Camera Lens"
              >
                <SwitchCamera size={16} />
              </button>
            )}
          </div>
        ) : (
          /* Pure Audio Holographic Orb Visualizer */
          <div className="flex flex-col items-center justify-center space-y-6">
            {/* Background Stream Active Floating Badge */}
            {(isCameraActive || isScreenSharing) && !isVisionPreviewVisible && (
              <motion.div
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                className="flex items-center gap-2 rounded-full border border-l/40 bg-l/15 px-3 py-1 text-xs text-l shadow-lg backdrop-blur"
              >
                <span>{isScreenSharing ? '🖥️ Screen Streaming Active' : '📷 Camera Streaming Active'}</span>
                <button
                  type="button"
                  onClick={() => {
                    haptic();
                    setIsVisionPreviewVisible(true);
                  }}
                  className="rounded-lg border border-l/40 bg-l/25 px-2 py-0.5 text-[11px] font-semibold text-l hover:bg-l/35"
                >
                  Show
                </button>
                <button
                  type="button"
                  onClick={handleStopVision}
                  className="rounded-lg border border-danger/30 bg-danger/20 px-2 py-0.5 text-[11px] font-semibold text-danger hover:bg-danger/30"
                >
                  Stop
                </button>
              </motion.div>
            )}
            <div className="relative flex items-center justify-center">
              {/* Outer animated wave rings */}
              <div
                style={{ transform: `scale(${glowScale * 1.35})` }}
                className="absolute h-56 w-56 rounded-full border border-l/20 bg-l/5 transition-transform duration-150"
              />
              <div
                style={{ transform: `scale(${glowScale * 1.18})` }}
                className="absolute h-44 w-44 rounded-full border border-l/30 bg-l/10 transition-transform duration-100"
              />

              {/* Core Holographic Orb */}
              <div
                style={{ transform: `scale(${glowScale})` }}
                className={`flex h-32 w-32 items-center justify-center rounded-full transition-all duration-100 shadow-2xl ${
                  isSpeaking
                    ? 'bg-gradient-to-tr from-l to-emerald-400 text-bg shadow-l/60'
                    : 'bg-gradient-to-tr from-l/30 to-card text-l border border-l/50 shadow-black'
                }`}
              >
                <Sparkles size={48} className={isSpeaking ? 'animate-spin' : ''} />
              </div>
            </div>

            <div className="text-center space-y-1">
              <div className="flex items-center justify-center gap-2">
                <h2 className="text-lg font-bold text-text">{isProactiveEnabled ? 'Misa' : 'Misa AI'}</h2>
                <Sparkles size={13} className="text-peak" aria-label="Live feature in development" />
                {isProactiveEnabled && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/20 px-2 py-0.5 text-[10px] font-semibold text-emerald-400 border border-emerald-500/30">
                    <PhoneCall size={10} /> Live Call
                  </span>
                )}
              </div>
              {isProactiveEnabled && (
                <p className="text-xs font-mono text-emerald-400/90 font-medium">{formatDuration(callDurationSeconds)}</p>
              )}
              <p className="text-xs text-muted">
                {status === 'thinking'
                  ? 'Thinking...'
                  : status === 'speaking'
                  ? (isProactiveEnabled ? 'Misa speaking...' : 'Explaining solution...')
                  : status === 'listening'
                  ? (isProactiveEnabled ? 'Listening to you...' : 'Listening to your voice / doubt...')
                  : (isProactiveEnabled ? 'Live Call Connected' : 'Ready to solve JEE problems')}
              </p>
            </div>
          </div>
        )}

        {/* Active Tool Execution / Thinking Indicator Pill */}
        {activeTool && (
          <motion.div
            initial={{ opacity: 0, scale: 0.9, y: 5 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.9, y: 5 }}
            className="mt-3 inline-flex items-center gap-2 rounded-full border border-l/40 bg-l/15 px-4 py-1.5 text-xs font-semibold text-l shadow-xl backdrop-blur-md animate-pulse"
          >
            <Sparkles size={13} className="animate-spin text-l" />
            <span>
              {activeTool.name === 'webSearch'
                ? `Searching Web for: "${activeTool.args?.query || 'latest updates'}"...`
                : activeTool.name === 'getTime'
                ? 'Checking Indian Standard Time (IST)...'
                : activeTool.name === 'getPlan'
                ? 'Fetching study plan...'
                : activeTool.name === 'addTask'
                ? 'Adding task to plan...'
                : `Running tool: @${activeTool.name}...`}
            </span>
          </motion.div>
        )}

        {/* Live Subtitles Floating Card */}
        {latestMessage && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="mt-4 max-h-24 w-full max-w-lg overflow-y-auto rounded-2xl border border-white/10 bg-card/80 p-3.5 text-center text-xs leading-relaxed text-text backdrop-blur-lg shadow-lg"
          >
            <span className="font-bold text-l mr-1.5">
              {latestMessage.role === 'assistant' ? 'Misa:' : 'You:'}
            </span>
            <span>{latestMessage.text}</span>
          </motion.div>
        )}

        {/* In-Call Full Chat History & Live Messages Drawer */}
        <AnimatePresence>
          {showChatInput && (
            <motion.div
              initial={{ opacity: 0, y: 20, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 20, scale: 0.96 }}
              className="absolute inset-x-4 bottom-24 top-16 z-30 flex flex-col overflow-hidden rounded-3xl border border-white/20 bg-card/95 shadow-2xl backdrop-blur-2xl max-w-xl mx-auto"
            >
              {/* Chat Drawer Header */}
              <div className="flex items-center justify-between border-b border-border px-4 py-3 bg-bg/50">
                <div className="flex items-center gap-2">
                  <span className="flex h-7 w-7 items-center justify-center rounded-xl bg-l/15 text-l">
                    <MessageSquare size={16} />
                  </span>
                  <div>
                    <h4 className="text-xs font-bold text-text">Chat History & Live Transcripts</h4>
                    <p className="text-[10px] text-muted">Previous chat messages + live voice turns</p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    haptic();
                    setShowChatInput(false);
                  }}
                  className="icon-btn h-7 w-7 rounded-full border border-white/10 bg-white/5"
                >
                  <X size={14} />
                </button>
              </div>

              {/* Scrollable Message Thread */}
              <div className="flex-1 overflow-y-auto p-4 space-y-3">
                {initialMessages.length === 0 && transcripts.length === 0 && (
                  <div className="flex h-full items-center justify-center text-center text-xs text-muted">
                    Abhi tak koi message nahi hai. Niche type karein ya voice mein bolein!
                  </div>
                )}

                {/* Previous Existing Messages from this Chat Session */}
                {initialMessages.map((msg) => (
                  <div
                    key={msg.id}
                    className={`flex flex-col ${msg.role === 'assistant' ? 'items-start' : 'items-end'}`}
                  >
                    <div className="flex items-center gap-1 mb-0.5 px-1">
                      <span className="text-[10px] font-semibold text-muted">
                        {msg.role === 'assistant' ? 'Misa' : 'You'}
                      </span>
                    </div>
                    {msg.role === 'assistant' ? (
                      <div className="flex flex-col items-start gap-1 max-w-[92%]">
                        {msg.reasoning && <ThinkingBlock text={msg.reasoning} />}
                        {msg.toolCalls && msg.toolCalls.length > 0 && <ToolCallsBlock calls={msg.toolCalls} />}
                        <div className="rounded-2xl border border-border bg-bg/80 px-3.5 py-2 text-xs leading-relaxed text-text markdown-body">
                          <ChatMarkdown text={msg.content} />
                        </div>
                      </div>
                    ) : (
                      <div className="max-w-[85%] rounded-2xl bg-l px-3.5 py-2 text-xs font-medium text-bg leading-relaxed">
                        {msg.content}
                      </div>
                    )}
                  </div>
                ))}

                {/* Live Call Real-Time Transcripts Divider if transcripts exist */}
                {transcripts.length > 0 && initialMessages.length > 0 && (
                  <div className="flex items-center gap-2 my-3">
                    <div className="flex-1 border-t border-white/10" />
                    <span className="text-[9px] font-bold uppercase tracking-wider text-l">Live Voice Session</span>
                    <div className="flex-1 border-t border-white/10" />
                  </div>
                )}

                {/* Live Transcripts — "[silence]" turns never render (safe net,
                    upstream updateTranscript already drops them). */}
                {transcripts.filter((t) => !isPureSilenceToken(t.text)).map((t) => (
                  <div
                    key={t.id}
                    className={`flex flex-col ${t.role === 'assistant' ? 'items-start' : 'items-end'}`}
                  >
                    <div className="flex items-center gap-1 mb-0.5 px-1">
                      <span className="text-[10px] font-semibold text-muted">
                        {t.role === 'assistant' ? 'Misa (Live)' : 'You (Live)'}
                      </span>
                    </div>
                    {t.role === 'assistant' ? (
                      <div className="flex flex-col items-start gap-1 max-w-[92%]">
                        {t.reasoning && <ThinkingBlock text={t.reasoning} streaming={isStreamingTail(t)} />}
                        {t.toolCalls && t.toolCalls.length > 0 && <ToolCallsBlock calls={t.toolCalls} />}
                        <div className="rounded-2xl border border-l/30 bg-l/10 px-3.5 py-2 text-xs leading-relaxed text-text shadow-sm markdown-body">
                          {isStreamingTail(t) ? <StreamingText text={t.text} /> : <ChatMarkdown text={t.text} />}
                        </div>
                      </div>
                    ) : (
                      <div className="max-w-[85%] rounded-2xl bg-l px-3.5 py-2 text-xs font-medium text-bg leading-relaxed">
                        {t.text}
                      </div>
                    )}
                  </div>
                ))}
              </div>

              {/* Bottom Input Field */}
              <div className="relative border-t border-border p-3 bg-bg/40">
                <LiveChatComposer
                  toolCatalog={toolCatalog}
                  isExecutingTool={isExecutingTool}
                  onSend={handleSendChatMessage}
                  onTyping={handleComposerTyping}
                />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Bottom Floating Control Dock */}
      <div className="p-6 flex items-center justify-center z-10">
        <div className="flex items-center gap-3 rounded-full border border-white/15 bg-card/90 p-2 px-4 shadow-2xl backdrop-blur-2xl">
          {/* Mic Toggle */}
          <button
            type="button"
            onClick={handleToggleMute}
            className={`flex h-12 w-12 items-center justify-center rounded-full transition-transform active:scale-90 ${
              isMuted ? 'bg-danger text-white' : 'border border-white/10 bg-white/5 text-text hover:bg-white/10'
            }`}
            aria-label={isMuted ? 'Unmute' : 'Mute'}
          >
            {isMuted ? <MicOff size={20} /> : <Mic size={20} />}
          </button>

          {/* In-Call Text Chat Drawer Button */}
          <button
            type="button"
            onClick={() => {
              haptic();
              setShowChatInput(!showChatInput);
            }}
            className={`relative flex h-12 w-12 items-center justify-center rounded-full transition-transform active:scale-90 ${
              showChatInput
                ? 'bg-l text-bg font-bold shadow-lg shadow-l/30'
                : 'border border-white/10 bg-white/5 text-text hover:bg-white/10'
            }`}
            aria-label="Open In-Call Chat Drawer"
            title="Chat History & Live Transcripts"
          >
            <MessageSquare size={20} />
            {transcripts.length > 0 && !showChatInput && (
              <span className="absolute 1 top-1 right-1 h-2.5 w-2.5 rounded-full bg-l animate-pulse" />
            )}
          </button>

          {/* Camera Stream Toggle */}
          <button
            type="button"
            onClick={handleToggleCamera}
            className={`flex h-12 w-12 items-center justify-center rounded-full transition-transform active:scale-90 ${
              isCameraActive ? 'bg-l text-bg' : 'border border-white/10 bg-white/5 text-text hover:bg-white/10'
            }`}
            aria-label={isCameraActive ? 'Stop Camera' : 'Start Camera'}
          >
            {isCameraActive ? <Camera size={20} /> : <CameraOff size={20} />}
          </button>

          {/* Screen Sharing Toggle */}
          <button
            type="button"
            onClick={handleToggleScreenShare}
            className={`flex h-12 w-12 items-center justify-center rounded-full transition-transform active:scale-90 ${
              isScreenSharing ? 'bg-cyan-500 text-bg' : 'border border-white/10 bg-white/5 text-text hover:bg-white/10'
            }`}
            aria-label={isScreenSharing ? 'Stop Screen Sharing' : 'Share Screen'}
          >
            <Monitor size={20} />
          </button>

          {/* End Call Button */}
          <button
            type="button"
            onClick={handleEndCall}
            className="flex h-12 w-12 items-center justify-center rounded-full bg-danger text-white transition-transform active:scale-90 shadow-lg shadow-danger/40"
            aria-label="End Call"
          >
            <PhoneOff size={20} />
          </button>
        </div>
      </div>

      {/* Settings Modal */}
      {showSettings && (
        <LiveSettingsModal
          isOpen={showSettings}
          onClose={() => setShowSettings(false)}
          config={config}
          onSave={(newConfig) => {
            onUpdateConfig(newConfig);
            const client = clientRef.current;
            if (!client) return;
            const prev = client.getConfig();
            // Sync the NEW settings into the RUNNING client first (fixes the
            // "live settings not linked to the live session" bug: the client
            // held its mount-time config, so even a reconnect used stale values).
            client.updateConfig(newConfig);
            // AUDIT FIX (round 1, MEDIUM): the typed API key lives in
            // newConfig.apiKey — using the stale render `apiKey` prop here meant
            // a user fixing a bad key from Live Settings never actually applied
            // it (the reconnect dialed with the OLD key and failed forever).
            const reconnectApiKey = newConfig.apiKey?.trim() || apiKey;
            // Reconnect ONLY when a session-baked setting (model/voice/VAD/FPS/
            // tokens/API-key) changed. Saving unrelated settings must NOT tear
            // down a healthy call — that unconditional reconnect was the real
            // "changing settings disconnects the call" bug.
            if (requiresLiveReconnect(prev, newConfig)) {
              // Suppress the transient red error banner during the expected
              // teardown/reconnect (see onStatusChange mapper).
              suppressingDisconnectErrorRef.current = true;
              setStatus('reconnecting');
              setErrorMessage(null);
              // AUDIT FIX (round 2, MEDIUM): rapid consecutive settings saves
              // race — reconnect #2's internal disconnect() aborts reconnect #1,
              // whose stale .catch then stamped 'error' over the healthy #2
              // attempt. A generation token makes only the NEWEST reconnect
              // allowed to touch error/suppressing state.
              const reconnectGen = (settingsReconnectGenRef.current += 1);
              client
                .reconnectWithNewConfig(reconnectApiKey, initialMicStream)
                .then(() => {
                  if (reconnectGen !== settingsReconnectGenRef.current) return;
                  suppressingDisconnectErrorRef.current = false;
                })
                .catch((e: any) => {
                  console.warn('[LiveCompanion] Settings reconnect failed:', e);
                  if (reconnectGen !== settingsReconnectGenRef.current) return;
                  suppressingDisconnectErrorRef.current = false;
                  setStatus('error');
                  setErrorMessage(e?.message || 'Reconnect after settings change failed.');
                });
            } else if (prev.defaultAudioRoute !== newConfig.defaultAudioRoute) {
              // Route changed but the session didn't — just re-route the audio
              // AND keep the overlay's route chip in sync (audit fix: it used
              // to stay on the old route until a full remount).
              void client.setAudioRoute(newConfig.defaultAudioRoute);
              setAudioRoute(newConfig.defaultAudioRoute);
            }
          }}
          defaultApiKey={apiKey}
        />
      )}
    </div>
  );
}

const LiveChatComposer = memo(function LiveChatComposer({
  toolCatalog,
  isExecutingTool,
  onSend,
  onTyping,
}: {
  toolCatalog: ChatToolMeta[];
  isExecutingTool: boolean;
  onSend: (text: string, toolMentions: string[]) => void;
  onTyping?: () => void;
}) {
  const [text, setText] = useState('');
  const [toolMentions, setToolMentions] = useState<string[]>([]);
  const [showToolPicker, setShowToolPicker] = useState(false);
  const [toolQuery, setToolQuery] = useState<string | null>(null);

  const filteredTools = useMemo(() => {
    if (toolQuery === null) return toolCatalog;
    const q = toolQuery.toLowerCase().trim();
    return toolCatalog.filter((t) => !q || t.id.toLowerCase().includes(q) || t.label.toLowerCase().includes(q));
  }, [toolCatalog, toolQuery]);

  const handleSelectTool = (id: string) => {
    haptic();
    if (!toolMentions.includes(id)) {
      setToolMentions((prev) => [...prev, id]);
    }
    // Remove query prefix from text
    setText((prev) => prev.replace(/(^|\s)@[a-zA-Z0-9_-]*$/, '$1').trim());
    setShowToolPicker(false);
    setToolQuery(null);
  };

  const handleSend = () => {
    const raw = text.trim();
    if (!raw && toolMentions.length === 0) return;
    onSend(raw, toolMentions);
    setText('');
    setToolMentions([]);
    setShowToolPicker(false);
    setToolQuery(null);
  };

  return (
    <div className="relative">
      {/* Floating @ Tool Mention Picker */}
      <AnimatePresence>
        {showToolPicker && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            className="absolute bottom-full left-0 right-0 mb-2 max-h-56 overflow-y-auto rounded-2xl border border-white/20 bg-card/95 p-1.5 shadow-2xl backdrop-blur-xl z-20 [scrollbar-width:thin]"
          >
            <p className="px-2 py-1 text-[9px] font-bold uppercase tracking-wider text-l">
              Tools — Select tool to use
            </p>
            {filteredTools.map((t) => {
              const isSelected = toolMentions.includes(t.id);
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => handleSelectTool(t.id)}
                  className={`flex w-full items-start gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors ${
                    isSelected ? 'bg-l/15' : 'hover:bg-white/5'
                  } active:scale-[0.98]`}
                >
                  <span className="mt-0.5 text-xs font-bold text-l">@{t.id}</span>
                  <div className="min-w-0 flex-1">
                    <span className="text-[11px] font-semibold text-text">{t.label}</span>
                    <span className="block truncate text-[10px] text-muted">{t.description}</span>
                  </div>
                </button>
              );
            })}
          </motion.div>
        )}
      </AnimatePresence>

      <div className="rounded-2xl border border-white/20 bg-card p-1.5 shadow-lg">
        {/* Tool Mentions Chip Row */}
        {toolMentions.length > 0 && (
          <div className="no-scrollbar mb-1.5 flex gap-1.5 overflow-x-auto px-1 pt-1">
            {toolMentions.map((id) => (
              <ToolChip
                key={id}
                id={id}
                catalog={toolCatalog}
                onRemove={() => setToolMentions((prev) => prev.filter((t) => t !== id))}
              />
            ))}
          </div>
        )}

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowToolPicker((prev) => !prev)}
            className={`flex h-7 w-7 items-center justify-center rounded-lg border text-xs font-bold transition-transform active:scale-90 ${
              showToolPicker || toolMentions.length > 0
                ? 'border-l bg-l text-bg'
                : 'border-white/10 bg-white/5 text-muted hover:text-text'
            }`}
            aria-label="Insert tool mention"
            title="AI Tools"
          >
            @
          </button>
          <input
            type="text"
            value={text}
            onChange={(e) => {
              const val = e.target.value;
              setText(val);
              // P2: typing resets the live silence timeline (throttled upstream).
              onTyping?.();
              const match = /(^|\s)@([a-zA-Z0-9_-]*)$/.exec(val);
              if (match) {
                setToolQuery(match[2] ?? '');
                setShowToolPicker(true);
              } else {
                setShowToolPicker(false);
                setToolQuery(null);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder="Live doubt ya formula type karo... (@ se tools)"
            className="flex-1 bg-transparent px-2 py-1.5 text-xs text-text placeholder:text-muted focus:outline-none"
          />
          <button
            type="button"
            disabled={isExecutingTool}
            onClick={handleSend}
            className="flex h-8 w-8 items-center justify-center rounded-xl bg-l text-bg transition-transform active:scale-90 disabled:opacity-50"
            aria-label="Send in-call text message"
          >
            {isExecutingTool ? <Sparkles size={14} className="animate-spin" /> : <Send size={14} />}
          </button>
        </div>
      </div>
    </div>
  );
});
