// SyncService — offline-first backup to the SmartRotator gateway.
//
// The app is push-authoritative: every mutation (state, chat, memory,
// settings, providers) is pushed to the server under the logged-in user's own
// folder (data/sync/<user>/<scope>.json on the server). The server never
// overwrites app data — it only stores the latest push (last-write-wins).
//
// Fresh-install / new-device recovery happens on login: the app pulls what the
// server has for the user and merges it (server data wins only when the local
// store is empty, i.e. a brand-new install).
//
// Auth: the user's own JWT token (kept in the AuthSession) — the same
// credential used for every gateway call. On mobile it goes through the
// native HTTP stack (no CORS); on web it falls back to fetch.
//
// Scopes mirror the server layout:
//   state    → whole AppState (plan, tasks, logs, memory, profile, providers…)
//   chat     → chat sessions + messages
//   settings → AI/chat preferences (kept separate so re-login can restore
//              prefs without clobbering live progress)

import type { HttpClient } from '../../infra/ai/http';
import { HttpError } from '../../infra/ai/http';
import type { AuthSession } from '../../lib/auth';
import type { AppState } from '../../core/domain/state';
import type { ChatStoreState } from '../../core/domain/chat';
import type { RelationshipState } from '../ai/relationship-state';
import type { MisaProactiveBlob } from '../ai/proactive-agent.service';
import { normalizeState } from '../../infra/storage/state-repository';
import { normalizeChatSessions } from '../backup/backup.service';

export type SyncScope = 'state' | 'chat' | 'settings' | 'misa';

export interface SyncStatus {
  exists: boolean;
  updatedAt: string;
  bytes: number;
}

export interface SyncPushResult {
  ok: boolean;
  updatedAt: string;
  status?: number;
  message?: string;
  /** True when the FINAL error was a 401/403 — the stored session is invalid. */
  auth?: boolean;
}

/** What a scope is syncing right now — surfaced in the Settings UI. */
export type SyncState = 'idle' | 'syncing' | 'online' | 'offline' | 'error';

export interface SyncScopeState {
  scope: SyncScope;
  state: SyncState;
  lastSyncedAt: string | null;
  lastError: string | null;
}

interface SyncStatusResponse {
  username?: string;
  exists?: boolean;
  scope?: string;
  updated_at?: string;
  bytes?: number;
}

interface SyncGetResponse {
  username?: string;
  scope?: string;
  exists?: boolean;
  updated_at?: string;
  state?: unknown;
}

interface SyncPutResponse {
  username?: string;
  scope?: string;
  updated_at?: string;
  ok?: boolean;
}

interface SyncDeleteResponse {
  username?: string;
  scope?: string;
  deleted?: boolean;
}

export class SyncService {
  private readonly http: HttpClient;

  constructor(http: HttpClient) {
    this.http = http;
  }

  private headers(session: AuthSession, bearer?: string): Record<string, string> {
    return { Authorization: `Bearer ${bearer ?? session.token ?? session.apiKey ?? ''}`, 'Content-Type': 'application/json' };
  }

  /**
   * P11 guarded re-auth: runs the request with the stored token; on a 401/403
   * retries ONCE with the long-lived apiKey — the SAME stored credential chat
   * already uses (token expiry/restart does NOT invalidate the apiKey). This
   * is never /auth/login: no password exists, so the apiKey fallback IS the
   * re-auth. Callers like status/scopes/pull still swallow the final error
   * (best-effort), but push() surfaces `auth: true` when both failed so the
   * coordinator can back off instead of spamming 401s.
   */
  private async requestWithAuth<T>(session: AuthSession, run: (bearer: string) => Promise<T>): Promise<T> {
    try {
      return await run(session.token || (session.apiKey ?? ''));
    } catch (err) {
      const first = session.token || (session.apiKey ?? '');
      const fallback = session.apiKey;
      if (err instanceof HttpError && err.kind === 'auth' && fallback && fallback !== first) {
        return await run(fallback); // silent same-credential re-auth
      }
      throw err;
    }
  }

  /** Server status for one scope (exists / updated_at / size). */
  async status(session: AuthSession, scope: SyncScope): Promise<SyncStatus> {
    try {
      const res = await this.requestWithAuth(session, (bearer) =>
        this.http.requestJson<SyncStatusResponse>({
          url: `${session.serverUrl}/sync/status?scope=${scope}`,
          method: 'GET',
          headers: this.headers(session, bearer),
          timeoutMs: 10_000,
          retries: 1,
        }),
      );
      return { exists: res.exists === true, updatedAt: res.updated_at ?? '', bytes: res.bytes ?? 0 };
    } catch {
      return { exists: false, updatedAt: '', bytes: 0 };
    }
  }

  /** Which scopes the server has for this user (fresh install pull hint). */
  async scopes(session: AuthSession): Promise<SyncScope[]> {
    try {
      const res = await this.requestWithAuth(session, (bearer) =>
        this.http.requestJson<{ scopes?: string[] }>({
          url: `${session.serverUrl}/sync/scopes`,
          method: 'GET',
          headers: this.headers(session, bearer),
          timeoutMs: 10_000,
          retries: 1,
        }),
      );
      const known: SyncScope[] = ['state', 'chat', 'settings', 'misa'];
      return (res.scopes ?? []).filter((s): s is SyncScope => (known as string[]).includes(s));
    } catch {
      return [];
    }
  }

