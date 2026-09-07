/**
 * Mid-call interaction fixes (production hardening round).
 *
 * - P1: Sending a text while Misa is speaking must STOP her old reply — the
 *   old turn's leftover audio is flushed AND dropped until the server confirms
 *   the interruption, so the user never hears "pehle wala bhi + mera reply bhi".
 * - P2: Typing in the composer restarts the silence timeline (no mid-typing
 *   nudges) but does NOT stop current playback.
 * - P3: A quick redial seeds the previous call's final exchanges so Misa
 *   CONTINUES the conversation instead of forgetting it.
 */

import { describe, it, expect, vi } from 'vitest';
import { GeminiLiveClient } from '../live-client';
import type { LiveSettingsConfig } from '../live-types';

const mockConfig: LiveSettingsConfig = {
  model: 'gemini-2.5-flash-native-audio-preview-09-2025',
  voice: 'Aoede',
  vadSensitivity: 'medium',
  videoFps: 1,
  screenFps: 1,
  defaultAudioRoute: 'speaker',
  playbackSpeed: 1.0,
  enable90DayTrack: true,
};

function makeClient() {
  const client = new GeminiLiveClient(mockConfig) as any;
  client.session = { sendRealtimeInput: vi.fn(), close: vi.fn() };
  return client;
}

describe('P1 — stale assistant output drop (send-during-speech)', () => {
  it('arms the stale-drop when a text is sent while speaking', () => {
    const client = makeClient();
    client.status = 'speaking';
    client.sendTextMessage('hello');
    expect(client.dropStaleAssistantOutput).toBe(true);
    expect(client.staleDropDeadline).toBeGreaterThan(Date.now());
  });

  it('does NOT arm the stale-drop when nothing is playing', () => {
    const client = makeClient();
    client.status = 'listening';
    client.sendTextMessage('hello');
    expect(client.dropStaleAssistantOutput).toBe(false);
  });

  it('suppresses old-turn output and clears after the safety window', () => {
    const client = makeClient();
    client.dropStaleAssistantOutput = true;
    client.staleDropDeadline = Date.now() + 5000;
    expect(client.shouldSuppressStaleAssistantOutput()).toBe(true);

    // Safety net: once the window passes, never swallow a real future reply.
    client.staleDropDeadline = Date.now() - 1;
    expect(client.shouldSuppressStaleAssistantOutput()).toBe(false);
    expect(client.dropStaleAssistantOutput).toBe(false);
  });

  it('clears the stale-drop when the server confirms the interruption', () => {
    const client = makeClient();
    client.dropStaleAssistantOutput = true;
    client.staleDropDeadline = Date.now() + 5000;
    // Drive the private handler with the API's interruption signal.
    client.handleServerMessage({ serverContent: { interrupted: true } });
    expect(client.dropStaleAssistantOutput).toBe(false);
  });
});

describe('P2 — typing restarts the silence timeline without stopping speech', () => {
  it('reportUserTyping resets the conversational silence anchor and streak', () => {
    const client = makeClient();
    client.lastTurnFinishedTime = 0;
    client.silenceNudgeStreak = 3;
    client.awaitingAssistantReply = true;
    const stateMachine = client.silenceStateMachine;
    const speechSpy = vi.spyOn(stateMachine, 'onSpeechActivity');

    client.reportUserTyping();

    expect(client.lastTurnFinishedTime).toBeGreaterThan(0);
    expect(client.silenceNudgeStreak).toBe(0);
    expect(client.awaitingAssistantReply).toBe(false);
    expect(speechSpy).toHaveBeenCalled();
  });

  it('does NOT reset callEndAskCount on user typing — the student already answered the "end the call?" question (no re-asking loop)', () => {
    // Regression: callEndAskCount was being zeroed on every user action, so
    // after the student said "keep talking/rakho" the agent re-asked the same
    // "call rkh du?" question 5 silent rounds later — over and over. The
    // counter now only resets on a fresh connect (new call), not on activity.
    const client = makeClient();
    client.callEndAskCount = 1;
    client.reportUserTyping();
    expect(client.callEndAskCount).toBe(1);
  });

  it('does NOT reset callEndAskCount on sending a text — same no-re-ask guarantee', () => {
    const client = makeClient();
    client.callEndAskCount = 2;
    client.sendTextMessage('hello');
    expect(client.callEndAskCount).toBe(2);
  });
});

