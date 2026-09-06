import { describe, it, expect, beforeEach } from 'vitest';
import { emptyAppState, type AppState } from '../../../core/domain/state';
import type { ChatSession } from '../../../core/domain/chat';
import type { AuthSession } from '../../../lib/auth';
import { SyncCoordinator } from '../sync-coordinator';
import { SyncService, type SyncScope, type SyncPushResult } from '../sync.service';

const SESSION: AuthSession = {
  serverUrl: 'https://example.com',
  username: 'testuser',
  role: 'user',
  isSuperAdmin: false,
  apiKey: 'sk-test',
  token: 'jwt-test',
  loggedInAt: '2026-01-01T00:00:00.000Z',
};

class FakeSync extends SyncService {
  scopesOnServer: SyncScope[] = [];
  serverState: Partial<Record<SyncScope, unknown>> = {};
  pushes: Array<{ scope: SyncScope; state: unknown }> = [];
  deletes: SyncScope[] = [];
  forcePushes = 0;
  failNext = false;
  /** When 'auth', every push fails with a final 401 (like an invalid session). */
  authMode: 'ok' | 'auth' = 'ok';
  probeResult: 'ok' | 'auth' | 'network' | 'server' = 'ok';
  probes = 0;
  statusCalls = 0;

  constructor() {
    super({} as never);
  }

  override async scopes(_s: AuthSession): Promise<SyncScope[]> {
    return this.scopesOnServer;
  }

  override async status(_s: AuthSession): Promise<{ exists: boolean; updatedAt: string; bytes: number }> {
    this.statusCalls++;
    return { exists: false, updatedAt: '', bytes: 0 };
  }

  override async pull(_s: AuthSession, scope: SyncScope) {
    if (this.serverState[scope] === undefined) return null;
    return { updatedAt: '2026-01-02T00:00:00.000Z', state: this.serverState[scope] };
  }

  override async push(_s: AuthSession, scope: SyncScope, state: unknown): Promise<SyncPushResult> {
    this.pushes.push({ scope, state });
    if (this.failNext) return { ok: false, updatedAt: '', status: 500, message: 'boom' };
    if (this.authMode === 'auth') return { ok: false, updatedAt: '', status: 401, message: 'unauthorized', auth: true };
    return { ok: true, updatedAt: '2026-01-02T00:00:00.000Z' };
  }

  override async probe(_s: AuthSession): Promise<'ok' | 'auth' | 'network' | 'server'> {
    this.probes++;
    return this.probeResult;
  }

  override async forceServerPush(_s: AuthSession): Promise<boolean> {
    this.forcePushes++;
    return true;
  }

  override async wipe(_s: AuthSession, _scope?: SyncScope): Promise<boolean> {
    return true;
  }
}

function makeCoordinator(fake: FakeSync, overrides: Record<string, unknown> = {}) {
  return new SyncCoordinator(fake as SyncService, {
    getState: () => state,
    getChatSessions: () => chat,
    replaceStore: (sessions) => {
      chat = sessions;
    },
    replaceState: (s) => {
      state = s as AppState;
    },
    ...overrides,
  });
}

let state: AppState = emptyAppState();
let chat: ChatSession[] = [];

