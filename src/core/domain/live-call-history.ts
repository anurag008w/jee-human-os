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
  /**
   * Chat session the call happened in. Lets chat deletion purge exactly that
   * session's calls — otherwise Misa keeps saying "Total N live calls hui hain"
   * after the chat (and its calls) were deleted. Undefined = legacy record
   * (pre-session-keying); those are never purged by session deletion.
   */
  sessionId?: string;
}

export interface PersistedLiveCallHistory {
  /** How many live calls the user has ever taken. */
  totalCalls: number;
  /** Recent calls (most-recent FIRST), capped at MAX_LOG. */
  recent: LiveCallRecord[];
  /** Message ids from the most recent call, reused as continuation context. */
  lastTranscriptSnapshot: string[];
  /**
   * endedAt of the call that produced `lastTranscriptSnapshot`. Lets
   * purgeLiveCallsForSession decide whether the tail belonged to a deleted
   * chat's call. Undefined = snapshot was set externally (redial seeding) and
   * is treated as untracked.
   */
  lastTranscriptSnapshotAt?: number;
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
      lastTranscriptSnapshotAt: Number.isFinite(parsed.lastTranscriptSnapshotAt)
        ? parsed.lastTranscriptSnapshotAt
        : undefined,
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
 * it to seed the next redial with continuation context. `sessionId` ties the
 * call to its chat session so deleting that chat can purge its calls.
 */
export function recordLiveCall(
  endedAt: number,
  durationSec: number,
  opts?: { sessionId?: string; updateTranscriptSnapshot?: (prev: string[]) => string[] },
): PersistedLiveCallHistory {
  const history = loadLiveCallHistory();
  history.totalCalls += 1;
  history.recent.unshift({ endedAt, durationSec, sessionId: opts?.sessionId || undefined });
  if (history.recent.length > MAX_CALL_LOG) history.recent.length = MAX_CALL_LOG;
  if (typeof opts?.updateTranscriptSnapshot === 'function') {
    history.lastTranscriptSnapshot = opts.updateTranscriptSnapshot(history.lastTranscriptSnapshot).slice(0, 20);
    history.lastTranscriptSnapshotAt = endedAt;
  }
  persist(history);
  return history;
}

/**
 * Delete every persisted call that belongs to `sessionId` and decrement the
 * total-call counter accordingly (bounded by the records still in the log).
 * The transcript snapshot is cleared when it was produced by one of the
 * deleted calls — so Misa cannot quote a deleted chat's last words. Legacy
 * records (no sessionId) are never touched. Returns how many records were
 * removed; 0 for unknown / untagged / empty histories.
 */
export function purgeLiveCallsForSession(sessionId: string): number {
  if (!sessionId) return 0;
  const history = loadLiveCallHistory();
  const removedAts = new Set<number>();
  const kept: LiveCallRecord[] = [];
  for (const r of history.recent) {
    if (r.sessionId === sessionId) {
      removedAts.add(r.endedAt);
    } else {
      kept.push(r);
    }
  }
  const removed = history.recent.length - kept.length;
  if (removed === 0) return 0;
  history.recent = kept;
  history.totalCalls = Math.max(0, history.totalCalls - removed);
  if (history.lastTranscriptSnapshotAt !== undefined && removedAts.has(history.lastTranscriptSnapshotAt)) {
    history.lastTranscriptSnapshot = [];
    history.lastTranscriptSnapshotAt = undefined;
  }
  persist(history);
  return removed;
}

/** Merge an in-memory snapshot into the persisted history (used at connect). */
export function setLastTranscriptSnapshot(snapshot: string[]): void {
  const history = loadLiveCallHistory();
  history.lastTranscriptSnapshot = snapshot.slice(0, 20);
  // Snapshot seeded externally (redial/connect context) has no record origin —
  // purgeLiveCallsForSession treats it as untracked so it survives chat
  // deletion (only snapshots produced by a deleted call are forgotten).
  history.lastTranscriptSnapshotAt = undefined;
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

/**
 * Compact, human-readable LIVE-CALL overview for AI context injection (TEXT chat
 * replies AND live-call system prompts). Gives Misa the same "kitni baar call
 * kiya, kab call hua, pichli call me kya baat hui" knowledge the app already
 * tracks — previously that data only reached the live greeting (and only when the
 * student did not speak before the greeting fired), so text chat had ZERO idea the
 * user had ever called.
 *
 * Returns '' when no call has ever completed, so callers can skip the block
 * entirely. The snapshot tail is the last call's final exchanges (Student/Misa
 * lines, capped) — the same continuation context the quick-redial greeting uses.
 */
export function buildLiveCallOverview(now = Date.now()): string {
  const history = loadLiveCallHistory();
  if (history.totalCalls === 0 && history.recent.length === 0) return '';
  const bits = [`Total ${history.totalCalls} live call${history.totalCalls === 1 ? '' : 's'} hui hain`];
  const last = history.recent[0];
  if (last) {
    const desc = describeLastCall(now);
    bits.push(`last call ${desc?.text ?? 'kabhi'} (lasted ~${Math.max(1, last.durationSec)}s)`);
  }
  const tail = history.lastTranscriptSnapshot;
  const lines: string[] = [];
  if (tail.length > 0) {
    lines.push('Pichli call me kya discuss hua tha (transcript tail):');
    lines.push(...tail.slice(-8));
  }
  return bits.join('; ') + (lines.length > 0 ? `\n${lines.join('\n')}` : '');
}