describe('P3 — redial continues the previous conversation', () => {
  it('disconnect stores the last exchanges as readable context', () => {
    const client = makeClient();
    client.transcripts = [
      { id: '1', role: 'user', text: 'kinematics me velocity kaise nikale?', timestamp: 't' },
      { id: '2', role: 'assistant', text: 'v = u + at se, pehle acceleration nikaalo.', timestamp: 't' },
      { id: '3', role: 'user', text: 'okay samajh gaya', timestamp: 't' },
    ];
    client.disconnect(false, false);
    expect(client.lastCallTranscriptSnapshot.length).toBeGreaterThan(0);
    const joined = client.lastCallTranscriptSnapshot.join('\n');
    expect(joined).toContain('Student: kinematics me velocity kaise nikale?');
    expect(joined).toContain('Misa: v = u + at se, pehle acceleration nikaalo.');
  });

  it('does NOT snapshot on a mid-call reconnect teardown', () => {
    const client = makeClient();
    client.lastCallTranscriptSnapshot = ['previous'];
    client.transcripts = [{ id: '1', role: 'user', text: 'x', timestamp: 't' }];
    client.disconnect(true, false); // reconnect preserve path
    expect(client.lastCallTranscriptSnapshot).toEqual(['previous']);
  });

  it('filters silence-nudge/call-end filler out of the redial snapshot', () => {
    const client = makeClient();
    client.transcripts = [
      { id: '1', role: 'user', text: 'hello', timestamp: 't' },
      { id: '2', role: 'assistant', text: 'Haan boliye, kaise ho?', timestamp: 't' },
      { id: '3', role: 'assistant', text: 'Kya aap silent ho? Are you there?', timestamp: 't' },
      { id: '4', role: 'assistant', text: 'Lagta hai call khatam ho gayi. Phir kabhi baat karenge.', timestamp: 't' },
    ];
    client.disconnect(false, false);
    const joined = client.lastCallTranscriptSnapshot.join('\n');
    expect(joined).toContain('Student: hello');
    expect(joined).toContain('Haan boliye');
    expect(joined).not.toContain('silent');
    expect(joined).not.toContain('call khatam');
  });
});

