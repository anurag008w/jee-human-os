/**
 * Persistent live-call history (survives app reloads).
 *
 * Lets Misa acknowledge "abhi toh call kiya tha", "kal bhi call kiya tha", and
 * "kitni baar call kiye" on a fresh live call — the previous in-memory globals
 * were lost on page reload and only remembered ONE call for a 2-minute window.
 *
 * Pure + testable: no React, no SDK — just localStorage behind an injectable
 * storage so tests can run headless.
 */

export interface LiveCallRecord {
  /** epoch ms the call ENDED (or was dropped). */
  endedAt: number;
  /** call duration in seconds. */
  durationSec: number;
}

export interface PersistedLiveCallHistory {
  /** How many live calls the user has ever taken. */
  totalCalls: number;
  /** Recent calls (most-recent FIRST), capped at MAX_LOG. */
  recent: LiveCallRecord[];
  /** Message ids from the most recent call, reused as continuation context. */
  lastTranscriptSnapshot: string[];
}

const STORAGE_KEY = 'levelup.live.call_history';
/** Keep a bounded history — a handful of recent calls is enough for context. */
export const MAX_CALL_LOG = 8;

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

let activeStorage: StorageLike | null = null;

/** Inject a storage backend (web: real localStorage; tests: an in-memory stub). */
export function setLiveCallHistoryStorage(storage: StorageLike | null): void {
  activeStorage = storage;
}

function storage(): StorageLike | null {
  if (activeStorage) return activeStorage;
  if (typeof localStorage !== 'undefined') return localStorage;
  return null;
}

/** Read the persisted call history, never throwing on missing/corrupt data. */
export function loadLiveCallHistory(): PersistedLiveCallHistory {
  // Always build a FRESH empty object: never reuse EMPTY's array references.
  // Sharing them would let `recordLiveCall`'s `.unshift` mutate the module-level
  // EMPTY.recent, leaking previous calls into the next empty read.
  const empty = (): PersistedLiveCallHistory => ({ totalCalls: 0, recent: [], lastTranscriptSnapshot: [] });
  const s = storage();
  if (!s) return empty();
  try {
    const raw = s.getItem(STORAGE_KEY);
    if (!raw) return empty();
    const parsed = JSON.parse(raw) as Partial<PersistedLiveCallHistory>;
    return {
      totalCalls: Number.isFinite(parsed.totalCalls) ? Math.max(0, parsed.totalCalls!) : 0,
      recent: Array.isArray(parsed.recent)
        ? parsed.recent
            .filter(
              (r) => r && Number.isFinite(r.endedAt) && Number.isFinite(r.durationSec),
            )
            .slice(0, MAX_CALL_LOG)
        : [],
      lastTranscriptSnapshot: Array.isArray(parsed.lastTranscriptSnapshot)
        ? parsed.lastTranscriptSnapshot.slice(0, 20)
        : [],
    };
  } catch {
    return empty();
  }
}

function persist(history: PersistedLiveCallHistory): void {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(STORAGE_KEY, JSON.stringify(history));
  } catch {
    // Quota / privacy-mode — best effort; never crash the call.
  }
}

/**
 * Record a completed live call. `updateTranscriptSnapshot` can be omitted; pass
 * it to seed the next redial with continuation context.
 */
export function recordLiveCall(
  endedAt: number,
  durationSec: number,
  updateTranscriptSnapshot?: (prev: string[]) => string[],
): PersistedLiveCallHistory {
  const history = loadLiveCallHistory();
  history.totalCalls += 1;
  history.recent.unshift({ endedAt, durationSec });
  if (history.recent.length > MAX_CALL_LOG) history.recent.length = MAX_CALL_LOG;
  if (typeof updateTranscriptSnapshot === 'function') {
    history.lastTranscriptSnapshot = updateTranscriptSnapshot(history.lastTranscriptSnapshot).slice(0, 20);
  }
  persist(history);
  return history;
}

/** Merge an in-memory snapshot into the persisted history (used at connect). */
export function setLastTranscriptSnapshot(snapshot: string[]): void {
  const history = loadLiveCallHistory();
  history.lastTranscriptSnapshot = snapshot.slice(0, 20);
  persist(history);
}

export function loadLastTranscriptSnapshot(): string[] {
  return loadLiveCallHistory().lastTranscriptSnapshot;
}

/** Human-readable "last call" blurb for the greeting, e.g. "abhi ~2 min pehle" / "kal". */
export function describeLastCall(now = Date.now()): { text: string; diffMs: number } | null {
  const history = loadLiveCallHistory();
  const last = history.recent[0];
  if (!last) return null;
  const diffMs = Math.max(0, now - last.endedAt);
  if (diffMs < 60_000) return { text: 'abhi isi minute me', diffMs };
  if (diffMs < 3_600_000) return { text: `~${Math.max(1, Math.round(diffMs / 60_000))} min pehle`, diffMs };
  if (diffMs < 86_400_000) return { text: `~${Math.max(1, Math.round(diffMs / 3_600_000))} ghante pehle`, diffMs };
  return { text: `~${Math.max(1, Math.round(diffMs / 86_400_000))} din pehle`, diffMs };
}
