import type { KeyValueRepository, StateRepository, StateStore } from '../../core/ports/repositories';
import type { AppState } from '../../core/domain/state';
import { defaultUserProfile, emptyAppState, STATE_SCHEMA_VERSION } from '../../core/domain/state';
import { DEFAULT_LIVE_SETTINGS, type LiveSettingsConfig } from '../../core/domain/live-types';
import { MEMORY_BYTES_BUDGET, normalizeMemoryStore, pruneMemoryToBudget } from '../../core/domain/memory';
import { INTERNAL_SYSTEM_PROMPT, LEGACY_MISA_SYSTEM_PROMPT } from '../../core/domain/chat';
import { normalizePlanners } from '../../core/domain/subject-planner';
import { migrateV1toV2 } from './migration';

export const STATE_KEY_V1 = 'levelup-state-v1';
export const STATE_KEY = 'levelup-state-v2';

/** Serialized state budget — kept safely under the ~5MB localStorage quota. */
const STATE_SAVE_BUDGET = 3_500_000;

const REQUIRED_V2_KEYS = [
  'schemaVersion',
  'startDateISO',
  'bonusDaysUsed',
  'taskLogs',
  'weeklyReviews',
  'monthlyAssessments',
  'failureLog',
  'examDateISO',
  'clearedLevels',
  'memory',
  'summaries',
  'aiSettings',
  'dynamicTaskBank',
  'planCache',
  'studyTimeMinutes',
  'lastSummaryDate',
  'aiActionHistory',
] as const;

