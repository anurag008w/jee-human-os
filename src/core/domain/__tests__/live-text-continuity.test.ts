// Regression: "call me chat ka content nahi aa raha" — a NEW live call must be
// seeded from the CURRENT chat session's messages, never from a previous call's
// stale context.
//
// Covered contract (enforced at ChatScreen.handleStartLiveCall +
// LiveCompanionOverlay.disposeActiveLiveCall):
//   - A user-intent call always starts with a FRESH client whose recent-chat
//     summary comes from the session the user is in right now.
//   - Re-seeding an existing client REPLACES the old summary (stale text chat
//     context cannot leak into the next system prompt).
import { describe, it, expect } from 'vitest';
import type { AppState } from '../../../core/domain/state';
import { emptyAppState } from '../../../core/domain/state';
import type { ChatRepository, StateStore } from '../../../core/ports/repositories';
import type { ChatStoreState } from '../../../core/domain/chat';
import type { ContentPart, LLMProvider, LLMResponse, HealthCheckResult, ModelInfo, LLMRequest, ProviderId } from '../../../core/domain/llm';
import type { ProviderFactory } from '../../../infra/ai/provider-factory';
import { LLMService } from '../../../features/ai/llm.service';
import { ProviderSettingsService } from '../../../features/ai/provider-settings.service';
import { ChatService } from '../../../features/chat/chat.service';
import { GeminiLiveClient } from '../live-client';
import type { LiveSettingsConfig } from '../live-types';
import { recordLiveCall, setLastTranscriptSnapshot, setLiveCallHistoryStorage } from '../live-call-history';

class MemoryChatRepository implements ChatRepository {
  private state: ChatStoreState = { version: 1, sessions: [] };
  load(): ChatStoreState {
    return this.state;
  }
  save(state: ChatStoreState): void {
    this.state = state;
  }
}

class FakeClock {
  private t = new Date('2026-09-08T10:00:00Z');
  now(): Date {
    return new Date(this.t);
  }
}

function makeStore(initial: Partial<AppState['aiSettings']>): StateStore {
  let state: AppState = { ...emptyAppState(), aiSettings: { ...emptyAppState().aiSettings, ...initial } };
  return {
    get: () => state,
    save: (s: AppState) => {
      state = s;
    },
  };
}

function makeStreamingProvider(id: ProviderId, replies: string[]): LLMProvider {
  return {
    id,
    label: id,
    isConfigured: () => true,
    complete: async (): Promise<LLMResponse> => ({ text: '', model: id }),
    stream: async (req: LLMRequest): Promise<LLMResponse> => {
      const text = replies[0] ?? '';
      if (req.onDelta) for (const ch of text) req.onDelta(ch);
      return { text, model: id };
    },
    fetchModels: async (): Promise<ModelInfo[]> => [],
    healthCheck: async (): Promise<HealthCheckResult> => ({ ok: true, provider: id, latencyMs: 1 }),
  };
}

function buildChatService() {
  const repo = new MemoryChatRepository();
  const store = makeStore({
    providers: { openrouter: { id: 'openrouter', label: 'OpenRouter', model: 'a', enabled: true } },
    aiEnabled: true,
  });
  const provider = makeStreamingProvider('openrouter', ['hi there']);
  const factory: ProviderFactory = { create: () => provider } as unknown as ProviderFactory;
  const settings = new ProviderSettingsService(store, factory);
  const llm = new LLMService(factory, settings);
  const chat = new ChatService(repo, llm, settings, () => 'ctx', new FakeClock());
  return { chat };
}

const liveCfg: LiveSettingsConfig = {
  model: 'gemini-2.5-flash-native-audio-preview-09-2025',
  voice: 'Aoede',
  vadSensitivity: 'medium',
  videoFps: 1,
  screenFps: 1,
  defaultAudioRoute: 'speaker',
  playbackSpeed: 1.0,
  enable90DayTrack: true,
};

