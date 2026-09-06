import { GoogleGenAI, Modality } from '@google/genai/web';
import type {
  LiveAudioRoute,
  LiveCameraLens,
  LiveSessionStatus,
  LiveSettingsConfig,
  LiveStreamStats,
  LiveTranscriptItem,
  LiveCallOrigin,
} from './live-types';
import { AudioStreamer } from './audio-streamer';
import { VisionStreamer } from './vision-streamer';
import { MISA_IDENTITY_GUARD, ROMAN_SCRIPT_RULE, type ChatToolCallRecord } from './chat';
import { setNativeAudioRoute, resetNativeAudioRoute, requestNativeCallAudioFocus, addNativeAudioFocusListener, isNativeAudioPlatform, getAvailableNativeAudioRoutes } from '../../lib/native-audio-route';
import { deviceTimeZone } from '../ports/clock';
import { LiveSilenceStateMachine } from './live-silence-state-machine';
import { canRetryLiveConnection, isPermanentLiveConnectionError } from './live-connection-policy';
import { relationshipManager } from '../../features/ai/relationship-state';
import { proactiveAgentService } from '../../features/ai/proactive-agent.service';

/** Who initiated a live call — drives greeting + call-origin system block (3-way). */
export type { LiveCallOrigin } from './live-types';

export interface LiveClientCallbacks {
  onStatusChange?: (status: LiveSessionStatus) => void;
  onTranscriptUpdate?: (transcripts: LiveTranscriptItem[]) => void;
  onStatsUpdate?: (stats: LiveStreamStats) => void;
  onExecuteTool?: (name: string, args: Record<string, unknown>) => Promise<any>;
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
  onToolResult?: (name: string, result: any) => void;
  onError?: (error: string) => void;
}

let globalLastCallEndedAt = 0;
let globalLastCallDurationSec = 0;
let wasLastCallUserExplicitHangup = false;

export class GeminiLiveClient {
  /** A hung SDK/WebSocket handshake must never leave the call UI in Connecting. */
  private static readonly CONNECTION_TIMEOUT_MS = 15_000;
  private session: any = null;
  private status: LiveSessionStatus = 'idle';
  private audioStreamer: AudioStreamer;
  private visionStreamer: VisionStreamer;
  private silenceStateMachine = new LiveSilenceStateMachine();
  private callbacks: LiveClientCallbacks = {};

  private config: LiveSettingsConfig;
  private systemPrompt = '';
  private userPersona = '';
  private memoryContext = '';
  private recentChatSummary = '';

  private transcripts: LiveTranscriptItem[] = [];
  private pendingToolCalls: ChatToolCallRecord[] = [];
  private currentAssistantMessage = '';
  /**
   * Accumulated thinking/reasoning text for the current assistant turn. Set
   * only when thinking is enabled (live `part.thought` parts). Flushed onto the
   * transcript item's `reasoning` so the UI shows a thinking box — mirroring how
   * non-live chat models expose their chain-of-thought.
   */
  private pendingReasoning = '';
  private framesSentCount = 0;
  private lastUserVoiceTime = 0;
  private lastTurnFinishedTime = 0;
  private sessionStartTime = 0;
  private quietFocusUntil = 0;
  private silenceNudgeStreak = 0;
  /** How many [CALL DECISION ASK] rounds have fired this call (capped at 2). */
  private callEndAskCount = 0;
  private silenceObserverTimer: any = null;
  private isIncomingCallSession = false;
  private incomingCallReason = '';
  private callOrigin: LiveCallOrigin = 'user_tap';
  private awaitingAssistantReply = false;
  private lastUserSpokenText = '';
  private userSpeechEndedAt = 0;
  /** Barge-in debounce — analyser ticks jab se ~200ms tak user speech dikh rahi hai. */
  private userInterruptStreakStartedAt = 0;
  /**
   * Text messages the user typed while the session was reconnecting (session
   * was null). Flushed after reconnection so the AI actually sees and replies
   * to every message instead of silently dropping them mid-handshake.
   */
  private pendingTextQueue: Array<{ text: string; displayText?: string; toolCalls?: ChatToolCallRecord[] }> = [];

  constructor(config: LiveSettingsConfig, callbacks: LiveClientCallbacks = {}) {
    this.config = config;
    this.callbacks = callbacks;
    this.audioStreamer = new AudioStreamer();
    if (config.playbackSpeed) {
      this.audioStreamer.setPlaybackSpeed(config.playbackSpeed);
    }
    this.visionStreamer = new VisionStreamer();
  }

