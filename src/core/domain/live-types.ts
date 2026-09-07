// Domain contracts and types for Gemini Live Multimodal Streaming.

/** Who initiated a live call — drives greeting + call-origin system block (3-way). */
export type LiveCallOrigin = 'user_tap' | 'user_tool' | 'auto';

export type GeminiLiveVoice =
  | 'Aoede'
  | 'Kore'
  | 'Leda'
  | 'Zephyr'
  | 'Thallo'
  | 'Autonoe'
  | 'Callisto'
  | 'Despina'
  | 'Galatea'
  | 'Himalia'
  | 'Larissa'
  | 'Naiad'
  | 'Pandora'
  | 'Thebe';

export interface GeminiLiveVoiceOption {
  id: GeminiLiveVoice;
  name: string;
  gender: 'female';
  description: string;
  previewSampleText: string;
}

export const OFFICIAL_GEMINI_VOICES: GeminiLiveVoiceOption[] = [
  {
    id: 'Aoede',
    name: 'Aoede (Default)',
    gender: 'female',
    description: 'Warm, cheerful, friendly aur expressive (Misa Recommended)',
    previewSampleText: 'Hey! Main Misa hoon, tumhari JEE study partner. Chalo aaj physics solve karte hain!',
  },
  {
    id: 'Kore',
    name: 'Kore',
    gender: 'female',
    description: 'Calm, soothing, sweet aur clear voice',
    previewSampleText: 'Hello! Chalo tumhara study plan aur doubts step-by-step review karte hain.',
  },
  {
    id: 'Leda',
    name: 'Leda',
    gender: 'female',
    description: 'Bright, inquisitive aur energetic student companion',
    previewSampleText: 'Hi there! Aaj kaunsa topic master karna hai? Formula list ready hai!',
  },
  {
    id: 'Zephyr',
    name: 'Zephyr',
    gender: 'female',
    description: 'Soft, gentle, smooth aur motivating voice',
    previewSampleText: 'Relax ho jao, sab cover ho jayega. Hum concept ko simple bana ke samjhenge.',
  },
  {
    id: 'Thallo',
    name: 'Thallo',
    gender: 'female',
    description: 'Upbeat, cheerful, lively aur encouraging',
    previewSampleText: 'Great job! Har ek problem solve karke tum JEE rank ke kareeb aa rahe ho!',
  },
  {
    id: 'Autonoe',
    name: 'Autonoe',
    gender: 'female',
    description: 'Crisp, articulate, focused aur sharp tutor',
    previewSampleText: 'Direct calculation par dhyan do, accuracy se tumhara percentile increase hoga.',
  },
  {
    id: 'Callisto',
    name: 'Callisto',
    gender: 'female',
    description: 'Grounded, mature aur elegant educator voice',
    previewSampleText: 'Deep conceptual clarity hi JEE Advanced mein kaam aati hai.',
  },
  {
    id: 'Despina',
    name: 'Despina',
    gender: 'female',
    description: 'Playful, lively aur curious study buddy',
    previewSampleText: 'Ye numerical kitna interesting hai na! Chalo shortcut trick dekhte hain.',
  },
  {
    id: 'Galatea',
    name: 'Galatea',
    gender: 'female',
    description: 'Intelligent, precise aur clean articulation',
    previewSampleText: 'Derivation complete hai, ab limiting cases check karte hain.',
  },
  {
    id: 'Himalia',
    name: 'Himalia',
    gender: 'female',
    description: 'Melodious, soft-spoken aur pleasant tone',
    previewSampleText: 'Consistent revision hi memory retention ka secret hai.',
  },
  {
    id: 'Larissa',
    name: 'Larissa',
    gender: 'female',
    description: 'Natural, friendly aur engaging partner',
    previewSampleText: 'Batao agla question kaunsa hai, hum milkar solve karenge.',
  },
  {
    id: 'Naiad',
    name: 'Naiad',
    gender: 'female',
    description: 'Serene, thoughtful aur calm guidance',
    previewSampleText: 'Exam hall mein calm mind hi best performance nikalta hai.',
  },
  {
    id: 'Pandora',
    name: 'Pandora',
    gender: 'female',
    description: 'Dynamic, expressive aur inspiring coach',
    previewSampleText: 'Full energy ke saath aaj ka target complete karna hai!',
  },
  {
    id: 'Thebe',
    name: 'Thebe',
    gender: 'female',
    description: 'Confident, bright aur motivating voice',
    previewSampleText: 'Tumhara progress bohot solid hai, keep leveling up!',
  },
];

