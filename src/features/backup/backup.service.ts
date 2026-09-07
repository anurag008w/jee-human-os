// Versioned, validated export/import for ALL user-modifiable data.
//
// Export envelope:
//   { app: 'levelup', kind: 'levelup-backup', version: 1, scope, exportedAt, data: { state, chat } }
//
// Scopes:
// - `full`  → whole AppState (plan, tasks, logs, memory, profile, providers,
//   post-journey, …) + chat. The regenerable model catalog (`modelCache`) is
//   deliberately stripped — it is an API cache, not user data, and refetches.
// - `tasks` → only task data: dynamicTaskBank, taskLogs, planCache (har din ke
//   phases/blocks) + restDays/testDays. Chat and everything else are NOT included.
// - `levels` → only progression data: clearedLevels, weeklyReviews,
//   monthlyAssessments + postJourney (custom phases/blocks). Chat untouched.
//
// - `state` is normalized through the same defensive normalizer used at load
//   time (full scope) or merged into the live store (scoped scopes).
// - `chat` is the chat store (sessions, messages, personas, per-session prefs)
//   and only travels with `full` backups.
// - Import is atomic-by-construction: everything is parsed + normalized FIRST,
//   then written. A malformed file never leaves a half-applied backup.
//   Scoped imports MERGE into the current store and never touch chat.

import { z } from 'zod';
import { cleanImportText } from '../../core/domain/import-utils';
import type { AppState } from '../../core/domain/state';
import type { ProviderConfig } from '../../core/domain/llm';
import { defaultChatPrefs, MAX_MESSAGES_PER_SESSION, MAX_SESSIONS, type ChatMessage, type ChatPreferences, type ChatSession, type ChatStoreState } from '../../core/domain/chat';
import type { StateStore } from '../../core/ports/repositories';
import { isPhaseId, type PhaseId } from '../../core/domain/task-bank';
import { normalizeState } from '../../infra/storage/state-repository';

export const BACKUP_APP = 'levelup';
export const BACKUP_KIND = 'levelup-backup';
export const BACKUP_VERSION = 1;

/** What a backup file contains. `full` replaces everything; scoped ones merge. */
export type BackupScope = 'full' | 'tasks' | 'levels';

export const BACKUP_SCOPES: readonly BackupScope[] = ['full', 'tasks', 'levels'] as const;

/** Generous but safely under the ~5MB localStorage quota shared with live state. */
export const IMPORT_BUDGET_BYTES = 4_000_000;

const THINKING_LEVELS = ['off', 'low', 'medium', 'high', 'max'] as const;

export interface BackupPayload {
  app: string;
  kind: typeof BACKUP_KIND;
  version: number;
  scope: BackupScope;
  exportedAt: string;
  data: {
    state: unknown;
    chat?: unknown;
  };
}

export interface BackupSummary {
  scope: BackupScope;
  state: {
    journeyStarted: boolean;
    totalDone: number;
    /** AI/user-created tasks in the dynamic bank. */
    dynamicTasks: number;
    /** Unique phases covered by the dynamic task bank (e.g. jee-core). */
    dynamicPhases: string[];
    /** Number of cached daily plans (har din ke phases/blocks). */
    planDays: number;
    memoryEntries: number;
    /** Progression data (levels scope / full backups). */
    clearedLevels: number;
    weeklyReviews: number;
    monthlyAssessments: number;
  };
  chat: {
    sessions: number;
    messages: number;
  };
  bytes: number;
}

/** A validation failure with a stable machine code + human Hinglish message. */
export class BackupError extends Error {
  readonly code: 'INVALID_JSON' | 'INVALID_ENVELOPE' | 'TOO_LARGE' | 'INVALID_STATE' | 'INVALID_CHAT';

  constructor(message: string, code: 'INVALID_JSON' | 'INVALID_ENVELOPE' | 'TOO_LARGE' | 'INVALID_STATE' | 'INVALID_CHAT') {
    super(message);
    this.name = 'BackupError';
    this.code = code;
  }
}

const envelopeSchema = z.object({
  app: z.literal(BACKUP_APP),
  kind: z.literal(BACKUP_KIND),
  version: z.literal(BACKUP_VERSION),
  scope: z.enum(['full', 'tasks', 'levels']).default('full'),
  exportedAt: z.string(),
  data: z.object({
    state: z.unknown().optional(),
    chat: z.unknown().optional(),
  }),
});

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function clampNumber(v: unknown, fallback: number, min: number, max: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
}