describe('live text continuity (chat → call context)', () => {
  it('a FRESH call after hangup is seeded from the CURRENT chat — old call context never leaks in', () => {
    const { chat } = buildChatService();

    // OLD chat A — the call was in here, then hung up.
    const sessionA = chat.createSession();
    sessionA.messages.push({ id: 'a1', role: 'user', content: 'integration samjha do', createdAt: '2026-09-08T10:00:00.000Z' });

    // Call #1 transcript lands back in session A (ChatScreen handleLiveOverlayClose).
    chat.appendMessages(sessionA.id, [
      { id: 'liveA', role: 'assistant', content: 'integration me u aur v...', createdAt: '2026-09-08T10:05:10.000Z' },
    ]);
    chat.flush();

    // Hang up (handleEndCall / disposeActiveLiveCall → disconnect(false)).
    const clientA = new GeminiLiveClient(liveCfg);
    clientA.setRecentChatHistory(sessionA.messages.slice(-25), 25);
    clientA.disconnect(false);

    // User creates NEW chat B and has MANY conversations in it before calling.
    const sessionB = chat.createSession();
    sessionB.messages.push(
      { id: 'b1', role: 'user', content: 'kal mock test hai kya?', createdAt: '2026-09-08T11:00:00.000Z' },
      { id: 'b2', role: 'assistant', content: 'Haan, kal mock test hai, preboard paper ke pattern jaisa.', createdAt: '2026-09-08T11:00:30.000Z' },
      { id: 'b3', role: 'user', content: 'physics formula sheet bana dena', createdAt: '2026-09-08T11:05:00.000Z' },
    );

    // New call starts → FRESH client (disposeActiveLiveCall nulled clientA),
    // seeded with the session the user is IN right now = session B.
    const call2 = new GeminiLiveClient(liveCfg);
    call2.setRecentChatHistory(sessionB.messages.slice(-25), 25);
    const summary2 = (call2 as any).recentChatSummary as string;

    // The new chat's texts ARE the call context.
    expect(summary2).toContain('kal mock test hai kya?');
    expect(summary2).toContain('physics formula sheet bana dena');
    // The old call's topic is NOT part of the new call.
    expect(summary2).not.toContain('integration');
  });

  it('re-seeding an existing client REPLACES the stale summary (no old-chat leak on reattach)', () => {
    const client = new GeminiLiveClient(liveCfg);

    // Call #1 seeded old session context.
    client.setRecentChatHistory(
      [{ id: 'x', role: 'user', content: 'integration samjha do', createdAt: '' } as any],
      25,
    );
    expect((client as any).recentChatSummary as string).toContain('integration');

    // The chat the user is NOW in has moved on — overlay re-seeds on every mount.
    client.setRecentChatHistory(
      [{ id: 'y', role: 'user', content: 'kal mock test hai kya?', createdAt: '' } as any],
      25,
    );
    const summary = (client as any).recentChatSummary as string;
    expect(summary).toContain('kal mock test hai kya?');
    expect(summary).not.toContain('integration');
  });

  it('explicit hangup (disconnect(false)) kills reconnect — a disposed stale client can never resurrect into a new call', () => {
    const client = new GeminiLiveClient(liveCfg);
    client.disconnect(false);
    expect((client as any).isUserExplicitlyClosed).toBe(true);
    expect((client as any).reconnectAttempts).toBeGreaterThan(900); // no auto-retry budget
  });

  it('TEXT CHAT knows the live-call history — Misa can answer "kitni baar call kiya"', async () => {
    // Injected storage so this test is headless + isolated.
    const map = new Map<string, string>();
    const stub = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => { void map.set(k, v); },
      removeItem: (k: string) => { void map.delete(k); },
    };
    setLiveCallHistoryStorage(stub);
    try {
      // Simulate the app's persisted call history (recorded on every hangup).
      setLastTranscriptSnapshot(['Student: integration samjha do', 'Misa: u aur v sath khelte hai']);
      recordLiveCall(Date.now() - 5 * 60_000, 182);
      recordLiveCall(Date.now() - 2 * 86_400_000, 300);

      let captured: LLMRequest | null = null;
      const repo = new MemoryChatRepository();
      const store = makeStore({
        providers: { openrouter: { id: 'openrouter', label: 'OpenRouter', model: 'a', enabled: true } },
        aiEnabled: true,
      });
      const provider: LLMProvider = {
        id: 'openrouter',
        label: 'OpenRouter',
        isConfigured: () => true,
        complete: async (): Promise<LLMResponse> => ({ text: '', model: 'a' }),
        stream: async (req: LLMRequest): Promise<LLMResponse> => {
          captured = req;
          return { text: 'done', model: 'a' };
        },
        fetchModels: async (): Promise<ModelInfo[]> => [],
        healthCheck: async (): Promise<HealthCheckResult> => ({ ok: true, provider: 'openrouter', latencyMs: 1 }),
      };
      const factory: ProviderFactory = { create: () => provider } as unknown as ProviderFactory;
      const settings = new ProviderSettingsService(store, factory);
      const llm = new LLMService(factory, settings);
      const chat = new ChatService(repo, llm, settings, () => 'ctx', new FakeClock());
      const session = chat.createSession();

      await chat.send(session.id, 'kitni baar call kiya tha maine?');

      expect(captured).not.toBeNull();
      const systemText = captured!.messages.filter((m) => m.role === 'system').map((m) => String(m.content)).join('\n');
      expect(systemText).toContain('Aapki live-call history');
      expect(systemText).toContain('Total 2 live calls');
      expect(systemText).toContain('u aur v'); // last-call transcript tail available too
    } finally {
      setLiveCallHistoryStorage(null);
    }
  });
});