  /** Pull one scope from the server. Returns the raw payload (null when absent). */
  async pull(session: AuthSession, scope: SyncScope): Promise<{ updatedAt: string; state: unknown } | null> {
    try {
      const res = await this.requestWithAuth(session, (bearer) =>
        this.http.requestJson<SyncGetResponse>({
          url: `${session.serverUrl}/sync/state?scope=${scope}`,
          method: 'GET',
          headers: this.headers(session, bearer),
          timeoutMs: 15_000,
          retries: 1,
        }),
      );
      if (!res.exists) return null;
      return { updatedAt: res.updated_at ?? '', state: res.state ?? {} };
    } catch {
      return null;
    }
  }

  /** Push one scope to the server (push-authoritative, last-write-wins). */
  async push(session: AuthSession, scope: SyncScope, state: unknown, updatedAt: string): Promise<SyncPushResult> {
    try {
      const res = await this.requestWithAuth(session, (bearer) =>
        this.http.requestJson<SyncPutResponse>({
          url: `${session.serverUrl}/sync/state?scope=${scope}`,
          method: 'PUT',
          headers: this.headers(session, bearer),
          body: { state, updated_at: updatedAt },
          timeoutMs: 15_000,
          retries: 1,
        }),
      );
      return { ok: res.ok === true, updatedAt: res.updated_at ?? updatedAt };
    } catch (err) {
      return {
        ok: false,
        updatedAt: updatedAt,
        status: err instanceof HttpError ? err.status : undefined,
        message: err instanceof Error ? err.message : String(err),
        auth: err instanceof HttpError && err.kind === 'auth',
      };
    }
  }

  /** Ask the server to force-push its data folder to GitHub right now.
   *  Used by the "Sync now" button — otherwise the server waits for its own
   *  180s sync loop. Admin-only server-side; non-admins get 403 and we fall
   *  back to the loop, so a failure here is never fatal. */
  async forceServerPush(session: AuthSession): Promise<boolean> {
    try {
      const res = await this.requestWithAuth(session, (bearer) =>
        this.http.requestJson<{ pushed?: boolean }>({
          url: `${session.serverUrl}/admin/sync/now`,
          method: 'POST',
          headers: this.headers(session, bearer),
          timeoutMs: 15_000,
          retries: 0,
        }),
      );
      return res.pushed === true;
    } catch {
      return false;
    }
  }

  /** Delete the user's whole sync folder on the server (logout wipe). */
  async wipe(session: AuthSession): Promise<boolean> {
    try {
      const res = await this.requestWithAuth(session, (bearer) =>
        this.http.requestJson<SyncDeleteResponse>({
          url: `${session.serverUrl}/sync/state?scope=*`,
          method: 'DELETE',
          headers: this.headers(session, bearer),
          timeoutMs: 15_000,
          retries: 1,
        }),
      );
      return res.deleted === true;
    } catch {
      return false;
    }
  }

  /**
   * P11: cheap credential validation → 'ok' | 'auth' | 'network' | 'server'.
   * Both the token AND the apiKey fallback are exercised by requestWithAuth —
   * so 'auth' means the server rejected BOTH stored credentials (banned /
   * removed server-side) and the coordinator can stop silently retrying.
   */
  async probe(session: AuthSession): Promise<'ok' | 'auth' | 'network' | 'server'> {
    try {
      await this.requestWithAuth(session, (bearer) =>
        this.http.requestJson<SyncStatusResponse>({
          url: `${session.serverUrl}/sync/status?scope=settings`,
          method: 'GET',
          headers: this.headers(session, bearer),
          timeoutMs: 10_000,
          retries: 0,
        }),
      );
      return 'ok';
    } catch (err) {
      if (err instanceof HttpError) {
        if (err.kind === 'auth') return 'auth';
        if (err.kind === 'network' || err.kind === 'timeout') return 'network';
        return 'server';
      }
      return 'network';
    }
  }
}

/** Builds the normalized payload pushed for the `state` scope. */
export function stateSyncPayload(state: AppState): unknown {
  const full = normalizeState(state);
  // The model catalog is an API cache, not user data — re-fetched on demand.
  // Stripping it removes ~75% of the file size for most real backups.
  return { ...full, aiSettings: { ...full.aiSettings, modelCache: {} } };
}

/** Builds the payload pushed for the `chat` scope. */
export function chatSyncPayload(chat: ChatStoreState): unknown {
  return { version: 1, sessions: normalizeChatSessions({ sessions: chat.sessions }) };
}

/** Normalizes a server chat payload back into a chat store. */
export function chatFromSync(raw: unknown): ChatStoreState {
  const sessions = normalizeChatSessions(raw);
  return { version: 1, sessions };
}

/**
 * Snapshot of Misa's persistent personal state + proactive agent runtime that
 * must survive a device change: relationship memory (commitments, promises,
 * struggle memories, fatigue, boundaries) and the proactive agent prefs +
 * scheduled reminders/calls. Both live in raw localStorage today (not synced);
 * this bundle travels under the `misa` scope so Misa "remembers" on any device.
 */
export interface MisaSyncPayload {
  version: number;
  relationship: RelationshipState;
  proactive: MisaProactiveBlob;
}

/** Builds the `misa` scope payload pushed to the server. */
export function misaSyncPayload(data: MisaSyncPayload): unknown {
  return { ...data };
}

/** Defensively validates a server `misa` payload back into a usable shape. */
export function misaFromSync(raw: unknown): MisaSyncPayload | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Partial<MisaSyncPayload>;
  if (typeof r.relationship !== 'object' || r.relationship === null) return null;
  if (typeof r.proactive !== 'object' || r.proactive === null) return null;
  return {
    version: r.version ?? 1,
    relationship: r.relationship as RelationshipState,
    proactive: r.proactive as MisaSyncPayload['proactive'],
  };
}
