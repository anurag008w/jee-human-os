// Small typed HTTP client with timeout, retry/backoff and SSE streaming.
// Providers inject this; no provider-specific logic lives here.

export interface HttpRequestInit {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  retries?: number;
  /** External abort signal (e.g. chat stop button). */
  signal?: AbortSignal;
}

export interface HttpClient {
  /** JSON request with retry + timeout. */
  requestJson<T>(init: HttpRequestInit): Promise<T>;
  /** Server-Sent-Events request; onDelta receives each data payload string. */
  requestSse(init: HttpRequestInit, onData: (payload: string) => void): Promise<void>;
}

export function delayMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

export class FetchHttpClient implements HttpClient {
  private readonly fetchFn: typeof fetch;
  private readonly defaultTimeoutMs: number;
  private readonly defaultRetries: number;

  constructor(fetchFn: typeof fetch = fetch, defaultTimeoutMs = 120_000, defaultRetries = 1) {
    // Binding keeps `this` = globalThis so the browser's `window.fetch` can be
    // invoked detached; otherwise Chrome throws "Illegal invocation".
    this.fetchFn = fetchFn.bind(globalThis) as typeof fetch;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.defaultRetries = defaultRetries;
  }

  async requestJson<T>(init: HttpRequestInit): Promise<T> {
    const retries = init.retries ?? this.defaultRetries;
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await this.rawFetch(init);
        const text = await res.text();
        let parsed: unknown = null;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch {
          parsed = text;
        }
        if (!res.ok) {
          const message = extractErrorMessage(parsed) ?? `HTTP ${res.status}`;
          const kind = statusToKind(res.status);
          throw new HttpError(message, res.status, kind, parsed);
        }
        return parsed as T;
      } catch (err) {
        lastError = err;
        if (isRetryable(err) && attempt < retries) {
          await delayMs(backoffMs(attempt));
          continue;
        }
        throw lastError;
      }
    }
    throw lastError;
  }

  async requestSse(init: HttpRequestInit, onData: (payload: string) => void): Promise<void> {
    const res = await this.rawFetch(init);
    if (!res.ok) {
      const text = await res.text();
      throw new HttpError(`SSE HTTP ${res.status}: ${text.slice(0, 300)}`, res.status, statusToKind(res.status), text);
    }
    if (!res.body) throw new HttpError('SSE response has no body', 0, 'network', null);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    // AUDIT FIX (round 3, MEDIUM): `timeoutMs` only guarded header arrival.
    // A gateway that stalls mid-stream would otherwise hold this connection open
    // forever. Arm an idle timer during the body-read loop — if NO data arrives
    // within an idle window, abort (surfacing a timeout) and let the caller retry.
    const idleWindowMs = init.timeoutMs ?? this.defaultTimeoutMs;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => reader.cancel().catch(() => {}), idleWindowMs);
    };
    armIdle();
    for (;;) {
      let value: Uint8Array | undefined;
      let done = false;
      try {
        const chunk = await reader.read();
        value = chunk.value;
        done = chunk.done;
      } catch (err) {
        if (idleTimer) clearTimeout(idleTimer);
        if (isAbortError(err)) {
          const byUser = init.signal?.aborted ?? false;
          throw new HttpError(byUser ? 'Request aborted' : 'SSE stream aborted', 0, byUser ? 'aborted' : 'timeout', null);
        }
        throw err;
      }
      if (done) break;
      // Received data → reset the idle timeout.
      armIdle();
      // CRLF-safe: normalize \r\n to \n (some servers/gateways stream with CRLF).
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      if (buffer.endsWith('\r')) buffer = buffer.slice(0, -1) + '\n';
      let sep;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        emitDataLines(frame, onData);
      }
    }
    if (idleTimer) clearTimeout(idleTimer);
  }

  private async rawFetch(init: HttpRequestInit): Promise<Response> {
    const timeoutMs = init.timeoutMs ?? this.defaultTimeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let signal: AbortSignal = controller.signal;
    
    if (init.signal) {
      if (init.signal.aborted) {
        clearTimeout(timer);
        throw new HttpError('Request aborted', 0, 'aborted', null);
      }
      // AbortSignal.any() is not supported in all browsers, use fallback
      if (typeof AbortSignal.any === 'function') {
        signal = AbortSignal.any([controller.signal, init.signal]);
      } else {
        // Fallback for older browsers: manually abort when either signals
        init.signal.addEventListener('abort', () => controller.abort(), { once: true });
      }
    }
    
    try {
      return await this.fetchFn(init.url, {
        method: init.method ?? 'POST',
        headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal,
      });
    } catch (err) {
      if (isAbortError(err)) {
        const byUser = init.signal?.aborted ?? false;
        throw new HttpError(byUser ? 'Request aborted' : `Request timed out after ${timeoutMs}ms`, 0, byUser ? 'aborted' : 'timeout', null);
      }
      const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      throw new HttpError(`Network request failed (${detail})`, 0, 'network', err);
    } finally {
      clearTimeout(timer);
    }
  }
}

function isAbortError(err: unknown): boolean {
  return (err instanceof DOMException && err.name === 'AbortError') || (err instanceof Error && err.name === 'AbortError');
}

/**
 * Emits every `data:` line of an SSE frame. Multi-line frames (a JSON payload
 * wrapped across several data: lines) are joined so nothing is silently lost.
 */
function emitDataLines(frame: string, onData: (payload: string) => void): void {
  const lines = frame.split('\n').filter((l) => l.startsWith('data:'));
  if (lines.length === 0) return;
  const payload = lines.map((l) => l.slice(5).trim()).join('');
  if (payload && payload !== '[DONE]') onData(payload);
}

export class HttpError extends Error {
  readonly status: number;
  readonly kind: 'auth' | 'rate-limit' | 'timeout' | 'network' | 'bad-request' | 'server' | 'unknown' | 'aborted';
  readonly payload: unknown;

  constructor(
    message: string,
    status: number,
    kind: HttpError['kind'],
    payload: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.kind = kind;
    this.payload = payload;
  }
}

function statusToKind(status: number): HttpError['kind'] {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate-limit';
  if (status >= 400 && status < 500) return 'bad-request';
  if (status >= 500) return 'server';
  return 'unknown';
}

function isRetryable(err: unknown): boolean {
  if (err instanceof HttpError) {
    if (err.kind === 'aborted') return false;
    return RETRYABLE_STATUS.has(err.status);
  }
  return true; // network / timeout
}

function backoffMs(attempt: number): number {
  return Math.min(100 * Math.pow(2, attempt), 2000);
}

export function extractErrorMessage(parsed: unknown): string | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const p = parsed as Record<string, unknown>;
  if (typeof p.error === 'object' && p.error !== null) {
    const e = p.error as Record<string, unknown>;
    if (typeof e.message === 'string') return e.message;
    const nested = e.error as Record<string, unknown> | undefined;
    if (nested && typeof nested.message === 'string') return nested.message;
  }
  if (typeof p.message === 'string') return p.message;
  return null;
}