export type LiveAudioRoute = 'speaker' | 'earpiece' | 'bluetooth';

export type LiveCameraLens = 'user' | 'environment';

export type LiveSessionStatus =
  | 'idle'
  | 'requesting-permissions'
  | 'connecting'
  | 'reconnecting'
  | 'background-active'
  | 'background-pip-active'
  | 'connected'
  | 'listening'
  | 'speaking'
  | 'thinking'
  | 'error'
  | 'disconnected';

export interface LiveTranscriptItem {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  timestamp: string;
  isInterrupted?: boolean;
  toolCalls?: import('./chat').ChatToolCallRecord[];
  reasoning?: string;
}

export interface LiveSettingsConfig {
  providerId?: string; // e.g. 'app-default', 'gemini', 'custom', or stored provider id
  apiKey?: string;
  /**
   * Server root used to reach the Gemini Live WebSocket endpoint.
   * - SmartRotator providers: the bare gateway root (e.g. https://smartrotator.onrender.com)
   *   so the Google GenAI SDK connects to our Google-compatible /ws/... BidiGenerateContent relay.
   * - "gemini" / Google direct: undefined → SDK uses Google's default Live endpoint.
   */
  baseUrl?: string;
  model: string;
  voice: GeminiLiveVoice;
  playbackSpeed?: number; // e.g. 0.85 (default)
  enable90DayTrack?: boolean;
  vadSensitivity: 'low' | 'medium' | 'high';
  defaultAudioRoute: LiveAudioRoute;
  videoFps: number;
  screenFps: number;
  timeZone?: string;
  temperature?: number;
  maxOutputTokens?: number;
  thinkingBudget?: number;
  /**
   * Ordered auto-fallback models used when the selected `model` becomes
   * unavailable at connect time. User-changeable (Live Settings → Advanced);
   * defaults to the known-good Gemini Live models. When empty/omitted, the
   * client falls back to the built-in default chain.
   */
  fallbackModels?: string[];
}

export const DEFAULT_LIVE_SETTINGS: LiveSettingsConfig = {
  model: 'gemini-3.1-flash-live-preview',
  voice: 'Aoede',
  playbackSpeed: 1.0,
  vadSensitivity: 'high',
  defaultAudioRoute: 'speaker',
  videoFps: 2,
  screenFps: 2,
  temperature: 0.7,
  maxOutputTokens: 2048,
  thinkingBudget: 0,
  fallbackModels: [
    'gemini-2.5-flash-native-audio-latest',
    'gemini-2.5-flash',
    'gemini-2.5-pro',
  ],
};

/**
 * The last-resort default fallback chain, used only when a config provides no
 * `fallbackModels`. Kept separate from DEFAULT_LIVE_SETTINGS so stored configs
 * that predate the field still resolve to a sane chain without mutating state.
 */
export const DEFAULT_LIVE_FALLBACK_MODELS: string[] = [
  'gemini-3.1-flash-live-preview',
  'gemini-2.5-flash-native-audio-latest',
  'gemini-2.5-flash',
];

/**
 * Settings that are baked into the Gemini Live SESSION at connect() time and
 * therefore need a full re-connect to take effect on a running call. Every
 * other field is hot-appliable client-side (e.g. playbackSpeed) or applied by
 * re-routing audio (defaultAudioRoute) without tearing the session down.
 */
const LIVE_SESSION_BAKED_KEYS: ReadonlyArray<keyof LiveSettingsConfig> = [
  'providerId',
  'apiKey',
  'model',
  'voice',
  'vadSensitivity',
  'videoFps',
  'screenFps',
  'temperature',
  'maxOutputTokens',
  'thinkingBudget',
  'baseUrl',
];

/**
 * True when switching from `prev` to `next` changes any session-baked setting
 * (model/voice/VAD/FPS/tokens/API-key/baseUrl/endpoint), i.e. when the running
 * Gemini session must be re-established for the change to take effect. Used by
 * the live overlay so saving unrelated settings (speed, prompts) does NOT tear
 * down a healthy call — the "changing settings disconnects the call" bug.
 */
export function requiresLiveReconnect(prev: LiveSettingsConfig, next: LiveSettingsConfig): boolean {
  return LIVE_SESSION_BAKED_KEYS.some((key) => prev[key] !== next[key]);
}

export interface LiveStreamStats {
  latencyMs: number;
  inputVolume: number; // 0..1
  outputVolume: number; // 0..1
  fps: number;
  framesSent: number;
}