describe('SyncCoordinator', () => {
  beforeEach(() => {
    state = emptyAppState();
    chat = [];
  });

  it('fresh install pulls server data (no meaningful local state)', async () => {
    const fake = new FakeSync();
    fake.scopesOnServer = ['state'];
    fake.serverState.state = { ...emptyAppState(), startDateISO: '2026-01-01' };
    const coord = makeCoordinator(fake);
    await coord.attach(SESSION);
    // Small wait so the async initialSync settles.
    await new Promise((r) => setTimeout(r, 0));
    expect(state.startDateISO).toBe('2026-01-01');
    expect(fake.pushes).toHaveLength(0);
  });

  it('existing user seeds the server (has local data → push, no pull)', async () => {
    const fake = new FakeSync();
    state = { ...emptyAppState(), startDateISO: '2026-01-01', customHabits: [] };
    fake.scopesOnServer = [];
    const coord = makeCoordinator(fake);
    await coord.attach(SESSION);
    await new Promise((r) => setTimeout(r, 0));
    expect(fake.pushes.length).toBeGreaterThanOrEqual(1);
    expect(fake.pushes.some((p) => p.scope === 'state')).toBe(true);
  });

  it('existing user seeds chat only when sessions exist', async () => {
    const fake = new FakeSync();
    state = { ...emptyAppState(), startDateISO: '2026-01-01' };
    chat = [{ id: 's1', title: 't', messages: [], prefs: {} as never, createdAt: '', updatedAt: '' }];
    const coord = makeCoordinator(fake);
    await coord.attach(SESSION);
    await new Promise((r) => setTimeout(r, 0));
    expect(fake.pushes.some((p) => p.scope === 'chat')).toBe(true);
  });

  it('fresh install with empty server leaves local untouched', async () => {
    const fake = new FakeSync();
    fake.scopesOnServer = [];
    const coord = makeCoordinator(fake);
    await coord.attach(SESSION);
    await new Promise((r) => setTimeout(r, 0));
    expect(state.startDateISO).toBeNull();
    expect(fake.pushes).toHaveLength(0);
  });

  it('failed seed marks state error and retries on next dirty', async () => {
    const fake = new FakeSync();
    fake.failNext = true;
    state = { ...emptyAppState(), startDateISO: '2026-01-01' };
    const coord = makeCoordinator(fake);
    await coord.attach(SESSION);
    await new Promise((r) => setTimeout(r, 0));
    expect(coord.getScopeState('state').state).toBe('error');
    fake.failNext = false;
    coord.markDirty('state');
    await new Promise((r) => setTimeout(r, 2200));
    expect(coord.getScopeState('state').lastError).toBeNull();
  });

  it('attach with skipInitialSync does not pull or seed', async () => {
    const fake = new FakeSync();
    fake.scopesOnServer = ['state'];
    fake.serverState.state = { ...emptyAppState(), startDateISO: '2026-01-01' };
    state = { ...emptyAppState(), startDateISO: '2026-01-02' };
    const coord = makeCoordinator(fake);
    await coord.attach(SESSION, { skipInitialSync: true });
    await new Promise((r) => setTimeout(r, 0));
    // Local state is left untouched (no pull) and nothing is pushed (no seed).
    expect(state.startDateISO).toBe('2026-01-02');
    expect(fake.pushes).toHaveLength(0);
    // Coordinator is still attached for future edits.
    expect(coord.isAttached).toBe(true);
  });

  it('syncNow pushes both scopes and force-pushes the server for admins', async () => {
    const fake = new FakeSync();
    const coord = makeCoordinator(fake);
    await coord.attach({ ...SESSION, isSuperAdmin: true }, { skipInitialSync: true });
    await coord.syncNow();
    expect(fake.pushes.map((p) => p.scope)).toEqual(['state', 'chat']);
    expect(fake.forcePushes).toBe(1);
  });

  it('syncNow skips the server force-push for non-admin users', async () => {
    const fake = new FakeSync();
    const coord = makeCoordinator(fake);
    await coord.attach(SESSION, { skipInitialSync: true });
    await coord.syncNow();
    expect(fake.pushes.map((p) => p.scope)).toEqual(['state', 'chat']);
    expect(fake.forcePushes).toBe(0);
  });

  it('P11: repeated final 401s surface an honest error, bounded silent retries, no 401 spam', async () => {
    const fake = new FakeSync();
    fake.authMode = 'auth';
    fake.probeResult = 'auth'; // server rejects the apiKey fallback too (banned/removed)
    const coord = makeCoordinator(fake, { applyServerCredential: () => undefined });
    await coord.attach(SESSION, { skipInitialSync: true });

    // 3 flush cycles, each 401 → silentReauth is cooldown-gated (60s) and after
    // AUTH_MAX_SILENT_RETRIES=2 we give up with a clear re-login error.
    coord.markDirty('state');
    await new Promise((r) => setTimeout(r, 2200));
    coord.markDirty('state');
    await new Promise((r) => setTimeout(r, 2200));
    coord.markDirty('state');
    await new Promise((r) => setTimeout(r, 2200));

    expect(coord.getScopeState('state').state).toBe('error');
    expect(coord.getScopeState('state').lastError).toContain('re-login');
    // Cooldown blocked immediate reprobes — no silent 401 hammering.
    expect(fake.probes).toBe(0);
  }, 15_000);

  it('P11: reconcileIfStale stays quiet while auth is in trouble (no status hammering)', async () => {
    const fake = new FakeSync();
    fake.authMode = 'auth';
    const coord = makeCoordinator(fake);
    await coord.attach(SESSION, { skipInitialSync: true });

    coord.markDirty('state');
    await new Promise((r) => setTimeout(r, 2200)); // trigger the 401 path

    const statusCallsBefore = fake.statusCalls;
    await coord.reconcileIfStale(); // poll/focus/visibility moment
    expect(fake.statusCalls).toBe(statusCallsBefore); // no status probe fired
  });

  it('P11: attach resets auth counters so a fresh login recovers immediately', async () => {
    const fake = new FakeSync();
    fake.authMode = 'auth';
    const coord = makeCoordinator(fake);
    await coord.attach(SESSION, { skipInitialSync: true });

    coord.markDirty('state');
    await new Promise((r) => setTimeout(r, 2200));
    expect(coord.getScopeState('state').state).toBe('error');

    // Session fixed; user re-login → attach → counters cleared → healthy again.
    fake.authMode = 'ok';
    await coord.attach(SESSION, { skipInitialSync: true });
    coord.markDirty('state');
    await new Promise((r) => setTimeout(r, 2200));
    expect(coord.getScopeState('state').state).toBe('online');
    expect(coord.getScopeState('state').lastError).toBeNull();
  });
});
