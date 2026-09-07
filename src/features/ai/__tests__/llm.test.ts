import { describe, it, expect } from 'vitest';
import type { AppState } from '../../../core/domain/state';
import { emptyAppState } from '../../../core/domain/state';
import type { LLMProvider, ProviderConfig, ProviderError, ProviderId, LLMResponse, HealthCheckResult, ModelInfo, LLMRequest } from '../../../core/domain/llm';
import type { StateStore } from '../../../core/ports/repositories';
import type { ProviderFactory } from '../../../infra/ai/provider-factory';
import { LLMService } from '../llm.service';
import { ProviderSettingsService } from '../provider-settings.service';

function makeStore(initial: Partial<AppState['aiSettings']>): StateStore {
  let state: AppState = { ...emptyAppState(), aiSettings: { ...emptyAppState().aiSettings, ...initial } };
  return {
    get: () => state,
    save: (s: AppState) => {
      state = s;
    },
  };
}

function providerFor(id: ProviderId, model: string, result: string): LLMProvider {
  const responder = {
    id,
    label: id,
    isConfigured: () => true,
    complete: async (_req: LLMRequest): Promise<LLMResponse> => ({ text: result, model }),
    stream: async (_req: LLMRequest): Promise<LLMResponse> => ({ text: result, model }),
    fetchModels: async (): Promise<ModelInfo[]> => [],
    healthCheck: async (): Promise<HealthCheckResult> => ({ ok: true, provider: id, latencyMs: 1 }),
  };
  return responder;
}

function failingProviderFor(id: ProviderId): LLMProvider {
  const err: ProviderError = Object.assign(new Error(`${id} exploded`), {
    kind: 'server',
    provider: id,
    status: 500,
  }) as ProviderError;
  const responder = {
    id,
    label: id,
    isConfigured: () => true,
    complete: async (): Promise<LLMResponse> => {
      throw err;
    },
    stream: async (): Promise<LLMResponse> => {
      throw err;
    },
    fetchModels: async (): Promise<ModelInfo[]> => [],
    healthCheck: async (): Promise<HealthCheckResult> => ({ ok: false, provider: id, latencyMs: 1 }),
  };
  return responder;
}

function rateLimitedProviderFor(id: ProviderId, message = 'HTTP 429 toomanyrequests'): LLMProvider {
  const err: ProviderError = Object.assign(new Error(message), {
    kind: 'rate-limit',
    provider: id,
    status: 429,
  }) as ProviderError;
  const responder = {
    id,
    label: id,
    isConfigured: () => true,
    complete: async (): Promise<LLMResponse> => {
      throw err;
    },
    stream: async (): Promise<LLMResponse> => {
      throw err;
    },
    fetchModels: async (): Promise<ModelInfo[]> => [],
    healthCheck: async (): Promise<HealthCheckResult> => ({ ok: false, provider: id, latencyMs: 1 }),
  };
  return responder;
}

function buildService(
  providers: Record<string, LLMProvider>,
  aiSettings: Partial<AppState['aiSettings']>,
): LLMService {
  const store = makeStore(aiSettings);
  const factory: ProviderFactory = {
    create: (config: ProviderConfig) => providers[config.id] ?? failingProviderFor(config.id),
  } as unknown as ProviderFactory;
  const settings = new ProviderSettingsService(store, factory);
  return new LLMService(factory, settings);
}

