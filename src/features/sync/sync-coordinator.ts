// SyncCoordinator — orchestrates when the app pushes to / pulls from the
// server. Owns the debounce, the online/offline listener, auto-focus reconciler,
// and fresh-install / multi-device recovery, so the UI just has to call
// attach()/detach() on login/logout.
//
// Multi-Device Resiliency (Plan 1):
//   - On window focus or tab visibility change: checks /sync/status.
//   - If server copy is newer (e.g. edited on mobile), pulls and merges
//     non-destructively (mergeAppState / mergeChatSessions).
//   - On login attach: merges cloud data with local store so neither device's
//     data is wiped.

import type { AuthSession } from '../../lib/auth';
import type { AppState } from '../../core/domain/state';
import type { ChatSession } from '../../core/domain/chat';
import { SyncService, stateSyncPayload, misaSyncPayload, misaFromSync, type SyncScope, type SyncScopeState, type MisaSyncPayload } from './sync.service';
import { mergeAppState, mergeChatSessions, mergeMisaData } from './sync-merge';

/** Push coalescing window — mutations within this span ride one request. */
const PUSH_DEBOUNCE_MS = 2_000;
/** Periodic background check interval (60s). */
const POLL_INTERVAL_MS = 60_000;

export class SyncCoordinator {
  private readonly sync: SyncService;
  private readonly getState: () => AppState;
  private readonly getChatSessions: () => ChatSession[];
  private readonly replaceStore: (sessions: ChatSession[]) => void;
  private readonly replaceState: (state: unknown) => void;
  private readonly getMisaData: () => MisaSyncPayload | null | Promise<MisaSyncPayload | null>;
  private readonly replaceMisaData: (data: MisaSyncPayload) => void;
  private readonly debounceMs: number;

  private session: AuthSession | null = null;
  private dirty = new Set<SyncScope>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  /** True while restoring / merging server data — suppress dirty so a pull never pushes back. */
  private restoring = false;
  /**
   * Bumped on detach/wipe so in-flight async pushes (e.g. a slow misa push that
   * resolved after delete-all) abort instead of resurrecting wiped data.
   */
  private generation = 0;
  /**
   * True once the initial reconcile (pull on fresh install / merge / seed for existing
   * users) has run for the current session.
   */
  private initialSyncDone = false;
  private online = !(typeof navigator !== 'undefined' && navigator.onLine === false);
  private listeners = new Set<() => void>();
  private scopeStates = new Map<SyncScope, SyncScopeState>();
  /**
   * P11 guarded silent re-auth (no 401 spam, no auto-login-with-password):
   * - Only fires while a session is ATTACHED (logout → detach() nulls it and
   *   all re-auth paths early-return).
   * - Re-auth = same stored apiKey (the credential chat already uses via
   *   configureServerAuth), NOT /auth/login — no password exists.
   * - Cooldown 60s between failures; after 2 silent tries we STOP until a
   *   user-initiated login/attach resets the counters.
   */
  private authTroubleSince: number | null = null;
  private authFailures = 0;
  private static readonly AUTH_MAX_SILENT_RETRIES = 2;
  private static readonly AUTH_REPROBE_COOLDOWN_MS = 60_000;
  /** Ready to apply the long-lived apiKey credential (wired from the container). */
  private readonly applyServerCredential: (session: AuthSession) => void;

