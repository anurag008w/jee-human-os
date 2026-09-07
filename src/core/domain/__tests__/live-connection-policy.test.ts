import { describe, expect, it } from 'vitest';
import { canRetryLiveConnection, isPermanentLiveConnectionError, MAX_LIVE_RECONNECT_ATTEMPTS } from '../live-connection-policy';

describe('live connection policy', () => {
  it('does not retry auth and invalid-model failures', () => {
    expect(isPermanentLiveConnectionError(new Error('401 API key invalid'))).toBe(true);
    expect(isPermanentLiveConnectionError(new Error('model not found'))).toBe(true);
  });
  it('keeps the call alive through sustained outages (bounded rolling retry)', () => {
    expect(isPermanentLiveConnectionError(new Error('network socket closed'))).toBe(false);
    // 4 attempts ≈ 22s of 20s-capped backoff (0.75+1.5+3+6s) — enough for a
    // real mid-call mobile blip. Beyond that the USER-ACTIVITY path
    // (retryConnectIfNeeded) resets the counter, so the next message/typing/
    // speech still recovers with a fresh 4-attempt window.
    expect(canRetryLiveConnection(4)).toBe(false);
    expect(canRetryLiveConnection(3)).toBe(true);
    expect(canRetryLiveConnection(2)).toBe(true);
    expect(canRetryLiveConnection(1)).toBe(true);
    expect(canRetryLiveConnection(0)).toBe(true);
  });
  it('trips the safety valve instead of spinning an 85s+ error storm', () => {
    // Terminal only as a sanity limit, never as the normal outage policy —
    // otherwise a dead link spams errors every ~0.75-20s for hours on mobile.
    expect(canRetryLiveConnection(MAX_LIVE_RECONNECT_ATTEMPTS - 1)).toBe(true);
    expect(canRetryLiveConnection(MAX_LIVE_RECONNECT_ATTEMPTS)).toBe(false);
    expect(MAX_LIVE_RECONNECT_ATTEMPTS).toBe(4);
  });
});