/** Light, safe normalization of a chat message. Unknown fields are dropped. */
function normalizeChatMessage(raw: unknown): ChatMessage | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== 'string' || typeof raw.content !== 'string') return null;
  const role = typeof raw.role === 'string' ? raw.role : '';
  if (role !== 'user' && role !== 'assistant') return null;
  const message: ChatMessage = {
    id: raw.id,
    role,
    content: raw.content,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date(0).toISOString(),
  };
  if (typeof raw.model === 'string') message.model = raw.model;
  if (typeof raw.reasoning === 'string') message.reasoning = raw.reasoning;
  if (typeof raw.tool === 'string') message.tool = raw.tool;
  if (typeof raw.stopped === 'boolean') message.stopped = raw.stopped;
  if (Array.isArray(raw.attachments)) message.attachments = raw.attachments as ChatMessage['attachments'];
  return message;
}

/** Normalizes prefs to a valid ChatPreferences, keeping only known fields. */
function normalizeChatPrefs(raw: unknown): ChatPreferences {
  const defaults = defaultChatPrefs();
  if (!isRecord(raw)) return defaults;
  return {
    providerId: typeof raw.providerId === 'string' ? raw.providerId : null,
    model: typeof raw.model === 'string' ? raw.model : null,
    temperature: clampNumber(raw.temperature, defaults.temperature, 0, 2),
    maxTokens: Math.floor(clampNumber(raw.maxTokens, defaults.maxTokens, 1, 100_000)),
    systemPrompt: typeof raw.systemPrompt === 'string' ? raw.systemPrompt : defaults.systemPrompt,
    userPersona: typeof raw.userPersona === 'string' ? raw.userPersona : defaults.userPersona,
    includeContext: typeof raw.includeContext === 'boolean' ? raw.includeContext : defaults.includeContext,
    ...(typeof raw.thinking === 'string' && (THINKING_LEVELS as readonly string[]).includes(raw.thinking)
      ? { thinking: raw.thinking as ChatPreferences['thinking'] }
      : {}),
  };
}

/**
 * Normalizes a raw chat store into a bounded, valid session list.
 * Never throws — garbage sessions/messages are dropped, then the list is
 * capped to the same limits the app itself enforces.
 */
export function normalizeChatSessions(raw: unknown): ChatSession[] {
  if (!isRecord(raw) || !Array.isArray(raw.sessions)) return [];
  const sessions: ChatSession[] = [];
  for (const s of raw.sessions) {
    if (sessions.length >= MAX_SESSIONS) break;
    if (!isRecord(s)) continue;
    if (typeof s.id !== 'string' || !Array.isArray(s.messages)) continue;
    const messages = s.messages
      .map(normalizeChatMessage)
      .filter((m): m is ChatMessage => m !== null)
      .slice(0, MAX_MESSAGES_PER_SESSION);
    sessions.push({
      id: s.id,
      title: typeof s.title === 'string' ? s.title.slice(0, 200) : '',
      messages,
      prefs: normalizeChatPrefs(s.prefs),
      createdAt: typeof s.createdAt === 'string' ? s.createdAt : new Date(0).toISOString(),
      updatedAt: typeof s.updatedAt === 'string' ? s.updatedAt : new Date(0).toISOString(),
      ...(typeof s.memorySummarizedAt === 'string' ? { memorySummarizedAt: s.memorySummarizedAt } : {}),
      ...(typeof s.aiSummarizedAt === 'string' ? { aiSummarizedAt: s.aiSummarizedAt } : {}),
    });
  }
  return sessions;
}

/**
 * Builds the versioned backup payload.
 *
 * `full`  → normalized whole state (minus the regenerable model catalog) + chat.
 * `tasks` → dynamicTaskBank + customHabits + taskLogs + planCache + restDays/testDays only.
 * `levels` → clearedLevels + weeklyReviews + monthlyAssessments + postJourney only.
 *
 * Scoped payloads carry a partial `state` object; they are merged back on
 * import instead of replacing the store.
 */