  constructor(
    sync: SyncService,
    deps: {
      getState: () => AppState;
      getChatSessions: () => ChatSession[];
      replaceStore: (sessions: ChatSession[]) => void;
      replaceState: (state: unknown) => void;
      getMisaData?: () => MisaSyncPayload | null | Promise<MisaSyncPayload | null>;
      replaceMisaData?: (data: MisaSyncPayload) => void;
      /** P11: applies the long-lived apiKey credential to the AI gateway (same credential chat uses). */
      applyServerCredential?: (session: AuthSession) => void;
    },
    opts: { debounceMs?: number } = {},
  ) {
    this.sync = sync;
    this.getState = deps.getState;
    this.getChatSessions = deps.getChatSessions;
    this.replaceStore = deps.replaceStore;
    this.replaceState = deps.replaceState;
    this.getMisaData = deps.getMisaData ?? (() => null);
    this.replaceMisaData = deps.replaceMisaData ?? (() => undefined);
    this.applyServerCredential = deps.applyServerCredential ?? (() => undefined);
    this.debounceMs = opts.debounceMs ?? PUSH_DEBOUNCE_MS;
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => this.handleOnline());
      window.addEventListener('offline', () => this.handleOffline());
      window.addEventListener('focus', () => void this.reconcileIfStale());
      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') void this.reconcileIfStale();
        });
      }
    }
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  private setScopeState(scope: SyncScope, patch: Partial<SyncScopeState>): void {
    const prev = this.scopeStates.get(scope) ?? { scope, state: 'idle', lastSyncedAt: null, lastError: null };
    this.scopeStates.set(scope, { ...prev, ...patch });
  }

  getScopeState(scope: SyncScope): SyncScopeState {
    return this.scopeStates.get(scope) ?? { scope, state: 'idle', lastSyncedAt: null, lastError: null };
  }

  isOnline(): boolean {
    return this.online;
  }

  get isAttached(): boolean {
    return this.session !== null;
  }

  /** Attach after login. Reconciles with server data cleanly. */
  attach(session: AuthSession, opts: { skipInitialSync?: boolean } = {}): Promise<void> | void {
    this.session = session;
    this.authFailures = 0;
    this.authTroubleSince = null;
    this.dirty.clear();
    this.scopeStates.clear();
    this.startPollTimer();
    if (opts.skipInitialSync) {
      // Full data wipe — the server copy was just deleted; never pull it back.
      this.initialSyncDone = true;
      return;
    }
    if (this.online) {
      this.initialSyncDone = true;
      // Return the promise so callers (login flows, tests) can await the
      // initial reconcile/seed; fire-and-forget callers are unaffected.
      return this.initialSync(session);
    }
  }

  detach(): void {
    this.generation += 1;
    if (this.timer) clearTimeout(this.timer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.timer = null;
    this.pollTimer = null;
    this.session = null;
    this.dirty.clear();
    this.inFlight = false;
    this.initialSyncDone = false;
    this.authFailures = 0;
    this.authTroubleSince = null;
    this.scopeStates.clear();
    this.emit();
  }

  private startPollTimer(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => {
      if (this.session && this.online && !this.restoring && !this.inFlight) {
        void this.reconcileIfStale();
      }
    }, POLL_INTERVAL_MS);
  }

  /** The active login session, or null when logged out. */
  getSession(): AuthSession | null {
    return this.session;
  }

  /** Called by storage wrappers whenever app data changes. */
  markDirty(scope: SyncScope): void {
    if (!this.session) return;
    if (this.restoring) return;
    this.dirty.add(scope);
    if (this.online) {
      this.setScopeState(scope, { state: 'syncing', lastError: null });
      this.schedulePush();
    } else {
      this.setScopeState(scope, { state: 'offline' });
      this.emit();
    }
  }

  /** Manual "Sync now" from the Settings UI. */
  async syncNow(): Promise<void> {
    if (!this.session) return;
    if (this.inFlight) return;
    this.online = typeof navigator === 'undefined' || navigator.onLine !== false;
    // First reconcile if stale from other device, then push
    await this.reconcileIfStale();
    this.dirty.add('state');
    this.dirty.add('chat');
    this.dirty.add('misa');
    await this.flush();
    const session = this.session;
    if (session?.isSuperAdmin) {
      await this.sync.forceServerPush(session);
    }
  }

  /**
   * Automatically pulls and merges remote updates if another device (e.g. phone or Linux)
   * pushed newer changes.
   */
  async reconcileIfStale(): Promise<void> {
    if (!this.session || !this.online || this.restoring || this.inFlight) return;
    // P11: while auth is in trouble, do NOT hammer /sync/status per scope —
    // just retry the guarded probe when the 60s cooldown elapses (these
    // moments = tab-open / focus / visibility / poll — exactly when the user
    // asked for a sync). When both credentials are rejected we stay quiet.
    if (this.authTroubleSince !== null) {
      if (
        this.authFailures <= SyncCoordinator.AUTH_MAX_SILENT_RETRIES &&
        Date.now() - this.authTroubleSince >= SyncCoordinator.AUTH_REPROBE_COOLDOWN_MS
      ) {
        await this.silentReauth();
      }
      return;
    }
    const session = this.session;
    try {
      const stateStatus = await this.sync.status(session, 'state');
      const curStateSync = this.getScopeState('state');
      if (stateStatus.exists && stateStatus.updatedAt && stateStatus.updatedAt > (curStateSync.lastSyncedAt || '')) {
        const remoteState = await this.sync.pull(session, 'state');
        if (remoteState?.state) {
          this.restoring = true;
          try {
            const merged = mergeAppState(this.getState(), remoteState.state as AppState);
            this.replaceState(merged);
            this.setScopeState('state', { state: 'online', lastSyncedAt: remoteState.updatedAt, lastError: null });
          } finally {
            this.restoring = false;
          }
        }
      }

      const chatStatus = await this.sync.status(session, 'chat');
      const curChatSync = this.getScopeState('chat');
      if (chatStatus.exists && chatStatus.updatedAt && chatStatus.updatedAt > (curChatSync.lastSyncedAt || '')) {
        const remoteChat = await this.sync.pull(session, 'chat');
        const remoteSessions = (remoteChat?.state as { sessions?: ChatSession[] })?.sessions;
        if (Array.isArray(remoteSessions)) {
          this.restoring = true;
          try {
            const merged = mergeChatSessions(this.getChatSessions(), remoteSessions);
            this.replaceStore(merged);
            this.setScopeState('chat', { state: 'online', lastSyncedAt: remoteChat?.updatedAt ?? chatStatus.updatedAt, lastError: null });
          } finally {
            this.restoring = false;
          }
        }
      }

      await this.reconcileMisaIfStale(session);
      this.emit();
    } catch {
      // Best-effort background reconcile
    }
  }

  private schedulePush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.debounceMs);
  }

  private async flush(): Promise<void> {
    if (!this.session || this.inFlight || this.dirty.size === 0 || !this.online) return;
    this.inFlight = true;
    const session = this.session;
    const scopes = [...this.dirty];
    this.dirty.clear();
    try {
      for (const scope of scopes) {
        if (scope === 'chat') {
          await this.pushChat(session);
        } else if (scope === 'misa') {
          await this.pushMisa(session);
        } else {
          await this.pushState(session);
        }
      }
    } finally {
      this.inFlight = false;
      this.emit();
    }
  }

  private async pushState(session: AuthSession): Promise<void> {
    const gen = this.generation;
    const now = new Date().toISOString();
    const res = await this.sync.push(session, 'state', stateSyncPayload(this.getState()), now);
    if (gen !== this.generation) return; // detached/wipe while in flight — abort
    if (res.ok) {
      this.setScopeState('state', { state: 'online', lastSyncedAt: now, lastError: null });
    } else {
      this.setScopeState('state', { state: 'error', lastError: res.message ?? 'Sync failed' });
      if (res.auth) this.handleAuthFailure();
      this.dirty.add('state');
    }
  }

  private async pushChat(session: AuthSession): Promise<void> {
    const gen = this.generation;
    const now = new Date().toISOString();
    const payload = { version: 1, sessions: this.getChatSessions() };
    const res = await this.sync.push(session, 'chat', payload, now);
    if (gen !== this.generation) return;
    if (res.ok) {
      this.setScopeState('chat', { state: 'online', lastSyncedAt: now, lastError: null });
    } else {
      this.setScopeState('chat', { state: 'error', lastError: res.message ?? 'Sync failed' });
      if (res.auth) this.handleAuthFailure();
      this.dirty.add('chat');
    }
  }

  private async pushMisa(session: AuthSession): Promise<void> {
    const gen = this.generation;
    const data = await this.getMisaData();
    if (!data || gen !== this.generation) return;
    const now = new Date().toISOString();
    const res = await this.sync.push(session, 'misa', misaSyncPayload(data), now);
    if (gen !== this.generation) return;
    if (res.ok) {
      this.setScopeState('misa', { state: 'online', lastSyncedAt: now, lastError: null });
    } else {
      this.setScopeState('misa', { state: 'error', lastError: res.message ?? 'Sync failed' });
      if (res.auth) this.handleAuthFailure();
      this.dirty.add('misa');
    }
  }

  /** Pulls and merges Misa's relationship + proactive state when the server copy is newer. */
  private async reconcileMisaIfStale(session: AuthSession): Promise<void> {
    const status = await this.sync.status(session, 'misa');
    if (!status.exists || !status.updatedAt) return;
    const cur = this.getScopeState('misa');
    if (status.updatedAt <= (cur.lastSyncedAt || '')) return;

    const remote = await this.sync.pull(session, 'misa');
    if (!remote) return;
    const parsed = misaFromSync(remote.state);
    if (!parsed) return;

    this.restoring = true;
    try {
      const merged = mergeMisaData(await this.getMisaData(), parsed);
      if (merged) {
        this.replaceMisaData(merged);
        this.setScopeState('misa', { state: 'online', lastSyncedAt: remote.updatedAt ?? status.updatedAt, lastError: null });
      }
    } finally {
      this.restoring = false;
    }
  }

  /**
   * On login (attach): reconcile local vs server non-destructively.
   */
  private async initialSync(session: AuthSession): Promise<void> {
    const scopes = await this.sync.scopes(session);
    const hasRemote = scopes.length > 0;
    const hasLocal = this.hasMeaningfulData();

    if (!hasRemote) {
      // Server is empty: seed server with existing local data
      if (hasLocal) {
        await this.seedServer(session);
      }
      return;
    }

    if (!hasLocal) {
      // Local is fresh/empty: pull everything down
      await this.pullAll(session);
      return;
    }

    // Both local and server have data: perform non-destructive smart merge!
    this.restoring = true;
    try {
      for (const scope of scopes) {
        const remote = await this.sync.pull(session, scope);
        if (!remote) continue;
        if (scope === 'chat') {
          const store = remote.state as { sessions?: ChatSession[] } | undefined;
          const remoteSessions = Array.isArray(store?.sessions) ? store.sessions : [];
          const merged = mergeChatSessions(this.getChatSessions(), remoteSessions);
          this.replaceStore(merged);
          this.setScopeState('chat', { state: 'online', lastSyncedAt: remote.updatedAt, lastError: null });
        } else if (scope === 'misa') {
          const parsed = misaFromSync(remote.state);
          const merged = mergeMisaData(await this.getMisaData(), parsed);
          if (merged) {
            this.replaceMisaData(merged);
            this.setScopeState('misa', { state: 'online', lastSyncedAt: remote.updatedAt, lastError: null });
          }
        } else {
          const merged = mergeAppState(this.getState(), remote.state as AppState);
          this.replaceState(merged);
          this.setScopeState('state', { state: 'online', lastSyncedAt: remote.updatedAt, lastError: null });
        }
      }
    } finally {
      this.restoring = false;
    }
    this.emit();

    // Push the unified merge back to cloud
    this.dirty.add('state');
    this.dirty.add('chat');
    this.dirty.add('misa');
    void this.flush();
  }

  /** True when the local state carries actual user progress (not an empty shell). */
  private hasMeaningfulData(): boolean {
    const state = this.getState();
    if (state.startDateISO !== null) return true;
    if (Object.keys(state.taskLogs ?? {}).length > 0) return true;
    if ((state.memory?.entries ?? []).length > 0) return true;
    if ((state.customHabits ?? []).length > 0) return true;
    if ((state.subjectPlanners ?? []).length > 0) return true;
    if ((state.clearedLevels ?? []).length > 0) return true;
    if ((state.weeklyReviews ?? []).length > 0) return true;
    if ((state.monthlyAssessments ?? []).length > 0) return true;
    if ((state.customTodos ?? []).length > 0) return true;
    if ((state.studyVault ?? []).length > 0) return true;
    return false;
  }

  /** Fresh install: pull every scope the server has for this user. */
  private async pullAll(session: AuthSession): Promise<void> {
    const scopes = await this.sync.scopes(session);
    this.restoring = true;
    try {
      for (const scope of scopes) {
        const remote = await this.sync.pull(session, scope);
        if (!remote) continue;
        if (scope === 'chat') {
          const store = remote.state as { sessions?: ChatSession[] } | undefined;
          const sessions = Array.isArray(store?.sessions) ? store.sessions : [];
          if (sessions.length > 0) this.replaceStore(sessions);
          this.setScopeState('chat', { state: 'online', lastSyncedAt: remote.updatedAt, lastError: null });
        } else if (scope === 'misa') {
          const parsed = misaFromSync(remote.state);
          if (parsed) {
            this.replaceMisaData(parsed);
            this.setScopeState('misa', { state: 'online', lastSyncedAt: remote.updatedAt, lastError: null });
          }
        } else {
          this.replaceState(remote.state);
          this.setScopeState('state', { state: 'online', lastSyncedAt: remote.updatedAt, lastError: null });
        }
      }
    } finally {
      this.restoring = false;
    }
    this.emit();
  }

  /** Existing user: push local data up once so the server has a backup. */
  private async seedServer(session: AuthSession): Promise<void> {
    const gen = this.generation;
    const now = new Date().toISOString();
    const stateRes = await this.sync.push(session, 'state', stateSyncPayload(this.getState()), now);
    if (gen !== this.generation) return; // detached/wipe mid-seed — abort (never resurrect)
    if (stateRes.ok) {
      this.setScopeState('state', { state: 'online', lastSyncedAt: now, lastError: null });
    } else {
      this.setScopeState('state', { state: 'error', lastError: stateRes.message ?? 'Sync failed' });
      if (stateRes.auth) this.handleAuthFailure();
    }
    const sessions = this.getChatSessions();
    if (sessions.length > 0 && gen === this.generation) {
      const chatRes = await this.sync.push(session, 'chat', { version: 1, sessions }, now);
      if (gen !== this.generation) return;
      if (chatRes.ok) {
        this.setScopeState('chat', { state: 'online', lastSyncedAt: now, lastError: null });
      } else {
        this.setScopeState('chat', { state: 'error', lastError: chatRes.message ?? 'Sync failed' });
        if (chatRes.auth) this.handleAuthFailure();
      }
    }
    const misaData = await this.getMisaData();
    if (misaData && gen === this.generation) {
      const misaRes = await this.sync.push(session, 'misa', misaSyncPayload(misaData), now);
      if (gen !== this.generation) return;
      if (misaRes.ok) {
        this.setScopeState('misa', { state: 'online', lastSyncedAt: now, lastError: null });
      } else {
        this.setScopeState('misa', { state: 'error', lastError: misaRes.message ?? 'Sync failed' });
        if (misaRes.auth) this.handleAuthFailure();
      }
    }
    this.emit();
  }

  private handleOnline(): void {
    this.online = true;
    if (!this.session) return;
    if (!this.initialSyncDone) {
      this.initialSyncDone = true;
      if (this.dirty.size === 0) {
        void this.initialSync(this.session);
        return;
      }
    }
    if (this.dirty.size > 0) {
      void this.flush();
    } else {
      void this.reconcileIfStale();
    }
  }

  private handleOffline(): void {
    this.online = false;
    for (const scope of this.scopeStates.keys()) {
      this.setScopeState(scope, { state: 'offline' });
    }
    this.emit();
  }

  /**
   * P11: same stored apiKey applied + cheap probe. Never /auth/login (no
   * password is stored — a future dev must NOT start persisting one here).
   * Runs only on the 60s poll / tab-open / focus / visibility moments.
   */
  private async silentReauth(): Promise<void> {
    const session = this.session;
    if (!session) return; // logout → kabhi auto re-auth nahi
    if (!session.apiKey) return; // fallback credential hi nahi
    if (this.authTroubleSince && Date.now() - this.authTroubleSince < SyncCoordinator.AUTH_REPROBE_COOLDOWN_MS) return;

    // Chat jaisa hi long-lived credential dobara apply (koi password nahi chahiye)
    this.applyServerCredential(session);

    const verdict = await this.sync.probe(session);
    if (verdict === 'ok') {
      this.authFailures = 0;
      this.authTroubleSince = null;
      this.setScopeState('state', { state: 'online', lastError: null });
    } else if (verdict === 'auth') {
      // Dono stored credentials reject → banned/removed server-side → CHUP
      this.authFailures = SyncCoordinator.AUTH_MAX_SILENT_RETRIES + 1;
      this.setScopeState('state', { state: 'error', lastError: 'Session invalid — Settings → Sync me re-login karo.' });
    }
    this.emit();
  }

  /** A push came back with a final 401/403 — bounded, cooldown-gated reaction. */
  private handleAuthFailure(): void {
    if (this.authTroubleSince === null) this.authTroubleSince = Date.now();
    this.authFailures += 1;
    if (this.authFailures <= SyncCoordinator.AUTH_MAX_SILENT_RETRIES) {
      void this.silentReauth(); // same credentials, silent
    } else {
      // give up silently + surface honest state (no 401 spam)
      this.setScopeState('state', { state: 'error', lastError: 'Session invalid — Settings → Sync me re-login karo.' });
      this.emit();
    }
  }
}
