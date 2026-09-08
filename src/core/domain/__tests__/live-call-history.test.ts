/**
 * Persistent live-call history — survives reloads, spans multiple calls, and
 * feeds Misa's greeting ("abhi call kiya tha" / "kal bhi call kiya tha").
 *
 * NOTE: the vitest environment here is `node` (no jsdom localStorage), so these
 * tests inject an in-memory storage backend and give each test a FRESH instance
 * to guarantee isolation.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadLiveCallHistory,
  recordLiveCall,
  setLastTranscriptSnapshot,
  loadLastTranscriptSnapshot,
  describeLastCall,
  buildLiveCallOverview,
  purgeLiveCallsForSession,
  MAX_CALL_LOG,
  setLiveCallHistoryStorage,
} from '../live-call-history';

function makeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { void map.set(k, v); },
    removeItem: (k: string) => { void map.delete(k); },
    _map: map,
  };
}

let storage: ReturnType<typeof makeStorage>;

beforeEach(() => {
  storage = makeStorage();
  setLiveCallHistoryStorage(storage);
});

describe('live call history persistence', () => {
  it('records calls and increments the total count', () => {
    recordLiveCall(1000, 30);
    recordLiveCall(2000, 45);
    const h = loadLiveCallHistory();
    expect(h.totalCalls).toBe(2);
    expect(h.recent[0]).toEqual({ endedAt: 2000, durationSec: 45 });
    expect(h.recent[1]).toEqual({ endedAt: 1000, durationSec: 30 });
  });

  it('survives a reload by reading the persisted payload again', () => {
    recordLiveCall(1000, 30);
    // Re-point the module at a fresh storage stamped with the same raw payload,
    // simulating a page reload that re-reads localStorage.
    const raw = storage._map.get('levelup.live.call_history')!;
    const reloaded = makeStorage();
    reloaded._map.set('levelup.live.call_history', raw);
    setLiveCallHistoryStorage(reloaded);

    const h = loadLiveCallHistory();
    expect(h.totalCalls).toBe(1);
    expect(h.recent[0]).toEqual({ endedAt: 1000, durationSec: 30 });
  });

  it('caps the recent-call log at MAX_CALL_LOG, keeping the newest', () => {
    for (let i = 0; i < MAX_CALL_LOG + 5; i++) recordLiveCall(i * 1000, 10);
    const h = loadLiveCallHistory();
    expect(h.recent.length).toBe(MAX_CALL_LOG);
    expect(h.recent[0].endedAt).toBe((MAX_CALL_LOG + 4) * 1000);
    expect(h.totalCalls).toBe(MAX_CALL_LOG + 5);
  });

  it('stores and recalls the last transcript snapshot for continuation', () => {
    setLastTranscriptSnapshot(['Student: hi', 'Misa: bolo']);
    expect(loadLastTranscriptSnapshot()).toEqual(['Student: hi', 'Misa: bolo']);
  });

  it('keeps a non-empty snapshot across a recorded call', () => {
    setLastTranscriptSnapshot(['old context']);
    recordLiveCall(1000, 20); // no updater → keep old snapshot
    expect(loadLastTranscriptSnapshot()).toEqual(['old context']);
  });

  it('tolerates corrupt / missing storage', () => {
    storage.setItem('levelup.live.call_history', '{not valid json');
    expect(loadLiveCallHistory().totalCalls).toBe(0);
    expect(loadLiveCallHistory().recent).toEqual([]);
  });

  it('does not leak prior-call data into an empty read (fresh-array regression test)', () => {
    // Populate, then point at brand-new EMPTY storage.
    recordLiveCall(1000, 30);
    setLiveCallHistoryStorage(makeStorage());
    const h = loadLiveCallHistory();
    expect(h.totalCalls).toBe(0);
    expect(h.recent).toEqual([]);
  });
});

describe('describeLastCall', () => {
  const now = 10_000_000_000;

  it('returns null with no history', () => {
    expect(describeLastCall(now)).toBeNull();
  });

  it('describes "abhi isi minute me" for a sub-minute gap', () => {
    recordLiveCall(now - 30_000, 30);
    expect(describeLastCall(now)?.text).toBe('abhi isi minute me');
  });

  it('describes minutes for a recent call', () => {
    recordLiveCall(now - 5 * 60_000, 30);
    expect(describeLastCall(now)?.text).toBe('~5 min pehle');
  });

  it('describes days for an old call', () => {
    recordLiveCall(now - 3 * 86_400_000, 30);
    const r = describeLastCall(now);
    expect(r?.text).toContain('din pehle');
    expect(r?.diffMs).toBe(3 * 86_400_000);
  });
});

describe('buildLiveCallOverview (AI context injection)', () => {
  const now = 10_000_000_000;

  it('returns empty string when no call has ever completed', () => {
    expect(buildLiveCallOverview(now)).toBe('');
  });

  it('reports total calls + last-call timing and duration', () => {
    recordLiveCall(now - 2 * 86_400_000, 300); // oldest first — recent[] is unshifted
    recordLiveCall(now - 5 * 60_000, 182);
    const out = buildLiveCallOverview(now);
    expect(out).toContain('Total 2 live calls');
    expect(out).toContain('~5 min pehle');
    expect(out).toContain('~182s');
  });

  it('keeps the last-call transcript tail so Misa can answer "last call me kya hui thi"', () => {
    setLastTranscriptSnapshot(['Student: integration samjha do', 'Misa: u aur v sath khelte hai']);
    recordLiveCall(now - 60_000, 90);
    const out = buildLiveCallOverview(now);
    expect(out).toContain('Pichli call me kya discuss hua tha');
    expect(out).toContain('u aur v');
  });

  it('tolerates corrupt storage (empty overview, no crash)', () => {
    storage.setItem('levelup.live.call_history', '{not valid json');
    expect(buildLiveCallOverview(now)).toBe('');
  });
});

describe('purgeLiveCallsForSession (chat deletion forgets its calls)', () => {
  it('removes ONLY the deleted session\'s calls and decrements totalCalls', () => {
    recordLiveCall(10_001, 60, { sessionId: 'chatA' });
    recordLiveCall(20_002, 90, { sessionId: 'chatA' });
    recordLiveCall(30_003, 120, { sessionId: 'chatB' });

    const removed = purgeLiveCallsForSession('chatA');

    expect(removed).toBe(2);
    const h = loadLiveCallHistory();
    expect(h.totalCalls).toBe(1);
    expect(h.recent).toHaveLength(1);
    expect(h.recent[0].sessionId).toBe('chatB');
  });

  it('clears the transcript snapshot when its producing call is purged', () => {
    recordLiveCall(50_000, 120, {
      sessionId: 'chatA',
      updateTranscriptSnapshot: () => ['Student: plan bana do', 'Misa: 30 min ka plan...'],
    });

    purgeLiveCallsForSession('chatA');

    expect(loadLiveCallHistory().lastTranscriptSnapshot).toEqual([]);
    expect(loadLiveCallHistory().lastTranscriptSnapshotAt).toBeUndefined();
  });

  it('keeps the snapshot when a NON-most-recent call is purged', () => {
    recordLiveCall(10_000, 60, { sessionId: 'chatOld' });
    setLastTranscriptSnapshot(['Misa: fresh call words']);
    recordLiveCall(20_000, 40, { sessionId: 'chatNew' });

    purgeLiveCallsForSession('chatOld');

    expect(loadLiveCallHistory().lastTranscriptSnapshot).toEqual(['Misa: fresh call words']);
    expect(loadLiveCallHistory().totalCalls).toBe(1);
  });

  it('legacy records without sessionId are never purged; unknown session is a no-op', () => {
    recordLiveCall(10_000, 60); // no sessionId (legacy)
    expect(purgeLiveCallsForSession('ghost')).toBe(0);
    expect(loadLiveCallHistory().totalCalls).toBe(1);

    expect(purgeLiveCallsForSession('')).toBe(0);
    expect(loadLiveCallHistory().totalCalls).toBe(1);
  });

  it('overview goes fully empty after the last calls are purged', () => {
    recordLiveCall(10_000, 60, { sessionId: 'chatA' });
    recordLiveCall(20_000, 45, { sessionId: 'chatA' });
    purgeLiveCallsForSession('chatA');
    expect(buildLiveCallOverview()).toBe('');
  });
});
