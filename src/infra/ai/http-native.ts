import { CapacitorHttp, type HttpOptions } from '@capacitor/core';
import { delayMs, extractErrorMessage, HttpError, type HttpClient, type HttpRequestInit } from './http';

/**
 * True when running inside the native Capacitor app (Android/iOS), where
 * requests go through the native stack (OkHttp) and are NOT subject to
 * browser CORS. This is what makes browser-blocked providers (OpenCode Zen)
 * work on mobile.
 */
export function isNativePlatform(): boolean {
  const w = globalThis as { Capacitor?: { isNativePlatform?: () => boolean } };
  return typeof w.Capacitor?.isNativePlatform === 'function' && w.Capacitor.isNativePlatform();
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/**
 * HttpClient backed by the Capacitor native HTTP plugin. On web it falls back
 * to the native plugin's own fetch implementation (same CORS rules apply); the
 * DI container only uses this client on real devices.
 */
export class CapacitorHttpClient implements HttpClient {
  async requestJson<T>(init: HttpRequestInit): Promise<T> {
    const retries = init.retries ?? 1;
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        if (init.signal?.aborted) {
          throw new HttpError('Request aborted', 0, 'aborted', null);
        }
        // AUDIT FIX (round 3, MEDIUM): CapacitorHttp can't abort an in-flight
        // request via a signal, so we honor the external abort by:
        //  1. pre-flight check above, and
        //  2. racing the response against the abort event right after it lands,
        //     so a user "stop" during a long request still surfaces as 'aborted'
        //     instead of completing the (now-wasted) call. Same contract as the
        //     web FetchHttpClient, which the rest of the app relies on.
        const aborted = new Promise<never>((_, reject) => {
          if (init.signal) {
            if (init.signal.aborted) reject(new HttpError('Request aborted', 0, 'aborted', null));
            else init.signal.addEventListener('abort', () => reject(new HttpError('Request aborted', 0, 'aborted', null)), { once: true });
          }
        });
        const res = await Promise.race([CapacitorHttp.request(this.toOptions(init)), aborted]);
        const status = res.status ?? 0;
        if (status < 200 || status >= 300) {
          const message = extractErrorMessage(res.data) ?? `HTTP ${status}`;
          throw new HttpError(message, status, statusToKind(status), res.data);
        }
        // The native plugin returns the body as a raw string whenever the
        // response Content-Type isn't detected as JSON — mirror the web client,
        // which always JSON.parses the text, so provider responses parse the
        // same way on every platform.
        if (typeof res.data === 'string') {
          try {
            return JSON.parse(res.data) as T;
          } catch {
            return res.data as T;
          }
        }
        return res.data as T;
      } catch (err) {
        lastError = err;
        if (attempt >= retries) throw lastError;
        const retryable = !(err instanceof HttpError) || RETRYABLE_STATUS.has(err.status);
        if (retryable) await delayMs(backoffMs(attempt));
      }
    }
    throw lastError;
  }

  async requestSse(init: HttpRequestInit, onData: (payload: string) => void): Promise<void> {
    const res = await CapacitorHttp.request({ ...this.toOptions(init), responseType: 'text' });
    const status = res.status ?? 0;
    if (status < 200 || status >= 300) {
      const message = extractErrorMessage(res.data) ?? `SSE HTTP ${status}`;
      throw new HttpError(message, status, statusToKind(status), res.data);
    }
    const body = (typeof res.data === 'string' ? res.data : JSON.stringify(res.data)).replace(/\r\n/g, '\n');
    for (const frame of body.split('\n\n')) {
      const lines = frame.split('\n').filter((l) => l.startsWith('data:'));
      if (lines.length === 0) continue;
      const payload = lines.map((l) => l.slice(5).trim()).join('');
      if (payload && payload !== '[DONE]') onData(payload);
    }
  }

  private toOptions(init: HttpRequestInit): HttpOptions {
    const options: HttpOptions = {
      url: init.url,
      method: init.method ?? 'POST',
      headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    };
    if (init.body !== undefined) options.data = init.body;
    if (init.timeoutMs) {
      options.connectTimeout = init.timeoutMs;
      options.readTimeout = init.timeoutMs;
    }
    return options;
  }
}

function statusToKind(status: number): HttpError['kind'] {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate-limit';
  if (status >= 400 && status < 500) return 'bad-request';
  if (status >= 500) return 'server';
  return 'unknown';
}

function backoffMs(attempt: number): number {
  return Math.min(100 * Math.pow(2, attempt), 2000);
}