describe('LLMService', () => {
  it('fails fast when AI is disabled', async () => {
    const svc = buildService(
      {
        openrouter: providerFor('openrouter', 'a', 'hi'),
      },
      { providers: { openrouter: { id: 'openrouter', label: 'OpenRouter', model: 'a', enabled: true } }, aiEnabled: false },
    );
    await expect(svc.complete({ messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow(/disabled/);
  });

  it('uses the active provider and returns its text', async () => {
    const svc = buildService(
      {
        gemini: providerFor('gemini', 'g', 'namaste'),
        openrouter: providerFor('openrouter', 'a', 'hi'),
      },
      {
        providers: {
          gemini: { id: 'gemini', label: 'Gemini', model: 'g', enabled: true },
          openrouter: { id: 'openrouter', label: 'OpenRouter', model: 'a', enabled: true },
        },
        activeProviderId: 'gemini',
        aiEnabled: true,
      },
    );
    const res = await svc.complete({ messages: [{ role: 'user', content: 'x' }] });
    expect(res.text).toBe('namaste');
  });


  it('honors an explicit provider override instead of the active provider', async () => {
    const svc = buildService(
      {
        gemini: providerFor('gemini', 'g', 'active text'),
        openrouter: providerFor('openrouter', 'a', 'selected text'),
      },
      {
        providers: {
          gemini: { id: 'gemini', label: 'Gemini', model: 'g', enabled: true },
          openrouter: { id: 'openrouter', label: 'OpenRouter', model: 'a', enabled: true },
        },
        activeProviderId: 'gemini',
        aiEnabled: true,
      },
    );

    const res = await svc.complete({ providerId: 'openrouter', messages: [{ role: 'user', content: 'x' }] });

    expect(res.text).toBe('selected text');
  });

  it('falls back to another usable provider when the active one fails', async () => {
    const svc = buildService(
      {
        gemini: failingProviderFor('gemini'),
        openrouter: providerFor('openrouter', 'a', 'fallback text'),
      },
      {
        providers: {
          gemini: { id: 'gemini', label: 'Gemini', model: 'g', enabled: true },
          openrouter: { id: 'openrouter', label: 'OpenRouter', model: 'a', enabled: true },
        },
        activeProviderId: 'gemini',
        aiEnabled: true,
      },
    );
    const res = await svc.complete({ messages: [{ role: 'user', content: 'x' }] });
    expect(res.text).toBe('fallback text');
  });

  it('surfaces the error only after every usable provider fails', async () => {
    const svc = buildService(
      {
        gemini: failingProviderFor('gemini'),
        openrouter: failingProviderFor('openrouter'),
      },
      {
        providers: {
          gemini: { id: 'gemini', label: 'Gemini', model: 'g', enabled: true },
          openrouter: { id: 'openrouter', label: 'OpenRouter', model: 'a', enabled: true },
        },
        activeProviderId: 'gemini',
        aiEnabled: true,
      },
    );
    await expect(svc.complete({ messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow(/openrouter exploded/);
  });

  it('stream() dispatches to the provider stream method, complete() to complete', async () => {
    let streamCalls = 0;
    let completeCalls = 0;
    const provider: LLMProvider = {
      id: 'openrouter',
      label: 'OpenRouter',
      isConfigured: () => true,
      complete: async (): Promise<LLMResponse> => {
        completeCalls += 1;
        return { text: 'complete', model: 'a' };
      },
      stream: async (): Promise<LLMResponse> => {
        streamCalls += 1;
        return { text: 'streamed', model: 'a' };
      },
      fetchModels: async (): Promise<ModelInfo[]> => [],
      healthCheck: async (): Promise<HealthCheckResult> => ({ ok: true, provider: 'openrouter', latencyMs: 1 }),
    };
    const svc = buildService(
      { openrouter: provider },
      { providers: { openrouter: { id: 'openrouter', label: 'OpenRouter', model: 'a', enabled: true } }, aiEnabled: true },
    );

    const streamRes = await svc.stream({ messages: [{ role: 'user', content: 'x' }] });
    expect(streamRes.text).toBe('streamed');
    expect(streamCalls).toBe(1);
    expect(completeCalls).toBe(0);

    const completeRes = await svc.complete({ messages: [{ role: 'user', content: 'x' }] });
    expect(completeRes.text).toBe('complete');
    expect(completeCalls).toBe(1);
  });

  it('still tries other providers on the same baseUrl after a 429 (no cooldown) and wraps with a friendly message', async () => {
    const GW_BASE = 'https://smartrotator.test/v1';
    let openrouterCalled = false;
    const openrouter = providerFor('openrouter', 'big-pickle', 'should not run');
    openrouter.complete = async (): Promise<LLMResponse> => {
      openrouterCalled = true;
      return { text: 'should not run', model: 'big-pickle' };
    };
    const svc = buildService(
      {
        custom: rateLimitedProviderFor('custom'),
        openrouter,
      },
      {
        providers: {
          custom: { id: 'custom', label: 'Default', model: 'levelup', baseUrl: GW_BASE, enabled: true },
          openrouter: { id: 'openrouter', label: 'OpenRouter', model: 'big-pickle', baseUrl: GW_BASE, enabled: true },
        },
        activeProviderId: 'custom',
        aiEnabled: true,
      },
    );
    const res = await svc.complete({ messages: [{ role: 'user', content: 'x' }] });
    // Even though the first provider rate-limited, the next provider on the
    // SAME baseUrl is still attempted — the LLM facade never blocks a provider
    // because of a previous failure (retry/backoff lives in the HTTP client).
    expect(openrouterCalled).toBe(true);
    expect(res.text).toBe('should not run');
  });

  it('falls through to the next provider after a 429 on the first', async () => {
    const svc = buildService(
      {
        custom: rateLimitedProviderFor('custom'),
        openrouter: providerFor('openrouter', 'a', 'fallback ok'),
      },
      {
        providers: {
          custom: { id: 'custom', label: 'Default', model: 'levelup', baseUrl: 'https://gw-a.test/v1', enabled: true },
          openrouter: { id: 'openrouter', label: 'OpenRouter', model: 'a', baseUrl: 'https://openrouter.ai/api/v1', enabled: true },
        },
        activeProviderId: 'custom',
        aiEnabled: true,
      },
    );
    const res = await svc.complete({ messages: [{ role: 'user', content: 'x' }] });
    expect(res.text).toBe('fallback ok');
  });

  it('aborted errors are not swallowed by the fallback chain', async () => {
    const aborted = Object.assign(new Error('cancelled'), { kind: 'aborted', provider: 'gemini', status: 0 }) as ProviderError;
    const abortedProvider: LLMProvider = {
      id: 'gemini',
      label: 'Gemini',
      isConfigured: () => true,
      complete: async (): Promise<LLMResponse> => {
        throw aborted;
      },
      stream: async (): Promise<LLMResponse> => {
        throw aborted;
      },
      fetchModels: async (): Promise<ModelInfo[]> => [],
      healthCheck: async (): Promise<HealthCheckResult> => ({ ok: false, provider: 'gemini', latencyMs: 1 }),
    };
    const fallback = providerFor('openrouter', 'a', 'should not run');
    let fallbackCalled = false;
    fallback.stream = async (): Promise<LLMResponse> => {
      fallbackCalled = true;
      return { text: 'no', model: 'a' };
    };
    const svc = buildService(
      { gemini: abortedProvider, openrouter: fallback },
      {
        providers: {
          gemini: { id: 'gemini', label: 'Gemini', model: 'g', enabled: true },
          openrouter: { id: 'openrouter', label: 'OpenRouter', model: 'a', enabled: true },
        },
        activeProviderId: 'gemini',
        aiEnabled: true,
      },
    );
    await expect(svc.stream({ messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow(/cancelled/);
    expect(fallbackCalled).toBe(false);
  });
});