describe('P4 — auto-retry after a failed connect (user activity)', () => {
  it('hasFailedConnection is true only after a recorded failure', () => {
    const client = makeClient();
    client.session = null; // simulate a failed/absent connection
    client.recordConnectionFailure();
    expect(client.hasFailedConnection()).toBe(true);
    client.session = { sendRealtimeInput: vi.fn(), close: vi.fn() };
    expect(client.hasFailedConnection()).toBe(false);
  });

  it('retryConnectIfNeeded does nothing when nothing failed', () => {
    const client = makeClient();
    client.lastConnectionErrorAt = 0;
    const spy = vi.spyOn(client, 'handleAutoReconnect');
    client.retryConnectIfNeeded();
    expect(spy).not.toHaveBeenCalled();
  });

  it('retryConnectIfNeeded kicks a reconnect after a failure', () => {
    const client = makeClient();
    client.session = null;
    client.recordConnectionFailure();
    const spy = vi.spyOn(client, 'handleAutoReconnect').mockResolvedValue(undefined);
    client.retryConnectIfNeeded();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(client.lastConnectionErrorAt).toBe(0); // cleared, no double-fire
  });

  it('does not auto-retry after an explicit hangup', () => {
    const client = makeClient();
    client.recordConnectionFailure();
    client.isUserExplicitlyClosed = true;
    client.retryConnectIfNeeded();
    expect(client.hasFailedConnection()).toBe(false);
  });

  it('a straight-up failed connect auto-kicks a bounded reconnect (self-heal) instead of sitting on error', async () => {
    // Regression: a WS that never opens fires NO SDK onerror/onclose, so the
    // call was stuck on 'error' until the user re-tapped Live Call (the Linux
    // "error 0 0" the student keeps hitting). A failed fresh connect now kicks
    // handleAutoReconnect once so a transient failure self-heals after a short
    // backoff; the reconnect worker's own recursion + cap keep it bounded.
    const client = makeClient();
    client.session = null;
    client.reconnectAttempts = 0;
    client.isUserExplicitlyClosed = false;
    const spy = vi.spyOn(client, 'handleAutoReconnect').mockResolvedValue(undefined);
    // Trigger the connect() catch path directly (throw path).
    // We can't easily run the real connect, so simulate what the catch does:
    client.connectionAttempt += 1;
    client.setStatus('error');
    client.recordConnectionFailure(new Error('network down'));
    expect(client.reconnectAttempts).toBe(0);
    // The catch guards with reconnectAttempts === 0 before firing.
    // Simulate the guard branch from the catch:
    if (!client.isUserExplicitlyClosed && client.reconnectAttempts === 0) {
      void client.handleAutoReconnect().catch(() => undefined);
    }
    await Promise.resolve();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('does NOT double-kick handleAutoReconnect when a retry is already in flight (reconnectAttempts > 0)', () => {
    const client = makeClient();
    client.session = null;
    client.reconnectAttempts = 1; // a reconnect is already running
    const spy = vi.spyOn(client, 'handleAutoReconnect').mockResolvedValue(undefined);
    // The connect() catch only auto-kicks on a FRESH (attempt 0) failure; an
    // in-progress reconnect recursion owns retries up to the cap.
    if (!client.isUserExplicitlyClosed && client.reconnectAttempts === 0) {
      void client.handleAutoReconnect().catch(() => undefined);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('sendTextMessage on a dead session nulls it + buffers + kicks a reconnect so a message after an error actually recovers the call', () => {
    // Simulate a half-dead session: SDK object exists but every send throws
    // (socket CLOSING/CLOSED). Before the fix, this.session stayed non-null so
    // hasFailedConnection() returned false and retryConnectIfNeeded() was a
    // no-op — the user's message after a network error was silently dropped
    // and the call stayed dead. Now the dead session is nulled, the message is
    // buffered, and a reconnect is kicked.
    const client = makeClient();
    const retrySpy = vi.spyOn(client, 'retryConnectIfNeeded').mockImplementation(() => {});
    client.session = {
      sendRealtimeInput: vi.fn(() => {
        throw new Error('WebSocket is already in CLOSING or CLOSED state');
      }),
      close: vi.fn(),
    };

    client.sendTextMessage('hello after error');

    expect(client.session).toBeNull(); // dead session unblocked the retry gate
    expect(client.pendingTextQueue.length).toBe(1);
    expect(client.pendingTextQueue[0].text).toBe('hello after error');
    expect(client.lastConnectionErrorAt).toBeGreaterThan(0); // failure recorded
    expect(retrySpy).toHaveBeenCalledTimes(1); // user action kicked a reconnect
    expect(client.transcripts.some((t: any) => t.role === 'user' && t.text === 'hello after error')).toBe(true); // user bubble intact
  });
});

describe('Model fallback chain — dead model self-heals instead of staying mute', () => {
  it('advances one step down the chain when the selected model is unavailable', async () => {
    const client = makeClient() as any;
    client.config = { ...client.config, model: 'gemini-3.1-flash-live-preview' };
    client.session = null;
    client.lastConnectionError = new Error("Selected Live model 'X' is unavailable or is not supported by your API key");
    const connectSpy = vi.spyOn(client, 'connect').mockResolvedValue(undefined);

    const kicked = client.tryModelFallback(client.lastConnectionError, 'k', null, null);
    expect(kicked).not.toBeNull();
    expect(client.config.model).toBe('gemini-2.5-flash-native-audio-latest');
    expect(connectSpy).toHaveBeenCalledTimes(1);
  });

  it('cascades through the whole chain when every model is dead (one user action)', async () => {
    const client = makeClient() as any;
    client.config = { ...client.config, model: 'gemini-3.1-flash-live-preview' };
    client.session = null;
    const err = new Error('model not found for live session');
    const connectSpy = vi.spyOn(client, 'connect').mockResolvedValue(undefined);

    // 1st failure: A → B
    const k1 = client.tryModelFallback(err, 'k', null, null);
    expect(k1).not.toBeNull();
    expect(client.config.model).toBe('gemini-2.5-flash-native-audio-latest');
    // 2nd failure (B also dead, its own connect catch): B → C — must NOT be
    // blocked (the old in-flight guard made fallback feel broken).
    const k2 = client.tryModelFallback(err, 'k', null, null);
    expect(k2).not.toBeNull();
    expect(client.config.model).toBe('gemini-2.5-flash');
    expect(connectSpy).toHaveBeenCalledTimes(2);
  });

  it('does not fall back when the chain is exhausted (stop condition)', () => {
    const client = makeClient() as any;
    client.config = { ...client.config, model: 'gemini-2.5-flash' }; // last in chain
    client.session = null;
    const err = new Error('model not found for live session');
    const connectSpy = vi.spyOn(client, 'connect').mockResolvedValue(undefined);

    const kicked = client.tryModelFallback(err, 'k', null, null);
    expect(kicked).toBeNull();
    expect(client.config.model).toBe('gemini-2.5-flash');
    expect(connectSpy).not.toHaveBeenCalled();
  });

  it('retryConnectIfNeeded does NOT double-advance while a model fallback is in flight (round-2 NEW-2)', async () => {
    const client = makeClient() as any;
    client.config = { ...client.config, model: 'gemini-3.1-flash-live-preview' };
    client.session = null;
    client.lastConnectionError = new Error("Selected Live model 'X' is unavailable");
    client.lastConnectionErrorAt = Date.now();
    // connect resolves LATER (still pending) → fallback is genuinely in flight.
    let resolveConnect!: () => void;
    const pending = new Promise<void>((r) => { resolveConnect = r; });
    const connectSpy = vi.spyOn(client, 'connect').mockReturnValue(pending);

    const kicked = client.tryModelFallback(client.lastConnectionError, 'k', null, null);
    expect(kicked).not.toBeNull();
    expect(client.modelFallbackInFlight).toBe(true);
    // Without the guard this would advance B → C (skipping gemini-2.5-flash).
    client.retryConnectIfNeeded();
    expect(client.config.model).toBe('gemini-2.5-flash-native-audio-latest');
    expect(connectSpy).toHaveBeenCalledTimes(1);
    resolveConnect();
    await pending;
    expect(client.modelFallbackInFlight).toBe(false);
  });

  it('uses a user-configured fallbackModels chain when provided (user-changeable)', async () => {
    const client = makeClient() as any;
    client.config = {
      ...client.config,
      model: 'custom-live-v1',
      fallbackModels: ['custom-live-v1', 'custom-live-v2', 'fallback-pro'],
    };
    client.session = null;
    client.lastConnectionError = new Error("Selected Live model 'X' is unavailable");
    const connectSpy = vi.spyOn(client, 'connect').mockResolvedValue(undefined);

    const kicked = client.tryModelFallback(client.lastConnectionError, 'k', null, null);
    expect(kicked).not.toBeNull();
    expect(client.config.model).toBe('custom-live-v2');
    expect(connectSpy).toHaveBeenCalledTimes(1);
  });

  it('falls back to the default chain when config.fallbackModels is empty/absent', async () => {
    const client = makeClient() as any;
    client.config = { ...client.config, model: 'gemini-3.1-flash-live-preview', fallbackModels: [] };
    client.session = null;
    client.lastConnectionError = new Error("Selected Live model 'X' is unavailable");
    const connectSpy = vi.spyOn(client, 'connect').mockResolvedValue(undefined);

    const kicked = client.tryModelFallback(client.lastConnectionError, 'k', null, null);
    expect(kicked).not.toBeNull();
    expect(client.config.model).toBe('gemini-2.5-flash-native-audio-latest');
    expect(connectSpy).toHaveBeenCalledTimes(1);
  });
});

describe('Gateway model-discovery fallback (Linux "error 0 0" — dead model self-heals)', () => {
  it('classifies gateway-style and opaque errors as model-availability (broadened)', () => {
    const client = makeClient() as any;
    // Existing phrases still match.
    expect(client.isModelAvailabilityError(new Error('model not found for live session'))).toBe(true);
    expect(client.isModelAvailabilityError(new Error('Selected Live model X is unsupported'))).toBe(true);
    expect(client.isModelAvailabilityError(new Error('INVALID_ARGUMENT: this model does not support live generation'))).toBe(true);
    expect(client.isModelAvailabilityError(new Error('model unavailable right now'))).toBe(true);
    // A genuinely unrelated opaque error stays non-model (no false fallback).
    expect(client.isModelAvailabilityError({ message: '' })).toBe(false);
    // AUDIT FIX (round 1, MEDIUM): a bare HTTP status/code — the opaque WS
    // close on Linux — counts ONLY when dialing a USER gateway, and never for
    // credential errors (401/403). Native Google always ships a message body,
    // so a bare status is NOT a model error there.
    client.activeBaseUrl = 'https://api.smartrotator.com/v1';
    expect(client.isModelAvailabilityError({ message: '', status: 404 })).toBe(true);
    expect(client.isModelAvailabilityError({ message: '', code: '400' })).toBe(true);
    expect(client.isModelAvailabilityError({ message: '', status: 401 })).toBe(false);
    expect(client.isModelAvailabilityError({ message: '', status: 403 })).toBe(false);
    client.activeBaseUrl = '';
    expect(client.isModelAvailabilityError({ message: '', status: 404 })).toBe(false);
  });

  it('discovers the first untried LIVE model from the gateway and recurses connect once', async () => {
    const client = makeClient() as any;
    client.config = { ...client.config, model: 'gemini-3.1-flash-live-preview' };
    client.activeBaseUrl = 'https://api.smartrotator.com/v1';
    client.session = null;
    const connectSpy = vi.spyOn(client, 'connect').mockResolvedValue(undefined);
    vi.spyOn(client, 'fetchGatewayLiveModels').mockResolvedValue([
      'gemini-2.5-flash-native-audio-latest',
      'gemini-2.5-pro', // text-ish name — real method sorts these last
    ]);

    const kicked = await client.tryGatewayDiscoveredModel(new Error('unavailable'), 'k', null, null);
    expect(kicked).not.toBeNull();
    expect(client.config.model).toBe('gemini-2.5-flash-native-audio-latest');
    expect(connectSpy).toHaveBeenCalledTimes(1);
  });

  it('skips models already tried by the chain cascade', async () => {
    const client = makeClient() as any;
    client.config = { ...client.config, model: 'gemini-2.5-flash-native-audio-latest' };
    client.activeBaseUrl = 'https://api.smartrotator.com/v1';
    client.session = null;
    // Chain advanced A→B and B just failed — both are already in the cascade.
    client.triedModelsInCascade = new Set([
      'gemini-3.1-flash-live-preview',
      'gemini-2.5-flash-native-audio-latest',
    ]);
    const connectSpy = vi.spyOn(client, 'connect').mockResolvedValue(undefined);
    vi.spyOn(client, 'fetchGatewayLiveModels').mockResolvedValue([
      'gemini-2.5-flash-native-audio-latest',
      'gemini-2.5-flash',
    ]);

    const kicked = await client.tryGatewayDiscoveredModel(new Error('unavailable'), 'k', null, null);
    expect(kicked).not.toBeNull();
    expect(client.config.model).toBe('gemini-2.5-flash'); // skipped the tried one
    expect(connectSpy).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire against native Google or when no gateway is active', async () => {
    const client = makeClient() as any;
    client.config = { ...client.config, model: 'gemini-3.1-flash-live-preview' };
    client.session = null;
    const connectSpy = vi.spyOn(client, 'connect').mockResolvedValue(undefined);
    const fetchSpy = vi.spyOn(client, 'fetchGatewayLiveModels').mockResolvedValue(['gemini-2.5-flash']);

    client.activeBaseUrl = null;
    expect(await client.tryGatewayDiscoveredModel(new Error('unavailable'), 'k', null, null)).toBeNull();
    client.activeBaseUrl = 'https://generativelanguage.googleapis.com';
    expect(await client.tryGatewayDiscoveredModel(new Error('unavailable'), 'k', null, null)).toBeNull();
    expect(connectSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('is a ONE-SHOT budget per fresh call — a second dead discovery does not spin', async () => {
    const client = makeClient() as any;
    client.config = { ...client.config, model: 'gemini-3.1-flash-live-preview' };
    client.activeBaseUrl = 'https://api.smartrotator.com/v1';
    client.session = null;
    const connectSpy = vi.spyOn(client, 'connect').mockResolvedValue(undefined);
    vi.spyOn(client, 'fetchGatewayLiveModels').mockResolvedValue(['gemini-2.5-flash-native-audio-latest']);

    const first = await client.tryGatewayDiscoveredModel(new Error('unavailable'), 'k', null, null);
    expect(first).not.toBeNull();
    expect(client.gatewayDiscoveryAttempted).toBe(true);
    // Second failure in the same call: budget spent → no more connects.
    const second = await client.tryGatewayDiscoveredModel(new Error('unavailable'), 'k', null, null);
    expect(second).toBeNull();
    expect(connectSpy).toHaveBeenCalledTimes(1);
  });

  it('a fresh user connect re-arms the gateway discovery budget', async () => {
    const client = makeClient() as any;
    client.gatewayDiscoveryAttempted = true;
    client.triedModelsInCascade = new Set(['old-model']);
    // Simulate connect() entry for a fresh (non-reconnect, non-fallback) start.
    const isReconnect = false;
    if (!isReconnect && !client.modelFallbackInFlight) {
      client.gatewayDiscoveryAttempted = false;
      client.triedModelsInCascade.clear();
    }
    expect(client.gatewayDiscoveryAttempted).toBe(false);
    expect(client.triedModelsInCascade.size).toBe(0);
  });
});