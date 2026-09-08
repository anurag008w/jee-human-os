import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import {
  Archive,
  Ban,
  Camera,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  Eraser,
  FileText,
  FolderArchive,
  HardDrive,
  Image,
  ImagePlus,
  MessageSquarePlus,
  MessageSquareText,
  MoreHorizontal,
  NotebookPen,
  Paperclip,
  PenLine,
  Phone,
  PhoneCall,
  PhoneOff,
  RefreshCw,
  Search,
  Send,
  Settings2,
  Share,
  Sigma,
  Sparkles,
  StickyNote,
  Trash2,
  Wrench,
  X,
} from 'lucide-react';
import type { StudyResource, VaultSubject } from '../core/domain/study-vault';
import { formatFileSize } from '../core/domain/study-vault';
import { getVaultFileBlob } from '../infra/storage/vault-db';
import type { ChatAttachment, ChatMessage, ChatPreferences, ChatSession, ChatToolCallRecord } from '../core/domain/chat';
import { TOOL_LABELS, type ChatToolMeta } from '../core/domain/chat-tools';
import type { ArchivedConversation } from '../core/domain/chat-transcript';
import { liveStreamingTailId } from '../core/domain/chat-transcript';
import { isAbortError, type ModelInfo } from '../core/domain/llm';
import { defaultChatPrefs, globalChatPrefsFromSettings, isPureSilenceToken } from '../core/domain/chat';
import { deviceTimeZone } from '../core/ports/clock';
import { container } from '../di/container';
import { redoLastAiAction, undoLastAiAction } from '../core/domain/ai-actions';
import { proactiveAgentService } from '../features/ai/proactive-agent.service';
import ChatMarkdown from '../components/ChatMarkdown';
import StreamingText from '../components/StreamingText';
import { useAppState } from '../lib/useAppState';
import FileCard from '../components/FileCard';
import FileKindBadge from '../components/FileKindBadge';
import { useMenuFocus } from '../components/useMenuFocus';
import { MoreButton } from '../components/menu-accessibility';
import { fileKindOf, shortFileName } from '../lib/file-kind';
import AddProviderForm from '../components/AddProviderForm';
import ReadOnlyChatViewer from '../components/ReadOnlyChatViewer';
import { detectFileDoc, looksLikeMarkdown } from '../components/markdown-utils';
import { haptic, hapticError, hapticSuccess } from '../lib/haptics';
import { extractFileText } from '../lib/fileText';
import { exportTextFile } from '../lib/exportFile';
import { notifyAiReply } from '../lib/notifications';
import { timeAgo } from '../lib/relative-time';
import {
  BUBBLE_GAP_MIN_MS,
  BUBBLE_GAP_RANDOM_MS,
  buildNotificationSteps,
  computeRevealSchedule,
  splitReplyIntoBubbles,
  type RevealSchedule,
} from '../features/chat/message-segments';
import type { LiveSettingsConfig, LiveTranscriptItem, LiveCallOrigin } from '../core/domain/live-types';
import { DEFAULT_LIVE_SETTINGS } from '../core/domain/live-types';
import LivePermissionModal from '../components/live/LivePermissionModal';
import LiveCompanionOverlay, { getActiveLiveClient, disposeActiveLiveCall } from '../components/live/LiveCompanionOverlay';
import { isLiveCallActive } from '../features/ai/live-call-state';
import { buildLiveCallOverview } from '../core/domain/live-call-history';
import { requestNativeCallAudioFocus, setNativeAudioRoute, resetNativeAudioRoute, isNativeAudioPlatform } from '../lib/native-audio-route';
import { isLiveCallInterrupted, clearLiveCallInterrupted } from '../lib/live-companion-service';
import { normalizeServerRoot } from '../lib/auth';

interface DraftAttachment {
  id: string;
  name: string;
  type: string;
  size: number;
  kind: 'text' | 'image' | 'file' | 'binary';
  content?: string;
  previewUrl?: string;
}

interface MenuState {
  message: ChatMessage;
  x: number;
  y: number;
}

const MAX_TEXT_ATTACHMENT_CHARS = 24_000;

const MATH_TEMPLATE =
  'Is maths problem ko step-by-step solve karo, LaTeX me dikhao: \\(\\frac{2}{3} + 3\\times3\\)';
const MD_TEMPLATE = 'Uploaded notes ko clean markdown summary + formula sheet me convert karo.';
const CANVAS_TEMPLATE = 'Is content se ek downloadable .md/.txt file bana do, headings aur tables ke saath.';

const SUGGESTIONS = [
  {
    label: 'Solve JEE question',
    prompt: 'Ek JEE-level maths problem bana kar step-by-step solve karo, LaTeX me. Example: \\(\\int_0^1 x^2\\,dx\\)',
  },
  { label: 'Create revision plan', prompt: 'Aaj ke liye ek tight revision plan banao — weak topics pe focus karo.' },
  { label: 'Summarize notes', prompt: 'Uploaded notes ko clean markdown summary + formula sheet me convert karo.' },
  { label: 'Explain concept', prompt: 'Ek JEE concept ko simple Hinglish me explain karo with example.' },
  { label: 'Generate flashcards', prompt: 'Is topic ke flashcards generate karo — Q&A pairs me.' },
];

const ATTACH_TOOLS: { id: string; label: string; hint: string; icon: React.ReactNode }[] = [
  { id: 'vault', label: 'Study Vault', hint: 'PDFs & Notes', icon: <FolderArchive size={20} /> },
  { id: 'math', label: 'Math Solver', hint: 'LaTeX solve', icon: <Sigma size={20} /> },
  { id: 'image', label: 'Image', hint: 'Upload photo', icon: <Image size={20} /> },
  { id: 'pdf', label: 'PDF', hint: 'Docs upload', icon: <FileText size={20} /> },
  { id: 'canvas', label: 'Canvas', hint: 'File output', icon: <PenLine size={20} /> },
  { id: 'markdown', label: 'Markdown', hint: 'Notes → MD', icon: <NotebookPen size={20} /> },
  { id: 'camera', label: 'Camera', hint: 'Live photo', icon: <Camera size={20} /> },
  { id: 'gallery', label: 'Gallery', hint: 'Pick photo', icon: <ImagePlus size={20} /> },
  { id: 'notes', label: 'Notes', hint: 'Text files', icon: <StickyNote size={20} /> },
];

// ── Windowed chat rendering (hang-fix P1) ─────────────────────────────────
// Renders only the message TAIL instead of the whole history, so a long
// conversation never re-renders its entire DOM on every streamed chunk. Older
// messages load in batches when the user scrolls up (infinite-scroll style).
export const CHAT_WINDOW_SIZE = 120;
export const CHAT_WINDOW_STEP = 120;

/** Oldest rendered index so the newest `windowSize` messages are visible. */
export function chatTailStart(total: number, windowSize = CHAT_WINDOW_SIZE): number {
  if (total <= 0) return 0;
  return Math.max(0, total - windowSize);
}

/** Next window start when the user scrolls up to load older messages. */
export function chatLoadOlderStart(current: number, step = CHAT_WINDOW_STEP): number {
  return Math.max(0, current - step);
}

/** The bounded slice rendered by the chat thread. */
export function chatVisibleMessages<T>(messages: T[], windowStart: number): T[] {
  if (windowStart <= 0) return messages;
  return messages.slice(windowStart);
}

