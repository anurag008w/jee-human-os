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
