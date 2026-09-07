/** Pure retry policy so reconnect behaviour is testable independently of the SDK. */
export function isPermanentLiveConnectionError(error: unknown): boolean {
  const message = String((error as { message?: string })?.message || error || '').toLowerCase();
  return /model|not found|unsupported|(?:401|403)|api key|authentication|unauthori[sz]ed|permission denied|invalid argument|invalid api/.test(message);
}

/**
 * SAFETY VALVE: 4 attempts with the 20s-capped exponential backoff ≈ 22s of
 * continuous auto-retry (0.75+1.5+3+6 ≈ 11s + jitter, then the user's next
 * message/typing/speech resets the counter for a fresh chance) — enough for a
 * real mid-call mobile blip, then the valve trips to a clear error card.
 *
 * CONTRACT CLARIFICATION: this constant is a TERMINAL SAFETY VALVE only, not
 * the product's call-termination policy. An explicit hangup always cancels the
 * worker immediately (pending backoff timer cleared + epoch bumped), and the
 * USER-ACTIVITY auto-retry path (`retryConnectIfNeeded`) resets the counter —
 * so after the valve trips, the NEXT message/typing/speech still gets a fresh
 * chance. 500 attempts (~3h) was an endless error-spam storm on mobile; the
 * user-action reset makes a small cap safe. Set to 4 per the student's
 * explicit requirement: just enough auto-retries for a blip, and each message
 * after a failure immediately kicks a fresh reconnect.
 */
export const MAX_LIVE_RECONNECT_ATTEMPTS = 4;

export function canRetryLiveConnection(attempt: number): boolean {
  return attempt < MAX_LIVE_RECONNECT_ATTEMPTS;
}