export function buildBackupPayload(state: AppState, chat: ChatStoreState | null, scope: BackupScope = 'full'): BackupPayload {
  const data: BackupPayload['data'] = { state: {} };

  if (scope === 'full') {
    const full = normalizeState(state);
    // The model catalog is an API cache, not user data — re-fetched on demand.
    // Stripping it removes ~75% of the file size for most real backups.
    // AUDIT FIX (round 2, MEDIUM): also strip SECRETS from the export. The
    // full AppState carries the Gemini/OpenRouter/etc provider keys, the
    // web-search key and the Live API key. That file is shareable via file
    // pickers and pushed to the sync gateway — a theft or server-side leak of
    // it would exfiltrate live billing credentials. Replace each key with a
    // `has*Key: true` flag so an import can still tell "a key was set" (and
    // warn the user to re-enter it) without ever shipping the secret itself.
    const providers: Record<string, ProviderConfig> = {};
    for (const [id, p] of Object.entries(full.aiSettings.providers ?? {})) {
      providers[id] = { ...p, apiKey: undefined, customHeaders: undefined };
    }
    const websearch = full.aiSettings.websearch
      ? { ...full.aiSettings.websearch, apiKey: '' }
      : full.aiSettings.websearch;
    const live = full.aiSettings.live
      ? { ...full.aiSettings.live, apiKey: full.aiSettings.live.apiKey ? 'REDACTED_IN_BACKUP' : undefined }
      : undefined;
    data.state = {
      ...full,
      aiSettings: {
        ...full.aiSettings,
        modelCache: {},
        providers,
        websearch,
        live,
      },
    };
    if (chat) data.chat = { version: 1, sessions: chat.sessions };
  } else if (scope === 'tasks') {
    const full = normalizeState(state);
    data.state = {
      dynamicTaskBank: full.dynamicTaskBank,
      customTodos: full.customTodos,
      studyVault: full.studyVault,
      customHabits: full.customHabits,
      taskLogs: full.taskLogs,
      planCache: full.planCache,
      restDays: full.restDays,
      testDays: full.testDays,
      masteryPlacement: full.masteryPlacement,
    };
  } else if (scope === 'levels') {
    const full = normalizeState(state);
    data.state = {
      clearedLevels: full.clearedLevels,
      weeklyReviews: full.weeklyReviews,
      monthlyAssessments: full.monthlyAssessments,
      postJourney: full.postJourney,
    };
  }

  return {
    app: BACKUP_APP,
    kind: BACKUP_KIND,
    version: BACKUP_VERSION,
    scope,
    exportedAt: new Date().toISOString(),
    data,
  };
}

/** Pretty-prints the backup payload for a human-readable, diffable file. */
export function serializeBackup(payload: BackupPayload): string {
  return JSON.stringify(payload, null, 2);
}

/**
 * Parses + validates a backup file. Throws {@link BackupError} with a stable
 * code when the payload is not a LevelUp backup. Structural contents are left
 * raw here and normalized later (see {@link applyBackup}).
 */
export function parseBackup(json: string): BackupPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleanImportText(json));
  } catch {
    throw new BackupError('File valid JSON nahi hai. Sahi backup file select karo.', 'INVALID_JSON');
  }
  const result = envelopeSchema.safeParse(parsed);
  if (!result.success) {
    throw new BackupError('Ye file LevelUp backup nahi lagti (galat format ya unsupported version).', 'INVALID_ENVELOPE');
  }
  return result.data as BackupPayload;
}

export interface ApplyBackupOptions {
  /** Reject payloads whose serialized size exceeds this many bytes. */
  maxBytes?: number;
}

export interface ApplyBackupTargets {
  store: StateStore;
  /** Nullable: backups are still importable when chat restore is unavailable. */
  chat?: {
    replaceStore(sessions: ChatSession[]): void;
  };
}

/**
 * Validates + normalizes a backup, then writes it.
 *
 * `full` backups REPLACE the whole store (state + chat). Scoped backups
 * (`tasks` / `levels`) MERGE their section into the existing store and never
 * touch chat. Throws {@link BackupError} BEFORE anything is written when the
 * payload is too large or its data can't be made valid.
 */
