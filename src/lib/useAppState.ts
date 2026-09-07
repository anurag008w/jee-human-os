import { useEffect, useState } from 'react';
import type { AppState } from '../types';
import { emptyAppState } from '../core/domain/state';
import { container } from '../di/container';
import { dateForDayNumber } from '../features/habit-engine/dates';
import { mergeDaySummary, shouldRollupDay } from '../features/ai/summary-scheduler';
import { canAutoUnlockSession, isAdminUnlocked, setAdminUnlocked, verifyAdminLogin, type AdminVerifyResult } from './admin';
import { loadSession } from './auth';
import { todayISO } from './storage';

/**
 * Single source of truth for the UI. Reads/writes through the DI container's
 * StateStore so every service sees the same object graph the screens render.
 *
 * Admin mode lets an unlocked user preview any content day of the journey:
 * `today` becomes the rest-shifted calendar date for that content day instead
 * of the real date. Everything downstream (plan builder, progress, chat
 * context) then renders that day, so the whole app acts as a time machine
 * that also honors rest-day sliding.
 */
export function useAppState() {
  const [state, setState] = useState<AppState>(() => container.store.get());
  const [realToday, setRealToday] = useState<string>(() => todayISO(container.store.get().timeZone));
  const [adminUnlocked, setAdminUnlockedState] = useState<boolean>(() => isAdminUnlocked(loadSession()?.username ?? null));
  const [adminDay, setAdminDayState] = useState<number | null>(null);
  /** One-time banner when storage was full and old memories got trimmed (M7). */
  const [pruneNotice, setPruneNotice] = useState<string | null>(null);
  /** One-time banner when the last persist hit a storage WRITE failure
   *  (quota / private-mode) — data is safe in memory but will be lost on
   *  restart unless the user frees space (audit round 1). */
  const [storageWriteError, setStorageWriteError] = useState<string | null>(null);
  /** One-time banner when the CHAT blob failed to persist (quota) — chats are
   *  safe in memory but lost on restart (audit round 2). */
  const [chatWriteError, setChatWriteError] = useState<string | null>(null);

  // Listen for external store updates (e.g., from chat tools) and sync state.
  // Hang-fix P3: event-driven — the store emits on every save, so we never
  // poll, and the UI reflects a mutation immediately instead of within 100ms.
  useEffect(() => {
    const syncFromStore = () => {
      setState(container.store.get());
      // Surface any silent memory-pruning notice (M7) — consumed once, so the
      // banner never re-appears unless a NEW prune happens.
      const notice = container.store.consumePruneNotice();
      if (notice) setPruneNotice(notice);
      // Same one-shot pattern for storage WRITE failures (audit round 1).
      const writeErr = container.store.consumeWriteError();
      if (writeErr) setStorageWriteError(writeErr);
      // Chat-blob persist failures (audit round 2 — quota asymmetry).
      const chatWriteErr = container.consumeChatWriteError();
      if (chatWriteErr) setChatWriteError(chatWriteErr);
    };
    syncFromStore();
    return container.store.subscribe(syncFromStore);
  }, []);

  // Keep "today" fresh if the app is left open across midnight
  useEffect(() => {
    const id = setInterval(() => setRealToday(todayISO(container.store.get().timeZone)), 60 * 1000);
    return () => clearInterval(id);
  }, []);

  // Day snapshot (M8): the daily summary pipeline used to be dead code. Run it
  // once per calendar day — on mount and on the minute tick — so the journey
  // context finally sees real day snapshots. Best-effort: a failure must never
  // block the app, and the merged result is based on the LATEST state so
  // concurrent edits are never lost.
  useEffect(() => {
    let cancelled = false;
    async function maybeRollupDay() {
      const s = container.store.get();
      const date = todayISO(s.timeZone);
      if (!shouldRollupDay(s, date)) return;
      let next: AppState;
      try {
        next = await container.summaries.runDailyPipeline(s, date);
      } catch {
        return; // summary is best-effort
      }
      if (cancelled) return;
      const latest = container.store.get();
      if (!shouldRollupDay(latest, date)) return; // another rollup already landed
      container.store.save(mergeDaySummary(latest, next, date));
    }
    void maybeRollupDay();
    const id = setInterval(() => void maybeRollupDay(), 60 * 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const today =
    adminUnlocked && adminDay != null && state.startDateISO
      ? dateForDayNumber(adminDay, state.startDateISO, state.restDays ?? [])
      : realToday;

  function update(updater: (s: AppState) => AppState) {
    setState((s) => {
      const next = updater(s);
      container.store.save(next);
      return next;
    });
  }

  /** Re-reads the store snapshot (after service-level mutations, e.g. chat tools). */
  function refresh() {
    setState(container.store.get());
  }

  function startJourney() {
    update((s) => ({ ...s, startDateISO: todayISO(s.timeZone) }));
  }

  function resetAll() {
    if (confirm('Poora progress reset karna hai? Is code SARA progress — tareeqa, tasks, memory — delete ho jayega aur ye undo nahi ho sakta. Kya aap 100% sure hain?')) {
      update(() => emptyAppState());
    }
  }

  /** Unlocks straight away when the logged-in session is a server super admin. */
  function autoUnlock(): boolean {
    const session = loadSession();
    if (!canAutoUnlockSession(session)) return false;
    setAdminUnlocked(session?.username ?? null, true);
    setAdminUnlockedState(true);
    return true;
  }

  /** Verifies credentials against the server; unlocks only for a super admin. */
  async function unlockAdmin(username: string, password: string): Promise<AdminVerifyResult> {
    const result = await verifyAdminLogin(username, password);
    if (!result.ok) return result;
    setAdminUnlocked(username.trim(), true);
    setAdminUnlockedState(true);
    return { ok: true };
  }

  /** Locks the panel and drops any previewed day. */
  function lockAdmin() {
    setAdminUnlocked(loadSession()?.username ?? null, false);
    setAdminUnlockedState(false);
    setAdminDayState(null);
  }

  /** Jumps the preview to an absolute day (1-based); null returns to real date. */
  function setAdminDay(day: number | null) {
    setAdminDayState(day);
  }

  return { state, today, update, refresh, startJourney, resetAll, adminUnlocked, adminDay, unlockAdmin, autoUnlock, lockAdmin, setAdminDay, pruneNotice, dismissPruneNotice: () => setPruneNotice(null), storageWriteError, dismissStorageWriteError: () => setStorageWriteError(null), chatWriteError, dismissChatWriteError: () => setChatWriteError(null) };
}