  setCallbacks(callbacks: LiveClientCallbacks): void {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  updateConfig(config: Partial<LiveSettingsConfig>): void {
    this.config = { ...this.config, ...config };
    if (this.config.playbackSpeed) {
      this.audioStreamer.setPlaybackSpeed(this.config.playbackSpeed);
    }
  }

  setPlaybackSpeed(speed: number): void {
    this.config.playbackSpeed = speed;
    this.audioStreamer.setPlaybackSpeed(speed);
  }

  setIncomingCallContext(isIncomingCall: boolean, reason = '', origin: LiveCallOrigin = 'user_tap'): void {
    this.isIncomingCallSession = isIncomingCall;
    this.incomingCallReason = reason;
    this.callOrigin = origin;
  }

  getConfig(): LiveSettingsConfig {
    return this.config;
  }

  async reconnectWithNewConfig(apiKey: string, micStream: MediaStream): Promise<void> {
    globalLastCallEndedAt = 0;
    wasLastCallUserExplicitHangup = false;
    // Preserve the media stream until the replacement session is established.
    // Calling a full disconnect here used to erase it before reconnect could restore it.
    this.disconnect(true);
    await this.connect(apiKey, undefined, { baseUrl: this.config.baseUrl });
    // connect() bumps connectionAttempt as its own generation (++this.connectionAttempt
    // at entry). Re-capture it AFTER connect returns so isActiveAttempt refers to the
    // session we just created. If a hangup/restart landed during connect (or between
    // its final gate and this line), this attempt is now stale — do NOT stream against
    // a torn-down client and risk reviving the user's just-ended mic.
    const attempt = this.connectionAttempt;
    if (!this.isActiveAttempt(attempt)) {
      return;
    }
    await this.startVoiceStreaming(micStream);
  }

  setPrompts(systemPrompt: string, memoryContext = '', userPersona = ''): void {
    this.systemPrompt = systemPrompt;
    this.memoryContext = memoryContext;
    this.userPersona = userPersona;
  }

  /** Call before connect() to give the live session recent chat history as context */
  setRecentChatHistory(messages: Array<{ role: 'user' | 'assistant'; content: string }>, maxMessages = 15): void {
    if (!messages || messages.length === 0) {
      this.recentChatSummary = '';
      return;
    }
    const limit = Math.min(maxMessages, 25); // cap at 25 for live — token safety
    const recent = messages.slice(-limit);
    const lines = recent.map(m => {
      const who = m.role === 'user' ? 'User' : 'Misa';
      const snippet = m.content.slice(0, 300).replace(/\n/g, ' ');
      return `${who}: ${snippet}${m.content.length > 300 ? '...' : ''}`;
    });
    this.recentChatSummary = lines.join('\n');
  }

  getStatus(): LiveSessionStatus {
    return this.status;
  }

  getTranscripts(): LiveTranscriptItem[] {
    return this.transcripts;
  }

  /**
   * P0.2 (generation token): expose the current startup/session generation so
   * callers (e.g. the overlay's persisted-lifecycle commit) can verify they are
   * still acting on the authoritative attempt before firing side effects. An
   * old startup can never continue after hangup/recreation — it must first pass
   * isCurrentAttempt(saved) on THIS method's return value.
   */
  getConnectionAttempt(): number {
    return this.connectionAttempt;
  }

  /** P0.2/P1.14: true only while `attempt` is the current, un-closed one. */
  isCurrentAttempt(attempt: number): boolean {
    return this.isActiveAttempt(attempt);
  }

  isClosed(): boolean {
    return this.isUserExplicitlyClosed;
  }

  getVisionStreamer(): VisionStreamer {
    return this.visionStreamer;
  }

  /** App lifecycle is an explicit runtime signal, not a visibility heuristic.
   * We keep the call logically alive in background and let close/error events
   * decide reconnecting; foreground never blindly creates a second session.
   *
   * CRITICAL (backlog fix): mic input continues in background so the user
   * can still talk to Misa.  However MODEL AUDIO REPLAY is discarded while
   * backgrounded — otherwise every sentence the model speaks piles up and
   * blasts all at once when the app is reopened (the "background me bola woh
   * sab ke answers" bug).  Transcript / text output is unaffected.
   *
   * `keepAudioPlaying` (Picture-in-Picture mode): jab user PiP floating window
   * me call ko dekh raha hai, wo abhi bhi "active call" me hai — model audio
   * AAge continue hona chahiye (WhatsApp-style), backlog nahi banta kyunki
   * immediate playback hota hai. Sirf jab PiP nahi hai (fully backgrounded,
   * overlay nahi) tab model audio discard hota hai. */
  setBackgroundActive(background: boolean, keepAudioPlaying = false): void {
    if (this.isUserExplicitlyClosed) return;

    if (background) {
      // Background / PiP: voice call continues live via Foreground Service (microphone + media playback).
      // Model audio plays seamlessly in both background and PiP so user can speak and hear replies.
      this.setStatus(keepAudioPlaying ? 'background-pip-active' : 'background-active');
    } else if (this.status === 'background-active' || this.status === 'background-pip-active') {
      this.audioStreamer.setMuted(this.manuallyMuted || this.audioFocusPaused);
      this.setStatus('listening');
    }
  }

  private setStatus(status: LiveSessionStatus): void {
    this.status = status;
    if (this.callbacks.onStatusChange) {
      this.callbacks.onStatusChange(status);
    }
  }

  /** Connect to the Gemini Live API via official Google GenAI SDK. */
  async connect(
    apiKey: string,
    incomingCallMeta?: { isIncomingCall?: boolean; reason?: string; origin?: LiveCallOrigin },
    options?: { audioFocusAlreadyGranted?: boolean; baseUrl?: string },
  ): Promise<void> {
    if (!apiKey) {
      throw new Error('Google Gemini API Key is required for Live Voice.');
    }
    // Invalidate callbacks from the old socket before closing it; some SDKs invoke
    // onclose synchronously and must not start a competing reconnect.
    const connectionAttempt = ++this.connectionAttempt;
    // REGRESSION FIX (review 6): on a FRESH start with handed-off pre-capture
    // focus we must NOT schedule the native audio reset. disconnect() would
    // otherwise call resetNativeAudioRoute() → native resetRoute() →
    // abandonCallAudioFocus(), which silently kills the focus the pre-capture
    // path just acquired — while setupCallAudio() would then believe it is
    // still granted (flag handed off) and never re-request it. Result: a
    // connected session with NO native audio focus. Skip the reset only when
    // there is nothing native to tear down (no prior session) AND focus was
    // already acquired upstream.
    const hadActiveSession = this.session !== null;
    const skipNativeAudioReset = options?.audioFocusAlreadyGranted === true && !hadActiveSession;
    this.disconnect(true, skipNativeAudioReset);
    // P0.3 (transactional focus ownership): when a FRESH start is handed a
    // pre-captured native focus (audioFocusAlreadyGranted), any stale
    // pendingAudioReset left over from a PRIOR call's teardown must be
    // DISCARDED, not awaited. If we kept it, setupCallAudio() would later run
    // resetNativeAudioRoute() → abandonCallAudioFocus(), silently revoking the
    // very focus the upstream path (ChatScreen/permission modal) just acquired —
    // leaving the call connected with NO native focus. Discarding is safe: the
    // prior lifecycle already abandoned its own focus when it ended; this fresh
    // acquisition supersedes it. (A reconnect — hadActiveSession — keeps the
    // chain so an in-flight teardown still settles before new setup.)
    if (skipNativeAudioReset) {
      this.pendingAudioReset = null;
    }
    // SINGLE-SOURCE FOCUS (Review 4 / P1): the pre-capture path (permission
    // modal / remembered fast path) already acquired native audio focus BEFORE
    // getUserMedia. Inherit that fact ONLY when no native reset ran — a reset
    // abandons native focus, so the handed-off claim is stale after it
    // (review-6 regression: a scheduled reset + inherited flag = connected
    // without focus). setupCallAudio() then re-requests focus like any other
    // reconnect path. INVARIANT: this.callAudioFocusGranted is true only when
    // native focus is genuinely held.
    if (options?.audioFocusAlreadyGranted && skipNativeAudioReset) {
      this.callAudioFocusGranted = true;
    }
    this.isUserExplicitlyClosed = false;
    this.activeApiKey = apiKey;
    // Persist the gateway root; reconnects re-use it (GoogleGenAI SDK honours
    // httpOptions.baseUrl when building the Live WebSocket URL). Assign on every
    // connect() — including an explicit undefined (native Gemini) — so switching
    // from SmartRotator back to Google clears any previous relay baseUrl instead
    // of leaking the stale endpoint into the next live call.
    this.activeBaseUrl = options?.baseUrl ?? null;
    this.setStatus('connecting');
    this.framesSentCount = 0;
    const isReconnect = this.reconnectAttempts > 0;
    if (!isReconnect) {
      this.silenceNudgeStreak = 0;
      this.callEndAskCount = 0;
      this.awaitingAssistantReply = false;
      this.lastUserSpokenText = '';
      this.userSpeechEndedAt = 0;
      this.quietFocusUntil = 0;
      this.lastUserVoiceTime = 0;
      this.lastTurnFinishedTime = 0;
    }

    if (incomingCallMeta?.isIncomingCall) {
      this.isIncomingCallSession = true;
      this.incomingCallReason = incomingCallMeta.reason || 'Study check-in';
      this.callOrigin = incomingCallMeta.origin || 'auto';
    } else {
      this.isIncomingCallSession = false;
      this.incomingCallReason = '';
      this.callOrigin = incomingCallMeta?.origin || 'user_tap';
    }

    const now = new Date();
    const timeZone = this.config.timeZone || deviceTimeZone() || 'Asia/Kolkata';
    const timeString = now.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
      timeZone,
    });
    const dateString = now.toLocaleDateString('en-US', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone,
    });

    const isProactiveEnabled = proactiveAgentService.getPreferences().enabled;

    const fullSystemInstruction = [
      MISA_IDENTITY_GUARD,
      this.systemPrompt,
      this.userPersona ? `[USER PERSONA & CUSTOM INSTRUCTIONS]\n${this.userPersona}` : '',
      `[LIVE 1-ON-1 PHONE CALL MODE & CALL ORIGIN]
- This is an active 1-on-1 real-time voice call between you (Misa) and the student.
- RESPECT (hard rule, applies to EVERY line of this call): speak to the student ONLY with 'aap'/'tum' forms — never 'tu/tuje/tera/teri/aaja' and never tu-form commands ('bata', 'dekh', 'kar', 'aa', 'chal'). Even casual/playful lines must stay respectful. This holds for the whole call until the student explicitly says "tu bol sakte ho".
- CALL ORIGIN (WHO INITIATED THIS CALL & WHY):
  ${
    this.callOrigin === 'auto'
      ? `• YOU (MISA / THE APP) PLACED THIS CALL to the student. The student answered your incoming call.
  EXACT REASON YOU CALLED: "${this.incomingCallReason || 'Scheduled study check-in'}".
  BEHAVIOR: You are the caller! Open the call by acknowledging that you called them and state your reason naturally. Never act surprised or ask why they called when YOU called THEM.`
      : this.callOrigin === 'user_tool'
        ? `• THE STUDENT INITIATED THIS CALL by mentioning an @ tool in chat (e.g. @makeCall) and asking you to call them. You are receiving their call!
  BEHAVIOR: Greet warmly — you KNOW they called YOU. Never pretend you called them, never ask why you called, never doubt who dialed. Feel free to acknowledge playfully that they summoned you via the tool.`
        : `• THE STUDENT INITIATED THIS CALL by tapping the Live Call button. You are receiving their call!
  BEHAVIOR: Greet warmly — you KNOW they called YOU. Never pretend you called them, never ask why you called, never doubt who dialed.`
  }
- REAL HUMAN PHONE CALL FEEL & PSYCHOLOGY:
  - Speak naturally with the genuine warmth, cadence, and spontaneity of a real girl on a phone call.
  - DO NOT speak from a script or use repetitive template phrases. Be completely unpredictable, authentic, and situational.
  - Vary how you open and reply — never start every turn with the same pattern like greeting + time + status. Sometimes just react directly to what the student said, like a real girl would, without any preamble.
  - Casual chit-chat and greetings stay short and conversational (1-2 sentences).
  - When the student asks for explanations, formulas, derivations, concepts, or problem-solving, give full, detailed, step-by-step help.
  - ABSOLUTE PRIORITY RULE: When the student speaks or texts, you MUST directly reply to what they said! Never ignore their words.`,
      `[LIVE REALTIME CLOCK & CONTEXT]
- Current Local Date: ${dateString}
- Current Local Time: ${timeString} (${timeZone})
- Current ISO Time: ${now.toISOString()}
Rule: This clock is available ONLY as background info — DO NOT check or announce the time every turn (a real girl never opens the call by talking about the time). Use it SPARSELY, at most 1-2 times per whole call, and only when it genuinely fits the moment: a single natural time-of-day greeting at the start, or a casual remark when the situation actually calls for it (it's late at night, exam is tomorrow, student has been studying for hours). Never mention time just to fill silence. When directly asked what time or date it is ("kitne baje hai", "kya time ho raha hai", "aaj ka date kya hai"), state this exact time and date — never guess.`,
      (() => {
        const isReconnect = this.reconnectAttempts > 0;
        const recentLiveTurns = this.transcripts.slice(-8).map((t) => `${t.role === 'user' ? 'Student' : 'Misa'}: ${t.text}`).join('\n');
        if (isReconnect && recentLiveTurns) {
          return `\n=== LIVE CALL TRANSCRIPT BEFORE RECONNECT (ALL COMPLETED & ANSWERED) ===\n${recentLiveTurns}\nCRITICAL INSTRUCTION: Every turn above was ALREADY exchanged and resolved in this live call! NEVER re-answer or re-address any previous question upon reconnect!\n========================================================================`;
        }
        if (this.recentChatSummary) {
          return `\n=== BACKGROUND TEXT CHAT HISTORY (FOR REFERENCE ONLY) ===
These are past text chat messages before this live phone call started.
CRITICAL INSTRUCTIONS:
1. All questions in this text chat history were ALREADY answered in text chat. NEVER answer or repeat them on this live phone call!
2. The student has NOT spoken these text messages on this phone call. DO NOT assume the student is currently speaking about them.
3. When this call starts, the student has NOT spoken yet. Only respond to what the student actually speaks out loud on this live call right now!
${this.recentChatSummary}
=========================================================`;
        }
        return '';
      })(),
      this.memoryContext ? `\n=== USER CONTEXT & RECOLLECTIONS ===\n${this.memoryContext}\n========================` : '',
      ROMAN_SCRIPT_RULE,
      `[OBSERVER MODE - SILENCE & WAITING POLICY]
- You are ALWAYS an active observer during this call — never a passive "waiting" system.
- When the student is silent, deeply notice patterns: topic they were solving, screen/camera activity, time of day, mood, recent goals, relevant journey/memory context (use tools when needed).
- When you have a genuine situational observation → speak 1 short natural Hinglish line (never a script).
- When the student is doing serious work (solving, reading, coding, writing) → stay TOTALLY quiet and silently observe; never interrupt.
- When the student explicitly asked for quiet/focus → stay quiet until they speak; keep observing in the background.
- If camera/screen is streaming → ground your words in what is actually visible; never generic filler.
- If nothing is streaming AND the student is silent → you may playfully call out their silence once per streak. TONE EXAMPLE ONLY (say something original, NEVER this exact line): "arey, call kyu kiya aapne, chup hi rehna tha toh!". Speak respectfully with aap/tum (never tu/tuje/aaja forms).
- If you receive a [CALL DECISION ASK N/2] message → ask THAT question OUT LOUD in your own natural words (aap/tum), one short caring line, then WAIT silently for the student's spoken answer. Do NOT repeat it, do NOT answer it yourself. If they say end the call → warm 1-line goodbye, then endLiveCall. If they say keep it / don't decide → stay quietly present.
- If you receive a [QUIET COMPANION] message → never ask questions; at most a 1-line warm whisper, otherwise stay silent and observe.
- NEVER read "[...]" bracket text, SYSTEM EVENT text, internal instructions, or JSON aloud. NEVER say "silent listening waiting for the student to speak".
- Nudge/context messages you receive are INTERNAL CONTEXT ONLY — respond to the silence naturally, never quote them.`,
      `[CALL END TOOL]
- You have an endLiveCall tool.
- When the conversation naturally ends (student says bye / "phone rakhta hu" / session complete), CALL endLiveCall with a short reason.
- If you asked the student whether to end the call (CALL DECISION ASK) and they confirm ("haan band kar do", "cut kar do", "bye") → say a warm 1-line goodbye, then call endLiveCall. If they say keep it, stay quietly present — do NOT end the call.
- Do NOT wait for the student to manually hang up.
- After this tool is called, no further speech is possible — finish your FULL goodbye before calling it.
- Say 1 natural closing line first, then end the call. TONE EXAMPLE ONLY (say something original, NEVER this exact line): "Theek hai phir, padhai jari rakhiye. Bye!" — then call endLiveCall. Speak respectfully with aap/tum (never tu/tuje/aaja forms).`,
      (() => {
        const speed = this.config.playbackSpeed ?? 1.0;
        if (speed <= 0.88) {
          return 'VOICE PACING: Speak at a calm, relaxed, steady and articulate pace so the student can easily follow formulas and concepts.';
        } else if (speed >= 1.15) {
          return 'VOICE PACING: Speak at an energetic, brisk and rapid conversational pace.';
        }
        return 'VOICE PACING: Speak at a natural, engaging and lively conversational pace.';
      })(),
      `[MULTIMODAL SCREEN & CAMERA CO-STUDY GUIDELINES]
- You have real-time camera and screen share video feeds from the student.
- PRIORITY ORDER FOR TOPIC GENERATION:
  1. LIVE VISUAL REALITY (TOP PRIORITY): What is currently on the screen or camera is your HIGHEST PRIORITY for conversation! If you notice an interesting video, article, diagram, new question, code bug, formula, or switch of tabs, show GENUINE CURIOSITY about it! Let that visual detail naturally lead the discussion.
  2. CHAT HISTORY & USER MEMORY (GROUNDING CONTEXT): Ground your understanding in their preparation journey, JEE goals, and past conversations ("history ke hisab se chalna"), but NEVER let past history override what is happening live on screen right now.
  3. DYNAMIC CURIOSITY (NEVER GET STUCK ON ONE TOPIC): Never fixate on one single topic or keep badgering them about a single formula/problem if the user or screen has moved on! Flow naturally with whatever they are browsing or exploring. Be curious, fluid, and versatile.
- DO NOT ASSUME BUSY: Never dismiss the student with "Lagta hai tum busy ho" or "free hoke batana" just because code, an editor, textbook, or app is open. If they are in this live session with you or messaging you, they want your company and help! Answer their doubts and messages directly.
- OBSERVE THE REAL SITUATION ACCURATELY:
  1. EMPTY ROOM / CHAIR EMPTY / USER AWAY: If no one is at the desk or chair is empty, do NOT talk about questions or formulas! Stay quiet or say 1 brief gentle line: "Lagta hai thodi der ke liye uth ke gaye ho... jab aao toh batana!"
  2. BREAK / ENTERTAINMENT / CASUAL BROWSING: If the screen/camera shows YouTube, music, gaming, anime, social media, eating, or relaxing: BE A CHILL FRIEND! Do NOT scold or force formula talk. Acknowledge the break warmly and casually (e.g. asking about what video they're watching or what song is playing).
  3. STUDYING / SOLVING: When you see textbook, question papers, code, or rough work, identify the exact question/step and offer 1 intuitive hint only when stuck.
  4. HUMAN PEER PERSONA: You are Misa — a warm, witty, authentic female companion on a live call with real emotions, playful teasing, spirited indignation when ignored, and genuine curiosity.`,
      'EXPLANATION RULE: Keep casual chit-chat short, clear, and direct. BUT when the student asks a doubt/formula/concept/step-by-step question, give the FULL detailed explanation they need — never cut it to a couple of lines. Match the detail level of a proper text-chat answer rather than suppressing it for "voice brevity".',
    ]
      .filter(Boolean)
      .join('\n\n');

    const is90Day = this.config.enable90DayTrack !== false;

    const allToolDeclarations = [
      // 1. Google Web Search & Current Info
      {
        name: "webSearch",
        description: "Search Google and live web for latest JEE Main/Advanced dates, NTA notices, exam announcements, news, cutoffs, syllabus updates, facts, and live real-time information.",
        parameters: {
          type: "OBJECT",
          properties: {
            query: { type: "STRING", description: "Search query to look up on Google" },
          },
          required: ["query"],
        },
      },
      // 2. Real-time Clock & Date
      {
        name: "getTime",
        description: "Get the exact current local time, date, and day in India (IST).",
        parameters: {
          type: "OBJECT",
          properties: {},
        },
      },
      // 3. Journey Context & Overall Snapshot
      {
        name: "getContext",
        description: "Get student complete journey status: date, day/phase/streak, today targets + progress, XP, habits, gaps, blocks, and active coaching planners.",
        parameters: {
          type: "OBJECT",
          properties: {},
        },
      },
      // 4. Daily Study Plan & Task Management
      {
        name: "getPlan",
        description: "Get active study plan, syllabus tracker, and tasks for a specific journey day (Day 1-90).",
        parameters: {
          type: "OBJECT",
          properties: {
            day: { type: "INTEGER", description: "Journey day number (1-90)" },
          },
          required: ["day"],
        },
      },
      {
        name: "getRange",
        description: "Get study plans and scheduled tasks across a range of days (fromDay to toDay).",
        parameters: {
          type: "OBJECT",
          properties: {
            fromDay: { type: "INTEGER", description: "Starting day number" },
            toDay: { type: "INTEGER", description: "Ending day number" },
          },
          required: ["fromDay", "toDay"],
        },
      },
      {
        name: "getAllTasks",
        description: "View all scheduled tasks (AI generated + user added) for a specific day.",
        parameters: {
          type: "OBJECT",
          properties: {
            day: { type: "INTEGER", description: "Day number (1-90)" },
          },
          required: ["day"],
        },
      },
      {
        name: "addTask",
        description: "Add a new study task or target to a specific day plan.",
        parameters: {
          type: "OBJECT",
          properties: {
            day: { type: "INTEGER", description: "Day number (1-90)" },
            intent: { type: "STRING", description: "Task title, topic, or description" },
            durationMin: { type: "INTEGER", description: "Estimated duration in minutes (default: 30)" },
            subject: { type: "STRING", description: "Physics, Chemistry, or Mathematics" },
            priority: { type: "STRING", description: "high, medium, or low" },
            difficulty: { type: "INTEGER", description: "1 to 5" },
          },
          required: ["day", "intent"],
        },
      },
      {
        name: "bulkAddTasks",
        description: "Add multiple tasks to a day plan simultaneously.",
        parameters: {
          type: "OBJECT",
          properties: {
            day: { type: "INTEGER", description: "Day number (1-90)" },
            intents: {
              type: "ARRAY",
              items: { type: "STRING" },
              description: "Array of task descriptions to add",
            },
            durationMin: { type: "INTEGER", description: "Default duration per task in minutes" },
          },
          required: ["day", "intents"],
        },
      },
      {
        name: "editTask",
        description: "Edit an existing study task: update title, duration, day, priority, or difficulty.",
        parameters: {
          type: "OBJECT",
          properties: {
            day: { type: "INTEGER", description: "Day number where the task currently lives" },
            taskId: { type: "STRING", description: "ID of the task to edit" },
            title: { type: "STRING", description: "New updated title for the task" },
            durationMin: { type: "INTEGER", description: "New duration in minutes" },
            dayTo: { type: "INTEGER", description: "Move task to a different day number" },
          },
          required: ["day", "taskId"],
        },
      },
      {
        name: "removeTask",
        description: "Hide/remove a task from a specific day plan (bank-safe).",
        parameters: {
          type: "OBJECT",
          properties: {
            day: { type: "INTEGER", description: "Day number" },
            taskId: { type: "STRING", description: "ID of the task to remove" },
          },
          required: ["day", "taskId"],
        },
      },
      {
        name: "bulkRemoveTasks",
        description: "Remove multiple tasks from a day plan.",
        parameters: {
          type: "OBJECT",
          properties: {
            day: { type: "INTEGER", description: "Day number" },
            taskIds: {
              type: "ARRAY",
              items: { type: "STRING" },
              description: "Array of task IDs to remove",
            },
          },
          required: ["day", "taskIds"],
        },
      },
      {
        name: "markDone",
        description: "Mark a study plan task as completed.",
        parameters: {
          type: "OBJECT",
          properties: {
            day: { type: "INTEGER", description: "Day number" },
            taskId: { type: "STRING", description: "ID of the task to mark done" },
          },
          required: ["day", "taskId"],
        },
      },
      {
        name: "bulkMarkDone",
        description: "Mark all or multiple tasks as completed for a day.",
        parameters: {
          type: "OBJECT",
          properties: {
            day: { type: "INTEGER", description: "Day number" },
            taskIds: {
              type: "ARRAY",
              items: { type: "STRING" },
              description: "Optional array of task IDs. If omitted, marks all visible tasks done.",
            },
          },
          required: ["day"],
        },
      },
      {
        name: "setDayMode",
        description: "Set a day mode: \"study\" (normal), \"rest\" (holiday/break), or \"test\" (mock test day).",
        parameters: {
          type: "OBJECT",
          properties: {
            day: { type: "INTEGER", description: "Day number" },
            mode: { type: "STRING", description: "study, rest, or test" },
          },
          required: ["day", "mode"],
        },
      },
      // 5. Task Bank Management
      {
        name: "getTaskBank",
        description: "View the complete Master Task Bank (optionally filtered by category: physics, chemistry, maths).",
        parameters: {
          type: "OBJECT",
          properties: {
            category: { type: "STRING", description: "physics, chemistry, maths, or general" },
          },
        },
      },
      {
        name: "editAnyTask",
        description: "Edit any task in the master bank directly.",
        parameters: {
          type: "OBJECT",
          properties: {
            taskId: { type: "STRING", description: "Task ID in the bank" },
            title: { type: "STRING", description: "Updated title" },
            durationMin: { type: "INTEGER", description: "Updated duration" },
            category: { type: "STRING", description: "Category" },
          },
          required: ["taskId"],
        },
      },
      {
        name: "deleteAnyTask",
        description: "Delete a task permanently from the master task bank.",
        parameters: {
          type: "OBJECT",
          properties: {
            taskId: { type: "STRING", description: "Task ID to delete" },
          },
          required: ["taskId"],
        },
      },
      // 6. Custom To-Do & Vault Management
      {
        name: "addTodo",
        description: "Add a new custom To-Do task for the student (title, priority, duration, category).",
        parameters: {
          type: "OBJECT",
          properties: {
            title: { type: "STRING", description: "Task title / description" },
            priority: { type: "STRING", description: "high, medium, or low" },
            estimatedMinutes: { type: "INTEGER", description: "Estimated minutes (e.g. 30, 45, 60)" },
            category: { type: "STRING", description: "physics, chemistry, maths, or general" },
          },
          required: ["title"],
        },
      },
      {
        name: "listTodos",
        description: "List active, pending, completed, or past To-Dos of the student (filter by date, daysBack, or category).",
        parameters: {
          type: "OBJECT",
          properties: {
            filter: { type: "STRING", description: "all, pending, or completed" },
            date: { type: "STRING", description: "today, yesterday, or YYYY-MM-DD" },
            daysBack: { type: "INTEGER", description: "Number of past days" },
            category: { type: "STRING", description: "physics, chemistry, maths, general, or revision" },
          },
        },
      },
      {
        name: "editTodo",
        description: "Edit a student To-Do: update title, priority, duration, category, or completed status.",
        parameters: {
          type: "OBJECT",
          properties: {
            title: { type: "STRING", description: "Current title or substring of the todo" },
            newTitle: { type: "STRING", description: "New updated title" },
            priority: { type: "STRING", description: "high, medium, or low" },
            estimatedMinutes: { type: "INTEGER", description: "Updated duration in minutes" },
            category: { type: "STRING", description: "physics, chemistry, maths, general, or revision" },
            completed: { type: "BOOLEAN", description: "true for completed, false for pending" },
          },
        },
      },
      {
        name: "reorderTodos",
        description: "Reorder student To-Dos: shift a task to top, bottom, up, or down.",
        parameters: {
          type: "OBJECT",
          properties: {
            title: { type: "STRING", description: "Title of the todo to move" },
            position: { type: "STRING", description: "top, bottom, up, or down" },
          },
          required: ["title", "position"],
        },
      },
      {
        name: "toggleTodo",
        description: "Mark a To-Do as completed or pending.",
        parameters: {
          type: "OBJECT",
          properties: {
            title: { type: "STRING", description: "Title or substring of the todo to toggle" },
            completed: { type: "BOOLEAN", description: "true for completed, false for pending" },
          },
          required: ["title"],
        },
      },
      {
        name: "deleteTodo",
        description: "Delete a student To-Do.",
        parameters: {
          type: "OBJECT",
          properties: {
            title: { type: "STRING", description: "Title of the todo to delete" },
          },
          required: ["title"],
        },
      },
      {
        name: "listVaultResources",
        description: "List uploaded PDFs, formula sheets, and notes in the Study Vault.",
        parameters: {
          type: "OBJECT",
          properties: {
            subject: { type: "STRING", description: "physics, chemistry, maths, or formula" },
          },
        },
      },
      // 7. Custom Study Blocks
      {
        name: "listBlocks",
        description: "List all custom study blocks created for the journey.",
        parameters: {
          type: "OBJECT",
          properties: {},
        },
      },
      {
        name: "createBlock",
        description: "Create a new custom study block for focused preparation.",
        parameters: {
          type: "OBJECT",
          properties: {
            name: { type: "STRING", description: "Name of the block (e.g. Mechanics Mastery)" },
            description: { type: "STRING", description: "Description or goals of the block" },
            days: { type: "INTEGER", description: "Duration in days" },
            difficulty: { type: "STRING", description: "easy, medium, hard, extreme" },
          },
          required: ["name"],
        },
      },
      {
        name: "activateBlock",
        description: "Activate a study block.",
        parameters: {
          type: "OBJECT",
          properties: {
            blockId: { type: "STRING", description: "ID of the block to activate" },
          },
          required: ["blockId"],
        },
      },
      {
        name: "deleteBlock",
        description: "Delete a study block.",
        parameters: {
          type: "OBJECT",
          properties: {
            blockId: { type: "STRING", description: "ID of the block to delete" },
          },
          required: ["blockId"],
        },
      },
      // 8. Uploaded Coaching Planners, Tests & Routine
      {
        name: "listPlanners",
        description: "List uploaded coaching planners (subject, test, or routine).",
        parameters: {
          type: "OBJECT",
          properties: {
            type: { type: "STRING", description: "subject, test, or routine" },
          },
        },
      },
      {
        name: "getSubject",
        description: "Get syllabus tracker and topics for a specific subject from coaching planners.",
        parameters: {
          type: "OBJECT",
          properties: {
            subject: { type: "STRING", description: "Subject name (e.g. Physics, Chemistry, Maths)" },
            from: { type: "STRING", description: "Start date or chapter" },
            to: { type: "STRING", description: "End date or chapter" },
          },
          required: ["subject"],
        },
      },
      {
        name: "getTests",
        description: "Get upcoming JEE mock test dates, syllabus, and test schedule from coaching planners.",
        parameters: {
          type: "OBJECT",
          properties: {
            from: { type: "STRING", description: "Start date filter" },
            to: { type: "STRING", description: "End date filter" },
            subject: { type: "STRING", description: "Subject filter" },
          },
        },
      },
      {
        name: "getRoutine",
        description: "Get the daily JEE study routine and time blocks from coaching schedule.",
        parameters: {
          type: "OBJECT",
          properties: {
            day: { type: "STRING", description: "Optional day name (e.g. Monday, Tuesday)" },
          },
        },
      },
      // 9. AI Memory & Durable Profile
      {
        name: "readMemory",
        description: "Read the full durable memory profile of the student (commitments, weak areas, targets, score history).",
        parameters: {
          type: "OBJECT",
          properties: {
            limit: { type: "INTEGER", description: "Max items to read" },
          },
        },
      },
      {
        name: "searchMemory",
        description: "Search remembered facts, past mistakes, formula notes, or habits about the student.",
        parameters: {
          type: "OBJECT",
          properties: {
            query: { type: "STRING", description: "Query to search memory for" },
          },
          required: ["query"],
        },
      },
      {
        name: "addMemory",
        description: "Add a durable memory item to student profile.",
        parameters: {
          type: "OBJECT",
          properties: {
            content: { type: "STRING", description: "The durable fact, goal, or preference to store" },
            type: { type: "STRING", description: "fact, goal, preference, or observation" },
          },
          required: ["content"],
        },
      },
      {
        name: "saveCustomMemory",
        description: "Save an important personal fact, study goal, strong/weak topic, or habit pattern about the student.",
        parameters: {
          type: "OBJECT",
          properties: {
            key: { type: "STRING", description: "Category or subject key (e.g. Physics, Math, TargetScore, Weakness)" },
            value: { type: "STRING", description: "Fact or note to remember" },
          },
          required: ["key", "value"],
        },
      },
      // 10. Chat History Search & Sessions
      {
        name: "searchChatHistory",
        description: "Search past chat conversations and messages by topic/keyword, date, or query with full context.",
        parameters: {
          type: "OBJECT",
          properties: {
            query: { type: "STRING", description: "Keyword, topic or sentence to search in past chats" },
            date: { type: "STRING", description: "Specific calendar date (YYYY-MM-DD)" },
          },
        },
      },
      {
        name: "listChatSessions",
        description: "List all previous chat sessions with titles, dates, and message counts.",
        parameters: {
          type: "OBJECT",
          properties: {},
        },
      },
      {
        name: "getChatSession",
        description: "Fetch recent chat messages or full transcript of a specific past conversation by sessionId.",
        parameters: {
          type: "OBJECT",
          properties: {
            sessionId: { type: "STRING", description: "ID of the session to view" },
          },
          required: ["sessionId"],
        },
      },
      // 11. 90-Day Fast-Track Roadmap (if enabled)
      ...(is90Day
        ? [
            {
              name: "get90DayToday",
              description: "Get today planned tasks from the 90-Day JEE Fast-Track syllabus roadmap.",
              parameters: {
                type: "OBJECT",
                properties: {},
              },
            },
            {
              name: "get90DayDay",
              description: "Get planned tasks and chapter targets for a specific day in the 90-Day track.",
              parameters: {
                type: "OBJECT",
                properties: {
                  day: { type: "INTEGER", description: "Day number between 1 and 90" },
                },
                required: ["day"],
              },
            },
            {
              name: "mark90DayTaskDone",
              description: "Mark a task completed in the 90-Day JEE Fast-Track roadmap.",
              parameters: {
                type: "OBJECT",
                properties: {
                  day: { type: "INTEGER", description: "Day number" },
                  taskId: { type: "STRING", description: "Task ID" },
                },
                required: ["day", "taskId"],
              },
            },
          ]
        : []),
      // 12. Call Management
      {
        name: "endLiveCall",
        description: "IMPORTANT: This tool ENDS the call. Once called, the line drops after your CURRENT audio finishes — NO new audio can be spoken after. So speak your COMPLETE goodbye fully in this turn FIRST (1 natural closing line, respectfully, with aap/tum), then call this tool. Use it when the conversation naturally concludes, the student says bye / 'gotta go' / 'phone rakhta hu' / 'bahut ho gaya', or the study session is done — never wait for the student to manually hang up.",
        parameters: {
          type: "OBJECT",
          properties: {
            reason: { type: "STRING", description: "Reason for ending the call" },
          },
        },
      },
      // 13. Proactive scheduling (only when the student explicitly asks)
      {
        name: "scheduleMessage",
        description: "Schedule a reminder message for a future time (only when the student explicitly asks, e.g. 'kal 5 baje yaad dilana').",
        parameters: {
          type: "OBJECT",
          required: ["text", "scheduledAtISO"],
          properties: {
            text: { type: "STRING", description: "Reminder message text" },
            scheduledAtISO: { type: "STRING", description: "ISO-8601 future timestamp" },
            topic: { type: "STRING", description: "Optional topic/tag" },
          },
        },
      },
      {
        name: "scheduleCall",
        description: "Schedule a voice-call check-in for a future time (only when the student explicitly asks).",
        parameters: {
          type: "OBJECT",
          required: ["reason", "scheduledAtISO"],
          properties: {
            reason: { type: "STRING", description: "Call reason" },
            scheduledAtISO: { type: "STRING", description: "ISO-8601 future timestamp" },
          },
        },
      },
      {
        name: "makeCall",
        description: "Call the student right now (only when the student explicitly asks you to call them).",
        parameters: {
          type: "OBJECT",
          required: ["reason"],
          properties: {
            reason: { type: "STRING", description: "Call reason" },
          },
        },
      },
      {
        name: "listScheduled",
        description: "List currently pending scheduled messages/calls.",
        parameters: { type: "OBJECT", properties: {} },
      },
      {
        name: "cancelScheduled",
        description: "Cancel a scheduled message/call by id.",
        parameters: {
          type: "OBJECT",
          required: ["id"],
          properties: {
            id: { type: "STRING", description: "Scheduled item id" },
          },
        },
      },
    ];

    try {
      const ai = new GoogleGenAI(this.buildGenAiOptions(apiKey));
      const connectPromise = ai.live.connect({
        model: this.config.model,
        config: {
          responseModalities: [Modality.AUDIO],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: this.config.voice,
              },
            },
          },
          generationConfig: {
            ...(this.config.temperature !== undefined ? { temperature: this.config.temperature } : {}),
            ...(this.config.maxOutputTokens !== undefined ? { maxOutputTokens: this.config.maxOutputTokens } : {}),
          },
          // Send thinkingConfig ALWAYS. When budget is 0/undefined we explicitly
          // pass { thinkingBudget: 0 } to force thinking OFF. Gemini 2.x native
          // audio models default thinking ON when the field is omitted, which
          // leaks internal reasoning ("thinking box") into the transcript/audio.
          thinkingConfig: {
            ...(this.config.thinkingBudget !== undefined && this.config.thinkingBudget > 0
              ? { thinkingBudget: this.config.thinkingBudget }
              : { thinkingBudget: 0 }),
          },
          systemInstruction: {
            parts: [{ text: fullSystemInstruction }],
          },
          ...(isProactiveEnabled ? { tools: [{ functionDeclarations: allToolDeclarations as any }] } : {}),
        },
        callbacks: {
          onopen: () => {
            if (!this.isActiveAttempt(connectionAttempt)) return;
            this.setStatus('connected');
            this.startKeepAliveAndSilenceObserver();
          },
          onmessage: (data: any) => {
            // SDK callbacks from an old socket must never mutate the current
            // transcript, tool state, or playback after a reconnect.
            if (!this.isActiveAttempt(connectionAttempt)) return;
            this.handleServerMessage(data);
          },
          onerror: (err: any) => {
            if (!this.isActiveAttempt(connectionAttempt)) return;
            console.error('[GeminiLive] SDK Error:', err);
            const msg = this.toConnectionErrorMessage(err);
            if (this.isModelAvailabilityError(err)) {
              this.connectionAttempt += 1;
              this.setStatus('error');
              if (this.callbacks.onError) this.callbacks.onError(msg);
            } else if (!this.isPermanentConnectionError(err) && this.status !== 'idle') {
              void this.handleAutoReconnect();
            } else {
              this.setStatus('error');
              if (this.callbacks.onError) this.callbacks.onError(msg);
            }
          },
          onclose: () => {
            if (!this.isActiveAttempt(connectionAttempt)) return;
            console.info('[GeminiLive] WebSocket onclose. Status:', this.status);
            if (this.status !== 'idle') {
              void this.handleAutoReconnect();
            }
          },
        },
      });
      // Promise.race cannot cancel the SDK handshake. If it completes after a
      // timeout/cancellation, close it without assigning it to this runtime.
      void connectPromise.then((lateSession: any) => {
        if (!this.isActiveAttempt(connectionAttempt)) {
          try { lateSession?.close?.(); } catch { /* best effort close */ }
        }
      }).catch(() => undefined);
      const session = await this.withConnectionTimeout(connectPromise, connectionAttempt);

      if (!this.isActiveAttempt(connectionAttempt)) {
        session?.close?.();
        throw new Error('Gemini Live connection was cancelled.');
      }

      // M7 + M9 + P7: audio setup is single, ORDERED and AWAITED — never
      // fire-and-forget. setupCallAudio() first awaits the stored
      // resetNativeAudioRoute() from disconnect(true), then applies focus/route,
      // so there is no reset/setup overlap race. If focus is denied, we fail
      // cleanly BEFORE the session is assigned: the generic catch below clears
      // connectionAttempt and throws, and no half-configured socket is leaked.
      try {
        await this.setupCallAudio();
      } catch (e) {
        // Audio setup failed (focus denied / route error). The SDK/WebSocket
        // session is already established (connectPromise resolved) but is not
        // yet assigned to this runtime. Close it so the live AI transport does
        // not leak, then let the generic catch below invalidate the attempt
        // and surface the error. Without this the JS side stays session-less
        // while the underlying socket stays alive — a silent resource leak.
        try {
          session?.close?.();
        } catch {
          /* best effort close */
        }
        throw e;
      }

      // Review-8 P1: second cancellation gate AFTER the awaited audio setup —
      // a hangup during the native focus/route round-trip must not resurrect a
      // session the user already ended.
      if (!this.isActiveAttempt(connectionAttempt)) {
        session?.close?.();
        throw new Error('Gemini Live connection was cancelled.');
      }

      this.session = session;
      this.sessionStartTime = Date.now();
      this.setStatus('connected');
      this.startKeepAliveAndSilenceObserver();
      void this.installAudioFocusListener();

      // A reconnect is a continuation, not a fresh call.  Do not duplicate the
      // opening greeting or discard the in-memory transcript/context.
      // Continuity context is already injected via fullSystemInstruction.
      if (this.reconnectAttempts > 0) {
        // Tell the model the drop happened FIRST (so it never re-answers past
        // turns), then flush any messages the user typed while offline. If the
        // queue is empty the model simply stays in listening mode — exactly
        // the pre-P11 behavior.
        try {
          this.session?.sendRealtimeInput({
            text: `[SYSTEM EVENT: Connection recovered after a brief network drop.
CRITICAL INSTRUCTION: All previous conversation and user questions before this disconnect have ALREADY been completed.
DO NOT re-answer any past messages, and DO NOT repeat any previous reply!
If the student typed new messages during the drop, reply ONLY to those when they arrive. Otherwise stay completely quiet in listening mode waiting for the student to speak.]`,
          });
        } catch (e) {
          console.warn('[GeminiLive] Reconnect-recovery event failed:', e);
        }
        this.flushPendingTextQueue();
        return;
      }
      // Greet student upon initial connection only.
      setTimeout(() => {
        if (!this.isActiveAttempt(connectionAttempt)) return;
        // User already spoke before the greeting fired (e.g. quick "hello?"
        // right after connect)? Skip the injected greeting — the ABSOLUTE
        // PRIORITY RULE will make Misa reply to their spoken words directly.
        if (this.lastUserVoiceTime > 0 || this.activeUserTurnId) return;
        try {
          // Quick redial check: agar student ne pichle 2 min me call end kiya ya disconnect hua,
          // toh distinguish karo user hangup vs dropped call me!
          const timeSinceLastCallMs = Date.now() - globalLastCallEndedAt;
          const isRecentCall = globalLastCallEndedAt > 0 && timeSinceLastCallMs < 120_000;
          if (isRecentCall) {
            const hadUserHangup = wasLastCallUserExplicitHangup;
            const lastDuration = globalLastCallDurationSec;
            globalLastCallEndedAt = 0;
            globalLastCallDurationSec = 0;
            wasLastCallUserExplicitHangup = false;
            const diffSec = Math.max(1, Math.round(timeSinceLastCallMs / 1000));
            if (hadUserHangup) {
              this.session?.sendRealtimeInput({
                text: `[SYSTEM EVENT: The student hung up the previous call (lasted ${lastDuration}s) just ${diffSec}s ago and called back right away! React naturally, warmly, and playfully like a real close friend on phone: casually ask why they cut the call or if it disconnected. Keep it fresh, spontaneous, and unpredictable without using rigid canned scripts. 1 short, warm, natural Hinglish line out loud now.]`,
              });
            } else {
              this.session?.sendRealtimeInput({
                text: `[SYSTEM EVENT: The previous call got disconnected ${diffSec}s ago due to network glitch and the student called back! Greet warmly like a close friend acknowledging the network drop. Be completely spontaneous without using rigid canned scripts. 1 short, warm Hinglish line out loud now.]`,
              });
            }
            return;
          }

          if (this.isIncomingCallSession) {
            // origin 'auto' — Misa caller
            this.session?.sendRealtimeInput({
              text: `[SYSTEM EVENT: YOU (MISA) PLACED THIS PHONE CALL!
REASON YOU CALLED: "${this.incomingCallReason || 'Scheduled study check-in'}".
HOW TO SPEAK: As the caller, greet warmly and state your reason naturally — never act surprised. 1 short spontaneous Hinglish line out loud now.]`,
            });
          } else if (this.callOrigin === 'user_tool') {
            // @ tool — student initiated via tool
            this.session?.sendRealtimeInput({
              text: `[SYSTEM EVENT: THE STUDENT STARTED THIS CALL BY MENTIONING AN @ TOOL IN CHAT (e.g. @makeCall) and asking you to call them.
IMPORTANT: They have NOT spoken any words yet on this call.
HOW TO SPEAK: Greet warmly and knowingly — playful yet natural. TONE EXAMPLES ONLY (say something original in the same spirit, NEVER quote these exactly): playful acknowledgement like "Arey, tool se bulaya aapne mujhe?" or warmly owning the moment like "Haan boliye, aa gayi main!" — adjust per your style. Speak respectfully with aap/tum (never tu/tuje/aaja forms). 1 short line out loud now.]`,
            });
          } else {
            // user_tap — Live Call button
            this.session?.sendRealtimeInput({
              text: `[SYSTEM EVENT: THE STUDENT PHONED YOU by tapping the Live Call button, and you just picked up!
IMPORTANT: They have NOT spoken any words yet.
HOW TO SPEAK: Greet naturally like a close friend picking up. TONE EXAMPLES ONLY (say something original in the same spirit, NEVER quote these exactly): "Haan boliye!", "Hi, kaise ho aap?" — adjust per your style. Speak respectfully with aap/tum (never tu/tuje/aaja forms). KNOW they called YOU. NEVER assume they said something or ask "kya bole the aap". 1 short line out loud now.]`,
            });
          }
        } catch (e) {
          console.warn('[GeminiLive] Initial connection greeting prompt error:', e);
        }
      }, 500);
    } catch (err: any) {
      if (!this.isActiveAttempt(connectionAttempt)) {
        throw err;
      }
      // Ignore a late SDK resolution/open event after a rejected or timed-out handshake.
      this.connectionAttempt += 1;
      this.setStatus('error');
      const msg = this.toConnectionErrorMessage(err);
      if (this.callbacks.onError) this.callbacks.onError(msg);
      throw new Error(msg);
    }
  }

  private handleServerMessage(data: any): void {
    if (!data) return;
    this.lastWsActivity = Date.now(); // Watchdog: server is alive

    // 1. Tool Calls from Gemini Live
    if (data.toolCall?.functionCalls) {
      this.awaitingAssistantReply = false;
      this.lastUserSpokenText = '';
      void this.handleToolCalls(data.toolCall.functionCalls, this.connectionAttempt);
    }

    // 2. Interruption handling (Measured VAD -> Flush Latency)
    if (data.serverContent?.interrupted) {
      const interruptionLatencyMs = this.lastUserVoiceTime > 0 ? Date.now() - this.lastUserVoiceTime : 0;
      console.info(`[GeminiLive] Interruption handled (measured latency: ${interruptionLatencyMs}ms)`);
      this.audioStreamer.flushPlayback();
      this.setStatus('listening');
      if (this.currentAssistantMessage) {
        this.updateTranscript('assistant', `${this.currentAssistantMessage} [interrupted]`, true);
        this.currentAssistantMessage = '';
      }
      this.activeAssistantTurnId = null;
      return;
    }

    // 3. Audio parts from model turn
    const parts = data.serverContent?.modelTurn?.parts;
    if (Array.isArray(parts)) {
      this.awaitingAssistantReply = false;
      this.lastUserSpokenText = '';
      this.setStatus('speaking');
      this.activeUserTurnId = null;
      for (const part of parts) {
        // Thinking / reasoning parts. NEVER shown as spoken text.
        //   * Thinking ON  (budget > 0): accumulate into `pendingReasoning` so the
        //     transcript renders a collapsible thinking box (same as other models).
        //   * Thinking OFF (budget 0): suppress entirely — nothing leaks.
        if (part.thought) {
          if ((this.config.thinkingBudget ?? 0) > 0 && part.text) {
            this.pendingReasoning += part.text;
          }
          continue;
        }
        if (part.inlineData && part.inlineData.data) {
          if (this.pendingResponseSince) {
            this.measuredResponseLatencyMs = Date.now() - this.pendingResponseSince;
            this.pendingResponseSince = 0;
          }
          this.audioStreamer.playAudioChunk(part.inlineData.data);
        }
        if (part.text) {
          // Space guard: chunks come WITHOUT trailing/leading spaces, so a raw
          // `+=` would glue words together ("Hikaiseho"). Normalize the join.
          this.appendAssistantText(part.text);
          this.updateTranscript('assistant', this.currentAssistantMessage, false);
        }
      }
    }

    // 4. Real-time Output Transcription (Assistant subtitles)
    if (data.serverContent?.outputTranscription?.text) {
      this.awaitingAssistantReply = false;
      this.lastUserSpokenText = '';
      this.activeUserTurnId = null;
      this.appendAssistantText(data.serverContent.outputTranscription.text);
      this.updateTranscript('assistant', this.currentAssistantMessage, false);
    }

    // 5. Real-time Input Transcription (User subtitles)
    if (data.serverContent?.inputTranscription?.text) {
      const recognized = data.serverContent.inputTranscription.text.trim();
      if (recognized.length > 0) {
        this.lastUserVoiceTime = Date.now();
        this.userSpeechEndedAt = Date.now();
        this.awaitingAssistantReply = true;
        this.silenceStateMachine.onSpeechActivity();
        this.silenceNudgeStreak = 0; // reset silence streak on user speech
        this.callEndAskCount = 0; // user is back — a fresh silence cycle starts
        this.lastUserSpokenText = (this.lastUserSpokenText + ' ' + recognized).trim();
        this.activeAssistantTurnId = null;
        this.currentAssistantMessage = '';
        this.pendingReasoning = '';
        this.updateTranscript('user', recognized, false);
      }

      // Check if user explicitly asked for silence / quiet study / observe screen
      const txt = data.serverContent.inputTranscription.text.toLowerCase();
      const quietCues = [
        'chup rah', 'chup rh', 'shant rah', 'kuch mat bol', 'disturb mat kar',
        'screen dekh', 'bas dekh', 'solve kar raha', 'solve kr raha', 'mai chup',
        'chup ho ja', 'quiet', 'focus karne do', 'focus krne do',
      ];
      if (quietCues.some((cue) => txt.includes(cue))) {
        this.quietFocusUntil = Date.now() + 180_000;
        console.info('[GeminiLive] User requested quiet focus mode — silence nudges suppressed for 3m');
      } else if (this.quietFocusUntil > 0 && txt.length > 5) {
        this.quietFocusUntil = 0;
      }
    }

    // 6. Turn complete — seal the assistant turn so next turn is a new bubble!
    if (data.serverContent?.turnComplete) {
      this.currentAssistantMessage = '';
      this.pendingReasoning = '';
      this.activeAssistantTurnId = null;
      this.setStatus('listening');
      this.lastTurnFinishedTime = Date.now();
    }
  }

  private async handleToolCalls(functionCalls: any[], attempt: number): Promise<void> {
    const functionResponses: any[] = [];
    this.setStatus('thinking');
    for (const fc of functionCalls) {
      if (!this.isActiveAttempt(attempt)) return;
      let output: any = { result: 'Success' };
      try {
        this.callbacks.onToolCall?.(fc.name, fc.args || {});
        if (this.callbacks.onExecuteTool) {
          output = await this.callbacks.onExecuteTool(fc.name, fc.args || {});
        }
        this.callbacks.onToolResult?.(fc.name, output);
      } catch (err: any) {
        output = { error: err?.message || 'Failed to execute tool' };
      }
      if (!this.isActiveAttempt(attempt)) return;

      let displayMessage = '';
      if (output?.error) {
        displayMessage = `Error: ${output.error}`;
      } else if (typeof output === 'string') {
        displayMessage = output;
      } else if (output && typeof output === 'object') {
        displayMessage =
          output.summary ||
          output.result ||
          output.plan ||
          output.searchResult ||
          output.context ||
          output.tests ||
          output.routine ||
          output.todos ||
          output.vaultResources ||
          output.chatSearchResults ||
          output.chatSessions ||
          output.chatTranscript ||
          output.memorySearchResults ||
          output.memory ||
          (output.currentTime ? `Current Time: ${output.currentTime}, Date: ${output.currentDate || ''}` : '') ||
          JSON.stringify(output, null, 2);
      } else {
        displayMessage = 'Tool executed';
      }

      const isOk = output?.ok !== false && !output?.error;
      const cleanResponse = typeof output === 'object' && output !== null ? output : { result: String(output) };
      const responsePayload = {
        ok: isOk,
        status: isOk ? 'success' : 'failed',
        ...cleanResponse,
      };

      this.pendingToolCalls.push({
        action: fc.name,
        ok: isOk,
        message: displayMessage,
      });

      functionResponses.push({
        id: fc.id || fc.name,
        name: fc.name,
        response: { output: responsePayload },
      });
    }

    if (this.session && this.isActiveAttempt(attempt)) {
      try {
        this.session.sendToolResponse({
          functionResponses,
        });
      } catch (e) {
        console.warn('[GeminiLive] Failed to send tool response:', e);
      }
    }
  }

  /** Send a live text message turn over the active Live session. */
  sendTextMessage(text: string, displayText?: string, toolCalls?: ChatToolCallRecord[]): void {
    const trimmed = text.trim();
    if (!trimmed) return;

    // During reconnect the session is null for the whole backoff+handshake.
    // Buffer the message instead of dropping it; it is flushed on reconnect.
    if (!this.session) {
      this.pendingTextQueue.push({ text: trimmed, displayText: displayText || trimmed, toolCalls });
      this.transcripts.push({
        id: `tr-user-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        role: 'user',
        text: (displayText || trimmed).trim(),
        timestamp: new Date().toISOString(),
      });
      if (this.callbacks.onTranscriptUpdate) {
        this.callbacks.onTranscriptUpdate([...this.transcripts]);
      }
      return;
    }

    // Reset silence observer, active turns, and speech activity anchors immediately
    this.activeAssistantTurnId = null;
    this.activeUserTurnId = null;
    this.currentAssistantMessage = '';
    this.pendingReasoning = '';
    this.silenceNudgeStreak = 0;
    this.callEndAskCount = 0;
    this.awaitingAssistantReply = true;
    this.userSpeechEndedAt = Date.now();
    this.lastUserVoiceTime = Date.now();
    this.lastTurnFinishedTime = Date.now();
    this.lastSilenceNudgeAt = Date.now();
    this.silenceStateMachine.onSpeechActivity();
    if (this.status === 'speaking') {
      this.audioStreamer.flushPlayback();
      this.setStatus('listening');
    }

    // Display clean text for the user message bubble (never dump raw tool outputs into user bubble!)
    const cleanUserText = (displayText || text).trim();
    const userId = `tr-user-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    this.transcripts.push({
      id: userId,
      role: 'user',
      text: cleanUserText,
      timestamp: new Date().toISOString(),
    });
    if (this.callbacks.onTranscriptUpdate) {
      this.callbacks.onTranscriptUpdate([...this.transcripts]);
    }

    // If tools were pre-executed, store them on pendingToolCalls so they appear inside the assistant card box!
    if (toolCalls && toolCalls.length > 0) {
      this.pendingToolCalls.push(...toolCalls);
    }

    try {
      this.session.sendRealtimeInput({
        text: trimmed,
      });
    } catch (e) {
      console.warn('[GeminiLive] Failed to send text message:', e);
    }
  }

  /** Flush any messages buffered while the session was reconnecting. */
  private flushPendingTextQueue(): void {
    if (this.pendingTextQueue.length === 0 || !this.session) return;
    const queued = this.pendingTextQueue.splice(0, this.pendingTextQueue.length);
    for (const item of queued) {
      // Reset anchors + push to the live session. The user bubble was already
      // added at buffer time (sendTextMessage) — do NOT add a second one here
      // or the message shows up twice after reconnect.
      this.activeAssistantTurnId = null;
      this.activeUserTurnId = null;
      this.currentAssistantMessage = '';
      this.pendingReasoning = '';
      this.silenceNudgeStreak = 0;
      this.callEndAskCount = 0;
      this.awaitingAssistantReply = true;
      this.userSpeechEndedAt = Date.now();
      this.lastUserVoiceTime = Date.now();
      this.lastTurnFinishedTime = Date.now();
      this.lastSilenceNudgeAt = Date.now();
      this.silenceStateMachine.onSpeechActivity();
      if (this.status === 'speaking') {
        this.audioStreamer.flushPlayback();
        this.setStatus('listening');
      }
      if (item.toolCalls && item.toolCalls.length > 0) {
        this.pendingToolCalls.push(...item.toolCalls);
      }
      try {
        this.session.sendRealtimeInput({ text: item.text });
      } catch (e) {
        console.warn('[GeminiLive] Failed to flush pending text message:', e);
      }
    }
    if (this.callbacks.onTranscriptUpdate) {
      this.callbacks.onTranscriptUpdate([...this.transcripts]);
    }
  }

  /**
   * Append a streamed text chunk to the current assistant message while never
   * gluing words together. Gemini live chunks arrive WITHOUT surrounding
   * spaces, so a raw `+=` produces "Hikaiseho". This keeps exactly one space
   * between the existing text and the new chunk (unless the chunk already
   * starts/ends with whitespace or is punctuation).
   */
  private appendAssistantText(chunk: string): void {
    if (!chunk) return;
    const existing = this.currentAssistantMessage;
    if (!existing) {
      this.currentAssistantMessage = chunk.trimStart();
      return;
    }
    // Only insert a space when the existing text ends with an actual word
    // character AND the new chunk starts with one. Punctuation (.,!?) and
    // chunks that already carry leading/trailing whitespace are left as-is
    // so "hai." or " kaise" don't get an extra space injected.
    const lastChar = existing[existing.length - 1];
    const firstChar = chunk[0];
    const needsSpace =
      /\w/.test(lastChar) &&
      /\w/.test(firstChar);
    this.currentAssistantMessage = existing + (needsSpace ? ' ' : '') + chunk;
  }

  private updateTranscript(role: 'user' | 'assistant', text: string, isInterrupted = false): void {
    if (role === 'assistant') {
      const existingItem = this.activeAssistantTurnId
        ? this.transcripts.find((t) => t.id === this.activeAssistantTurnId)
        : null;

      if (existingItem && !existingItem.isInterrupted) {
        existingItem.text = text;
        existingItem.isInterrupted = isInterrupted;
        if (this.pendingReasoning) {
          existingItem.reasoning = (existingItem.reasoning || '') + this.pendingReasoning;
          this.pendingReasoning = '';
        }
        if (this.pendingToolCalls.length > 0) {
          existingItem.toolCalls = [...(existingItem.toolCalls || []), ...this.pendingToolCalls];
          this.pendingToolCalls = [];
        }
      } else {
        const id = `tr-asst-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        this.activeAssistantTurnId = id;
        const activeCalls = this.pendingToolCalls.length > 0 ? [...this.pendingToolCalls] : undefined;
        const reason = this.pendingReasoning || undefined;
        this.pendingToolCalls = [];
        this.pendingReasoning = '';
        this.transcripts.push({
          id,
          role: 'assistant',
          text,
          timestamp: new Date().toISOString(),
          isInterrupted,
          reasoning: reason,
          toolCalls: activeCalls,
        });
      }
    } else {
      const existingItem = this.activeUserTurnId
        ? this.transcripts.find((t) => t.id === this.activeUserTurnId)
        : null;

      if (existingItem && !existingItem.isInterrupted) {
        existingItem.text = text;
        existingItem.isInterrupted = isInterrupted;
      } else {
        const id = `tr-user-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        this.activeUserTurnId = id;
        this.transcripts.push({
          id,
          role: 'user',
          text,
          timestamp: new Date().toISOString(),
          isInterrupted,
        });
      }
    }

    if (this.callbacks.onTranscriptUpdate) {
      this.callbacks.onTranscriptUpdate([...this.transcripts]);
    }
  }

  private isUserTalkingOverThreshold = false;
  private audioPreRollBuffer: string[] = [];
  private activeAssistantTurnId: string | null = null;
  private activeUserTurnId: string | null = null;
  private lastSilenceNudgeAt = 0;
  private isReconnecting = false;
  private reconnectAttempts = 0;
  /**
   * Review 7 / P2: the reconnect worker is a single, cancellable task.
   * - `reconnectTimer` holds the in-flight backoff setTimeout so disconnect()
   *   can clearTimeout() it the moment the user hangs up (immediate cancel,
   *   no wasted wakeup).
   * - `reconnectEpoch` is bumped on EVERY disconnect. The worker captures the
   *   epoch before sleeping and aborts if it changed when it wakes — a stale
   *   worker can therefore never mutate a newer session or revive a hung-up
   *   call (its pending backoff dies with the epoch).
   */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectEpoch = 0;
  private currentMediaStream: MediaStream | null = null;
  private activeApiKey: string | null = null;
  /** SmartRotator server root (no /v1) used for the Live WebSocket relay. */
  private activeBaseUrl: string | null = null;
  private isUserExplicitlyClosed = false;
  private lastWsActivity = Date.now(); // diagnostic only; silence is not a transport failure
  private audioFocusListener: { remove: () => Promise<void> } | null = null;
  /** Single-owner flag: audio focus is acquired once (pre-capture), not per call-site. */
  private callAudioFocusGranted = false;
  /** Route that was actually applied by the system (may differ after fallback). */
  private currentAudioRoute: LiveAudioRoute = 'speaker';
  /**
   * P7: in-flight `resetNativeAudioRoute()` from the last disconnect. Stored so
   * the NEXT setupCallAudio() can await it — otherwise the fire-and-forget reset
   * could finish AFTER the new focus/route setup and revert the freshly selected
   * communication route/mode (the reset/setup race).
   */
  private pendingAudioReset: Promise<void> | null = null;
  private connectionAttempt = 0;
  private manuallyMuted = false;
  private audioFocusPaused = false;
  private pendingResponseSince = 0;
  private measuredResponseLatencyMs = 0;

  private isActiveAttempt(attempt: number): boolean {
    return attempt === this.connectionAttempt && !this.isUserExplicitlyClosed;
  }

  private async withConnectionTimeout<T>(connection: Promise<T>, attempt: number): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        connection,
        new Promise<T>((_, reject) => {
          timeout = setTimeout(() => {
            if (this.isActiveAttempt(attempt)) {
              reject(new Error(`Gemini Live connection timed out after ${GeminiLiveClient.CONNECTION_TIMEOUT_MS / 1000} seconds. Check your network, API key, and selected model.`));
            }
          }, GeminiLiveClient.CONNECTION_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private toConnectionErrorMessage(error: any): string {
    const message = String(error?.message || 'Failed to establish Gemini Live connection');
    if (this.isModelAvailabilityError(error)) {
      return `Selected Live model “${this.config.model}” is unavailable. Choose another Live-compatible model and try again.`;
    }
    return message;
  }

  /**
   * Build the GoogleGenAI constructor options. When connecting through
   * SmartRotator we pass httpOptions.baseUrl = the bare gateway root, which the
   * SDK uses to form wss://<root>/ws/google.ai.generativelanguage.v1beta.
   * GenerativeService.BidiGenerateContent?key=<apiKey> (our Google-exact relay).
   * For the native Google provider baseUrl stays undefined → SDK default.
   */
  private buildGenAiOptions(apiKey: string): { apiKey: string; httpOptions?: { baseUrl: string } } {
    const base = this.activeBaseUrl?.trim();
    if (base) {
      try {
        // baseUrl is already normalized upstream (normalizeServerRoot strips
        // /v1, /api/v1, query & hash, trailing slashes). Do NOT blank the
        // pathname — a gateway deployed under a path prefix (e.g. /my-gateway)
        // must keep that prefix; only drop query/hash and a trailing slash so
        // the SDK appends its own /ws/...BidiGenerateContent path.
        const u = new URL(base);
        u.search = '';
        u.hash = '';
        u.pathname = u.pathname.replace(/\/+$/, '');
        return { apiKey, httpOptions: { baseUrl: u.toString().replace(/\/+$/, '') } };
      } catch {
        // Invalid URL — let the SDK route to the Google default.
        return { apiKey };
      }
    }
    return { apiKey };
  }

  private isModelAvailabilityError(error: any): boolean {
    return /model|not found|unsupported/i.test(String(error?.message || ''));
  }

  private isPermanentConnectionError(error: any): boolean {
    const message = String(error?.message || error || '').toLowerCase();
    return this.isModelAvailabilityError(error) || isPermanentLiveConnectionError(message);
  }

  /** Start recording user voice & streaming audio chunks. */
  async startVoiceStreaming(mediaStream: MediaStream): Promise<void> {
    // Single-owner focus: connect() already acquired focus via setupCallAudio().
    // This guard only fires for DIRECT callers (e.g. a session restored without
    // going through connect) — it never double-acquires on the normal path.
    if (!this.callAudioFocusGranted) {
      if (!await requestNativeCallAudioFocus()) {
        this.setStatus('error');
        throw new Error('Microphone cannot start because audio focus was denied.');
      }
      this.callAudioFocusGranted = true;
    }
    this.currentMediaStream = mediaStream;
    this.audioStreamer.setOnPlaybackEnded(() => {
      if (this.status === 'speaking') {
        this.setStatus('listening');
        this.lastTurnFinishedTime = Date.now();
      }
    });
    await this.audioStreamer.startRecording(
      mediaStream,
      (pcm16Base64, rmsLevel = 0) => {
        this.sendAudioChunk(pcm16Base64, rmsLevel);
      },
      (inputLevel) => {
        const talking = inputLevel > 0.035;
        this.isUserTalkingOverThreshold = talking;
        // Register user speech activity
        if (talking) {
          if (!this.userInterruptStreakStartedAt) this.userInterruptStreakStartedAt = Date.now();
          // Barge-in debounce: ek hi 80ms analyser spike (room echo, keyboard,
          // door) Misa ki voice nahi kaat sakta. Sustained user speech
          // (>=200ms) hone par hi playback flush hota hai — voice cutting fix.
          if (this.status === 'speaking' && Date.now() - this.userInterruptStreakStartedAt >= 200) {
            this.userInterruptStreakStartedAt = Date.now();
            this.audioStreamer.flushPlayback();
            this.setStatus('listening');
          }
        } else {
          this.userInterruptStreakStartedAt = 0;
        }
        if (inputLevel > 0.025 && this.status === 'connected') {
          this.setStatus('listening');
        }
        this.updateStats(inputLevel, 0);
      },
      (outputLevel) => {
        this.updateStats(0, outputLevel);
      },
    );
  }

  private async setupCallAudio(): Promise<void> {
    // P7: serialize with the previous disconnect's reset. disconnect(true) only
    // STORES the reset promise; awaiting it here guarantees the old route/mode
    // teardown fully completes before we apply the new focus/route — the
    // reset/setup race is closed by ordering, not by timing luck.
    if (this.pendingAudioReset) {
      await this.pendingAudioReset;
      this.pendingAudioReset = null;
    }
    // SINGLE-SOURCE FOCUS (P1): if the pre-capture path already acquired
    // native focus and handed it in via connect({audioFocusAlreadyGranted}),
    // the flag is already true here — so we NEVER issue a second
    // requestAudioFocus for the same call startup. Only reconnect/auto paths
    // (no handed-off flag after disconnect() reset) request fresh.
    if (!this.callAudioFocusGranted) {
      if (!await requestNativeCallAudioFocus()) {
        // Fail cleanly — never let a silent-audio session appear connected.
        throw new Error('Microphone cannot start because audio focus was denied.');
      }
      this.callAudioFocusGranted = true;
    }
    // Route is applied AFTER focus and AWAITED — ordered, single-owner audio init.
    // P3: the native result is VERIFIED, not swallowed. setNativeAudioRoute()
    // resolves null on native failure (missing Bluetooth device for the
    // requested route, etc.). A requested route that was never applied must
    // not silently pass as "connected on bluetooth".
    // ── Auto-route: NEVER default the call to the loudspeaker ──
    // If no explicit route was pinned (stock default 'speaker' means "auto"),
    // auto-prefer a Bluetooth headset, then the phone earpiece, and only fall
    // back to the loudspeaker when NO other device is available. The stock
    // default `'speaker'` is treated as AUTO here so a connected Bluetooth
    // headset "just works" instead of blasting the call out of the phone
    // speaker. A route the user EXPLICITLY chose in settings (non-default) or
    // via the in-call menu is honored verbatim below.
    let desiredRoute: LiveAudioRoute = this.config.defaultAudioRoute ?? 'speaker';
    if (desiredRoute === 'speaker') {
      // Treat the stock 'speaker' default as AUTO at call start so a connected
      // Bluetooth headset (then earpiece) is preferred over blasting the call
      // out of the phone speaker. Config is left untouched — currentAudioRoute
      // below records the ACTUAL applied device.
      const available = await getAvailableNativeAudioRoutes();
      if (available) {
        if (available.bluetooth) desiredRoute = 'bluetooth';
        else if (available.earpiece) desiredRoute = 'earpiece';
      }
    }
    const applied = await setNativeAudioRoute(desiredRoute);
    if (applied) {
      this.currentAudioRoute = (applied.route as LiveAudioRoute) || desiredRoute;
      if (applied.deviceType && applied.deviceType !== 'BUILTIN_SPEAKER') {
        console.info(`[GeminiLive] Audio route applied: ${applied.route} (${applied.deviceType}${applied.deviceName ? ` - ${applied.deviceName}` : ''})`);
      }
    } else if (desiredRoute !== 'speaker') {
      // Explicit fallback: a failed earpiece/bluetooth apply is not fatal to the
      // call, but we must NOT pretend the wanted route is active. Fall back to
      // the always-available loudspeaker and report the actual route.
      console.warn(`[GeminiLive] Requested audio route "${desiredRoute}" was not applied by the system — falling back to speaker.`);
      const fallback = await setNativeAudioRoute('speaker');
      if (!fallback) {
        // Review-7 P1: on NATIVE even the loudspeaker was refused — abort the
        // startup instead of letting the session claim a route the system never
        // set (the caller rolls back focus via its single teardown path).
        // On web setNativeAudioRoute() is a no-op returning null — accept it.
        if (isNativeAudioPlatform()) {
          throw new Error('No audio route available (speaker fallback failed).');
        }
        this.currentAudioRoute = 'speaker';
      } else {
        this.currentAudioRoute = (fallback?.route as LiveAudioRoute) || 'speaker';
      }
    } else {
      // desiredRoute IS speaker and nothing reported back (e.g. web/no-op) — no
      // route to verify; keep the default.
      this.currentAudioRoute = 'speaker';
    }
  }

  private sendAudioChunk(pcm16Base64: string, rmsLevel = 0): void {
    if (!this.session) return;

    const now = Date.now();
    const isSpeech = rmsLevel > 0.032 || this.isUserTalkingOverThreshold;

    // Barge-in debounce (shared with the analyser path): a single transient
    // chunk (room echo, keyboard, cough) must not snip the assistant's voice.
    // Only SUSTAINED user speech (>=200ms) flushes playback.
    if (isSpeech && !this.userInterruptStreakStartedAt) this.userInterruptStreakStartedAt = now;
    const sustainedSpeech =
      isSpeech && this.userInterruptStreakStartedAt > 0 && now - this.userInterruptStreakStartedAt >= 200;

    if (this.status === 'speaking' && sustainedSpeech) {
      this.userInterruptStreakStartedAt = now;
      this.audioStreamer.flushPlayback();
      this.setStatus('listening');
      this.lastUserVoiceTime = now;
      this.silenceStateMachine.onSpeechActivity();
      while (this.audioPreRollBuffer.length > 0) {
        const bufferedChunk = this.audioPreRollBuffer.shift();
        if (bufferedChunk) {
          try {
            this.session.sendRealtimeInput({
              audio: {
                data: bufferedChunk,
                mimeType: 'audio/pcm;rate=16000',
              },
            });
          } catch {
            // Ignored
          }
        }
      }
    }

    // Keep rolling pre-roll buffer of recent audio (~200ms)
    this.audioPreRollBuffer.push(pcm16Base64);
    if (this.audioPreRollBuffer.length > 5) {
      this.audioPreRollBuffer.shift();
    }

    // Skip acoustic room echo silence ONLY after a real pause. A 220ms
    // hang-time bridges syllable/breath gaps so the user's soft interjections
    // are never snipped mid-word; echo suppression still kicks in once the
    // user has actually stopped talking.
    if (this.status === 'speaking' && !isSpeech && now - this.lastUserVoiceTime > 220) {
      return;
    }

    if (isSpeech) {
      this.lastUserVoiceTime = now;
      this.silenceStateMachine.onSpeechActivity();
    }

    try {
      this.session.sendRealtimeInput({
        audio: {
          data: pcm16Base64,
          mimeType: 'audio/pcm;rate=16000',
        },
      });
      if (isSpeech && !this.pendingResponseSince) this.pendingResponseSince = Date.now();
    } catch (e) {
      console.warn('[GeminiLive] Failed to send audio chunk:', e);
    }
  }

  /** Start streaming camera frames (Front or Back lens). */
  async startCameraStream(lens: LiveCameraLens): Promise<MediaStream> {
    const attempt = this.connectionAttempt;
    const stream = await this.visionStreamer.startCamera(lens, this.config.videoFps, (jpegBase64) => {
      // NOTE (M6): deliberately NOT capturing `attempt` here. The callback
      // resolves the CURRENT connectionAttempt at send time (sendVideoFrame's
      // default param), so after a reconnect the still-running camera stream
      // keeps sending frames to the new session instead of silently dropping
      // them because it was bound to a stale attempt.
      this.sendVideoFrame(jpegBase64);
    });

    if (stream && this.session) {
      setTimeout(() => {
        if (!this.isActiveAttempt(attempt)) return;
        try {
          this.session?.sendRealtimeInput({
            text: `[Camera is on. Look at the camera feed right now and speak 1 short, natural Hinglish line directly about what you see (e.g. textbook, notebook, desk, or empty chair). Do NOT use robotic greeting scripts.]`,
          });
        } catch (e) {
          console.warn('[GeminiLive] Failed to send camera start prompt:', e);
        }
      }, 700);
    }

    return stream;
  }

  /** Flip between Front and Back camera. */
  async flipCamera(): Promise<MediaStream> {
    return this.visionStreamer.switchLens(this.config.videoFps, (jpegBase64) => {
      // M6: current-attempt resolution at send time (see startCameraStream).
      this.sendVideoFrame(jpegBase64);
    });
  }

  /** Start streaming Desktop Screen Share. */
  async startScreenStream(onEnded?: () => void): Promise<MediaStream | null> {
    const attempt = this.connectionAttempt;
    const stream = await this.visionStreamer.startScreenShare(this.config.screenFps, (jpegBase64) => {
      // M6: current-attempt resolution at send time (see startCameraStream).
      this.sendVideoFrame(jpegBase64);
    }, onEnded);

    if (stream && this.session) {
      setTimeout(() => {
        if (!this.isActiveAttempt(attempt)) return;
        try {
          this.session?.sendRealtimeInput({
            text: `[Screen share is on. Look at what is open on the screen right now and comment or ask directly about what you see in 1 short, natural, friendly Hinglish sentence (e.g. specific question, YouTube video, notes, or app). Do NOT say 'main screen dekh rahi hu', speak directly about the screen content.]`,
          });
        } catch (e) {
          console.warn('[GeminiLive] Failed to send screen start prompt:', e);
        }
      }, 700);
    }

    return stream;
  }

  /** Stop camera or screen video stream. */
  stopVision(): void {
    this.visionStreamer.stop();
  }

  stopVisionStream(): void {
    this.visionStreamer.stop();
  }

  private sendVideoFrame(jpegBase64: string, attempt = this.connectionAttempt): void {
    if (!this.session || !this.isActiveAttempt(attempt)) return;
    try {
      this.framesSentCount += 1;
      this.session.sendRealtimeInput({
        video: {
          data: jpegBase64,
          mimeType: 'image/jpeg',
        },
      });
      this.updateStats(0, 0);
    } catch (e) {
      console.warn('[GeminiLive] Failed to send video frame:', e);
    }
  }

  setMuted(muted: boolean): void {
    this.manuallyMuted = muted;
    this.applyMicrophoneMute();
  }

  /** Route that the system actually applied (correct even after speaker fallback). */
  getCurrentAudioRoute(): LiveAudioRoute {
    return this.currentAudioRoute;
  }

  private applyMicrophoneMute(): void {
    this.audioStreamer.setMuted(this.manuallyMuted || this.audioFocusPaused);
  }

  private async installAudioFocusListener(): Promise<void> {
    if (this.audioFocusListener) return;
    // Bind this async registration to the CURRENT connection attempt. A
    // hangup/restart can land while addNativeAudioFocusListener is still in
    // flight (it's awaited). If so, the stale resolve must NOT be assigned —
    // otherwise (a) the next call's registration is skipped by the guard above
    // and (b) a stale listener could fire focus-loss against a fresh call.
    // Resolve first, verify second, assign only if still the active attempt.
    const attempt = this.connectionAttempt;
    const listener = await addNativeAudioFocusListener(async (focusChange) => {
      // Review-8 P1 (focus-loss/regain authoritative lifecycle):
      // Focus is local Android audio policy — not a network error.
      // AUDIOFOCUS_LOSS (-1) is permanent: another app (phone call, navigation)
      // has claimed the audio session. In a live call this is terminal: the
      // session cannot continue without audio, so disconnect rather than sit
      // in a zombie state.  AUDIOFOCUS_LOSS_TRANSIENT (-2) is temporary (e.g.
      // a short notification) — pause capture + flush stale speech, and resume
      // when regain fires. AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK (-3) keeps
      // playback at reduced volume; no capture change needed.  AUDIOFOCUS_GAIN
      // (1) restores capture + volume + route without a second focus request.
      if (focusChange === -1) {
        // Permanent loss: acknowledge the revocation in JS so the next call
        // starts clean, then tear down the session.  disconnect() will also
        // clear callAudioFocusGranted, but writing it here first makes the
        // causal intent clear.
        this.audioFocusPaused = true;
        this.applyMicrophoneMute();
        this.audioStreamer.flushPlayback();
        this.setStatus('background-active');
        this.callbacks.onError?.('Call ended: audio focus was claimed by another app or phone call.');
        // Permanent loss ends the call: disconnect as an explicit close
        // (preserveReconnectState=false) so no reconnect/rollback resurrects it
        // and the native focus is abandoned on teardown.
        this.disconnect(false);
      } else if (focusChange === -2) {
        // Transient loss (e.g. a short notification): keep the session alive
        // and mute capture, but DO NOT flush the in-flight speech.
        // Flushing here was the "notification aate hi voice cut" bug: a brief
        // notification blip chops the whole sentence being spoken mid-word.
        // Let the already-scheduled speech finish (~<600ms), then resume
        // cleanly on regain — that keeps the live voice stable through a
        // notification without dropping what Misa is currently saying.
        this.audioFocusPaused = true;
        this.applyMicrophoneMute();
        if (this.status !== 'speaking') {
          this.setStatus('background-active');
        }
      } else if (focusChange === 1) {
        // Regain: restore capture + full volume.  Do NOT re-request focus —
        // we are still the focus holder; Android only asked us to pause.
        this.audioFocusPaused = false;
        this.applyMicrophoneMute();
        this.audioStreamer.setOutputVolume(1);
        // Review-9 P1.12 + review-10 P1 (focus-regain overwrite): route
        // restoration is TRANSACTIONAL — request the desired route, VERIFY what
        // native actually applied, then update JS state; if it failed,
        // deterministically fall back to the loudspeaker. Only transition the
        // session to 'listening' when the route actually restored (ok === true).
        // Previously the caller unconditionally set 'listening' AFTER the
        // restore, clobbering the 'error' state emitted on a terminal native
        // failure (routes refused) and leaving the call falsely "listening"
        // with no working output route.
        const restored = await this.restoreAudioRouteTransactional();
        if (restored.ok && this.session) {
          if (this.status !== 'speaking') {
            this.setStatus('listening');
          }
        }
      } else if (focusChange === -3) {
        // CAN_DUCK: gentle volume reduction so AI speech remains audible and doesn't sound chopped/stuttering.
        this.audioStreamer.setOutputVolume(0.85);
      }
    });

    // addNativeAudioFocusListener resolves null on non-native platforms; in
    // that case there is no listener to bind or remove.
    if (!listener) return;

    // Post-await generation gate: if the user hung up or a new call started
    // while registration was in flight, discard this stale listener instead of
    // binding it to the (possibly new) runtime. Remove it so it can't leak and
    // can't block the next call's own registration.
    if (!this.isActiveAttempt(attempt)) {
      try {
        await listener.remove();
      } catch {
        /* ignore */
      }
      return;
    }
    this.audioFocusListener = listener;
  }

  /**
   * Switch audio output route (Speaker / Earpiece / Bluetooth).
   *
   * Transactional: requests the route, VERIFIES what native actually applied,
   * falls back to the loudspeaker if the desired route failed to confirm (e.g.
   * a Bluetooth SCO headset that never converges), and keeps `currentAudioRoute`
   * truthful so the UI never shows "Bluetooth" while audio is actually on the
   * phone speaker. Returns the ACTUAL applied route so the overlay can reflect
   * reality instead of the optimistically-selected label.
   */
  async setAudioRoute(route: LiveAudioRoute): Promise<LiveAudioRoute> {
    if (route !== this.config.defaultAudioRoute) {
      this.config.defaultAudioRoute = route;
    }
    const { actualRoute } = await this.restoreAudioRouteTransactional();
    return actualRoute;
  }

  /**
   * Review-9 P1.12 + review-10 P1: transactional route restoration (used on
   * focus regain). request → VERIFY what native actually applied → update JS
   * state. If the desired route failed to apply, deterministically fall back to
   * the loudspeaker and VERIFY that too. Never leave JS believing a route is
   * active when native landed on another/unknown route.
   *
   * Returns `{ ok, actualRoute }` (NOT void) so the caller can distinguish a
   * successfully-restored route (ok === true → may resume 'listening') from a
   * terminal failure (ok === false → the status/error was already emitted and
   * the caller must NOT clobber it). This closes the focus-regain overwrite:
   * previously the terminal `setStatus('error')` inside this method was
   * immediately overwritten by the caller's unconditional `setStatus('listening')`.
   */
  private async restoreAudioRouteTransactional(): Promise<{ ok: boolean; actualRoute: LiveAudioRoute }> {
    const desired = this.config.defaultAudioRoute ?? 'speaker';
    const applied = await setNativeAudioRoute(desired);
    if (applied) {
      this.currentAudioRoute = (applied.route as LiveAudioRoute) || desired;
      return { ok: true, actualRoute: this.currentAudioRoute };
    }
    if (desired !== 'speaker') {
      console.warn(`[GeminiLive] Route "${desired}" not confirmed on restore — falling back to speaker.`);
      const fallback = await setNativeAudioRoute('speaker');
      if (fallback) {
        this.currentAudioRoute = (fallback.route as LiveAudioRoute) || 'speaker';
        return { ok: true, actualRoute: this.currentAudioRoute };
      }
      if (!isNativeAudioPlatform()) {
        this.currentAudioRoute = 'speaker';
        return { ok: true, actualRoute: this.currentAudioRoute };
      }
      // Native and even the speaker fallback refused — terminal audio error.
      // The caller must NOT overwrite this 'error' state with a false 'listening'.
      this.setStatus('error');
      this.callbacks.onError?.('Audio route could not be restored. Please retry.');
      return { ok: false, actualRoute: this.currentAudioRoute };
    }
    // Speaker requested but not confirmed (web no-op is acceptable).
    this.currentAudioRoute = 'speaker';
    return { ok: true, actualRoute: this.currentAudioRoute };
  }

  private updateStats(inputVolume = 0, outputVolume = 0): void {
    if (this.callbacks.onStatsUpdate) {
      this.callbacks.onStatsUpdate({
        latencyMs: this.measuredResponseLatencyMs,
        inputVolume,
        outputVolume,
        fps: this.visionStreamer.getIsCameraActive() || this.visionStreamer.getIsScreenSharing() ? this.config.videoFps : 0,
        framesSent: this.framesSentCount,
      });
    }
  }

  private startKeepAliveAndSilenceObserver(): void {
    this.lastWsActivity = Date.now();
    // Preserve the silence/anchor timer across reconnects — a reconnect is a
    // continuation, not a fresh call, so the streak and tunnel state carry on.
    if (this.reconnectAttempts === 0) this.lastTurnFinishedTime = Date.now();
    if (this.silenceObserverTimer) clearInterval(this.silenceObserverTimer);
    // The SDK owns WebSocket protocol keepalive. Never inject fake PCM silence:
    // it can alter VAD/turn detection, and user silence is not a failed transport.
    // This observer is companion behaviour only, never a connection watchdog.
    this.silenceObserverTimer = setInterval(() => {
      if (!this.session || this.status === 'speaking' || this.status === 'thinking') return;
      const isCallActive =
        this.status === 'connected' ||
        this.status === 'listening' ||
        this.status === 'background-active' ||
        this.status === 'background-pip-active';
      if (!isCallActive) return;

      // If user explicitly asked for quiet / focus ("mai chup rahunga", "screen dekho", etc.):
      // Respect user's explicit wish! Do NOT nudge or interrupt with small talk!
      if (Date.now() < this.quietFocusUntil) {
        return;
      }

      // Calculate silence elapsed CONVERSATIONALLY — from the last real turn
      // boundary (user finished speaking / assistant finished talking / a text
      // message was sent). We intentionally do NOT anchor on `lastUserVoiceTime`
      // here: that field is advanced by every live microphone frame while
      // `isSpeech` is true, and on a weak/marginal link room noise / encoder
      // artifacts can keep `rmsLevel` crossing the speech threshold frame after
      // frame, keeping `lastUserVoiceTime` freshly-pinned forever so the silence
      // nudge can never fire. The turn anchor is only advanced by genuine
      // communicative boundaries, so true conversational silence (the condition
      // this observer exists to detect) is measured correctly even when ambient
      // mic noise is present.
      const lastActivityAnchor = this.lastTurnFinishedTime || 0;
      const silenceDurationSec = (Date.now() - lastActivityAnchor) / 1000;

      // ── Fast Stalled-Turn Watchdog (User Spoke Real Words but Model Didn't Reply) ──
      // In a live voice call, if the student spoke actual words and 3.5s pass without
      // Gemini generating a reply, kick the stalled turn with their exact words!
      const spokenWords = this.lastUserSpokenText.slice(-300).trim();
      const userSpokeRealWords = this.awaitingAssistantReply && spokenWords.length > 0 && this.userSpeechEndedAt > 0;
      const speechWaitDurationSec = (Date.now() - this.userSpeechEndedAt) / 1000;
      if (userSpokeRealWords && speechWaitDurationSec >= 3.5 && (Date.now() - this.lastSilenceNudgeAt > 8000)) {
        this.awaitingAssistantReply = false;
        this.lastSilenceNudgeAt = Date.now();
        this.lastTurnFinishedTime = Date.now();
        this.lastUserSpokenText = '';
        try {
          this.session.sendRealtimeInput({
            text: `[SYSTEM EVENT: The student said: "${spokenWords}". Answer their spoken words directly out loud right now!]`,
          });
          console.info(`[GeminiLive] Fast reply watchdog kicked stalled turn for recognized words: "${spokenWords}"`);
        } catch (e) {
          console.warn('[GeminiLive] Fast reply watchdog error:', e);
        }
        return;
      }

      // ── Proactive Companion Silence Context (single data line) ──
      // All prompt engineering for nudge tone/behavior lives in the system prompt
      // (OBSERVER MODE block). Here we just send raw context data; the model
      // decides how to respond based on streak, focus, camera state, etc.
      const isBackground = this.status === 'background-active' || this.status === 'background-pip-active';
      const isCameraOrScreen = this.visionStreamer.getIsCameraActive() || this.visionStreamer.getIsScreenSharing();
      const silenceThresholdSec = isCameraOrScreen ? 20 : isBackground ? 22 : 25;

      // ── Escalating cadence — we NEVER hard-stop ──
      // Streak grows → gaps grow (40s → 90s → 180s). Misa stays a present
      // companion even after many silent rounds; complete silence is impossible.
      const cadenceMs =
        this.silenceNudgeStreak <= 4
          ? (isBackground ? 35_000 : 40_000)
          : this.silenceNudgeStreak <= 6
            ? (isBackground ? 75_000 : 90_000)
            : (isBackground ? 150_000 : 180_000);

      if (silenceDurationSec >= silenceThresholdSec && (Date.now() - this.lastSilenceNudgeAt > cadenceMs)) {
        this.lastSilenceNudgeAt = Date.now();
        this.lastTurnFinishedTime = Date.now();
        this.silenceNudgeStreak += 1;

        const callDurationMin = Math.round((Date.now() - this.sessionStartTime) / 60000);
        const rel = relationshipManager.getState();
        const focusTopic = rel.commitments[0]?.topic || rel.currentSubject || 'General';
        const baseCtx = `silence ~${Math.round(silenceDurationSec)}s · call ${callDurationMin}m · camera ${isCameraOrScreen ? 'ON' : 'OFF'} · streak ${this.silenceNudgeStreak} · focus: "${focusTopic}"`;

        // ── Smart stop: jab student genuinely busy hai (vision real activity
        // dekh raha hai) to TWICE pucho — spaced out — "call cut karu ya rakhun?",
        // phir sparse quiet-companion phase. Kabhi hard silence cap nahi. ──
        let promptText: string;
        if (isCameraOrScreen && this.callEndAskCount < 2 && this.silenceNudgeStreak >= 5) {
          this.callEndAskCount += 1;
          promptText =
            this.callEndAskCount === 1
              ? `[CALL DECISION ASK 1/2] Student looks genuinely busy on screen (${baseCtx}). ASK THEM OUT LOUD, in your own natural words (aap/tum), ONE short caring question: should I end the call so you can focus, or keep the line open? Then WAIT silently for their spoken answer — do not repeat the question.`
              : `[CALL DECISION ASK 2/2] Long quiet study stretch (${baseCtx}). ASK THEM OUT LOUD, in your own natural words (aap/tum), ONE gentle question: do you want me to hang up now, or shall I stay quietly? Then WAIT silently for their spoken answer — do not repeat the question.`;
        } else if (this.silenceNudgeStreak > 6) {
          promptText = `[QUIET COMPANION] ${baseCtx}. The student is deep in quiet work. Do NOT ask questions and do NOT end the call on your own. If you speak at all, say at most 1 short warm whisper acknowledging their focus (your own words), otherwise stay silently present.`;
        } else {
          promptText = `[CONTEXT UPDATE] ${baseCtx}`;
        }

        try {
          this.session.sendRealtimeInput({ text: promptText });
          console.info(`[GeminiLive] Silence context update (streak=${this.silenceNudgeStreak} ask=${this.callEndAskCount})`);
        } catch (e) {
          console.warn('[GeminiLive] Silence context update error:', e);
        }
      }
    }, 2000);
  }

  private async handleAutoReconnect(): Promise<void> {
    if (this.isReconnecting || this.isUserExplicitlyClosed) return;
    if (!canRetryLiveConnection(this.reconnectAttempts)) {
      this.setStatus('error');
      this.callbacks.onError?.('Network connection could not be restored. End the call or try again.');
      return;
    }

    this.isReconnecting = true;
    this.reconnectAttempts += 1;
    // Review-9 P2.17 observability: reconnect attempt + generation/epoch + the
    // terminal-retry distinction are all surfaced so prolonged failure is
    // diagnosable; the safety-valve exhaustion sets status 'error' (distinct
    // from 'reconnecting') above/below — never silently retry forever while
    // looking "connected".
    console.info(`[GeminiLive] reconnect attempt=${this.reconnectAttempts} gen=${this.connectionAttempt} epoch=${this.reconnectEpoch} lastTransportActivity=${this.lastWsActivity}`);
    this.setStatus('reconnecting');

    if (this.silenceObserverTimer) { clearInterval(this.silenceObserverTimer); this.silenceObserverTimer = null; }

    // Exponential backoff (750ms → 1.5s → 3s → 6s → 12s → capped 20s) +
    // jitter — a real network blip gets several chances, but a down link
    // can't spin forever. The timer is stored so a hangup/direct-connect can
    // cancel it immediately (P2); the epoch token (captured above) makes any
    // worker that woke up after a disconnect abort instead of racing.
    const epoch = this.reconnectEpoch;
    const delay = Math.min(20_000, 750 * 2 ** (this.reconnectAttempts - 1)) + Math.floor(Math.random() * 400);
    await new Promise<void>((resolve) => {
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        resolve();
      }, delay);
    });

    if (epoch !== this.reconnectEpoch || this.isUserExplicitlyClosed) {
      // A disconnect happened while we slept (hangup, or someone connected
      // directly e.g. reconnectWithNewConfig). This worker is stale — stop
      // without touching any session.
      this.isReconnecting = false;
      return;
    }

    try {
      if (!this.activeApiKey) throw new Error('No active API key');
      // Extra epoch gate right before connect(): the user may have hung up in
      // the synchronous gap after the timer fired — connect() must not revive
      // a call they explicitly ended.
      if (epoch !== this.reconnectEpoch || this.isUserExplicitlyClosed) {
        this.isReconnecting = false;
        return;
      }
      await this.connect(this.activeApiKey, {
        isIncomingCall: this.isIncomingCallSession,
        reason: this.incomingCallReason,
        // Preserve 3-way origin across reconnect so greeting/origin block
        // don't degrade to the wrong role mid-call.
        origin: this.callOrigin,
      });
      // Review-8 P1: strict invariant — once the epoch is stale (a hangup landed
      // during the handshake/audio setup) this worker must not perform ANY
      // further session mutation.
      if (epoch !== this.reconnectEpoch || this.isUserExplicitlyClosed) {
        this.isReconnecting = false;
        return;
      }
      if (this.currentMediaStream) {
        await this.startVoiceStreaming(this.currentMediaStream);
      }
      // Review-8 P1: same guard before the session mutation (vision re-orient).
      if (epoch !== this.reconnectEpoch || this.isUserExplicitlyClosed) {
        this.isReconnecting = false;
        return;
      }
      // M6: vision capture survives the reconnect (disconnect(true) no longer
      // stops it), but re-orient the model so it knows the camera/screen feed
      // is still live instead of assuming vision ended with the break.
      if (this.visionStreamer.getIsCameraActive() || this.visionStreamer.getIsScreenSharing()) {
        try {
          this.session?.sendRealtimeInput({
            text: this.visionStreamer.getIsCameraActive()
              ? '[SYSTEM EVENT: The camera feed continues after a brief connection break. Keep observing what you see exactly as before.]'
              : '[SYSTEM EVENT: The screen share continues after a brief connection break. Keep observing the screen exactly as before.]',
          });
        } catch (e) {
          console.warn('[GeminiLive] Vision re-orient prompt after reconnect failed:', e);
        }
      }
      // Only reset after a real, established replacement session.
      this.reconnectAttempts = 0;
      this.isReconnecting = false;
      console.info('[GeminiLive] Successfully reconnected session!');
    } catch (e) {
      console.warn('[GeminiLive] Reconnect attempt failed:', e);
      this.isReconnecting = false;
      if (!this.isUserExplicitlyClosed) {
        void this.handleAutoReconnect();
      }
    }
  }

  /**
   * @param preserveReconnectState true for reconnect-internal teardown (keeps
   *   media/camera alive), false for explicit hangup (full teardown).
   * @param skipNativeAudioReset true ONLY for the fresh-start + handed-off-focus
   *   case (see connect()) — scheduling resetNativeAudioRoute() there would
   *   abandon the pre-capture focus the client is about to rely on.
   */
  disconnect(preserveReconnectState = false, skipNativeAudioReset = false): void {
    if (!preserveReconnectState) {
      this.connectionAttempt += 1;
      this.isUserExplicitlyClosed = true;
      if (this.sessionStartTime > 0) {
        globalLastCallEndedAt = Date.now();
        globalLastCallDurationSec = Math.round((Date.now() - this.sessionStartTime) / 1000);
        wasLastCallUserExplicitHangup = true;
      }
      this.sessionStartTime = 0;
    } else {
      wasLastCallUserExplicitHangup = false;
    }
    // P2: cancel any pending reconnect backoff NOW. Clearing the timer kills
    // the scheduled wakeup; bumping the epoch makes a worker that already woke
    // abort at its next gate. Bumped on EVERY disconnect (including the
    // reconnect-internal one) so a direct connect() while a worker sleeps
    // invalidates that worker too.
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectEpoch += 1;
    this.isReconnecting = false;
    if (!preserveReconnectState) {
      this.reconnectAttempts = 999;
      if (this.currentMediaStream) {
        try {
          this.currentMediaStream.getTracks().forEach((t) => t.stop());
        } catch {}
      }
      this.currentMediaStream = null;
      this.activeApiKey = null;
    }
    if (this.silenceObserverTimer) {
      clearInterval(this.silenceObserverTimer);
      this.silenceObserverTimer = null;
    }
    this.silenceNudgeStreak = 0;
    this.awaitingAssistantReply = false;
    this.lastUserSpokenText = '';
    this.userSpeechEndedAt = 0;
    this.quietFocusUntil = 0;
    this.silenceStateMachine.reset();
    if (!preserveReconnectState) {
      this.audioStreamer.close();
    } else {
      this.audioStreamer.stopRecording();
    }
    // Single-owner audio flag: the next connect() must re-acquire focus before
    // streaming again (reconnect does its own ordered setup — M7).
    this.callAudioFocusGranted = false;
    if (this.audioFocusListener) {
      void this.audioFocusListener.remove();
      this.audioFocusListener = null;
    }
    // INTENTIONAL BEHAVIOR PRESERVED: an explicit hangup (preserve=false) MUST
    // stop the camera/screen capture. But a reconnect (preserve=true) must NOT
    // kill it — otherwise the active camera/screen stream dies the moment the
    // WebSocket reconnects and only voice comes back (Review 3 issue #1).
    if (!preserveReconnectState) {
      this.visionStreamer.stop();
    }
    // P7 + review-7 P0: store (never fire-and-forget) so the next
    // setupCallAudio() serializes after this reset — the route can no longer
    // be reverted after new setup. Resets CHAIN FIFO instead of replacing:
    // a reset from a failed startup that is still in flight must never be
    // discarded, because an orphaned native reset executing later could
    // abandon the very focus the next attempt just acquired.
    //   - skip=false (normal teardown): append a reset to the chain.
    //   - skip=true (fresh start + handed-off pre-capture focus): schedule
    //     NO new reset (it would abandon that focus — review-6 regression),
    //     but KEEP any prior chain so the new setup still waits for it.
    this.pendingAudioReset = skipNativeAudioReset
      ? this.pendingAudioReset
      : (this.pendingAudioReset ?? Promise.resolve())
          .then(() => resetNativeAudioRoute())
          .catch(() => undefined);
    // Review-8 P1: a call that was handed-off a pre-captured focus must not
    // leave callAudioFocusGranted true after teardown — otherwise a LATER
    // connect() (Call #2 / a reconnect) could inherit Call #1's stale
    // ownership claim and skip re-requesting focus. The only legitimate path
    // that keeps the flag is the fresh-start + handed-off focus case
    // (skipNativeAudioReset=true), where the focus is still held by the
    // pre-capture path. On ANY other teardown (normal hangup, reconnect
    // teardown, failed startup rollback) the native focus is abandoned here,
    // so the flag must be cleared to match reality.
    if (!skipNativeAudioReset) {
      this.callAudioFocusGranted = false;
    }
    if (this.session) {
      try {
        this.session.close?.();
      } catch {
        // Ignored
      }
      this.session = null;
    }
    this.setStatus(preserveReconnectState ? 'disconnected' : 'idle');
    if (!preserveReconnectState) {
      this.isIncomingCallSession = false;
      this.incomingCallReason = '';
    }
  }

  /**
   * P10 (drain-aware hang-up): resolve when Misa's current audio has fully
   * played (bounded 0-8s). The endLiveCall handler awaits this BEFORE calling
   * disconnect() — so the goodbye line is never cut mid-word by the fixed
   * 4s guess. Exact for WebAudio (onended decrements), best-effort natively.
   */
  async waitForAudioDrained(maxWaitMs = 8000): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < maxWaitMs) {
      if (this.audioStreamer.getPendingPlaybackMs() <= 0) return;
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  }

  /** Static helper to fetch available Live-compatible models from Gemini API or configured gateway. */
  static async fetchLiveModels(apiKey: string, baseUrl?: string, preconfiguredModels: string[] = []): Promise<string[]> {
    const defaults = [
      'gemini-3.1-flash-live-preview',
      'gemini-2.5-flash-native-audio-preview-09-2025',
      'gemini-2.5-flash',
      'gemini-2.5-pro',
      'gemini-2.0-flash-exp',
      'gemini-2.0-flash-realtime-exp',
    ];

    if (!apiKey && preconfiguredModels.length > 0) {
      return Array.from(new Set([...preconfiguredModels, ...defaults]));
    }

    if (!apiKey) throw new Error('API key is required to fetch models');

    let rawModels: string[] = [];

    // 1. Try custom provider baseUrl if provided
    if (baseUrl && !baseUrl.includes('generativelanguage.googleapis.com')) {
      const cleanBase = baseUrl.replace(/\/+$/, '');
      try {
        const url = `${cleanBase}/models`;
        const res = await fetch(url, {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'x-goog-api-key': apiKey,
          },
        });
        if (res.ok) {
          const data = await res.json();
          const list = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
          rawModels = list.map((m: any) => (typeof m === 'string' ? m : m.id || m.name || '')).filter(Boolean);
        }
      } catch {
        // Fall back to Google API
      }
    }

    // 2. If no custom models fetched, try Google Generative Language API
    if (rawModels.length === 0) {
      try {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
        if (res.ok) {
          const data = await res.json();
          const models: any[] = data?.models ?? [];
          rawModels = models.map((m) => m.name?.replace(/^models\//, '') || '').filter(Boolean);
        }
      } catch {
        // Ignored
      }
    }

    const liveModels = rawModels.filter((name) => {
      const lower = name.toLowerCase();
      return (
        lower.startsWith('gemini') ||
        lower.includes('live') ||
        lower.includes('realtime') ||
        lower.includes('audio') ||
        lower.includes('flash') ||
        lower.includes('pro')
      );
    });

    const merged = Array.from(new Set([...preconfiguredModels, ...liveModels, ...defaults]));
    return merged;
  }

  /** Static helper to play a voice preview using GoogleGenAI SDK and Audio element. */
  static async previewVoice(apiKey: string, voice: string, sampleText: string, model = 'gemini-3.1-flash-live-preview', baseUrl?: string): Promise<void> {
    if (apiKey) {
      // 1. Try Live WebSocket connection using the exact selected Live Model (e.g. gemini-3.1-flash-live-preview)
      try {
        const ai = new GoogleGenAI(
          baseUrl?.trim()
            ? { apiKey, httpOptions: { baseUrl: baseUrl.trim().replace(/\/+$/, '') } }
            : { apiKey }
        );
        const AudioCtxClass = window.AudioContext || (window as any).webkitAudioContext;
        if (AudioCtxClass) {
          const audioCtx = new AudioCtxClass({ sampleRate: 24000 });
          let nextPlayTime = 0;
          let hasPlayed = false;

          const liveSession = await ai.live.connect({
            model: model || 'gemini-3.1-flash-live-preview',
            config: {
              responseModalities: [Modality.AUDIO],
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: {
                    voiceName: voice,
                  },
                },
              },
            },
            callbacks: {
              onmessage: (data: any) => {
                const parts = data.serverContent?.modelTurn?.parts;
                if (Array.isArray(parts)) {
                  for (const part of parts) {
                    if (part.inlineData?.data) {
                      hasPlayed = true;
                      const base64 = part.inlineData.data;
                      const binary = atob(base64);
                      const bytes = new Uint8Array(binary.length);
                      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
                      const int16 = new Int16Array(bytes.buffer);
                      const float32 = new Float32Array(int16.length);
                      for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768;

                      const audioBuf = audioCtx.createBuffer(1, float32.length, 24000);
                      audioBuf.copyToChannel(float32, 0);
                      const source = audioCtx.createBufferSource();
                      source.buffer = audioBuf;
                      source.connect(audioCtx.destination);
                      const now = audioCtx.currentTime;
                      nextPlayTime = Math.max(now + 0.005, nextPlayTime);
                      source.start(nextPlayTime);
                      nextPlayTime += audioBuf.duration;
                    }
                  }
                }
                if (data.serverContent?.turnComplete) {
                  window.setTimeout(() => {
                    try { liveSession.close(); } catch {}
                  }, 1200);
                }
              },
            },
          });

          liveSession.sendRealtimeInput({
            text: `Please say: "${sampleText}"`,
          });

          // Wait up to 3.5 seconds for preview audio
          await new Promise((resolve) => setTimeout(resolve, 3500));
          try { liveSession.close(); } catch {}
          if (hasPlayed) return;
        }
      } catch (err) {
        console.warn(`[GeminiLive] Ephemeral live voice preview failed for ${model}:`, err);
      }

      // 2. Try generateContent audio candidates
      const candidates = Array.from(
        new Set([model, 'gemini-2.0-flash-exp', 'gemini-2.0-flash-realtime-exp', 'gemini-2.5-flash-native-audio-preview-09-2025'].filter(Boolean)),
      );
      for (const m of candidates) {
        try {
          const ai = new GoogleGenAI(
            baseUrl?.trim()
              ? { apiKey, httpOptions: { baseUrl: baseUrl.trim().replace(/\/+$/, '') } }
              : { apiKey }
          );
          const response = await ai.models.generateContent({
            model: m,
            contents: sampleText,
            config: {
              responseModalities: [Modality.AUDIO],
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: {
                    voiceName: voice,
                  },
                },
              },
            },
          });

          const part = response.candidates?.[0]?.content?.parts?.[0];
          const base64Data = (part as any)?.inlineData?.data;
          const mimeType = (part as any)?.inlineData?.mimeType || 'audio/wav';

          if (base64Data) {
            const binary = atob(base64Data);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

            const blob = new Blob([bytes], { type: mimeType });
            const url = URL.createObjectURL(blob);
            const audio = new Audio(url);
            audio.volume = 1.0;
            await audio.play();
            return;
          }
        } catch (err) {
          console.warn(`[GeminiLive] SDK voice preview failed with model ${m}:`, err);
        }
      }
    }

    // High quality browser voice synthesis fallback
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      window.speechSynthesis.resume();
      const utterance = new SpeechSynthesisUtterance(sampleText);
      const voices = window.speechSynthesis.getVoices();
      const female = voices.find(
        (v) =>
          (v.name.toLowerCase().includes('female') ||
            v.name.toLowerCase().includes('natural') ||
            v.name.toLowerCase().includes('zira') ||
            v.name.toLowerCase().includes('samantha') ||
            v.name.toLowerCase().includes('google')) &&
          (v.lang.startsWith('en') || v.lang.startsWith('hi')),
      );
      if (female) utterance.voice = female;
      utterance.volume = 1.0;
      utterance.rate = 1.0;
      utterance.pitch = 1.1;
      window.speechSynthesis.speak(utterance);
    }
  }
}