/** Defensively rebuilds a v2 state from whatever came out of storage. */
export function normalizeState(raw: unknown): AppState {
  const base = emptyAppState();
  if (typeof raw !== 'object' || raw === null) return base;
  const r = raw as Record<string, unknown>;
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    startDateISO: typeof r.startDateISO === 'string' ? r.startDateISO : base.startDateISO,
    bonusDaysUsed: typeof r.bonusDaysUsed === 'number' ? r.bonusDaysUsed : 0,
    taskLogs: isRecord(r.taskLogs) ? (r.taskLogs as AppState['taskLogs']) : {},
    weeklyReviews: Array.isArray(r.weeklyReviews) ? r.weeklyReviews : [],
    monthlyAssessments: Array.isArray(r.monthlyAssessments) ? r.monthlyAssessments : [],
    failureLog: Array.isArray(r.failureLog) ? r.failureLog : [],
    examDateISO: typeof r.examDateISO === 'string' ? r.examDateISO : null,
    clearedLevels: Array.isArray(r.clearedLevels) ? r.clearedLevels : [],
    memory: normalizeMemoryStore(r.memory),
    summaries: Array.isArray(r.summaries) ? r.summaries : [],
    aiSettings:
      isRecord(r.aiSettings) && isRecord((r.aiSettings as { providers?: unknown }).providers)
        ? {
            ...base.aiSettings,
            ...(r.aiSettings as Partial<AppState['aiSettings']>),
            websearch: isRecord((r.aiSettings as { websearch?: unknown }).websearch)
              ? (() => {
                  const storedWs = (r.aiSettings as { websearch?: unknown }).websearch as Partial<AppState['aiSettings']['websearch']>;
                  const merged = { ...base.aiSettings.websearch, ...storedWs };
                  const rawProvider = storedWs.providerId;
                  if (rawProvider === 'google' || rawProvider === 'smartrotator') return { ...merged, providerId: rawProvider };
                  return { ...merged, providerId: base.aiSettings.websearch.providerId };
                })()
              : base.aiSettings.websearch,
            chat: isRecord((r.aiSettings as { chat?: unknown }).chat)
              ? (() => {
                  const storedChat = (r.aiSettings as { chat: unknown }).chat as Partial<AppState['aiSettings']['chat']>;
                  // Sessions/global settings still carrying the old longer Misa
                  // default are upgraded to the compressed persona on load;
                  // user-edited text is never touched (exact match only).
                  const systemPrompt =
                    storedChat.systemPrompt === LEGACY_MISA_SYSTEM_PROMPT ? INTERNAL_SYSTEM_PROMPT : storedChat.systemPrompt;
                  return { ...base.aiSettings.chat, ...storedChat, systemPrompt: systemPrompt ?? base.aiSettings.chat.systemPrompt };
                })()
              : base.aiSettings.chat,
            live: isRecord((r.aiSettings as { live?: unknown }).live)
              ? { ...DEFAULT_LIVE_SETTINGS, ...((r.aiSettings as { live: Partial<LiveSettingsConfig> }).live) }
              : (base.aiSettings.live ?? DEFAULT_LIVE_SETTINGS),
          }
        : base.aiSettings,
    dynamicTaskBank: Array.isArray(r.dynamicTaskBank) ? r.dynamicTaskBank : [],
    restDays: Array.isArray(r.restDays) ? r.restDays : [],
    testDays: Array.isArray(r.testDays) ? r.testDays : [],
    masteryPlacement: isRecord(r.masteryPlacement) ? (r.masteryPlacement as AppState['masteryPlacement']) : {},
    planCache: isRecord(r.planCache) ? (r.planCache as AppState['planCache']) : {},
    studyTimeMinutes: typeof r.studyTimeMinutes === 'number' && r.studyTimeMinutes > 0 ? r.studyTimeMinutes : 360,
    aiActionHistory:
      isRecord(r.aiActionHistory) && Array.isArray((r.aiActionHistory as { versions?: unknown }).versions)
        ? {
            versions: (r.aiActionHistory as { versions: AppState['aiActionHistory']['versions']; undone?: unknown }).versions,
            undone: Array.isArray((r.aiActionHistory as { undone?: unknown }).undone)
              ? ((r.aiActionHistory as { undone: AppState['aiActionHistory']['undone'] }).undone)
              : [],
          }
        : base.aiActionHistory,
    lastSummaryDate: typeof r.lastSummaryDate === 'string' ? r.lastSummaryDate : null,
    // Post-journey (v3) - handles migration from older versions
    postJourney:
      isRecord(r.postJourney)
        ? {
            ...base.postJourney,
            ...(r.postJourney as Partial<AppState['postJourney']>),
          }
        : base.postJourney,
    userProfile: isRecord(r.userProfile)
      ? {
          ...defaultUserProfile(),
          ...(r.userProfile as Partial<AppState['userProfile']>),
        }
      : base.userProfile,
    timeZone: typeof r.timeZone === 'string' && r.timeZone.length > 0 ? r.timeZone : null,
    customHabits: Array.isArray(r.customHabits) ? r.customHabits : [],
    curriculumEditing: typeof r.curriculumEditing === 'boolean' ? r.curriculumEditing : false,
    subjectPlanners: normalizePlanners(r.subjectPlanners),
    enable90DayTrack: typeof r.enable90DayTrack === 'boolean' ? r.enable90DayTrack : true,
    pausedTrackDay: typeof r.pausedTrackDay === 'number' ? r.pausedTrackDay : undefined,
    customTodos: Array.isArray(r.customTodos) ? r.customTodos : [],
    studyVault: Array.isArray(r.studyVault) ? r.studyVault : [],
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export class LocalStateRepository {
  private readonly store: KeyValueRepository;
  /** Set when save() had to trim memory to fit the quota (M7). */
  private pruneNotice: string | null = null;
  /** AUDIT FIX: one-shot notice when the underlying storage write failed
   *  (quota exceeded / private-mode denial). Consumed exactly once so the UI
   *  can warn the user instead of silently losing their data on restart. */
  private writeError: string | null = null;

  constructor(store: KeyValueRepository) {
    this.store = store;
  }

  load(): AppState {
    const rawV2 = this.store.getItem(STATE_KEY);
    if (rawV2 !== null) {
      try {
        return normalizeState(JSON.parse(rawV2));
      } catch {
        // Corrupt v2 — fall through to migration path.
      }
    }
    const rawV1 = this.store.getItem(STATE_KEY_V1);
    if (rawV1 !== null) {
      try {
        const migrated = migrateV1toV2(JSON.parse(rawV1));
        this.save(migrated);
        return migrated;
      } catch {
        // Corrupt v1 — return a fresh state (old key is left untouched).
      }
    }
    return emptyAppState();
  }

  save(state: AppState): void {
    let normalized = normalizeState(state);
    let serialized = JSON.stringify(normalized);
    // Quota safeguard: if the whole state is about to exceed the localStorage
    // budget, shrink memory (the biggest consumer) until it fits, then write
    // that. Better a trimmed memory than a silently lost save on restart.
    if (serialized.length > STATE_SAVE_BUDGET) {
      normalized = { ...normalized, memory: pruneMemoryToBudget(normalized.memory, MEMORY_BYTES_BUDGET) };
      serialized = JSON.stringify(normalized);
      // M7: surface the trim — old memories were dropped to make room, and the
      // user should know instead of wondering where their early-day notes went.
      this.pruneNotice =
        'Storage was full, so some older memories were compacted to fit. Your progress is safe — only old AI memory notes were trimmed.';
    }
    this.store.setItem(STATE_KEY, serialized);
    // AUDIT FIX: read the backend's write-failure flag right after the
    // (synchronous) persist attempt. PersistentStorage.set runs its whole body
    // synchronously, so the error is already recorded here when a quota/denial
    // occurred. This is the ONLY production consumer of getLastWriteError.
    const writeErr = (this.store as { getLastWriteError?: () => string | null }).getLastWriteError?.();
    if (writeErr) this.writeError = writeErr;
  }

  /** Returns + clears the pending write-failure notice (one-shot; consumed by
   *  the UI the same way as the prune notice). */
  consumeWriteError(): string | null {
    const err = this.writeError;
    this.writeError = null;
    return err;
  }

  /** Returns + clears the pending prune notice (one-shot; M7). */
  consumePruneNotice(): string | null {
    const notice = this.pruneNotice;
    this.pruneNotice = null;
    return notice;
  }

  clear(): void {
    this.store.setItem(STATE_KEY, JSON.stringify(emptyAppState()));
  }
}

export function hasV2Shape(raw: unknown): boolean {
  return isRecord(raw) && REQUIRED_V2_KEYS.every((k) => k in raw);
}

/** In-memory StateStore backed by a StateRepository (single source of truth). */
export class CachedStateStore implements StateStore {
  private cache: AppState | null = null;
  private readonly repo: StateRepository;
  /** Trailing debounce window for repository writes (ms). */
  private readonly persistDelayMs: number;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  /** UI listeners notified (asynchronously) on every cache change. */
  private readonly listeners = new Set<() => void>();

  constructor(repo: StateRepository, persistDelayMs = 400) {
    this.repo = repo;
    this.persistDelayMs = persistDelayMs;
  }

  get(): AppState {
    if (!this.cache) this.cache = this.repo.load();
    return this.cache;
  }

  /**
   * Subscribe to store changes (hang-fix P3): replaces the 100ms polling in
   * useAppState. Returns an unsubscribe function. Emission is DEFERRED to a
   * microtask so a save() called from inside a React state updater (e.g.
   * useAppState.update) can never trigger a setState DURING the render phase.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emitChange(): void {
    const notify = () => {
      for (const listener of [...this.listeners]) listener();
    };
    if (typeof queueMicrotask === 'function') queueMicrotask(notify);
    else setTimeout(notify, 0);
  }

  /**
   * Re-reads the repository into the cache and returns the fresh snapshot.
   * Used at boot (repair a pre-init empty read — N1) and whenever external
   * storage may have changed (multi-tab sync, sync restore, backup import —
   * N2). Without this, a state written by another tab or restored from the
   * server is invisible to the UI until a full page reload.
   */
  reload(): AppState {
    // AUDIT FIX (INFO): cancel any pending debounced write. It captured the
    // PRE-reload state and would fire repo.save(oldState) AFTER the fresh
    // read, silently clobbering the just-loaded (other-tab/sync-restored) data.
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.cache = this.repo.load();
    this.emitChange();
    return this.cache;
  }

  save(state: AppState): void {
    // The in-memory cache is the source of truth for the UI and every
    // service, so it updates immediately. The repository (localStorage) write
    // is TRAILING-DEBOUNCED: without this, every UI interaction — toggles,
    // slider drags, selects, keystrokes, tab switches — serializes the whole
    // state (potentially MBs of memory/summaries) and synchronously writes it
    // to localStorage, which is what made the app hang on low-end devices.
    // Behavior is unchanged: the cache always has the latest state; the
    // debounced write is invisible except that storage catches up ~400ms later
    // (or immediately on flush()/page hide).
    this.cache = state;
    this.emitChange();
    if (this.persistTimer !== null) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.repo.save(state);
    }, this.persistDelayMs);
  }

  /** Writes any pending state to the repository immediately. No-op when the
   *  last save already hit the repository. Safe to call at any time. */
  flush(): void {
    if (this.persistTimer !== null && this.cache) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
      this.repo.save(this.cache);
    }
  }

  /** One-time notice when the last save had to trim memory (M7). */
  consumePruneNotice(): string | null {
    return this.repo.consumePruneNotice ? this.repo.consumePruneNotice() : null;
  }

  /** One-time notice when the last persist hit a storage write failure. */
  consumeWriteError(): string | null {
    return this.repo.consumeWriteError ? this.repo.consumeWriteError() : null;
  }
}