export function applyBackup(payload: BackupPayload, targets: ApplyBackupTargets, opts: ApplyBackupOptions = {}): BackupSummary {
  const bytes = serializeBackup(payload).length;
  const maxBytes = opts.maxBytes ?? IMPORT_BUDGET_BYTES;
  if (bytes > maxBytes) {
    throw new BackupError(
      `Backup file bahut bada hai (${Math.round(bytes / 1_000_000)}MB). Is device ke storage budget ke andar nahi aayega.`,
      'TOO_LARGE',
    );
  }

  const scope = payload.scope ?? 'full';
  const rawState = isRecord(payload.data.state) ? payload.data.state : {};

  // Everything above is validation only — writes start here.
  if (scope === 'full') {
    const state = normalizeState(rawState);
    if (!isRecord(state)) {
      throw new BackupError('Backup ka state section valid nahi hai.', 'INVALID_STATE');
    }
    const sessions = normalizeChatSessions(payload.data.chat);
    // AUDIT FIX (round 2): backups are exported with secrets REDACTED, so an
    // import of one must NOT clobber the CURRENT device's working keys with a
    // literal "REDACTED_IN_BACKUP" placeholder (which would silently break AI
    // chat/search/live). Keep the device's existing keys; only overwrite the
    // non-secret fields. This makes re-import idempotent w.r.t. credentials.
    const withRedaction = (redact: (s: AppState) => AppState): AppState => {
      const current = targets.store.get();
      const merged: AppState = { ...state, aiSettings: { ...state.aiSettings } };
      const liveBackup = state.aiSettings.live;
      const liveCurrent = current.aiSettings?.live;
      const redactedLive = liveBackup && (liveBackup.apiKey === 'REDACTED_IN_BACKUP' || liveBackup.apiKey === 'REDACTED_IN_SYNC');
      merged.aiSettings.live = redactedLive && liveCurrent
        ? { ...liveBackup, apiKey: liveCurrent.apiKey }
        : liveBackup;
      const safeWeb = state.aiSettings.websearch;
      if (safeWeb && !safeWeb.apiKey && current.aiSettings?.websearch?.apiKey) {
        merged.aiSettings.websearch = { ...safeWeb, apiKey: current.aiSettings.websearch.apiKey };
      }
      for (const [id, p] of Object.entries(state.aiSettings.providers ?? {})) {
        if (!p || p.apiKey !== undefined) continue; // only preserve when backup has no key
        const cur = current.aiSettings?.providers?.[id];
        if (cur?.apiKey) merged.aiSettings.providers = { ...(merged.aiSettings.providers ?? {}), [id]: { ...p, apiKey: cur.apiKey } };
      }
      return redact ? redact(merged) : merged;
    };
    const restored = withRedaction((s) => s);
    targets.store.save(restored);
    targets.chat?.replaceStore(sessions);
    return summarizeBackup(restored, sessions, bytes, scope);
  }

  // Scoped import: merge only the carried section into the live store.
  const current = targets.store.get();
  const next: AppState = { ...current };

  if (scope === 'tasks') {
    if (Array.isArray(rawState.dynamicTaskBank)) next.dynamicTaskBank = rawState.dynamicTaskBank as AppState['dynamicTaskBank'];
    if (Array.isArray(rawState.customTodos)) next.customTodos = rawState.customTodos as AppState['customTodos'];
    if (Array.isArray(rawState.studyVault)) next.studyVault = rawState.studyVault as AppState['studyVault'];
    if (isRecord(rawState.taskLogs)) next.taskLogs = rawState.taskLogs as AppState['taskLogs'];
    if (isRecord(rawState.planCache)) next.planCache = rawState.planCache as AppState['planCache'];
    if (Array.isArray(rawState.restDays)) next.restDays = rawState.restDays as AppState['restDays'];
    if (Array.isArray(rawState.testDays)) next.testDays = rawState.testDays as AppState['testDays'];
  } else if (scope === 'levels') {
    if (Array.isArray(rawState.clearedLevels)) next.clearedLevels = rawState.clearedLevels as AppState['clearedLevels'];
    if (Array.isArray(rawState.weeklyReviews)) next.weeklyReviews = rawState.weeklyReviews as AppState['weeklyReviews'];
    if (Array.isArray(rawState.monthlyAssessments)) next.monthlyAssessments = rawState.monthlyAssessments as AppState['monthlyAssessments'];
    if (isRecord(rawState.postJourney)) next.postJourney = rawState.postJourney as unknown as AppState['postJourney'];
  }

  const state = normalizeState(next);
  targets.store.save(state);
  // Chat is deliberately untouched for scoped imports.
  return summarizeBackup(state, [], bytes, scope);
}

/** Compact stats shown in the UI after export/import. */
export function summarizeBackup(state: AppState, sessions: ChatSession[], bytes: number, scope: BackupScope = 'full'): BackupSummary {
  const totalDone = Object.values(state.taskLogs).reduce((sum, log) => sum + Object.values(log ?? {}).filter(Boolean).length, 0);
  const dynamicPhases = [...new Set(state.dynamicTaskBank.map((t) => t.phase).filter((p): p is PhaseId => isPhaseId(p)))].sort();
  return {
    scope,
    state: {
      journeyStarted: !!state.startDateISO,
      totalDone,
      dynamicTasks: state.dynamicTaskBank.length,
      dynamicPhases,
      planDays: Object.keys(state.planCache ?? {}).length,
      memoryEntries: state.memory.entries.length,
      clearedLevels: state.clearedLevels.length,
      weeklyReviews: state.weeklyReviews.length,
      monthlyAssessments: state.monthlyAssessments.length,
    },
    chat: {
      sessions: sessions.length,
      messages: sessions.reduce((sum, s) => sum + s.messages.length, 0),
    },
    bytes,
  };
}

/** Human label for a byte count (e.g. "1.2 MB"). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