export default function ChatScreen({
  targetSessionId,
  onTargetConsumed,
}: {
  /** Notification tap/reply se khula jaane wala session (App.tsx se). */
  targetSessionId?: string | null;
  /** ChatScreen ne target consume kar liya — App value clear kar de. */
  onTargetConsumed?: () => void;
}) {
  const [sessions, setSessions] = useState<ChatSession[]>(() => container.chat.listSessions());
  const [activeId, setActiveId] = useState<string | null>(null);
  const { state: appState } = useAppState();
  /** Stable ref for the memoized MessageBubble's action callbacks. The
   *  callbacks close over mutable state (draft, active, streaming), so they
   *  live behind a ref: the ref identity never changes, letting React.memo
   *  skip re-rendering every bubble on each keystroke (the typing-lag fix). */
  const actionsRef = useRef<MessageActions>(null!);
  const [draft, setDraft] = useState('');
  const [streaming, setStreaming] = useState(false);
  // ── Windowed rendering (hang-fix P1) ────────────────────────────────────
  // `windowStart` = oldest rendered message index. `stuckToBottom` = the user
  // is reading the latest messages (auto-scroll + window re-base allowed).
  const [windowStart, setWindowStart] = useState<number>(0);
  const [stuckToBottom, setStuckToBottom] = useState(true);
  const loadingOlderRef = useRef(false);
  const prevScrollHeightRef = useRef<number | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  /** Id of the freshly generated assistant message that should reveal bubble-by-bubble. */
  const [revealId, setRevealId] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ sessionId: string; messageId: string; originalDraft: string } | null>(null);
  const [attachments, setAttachments] = useState<DraftAttachment[]>([]);
  const [processing, setProcessing] = useState<string[]>([]);
  const [showSettings, setShowSettings] = useState(false);
  const [showAttach, setShowAttach] = useState(false);
  const [showVaultPicker, setShowVaultPicker] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showProviderPicker, setShowProviderPicker] = useState(false);
  const [showMemoryChatId, setShowMemoryChatId] = useState<string | null>(null);
  const [memoryChats, setMemoryChats] = useState<ArchivedConversation[]>([]);
  const [catalog, setCatalog] = useState<ModelInfo[]>([]);
  const [providerSig, setProviderSig] = useState(() => providerSigOf(container.providerSettings.listStoredProviders()));
  const [menu, setMenu] = useState<MenuState | null>(null);
  /** Tools pinned for the NEXT run via the "@" picker — the AI may only use these. */
  const [toolMentions, setToolMentions] = useState<string[]>([]);
  /** Live "@query" filter text while the tool picker is open (null = closed). */
  const [toolQuery, setToolQuery] = useState<string | null>(null);
  /** Pending "Copy this chat to memory?" prompt shown when switching away from an unarchived chat. */
  const [memoryPrompt, setMemoryPrompt] = useState<{ sessionId: string; title: string; onConfirm: () => void } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const toolPickerRef = useRef<HTMLDivElement | null>(null);
  // The reveal schedule for the freshly generated reply. Set in doSend, consumed
  // by the revealing MessageBubble and by the notification delay — both share
  // the SAME schedule so the notification lands exactly when the chat finishes
  // showing the whole reply. Only one reply reveals at a time (composer is
  // locked while streaming), so a single slot is enough.
  const revealScheduleRef = useRef<RevealSchedule | null>(null);

  const active = useMemo(() => sessions.find((s) => s.id === activeId) ?? null, [sessions, activeId]);
  // User-pickable AI tools for the "@" composer picker. Driven by the shared
  // state so a live 90-day track toggle (ON ↔ OFF) immediately re-renders the
  // catalog — 90-day tools vanish the instant flexible mode is on, and return
  // as soon as the track is back on. (container.chat.listTools() already
  // filters by enable90DayTrack; the reference below makes that dependency
  // explicit so the memo re-evaluates when the track toggles.)
  const toolCatalog = useMemo(() => {
    void appState.enable90DayTrack;
    return container.chat.listTools();
  }, [appState.enable90DayTrack]);
  const filteredTools = useMemo(() => {
    if (toolQuery === null) return [];
    const q = toolQuery.toLowerCase().trim();
    return toolCatalog.filter((t) => !q || t.id.toLowerCase().includes(q) || t.label.toLowerCase().includes(q));
  }, [toolCatalog, toolQuery]);
  const providers = useMemo(
    () => (void providerSig, container.providerSettings.listStoredProviders()),
    [providerSig],
  );
  const messages = active?.messages ?? [];
  // Bounded slice rendered by the thread — the full history stays in memory,
  // only the DOM is windowed (hang-fix P1).
  const visibleMessages = chatVisibleMessages(messages, windowStart).filter(
    // "[silence]" is a no-op token: never render (old persisted turns included).
    (m) => !isPureSilenceToken(m.content),
  );
  const hasMessages = active !== null && messages.length > 0;
  // Screen-reader live region: announce when a freshly generated AI reply is
  // revealed (old chats and session switches never replay their history).
  const [liveAnnounce, setLiveAnnounce] = useState('');
  // A monotonically increasing suffix keeps every new reply a distinct value so
  // the polite region re-announces even when replies arrive back-to-back.
  const announceSeq = useRef(0);
  const aiEnabled = container.providerSettings.isAiEnabled();
  const showThinking = container.store.get().aiSettings.chat.showThinking;
  // Stable identity so the reveal effect never restarts from its callback.
  const handleRevealDone = useCallback(() => {
    // Reveal khatam — shared schedule ab waste hai, slot khaali karo.
    revealScheduleRef.current = null;
    setRevealId(null);
    announceSeq.current += 1;
    setLiveAnnounce(`Misa ka naya reply aaya (${announceSeq.current})`);
  }, []);

  // This screen stays mounted across tab switches (chatVisited), so provider
  // changes made in AI Settings would never show here. Poll the store so the
  // provider + model lists stay in sync with Settings.
  useEffect(() => {
    // `disposed` guards against a tick that was already queued when the
    // component unmounts — clearInterval only stops FUTURE firings, and a
    // queued callback would otherwise call setState after teardown.
    let disposed = false;
    const id = setInterval(() => {
      if (disposed) return;
      setProviderSig((prev) => {
        const next = providerSigOf(container.providerSettings.listStoredProviders());
        return next === prev ? prev : next;
      });
    }, 300);
    return () => {
      disposed = true;
      clearInterval(id);
    };
  }, []);

  // Link the Live settings so a change made in the AI Settings screen (which
  // writes aiSettings.live to the SAME store) is reflected here — otherwise the
  // live overlay opens a call with a stale, mount-time config. Hang-fix P3:
  // event-driven via the store subscription (same 300ms poll is gone) — only
  // commit when it actually changed, so an untouched config never re-renders.
  useEffect(() => {
    const syncLiveConfig = () => {
      const fromStore = container.store.get()?.aiSettings?.live;
      if (!fromStore) return;
      setLiveConfig((prev) =>
        JSON.stringify(prev) === JSON.stringify(fromStore) ? prev : fromStore,
      );
    };
    syncLiveConfig();
    return container.store.subscribe(syncLiveConfig);
  }, []);

  // "@" tool picker: close when the user interacts OUTSIDE the picker + input
  // (not on blur — blur fires on touch/scroll inside the panel and killed the
  // whole scrollable list on mobile).
  useEffect(() => {
    if (toolQuery === null) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (toolPickerRef.current?.contains(target)) return;
      if (textareaRef.current?.contains(target)) return;
      setToolQuery(null);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [toolQuery]);

  const modelChip = useMemo(() => {
    const pid = active?.prefs.providerId ?? null;
    const provider = pid ? providers.find((p) => p.id === pid) : container.providerSettings.getActiveProvider();
    if (!provider) return { label: 'AI off', model: null as string | null };
    return { label: provider.label, model: (active?.prefs.model ?? provider.model ?? null) as string | null };
  }, [active?.prefs.providerId, active?.prefs.model, providers]);

  useEffect(() => {
    if (!activeId && sessions.length > 0) setActiveId(sessions[0].id);
  }, [activeId, sessions]);

  // Notification tap/reply se target session aaya — usi ko kholo aur App ko
  // batado ki value consume ho gayi (taaki dobara-trigger na ho).
  useEffect(() => {
    if (!targetSessionId) return;
    setActiveId(targetSessionId);
    onTargetConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetSessionId]);

  // Notification inline reply se messages directly repo me add ho sakte hain —
  // event aaye to sessions list refresh karo (bina active chat ko disturb kiye).
  useEffect(() => {
    const onUpdated = () => setSessions(container.chat.listSessions());
    window.addEventListener('levelup:chat-updated', onUpdated);
    return () => window.removeEventListener('levelup:chat-updated', onUpdated);
  }, []);

  // Keyboard / URL-bar inset. The composer must stay pinned above the on-screen
  // keyboard on every platform: Android resizes the layout viewport itself
  // (adjustResize / interactive-widget), iOS Safari and some WebViews only
  // shrink the VISUAL viewport. Track the difference and expose it as
  // --kb-inset so .chat-shell can pad its bottom by exactly that much. When the
  // layout viewport already resized, the difference is ~0 and nothing double-pads.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      const inset = Math.max(0, window.innerHeight - vv.height);
      document.documentElement.style.setProperty('--kb-inset', `${inset}px`);
    };
    update();
    vv.addEventListener('resize', update);
    window.addEventListener('resize', update);
    return () => {
      vv.removeEventListener('resize', update);
      window.removeEventListener('resize', update);
    };
  }, []);

  // Keep every session's shared prefs in line with the global chat settings
  // (Settings tab -> Chat Experience) whenever the coach screen mounts.
  useEffect(() => {
    container.chat.applyGlobalPrefs(globalChatPrefsFromSettings(container.store.get().aiSettings.chat));
    setSessions(container.chat.listSessions());

    // Mark the session the user lands on as active so it is never silently
    // archived — a chat only ever enters AI memory when the user explicitly
    // chooses "Copy to memory" on switch, or via the manual memory panel.
    const landingId = activeId ?? container.chat.listSessions()[0]?.id ?? null;
    container.chat.setActiveSessionId(landingId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Full backup imports and "Delete all data" replace the whole chat history
  // from Settings while this screen stays mounted (chatVisited). Re-read the
  // sessions so the restored / cleared history shows up immediately.
  useEffect(() => {
    const onDataReplaced = () => setSessions(container.chat.listSessions());
    window.addEventListener('levelup:backup-imported', onDataReplaced);
    return () => window.removeEventListener('levelup:backup-imported', onDataReplaced);
  }, []);

  useEffect(() => {
    // The session the user is actively chatting in stays internal to the AI —
    // it is never included in the one-click memory summarization.
    container.chat.setActiveSessionId(activeId);
  }, [activeId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stuckToBottom) el.scrollTop = el.scrollHeight;
  }, [active?.messages.length, streaming, stuckToBottom]);

  // ── Windowed rendering (hang-fix P1) ─────────────────────────────────────
  // Scroll handler: user near the top → load older window; user away from the
  // bottom → release auto-scroll so reading history isn't yanked back.
  const handleThreadScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    setStuckToBottom(nearBottom);
    if (el.scrollTop < 120 && windowStart > 0) {
      if (!loadingOlderRef.current) {
        loadingOlderRef.current = true;
        prevScrollHeightRef.current = el.scrollHeight;
        requestAnimationFrame(() => {
          loadingOlderRef.current = false;
          setWindowStart((prev) => chatLoadOlderStart(prev));
        });
      }
    }
  }, [windowStart]);

  // Restore the scroll anchor after older messages are prepended, so the
  // viewport doesn't jump when the window grows.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || prevScrollHeightRef.current === null) return;
    el.scrollTop = el.scrollHeight - prevScrollHeightRef.current;
    prevScrollHeightRef.current = null;
  }, [windowStart, visibleMessages.length]);

  // Hang-fix P2: page hide = debounced chat writes must land on disk now
  // (user closed the tab / app is being backgrounded / process may die).
  useEffect(() => {
    const flushChat = () => container.chat.flush();
    window.addEventListener('pagehide', flushChat);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushChat();
    });
    return () => {
      window.removeEventListener('pagehide', flushChat);
      document.removeEventListener('visibilitychange', flushChat);
    };
  }, []);

  // While stuck at the bottom, keep the newest messages visible as the
  // conversation grows (streamed chunks, proactive injections).
  useEffect(() => {
    if (!stuckToBottom) return;
    setWindowStart(() => chatTailStart(messages.length));
  }, [messages.length, stuckToBottom]);

  // Session switch: reset the window to the tail and re-stick to the bottom.
  useEffect(() => {
    setWindowStart(() => chatTailStart(messages.length));
    setStuckToBottom(true);
  }, [activeId]);

  // If the screen unmounts mid-stream, the in-flight AbortController is
  // cancelled by stop(); nothing paced is left behind.

  useEffect(() => {
    void loadCatalog();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.prefs.providerId]);

  useEffect(() => {
    setDraft('');
    setEditing(null);
    setAttachments([]);
    setError('');
  }, [activeId]);

  useEffect(() => {
    const open = showSettings || showAttach || showHistory || showProviderPicker || menu !== null || showMemoryChatId !== null;
    document.body.style.overflow = open ? 'hidden' : '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [showSettings, showAttach, showHistory, showProviderPicker, menu, showMemoryChatId]);

  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(''), 2400);
    return () => window.clearTimeout(t);
  }, [notice]);

  // P5: check once on mount whether the last Live call was killed by the system
  // (process death / OEM kill — a hard platform limit). If yes, surface it so
  // the user is not left wondering why the call vanished. Dismissal clears the
  // persisted flag so this banner does not haunt the next launches.
  useEffect(() => {
    let cancelled = false;
    isLiveCallInterrupted()
      .then((interrupted) => {
        if (interrupted && !cancelled) setLiveCallInterrupted(true);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const dismissLiveCallInterrupted = () => {
    setLiveCallInterrupted(false);
    void clearLiveCallInterrupted().catch(() => undefined);
  };

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 144)}px`;
  }, [draft]);

  // Live Voice & Video Streaming State
  const [showLivePermission, setShowLivePermission] = useState(false);
  const [showLiveOverlay, setShowLiveOverlay] = useState(false);
  const [liveMicStream, setLiveMicStream] = useState<MediaStream | null>(null);
  /** P1: true jab pre-capture path ne native audio focus pehle hi le liya ho (single-owner). */
  const [liveAudioFocusGranted, setLiveAudioFocusGranted] = useState(false);
  /** Imperative handle so the `endLiveCall` live tool can hang up the active
   *  overlay call programmatically (it otherwise had no handler and fell into
   *  the unknown-tool fallback, surfacing an "error reading summary"). The
   *  overlay sets this to its own end-call routine while mounted. */
  const endLiveCallRef = useRef<(() => void) | null>(null);
  /** P5: previous live call was killed by the system (process death) — recovery UX. */
  const [liveCallInterrupted, setLiveCallInterrupted] = useState(false);
  const [liveCamStream, setLiveCamStream] = useState<MediaStream | null>(null);
  const liveCallSessionIdRef = useRef<string | null>(null);
  /**
   * Id of the assistant transcript message whose text is STILL GROWING during a
   * live call (the tail of the transcript snapshot). Its bubble renders as
   * cheap plain text — ChatMarkdown's full parse (GFM + KaTeX + highlight)
   * only runs ONCE, when the message is superseded (new user turn) or the call
   * ends. This kills the streaming re-parse hang: every coalesced transcript
   * flush used to re-parse the whole growing reply from scratch.
   */
  const [liveStreamingMsgId, setLiveStreamingMsgId] = useState<string | null>(null);
  /**
   * Live-call transcript sink is coalesced: Gemini streams transcript chunks
   * continuously during a reply. Writing every chunk straight into the chat
   * store (full-state JSON.stringify + localStorage + markDirty), then
   * deep-cloning every session and setSessions()-ing the whole ChatScreen,
   * saturates the main thread mid-call — stalling the text composer AND
   * starving the Live audio scheduler (ScriptProcessor capture + playback
   * chunk scheduling both live on the same thread). Trailing-coalesce to one
   * flush per quiet window; appends are idempotent by message id and the
   * hang-up path (handleLiveOverlayClose) re-applies the final transcript.
   */
  const liveTranscriptTimerRef = useRef<number | null>(null);
  /** Latest live transcript + the chat session it BELONGS to, captured at store
   *  time. Capturing the sid here (not re-reading it at flush time) closes a
   *  race: a post-disconnect `onTranscriptUpdate` that arrives AFTER
   *  `liveCallSessionIdRef` is cleared can no longer mis-target a different
   *  active chat session. */
  const liveTranscriptSnapshotRef = useRef<{ transcripts: LiveTranscriptItem[]; sid: string } | null>(null);
  /** Set when the call overlay is closed/hung up; any late transcript emitted
   *  by the client afterward is ignored instead of re-arming a new flush. */
  const liveCallSessionClosedRef = useRef(false);
  const [liveIncomingMeta, setLiveIncomingMeta] = useState<{ isIncomingCall: boolean; reason?: string; origin?: LiveCallOrigin } | undefined>(undefined);
  const [liveConfig, setLiveConfig] = useState<LiveSettingsConfig>(() => {
    const liveFromStore = container.store.get()?.aiSettings?.live;
    if (liveFromStore) return liveFromStore;
    try {
      const saved = localStorage.getItem('levelup.live.settings.v1');
      return saved ? { ...DEFAULT_LIVE_SETTINGS, ...JSON.parse(saved) } : DEFAULT_LIVE_SETTINGS;
    } catch {
      return DEFAULT_LIVE_SETTINGS;
    }
  });
  // AUDIT FIX (round 1, LOW): live mirror ref for long-lived closures — the
  // coalesced transcript flush timer (250ms) and the overlay-close re-apply run
  // with the render that CREATED them; after a mid-call model change they would
  // stamp OLD model names on the synced assistant messages. The ref always
  // holds the LATEST config.
  const liveConfigRef = useRef(liveConfig);
  liveConfigRef.current = liveConfig;

  const handleUpdateLiveConfig = (newCfg: LiveSettingsConfig) => {
    setLiveConfig(newCfg);
    try {
      const cur = container.store.get();
      if (cur) {
        container.store.save({
          ...cur,
          aiSettings: {
            ...cur.aiSettings,
            live: newCfg,
          },
        });
      }
    } catch {
      // Best effort
    }
    try {
      localStorage.setItem('levelup.live.settings.v1', JSON.stringify(newCfg));
    } catch {
      // Best effort
    }
  };

  const getGeminiLiveApiKey = (): string => {
    if (liveConfig.apiKey?.trim()) return liveConfig.apiKey.trim();
    const provId = liveConfig.providerId || 'app-default';
    if (provId === 'app-default') {
      const activeProv = container.providerSettings.getActiveProvider();
      if (activeProv?.apiKey?.trim()) return activeProv.apiKey.trim();
      const hiddenDefault = container.providerSettings.getHiddenDefaultFull();
      if (hiddenDefault?.apiKey?.trim()) return hiddenDefault.apiKey.trim();
    } else if (provId === 'gemini') {
      const geminiProv = providers.find((p) => p.id === 'gemini');
      if (geminiProv?.apiKey?.trim()) return geminiProv.apiKey.trim();
    } else if (provId !== 'custom') {
      const targetProv = providers.find((p) => p.id === provId);
      if (targetProv?.apiKey?.trim()) return targetProv.apiKey.trim();
    }
    // Fallback chain if specific provider has no key configured
    const geminiProv = providers.find((p) => p.id === 'gemini');
    if (geminiProv?.apiKey?.trim()) return geminiProv.apiKey.trim();
    const activeProv = container.providerSettings.getActiveProvider();
    if (activeProv?.apiKey?.trim()) return activeProv.apiKey.trim();
    const hiddenDefault = container.providerSettings.getHiddenDefaultFull();
    if (hiddenDefault?.apiKey?.trim()) return hiddenDefault.apiKey.trim();
    const anyKey = providers.find((p) => p.apiKey?.trim())?.apiKey?.trim();
    if (anyKey) return anyKey;
    return '';
  };

  /**
   * Server root (no /v1) the Live WebSocket must target, so the Google GenAI
   * SDK dials OUR Google-exact /ws/...BidiGenerateContent relay instead of
   * Google. Only SmartRotator-backed providers route through the app's gateway:
   * - "gemini" (native Google key) → undefined → SDK uses Google's Live endpoint.
   * - "app-default" / "custom" / stored providers on the gateway → SmartRotator root.
   * Respects an explicit baseUrl already saved in live settings.
   */
  const getLiveBaseUrl = (): string | undefined => {
    if (liveConfig.baseUrl?.trim()) return normalizeServerRoot(liveConfig.baseUrl);
    const provId = liveConfig.providerId || 'app-default';
    if (provId === 'gemini') return undefined;
    // If the active key is a native Google Gemini key (AIzaSy...), connect directly to Google
    // to avoid proxy latency and packet chunking on live audio.
    const key = getGeminiLiveApiKey();
    if (key.startsWith('AIzaSy')) return undefined;

    const provider = container.providerSettings.getProviderById(provId)
      ?? container.providerSettings.getActiveProvider()
      ?? container.providerSettings.getHiddenDefaultFull();
    return provider?.baseUrl ? normalizeServerRoot(provider.baseUrl) : undefined;
  };

  const handleStartLiveCall = async (meta?: { reason?: string; isIncomingCall?: boolean; origin?: LiveCallOrigin }) => {
    haptic();
    // LIVE-CONTINUITY FIX (call me chat ka content nahi aa raha): a NEW
    // user-intent call must NEVER inherit the previous call's context. If a live
    // client survived (background/PiP continuation — the app keeps the call alive
    // WhatsApp-style — or a stale client after an app kill), hang it up FIRST so
    // the fresh overlay mounts a client seeded with the CURRENT chat's messages.
    // This is the ONLY mount path (Live button tap + incoming-call accept), so a
    // genuinely ongoing PiP call is never affected — it never re-runs here.
    disposeActiveLiveCall();
    setLiveIncomingMeta(meta && meta.isIncomingCall ? { isIncomingCall: true, reason: meta.reason, origin: meta.origin } : undefined);
    const key = getGeminiLiveApiKey();
    if (!key) {
      hapticError();
      setShowProviderPicker(true);
      return;
    }

    const hasGrantedBefore = localStorage.getItem('levelup.live.permission_granted') === 'true';
    if (hasGrantedBefore) {
      try {
        // ROOT-CAUSE FIX (mic silent bug): AudioManager mode/focus MUST be
        // set to MODE_IN_COMMUNICATION *before* getUserMedia() opens the
        // native AudioRecord — Chromium's own echoCancellation-triggered
        // capture pipeline expects to open under communication mode from
        // the start (this is exactly what Google's own AppRTC WebRTC demo
        // documents: "switch to COMMUNICATION mode when the first
        // streaming session starts"). Previously this only happened
        // *after* the Live WebSocket connected (several hundred ms to a
        // few seconds later), by which point the mic's AudioRecord was
        // already open under MODE_NORMAL — many Android audio HALs do not
        // re-route an already-open capture session when the mode changes
        // underneath it, so the mic effectively went silent to the model
        // every single call, in foreground and background alike.
        const focusGranted = await requestNativeCallAudioFocus();
        if (!focusGranted) {
          // Fall through to the permission modal — its requestMic() also honours
          // focus and will surface a clear error instead of silently proceeding
          // into a broken (silent-mic) call.
          throw new Error('Audio focus denied');
        }
        try {
          // P3 + review-7 P1: the route result must be VERIFIED, not swallowed.
          // Requested route applied → continue. Non-speaker route refused →
          // fall back to the always-available loudspeaker and verify THAT too.
          // Fallback also refused → the startup is aborted (no silent
          // "connected on bluetooth" lie) and native focus is released below.
          const desiredRoute = liveConfig.defaultAudioRoute ?? 'speaker';
          const applied = await setNativeAudioRoute(desiredRoute);
          if (!applied && desiredRoute !== 'speaker') {
            const fallback = await setNativeAudioRoute('speaker');
            // On web the route API is a no-op (null) — accept it there; on
            // native a refused speaker means abort (rollback below releases
            // focus) rather than limping into a false route claim.
            if (!fallback && isNativeAudioPlatform()) {
              throw new Error('No audio route available (speaker fallback failed)');
            }
          }
          // Warm re-launch release race (same root cause as the camera-flip
          // bug): right after an ended call, the WebView can still hold the
          // previous mic hardware. Re-acquiring getUserMedia in the same
          // synchronous turn returns a stale/silent stream and the new call
          // never starts — which is why a cold (full process) restart is the
          // only thing that "worked". Yield a macrotask so the WebView frees
          // the prior mic before we open a fresh one.
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
            },
            video: false,
          });
          // COMMIT POINT (review-7 P0): the handoff flag only becomes true once
          // focus + route + mic capture ALL succeeded. If any step above failed,
          // native focus is released and the flag stays false — a connected
          // overlay can never inherit a stale "focus granted" claim into a call
          // whose audio session never came up.
          setLiveAudioFocusGranted(true);
          setLiveMicStream(stream);
          liveCallSessionIdRef.current = active?.id || ensureSession().id;
          liveCallSessionClosedRef.current = false;
          setShowLiveOverlay(true);
          return;
        } catch {
          // Rollback the half-acquired native audio session (mode/focus/route)
          // so no dangling session lingers — the modal below re-acquires cleanly.
          try {
            await resetNativeAudioRoute();
          } catch {
            // Ignored — best-effort native teardown.
          }
          setLiveAudioFocusGranted(false);
        }
      } catch {
        // Fallback to permission modal if stream acquisition failed
      }
    }

    setShowLivePermission(true);
  };

  const handlePermissionProceed = (micStream: MediaStream, camStream?: MediaStream) => {
    try {
      localStorage.setItem('levelup.live.permission_granted', 'true');
    } catch {
      // Ignored
    }
    // P1: the modal's requestMic() already acquired native focus for this
    // stream — mark it so the client never requests focus a second time.
    setLiveAudioFocusGranted(true);
    setLiveMicStream(micStream);
    setLiveCamStream(camStream || null);
    setShowLivePermission(false);
    liveCallSessionIdRef.current = active?.id || ensureSession().id;
    liveCallSessionClosedRef.current = false;
    setShowLiveOverlay(true);
  };

  const handleExecuteLiveTool = async (name: string, args: Record<string, unknown>): Promise<any> => {
    try {
      if (name === 'getTime') {
        const state = container.store.get();
        const timeZone = state.timeZone ?? deviceTimeZone();
        const now = new Date();
        const time = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone });
        const date = now.toLocaleDateString('en-US', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone });
        return { currentTime: time, currentDate: date, timeZone };
      }
      if (name === 'webSearch') {
        const query = String(args.query || '');
        const state = container.store.get();
        const wsSettings = state.aiSettings.websearch;

        // Resolve WebSearch Context strictly according to user settings in Settings screen!
        if (wsSettings && wsSettings.providerId === 'smartrotator') {
          const s = container.syncCoordinator.getSession();
          const gateway = container.providerSettings.getHiddenDefaultFull();
          const root = s?.serverUrl ?? (gateway?.baseUrl ? gateway.baseUrl.replace(/\/+$/, '') : '');
          // Prefer the session/gateway root, then the user's own baseUrl override
          // in Web Search settings, then the known-good default. The default is
          // never a lock — the user can always override via settings.
          const baseUrl =
            root
              ? (/\/v1$/.test(root) ? root : `${root}/v1`)
              : wsSettings.baseUrl?.trim()
                ? (/\/v1$/.test(wsSettings.baseUrl.trim()) ? wsSettings.baseUrl.trim() : `${wsSettings.baseUrl.trim()}/v1`)
                : 'https://api.smartrotator.com/v1';
          const key = s?.apiKey || wsSettings.apiKey.trim() || gateway?.apiKey || '';
          if (key && query) {
            const searchRes = await container.websearch.search(
              {
                providerId: 'smartrotator',
                apiKey: key,
                baseUrl,
                model: wsSettings.model?.trim() || undefined,
              },
              [{ role: 'user', content: query }],
            );
            if (searchRes.ok && searchRes.text) {
              return { searchResult: searchRes.text };
            }
          }
        } else if (wsSettings && wsSettings.providerId === 'google') {
          const key = wsSettings.apiKey.trim() || getGeminiLiveApiKey();
          if (key && query) {
            const searchRes = await container.websearch.search(
              {
                providerId: 'google',
                apiKey: key,
                baseUrl: wsSettings.baseUrl?.trim() || 'https://generativelanguage.googleapis.com',
                model: wsSettings.model?.trim() || 'gemini-2.5-flash',
              },
              [{ role: 'user', content: query }],
            );
            if (searchRes.ok && searchRes.text) {
              return { searchResult: searchRes.text };
            }
          }
        }

        // Direct fallback
        const fallbackKey = getGeminiLiveApiKey();
        if (fallbackKey && query) {
          try {
            const customModel = wsSettings?.model?.trim() || 'gemini-2.5-flash';
            // AUDIT FIX (round 2, LOW): the API key was passed in the QUERY
            // STRING — it leaks through proxies, WebView network capture and
            // server access logs. Send it via the x-goog-api-key header like
            // the primary web-search path does.
            const resp = await fetch(
              `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(customModel)}:generateContent`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-goog-api-key': fallbackKey },
                body: JSON.stringify({
                  contents: [{ parts: [{ text: `Search the web and provide direct factual information with dates/sources for: ${query}` }] }],
                  tools: [{ google_search: {} }],
                }),
              },
            );
            if (resp.ok) {
              const data = await resp.json();
              const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
              if (text) return { ok: true, status: 'completed', searchResult: text, summary: text };
            }
          } catch {
            // Ignored
          }
        }
        return { ok: false, status: 'no_results', searchResult: `No live search results found for query: ${query}`, summary: `No live search results found for query: ${query}` };
      }
      if (name === 'getPlan') {
        const res = await container.chatTools.runMany([{ action: 'getPlan', day: Number(args.day) || 1 }]);
        return { ok: res.ok, status: res.ok ? 'completed' : 'failed', plan: res.summary, summary: res.summary, result: res.summary };
      }
      if (name === 'addTask') {
        const res = await container.chatTools.runMany([
          {
            action: 'addTask',
            day: Number(args.day) || 1,
            intent: String(args.intent || 'Study task'),
            durationMin: Number(args.durationMin) || 30,
          },
        ]);
        return { ok: res.ok, status: res.ok ? 'completed' : 'failed', requiresConfirmation: res.requiresConfirmation, result: res.summary, summary: res.summary };
      }
      if (name === 'markDone') {
        const res = await container.chatTools.runMany([
          {
            action: 'markDone',
            day: Number(args.day) || 1,
            taskId: String(args.taskId || ''),
          },
        ]);
        return { ok: res.ok, status: res.ok ? 'completed' : 'failed', requiresConfirmation: res.requiresConfirmation, result: res.summary, summary: res.summary };
      }
      if (name === 'editTask') {
        const res = await container.chatTools.runMany([
          {
            action: 'editTask',
            day: Number(args.day) || 1,
            taskId: String(args.taskId || ''),
            title: args.title ? String(args.title) : undefined,
            durationMin: args.durationMin !== undefined ? Number(args.durationMin) : undefined,
          },
        ]);
        return { ok: res.ok, status: res.ok ? 'completed' : 'failed', requiresConfirmation: res.requiresConfirmation, result: res.summary, summary: res.summary };
      }
      if (name === 'getContext') {
        const res = await container.chatTools.runMany([{ action: 'getContext' }]);
        return { ok: res.ok, status: res.ok ? 'completed' : 'failed', context: res.summary, summary: res.summary, result: res.summary };
      }
      if (name === 'saveCustomMemory') {
        const cur = container.store.get();
        const updated = container.memory.add(cur, {
          type: 'observation',
          content: String(args.content || ''),
          source: 'user',
          importance: 0.8,
          longTerm: true,
        });
        container.store.save(updated);
        return { ok: true, status: 'completed', result: 'Memory saved into persistent recollections.', summary: 'Memory saved into persistent recollections.' };
      }
      if (name === 'getTests') {
        const res = await container.chatTools.runMany([{ action: 'getTests' }]);
        return { ok: res.ok, status: res.ok ? 'completed' : 'failed', tests: res.summary, summary: res.summary, result: res.summary };
      }
      if (name === 'getRoutine') {
        const res = await container.chatTools.runMany([{ action: 'getRoutine', day: args.day ? String(args.day) : undefined }]);
        return { ok: res.ok, status: res.ok ? 'completed' : 'failed', routine: res.summary, summary: res.summary, result: res.summary };
      }
      // Custom To-Dos & Study Vault tools
      if (name === 'addTodo') {
        const res = await container.chatTools.runMany([
          {
            action: 'addTodo',
            title: String(args.title || ''),
            priority: (args.priority as any) || 'medium',
            estimatedMinutes: Number(args.estimatedMinutes) || 30,
            category: (args.category as any) || 'general',
          },
        ]);
        return { ok: res.ok, status: res.ok ? 'completed' : 'failed', requiresConfirmation: res.requiresConfirmation, result: res.summary, summary: res.summary };
      }
      if (name === 'editTodo') {
        const res = await container.chatTools.runMany([
          {
            action: 'editTodo',
            todoId: args.todoId ? String(args.todoId) : undefined,
            title: args.title ? String(args.title) : undefined,
            newTitle: args.newTitle ? String(args.newTitle) : undefined,
            priority: (args.priority as any) || undefined,
            estimatedMinutes: args.estimatedMinutes !== undefined ? Number(args.estimatedMinutes) : undefined,
            category: (args.category as any) || undefined,
            completed: args.completed !== undefined ? Boolean(args.completed) : undefined,
          },
        ]);
        return { ok: res.ok, status: res.ok ? 'completed' : 'failed', requiresConfirmation: res.requiresConfirmation, result: res.summary, summary: res.summary };
      }
      if (name === 'reorderTodos') {
        const res = await container.chatTools.runMany([
          {
            action: 'reorderTodos',
            todoId: args.todoId ? String(args.todoId) : undefined,
            title: args.title ? String(args.title) : undefined,
            position: (args.position as any) || undefined,
          },
        ]);
        return { ok: res.ok, status: res.ok ? 'completed' : 'failed', requiresConfirmation: res.requiresConfirmation, result: res.summary, summary: res.summary };
      }
      if (name === 'listTodos') {
        const res = await container.chatTools.runMany([
          {
            action: 'listTodos',
            filter: (args.filter as any) || 'all',
            date: args.date ? String(args.date) : undefined,
            daysBack: args.daysBack !== undefined ? Number(args.daysBack) : undefined,
            category: (args.category as any) || undefined,
          },
        ]);
        return { ok: res.ok, status: res.ok ? 'completed' : 'failed', todos: res.summary, summary: res.summary, result: res.summary };
      }
      if (name === 'toggleTodo') {
        const res = await container.chatTools.runMany([
          {
            action: 'toggleTodo',
            todoId: args.todoId ? String(args.todoId) : undefined,
            title: args.title ? String(args.title) : undefined,
            completed: args.completed !== undefined ? Boolean(args.completed) : undefined,
          },
        ]);
        return { ok: res.ok, status: res.ok ? 'completed' : 'failed', requiresConfirmation: res.requiresConfirmation, result: res.summary, summary: res.summary };
      }
      if (name === 'deleteTodo') {
        const res = await container.chatTools.runMany([
          {
            action: 'deleteTodo',
            todoId: args.todoId ? String(args.todoId) : undefined,
            title: args.title ? String(args.title) : undefined,
          },
        ]);
        return { ok: res.ok, status: res.ok ? 'completed' : 'failed', requiresConfirmation: res.requiresConfirmation, result: res.summary, summary: res.summary };
      }
      if (name === 'listVaultResources') {
        const res = await container.chatTools.runMany([
          {
            action: 'listVaultResources',
            subject: args.subject ? String(args.subject) : undefined,
          },
        ]);
        return { ok: res.ok, status: res.ok ? 'completed' : 'failed', vaultResources: res.summary, summary: res.summary, result: res.summary };
      }
      if (name === 'searchChatHistory') {
        const res = await container.chatTools.runMany([
          {
            action: 'searchChatHistory',
            query: args.query ? String(args.query) : undefined,
            date: args.date ? String(args.date) : undefined,
            fromDate: args.fromDate ? String(args.fromDate) : undefined,
            toDate: args.toDate ? String(args.toDate) : undefined,
          },
        ]);
        return { ok: res.ok, status: res.ok ? 'completed' : 'failed', chatSearchResults: res.summary, summary: res.summary, result: res.summary };
      }
      if (name === 'listChatSessions') {
        const res = await container.chatTools.runMany([
          {
            action: 'listChatSessions',
          },
        ]);
        return { ok: res.ok, status: res.ok ? 'completed' : 'failed', chatSessions: res.summary, summary: res.summary, result: res.summary };
      }
      if (name === 'getChatSession') {
        const res = await container.chatTools.runMany([
          {
            action: 'getChatSession',
            sessionId: String(args.sessionId || ''),
          },
        ]);
        return { ok: res.ok, status: res.ok ? 'completed' : 'failed', chatTranscript: res.summary, summary: res.summary, result: res.summary };
      }
      if (name === 'searchMemory') {
        const res = await container.chatTools.runMany([
          {
            action: 'searchMemory',
            query: String(args.query || ''),
          },
        ]);
        return { ok: res.ok, status: res.ok ? 'completed' : 'failed', memorySearchResults: res.summary, summary: res.summary, result: res.summary };
      }
      if (name === 'readMemory') {
        const res = await container.chatTools.runMany([
          {
            action: 'readMemory',
          },
        ]);
        return { ok: res.ok, status: res.ok ? 'completed' : 'failed', memory: res.summary, summary: res.summary, result: res.summary };
      }
      if (name === 'addMemory') {
        const res = await container.chatTools.runMany([
          {
            action: 'addMemory',
            content: String(args.content || ''),
          },
        ]);
        return { ok: res.ok, status: res.ok ? 'completed' : 'failed', requiresConfirmation: res.requiresConfirmation, result: res.summary, summary: res.summary };
      }
      // End / hang up the live call when the model decides the conversation is
      // over (student says bye/gotta go/phone rakhta hu). This must actually
      // tear down the call AND return a clean, readable summary to the model —
      // previously endLiveCall had no handler, fell into the unknown-tool
      // fallback below, and surfaced an "error reading summary".
      if (name === 'endLiveCall') {
        // P10 drain-aware: the LiveCompanionOverlay ref wrapper first lets
        // Misa's goodbye audio play to completion (0-8s, real pending playback
        // ms from the streamer — no fixed 4s guess), then hangs up. We return
        // the summary to the model immediately; the hang-up is async.
        endLiveCallRef.current?.();
        const reason = String(args?.reason || '').trim();
        const summary = reason ? `Live call ended (${reason}).` : 'Live call ended.';
        return { ok: true, status: 'completed', result: summary, summary };
      }
      // Proactive scheduling / calls (live AI tools) — delegate to proactive agent
      // so the message/call actually fires on schedule. Returns a natural summary
      // back to the live model.
      if (name === 'scheduleMessage' || name === 'scheduleCall' || name === 'makeCall' || name === 'listScheduled' || name === 'cancelScheduled') {
        const actionObj: any = { action: name, ...args };
        const proRes = await container.chatTools.runMany([actionObj]);
        const proSummary = proRes?.summary || (proRes?.ok ? 'Ho gaya.' : 'Kuch galti hui — dobara try karo.');
        return { ok: proRes?.ok === true, status: proRes?.ok ? 'completed' : 'failed', result: proSummary, summary: proSummary };
      }
      // Universal fallback for all other domain tools (editMemory, deleteMemory, pinMemory, getSubject, getRange, etc.)
      const actionObj: any = { action: name, ...args };
      const fallbackRes = await container.chatTools.runMany([actionObj]);
      const fallbackSummary = fallbackRes?.summary || (fallbackRes?.ok ? 'Ho gaya.' : 'Kuch galti hui — dobara try karo.');
      return { ok: fallbackRes?.ok === true, status: fallbackRes?.ok ? 'completed' : 'failed', requiresConfirmation: fallbackRes?.requiresConfirmation, result: fallbackSummary, summary: fallbackSummary };
    } catch (e: any) {
      return { ok: false, status: 'error', error: e?.message || 'Tool execution failed' };
    }
  };

  const handleLiveTranscriptUpdate = (transcripts: LiveTranscriptItem[]) => {
    if (transcripts.length === 0) return;
    // Once the call is closed (hang-up), a late transcript emission from the
    // client must never re-arm a flush and mis-target another chat session.
    if (liveCallSessionClosedRef.current) return;
    // Strictly isolate live call messages to the session where the call was initiated
    const targetSessionId = liveCallSessionIdRef.current || active?.id;
    if (!targetSessionId) return;

    // Coalesce the per-chunk flush: keep the latest snapshot + the session id
    // it belongs to, but only run the expensive sync work (appendMessage→full-store
    // persist, listSessions deep clone, setSessions) once per quiet window — never
    // once per streamed chunk.
    liveTranscriptSnapshotRef.current = { transcripts, sid: targetSessionId };
    if (liveTranscriptTimerRef.current !== null) return;
    liveTranscriptTimerRef.current = window.setTimeout(() => {
      liveTranscriptTimerRef.current = null;
      const latest = liveTranscriptSnapshotRef.current;
      liveTranscriptSnapshotRef.current = null;
      if (!latest || latest.transcripts.length === 0) return;
      // Use the sid captured when the snapshot was STORED — never re-derive
      // from liveCallSessionIdRef (may already be nulled) or active session.
      const sid = latest.sid;
      const msgs: ChatMessage[] = [];
      for (const t of latest.transcripts) {
        if (!t || typeof t.text !== 'string' || !t.text.trim()) continue;
        msgs.push({
          id: t.id,
          role: t.role,
          content: t.text,
          createdAt: t.timestamp,
          model: t.role === 'assistant' ? liveConfigRef.current.model : undefined,
          toolCalls: t.toolCalls,
          reasoning: t.reasoning,
        });
      }
      // One persist for the whole flush instead of one JSON.stringify +
      // localStorage write per chunk (N × full-store cost mid-call).
      if (msgs.length > 0) {
        container.chat.appendMessages(sid, msgs);
        const all = container.chat.listSessions();
        setSessions(all);
      }
      // Streaming-tail tracking: only the CURRENTLY growing assistant reply stays
      // plain-text. Once a user turn lands (or the reply id is superseded), the
      // flag drops and that bubble gets its single markdown parse.
      setLiveStreamingMsgId(liveStreamingTailId(latest.transcripts));
    }, 250);
    // Never hijack activeId if the user navigated to another chat during the call
  };

  const handleLiveOverlayClose = (transcripts: LiveTranscriptItem[]) => {
    setShowLiveOverlay(false);
    // Late transcript emissions after this point belong to a CLOSED call — they
    // must never re-arm a coalesced flush against a different chat session.
    liveCallSessionClosedRef.current = true;
    // Cancel any pending coalesced transcript flush — the final transcript
    // array is re-applied idempotently below, so the timer must not fire later
    // against a call that has already been torn down.
    if (liveTranscriptTimerRef.current !== null) {
      window.clearTimeout(liveTranscriptTimerRef.current);
      liveTranscriptTimerRef.current = null;
    }
    liveTranscriptSnapshotRef.current = null;
    // Streams are acquired by this screen, so explicitly release hardware on
    // a user hang-up. The live client intentionally preserves tracks while it
    // reconnects, but an ended call must not leave the microphone/camera live.
    liveMicStream?.getTracks().forEach((track) => track.stop());
    liveCamStream?.getTracks().forEach((track) => track.stop());
    setLiveMicStream(null);
    setLiveCamStream(null);
    // Review-8 P1 (duplicated handoff state): this screen-level ownership flag
    // must be reset on EVERY hangup so Call #2 can never inherit Call #1's
    // "pre-capture focus granted" claim. The client separately clears its own
    // callAudioFocusGranted on disconnect (single source of truth for focus);
    // this React flag is only the pre-capture handoff hint and must start
    // false for every new call.
    setLiveAudioFocusGranted(false);
    void resetNativeAudioRoute().catch(() => undefined);
    const targetSessionId = liveCallSessionIdRef.current || active?.id;
    if (transcripts?.length > 0 && targetSessionId) {
      const finalMsgs: ChatMessage[] = [];
      for (const t of transcripts) {
        if (!t || typeof t.text !== 'string' || !t.text.trim()) continue;
        finalMsgs.push({
          id: t.id,
          role: t.role,
          content: t.text,
          createdAt: t.timestamp,
          model: t.role === 'assistant' ? liveConfigRef.current.model : undefined,
          toolCalls: t.toolCalls,
          reasoning: t.reasoning,
        });
      }
      // Single persist for the final transcript (idempotent by id).
      container.chat.appendMessages(targetSessionId, finalMsgs);
    }
    liveCallSessionIdRef.current = null;
    const all = container.chat.listSessions();
    setSessions(all);
    // Call over — no message is growing anymore; every live reply renders its
    // single markdown parse now (the idempotent re-apply above is final text).
    setLiveStreamingMsgId(null);
  };

  const refresh = useCallback(() => {
    setSessions(container.chat.listSessions());
  }, []);

  /**
   * Loads the memory archive and opens the chat history sheet. Chats only enter
   * memory on explicit "Copy to memory" or the manual memory panel — switching
   * chats never auto-archives them.
   */
  function openHistory() {
    setMemoryChats(container.chat.listMemoryConversations());
    setShowHistory(true);
  }

  /** Opens a memory-archived chat in the read-only viewer. */
  function openMemoryChat(sessionId: string) {
    haptic();
    setShowHistory(false);
    setShowMemoryChatId(sessionId);
  }

  function ensureSession(): ChatSession {
    let s = active;
    if (!s) {
      s = container.chat.createSession('', globalChatPrefs());
      refresh();
      setActiveId(s.id);
    }
    return s;
  }

  /**
   * Switching away from a chat that still has unsaved messages asks once whether
   * to copy it into memory ("Copy to memory") or leave it and just switch.
   * Already-copied or empty chats switch immediately without asking.
   */
  function switchAway(action: () => void) {
    if (active && active.messages.length > 0 && !container.chat.isChatArchived(active.id)) {
      setMemoryPrompt({ sessionId: active.id, title: active.title || 'Yeh chat', onConfirm: action });
      return;
    }
    action();
  }

  function newChat() {
    haptic();
    setShowHistory(false);
    switchAway(() => {
      const session = container.chat.createSession('', globalChatPrefs());
      refresh();
      setActiveId(session.id);
      setDraft('');
      revokeAttachmentUrls(attachments);
      setAttachments([]);
      setError('');
      focusComposer();
    });
  }

  /** Opens the chat settings sheet, creating a session first when none exists. */
  function openSettings() {
    ensureSession();
    setShowSettings(true);
  }

  function openSession(id: string) {
    if (id === activeId) return;
    switchAway(() => {
      setActiveId(id);
      setError('');
    });
  }

  function removeSession(id: string) {
    container.chat.deleteSession(id);
    if (activeId === id) setActiveId(null);
    refresh();
  }

  function clearMessages() {
    if (active && confirm('Is chat ke SAARE messages permanently delete karne hain? Ye undo nahi ho sakta.')) {
      container.chat.clearSession(active.id);
      refresh();
    }
  }

  function updatePrefs(patch: Partial<ChatPreferences>) {
    if (!active) return;
    const next = { ...active.prefs, ...patch };
    container.chat.updatePrefs(active.id, next);
    syncGlobalChatSettings(next);
    refresh();
  }

  function resetPrefs() {
    if (!active) return;
    container.chat.updatePrefs(active.id, globalChatPrefs());
    refresh();
    haptic();
    setNotice('Chat settings reset ho gaye');
  }

  /** Mirrors shared session settings back into the global chat settings AND
   *  re-propagates them to every other session. Without the applyGlobalPrefs
   *  call the other sessions would silently keep their old values. */
  function syncGlobalChatSettings(prefs: ChatPreferences) {
    const s = container.store.get();
    const chat = {
      ...s.aiSettings.chat,
      temperature: prefs.temperature,
      maxTokens: prefs.maxTokens,
      systemPrompt: prefs.systemPrompt,
      userPersona: prefs.userPersona,
      includeJourneyContext: prefs.includeContext,
      // Keep `thinking` present even when provider-default, so the shared
      // global can CLEAR sessions that had a custom level (not just set one).
      ...(prefs.thinking ? { thinking: prefs.thinking } : { thinking: undefined }),
    };
    container.store.save({
      ...s,
      aiSettings: {
        ...s.aiSettings,
        chat,
      },
    });
    container.chat.applyGlobalPrefs(globalChatPrefsFromSettings(chat));
  }

  async function loadCatalog() {
    if (!active?.prefs.providerId) return;
    const config = container.providerSettings.getProviderById(active.prefs.providerId);
    if (!config || config.hidden) return;
    try {
      setCatalog(await container.modelCache.getModels(config));
    } catch {
      setCatalog([]);
    }
  }

  async function send() {
    // User initiated a send — snap back to the latest messages (hang-fix P1).
    setStuckToBottom(true);
    const pendingDraft = draft;
    const pendingAttachments = attachments;
    const text = buildPromptWithAttachments(pendingDraft.trim(), pendingAttachments);
    if (!text || streaming) return;

    // LIVE CALL routing (user: "call chalu ho toh chat me type kiya message
    // call me hi jaye, confusion na ho"). Jab live call active hai (PiP bubble
    // ya overlay open) toh chat composer ka PLAIN text direct Gemini Live
    // session me jaata hai — normal chat LLM streaming nahi chalti (nahi toh
    // do alag conversations ban jaati hain). handleLiveTranscriptUpdate yahi
    // text baad me session me dikha deta hai, isliye koi loss nahi.
    // Attachments / edit / @tools advanced flows normal chat me hi rehte hain.
    if (pendingAttachments.length === 0 && !editing && isLiveCallActive()) {
      const live = getActiveLiveClient();
      if (live) {
        live.sendTextMessage(pendingDraft.trim(), pendingDraft.trim());
        setDraft('');
        setToolMentions([]);
        setShowAttach(false);
        haptic();
        return;
      }
    }

    const s = ensureSession();
    const editTarget = editing && editing.sessionId === s.id ? editing : null;
    setShowAttach(false);
    if (editTarget) {
      container.chat.deleteMessagesFrom(s.id, editTarget.messageId);
      setEditing(null);
      refresh();
    }
    await doSend(s.id, text, pendingDraft, pendingAttachments, toolMentions);
  }

  async function doSend(
    sessionId: string,
    text: string,
    pendingDraft: string,
    pendingAttachments: DraftAttachment[],
    onlyTools: string[],
  ) {
    if (!text || streaming) return;
    // Late-reply follow-up: agar user ne Misa ke brown (missed) me aaya message
    // ka jawaab kaafi der baad diya, record karo taaki natural "tum bahut der
    // me reply kiya, sab theek hai?" mile. Sirf tab jab ek visible dikhne wala
    // gap (>= 30 min) ho aur wo paused/acknowledged na ho — service khud
    // recent-audit + dedupe karti hai.
    try {
      const prev: ChatSession | null = container.chat.getSession(sessionId);
      const lastUser = prev?.messages
        ? [...prev.messages].reverse().find((m) => m.role === 'user' && m.content?.trim())
        : undefined;
      if (lastUser?.createdAt) {
        const lateByMs = Date.now() - new Date(lastUser.createdAt).getTime();
        if (lateByMs >= 30 * 60 * 1000) {
          proactiveAgentService.recordMessageLateReply(lateByMs);
        }
      }
    } catch {
      // late-reply tracking best-effort — kabhi main flow ko rok na de
    }
    let sent = false;
    setError('');
    setDraft('');
    setAttachments([]);
    setToolMentions([]);
    setToolQuery(null);
    setStreaming(true);
    const controller = new AbortController();
    abortRef.current = controller;

    // Convert DraftAttachment to ChatAttachment for LLM
    const chatAttachments: ChatAttachment[] = pendingAttachments.map((a) => ({
      id: a.id,
      name: a.name,
      kind: a.kind,
      previewUrl: a.previewUrl,
      content: a.content,
    }));

    // Collect the whole reply first — nothing is shown while it streams, and no
    // thinking/typing indicator starts early (even during tool calls). Only
    // when the full answer is ready do we reveal it: a fixed 3s thinking pause
    // with dots, the first paragraph, then a random 3-8s thinking pause before
    // each next paragraph — like a person sending short messages one at a time.
    let lastAssistantId: string | null = null;
    const pending = container.chat.send(
      sessionId,
      text,
      undefined, // onDelta — intentionally not shown live
      controller.signal,
      undefined, // onStatus — intentionally unused; no live tool-status box in the composer
      undefined, // reasoning delta — collected and stored on the message
      chatAttachments,
      onlyTools,
    );
    // chat.send() pushes the user message synchronously before its first await,
    // so re-read sessions now — the user's own message appears immediately
    // while the AI collects the reply, instead of only after it completes.
    refresh();
    try {
      const assistant = await pending;
      sent = true;
      lastAssistantId = assistant.id;

      // AI reply complete — native/web notification (sirf jab user ne Settings me ON kiya ho).
      // sessionId notification ke extra me jaata hai — tap/reply se usi chat pe khulega.
      // Chat reply ko bubble-by-bubble reveal karta hai: pehla bubble 3s ke
      // thinking pause ke baad, phir har paragraph ke beech random 3–8s. Wohi
      // schedule notification ko bhi mile (revealScheduleRef), taaki notification
      // bhi har bubble ke aate hi update ho.
      const bubbles = splitReplyIntoBubbles(assistant.content);
      const schedule = computeRevealSchedule(bubbles.length);
      if (bubbles.length > 0) {
        revealScheduleRef.current = schedule;
      }
      // Notification me bhi wahi WhatsApp-style merging: same sessionId = same
      // notification id, har bubble ke reveal moment pe update hoti hai (purana
      // merge hoke naya ban jata hai). Last update me POORA reply hota hai —
      // chahe reply kitna bhi bada ho, koi character cut-off nahi.
      // Title = "Misa" (sender), body = poora reply — reply/open actions same
      // sessionId se hi kaam karte hain.
      //
      // Har bubble apne reveal moment pe JS timer se fire hota hai (delayMs=0 →
      // turant show/merge), OS-level pre-scheduling nahi — Android plugin same
      // id ke pending alarms cancel kar deta hai, isliye pehle se schedule kiye
      // steps me se sirf aakhri fire hota aur bubble reveal kabhi dikhta nahi.
      // Capacitor KeepRunning=true (default) background me bhi timers chalata
      // hai, isliye user ke tab-switch/app-minimize karne pe bhi notification
      // bubble-by-bubble merge hoti rehti hai.
      // Body = latest bubble (collapsed/heads-up — warna Android cumulative
      // text ka pehla line har popup me dikhata), largeBody = poora reply so
      // far, messages = native MessagingStyle expand ke liye (scrollable) —
      // user ka message username se, Misa ke bubbles 'ai' se.
      for (const step of buildNotificationSteps(bubbles, schedule, undefined, { text, at: Date.now() })) {
        setTimeout(() => void notifyAiReply('Misa', step.latest || 'Naya AI reply aaya', sessionId, 0, undefined, step.text, step.messages, { preferBigText: true }), step.delayMs);
      }
      // Koi visible bubble nahi (sirf whitespace reply) — ek turant notification.
      if (bubbles.length === 0) {
        void notifyAiReply(
          'Misa',
          assistant.content.trim() || 'Naya AI reply aaya',
          sessionId,
          0,
          undefined,
          assistant.content.trim() || undefined,
          undefined,
          { preferBigText: true },
        );
      }
    } catch (err) {
      setDraft(pendingDraft);
      setAttachments(pendingAttachments);
      if (isAbortError(err)) {
        setNotice('Stopped');
        setError('');
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (sent) revokeAttachmentUrls(pendingAttachments);
      abortRef.current = null;
      setStreaming(false);
      refresh();
      // Only the message we just generated gets the reveal effect; reopening
      // an old chat must never replay it.
      if (sent && lastAssistantId) {
        setRevealId(lastAssistantId);
        // AUDIT FIX (round 1, LOW): `active` here is the render-closure session
        // captured when doSend STARTED — before the reply streamed in, so
        // active.messages never contains the new assistant message and
        // finalAssistant was almost always undefined (the proactive agent got an
        // empty reply). Read the fresh session from the service instead.
        const freshSession = container.chat.getSession(sessionId);
        const finalAssistant = freshSession?.messages.find((m) => m.id === lastAssistantId);
        proactiveAgentService.onChatTurn(text, finalAssistant?.content || '', {
          tasksCount: container.store.get().customTodos?.length || 0,
        });
      }
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  function regenerate() {
    if (!active || streaming) return;
    const msgs = active.messages;
    const last = msgs[msgs.length - 1];
    if (!last || last.role !== 'assistant') return;
    const userMsg = msgs[msgs.length - 2];
    if (!userMsg || userMsg.role !== 'user') return;
    container.chat.deleteMessagesFrom(active.id, userMsg.id);
    refresh();
    haptic();
    void doSend(active.id, userMsg.content, '', [], []);
  }

  /**
   * Wired to the tappable Yes/No buttons on a blocked destructive/bulk tool
   * action (setDayMode, removeTask, memory deletion, etc.) — see
   * ChatMessage.pendingConfirmation. Mirrors doSend's streaming/reveal
   * pattern so the confirmation reply behaves like any other AI message,
   * but calls confirmPendingAction instead of send(): the actual action is
   * replayed deterministically with confirmed:true, no model round-trip
   * involved in whether it actually applies.
   */
  function confirmAction(message: ChatMessage, confirmed: boolean) {
    if (!active || streaming) return;
    haptic();
    setStreaming(true);
    const controller = new AbortController();
    abortRef.current = controller;
    const pending = container.chat.confirmPendingAction(active.id, message.id, confirmed, undefined, controller.signal);
    refresh();
    let sent = false;
    let lastAssistantId: string | null = null;
    void pending
      .then((assistant) => {
        sent = true;
        lastAssistantId = assistant.id;
        const bubbles = splitReplyIntoBubbles(assistant.content);
        const schedule = computeRevealSchedule(bubbles.length);
        if (bubbles.length > 0) revealScheduleRef.current = schedule;
        for (const step of buildNotificationSteps(bubbles, schedule, undefined, { text: confirmed ? 'Confirm' : 'Cancel', at: Date.now() })) {
          setTimeout(() => void notifyAiReply('Misa', step.latest || 'Naya AI reply aaya', active.id, 0, undefined, step.text, step.messages, { preferBigText: true }), step.delayMs);
        }
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        abortRef.current = null;
        setStreaming(false);
        refresh();
        if (sent && lastAssistantId) setRevealId(lastAssistantId);
      });
  }

  function deleteMessage(message: ChatMessage) {
    if (!active) return;
    container.chat.deleteMessage(active.id, message.id);
    refresh();
    haptic();
    setNotice('Message delete ho gaya');
  }

  function editMessage(message: ChatMessage) {
    if (!active || streaming) return;
    const editDraft = stripAttachmentBlocks(message.content);
    setEditing({ sessionId: active.id, messageId: message.id, originalDraft: draft });
    setDraft(editDraft);
    setAttachments([]);
    setShowAttach(false);
    setError('');
    setNotice('Editing mode — send karne par is message ke baad wali chat replace hogi.');
    haptic();
    focusComposer();
  }

  function cancelEdit() {
    if (!editing) return;
    setDraft(editing.originalDraft);
    setEditing(null);
    setError('');
    setNotice('Edit cancel ho gaya — chat unchanged.');
    haptic();
    focusComposer();
  }

  async function copyMessage(message: ChatMessage) {
    try {
      await navigator.clipboard.writeText(message.content);
      setNotice('Copied');
      hapticSuccess();
    } catch {
      hapticError();
    }
  }

  function shareMessage(message: ChatMessage) {
    if ('share' in navigator) {
      navigator
        .share({ text: message.content })
        .then(() => {})
        .catch(() => {});
    } else {
      void copyMessage(message);
    }
  }

  function downloadMessage(message: ChatMessage) {
    void exportTextFile(message.content, `levelup-ai-${new Date(message.createdAt).toISOString().slice(0, 10)}.md`, 'text/markdown;charset=utf-8').then((result) => {
      if (!result.ok) setNotice(result.message);
    });
  }

  function exportChat() {
    if (!active) return;
    const md = [
      `# ${active.title || 'LevelUp chat'}`,
      '',
      ...active.messages.map((m) => `**${m.role === 'user' ? 'User' : 'AI'}:**\n\n${m.content}`),
      '',
    ].join('\n\n');
    void exportTextFile(md, `levelup-chat-${(active.title || 'session').slice(0, 30).replace(/[^\w-]+/g, '_')}.md`, 'text/markdown;charset=utf-8').then((result) => {
      setNotice(result.message);
    });
  }

  async function attachFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setError('');
    const pending = Array.from(files);
    setProcessing((prev) => [...prev, ...pending.map((f) => f.name)]);
    try {
      const next = await Promise.all(pending.map(readAttachment));
      setAttachments((prev) => [...prev, ...next]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setProcessing((prev) => prev.filter((name) => !pending.some((f) => f.name === name)));
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  function removeAttachment(id: string) {
    setAttachments((prev) => {
      const item = prev.find((a) => a.id === id);
      if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl);
      return prev.filter((a) => a.id !== id);
    });
  }

  function pickFiles(accept: string, capture?: string) {
    const input = fileInputRef.current;
    if (!input) return;
    input.accept = accept;
    if (capture) input.setAttribute('capture', capture);
    else input.removeAttribute('capture');
    input.click();
  }

  function insertPromptTemplate(template: string) {
    setDraft((prev) => (prev.trim() ? `${prev.trim()}\n\n${template}` : template));
  }

  async function handleAttachVaultResource(resource: StudyResource) {
    setShowVaultPicker(false);
    haptic();
    try {
      setProcessing((prev) => [...prev, resource.fileName]);
      const blob = await getVaultFileBlob(resource.storageKey);
      if (!blob) {
        setError(`"${resource.title}" ka file data nahi mila.`);
        return;
      }
      const blobObj = typeof blob === 'string' ? new Blob([blob]) : blob;
      const file = new File([blobObj], resource.fileName, { type: blobObj.type || resource.fileType || 'application/pdf' });
      const att = await readAttachment(file);
      setAttachments((prev) => [...prev, att]);
      setNotice(`"${resource.title}" message me attach ho gaya!`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Vault file attach karne me error aaya.');
    } finally {
      setProcessing((prev) => prev.filter((name) => name !== resource.fileName));
      focusComposer();
    }
  }

  function attachTool(id: string) {
    setShowAttach(false);
    haptic();
    switch (id) {
      case 'vault':
        setShowVaultPicker(true);
        return;
      case 'math':
        insertPromptTemplate(MATH_TEMPLATE);
        break;
      case 'canvas':
        insertPromptTemplate(CANVAS_TEMPLATE);
        break;
      case 'markdown':
        insertPromptTemplate(MD_TEMPLATE);
        break;
      case 'image':
      case 'gallery':
        pickFiles('image/*');
        break;
      case 'camera':
        pickFiles('image/*', 'environment');
        break;
      case 'pdf':
        pickFiles('.pdf,.ppt,.pptx,.doc,.docx,.xls,.xlsx,.zip');
        break;
      case 'notes':
        pickFiles('.txt,.md,.markdown,.csv,.json,.yaml,.yml,.xml,.html,.htm,.css,.scss,.less,.js,.jsx,.ts,.tsx,.py,.java,.cpp,.c,.h,.cs,.go,.rs,.rb,.php,.swift,.kt,.sh,.bash,.bat,.ps1,.sql,.toml,.ini,.cfg,.log,.tex,.env,.properties');
        break;
    }
    focusComposer();
  }

  function focusComposer() {
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  function keydown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Escape' && toolQuery !== null) {
      e.preventDefault();
      setToolQuery(null);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  /** Composer typing: track the draft and open/close the "@" tool picker. */
  function handleDraftChange(value: string) {
    setDraft(value);
    const match = /(^|\s)@([a-z]*)$/i.exec(value);
    if (match && toolCatalog.length > 0 && !streaming) setToolQuery(match[2] ?? '');
    else setToolQuery(null);
    // Notify proactive service so its 20 s / 2 min idle timers don't fire
    // while the user is actively composing a message. Throttled internally
    // (saveState once per 20 s) so there's no localStorage churn per keystroke.
    proactiveAgentService.recordTyping();
    // Live call chalu ho toh typing live session ki activity hai — silence
    // observer restart karo taaki mid-composition "arey suno?" na aaye.
    if (isLiveCallActive()) getActiveLiveClient()?.reportUserTyping();
  }

  /** Pins a tool from the "@" picker: strips the "@query" text and adds a chip. */
  function pickTool(tool: ChatToolMeta) {
    setDraft((d) => d.replace(/(^|\s)@[a-z]*$/i, '$1').trimEnd());
    setToolMentions((prev) => (prev.includes(tool.id) ? prev : [...prev, tool.id]));
    setToolQuery(null);
    focusComposer();
  }

  function removeToolMention(id: string) {
    setToolMentions((prev) => prev.filter((t) => t !== id));
  }

  function openMenu(e: { clientX: number; clientY: number }, message: ChatMessage) {
    setMenu({
      message,
      x: Math.max(8, Math.min(e.clientX, window.innerWidth - 200)),
      y: Math.max(8, Math.min(e.clientY, window.innerHeight - 280)),
    });
  }

  const { menuRef } = useMenuFocus(menu !== null, () => setMenu(null));

  // Refresh the ref with the latest closures on every render — the ref object
  // itself stays the same, so memoized MessageBubble instances never re-render
  // just because these identities changed.
  const handleStartLiveCallRef = useRef(handleStartLiveCall);
  handleStartLiveCallRef.current = handleStartLiveCall;

  actionsRef.current = {
    onMenu: openMenu,
    onCopy: (m) => void copyMessage(m),
    onEdit: editMessage,
    onRegenerate: regenerate,
    onDelete: deleteMessage,
    onDownload: downloadMessage,
    onShare: (m) => shareMessage(m),
    onConfirmAction: confirmAction,
    onStartLiveCall: () => void handleStartLiveCallRef.current(),
  };

  useEffect(() => {
    const onStartLiveCallEvent = (e: Event) => {
      const detail = (e as CustomEvent<{ reason?: string; isIncomingCall?: boolean; origin?: LiveCallOrigin }>).detail;
      void handleStartLiveCallRef.current({
        reason: detail?.reason,
        isIncomingCall: detail?.isIncomingCall === true,
        origin: detail?.origin,
      });
    };
    window.addEventListener('levelup:start-live-call', onStartLiveCallEvent);
    return () => window.removeEventListener('levelup:start-live-call', onStartLiveCallEvent);
  }, []);

  useEffect(() => {
    const unsubscribe = proactiveAgentService.onMessageInjection((injected) => {
      // REAL-FIX (notification-tap race): active session abhi load nahi hua
      // (boot/background-resume) → ye listener kuch deliver NAHI kar saka.
      // Service ko `false` return karke batana zaroori hai taaki wo store
      // fallback chala sake. Pehle silent `return` → service ne "delivered"
      // maan liya → message poori tarah gayab ho jaata tha.
      if (!active) return false;
      const msg: ChatMessage = {
        id: injected.msgId ?? `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        role: injected.role,
        content: injected.text,
        createdAt: new Date().toISOString(),
        isProactive: injected.isProactive,
        isCallEvent: injected.isCallEvent,
        callStatus: injected.callStatus as any,
      };
      // AUDIT FIX: appendMessage ab boolean return karta hai — session vanish
      // ho gaya (deleted) toh false → service store-fallback + window event
      // chala ke SAME msgId se message commit kare; "true" par galati se nahi.
      if (!container.chat.appendMessage(active.id, msg)) return false;
      refresh();
      haptic();
      return true;
    });
    return unsubscribe;
  }, [active, refresh]);

  // Fallback: window event se proactive messages catch karo jab listener
  // registered nahi tha (ChatScreen unmounted/tab switch). Direct listener
  // path se dedupe already hota hai — yeh sirf woh deliver karta hai jo
  // listener ke bina dispatch hua tha.
  useEffect(() => {
    const onProactiveWindow = (e: Event) => {
      const detail = (e as CustomEvent<{ text: string; isProactive?: boolean; msgId?: string }>).detail;
      if (!detail?.text || !active) return;
      const msg: ChatMessage = {
        id: detail.msgId ?? `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        role: 'assistant',
        content: detail.text,
        createdAt: new Date().toISOString(),
        isProactive: detail.isProactive ?? true,
      };
      container.chat.appendMessage(active.id, msg);
      refresh();
      haptic();
    };
    window.addEventListener('levelup:proactive-message', onProactiveWindow);
    return () => window.removeEventListener('levelup:proactive-message', onProactiveWindow);
  }, [active, refresh]);

  return (
    <div className="chat-shell fade-up">
      {/* Top bar */}
      <header className="chat-topbar">
        <button
          type="button"
          onClick={newChat}
          className="icon-btn"
          aria-label="New chat"
          title="New chat"
        >
          <MessageSquarePlus size={19} color="var(--color-l)" />
        </button>
        <button
          type="button"
          onClick={openHistory}
          className="flex h-full min-w-0 flex-1 items-center gap-2 px-1 text-left"
          aria-label="Open chat history"
        >
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-danger/12 text-danger"><Sparkles size={16} /></span>
          <span className="min-w-0">
            <span className="block truncate font-display text-[15px] font-bold leading-none">{active?.title || 'Misa'}</span>
          </span>
          <Sparkles size={13} className="shrink-0 text-peak" aria-label="Misa features in development" />
          <ChevronDown size={13} className="shrink-0 text-muted" />
        </button>
        <button
          type="button"
          onClick={openSettings}
          className="flex h-8 max-w-[9.5rem] shrink-0 items-center gap-1.5 rounded-full border border-border bg-panel px-2.5 text-[10px] font-semibold text-muted transition-colors hover:border-border-strong"
          aria-label="Model settings"
          title="Model settings"
        >
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ background: aiEnabled ? 'var(--color-success)' : 'var(--color-muted-dim)' }}
          />
          <span className="truncate">
            {modelChip.label}
          </span>
        </button>
        <button
          type="button"
          onClick={openSettings}
          className="icon-btn"
          aria-label="Chat settings"
          title="Chat settings"
        >
          <MoreHorizontal size={20} />
        </button>
      </header>

      {/* Conversation */}
      <main ref={scrollRef} className="chat-thread" aria-label="Messages" onScroll={handleThreadScroll}>
        <div role="status" className="sr-only">{liveAnnounce}</div>
        {!hasMessages && !streaming ? (
          <EmptyChat onPick={(t) => setDraft(t)} />
        ) : (
          <div className="mx-auto max-w-[48rem] py-4">
            {visibleMessages.map((m, i) => (
              <MessageBubble
                key={m.id}
                message={m}
                isLast={i === visibleMessages.length - 1}
                showThinking={showThinking}
                reveal={m.id === revealId}
                revealSchedule={m.id === revealId ? revealScheduleRef.current : undefined}
                streaming={m.id === liveStreamingMsgId}
                scrollRef={scrollRef}
                onRevealDone={handleRevealDone}
                actionsRef={actionsRef}
              />
            ))}
          </div>
        )}
      </main>

      {/* Composer */}
      <div className="chat-composer-wrap">
        {liveCallInterrupted && (
          <div
            className="mb-2 flex items-center justify-between gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-400"
            role="status"
          >
            <span>
              Pichli Live call system restart ki wajah se ruk gayi thi (yahan maine call end nahi ki thi).
              Dobara shuru karne ke liye Live Call kholen.
            </span>            <button
              onClick={dismissLiveCallInterrupted}
              className="ml-auto shrink-0 rounded-full border border-amber-500/30 px-2 py-0.5 text-[10px] font-semibold hover:bg-amber-500/10"
              aria-label="Dismiss"
            >
              Theek hai
            </button>
          </div>
        )}
        {(error || notice) && (
          <div
            className={`mb-2 flex justify-center text-center ${error ? 'text-danger' : 'text-muted'}`}
            role={error ? 'alert' : 'status'}
          >
            <span className="rounded-full border border-border bg-panel px-3 py-1.5 text-[11px]">
              {error || notice}
            </span>
          </div>
        )}
        <div className="relative">
          {toolQuery !== null && filteredTools.length > 0 && (
            <div
              ref={toolPickerRef}
              className="absolute bottom-full left-0 right-0 z-30 mb-2 max-h-72 overflow-y-auto overscroll-contain rounded-2xl border border-border bg-surface/95 p-1.5 pr-1 shadow-xl backdrop-blur [scrollbar-width:thin]"
            >
              <p className="px-2 pb-1 pt-1 text-[9px] font-semibold uppercase tracking-wider text-muted">
                Tools — is run mein sirf ye chalenge
              </p>
              {filteredTools.map((t) => {
                const selected = toolMentions.includes(t.id);
                return (
                  <button
                    key={t.id}
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      pickTool(t);
                    }}
                    className={`flex w-full items-start gap-2.5 rounded-xl px-2 py-2 text-left transition-colors ${
                      selected ? 'bg-l/15' : 'hover:bg-bg'
                    }`}
                  >
                    <span
                      className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-md border ${
                        selected ? 'border-l bg-l text-bg' : 'border-border'
                      }`}
                      aria-hidden="true"
                    >
                      {selected && <Check size={11} strokeWidth={3} />}
                    </span>
                    <span className="min-w-0">
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        <span className="text-xs font-semibold text-text">@{t.id}</span>
                        <span className="text-[10px] font-medium text-l">{t.label}</span>
                      </span>
                      <span className="block truncate text-[10px] leading-snug text-muted">{t.description}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          <div className="chat-input chat-composer rounded-[1.5rem] p-1.5">
            {(toolMentions.length > 0 || processing.length > 0 || attachments.length > 0) && (
              <div className="no-scrollbar mb-1.5 flex gap-2 overflow-x-auto px-1 pt-1">
                {toolMentions.map((id) => (
                  <ToolChip key={id} id={id} catalog={toolCatalog} onRemove={() => removeToolMention(id)} />
                ))}
                {processing.map((name) => (
                <span
                  key={`proc-${name}`}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-l/30 bg-l/10 px-2 py-1 text-[10px] font-semibold text-l"
                  role="status"
                >
                  <span className="spinner" aria-hidden="true" />
                  <span className="truncate">{name}</span>
                </span>
              ))}
              {attachments.map((a) => (
                <AttachmentChip key={a.id} attachment={a} onRemove={() => removeAttachment(a.id)} />
              ))}
            </div>
          )}
          {editing && (
            <div className="mb-1.5 flex items-center justify-between gap-2 rounded-2xl border border-light/25 bg-light/10 px-3 py-2 text-xs">
              <div className="min-w-0">
                <p className="font-semibold text-light">Editing message</p>
                <p className="truncate text-[10px] text-muted">Cancel dabane se niche wali chat safe rahegi.</p>
              </div>
              <button type="button" className="btn btn-ghost min-h-8 px-2.5 py-1 text-xs" onClick={cancelEdit}>
                <X size={13} /> Cancel
              </button>
            </div>
          )}
          <div className="flex items-end gap-1">
            <button
              type="button"
              onClick={() => setShowAttach(true)}
              className="icon-btn shrink-0"
              aria-label="Attach files"
              title="Attach files"
            >
              <Paperclip size={19} color="var(--color-muted)" />
            </button>
            <textarea
              ref={textareaRef}
              rows={1}
              value={draft}
              onChange={(e) => handleDraftChange(e.target.value)}
              onKeyDown={keydown}
              placeholder={
                isLiveCallActive()
                  ? 'Live call me bhejo — text direct call me jaayega…'
                  : 'Maths, doubts ya notes likho… (@ se tools select karo)'
              }
              className="max-h-36 min-h-10 flex-1 resize-none bg-transparent px-2 py-2 text-[14px] leading-snug text-text outline-none placeholder:text-muted-dim"
              aria-label="Message"
            />
            {/* Live Voice / Multimodal Call Button */}
            <button
              type="button"
              onClick={() => void handleStartLiveCall()}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-l/30 bg-l/15 text-l transition-transform active:scale-90 hover:bg-l/25"
              aria-label="Start Misa Live Call"
              title="Misa Live (Voice & Doubt Call)"
            >
              <Sparkles size={17} className="animate-pulse" />
            </button>
            {streaming ? (
              <button
                type="button"
                onClick={stop}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-danger/40 bg-danger/10 transition-transform active:scale-90"
                aria-label="Stop generating"
              >
                <X size={17} color="var(--color-danger)" />
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void send()}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-l transition-transform active:scale-90"
                aria-label={isLiveCallActive() ? 'Send to live call' : editing ? 'Send edited message' : 'Send message'}
                title={isLiveCallActive() ? 'Text call me jaayega' : undefined}
              >
                {isLiveCallActive() ? (
                  <Phone size={17} color="var(--color-ink)" />
                ) : (
                  <Send size={17} color="var(--color-ink)" />
                )}
              </button>
            )}
          </div>
        </div>
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept=".pdf,.txt,.md,.markdown,.csv,.json,.yaml,.yml,.tex,.ppt,.pptx,.doc,.docx,.xls,.xlsx,image/*"
        className="hidden"
        onChange={(e) => void attachFiles(e.target.files)}
      />

      {/* Overlays */}
      {(() => {
        const currentSession =
          (showSettings || showProviderPicker)
            ? active || (sessions.length > 0 ? sessions[0] : null) || ensureSession()
            : null;
        return (
          <>
            {currentSession && showSettings && (
              <SettingsSheet
                prefs={currentSession.prefs}
                providers={providers}
                catalog={catalog}
                onChange={updatePrefs}
                onReset={resetPrefs}
                onLoadCatalog={() => void loadCatalog()}
                onOpenProviderPicker={() => setShowProviderPicker(true)}
                onProviderAdded={() => setProviderSig((s) => `${s}-added`)}
                onHistoryChanged={() => {
                  setProviderSig((s) => `${s}-hist`);
                  refresh();
                }}
                onExport={exportChat}
                onClear={clearMessages}
                onClose={() => setShowSettings(false)}
              />
            )}

            {currentSession && showProviderPicker && (
              <ProviderPickerSheet
                prefs={currentSession.prefs}
                providers={providers}
                onSelect={(pid) => {
                  updatePrefs({ providerId: pid });
                  setShowProviderPicker(false);
                }}
                onProviderAdded={() => setProviderSig((s) => `${s}-added`)}
                onClose={() => setShowProviderPicker(false)}
              />
            )}
          </>
        );
      })()}

      {showHistory && (
        <HistorySheet
          sessions={sessions}
          memory={memoryChats}
          activeId={activeId}
          onOpen={openSession}
          onNew={newChat}
          onDelete={removeSession}
          onOpenMemory={openMemoryChat}
          onClose={() => setShowHistory(false)}
        />
      )}

      {memoryPrompt && (
        <MemoryPromptSheet
          title={memoryPrompt.title}
          onCopy={() => {
            const { sessionId, onConfirm } = memoryPrompt;
            setMemoryPrompt(null);
            const ok = container.chat.archiveSessionToMemory(sessionId);
            refresh();
            if (ok) {
              hapticSuccess();
              setNotice('Chat memory me copy ho gayi — ab dobara store nahi hogi');
            } else {
              hapticError();
              setNotice('Chat memory me copy nahi ho payi');
            }
            onConfirm();
          }}
          onSkip={() => {
            const { onConfirm } = memoryPrompt;
            setMemoryPrompt(null);
            onConfirm();
          }}
        />
      )}

      {showMemoryChatId !== null && (
        <ReadOnlyChatViewer initialId={showMemoryChatId} onClose={() => setShowMemoryChatId(null)} />
      )}

      {showAttach && <AttachmentSheet onPick={attachTool} onClose={() => setShowAttach(false)} />}
      {showVaultPicker && <VaultPickerModal onSelect={handleAttachVaultResource} onClose={() => setShowVaultPicker(false)} />}

      {menu && (
        <MessageMenu
          menuRef={menuRef}
          message={menu.message}
          position={{ x: menu.x, y: menu.y }}
          isLast={menu.message.id === active?.messages[active.messages.length - 1]?.id}
          onClose={() => setMenu(null)}
          onCopy={(m) => void copyMessage(m)}
          onEdit={editMessage}
          onRegenerate={regenerate}
          onDelete={deleteMessage}
          onDownload={downloadMessage}
          onShare={(m) => shareMessage(m)}
        />
      )}

      {/* Live Voice & Multimodal Overlays */}
      <LivePermissionModal
        isOpen={showLivePermission}
        onClose={() => setShowLivePermission(false)}
        onProceed={handlePermissionProceed}
        defaultAudioRoute={liveConfig.defaultAudioRoute}
      />

      {showLiveOverlay && liveMicStream && (
        <LiveCompanionOverlay
          isOpen={showLiveOverlay}
          onClose={handleLiveOverlayClose}
          apiKey={getGeminiLiveApiKey()}
          systemPrompt={active?.prefs.systemPrompt || ''}
          userPersona={active?.prefs.userPersona || ''}
          memoryContext={
            [
              container.store.get().memory.entries.length > 0
                ? `[PERSISTENT USER MEMORIES]:\n${container.store.get().memory.entries.map((e) => `- ${e.content}`).join('\n')}`
                : '',
              container.chat.getJourneyContext()
                ? `[LIVE JOURNEY CONTEXT]:\n${container.chat.getJourneyContext()}`
                : '',
              buildLiveCallOverview()
                ? `[LIVE CALL HISTORY]:\n${buildLiveCallOverview()}`
                : '',
            ]
              .filter(Boolean)
              .join('\n\n')
          }
          initialMicStream={liveMicStream}
          initialCameraStream={liveCamStream || undefined}
          initialMessages={(() => {
            const all = active?.messages || [];
            const historyLen = container.store.get().aiSettings?.chat?.conversationHistoryLength;
            // 0 = full history (chat jaisa), par live me cap 25
            const limit = historyLen === 0 ? 25 : Math.min(historyLen ?? 15, 25);
            return all.slice(-limit);
          })()}
          toolCatalog={toolCatalog}
          endLiveCallRef={endLiveCallRef}
          config={{
            ...liveConfig,
            baseUrl: getLiveBaseUrl(),
            enable90DayTrack: container.store.get().enable90DayTrack !== false,
            timeZone: container.store.get().timeZone ?? deviceTimeZone(),
          }}
          onUpdateConfig={handleUpdateLiveConfig}
          onExecuteTool={handleExecuteLiveTool}
          onTranscriptUpdate={handleLiveTranscriptUpdate}
          incomingCallMeta={liveIncomingMeta}
          audioFocusAlreadyGranted={liveAudioFocusGranted}
        />
      )}
    </div>
  );
}

/* =====================================================================
   Empty chat — logo, greeting, prompt suggestions
   ===================================================================== */

function EmptyChat({ onPick }: { onPick: (prompt: string) => void }) {
  return (
    <div className="flex min-h-full flex-col items-center justify-center px-4 pb-12 text-center">
      <span
        className="flex h-16 w-16 items-center justify-center rounded-3xl"
        style={{
          background: 'linear-gradient(145deg, rgba(227,69,48,0.22), rgba(239,233,223,0.1))',
          border: '1px solid rgba(227,69,48,0.35)',
          boxShadow: '0 0 42px -10px rgba(227,69,48,0.4)',
        }}
      >
        <Sparkles size={30} color="var(--color-danger)" />
      </span>
      <h2 className="mt-5 font-display text-2xl font-bold tracking-tight">{greeting()}! I’m Misa</h2>
      <p className="mt-1 max-w-sm text-sm leading-relaxed text-muted">JEE doubts, maths & notes — sab yahan, tension mat lo.</p>
      <div className="no-scrollbar mt-6 flex w-full gap-2 overflow-x-auto pb-1">
        {SUGGESTIONS.map((s) => (
          <button
            key={s.label}
            type="button"
            onClick={() => {
              haptic();
              onPick(s.prompt);
            }}
            className="filter-chip shrink-0"
          >
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

/* =====================================================================
   Messages
   ===================================================================== */

interface MessageActions {
  onMenu: (pos: { clientX: number; clientY: number }, m: ChatMessage) => void;
  onCopy: (m: ChatMessage) => void;
  onEdit: (m: ChatMessage) => void;
  onRegenerate: () => void;
  onDelete: (m: ChatMessage) => void;
  onDownload: (m: ChatMessage) => void;
  onShare: (m: ChatMessage) => void;
  onConfirmAction: (m: ChatMessage, confirmed: boolean) => void;
  onStartLiveCall?: (reason?: string) => void;
}

function DeletedBubble({ isUser }: { isUser: boolean }) {
  return (
    <div className={`flex w-full mb-3 ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-2xl border border-white/5 bg-white/5 text-xs italic text-slate-400 select-none">
        <Ban size={13} className="opacity-70 text-slate-400" />
        <span>This message was deleted</span>
      </div>
    </div>
  );
}

function CallEventCard({ message, actions }: { message: ChatMessage; actions: MessageActions }) {
  const isAccepted = message.callStatus === 'accepted';
  return (
    <div className="flex w-full justify-center my-3">
      <div className="w-full max-w-sm flex items-center justify-between gap-3 px-4 py-2.5 rounded-2xl border border-white/10 bg-panel/90 backdrop-blur-md shadow-md text-xs">
        <div className="flex items-center gap-2.5">
          <div className={`p-2 rounded-full ${isAccepted ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'}`}>
            {isAccepted ? <PhoneCall size={15} /> : <PhoneOff size={15} />}
          </div>
          <div>
            <p className="font-semibold text-slate-200">{message.content}</p>
            <p className="text-[10px] text-slate-400">
              {new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              {message.callDurationSec ? ` · ${Math.floor(message.callDurationSec / 60)}m ${message.callDurationSec % 60}s` : ''}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => {
            if (actions?.onStartLiveCall) {
              actions.onStartLiveCall('Callback from chat');
            }
          }}
          className="px-3 py-1.5 rounded-xl bg-primary/20 hover:bg-primary/30 active:scale-95 text-primary text-xs font-semibold flex items-center gap-1.5 transition-all"
        >
          <Phone size={13} />
          <span>Call Back</span>
        </button>
      </div>
    </div>
  );
}

const MessageBubble = memo(function MessageBubble(props: {
  message: ChatMessage;
  isLast: boolean;
  showThinking?: boolean;
  reveal?: boolean;
  revealSchedule?: RevealSchedule | null;
  streaming?: boolean;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  onRevealDone?: () => void;
  actionsRef: React.RefObject<MessageActions>;
}) {
  if (props.message.isDeleted) {
    return <DeletedBubble isUser={props.message.role === 'user'} />;
  }
  if (props.message.isCallEvent) {
    return <CallEventCard message={props.message} actions={props.actionsRef.current} />;
  }
  return <StandardMessageBubble {...props} />;
});

const StandardMessageBubble = memo(function StandardMessageBubble({
  message,
  isLast: _isLast,
  showThinking,
  reveal = false,
  revealSchedule,
  streaming = false,
  scrollRef,
  onRevealDone,
  actionsRef,
}: {
  message: ChatMessage;
  isLast: boolean;
  showThinking?: boolean;
  reveal?: boolean;
  revealSchedule?: RevealSchedule | null;
  streaming?: boolean;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  onRevealDone?: () => void;
  actionsRef: React.RefObject<MessageActions>;
}) {
  // Latest action callbacks from the parent — the ref identity is stable, so
  // React.memo still skips re-rendering this bubble on unrelated state changes
  // (e.g. typing in the composer).
  const actions = actionsRef.current;
  const isUser = message.role === 'user';

  const holdTimer = useRef<number | null>(null);
  const firedRef = useRef(false);
  const doc = useMemo(() => (isUser ? null : detectFileDoc(message.content)), [isUser, message.content]);
  const [showPreview, setShowPreview] = useState(true);
  // An AI reply is shown as several short bubbles, one per paragraph break.
  const bubbleTexts = useMemo(() => (isUser ? [] : splitReplyIntoBubbles(message.content)), [isUser, message.content]);
  // Fresh replies reveal their bubbles like a person sending short messages:
  // a fixed 3s thinking pause with dots, the first paragraph, then a random
  // 3-8s thinking pause before every next paragraph (no repeating pattern).
  // Reopened chats skip this entirely. The freshly generated reply carries the
  // SAME schedule used to delay its notification (revealSchedule), so both stay
  // perfectly in sync; everything else falls back to its own schedule.
  const schedule = useMemo(
    () => revealSchedule ?? computeRevealSchedule(bubbleTexts.length),
    [revealSchedule, bubbleTexts.length],
  );
  const [revealed, setRevealed] = useState(0);
  const [thinking, setThinking] = useState(() => reveal && bubbleTexts.length > 0);
  const onRevealDoneRef = useRef(onRevealDone);
  onRevealDoneRef.current = onRevealDone;
  const msgRef = useRef<HTMLDivElement | null>(null);

  // If a reply has no visible bubbles (e.g. the model replied with only
  // whitespace), don't leave reveal stuck — finish it immediately.
  useEffect(() => {
    if (reveal && !isUser && bubbleTexts.length === 0) {
      onRevealDoneRef.current?.();
    }
  }, [reveal, isUser, bubbleTexts.length]);

  useEffect(() => {
    if (!reveal || isUser || bubbleTexts.length === 0) return;
    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const wait = (ms: number, fn: () => void) => {
      if (cancelled) return;
      timers.push(setTimeout(fn, ms));
    };
    const showBubble = (i: number) => {
      if (cancelled) return;
      setThinking(false);
      setRevealed(i + 1);
      if (i + 1 >= bubbleTexts.length) {
        onRevealDoneRef.current?.();
        return;
      }
      // Thinking pause before the next paragraph: dots for a random 3-8s.
      setThinking(true);
      wait(schedule.gapDelays[i] ?? BUBBLE_GAP_MIN_MS + Math.random() * BUBBLE_GAP_RANDOM_MS, () => showBubble(i + 1));
    };
    // After the reply is collected, Misa "thinks" for a fixed 3s before her
    // first paragraph lands.
    setThinking(true);
    wait(schedule.firstDelay, () => showBubble(0));
    return () => {
      cancelled = true;
      for (const t of timers) clearTimeout(t);
    };
  }, [reveal, isUser, bubbleTexts.length, schedule]);

  // Keep the freshly revealed message in view as its bubbles grow. Never use
  // scrollIntoView here: when .chat-thread can't scroll enough (short chat),
  // the browser falls back to scrolling the PAGE, which drags the whole
  // topbar + composer up and down with the screen. Scroll the thread only.
  useEffect(() => {
    if (!reveal) return;
    const thread = scrollRef.current;
    const msg = msgRef.current;
    if (!thread || !msg) return;
    const threadRect = thread.getBoundingClientRect();
    const msgRect = msg.getBoundingClientRect();
    if (msgRect.top >= threadRect.top && msgRect.bottom <= threadRect.bottom) return;
    thread.scrollTo({ top: msg.offsetTop - thread.offsetTop - 12, behavior: 'smooth' });
  }, [revealed, thinking, reveal, scrollRef]);

  const visibleBubbleTexts = reveal ? bubbleTexts.slice(0, revealed) : bubbleTexts;
  const isFullyRevealed = !reveal || (!thinking && revealed >= bubbleTexts.length);

  function triggerMenu(clientX: number, clientY: number) {
    haptic(20);
    actions.onMenu({ clientX, clientY }, message);
  }

  return (
    <motion.div
      ref={msgRef}
      className={`mb-4 flex items-end gap-2 ${isUser ? 'justify-end' : 'justify-start'}`}
      initial={{ opacity: 0, y: 12, scale: 0.99 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ type: 'spring', stiffness: 420, damping: 34, mass: 0.9 }}
      onContextMenu={(e) => {
        e.preventDefault();
        if (!firedRef.current) triggerMenu(e.clientX, e.clientY);
      }}
      onPointerDown={(e) => {
        if (e.pointerType !== 'touch') return;
        firedRef.current = false;
        holdTimer.current = window.setTimeout(() => {
          firedRef.current = true;
          triggerMenu(e.clientX, e.clientY);
        }, 450);
      }}
      onPointerUp={() => {
        if (holdTimer.current) {
          window.clearTimeout(holdTimer.current);
          holdTimer.current = null;
        }
      }}
      onPointerMove={() => {
        if (holdTimer.current) {
          window.clearTimeout(holdTimer.current);
          holdTimer.current = null;
        }
      }}
      onPointerLeave={() => {
        if (holdTimer.current) {
          window.clearTimeout(holdTimer.current);
          holdTimer.current = null;
        }
      }}
    >
      <MoreButton
        label={`Open actions for message ${isUser ? 'sent' : 'received'}`}
        onOpen={(r) => actions.onMenu({ clientX: r.right, clientY: r.bottom }, message)}
      />
      {isUser ? (
        <div className="message-card relative rounded-3xl rounded-br-lg px-4 py-3 text-[13.5px] leading-relaxed bubble-user">
          <UserMessageContent content={message.content} attachments={message.attachments} />
          {/* Edit / Copy / Delete live in the long-press (or right-click)
              menu — see triggerMenu/MessageMenu below — so the bubble stays
              clean instead of showing an always-on action row. */}
          {message.stopped && (
            <div className="mt-2 flex items-center justify-end">
              <span className="rounded bg-black/20 px-1.5 py-0.5 text-[9px]">stopped</span>
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-col items-start gap-1.5">
          {(message.reasoning && showThinking !== false) || message.tool || (message.toolCalls && message.toolCalls.length > 0) ? (
            <div className="message-card relative rounded-3xl rounded-bl-lg px-4 py-3 text-[13.5px] leading-relaxed bubble-ai">
              {message.reasoning && showThinking !== false && <ThinkingBlock text={message.reasoning} streaming={streaming} />}
              {message.toolCalls && message.toolCalls.length > 0 ? (
                <ToolCallsBlock calls={message.toolCalls} />
              ) : (
                message.tool && <ToolBadge tool={message.tool} />
              )}
            </div>
          ) : null}
          {doc && (
            <div className="message-card relative rounded-3xl rounded-bl-lg px-4 py-3 text-[13.5px] leading-relaxed bubble-ai">
              <FileCard
                name={doc.name}
                sizeLabel={doc.sizeLabel}
                preview={showPreview}
                onTogglePreview={() => {
                  haptic();
                  setShowPreview((v) => !v);
                }}
                onDownload={() => actions.onDownload(message)}
              />
            </div>
          )}
          {(!doc || showPreview) &&
            visibleBubbleTexts.map((seg, i) => (
              <div
                key={i}
                className="message-card relative rounded-3xl rounded-bl-lg px-4 py-3 text-[13.5px] leading-relaxed bubble-ai"
              >
                {streaming ? (
                  <StreamingText text={seg} />
                ) : (
                  <div className="markdown-body">
                    <ChatMarkdown text={seg} />
                  </div>
                )}
              </div>
            ))}
          {reveal && thinking && (
            <div className="bubble-ai flex items-center gap-2.5 rounded-2xl rounded-bl-md px-4 py-3">
              <span className="typing-dots" aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
            </div>
          )}
          {message.pendingConfirmation && isFullyRevealed && (
            <div className="flex gap-2 pl-1 pt-1">
              <button
                type="button"
                className="rounded-full bg-red-600 px-4 py-1.5 text-[12.5px] font-medium text-white shadow-md active:opacity-70"
                onClick={() => {
                  haptic();
                  actions.onConfirmAction(message, true);
                }}
              >
                Haan, karo
              </button>
              <button
                type="button"
                className="rounded-full border border-white/15 bg-surface-2 px-4 py-1.5 text-[12.5px] font-medium text-muted hover:text-text active:opacity-70"
                onClick={() => {
                  haptic();
                  actions.onConfirmAction(message, false);
                }}
              >
                Nahi, rehne do
              </button>
            </div>
          )}
          {/* Copy / Regenerate / Download live in the long-press (or
              right-click) menu — see triggerMenu/MessageMenu below — so the
              bubble only shows status, not an always-on action row. */}
          <div className="mt-1.5 flex items-center gap-1 pl-1">
            {message.stopped && (
              <span className="rounded bg-surface-3 px-1.5 py-0.5 text-[9px] text-muted">stopped</span>
            )}
            <Check size={11} color="var(--color-success)" />
          </div>
        </div>
      )}
    </motion.div>
  );
});

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

/**
 * Collapsible "thinking"-style block for executed tool calls. Collapsed by
 * default — click to reveal each tool as a readable result message, never raw
 * JSON.
 */
function ToolCallsBlock({ calls }: { calls: ChatToolCallRecord[] }) {
  const [open, setOpen] = useState(false);
  const requiresConfirmCount = calls.filter(
    (c) => !c.ok && (c.requiresConfirmation || /confirmation/i.test(c.message || '')),
  ).length;
  const genuineFailCount = calls.filter(
    (c) => !c.ok && !c.requiresConfirmation && !/confirmation/i.test(c.message || ''),
  ).length;

  return (
    <div className="mb-2 overflow-hidden rounded-xl border border-peak/25 bg-peak/8 shadow-xs">
      <button
        type="button"
        onClick={() => {
          haptic();
          setOpen((v) => !v);
        }}
        className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-[11px] font-semibold text-muted transition-colors hover:text-text"
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <Wrench size={12} className="shrink-0 text-peak" />
          <span className="truncate">
            {calls.length} tool{calls.length > 1 ? 's' : ''} use kiye
            {genuineFailCount > 0
              ? ` — ${genuineFailCount} fail`
              : requiresConfirmCount > 0
                ? ' — confirmation chahiye'
                : ''}
          </span>
        </span>
        <ChevronDown size={12} className={`shrink-0 text-muted transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="max-h-72 overflow-y-auto border-t border-peak/15 px-3 py-2.5 text-[11.5px] leading-relaxed">
          {calls.map((c, i) => {
            const isConfirm = !c.ok && (c.requiresConfirmation || /confirmation/i.test(c.message || ''));
            const statusIcon = c.ok ? '✅' : isConfirm ? '⏳' : '❌';
            return (
              <div key={i} className="mb-2 last:mb-0">
                <div className="flex items-center gap-1.5 font-semibold text-text">
                  <span className="shrink-0 text-xs">{statusIcon}</span>
                  <span className="truncate">{TOOL_LABELS[c.action] ?? c.action}</span>
                  {isConfirm && (
                    <span className="ml-auto rounded-full bg-amber-500/15 border border-amber-500/30 px-1.5 py-0.5 text-[9px] font-semibold text-amber-400">
                      Approval Needed
                    </span>
                  )}
                </div>
                <div className="mt-1 pl-4.5 text-muted text-xs markdown-body">
                  <ChatMarkdown text={c.message || ''} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ToolBadge({ tool }: { tool: string }) {
  const tools = tool.split(',').map((t) => t.trim()).filter(Boolean);
  if (tools.length === 0) return null;
  return (
    <div className="mb-1.5 flex flex-wrap items-center gap-1" aria-label={`Tools used: ${tools.join(', ')}`}>
      {tools.map((t) => (
        <span
          key={t}
          className="inline-flex items-center gap-1 rounded-full border border-peak/20 bg-peak/8 px-2 py-0.5 text-[10px] font-medium leading-tight text-peak"
        >
          <Wrench size={10} className="shrink-0 opacity-70" />
          {TOOL_LABELS[t] ?? t}
        </span>
      ))}
    </div>
  );
}

/* =====================================================================
   Attachments
   ===================================================================== */

function ToolChip({ id, catalog, onRemove }: { id: string; catalog: ChatToolMeta[]; onRemove: () => void }) {
  const tool = catalog.find((t) => t.id === id);
  return (
    <div className="flex min-w-0 shrink-0 items-center gap-1.5 rounded-xl border border-l/35 bg-l/10 px-2 py-1.5">
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

function AttachmentChip({ attachment, onRemove }: { attachment: DraftAttachment; onRemove: () => void }) {
  const isImage = attachment.kind === 'image';
  const kind = fileKindOf(attachment.name, attachment.type);
  return (
    <div className="flex min-w-0 shrink-0 items-center gap-2 rounded-xl border border-border bg-bg px-2 py-1.5">
      {isImage && attachment.previewUrl ? (
        <img src={attachment.previewUrl} alt="" className="h-9 w-9 rounded-lg object-cover" />
      ) : (
        <FileKindBadge name={attachment.name} mimeType={attachment.type} />
      )}
      <div className="min-w-0 max-w-28">
        <p className="truncate text-[10px] font-semibold leading-tight text-text">{shortFileName(attachment.name)}</p>
        <p className="text-[9px] text-muted">
          {kind.ext} · {formatBytes(attachment.size)}
        </p>
      </div>
      <button type="button" onClick={onRemove} className="rounded-full p-0.5 text-muted hover:bg-danger/10 hover:text-danger" aria-label="Remove attachment">
        <X size={11} />
      </button>
    </div>
  );
}

/**
 * Image thumbnail with a graceful dead-blob fallback (N5). Blob `previewUrl`s
 * are session-scoped, so a message restored from storage after an app reload
 * points at a URL that no longer resolves. Instead of rendering a broken
 * <img>, the chip swaps to the type badge on load error.
 */
function ImageThumb({ src, name, mimeType, className }: { src: string; name: string; mimeType?: string; className: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <FileKindBadge name={name} mimeType={mimeType} size="sm" />;
  return <img src={src} alt="" className={className} onError={() => setFailed(true)} />;
}

/* =====================================================================
   Sheets
   ===================================================================== */

function Sheet({
  open,
  onClose,
  title,
  icon,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  if (!open) return null;
  return (
    <>
      <div className="sheet-backdrop" onClick={onClose} aria-hidden="true" />
      <div role="dialog" aria-modal="true" aria-label={title} className="sheet">
        <div className="sheet-handle" aria-hidden="true" />
        <div className="flex items-center justify-between px-5 pb-2 pt-1">
          <h2 className="flex items-center gap-2 font-display text-base font-bold">
            <span className="text-l">{icon}</span>
            {title}
          </h2>
          <button type="button" onClick={onClose} className="icon-btn" aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="sheet-scroll px-5 pb-[calc(1.5rem_+_env(safe-area-inset-bottom,0px))]">
          {children}
        </div>
      </div>
    </>
  );
}

function SettingsSheet({
  prefs,
  providers,
  catalog,
  onChange,
  onReset,
  onLoadCatalog,
  onOpenProviderPicker,
  onProviderAdded,
  onHistoryChanged,
  onExport,
  onClear,
  onClose,
}: {
  prefs: ChatPreferences;
  providers: Array<{ id: string; label: string; enabled?: boolean; models?: string[]; model?: string }>;
  catalog: ModelInfo[];
  onChange: (patch: Partial<ChatPreferences>) => void;
  onReset: () => void;
  onLoadCatalog: () => void;
  onOpenProviderPicker: () => void;
  onProviderAdded: () => void;
  onHistoryChanged: () => void;
  onExport: () => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const providerLabel = providers.find((p) => p.id === prefs.providerId)?.label ?? 'App default';
  const presetModels = (() => {
    const provider = providers.find((p) => p.id === prefs.providerId);
    return [...new Set([...(provider?.models ?? []), ...(provider?.model ? [provider.model] : [])])];
  })();
  return (
    <Sheet open onClose={onClose} title="Chat settings" icon={<Settings2 size={16} />}>
      <div className="space-y-6 pb-2">
        {/* Model */}
        <section>
          <p className="section-label mb-2">Model</p>
          <div className="overflow-hidden rounded-2xl border border-border bg-panel">
            <button
              type="button"
              onClick={onOpenProviderPicker}
              className="group flex w-full items-center justify-between px-4 py-3.5 text-sm transition-colors hover:bg-panel-raised active:bg-panel-raised"
            >
              <span className="text-muted">Provider</span>
              <span className="flex items-center gap-1 font-semibold text-text">
                {providerLabel}
                <ChevronRight size={14} className="text-muted transition-transform group-active:translate-x-0.5" />
              </span>
            </button>
            <div className="border-t border-border/70 px-4 py-3.5">
              {presetModels.length > 1 && (
                <div className="mb-3">
                  <span className="field-label">Quick pick</span>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {presetModels.map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => onChange({ model: prefs.model === m ? null : m })}
                        className="filter-chip"
                        aria-pressed={prefs.model === m}
                      >
                        {m}
                      </button>
                    ))}
                  </div>
                  <span className="mt-1.5 block text-[11px] leading-snug text-muted-dim">
                    Default: {presetModels[0]} — tap karke badlo.
                  </span>
                </div>
              )}
              <label className="field-label flex items-center justify-between">
                <span>Model override</span>
                <button type="button" onClick={onLoadCatalog} className="font-normal text-muted underline-offset-2 hover:text-text hover:underline">
                  catalog dikhao
                </button>
              </label>
              <input
                list="chat-model-catalog"
                value={prefs.model ?? ''}
                onChange={(e) => onChange({ model: e.target.value || null })}
                placeholder="Khaali = provider default"
                className="field"
              />
              <datalist id="chat-model-catalog">
                {catalog.map((m) => (
                  <option key={m.id} value={m.id} />
                ))}
                {presetModels.map((m) => (
                  <option key={`preset-${m}`} value={m} />
                ))}
              </datalist>
            </div>
          </div>
          <div className="mt-2">
            <AddProviderForm
              onAdd={(config) => {
                container.providerSettings.upsertProvider(config);
                onProviderAdded();
              }}
            />
          </div>
        </section>

        {/* AI activity */}
        <AiActivityPanel onHistoryChanged={onHistoryChanged} />

        {/* Actions */}
        <section>
          <p className="section-label mb-2">Actions</p>
          <div className="divide-y divide-border/70 overflow-hidden rounded-2xl border border-border bg-panel">
            <ActionRow icon={<Download size={15} />} label="Export chat (.md)" onClick={onExport} />
            <ActionRow icon={<Eraser size={15} />} label="Chat clear karo" onClick={onClear} />
            <ActionRow icon={<Settings2 size={15} />} label="Settings reset karo" onClick={onReset} />
          </div>
        </section>
      </div>
    </Sheet>
  );
}

function globalChatPrefs(): ChatPreferences {
  const global = container.store.get().aiSettings.chat;
  return {
    ...defaultChatPrefs(),
    temperature: global.temperature,
    maxTokens: global.maxTokens,
    systemPrompt: global.systemPrompt,
    userPersona: global.userPersona,
    includeContext: global.includeJourneyContext,
    ...(global.thinking ? { thinking: global.thinking } : {}),
  };
}

function ActionRow({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={() => {
        haptic();
        onClick();
      }}
      className="flex w-full items-center gap-2.5 px-4 py-3 text-sm font-medium text-text transition-colors hover:bg-panel-raised active:bg-panel-raised"
    >
      <span className="text-muted">{icon}</span>
      {label}
    </button>
  );
}

function ProviderPickerSheet({
  prefs,
  providers,
  onSelect,
  onProviderAdded,
  onClose,
}: {
  prefs: ChatPreferences;
  providers: Array<{ id: string; label: string; enabled?: boolean; models?: string[]; model?: string }>;
  onSelect: (pid: string | null) => void;
  onProviderAdded: () => void;
  onClose: () => void;
}) {
  return (
    <Sheet open onClose={onClose} title="Provider" icon={<Settings2 size={16} />}>
      <div className="space-y-1.5 pb-2">
        <button
          type="button"
          onClick={() => onSelect(null)}
          className={`flex w-full items-center justify-between rounded-xl border px-3.5 py-3 text-sm transition-colors ${
            !prefs.providerId ? 'border-l/50 bg-l/10 text-text' : 'border-border bg-panel text-muted'
          }`}
        >
          <span>App default (active provider)</span>
          {!prefs.providerId && <Check size={15} color="var(--color-l)" />}
        </button>
        {providers.map((p) => {
          const isActive = prefs.providerId === p.id;
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => onSelect(p.id)}
              className={`flex w-full items-center justify-between rounded-xl border px-3.5 py-3 text-sm transition-colors ${
                isActive ? 'border-l/50 bg-l/10 text-text' : 'border-border bg-panel text-muted'
              }`}
            >
              <span className="flex items-center gap-2">
                {p.label}
                {p.enabled === false && <span className="text-[10px] text-muted">(off)</span>}
              </span>
              {isActive && <Check size={15} color="var(--color-l)" />}
            </button>
          );
        })}
        <div className="pt-1">
          <AddProviderForm
            onAdd={(config) => {
              container.providerSettings.upsertProvider(config);
              onProviderAdded();
            }}
          />
        </div>
      </div>
    </Sheet>
  );
}

function HistorySheet({
  sessions,
  memory,
  activeId,
  onOpen,
  onNew,
  onDelete,
  onOpenMemory,
  onClose,
}: {
  sessions: ChatSession[];
  memory: ArchivedConversation[];
  activeId: string | null;
  onOpen: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onOpenMemory: (sessionId: string) => void;
  onClose: () => void;
}) {
  return (
    <Sheet open onClose={onClose} title="Chats" icon={<MessageSquareText size={16} />}>
      <div className="space-y-1.5 pb-2">
        <button
          type="button"
          onClick={onNew}
          className="mb-1 flex w-full items-center gap-2.5 rounded-xl border border-dashed border-l/40 bg-l/10 px-3.5 py-3 text-sm font-semibold text-l transition-colors hover:bg-l/15"
        >
          <MessageSquarePlus size={15} />
          Naya chat
        </button>
        {sessions.length === 0 && memory.length === 0 && (
          <p className="px-1 py-4 text-center text-sm text-muted">Abhi koi chat nahi hai.</p>
        )}
        {sessions.map((s) => {
          const isActive = s.id === activeId;
          return (
            <div
              key={s.id}
              className={`flex items-center gap-2 rounded-xl border px-3 py-2.5 transition-colors ${
                isActive ? 'border-l/50 bg-l/10' : 'border-border bg-panel'
              }`}
            >
              <button
                type="button"
                onClick={() => {
                  onOpen(s.id);
                  onClose();
                }}
                className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left"
              >
                <span className="w-full truncate text-sm font-semibold text-text">{s.title || 'Naya chat'}</span>
                <span className="text-[10px] text-muted">
                  {s.messages.length} messages · {timeAgo(s.updatedAt)}
                  {s.aiSummarizedAt ? ' · memory me summarized' : ''}
                </span>
              </button>
              <button
                type="button"
                onClick={() => {
                  haptic();
                  onDelete(s.id);
                }}
                className="icon-btn shrink-0 !min-w-8 !min-h-8 rounded-lg text-muted hover:bg-danger/10 hover:text-danger"
                aria-label="Delete chat"
              >
                <Trash2 size={14} />
              </button>
            </div>
          );
        })}

        {memory.length > 0 && (
          <>
            <p className="px-1 pt-2.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
              Memory se purani chats · read-only
            </p>
            {memory.map((c) => (
              <button
                key={c.sessionId}
                type="button"
                onClick={() => onOpenMemory(c.sessionId)}
                className="flex w-full items-center gap-2 rounded-xl border border-border bg-panel px-3 py-2.5 text-left transition-colors hover:bg-panel-raised active:bg-panel-raised"
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-l/10 text-l">
                  <Archive size={13} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-text">{c.title || 'Memory chat'}</span>
                  <span className="block text-[10px] text-muted">
                    {c.messages.length} messages · {timeAgo(c.updatedAt)} ·{' '}
                    {c.source === 'ai-summary' ? 'AI summarized' : 'archived'}
                  </span>
                </span>
                <ChevronRight size={14} className="shrink-0 text-muted" />
              </button>
            ))}
          </>
        )}
      </div>
    </Sheet>
  );
}

function VaultPickerModal({ onSelect, onClose }: { onSelect: (res: StudyResource) => void; onClose: () => void }) {
  const state = container.store.get();
  const resources: StudyResource[] = state.studyVault ?? [];
  const [selectedSubject, setSelectedSubject] = useState<VaultSubject | 'all'>('all');
  const [search, setSearch] = useState('');

  const subjects: { id: VaultSubject | 'all'; label: string; color: string }[] = [
    { id: 'all', label: 'All Files', color: 'text-stone-300 bg-stone-500/10 border-stone-500/20' },
    { id: 'physics', label: 'Physics', color: 'text-blue-400 bg-blue-500/10 border-blue-500/20' },
    { id: 'chemistry', label: 'Chemistry', color: 'text-purple-400 bg-purple-500/10 border-purple-500/20' },
    { id: 'maths', label: 'Maths', color: 'text-cyan-400 bg-cyan-500/10 border-cyan-500/20' },
    { id: 'formula', label: 'Formula Sheets', color: 'text-amber-400 bg-amber-500/10 border-amber-500/20' },
    { id: 'general', label: 'General / DPPs', color: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20' },
  ];

  const filtered = resources.filter((r) => {
    const matchesSubject = selectedSubject === 'all' || r.subject === selectedSubject;
    const matchesSearch =
      !search.trim() ||
      r.title.toLowerCase().includes(search.toLowerCase()) ||
      r.fileName.toLowerCase().includes(search.toLowerCase());
    return matchesSubject && matchesSearch;
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm fade-in">
      <div className="card w-full max-w-lg p-5 space-y-3.5 border-l/40 bg-panel-raised shadow-2xl max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between border-b border-border/60 pb-3">
          <div className="flex items-center gap-2">
            <FolderArchive size={18} className="text-l" />
            <div>
              <h3 className="font-display text-sm font-bold text-text">Study Resource Vault</h3>
              <p className="text-[11px] text-muted">AI ko analyze karwane ke liye koi bhi file attach karo</p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="icon-btn" aria-label="Close">
            <X size={16} />
          </button>
        </div>

        {/* Subjects Filter */}
        <div className="flex flex-wrap gap-1.5 pt-1">
          {subjects.map((s) => {
            const count = s.id === 'all' ? resources.length : resources.filter((r) => r.subject === s.id).length;
            const active = selectedSubject === s.id;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => {
                  haptic(4);
                  setSelectedSubject(s.id);
                }}
                className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-all ${
                  active ? 'border-l bg-l/15 text-light font-bold' : 'border-border/50 bg-panel/50 text-muted hover:border-border'
                }`}
              >
                {s.label} ({count})
              </button>
            );
          })}
        </div>

        {/* Search */}
        {resources.length > 0 && (
          <div className="relative">
            <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <input
              type="text"
              className="field pl-8 text-xs py-1.5"
              placeholder="Search in vault..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        )}

        {/* List */}
        <div className="flex-1 overflow-y-auto space-y-2 pr-1 min-h-[150px]">
          {filtered.length === 0 ? (
            <div className="p-6 text-center text-muted space-y-2">
              <HardDrive size={24} className="mx-auto text-muted-dim" />
              <p className="text-xs font-semibold text-text">
                {resources.length === 0 ? 'Study Vault mein koi file nahi hai.' : 'Koi matching file nahi mili.'}
              </p>
              <p className="text-[11px] text-muted">
                {resources.length === 0
                  ? 'Planners tab me ja kar pehle Study Vault me PDFs ya Notes upload karo.'
                  : 'Dusra keyword search karo ya filter badlo.'}
              </p>
            </div>
          ) : (
            filtered.map((res) => {
              const subj = subjects.find((s) => s.id === res.subject) || subjects[5];
              return (
                <div
                  key={res.id}
                  className="card flex items-center justify-between gap-3 p-3 bg-panel/75 hover:border-border-strong transition-all"
                >
                  <div className="flex min-w-0 items-center gap-2.5">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white/5 border border-border/50 text-l">
                      <FileText size={16} />
                    </div>
                    <div className="min-w-0">
                      <p className="font-display text-xs font-semibold text-text truncate">{res.title}</p>
                      <div className="flex items-center gap-1.5 text-[10px] text-muted mt-0.5">
                        <span className={`inline-flex rounded border px-1.5 py-0.1 font-medium ${subj.color}`}>
                          {subj.label}
                        </span>
                        <span>·</span>
                        <span>{formatFileSize(res.fileSize)}</span>
                        <span>·</span>
                        <span className="truncate max-w-[100px]">{res.fileName}</span>
                      </div>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => onSelect(res)}
                    className="btn btn-primary min-h-8 px-3 text-xs font-bold shrink-0 gap-1"
                  >
                    <Paperclip size={12} /> Attach
                  </button>
                </div>
              );
            })
          )}
        </div>

        <div className="pt-2 border-t border-border/60 flex justify-end">
          <button type="button" onClick={onClose} className="btn btn-ghost text-xs">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function AttachmentSheet({ onPick, onClose }: { onPick: (id: string) => void; onClose: () => void }) {
  return (
    <Sheet open onClose={onClose} title="Attach" icon={<Paperclip size={16} />}>
      <div className="grid grid-cols-3 gap-2.5 pb-2">
        {ATTACH_TOOLS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => onPick(t.id)}
            className="flex flex-col items-center gap-1.5 rounded-2xl border border-border bg-panel px-2 py-4 text-center transition-all hover:border-l/50 active:scale-[0.96]"
          >
            <span
              className="flex h-11 w-11 items-center justify-center rounded-xl"
              style={{ background: 'rgba(163,19,19,0.12)', color: 'var(--color-l)' }}
            >
              {t.icon}
            </span>
            <span className="text-[11px] font-semibold leading-tight text-text">{t.label}</span>
            <span className="text-[9px] leading-tight text-muted-dim">{t.hint}</span>
          </button>
        ))}
      </div>
    </Sheet>
  );
}

/**
 * Shown when the user switches away from a chat that was never copied to
 * memory. Copying keeps the chat in history AND stores a read-only transcript
 * in memory (marked once, so it is never stored again); "just switching"
 * leaves it untouched and the prompt will ask again next time.
 */
function MemoryPromptSheet({ title, onCopy, onSkip }: { title: string; onCopy: () => void; onSkip: () => void }) {
  return (
    <>
      <div className="sheet-backdrop" onClick={onSkip} aria-hidden="true" />
      <div role="dialog" aria-modal="true" aria-label="Chat ko memory me copy karein?" className="sheet">
        <div className="sheet-handle" aria-hidden="true" />
        <div className="px-5 pb-2 pt-1">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-l/10 text-l">
              <Archive size={16} />
            </span>
            <div className="min-w-0">
              <h2 className="font-display text-base font-bold leading-tight">Chat ko memory me copy karein?</h2>
              <p className="truncate text-[11px] text-muted">{title}</p>
            </div>
          </div>
        </div>
        <div className="px-5 pb-[calc(1.5rem_+_env(safe-area-inset-bottom,0px))]">
          <p className="text-[13px] leading-relaxed text-muted">
            Copy hone ke baad is chat ki memory <span className="font-semibold text-text">dobara store nahi hogi</span>.
          </p>
          <div className="mt-4 grid gap-2">
            <button type="button" onClick={onCopy} className="btn btn-primary min-h-11 w-full gap-2">
              <Archive size={15} />
              Copy to memory
            </button>
            <button type="button" onClick={onSkip} className="btn btn-ghost min-h-11 w-full">
              Sirf switch karo
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

function AiActivityPanel({ onHistoryChanged }: { onHistoryChanged: () => void }) {
  const history = container.store.get().aiActionHistory;
  const latest = history.versions.at(-1);
  const undone = history.undone.length;

  function undo() {
    container.store.save(undoLastAiAction(container.store.get()));
    onHistoryChanged();
  }

  function redo() {
    container.store.save(redoLastAiAction(container.store.get()));
    onHistoryChanged();
  }

  return (
    <section>
      <p className="section-label mb-2">AI Activity</p>
      <div className="rounded-xl border border-border bg-panel px-3.5 py-3">
        <div className="mb-1 flex items-center justify-between gap-2">
          <p className="flex items-center gap-1.5 text-xs font-semibold text-muted">
            AI Activity & Undo
            <span
              className="badge !px-1.5 !py-px !text-[10px] font-medium lowercase"
              title="Experimental — kuch AI changes ka undo supported hai"
              style={{ backgroundColor: 'rgba(155,138,168,0.16)', color: 'var(--color-tag-revision)' }}
            >
              dev
            </span>
          </p>
          <span className="font-mono text-[10px] text-light">{history.versions.length} versions</span>
        </div>
        {latest ? (
          <p className="mb-2 line-clamp-2 text-[11px] text-muted">
            Latest: {latest.summary} · {latest.status}
          </p>
        ) : (
          <p className="mb-2 text-[11px] text-muted">AI edits will appear here with 90-day version history.</p>
        )}
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={!latest} onClick={undo} className="btn btn-ghost min-h-8 px-2.5 py-1 text-xs disabled:opacity-40">
            Undo last AI change
          </button>
          <button type="button" disabled={undone === 0} onClick={redo} className="btn btn-ghost min-h-8 px-2.5 py-1 text-xs disabled:opacity-40">
            Redo ({undone})
          </button>
        </div>
      </div>
    </section>
  );
}

/* =====================================================================
   Message context menu
   ===================================================================== */

function MessageMenu({
  message,
  position,
  isLast,
  menuRef,
  onClose,
  onCopy,
  onEdit,
  onRegenerate,
  onDelete,
  onDownload,
  onShare,
}: {
  message: ChatMessage;
  position: { x: number; y: number };
  isLast: boolean;
  menuRef: React.RefObject<HTMLDivElement | null>;
  onClose: () => void;
  onCopy: (m: ChatMessage) => void;
  onEdit: (m: ChatMessage) => void;
  onRegenerate: () => void;
  onDelete: (m: ChatMessage) => void;
  onDownload: (m: ChatMessage) => void;
  onShare: (m: ChatMessage) => void;
}) {
  const isUser = message.role === 'user';
  const items: { label: string; icon: React.ReactNode; danger?: boolean; run: () => void }[] = [
    { label: 'Copy', icon: <Copy size={15} />, run: () => onCopy(message) },
    ...(isUser
      ? [{ label: 'Edit', icon: <PenLine size={15} />, run: () => onEdit(message) }]
      : [
          ...(isLast ? [{ label: 'Regenerate', icon: <RefreshCw size={15} />, run: onRegenerate }] : []),
          { label: 'Download .md', icon: <Download size={15} />, run: () => onDownload(message) },
        ]),
    ...('share' in navigator ? [{ label: 'Share', icon: <Share size={15} />, run: () => onShare(message) }] : []),
    { label: 'Delete', icon: <Trash2 size={15} />, danger: true, run: () => onDelete(message) },
  ];

  return (
    <>
      <div className="fixed inset-0 z-[59]" onClick={onClose} aria-hidden="true" />
      <div ref={menuRef} role="menu" className="ctx-menu" style={{ left: position.x, top: position.y }}>
        {items.map((item) => (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            onClick={() => {
              haptic();
              item.run();
              onClose();
            }}
            className={`ctx-item ${item.danger ? 'danger' : ''}`}
          >
            {item.icon}
            {item.label}
          </button>
        ))}
      </div>
    </>
  );
}

/* =====================================================================
   Helpers
   ===================================================================== */

async function readAttachment(file: File): Promise<DraftAttachment> {
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';

  if (file.type.startsWith('image/')) {
    // Stable content descriptor (N5/M11): the blob previewUrl never survives an
    // app restart, so without this the AI would silently lose the image's
    // context on the next turn / retry. Like files, images now carry a stable
    // text note the model can see whenever the actual bytes are gone.
    return { id: uid('att'), name: file.name, type: file.type, size: file.size, kind: 'image', previewUrl: URL.createObjectURL(file), content: `[Image: ${file.name}]` };
  }

  const isPdf = file.type === 'application/pdf' || extension === 'pdf';
  const isOffice = extension === 'docx' || extension === 'pptx' || extension === 'xlsx';

  // PDFs and Office files go straight to the model as a raw file when the
  // model accepts them; client-side text extraction only kicks in as a
  // fallback if that direct send fails.
  if (isPdf || isOffice) {
    // Pre-extract text at attach time so the fallback path AND follow-up
    // messages in the same session can still use the content: the raw file's
    // blob URL is revoked after the first send (and never survives an app
    // restart), so without this the document context would silently vanish.
    let content: string | undefined;
    try {
      const extracted = await extractFileText(file);
      if (extracted) {
        const truncated = extracted.length > MAX_TEXT_ATTACHMENT_CHARS;
        content = truncated ? `${extracted.slice(0, MAX_TEXT_ATTACHMENT_CHARS)}\n\n[Attachment truncated after ${MAX_TEXT_ATTACHMENT_CHARS} characters]` : extracted;
      }
    } catch {
      content = undefined;
    }
    return { id: uid('att'), name: file.name, type: file.type || extension || 'file', size: file.size, kind: 'file', previewUrl: URL.createObjectURL(file), content };
  }

  const raw = await extractFileText(file);
  if (raw) {
    // Note: PDFs and Office files never reach this branch — they are sent to
    // the model as raw files and only fall back to text extraction on failure
    // (inside ChatService.applyFileFallback).
    const truncated = raw.length > MAX_TEXT_ATTACHMENT_CHARS;
    const body = truncated ? `${raw.slice(0, MAX_TEXT_ATTACHMENT_CHARS)}\n\n[Attachment truncated after ${MAX_TEXT_ATTACHMENT_CHARS} characters]` : raw;
    return {
      id: uid('att'),
      name: file.name,
      type: file.type || extension || 'text',
      size: file.size,
      kind: 'text',
      content: body,
    };
  }

  return { id: uid('att'), name: file.name, type: file.type || extension || 'binary', size: file.size, kind: 'binary' };
}

function revokeAttachmentUrls(attachments: DraftAttachment[]): void {
  for (const attachment of attachments) {
    if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
  }
}

function buildPromptWithAttachments(draft: string, attachments: DraftAttachment[]): string {
  if (attachments.length === 0) return draft;
  const blocks = attachments.map((a, idx) => {
    const header = `Attachment ${idx + 1}: ${a.name} (${a.type || 'unknown'}, ${formatBytes(a.size)})`;
    if (a.kind === 'text') return `<attached_file>\n${header}\n\n${a.content ?? ''}\n</attached_file>`;
    if (a.kind === 'image') return `<attached_image>\n${header}\nUser ne ek image attach ki hai (preview UI mein visible hai). Agar tum image dekh sakte ho toh analyze karo; warna user ko text/OCR dekar likhne ko bolo.\n</attached_image>`;
    if (a.kind === 'file')
      return `<attached_file>\n${header}\nYeh file (${a.type || 'document'}) model ko direct bheji gayi hai. Agar file ka content tumhe mila ho toh use karo; agar na mile toh bolo ki text yahan visible nahi hai.\n</attached_file>`;
    return `<attached_file>\n${header}\nYeh file type in-browser extract nahi ho sakti (scanned PDF, zip ya legacy binary). Bas honestly bolo ki content yahan visible nahi hai aur user se .txt/.md export ya copy-paste maango.\n</attached_file>`;
  });
  return [draft || 'In uploaded attachments ko analyze karo.', ...blocks].join('\n\n');
}

function stripAttachmentBlocks(text: string): string {
  return text
    .replace(/<attached_file>[\s\S]*?<\/attached_file>/g, '')
    .replace(/<attached_image>[\s\S]*?<\/attached_image>/g, '')
    .trim();
}

/**
 * Parses a sent user message into its typed text plus one descriptor per
 * attached file, so attachments render as chips instead of raw block text.
 */
function parseUserMessageContent(content: string): { text: string; files: { name: string; meta: string }[]; hasImage: boolean } {
  const files: { name: string; meta: string }[] = [];
  let hasImage = false;
  const text = content
    .replace(/<attached_(?:file|image)>([\s\S]*?)<\/attached_(?:file|image)>/g, (_whole, inner: string, tag: string) => {
      if (tag === 'image') hasImage = true;
      const header = (inner.trim().split('\n')[0] ?? '').replace(/^Attachment\s+\d+:\s*/i, '');
      if (header) {
        const match = header.match(/^(.+?)\s*\((.*)\)\s*$/);
        files.push({
          name: (match ? match[1] : header).trim(),
          meta: (match ? match[2] : '').trim(),
        });
      }
      return '';
    })
    .trim();
  return { text, files, hasImage };
}

function UserMessageContent({ content, attachments }: { content: string; attachments?: ChatAttachment[] }) {
  const { text, files, hasImage } = parseUserMessageContent(content);
  const renderMarkdown = !hasImage && looksLikeMarkdown(text);

  // Attached files render as compact type chips (icon + short name + type).
  // New messages carry durable `attachments`; legacy/imported messages fall
  // back to the descriptors parsed out of the content blocks. Images show a
  // small thumbnail whenever a preview URL is available (same-session blobs).
  const chips: Array<{ id: string; name: string; kind: ChatAttachment['kind']; previewUrl?: string; label: string }> =
    attachments && attachments.length > 0
      ? attachments.map((a) => ({ id: a.id, name: a.name, kind: a.kind, previewUrl: a.previewUrl, label: fileKindOf(a.name).ext }))
      : files.map((f, i) => {
          const sizeLabel = f.meta.match(/([\d.]+)\s*(?:KB|MB|GB|B)/)?.[0];
          return {
            id: `f-${i}-${f.name}`,
            name: f.name,
            kind: 'file' as const,
            label: sizeLabel ? `${fileKindOf(f.name).ext} · ${sizeLabel}` : fileKindOf(f.name).ext,
          };
        });

  return (
    <div className={renderMarkdown ? '' : 'whitespace-pre-wrap break-words font-medium'}>
      {renderMarkdown ? (
        <div className="markdown-body">
          <ChatMarkdown text={text} />
        </div>
      ) : (
        text || '—'
      )}
      {chips.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {chips.map((c) => {
            const isImage = c.kind === 'image' && c.previewUrl;
            return (
              <span
                key={c.id}
                className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-black/15 bg-black/10 px-1.5 py-1 text-[10px]"
              >
                {isImage ? (
                  <ImageThumb src={c.previewUrl!} name={c.name} className="h-7 w-7 rounded-md object-cover" />
                ) : (
                  <FileKindBadge name={c.name} size="sm" />
                )}
                <span className="min-w-0">
                  <span className="block max-w-24 truncate font-semibold">{shortFileName(c.name, 16)}</span>
                  <span className="block text-[8px] font-normal opacity-60">{c.label}</span>
                </span>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function uid(prefix: string): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Cheap fingerprint of the provider list (id + label + models + model). */
function providerSigOf(providers: { id: string; label: string; enabled?: boolean; models?: string[]; model?: string }[]): string {
  return providers
    .map((p) => `${p.id}|${p.label}|${p.enabled ? 1 : 0}|${(p.models ?? []).join(',')}|${p.model ?? ''}`)
    .join(';;');
}
