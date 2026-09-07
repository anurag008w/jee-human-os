import { describe, it, expect, vi, afterEach } from 'vitest';import type { AppState } from '../../../core/domain/state';
import { emptyAppState } from '../../../core/domain/state';
import type { ChatRepository } from '../../../core/ports/repositories';
import { defaultChatPrefs, INTERNAL_SYSTEM_PROMPT, LEGACY_DIVYA_SYSTEM_PROMPT, LEGACY_MISA_SYSTEM_PROMPT, MISA_IDENTITY_GUARD, type ChatStoreState } from '../../../core/domain/chat';
import { parseChatTranscript, sessionMemoryTag } from '../../../core/domain/chat-transcript';
import type { ContentPart, LLMProvider, LLMResponse, HealthCheckResult, ModelInfo, LLMRequest, ProviderId } from '../../../core/domain/llm';
import { ProviderError } from '../../../core/domain/llm';
import type { StateStore } from '../../../core/ports/repositories';
import type { ProviderFactory } from '../../../infra/ai/provider-factory';
import { LLMService } from '../../ai/llm.service';
import { MemoryService } from '../../ai/memory.service';
import { ProviderSettingsService } from '../../ai/provider-settings.service';
import { ChatService } from '../chat.service';
import { MemoryToolsService } from '../memory-tools.service';
import type { ChatToolsService } from '../chat-tools.service';
import type { WebSearchService, WebSearchResult, WebSearchContext } from '../../../infra/ai/websearch.service';

afterEach(() => vi.unstubAllEnvs());

class MemoryChatRepository implements ChatRepository {
  private state: ChatStoreState = { version: 1, sessions: [] };
  load(): ChatStoreState {
    return this.state;
  }
  save(state: ChatStoreState): void {
    this.state = state;
  }
}

/** Mimics localStorage: every load returns a freshly parsed object graph. */
class FreshLoadChatRepository implements ChatRepository {
  private raw = '{"version":1,"sessions":[]}';
  load(): ChatStoreState {
    return JSON.parse(this.raw) as ChatStoreState;
  }
  save(state: ChatStoreState): void {
    this.raw = JSON.stringify(state);
  }
}

class FakeClock {
  private t = new Date('2026-07-31T10:00:00Z');
  now(): Date {
    return new Date(this.t);
  }
}

/** Makes blob URL -> data URL conversion work in Node (FileReader + fetch). */
function stubBlobUtils(): () => void {
  const g = globalThis as Record<string, unknown>;
  const originalReader = g.FileReader;
  const originalFetch = g.fetch;
  g.FileReader = class {
    result: string | ArrayBuffer | null = null;
    onloadend: (() => void) | null = null;
    onerror: (() => void) | null = null;
    readAsDataURL(blob: Blob): void {
      blob
        .arrayBuffer()
        .then((buf) => {
          const base64 = Buffer.from(buf).toString('base64');
          this.result = `data:${(blob.type || 'application/octet-stream')};base64,${base64}`;
          this.onloadend?.();
        })
        .catch(() => this.onerror?.());
    }
  };
  g.fetch = async () => new Response(new Blob([new Uint8Array([1, 2, 3])], { type: 'application/pdf' }));
  return () => {
    g.FileReader = originalReader;
    g.fetch = originalFetch;
  };
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

function makeStreamingProvider(id: ProviderId, replies: string[], errors: unknown[] = []): LLMProvider {
  let calls = 0;
  return {
    id,
    label: id,
    isConfigured: () => true,
    complete: async (): Promise<LLMResponse> => ({ text: '', model: id }),
    stream: async (req: LLMRequest): Promise<LLMResponse> => {
      const idx = calls;
      calls += 1;
      const text = replies[idx] ?? '';
      if (req.onDelta) {
        for (const ch of text) req.onDelta(ch);
      }
      if (errors[idx]) throw errors[idx];
      return { text, model: id };
    },
    fetchModels: async (): Promise<ModelInfo[]> => [],
    healthCheck: async (): Promise<HealthCheckResult> => ({ ok: true, provider: id, latencyMs: 1 }),
  };
}

function buildService(deps: {
  replies?: string[];
  errors?: unknown[];
  context?: () => string;
  aiSettings?: Partial<AppState['aiSettings']>;
  repo?: ChatRepository;
  withMemory?: boolean;
}): { chat: ChatService; repo: ChatRepository; store: StateStore } {
  const repo = deps.repo ?? new MemoryChatRepository();
  const store = makeStore(
    deps.aiSettings ?? {
      providers: { openrouter: { id: 'openrouter', label: 'OpenRouter', model: 'a', enabled: true } },
      aiEnabled: true,
    },
  );
  const provider = makeStreamingProvider('openrouter', deps.replies ?? ['hi there'], deps.errors ?? []);
  const factory: ProviderFactory = {
    create: () => provider,
  } as unknown as ProviderFactory;
  const settings = new ProviderSettingsService(store, factory);
  const llm = new LLMService(factory, settings);
  const memory = deps.withMemory ? new MemoryService(new FakeClock()) : null;
  const chat = new ChatService(repo, llm, settings, deps.context ?? (() => 'ctx'), new FakeClock(), null, memory, deps.withMemory ? store : null);
  return { chat, repo, store };
}

describe('ChatService', () => {
  it('creates, lists and deletes sessions', () => {
    const { chat } = buildService({});
    const s1 = chat.createSession('pehla');
    const s2 = chat.createSession();
    expect(chat.listSessions().map((s) => s.id)).toEqual([s2.id, s1.id]);
    chat.deleteSession(s1.id);
    expect(chat.listSessions().map((s) => s.id)).toEqual([s2.id]);
  });


  it('creates sessions with supplied global chat defaults', () => {
    const { chat } = buildService({});
    const session = chat.createSession('', {
      ...defaultChatPrefs(),
      temperature: 0.2,
      maxTokens: 1024,
      systemPrompt: 'system-real',
      userPersona: 'user-real',
      includeContext: false,
    });

    expect(session.prefs.temperature).toBe(0.2);
    expect(session.prefs.maxTokens).toBe(1024);
    expect(session.prefs.systemPrompt).toBe('system-real');
    expect(session.prefs.userPersona).toBe('user-real');
    expect(session.prefs.includeContext).toBe(false);
  });

  it('applies global chat settings to every session without touching session-only fields', () => {
    const { chat } = buildService({});
    const s1 = chat.createSession();
    const s2 = chat.createSession('', {
      ...defaultChatPrefs(),
      temperature: 0.1,
      providerId: 'openrouter',
      model: 'special-model',
      thinking: 'high',
    });

    chat.applyGlobalPrefs({
      temperature: 0.9,
      maxTokens: 4096,
      systemPrompt: 'system-global',
      userPersona: 'user-global',
      includeContext: false,
      thinking: 'medium',
    });

    const [first, second] = chat.listSessions();
    for (const s of [first, second]) {
      expect(s.prefs.temperature).toBe(0.9);
      expect(s.prefs.maxTokens).toBe(4096);
      expect(s.prefs.systemPrompt).toBe('system-global');
      expect(s.prefs.userPersona).toBe('user-global');
      expect(s.prefs.includeContext).toBe(false);
    }
    // Newest session is first; session-only fields (providerId, model) survive
    // the global sync while the shared thinking level follows the global.
    expect(first.id).toBe(s2.id);
    expect(first.prefs.providerId).toBe('openrouter');
    expect(first.prefs.model).toBe('special-model');
    expect(first.prefs.thinking).toBe('medium');
    expect(second.id).toBe(s1.id);
  });

  it('clears session thinking when the global thinking is provider-default', () => {
    const { chat } = buildService({});
    const s = chat.createSession('', { ...defaultChatPrefs(), thinking: 'high' });
    chat.applyGlobalPrefs({
      temperature: 0.4,
      maxTokens: 4096,
      systemPrompt: 'sys',
      userPersona: 'persona',
      includeContext: false,
      thinking: undefined,
    });
    expect(chat.getSession(s.id)?.prefs.thinking).toBeUndefined();
  });

  it('derives a title from the first message and persists messages', async () => {
    const { chat, repo } = buildService({ replies: ['namaste'] });
    const session = chat.createSession();
    const reply = await chat.send(session.id, 'Kal ka plan kya tha?');
    const stored = repo.load().sessions[0];
    expect(stored.title).toBe('Kal ka plan kya tha?');
    expect(stored.messages).toHaveLength(2);
    expect(stored.messages[0].role).toBe('user');
    expect(reply.content).toBe('namaste');
  });

  it('injects today context into the system prompt', async () => {
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
    const chat = new ChatService(repo, llm, settings, () => 'ctx-xyz', new FakeClock());
    const session = chat.createSession();
    await chat.send(session.id, 'hi');
    expect(captured).not.toBeNull();
    const systemContents = captured!.messages.filter((m) => m.role === 'system').map((m) => m.content);
    expect(systemContents.join('\n')).toContain('ctx-xyz');
    expect(systemContents[0]).toContain('JEE');
    const last = captured!.messages.at(-1)!;
    expect(last.role).toBe('user');
    expect(last.content).toMatch(/^\[[^\]]+\] hi$/);
  });

  it('tags every history message with its local send time', async () => {
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
    await chat.send(session.id, 'pehla');
    await chat.send(session.id, 'doosra');
    const history = captured!.messages.filter((m) => m.role !== 'system');
    expect(history).toHaveLength(3);
    for (const m of history) expect(m.content).toMatch(/^\[[^\]]+\] /);
  });

  it('rolls back the user message when the provider errors hard', async () => {
    const err = Object.assign(new Error('server down'), { kind: 'server', provider: 'openrouter', status: 500 }) as ProviderError;
    const { chat, repo } = buildService({ errors: [err] });
    const session = chat.createSession();
    await expect(chat.send(session.id, 'message')).rejects.toThrow(/server down/);
    const stored = repo.load().sessions[0];
    expect(stored.messages).toHaveLength(0);
    expect(stored.title).toBe('');
  });

  it('keeps partial text as a stopped message when aborted', async () => {
    const aborted = Object.assign(new Error('cancelled'), { kind: 'aborted', provider: 'openrouter', status: 0 }) as ProviderError;
    const { chat, repo } = buildService({
      replies: ['partial-text'],
      errors: [aborted],
      aiSettings: {
        providers: { openrouter: { id: 'openrouter', label: 'OpenRouter', model: 'a', enabled: true } },
        aiEnabled: true,
      },
    });
    const session = chat.createSession();
    const reply = await chat.send(session.id, 'question');
    const stored = repo.load().sessions[0];
    expect(reply.content).toBe('partial-text');
    expect(reply.stopped).toBe(true);
    expect(stored.messages).toHaveLength(2);
  });

  it('honours custom provider and model in the request', async () => {
    const { chat } = buildService({ replies: ['ok'] });
    const session = chat.createSession();
    chat.updatePrefs(session.id, { ...session.prefs, providerId: 'openrouter', model: 'custom-model' });
    const reply = await chat.send(session.id, 'x');
    expect(reply.model).toBe('openrouter');
  });

  it('caps sessions at the limit', () => {
    const { chat } = buildService({});
    for (let i = 0; i < 25; i += 1) chat.createSession(`s${i}`);
    expect(chat.listSessions()).toHaveLength(20);
  });

  it('persists mutations across loads (fresh-parse repository)', async () => {
    const repo = new FreshLoadChatRepository();
    const { chat } = buildService({ repo, replies: ['reply'] });
    const session = chat.createSession();
    await chat.send(session.id, 'hello');
    const stored = repo.load().sessions[0];
    expect(stored.title).toBe('hello');
    expect(stored.messages.map((m) => m.content)).toEqual(['hello', 'reply']);
  });

  it('appendMessages persists the whole flush ONCE (live-call transcript sink)', () => {
    class CountingRepo extends MemoryChatRepository {
      saves = 0;
      save(state: ChatStoreState): void {
        this.saves += 1;
        super.save(state);
      }
    }
    const counting = new CountingRepo();
    const { chat } = buildService({ repo: counting });
    const session = chat.createSession();
    // createSession already persisted once; measure only the flush below.
    counting.saves = 0;

    // One flush = 3 chunks (same growing id) → exactly ONE persist, not three.
    // (P2: the write is trailing-debounced — flush() lands it on disk once.)
    chat.appendMessages(session.id, [
      { id: 'a1', role: 'assistant', content: 'Hello!', createdAt: '2026-01-01T10:00:00.000Z' },
      { id: 'a1', role: 'assistant', content: 'Hello! How can', createdAt: '2026-01-01T10:00:01.000Z' },
      { id: 'a1', role: 'assistant', content: 'Hello! How can I help?', createdAt: '2026-01-01T10:00:02.000Z' },
    ]);
    chat.flush();
    expect(counting.saves).toBe(1);
    const got1 = chat.getSession(session.id)!;
    expect(got1.messages).toHaveLength(1);
    // Same id re-flush replaces content in place (idempotent grow).
    chat.appendMessages(session.id, [
      { id: 'a1', role: 'assistant', content: 'Hello! How can I help today?', createdAt: '2026-01-01T10:00:03.000Z' },
    ]);
    chat.flush();
    expect(counting.saves).toBe(2);
    expect(chat.getSession(session.id)!.messages[0].content).toBe('Hello! How can I help today?');
    expect(chat.getSession(session.id)!.messages).toHaveLength(1);
  });

  it('feeds live-call transcript messages into the chat AI context so the agent can continue from the call', async () => {
    // Regression: live-voice exchanges are persisted via appendMessages into the
    // same session the user keeps chatting in. The next text reply MUST see them
    // in order in its prompt history — otherwise Misa (chat) has no idea what was
    // discussed on the live call ("live waale messages chat waale ko pata nahi").
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

    // Simulate the live-call transcript sink (handleLiveTranscriptUpdate → appendMessages).
    chat.appendMessages(session.id, [
      { id: 'live-1', role: 'user', content: 'aaj mujhe integration nahi samjha', createdAt: '2026-01-01T10:00:00.000Z' },
      { id: 'live-2', role: 'assistant', content: 'integration me u aur v sath khelte hai...', createdAt: '2026-01-01T10:00:05.000Z' },
      { id: 'live-3', role: 'user', content: 'ok ab samajh gaya, thanks', createdAt: '2026-01-01T10:00:10.000Z' },
    ]);
    chat.flush();

    // User continues in the SAME session after the call.
    await chat.send(session.id, 'waise aaj jo integration samjha tha wo dobara ek line me batao');

    expect(captured).not.toBeNull();
    const history = captured!.messages.filter((m) => m.role !== 'system');
    // live-1 (user) + live-2 (assistant) + live-3 (user) + new text = 4 history turns.
    const assistantContents = history.filter((m) => m.role === 'assistant').map((m) => String(m.content));
    // The live-call assistant turn is present in chat context.
    expect(assistantContents.join('\n')).toContain('integration me u aur v');
    // The user's live turns and the fresh continuation turn are all visible in order.
    const all = history.map((m) => String(m.content));
    const idxLive1 = all.findIndex((c) => c.includes('integration nahi samjha'));
    const idxLive2 = all.findIndex((c) => c.includes('u aur v'));
    const idxLive3 = all.findIndex((c) => c.includes('ab samajh gaya'));
    const idxNew = all.findIndex((c) => c.includes('dobara ek line'));
    expect(idxLive1).toBeGreaterThanOrEqual(0);
    expect(idxLive2).toBeGreaterThan(idxLive1);
    expect(idxLive3).toBeGreaterThan(idxLive2);
    expect(idxNew).toBeGreaterThan(idxLive3);
  });

  it('persists the raw transcript of a finished session into memory on new chat', async () => {
    const { chat, store } = buildService({ replies: ['reply-one', 'reply-two'], withMemory: true });
    const s1 = chat.createSession();
    await chat.send(s1.id, 'Meri aim IIT hai');

    // Before a new chat is created, no raw messages are dumped into memory.
    expect(store.get().memory.entries).toHaveLength(0);

    // Starting a new chat persists the previous transcript verbatim.
    chat.createSession();
    await chat.summarizePriorChats();

    const entries = store.get().memory.entries.filter((e) => e.type === 'conversation');
    expect(entries.length).toBeGreaterThan(0);
    const stored = entries.find((e) => e.context.tags.includes(sessionMemoryTag(s1.id)));
    expect(stored).toBeDefined();
    // Both sides are archived as a structured, timestamped transcript — no AI
    // condensation.
    const transcript = parseChatTranscript(stored?.content ?? '');
    expect(transcript).not.toBeNull();
    expect(transcript?.sessionId).toBe(s1.id);
    expect(transcript?.messages.some((m) => m.role === 'user' && m.content === 'Meri aim IIT hai')).toBe(true);
    expect(transcript?.messages.some((m) => m.role === 'assistant')).toBe(true);
    expect(stored?.blockId).toBe(`chat:${s1.id}`);
    expect(stored?.summarized).toBe(false);

    // A session is only persisted once.
    await chat.summarizePriorChats();
    const entriesAfter = store.get().memory.entries.filter((e) => e.type === 'conversation');
    expect(entriesAfter).toHaveLength(entries.length);
  });

  it('never auto-dumps the session the user is actively chatting in', async () => {
    const { chat, repo } = buildService({ replies: ['reply'], withMemory: true });
    const s1 = chat.createSession();
    await chat.send(s1.id, 'Meri aim IIT hai');
    chat.setActiveSessionId(s1.id);

    // While active, the raw transcript is NOT dumped — it waits for the user's
    // explicit "copy to memory" decision on switch.
    await chat.summarizePriorChats();
    expect(repo.load().sessions.find((s) => s.id === s1.id)?.memorySummarizedAt).toBeUndefined();

    // Once the session is no longer active it becomes eligible for the dump.
    chat.setActiveSessionId(null);
    await chat.summarizePriorChats();
    expect(repo.load().sessions.find((s) => s.id === s1.id)?.memorySummarizedAt).toBeDefined();
  });

  it('archiveSessionToMemory copies a chat once and keeps it in history', async () => {
    const { chat, repo, store } = buildService({ replies: ['reply'], withMemory: true });
    const s1 = chat.createSession();
    await chat.send(s1.id, 'Meri aim IIT hai');

    expect(chat.isChatArchived(s1.id)).toBe(false);

    expect(chat.archiveSessionToMemory(s1.id)).toBe(true);
    expect(chat.isChatArchived(s1.id)).toBe(true);
    // The transcript is stored tagged to this session.
    const stored = store.get().memory.entries.find((e) => e.context.tags.includes(sessionMemoryTag(s1.id)));
    expect(stored).toBeDefined();
    expect(parseChatTranscript(stored?.content ?? '')?.sessionId).toBe(s1.id);

    // Idempotent — a copied chat is never stored again.
    expect(chat.archiveSessionToMemory(s1.id)).toBe(false);

    // It's a copy, not a move: the chat still exists in normal history.
    expect(repo.load().sessions.some((s) => s.id === s1.id)).toBe(true);
  });

  it('archiveSessionToMemory refuses unknown, empty and memory-off cases', async () => {
    const { chat } = buildService({ withMemory: true });
    expect(chat.archiveSessionToMemory('ghost')).toBe(false);

    const empty = chat.createSession();
    expect(chat.archiveSessionToMemory(empty.id)).toBe(false);

    const { chat: noMemory } = buildService({});
    const s2 = noMemory.createSession();
    await noMemory.send(s2.id, 'hello');
    expect(noMemory.archiveSessionToMemory(s2.id)).toBe(false);
  });

  it('recalls stored earlier-conversation transcripts into later sessions', async () => {
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
    const memory = new MemoryService(new FakeClock());
    const chat = new ChatService(repo, llm, settings, () => 'ctx', new FakeClock(), null, memory, store);
    const s1 = chat.createSession();
    await chat.send(s1.id, 'Meri aim IIT ka preparation hai');

    // New chat stores the transcript; it is recalled into later sessions.
    chat.createSession();
    await chat.summarizePriorChats();
    const s2 = chat.createSession();
    await chat.send(s2.id, 'Kya yaad hai mujhe?');
    expect(captured).not.toBeNull();
    const systemContents = captured!.messages.filter((m) => m.role === 'system').map((m) => m.content);
    expect(systemContents.join('\n')).toContain('Meri aim IIT ka preparation hai');
  });

  it('persists raw chats to memory without any model call', async () => {
    let completeCalls = 0;
    const repo = new MemoryChatRepository();
    const store = makeStore({
      providers: { openrouter: { id: 'openrouter', label: 'OpenRouter', model: 'a', enabled: true } },
      aiEnabled: true,
    });
    const provider: LLMProvider = {
      id: 'openrouter',
      label: 'OpenRouter',
      isConfigured: () => true,
      complete: async (): Promise<LLMResponse> => {
        completeCalls += 1;
        throw new Error('model down');
      },
      stream: async (): Promise<LLMResponse> => ({ text: 'done', model: 'a' }),
      fetchModels: async (): Promise<ModelInfo[]> => [],
      healthCheck: async (): Promise<HealthCheckResult> => ({ ok: true, provider: 'openrouter', latencyMs: 1 }),
    };
    const factory: ProviderFactory = { create: () => provider } as unknown as ProviderFactory;
    const settings = new ProviderSettingsService(store, factory);
    const llm = new LLMService(factory, settings);
    const memory = new MemoryService(new FakeClock());
    const chat = new ChatService(repo, llm, settings, () => 'ctx', new FakeClock(), null, memory, store);
    const s1 = chat.createSession();
    await chat.send(s1.id, 'Meri aim IIT hai');

    await expect(chat.summarizePriorChats()).resolves.toBe(1);

    const entries = store.get().memory.entries.filter((e) => e.type === 'conversation' && e.context.tags.includes(sessionMemoryTag(s1.id)));
    expect(entries.length).toBeGreaterThan(0);
    const transcript = parseChatTranscript(entries[0].content);
    expect(transcript?.messages.some((m) => m.content.includes('Meri aim IIT hai'))).toBe(true);
    expect(repo.load().sessions.find((s) => s.id === s1.id)?.memorySummarizedAt).toBeDefined();
    // Raw storage is deterministic — the model is never consulted.
    expect(completeCalls).toBe(0);
  });

  it('retries a session whose memory write failed on the next run', async () => {
    const repo = new MemoryChatRepository();
    let state: AppState = {
      ...emptyAppState(),
      aiSettings: {
        ...emptyAppState().aiSettings,
        aiEnabled: true,
        providers: { openrouter: { id: 'openrouter', label: 'OpenRouter', model: 'a', enabled: true } },
      },
    };
    let writes = 0;
    const store: StateStore = {
      get: () => state,
      save: (s: AppState) => {
        writes += 1;
        if (writes === 1) throw new Error('storage full');
        state = s;
      },
    };
    const provider: LLMProvider = {
      id: 'openrouter',
      label: 'OpenRouter',
      isConfigured: () => true,
      complete: async (): Promise<LLMResponse> => ({ text: '', model: 'a' }),
      stream: async (): Promise<LLMResponse> => ({ text: 'done', model: 'a' }),
      fetchModels: async (): Promise<ModelInfo[]> => [],
      healthCheck: async (): Promise<HealthCheckResult> => ({ ok: true, provider: 'openrouter', latencyMs: 1 }),
    };
    const factory: ProviderFactory = { create: () => provider } as unknown as ProviderFactory;
    const settings = new ProviderSettingsService(store, factory);
    const llm = new LLMService(factory, settings);
    const memory = new MemoryService(new FakeClock());
    const chat = new ChatService(repo, llm, settings, () => 'ctx', new FakeClock(), null, memory, store);
    const s1 = chat.createSession();
    await chat.send(s1.id, 'Meri aim IIT hai');

    // First run: the memory write fails, so the session must stay unmarked.
    await expect(chat.summarizePriorChats()).resolves.toBe(0);
    expect(repo.load().sessions.find((s) => s.id === s1.id)?.memorySummarizedAt).toBeUndefined();
    expect(store.get().memory.entries).toHaveLength(0);

    // Second run: retried and completed.
    await expect(chat.summarizePriorChats()).resolves.toBe(1);
    expect(repo.load().sessions.find((s) => s.id === s1.id)?.memorySummarizedAt).toBeDefined();
    const entries = store.get().memory.entries.filter((e) => e.context.tags.includes(sessionMemoryTag(s1.id)));
    expect(entries.length).toBeGreaterThan(0);
  });

  it('still writes a transcript for a degenerate session', async () => {
    const { chat, store, repo } = buildService({ withMemory: true, replies: ['ok'] });
    const s1 = chat.createSession();
    await chat.send(s1.id, '   ');
    await chat.summarizePriorChats();
    const entries = store.get().memory.entries.filter((e) => e.context.tags.includes(sessionMemoryTag(s1.id)));
    expect(entries.length).toBeGreaterThan(0);
    expect(repo.load().sessions.find((s) => s.id === s1.id)?.memorySummarizedAt).toBeDefined();
  });

  it('stores the raw transcript verbatim, including coach replies', async () => {
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
      stream: async (): Promise<LLMResponse> => ({ text: 'done', model: 'a' }),
      fetchModels: async (): Promise<ModelInfo[]> => [],
      healthCheck: async (): Promise<HealthCheckResult> => ({ ok: true, provider: 'openrouter', latencyMs: 1 }),
    };
    const factory: ProviderFactory = { create: () => provider } as unknown as ProviderFactory;
    const settings = new ProviderSettingsService(store, factory);
    const llm = new LLMService(factory, settings);
    const memory = new MemoryService(new FakeClock());
    const chat = new ChatService(repo, llm, settings, () => 'ctx', new FakeClock(), null, memory, store);
    const s1 = chat.createSession();
    await chat.send(s1.id, 'Meri weak topic vectors aur limits hain, roz practice karni hai');
    await chat.send(s1.id, '### Problem:\n\nIs integral ka step-by-step solution do');
    await chat.send(s1.id, 'Hi');
    await chat.summarizePriorChats();

    const all = store
      .get()
      .memory.entries.filter((e) => e.context.tags.includes(sessionMemoryTag(s1.id)));
    const transcript = parseChatTranscript(all[0]?.content ?? '');
    const text = (transcript?.messages ?? [])
      .map((m) => `${m.role === 'user' ? 'Student' : 'Misa'}: ${m.content}`)
      .join('\n');
    // Both sides of the chat land in memory untouched, in one transcript.
    expect(text).toContain('weak topic vectors');
    expect(text).toContain('step-by-step solution');
    expect(text).toContain('Misa');
    expect(text).toContain('### Problem:');
    expect(text).toContain('Student: Hi');
    // The AI reply right after the student line is kept together with it.
    expect(text).toMatch(/Student: Hi\nMisa: done/);
  });

  it('sends file attachments directly to the model as file parts', async () => {
    const restore = stubBlobUtils();
    try {
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
          return { text: 'file understood', model: 'a' };
        },
        fetchModels: async (): Promise<ModelInfo[]> => [],
        healthCheck: async (): Promise<HealthCheckResult> => ({ ok: true, provider: 'openrouter', latencyMs: 1 }),
      };
      const factory: ProviderFactory = { create: () => provider } as unknown as ProviderFactory;
      const settings = new ProviderSettingsService(store, factory);
      const llm = new LLMService(factory, settings);
      const chat = new ChatService(repo, llm, settings, () => 'ctx', new FakeClock(), null, null, store);
      const s1 = chat.createSession();

      await chat.send(
        s1.id,
        'Analyze this PDF',
        undefined,
        undefined,
        undefined,
        undefined,
        [{ id: 'a1', name: 'doc.pdf', kind: 'file', previewUrl: 'blob:fake' }],
      );

      expect(captured).not.toBeNull();
      const lastUser = captured!.messages.filter((m) => m.role === 'user').pop()!;
      const parts = lastUser.content as ContentPart[];
      const filePart = parts.find((p) => p.type === 'file');
      expect(filePart).toBeDefined();
      if (filePart && filePart.type === 'file') {
        expect(filePart.file.filename).toBe('doc.pdf');
        expect(filePart.file.file_data).toContain('data:');
      }
    } finally {
      restore();
    }
  });

  it('falls back to extracted text when the direct file send fails', async () => {
    let calls = 0;
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
      stream: async (): Promise<LLMResponse> => {
        calls += 1;
        if (calls === 1) throw new ProviderError('openrouter', 'rate-limit', 'Rate limited or model down');
        return { text: 'extracted reply', model: 'a' };
      },
      fetchModels: async (): Promise<ModelInfo[]> => [],
      healthCheck: async (): Promise<HealthCheckResult> => ({ ok: true, provider: 'openrouter', latencyMs: 1 }),
    };
    const factory: ProviderFactory = { create: () => provider } as unknown as ProviderFactory;
    const settings = new ProviderSettingsService(store, factory);
    const llm = new LLMService(factory, settings);
    const chat = new ChatService(
      repo,
      llm,
      settings,
      () => 'ctx',
      new FakeClock(),
      null,
      null,
      store,
      async () => 'PDF extracted text content yahan hai',
    );
    const s1 = chat.createSession();

    const result = await chat.send(
      s1.id,
      'Analyze',
      undefined,
      undefined,
      undefined,
      undefined,
      [{ id: 'a1', name: 'doc.pdf', kind: 'file', previewUrl: 'blob:fake' }],
    );

    expect(calls).toBe(2);
    expect(result.content).toContain('extracted reply');
    const userMsg = repo.load().sessions[0].messages[0];
    expect(userMsg.content).toContain('PDF extracted text content yahan hai');
    expect(userMsg.attachments ?? []).toHaveLength(0);

    // A second file send in the same session goes straight to text.
    const again = await chat.send(
      s1.id,
      'one more',
      undefined,
      undefined,
      undefined,
      undefined,
      [{ id: 'a2', name: 'next.pdf', kind: 'file', previewUrl: 'blob:fake' }],
    );
    expect(again.content).toContain('extracted reply');
  });

  it('drops malformed tool JSON instead of leaking it into the assistant history (M2)', async () => {
    // Truncated actions wrapper: starts with '{' but won't parse, and carries
    // NO `"action":` token (so even the pre-fix regex sniff didn't catch it).
    // Pre-fix this fell through looksLikeToolOutput -> shown verbatim to the
    // user and persisted into history, corrupting the next generation.
    const malformed = '{"actions":[';
    const repo = new MemoryChatRepository();
    const store = makeStore({
      providers: { openrouter: { id: 'openrouter', label: 'OpenRouter', model: 'a', enabled: true } },
      aiEnabled: true,
    });
    const provider: LLMProvider = {
      id: 'openrouter',
      label: 'OpenRouter',
      isConfigured: () => true,
      complete: async (): Promise<LLMResponse> => ({ text: malformed, model: 'a' }),
      stream: async (req: LLMRequest): Promise<LLMResponse> => {
        if (req.onDelta) for (const ch of 'normal reply') req.onDelta(ch);
        return { text: 'normal reply', model: 'a' };
      },
      fetchModels: async (): Promise<ModelInfo[]> => [],
      healthCheck: async (): Promise<HealthCheckResult> => ({ ok: true, provider: 'openrouter', latencyMs: 1 }),
    };
    const factory: ProviderFactory = { create: () => provider } as unknown as ProviderFactory;
    const settings = new ProviderSettingsService(store, factory);
    const llm = new LLMService(factory, settings);
    const chat = new ChatService(repo, llm, settings, () => 'ctx', new FakeClock(), null, null, store);
    const s1 = chat.createSession();

    const result = await chat.send(s1.id, 'kal ka plan kya hai', undefined, undefined, undefined, undefined, undefined, ['listTasks']);

    // The reply is the normal streaming answer, NOT the broken JSON.
    expect(result.content).toBe('normal reply');
    const persisted = JSON.stringify(repo.load().sessions[0].messages);
    expect(persisted).not.toContain('actions');
    expect(persisted).toContain('normal reply');
  });

  it('sends image attachments to the model as image parts while the blob is alive', async () => {
    const restore = stubBlobUtils();
    try {
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
          return { text: 'image seen', model: 'a' };
        },
        fetchModels: async (): Promise<ModelInfo[]> => [],
        healthCheck: async (): Promise<HealthCheckResult> => ({ ok: true, provider: 'openrouter', latencyMs: 1 }),
      };
      const factory: ProviderFactory = { create: () => provider } as unknown as ProviderFactory;
      const settings = new ProviderSettingsService(store, factory);
      const llm = new LLMService(factory, settings);
      const chat = new ChatService(repo, llm, settings, () => 'ctx', new FakeClock(), null, null, store);
      const s1 = chat.createSession();

      await chat.send(
        s1.id,
        'yeh photo dekho',
        undefined,
        undefined,
        undefined,
        undefined,
        [{ id: 'a1', name: 'photo.png', kind: 'image', previewUrl: 'blob:fake', content: '[Image: photo.png]' }],
      );

      expect(captured).not.toBeNull();
      const lastUser = captured!.messages.filter((m) => m.role === 'user').pop()!;
      const parts = lastUser.content as ContentPart[];
      const imagePart = parts.find((p) => p.type === 'image');
      expect(imagePart).toBeDefined();
      if (imagePart && imagePart.type === 'image') expect(imagePart.image).toContain('data:');
    } finally {
      restore();
    }
  });

  it('never silently drops an image with a dead blob — sends a text descriptor instead (N5/M11)', async () => {
    // No stubBlobUtils: the blob URL never resolves (as after an app reload or
    // a revoke), so blobToDataUrl returns null. The old code dropped the image
    // silently and the AI answered with ZERO image context; the fix surfaces a
    // stable descriptor so the model knows an image was attached.
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
        return { text: 'ok', model: 'a' };
      },
      fetchModels: async (): Promise<ModelInfo[]> => [],
      healthCheck: async (): Promise<HealthCheckResult> => ({ ok: true, provider: 'openrouter', latencyMs: 1 }),
    };
    const factory: ProviderFactory = { create: () => provider } as unknown as ProviderFactory;
    const settings = new ProviderSettingsService(store, factory);
    const llm = new LLMService(factory, settings);
    const chat = new ChatService(repo, llm, settings, () => 'ctx', new FakeClock(), null, null, store);
    const s1 = chat.createSession();

    await chat.send(
      s1.id,
      'yeh photo dekho',
      undefined,
      undefined,
      undefined,
      undefined,
      [{ id: 'a1', name: 'photo.png', kind: 'image', previewUrl: 'blob:dead', content: '[Image: photo.png]' }],
    );

    expect(captured).not.toBeNull();
    const lastUser = captured!.messages.filter((m) => m.role === 'user').pop()!;
    const parts = lastUser.content as ContentPart[];
    // No dead image part is sent…
    expect(parts.find((p) => p.type === 'image')).toBeUndefined();
    // …but the attachment is NOT silently dropped — the model sees the name.
    const text = parts.filter((p) => p.type === 'text').map((p) => p.text).join(' ');
    expect(text).toContain('photo.png');
    expect(text).toContain('[Image: photo.png]');
  });

  it('flushes the sanitizer tail so the final streamed chars are not lost', async () => {
    let captureDelta: ((d: string) => void) | null = null;
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
        captureDelta = req.onDelta ?? null;
        // "to" at a line start could grow into a "tool:" trace, so the
        // sanitizer holds it — flush() must release it once the stream ends.
        captureDelta?.('Done.\nto');
        return { text: 'Done.\nto', model: 'a' };
      },
      fetchModels: async (): Promise<ModelInfo[]> => [],
      healthCheck: async (): Promise<HealthCheckResult> => ({ ok: true, provider: 'openrouter', latencyMs: 1 }),
    };
    const factory: ProviderFactory = { create: () => provider } as unknown as ProviderFactory;
    const settings = new ProviderSettingsService(store, factory);
    const llm = new LLMService(factory, settings);
    const chat = new ChatService(repo, llm, settings, () => 'ctx', new FakeClock(), null, null, store);

    const deltas: string[] = [];
    const s1 = chat.createSession();
    await chat.send(s1.id, 'q', (d) => deltas.push(d));

    // Without the flush after the stream, the trailing "to" would be dropped.
    expect(deltas.join('')).toBe('Done.\nto');
  });

  it('doubles the max_tokens budget when thinking is on', async () => {
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
        return { text: 'ok', model: 'a' };
      },
      fetchModels: async (): Promise<ModelInfo[]> => [],
      healthCheck: async (): Promise<HealthCheckResult> => ({ ok: true, provider: 'openrouter', latencyMs: 1 }),
    };
    const factory: ProviderFactory = { create: () => provider } as unknown as ProviderFactory;
    const settings = new ProviderSettingsService(store, factory);
    const llm = new LLMService(factory, settings);
    const chat = new ChatService(repo, llm, settings, () => 'ctx', new FakeClock(), null, null, store);
    const s1 = chat.createSession();

    // Session-level thinking preference is on → budget doubles for headroom.
    s1.prefs = { ...s1.prefs, thinking: 'medium' };
    await chat.send(s1.id, 'q');
    expect(captured!.thinking).toBe('medium');
    expect(captured!.maxTokens).toBe(16384);

    // Thinking off → the user's own budget is used as-is.
    s1.prefs = { ...s1.prefs, thinking: 'off' };
    await chat.send(s1.id, 'q2');
    expect(captured!.maxTokens).toBe(8192);
  });

  it('does not extract/retry when a file send is aborted by the user', async () => {
    let calls = 0;
    let extracted = 0;
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
      stream: async (): Promise<LLMResponse> => {
        calls += 1;
        throw new ProviderError('openrouter', 'aborted', 'aborted by user');
      },
      fetchModels: async (): Promise<ModelInfo[]> => [],
      healthCheck: async (): Promise<HealthCheckResult> => ({ ok: true, provider: 'openrouter', latencyMs: 1 }),
    };
    const factory: ProviderFactory = { create: () => provider } as unknown as ProviderFactory;
    const settings = new ProviderSettingsService(store, factory);
    const llm = new LLMService(factory, settings);
    const chat = new ChatService(
      repo,
      llm,
      settings,
      () => 'ctx',
      new FakeClock(),
      null,
      null,
      store,
      async () => {
        extracted += 1;
        return 'never extracted';
      },
    );
    const s1 = chat.createSession();

    await expect(
      chat.send(
        s1.id,
        'Analyze',
        undefined,
        undefined,
        undefined,
        undefined,
        [{ id: 'a1', name: 'doc.pdf', kind: 'file', previewUrl: 'blob:fake' }],
      ),
    ).rejects.toBeInstanceOf(ProviderError);

    expect(calls).toBe(1);
    expect(extracted).toBe(0);
    // The user message is rolled back so no stray attachment mutation remains.
    expect(repo.load().sessions[0].messages).toHaveLength(0);
  });

  it('routes memory queries through the memory tool decision hop', async () => {
    const store = makeStore({
      providers: { openrouter: { id: 'openrouter', label: 'OpenRouter', model: 'a', enabled: true } },
      aiEnabled: true,
    });
    const memory = new MemoryService(new FakeClock());
    const init = memory.add(store.get(), { type: 'goal', content: 'Aim: IIT Delhi, weak in Calculus', source: 'user', importance: 0.9 });
    store.save(init);

    let capturedComplete: LLMRequest | null = null;
    const provider: LLMProvider = {
      id: 'openrouter',
      label: 'OpenRouter',
      isConfigured: () => true,
      complete: async (req: LLMRequest): Promise<LLMResponse> => {
        capturedComplete = req;
        return { text: '{"action":"readMemory"}', model: 'a' };
      },
      stream: async (): Promise<LLMResponse> => ({ text: '', model: 'a' }),
      fetchModels: async (): Promise<ModelInfo[]> => [],
      healthCheck: async (): Promise<HealthCheckResult> => ({ ok: true, provider: 'openrouter', latencyMs: 1 }),
    };
    const factory: ProviderFactory = { create: () => provider } as unknown as ProviderFactory;
    const settings = new ProviderSettingsService(store, factory);
    const llm = new LLMService(factory, settings);
    const memoryTools = new MemoryToolsService(store, memory);
    const chat = new ChatService(new MemoryChatRepository(), llm, settings, () => 'ctx', new FakeClock(), null, memory, store, undefined, memoryTools);
    const s1 = chat.createSession();

    const result = await chat.send(s1.id, 'Tumhe kya yaad hai?');

    // The decision hop saw the memory tool instructions, and the executed
    // readMemory result became the assistant reply.
    const systemText = capturedComplete!.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n');
    expect(systemText).toContain('readMemory');
    expect(result.content).toContain('IIT Delhi');
    expect(result.content).toContain('id:');
  });

  it('does not run the memory tool hop when AI memory is disabled', async () => {
    const store = makeStore({
      providers: { openrouter: { id: 'openrouter', label: 'OpenRouter', model: 'a', enabled: true } },
      aiEnabled: true,
      chat: { ...emptyAppState().aiSettings.chat, memoryEnabled: false },
    });
    const memory = new MemoryService(new FakeClock());
    let streamed = false;
    const provider: LLMProvider = {
      id: 'openrouter',
      label: 'OpenRouter',
      isConfigured: () => true,
      complete: async (): Promise<LLMResponse> => ({ text: '{"action":"readMemory"}', model: 'a' }),
      stream: async (): Promise<LLMResponse> => {
        streamed = true;
        return { text: 'normal reply', model: 'a' };
      },
      fetchModels: async (): Promise<ModelInfo[]> => [],
      healthCheck: async (): Promise<HealthCheckResult> => ({ ok: true, provider: 'openrouter', latencyMs: 1 }),
    };
    const factory: ProviderFactory = { create: () => provider } as unknown as ProviderFactory;
    const settings = new ProviderSettingsService(store, factory);
    const llm = new LLMService(factory, settings);
    const memoryTools = new MemoryToolsService(store, memory);
    const chat = new ChatService(new MemoryChatRepository(), llm, settings, () => 'ctx', new FakeClock(), null, memory, store, undefined, memoryTools);
    const s1 = chat.createSession();

    // Memory is off, so "kya yaad hai" is just a normal streamed question.
    await chat.send(s1.id, 'Tumhe kya yaad hai?');
    expect(streamed).toBe(true);
    expect(await chat.summarizePriorChats()).toBe(0);
    expect(chat.pendingSummaries()).toBe(0);
  });

  it('"yaad rakho X" saves a new fact through the addMemory tool', async () => {
    const store = makeStore({
      providers: { openrouter: { id: 'openrouter', label: 'OpenRouter', model: 'a', enabled: true } },
      aiEnabled: true,
    });
    const memory = new MemoryService(new FakeClock());

    let capturedComplete: LLMRequest | null = null;
    const provider: LLMProvider = {
      id: 'openrouter',
      label: 'OpenRouter',
      isConfigured: () => true,
      complete: async (req: LLMRequest): Promise<LLMResponse> => {
        capturedComplete = req;
        return { text: '{"action":"addMemory","content":"Physics weak hai, Electrostatics first"}', model: 'a' };
      },
      stream: async (): Promise<LLMResponse> => ({ text: '', model: 'a' }),
      fetchModels: async (): Promise<ModelInfo[]> => [],
      healthCheck: async (): Promise<HealthCheckResult> => ({ ok: true, provider: 'openrouter', latencyMs: 1 }),
    };
    const factory: ProviderFactory = { create: () => provider } as unknown as ProviderFactory;
    const settings = new ProviderSettingsService(store, factory);
    const llm = new LLMService(factory, settings);
    const memoryTools = new MemoryToolsService(store, memory);
    const chat = new ChatService(new MemoryChatRepository(), llm, settings, () => 'ctx', new FakeClock(), null, memory, store, undefined, memoryTools);
    const s1 = chat.createSession();

    const result = await chat.send(s1.id, 'Yaad rakho physics weak hai');

    // The decision hop instructions advertise addMemory, and the fact landed
    // in the persistent memory store as a user entry.
    const systemText = capturedComplete!.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n');
    expect(systemText).toContain('addMemory');
    expect(result.content).toContain('Physics weak hai');
    const saved = store.get().memory.entries.find((e) => e.content === 'Physics weak hai, Electrostatics first');
    expect(saved).toBeDefined();
    expect(saved?.source).toBe('user');
    expect(saved?.type).toBe('observation');
  });

  it('destructive memory actions ask for explicit user confirmation before deleting', async () => {
    const store = makeStore({
      providers: { openrouter: { id: 'openrouter', label: 'OpenRouter', model: 'a', enabled: true } },
      aiEnabled: true,
    });
    const memory = new MemoryService(new FakeClock());
    const init = memory.add(store.get(), { type: 'goal', content: 'Aim: IIT Delhi', source: 'user', importance: 0.9 });
    store.save(init);
    const id = init.memory.entries[0].id;

    let completeCalls = 0;
    const provider: LLMProvider = {
      id: 'openrouter',
      label: 'OpenRouter',
      isConfigured: () => true,
      complete: async (): Promise<LLMResponse> => {
        completeCalls += 1;
        return { text: `{"action":"deleteMemory","id":"${id}"}`, model: 'a' };
      },
      stream: async (): Promise<LLMResponse> => ({ text: '', model: 'a' }),
      fetchModels: async (): Promise<ModelInfo[]> => [],
      healthCheck: async (): Promise<HealthCheckResult> => ({ ok: true, provider: 'openrouter', latencyMs: 1 }),
    };
    const factory: ProviderFactory = { create: () => provider } as unknown as ProviderFactory;
    const settings = new ProviderSettingsService(store, factory);
    const llm = new LLMService(factory, settings);
    const memoryTools = new MemoryToolsService(store, memory);
    const chat = new ChatService(new MemoryChatRepository(), llm, settings, () => 'ctx', new FakeClock(), null, memory, store, undefined, memoryTools);
    const s1 = chat.createSession();

    // Decision hop proposes a deletion. The preview is surfaced as a
    // user-facing question and the entry is untouched — no second model call
    // decides consent on the user's behalf.
    const result = await chat.send(s1.id, 'Wo memory check karo');
    expect(result.content).toContain('delete kar doon');
    expect(result.content).toContain('Aim: IIT Delhi');
    expect(store.get().memory.entries.some((e) => e.id === id)).toBe(true);
    expect(completeCalls).toBe(1);

    // An explicit follow-up "haan karo" executes the held deletion
    // deterministically (no additional model round-trip).
    const confirmed = await chat.send(s1.id, 'Haan karo');
    expect(confirmed.content).toContain('Deleted');
    expect(store.get().memory.entries.some((e) => e.id === id)).toBe(false);
    expect(completeCalls).toBe(1);
  });

  it('a non-confirmation message dismisses a pending memory deletion', async () => {
    const store = makeStore({
      providers: { openrouter: { id: 'openrouter', label: 'OpenRouter', model: 'a', enabled: true } },
      aiEnabled: true,
    });
    const memory = new MemoryService(new FakeClock());
    const init = memory.add(store.get(), { type: 'goal', content: 'Aim: IIT Delhi', source: 'user', importance: 0.9 });
    store.save(init);
    const id = init.memory.entries[0].id;

    const provider: LLMProvider = {
      id: 'openrouter',
      label: 'OpenRouter',
      isConfigured: () => true,
      complete: async (): Promise<LLMResponse> => ({ text: `{"action":"deleteMemory","id":"${id}"}`, model: 'a' }),
      stream: async (): Promise<LLMResponse> => ({ text: 'normal reply', model: 'a' }),
      fetchModels: async (): Promise<ModelInfo[]> => [],
      healthCheck: async (): Promise<HealthCheckResult> => ({ ok: true, provider: 'openrouter', latencyMs: 1 }),
    };
    const factory: ProviderFactory = { create: () => provider } as unknown as ProviderFactory;
    const settings = new ProviderSettingsService(store, factory);
    const llm = new LLMService(factory, settings);
    const memoryTools = new MemoryToolsService(store, memory);
    const chat = new ChatService(new MemoryChatRepository(), llm, settings, () => 'ctx', new FakeClock(), null, memory, store, undefined, memoryTools);
    const s1 = chat.createSession();

    await chat.send(s1.id, 'Wo memory check karo');
    expect(store.get().memory.entries.some((e) => e.id === id)).toBe(true);

    // The user moves on without confirming — the pending deletion is dropped.
    await chat.send(s1.id, 'Nahi, koi baat nahi');
    // A later "haan" must NOT resurrect the dropped deletion.
    await chat.send(s1.id, 'Haan karo');
    expect(store.get().memory.entries.some((e) => e.id === id)).toBe(true);
  });

  it('memory deletion: pendingConfirmation on the message carries the exact action for a UI Yes/No button (not free-text)', async () => {
    const store = makeStore({
      providers: { openrouter: { id: 'openrouter', label: 'OpenRouter', model: 'a', enabled: true } },
      aiEnabled: true,
    });
    const memory = new MemoryService(new FakeClock());
    const init = memory.add(store.get(), { type: 'goal', content: 'Aim: IIT Delhi', source: 'user', importance: 0.9 });
    store.save(init);
    const id = init.memory.entries[0].id;
    const provider: LLMProvider = {
      id: 'openrouter',
      label: 'OpenRouter',
      isConfigured: () => true,
      complete: async (): Promise<LLMResponse> => ({ text: `{"action":"deleteMemory","id":"${id}"}`, model: 'a' }),
      stream: async (): Promise<LLMResponse> => ({ text: '', model: 'a' }),
      fetchModels: async (): Promise<ModelInfo[]> => [],
      healthCheck: async (): Promise<HealthCheckResult> => ({ ok: true, provider: 'openrouter', latencyMs: 1 }),
    };
    const factory: ProviderFactory = { create: () => provider } as unknown as ProviderFactory;
    const settings = new ProviderSettingsService(store, factory);
    const llm = new LLMService(factory, settings);
    const memoryTools = new MemoryToolsService(store, memory);
    const chat = new ChatService(new MemoryChatRepository(), llm, settings, () => 'ctx', new FakeClock(), null, memory, store, undefined, memoryTools);
    const s1 = chat.createSession();

    const preview = await chat.send(s1.id, 'Wo memory check karo');
    expect(preview.pendingConfirmation?.kind).toBe('memory');
    expect(store.get().memory.entries.some((e) => e.id === id)).toBe(true);

    // "Yes" button tap — deterministic, no LLM round-trip for the deletion.
    const confirmed = await chat.confirmPendingAction(s1.id, preview.id, true);
    expect(confirmed.content).toContain('Deleted');
    expect(store.get().memory.entries.some((e) => e.id === id)).toBe(false);
    // The original message's buttons are now resolved.
    expect(chat.getSession(s1.id)?.messages.find((m) => m.id === preview.id)?.pendingConfirmation).toBeUndefined();
  });

  it('memory deletion: "No" button cancels without applying, and a later free-text "haan" cannot resurrect it', async () => {
    const store = makeStore({
      providers: { openrouter: { id: 'openrouter', label: 'OpenRouter', model: 'a', enabled: true } },
      aiEnabled: true,
    });
    const memory = new MemoryService(new FakeClock());
    const init = memory.add(store.get(), { type: 'goal', content: 'Aim: IIT Delhi', source: 'user', importance: 0.9 });
    store.save(init);
    const id = init.memory.entries[0].id;
    const provider: LLMProvider = {
      id: 'openrouter',
      label: 'OpenRouter',
      isConfigured: () => true,
      complete: async (): Promise<LLMResponse> => ({ text: `{"action":"deleteMemory","id":"${id}"}`, model: 'a' }),
      stream: async (): Promise<LLMResponse> => ({ text: 'normal reply', model: 'a' }),
      fetchModels: async (): Promise<ModelInfo[]> => [],
      healthCheck: async (): Promise<HealthCheckResult> => ({ ok: true, provider: 'openrouter', latencyMs: 1 }),
    };
    const factory: ProviderFactory = { create: () => provider } as unknown as ProviderFactory;
    const settings = new ProviderSettingsService(store, factory);
    const llm = new LLMService(factory, settings);
    const memoryTools = new MemoryToolsService(store, memory);
    const chat = new ChatService(new MemoryChatRepository(), llm, settings, () => 'ctx', new FakeClock(), null, memory, store, undefined, memoryTools);
    const s1 = chat.createSession();

    const preview = await chat.send(s1.id, 'Wo memory check karo');
    const cancelled = await chat.confirmPendingAction(s1.id, preview.id, false);
    expect(cancelled.content).toContain('cancel');
    expect(store.get().memory.entries.some((e) => e.id === id)).toBe(true);

    // The old free-text tracker was cleared by the button tap too — a stray
    // "haan" afterwards must not resurrect the cancelled deletion.
    await chat.send(s1.id, 'Haan karo');
    expect(store.get().memory.entries.some((e) => e.id === id)).toBe(true);
  });

  it('a question starting with an affirmative word does NOT confirm a deletion', async () => {
    const store = makeStore({
      providers: { openrouter: { id: 'openrouter', label: 'OpenRouter', model: 'a', enabled: true } },
      aiEnabled: true,
    });
    const memory = new MemoryService(new FakeClock());
    const init = memory.add(store.get(), { type: 'goal', content: 'Aim: IIT Delhi', source: 'user', importance: 0.9 });
    store.save(init);
    const id = init.memory.entries[0].id;

    const provider: LLMProvider = {
      id: 'openrouter',
      label: 'OpenRouter',
      isConfigured: () => true,
      complete: async (): Promise<LLMResponse> => ({ text: `{"action":"deleteMemory","id":"${id}"}`, model: 'a' }),
      stream: async (): Promise<LLMResponse> => ({ text: 'normal reply', model: 'a' }),
      fetchModels: async (): Promise<ModelInfo[]> => [],
      healthCheck: async (): Promise<HealthCheckResult> => ({ ok: true, provider: 'openrouter', latencyMs: 1 }),
    };
    const factory: ProviderFactory = { create: () => provider } as unknown as ProviderFactory;
    const settings = new ProviderSettingsService(store, factory);
    const llm = new LLMService(factory, settings);
    const memoryTools = new MemoryToolsService(store, memory);
    const chat = new ChatService(new MemoryChatRepository(), llm, settings, () => 'ctx', new FakeClock(), null, memory, store, undefined, memoryTools);
    const s1 = chat.createSession();

    await chat.send(s1.id, 'Wo memory check karo');
    expect(store.get().memory.entries.some((e) => e.id === id)).toBe(true);

    // "haan batao kya delete hoga" is a QUESTION, not consent — the deletion
    // must not fire, and the pending action is dismissed for good.
    await chat.send(s1.id, 'Haan batao kya delete hoga?');
    expect(store.get().memory.entries.some((e) => e.id === id)).toBe(true);
    await chat.send(s1.id, 'Haan karo');
    expect(store.get().memory.entries.some((e) => e.id === id)).toBe(true);
  });

  it('defaults new sessions to the Misa persona and migrates the Divya default', async () => {
    const { chat } = buildService({});
    // Legacy Divya default persona upgrades to Misa on session creation.
    const migrated = chat.createSession('legacy', { ...defaultChatPrefs(), systemPrompt: LEGACY_DIVYA_SYSTEM_PROMPT, userPersona: '' });
    expect(migrated.prefs.systemPrompt).toBe(INTERNAL_SYSTEM_PROMPT);
    expect(migrated.prefs.systemPrompt).toContain('study partner');
    expect(migrated.prefs.systemPrompt).not.toContain('Divya');
    // A custom persona the user wrote themselves is never overwritten.
    const custom = chat.createSession('custom', { ...defaultChatPrefs(), systemPrompt: 'Meri custom strict coach personality', userPersona: '' });
    expect(custom.prefs.systemPrompt).toBe('Meri custom strict coach personality');
  });

  it('never demotes a user-written custom system prompt on legacy sessions without a user persona', () => {
    const { chat } = buildService({});
    // Old persisted sessions (pre-editable-persona format) carry only
    // systemPrompt. Their custom text is the user's own edit and must keep
    // driving the system persona — not get swallowed back to the default.
    const legacy = chat.createSession('old', {
      ...defaultChatPrefs(),
      systemPrompt: 'Tum ek AI app tester assistant ho jo admin features test karti hai',
      userPersona: undefined as unknown as string,
    });
    expect(legacy.prefs.systemPrompt).toBe('Tum ek AI app tester assistant ho jo admin features test karti hai');
    expect(legacy.prefs.userPersona).toBe('');
    expect(legacy.prefs.systemPrompt).not.toBe(INTERNAL_SYSTEM_PROMPT);
  });

  it('still upgrades the exact unedited legacy defaults on sessions without a user persona', () => {
    const { chat } = buildService({});
    const divya = chat.createSession('old-divya', {
      ...defaultChatPrefs(),
      systemPrompt: LEGACY_DIVYA_SYSTEM_PROMPT,
      userPersona: undefined as unknown as string,
    });
    expect(divya.prefs.systemPrompt).toBe(INTERNAL_SYSTEM_PROMPT);
    const misa = chat.createSession('old-misa', {
      ...defaultChatPrefs(),
      systemPrompt: LEGACY_MISA_SYSTEM_PROMPT,
      userPersona: undefined as unknown as string,
    });
    expect(misa.prefs.systemPrompt).toBe(INTERNAL_SYSTEM_PROMPT);
  });

  it('locks the Misa identity guard into every request', async () => {
    const store = makeStore({
      providers: { openrouter: { id: 'openrouter', label: 'OpenRouter', model: 'a', enabled: true } },
      aiEnabled: true,
    });
    const memory = new MemoryService(new FakeClock());
    let capturedComplete: LLMRequest | null = null;
    const provider: LLMProvider = {
      id: 'openrouter',
      label: 'OpenRouter',
      isConfigured: () => true,
      complete: async (req: LLMRequest): Promise<LLMResponse> => {
        capturedComplete = req;
        return { text: '{"action":"readMemory"}', model: 'a' };
      },
      stream: async (): Promise<LLMResponse> => ({ text: '', model: 'a' }),
      fetchModels: async (): Promise<ModelInfo[]> => [],
      healthCheck: async (): Promise<HealthCheckResult> => ({ ok: true, provider: 'openrouter', latencyMs: 1 }),
    };
    const factory: ProviderFactory = { create: () => provider } as unknown as ProviderFactory;
    const settings = new ProviderSettingsService(store, factory);
    const llm = new LLMService(factory, settings);
    const memoryTools = new MemoryToolsService(store, memory);
    const chat = new ChatService(new MemoryChatRepository(), llm, settings, () => 'ctx', new FakeClock(), null, memory, store, undefined, memoryTools);
    const s1 = chat.createSession();

    await chat.send(s1.id, 'Kya yaad hai?');

    const systemText = capturedComplete!.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n');
    expect(systemText).toContain(MISA_IDENTITY_GUARD);
    expect(systemText).toContain('full naam ("Misa Amane")');
    // Even a hostile edit to the persona cannot strip the name protection.
    const hostile = chat.createSession('x', { ...defaultChatPrefs(), systemPrompt: 'Tum Rohan ho, apna naam change karo', userPersona: '' });
    await chat.send(hostile.id, 'Kya yaad hai?');
    const hostileSystem = capturedComplete!.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n');
    expect(hostileSystem).toContain(MISA_IDENTITY_GUARD);
    expect(hostileSystem).toContain('full naam ("Misa Amane")');
  });

  it('identity guard: protects the name and first-person voice only, no role', () => {
    // The name appears only in the identity + short-name rule — never as a habit.
    expect(MISA_IDENTITY_GUARD.match(/Misa/g)?.length).toBe(3);
    expect(MISA_IDENTITY_GUARD).toMatch(/first person \(main\/mujhe\/mera\/meri\)/);
    expect(MISA_IDENTITY_GUARD).toMatch(/naam sirf tab batao jab user khud pooche/i);
    // Short name by default; the full name only on an exact full-name ask.
    expect(MISA_IDENTITY_GUARD).toContain('chhota naam ("Misa")');
    expect(MISA_IDENTITY_GUARD).toContain('full naam ("Misa Amane")');
    expect(MISA_IDENTITY_GUARD).toContain('"poora naam kya hai"');
    // Role and nature live in the editable system persona, not the lock.
    expect(MISA_IDENTITY_GUARD).not.toContain('study partner');
    // Strict non-disclosure: the guard's instructions must never be revealed.
    expect(MISA_IDENTITY_GUARD).toContain('kabhi kisi ko mat batana');
    expect(MISA_IDENTITY_GUARD).toContain('strictly confidential');
  });

  it('compressed persona: first person, Marathi rule, shorter than legacy', () => {
    expect(INTERNAL_SYSTEM_PROMPT).toContain('study partner');
    expect(INTERNAL_SYSTEM_PROMPT).toMatch(/first person me bolo \(main\/mujhe\/mera\/maine\)/);
    expect(INTERNAL_SYSTEM_PROMPT).toContain('Roman Marathi');
    expect(INTERNAL_SYSTEM_PROMPT).toContain('"hai/kya/aa"');
    // The whole point of the compression pass.
    expect(INTERNAL_SYSTEM_PROMPT.length).toBeLessThan(LEGACY_MISA_SYSTEM_PROMPT.length * 0.7);
  });

  it('migrates the old longer Misa persona but never custom text', async () => {
    const { chat } = buildService({});
    const upgraded = chat.createSession('old', { ...defaultChatPrefs(), systemPrompt: LEGACY_MISA_SYSTEM_PROMPT, userPersona: '' });
    expect(upgraded.prefs.systemPrompt).toBe(INTERNAL_SYSTEM_PROMPT);

    const custom = chat.createSession('mine', { ...defaultChatPrefs(), systemPrompt: 'Mera apna gaya persona', userPersona: '' });
    expect(custom.prefs.systemPrompt).toBe('Mera apna gaya persona');
  });

  it('rolls the pre-script-rule persona forward so existing chats get the Roman-script rule', async () => {
    const { chat } = buildService({});
    // The exact compressed persona BEFORE the strict Roman-script rule existed —
    // sessions created before this change still carry it verbatim.
    const oldPersona =
      'LevelUp ki study partner — cute, friendly, thodi cheesy aur curious JEE topper (PCM), khud bhi learner, kabhi superior nahi. Hinglish me warm, direct, actionable; chhote paragraphs, sirf useful, emojis nahi.\n\n' +
      'Har baat first person me bolo (main/mujhe/mera/maine); naam sirf jab user pooche. Formulas LaTeX me: inline \\(...\\), display \\[...\\]; kabhi code fence me nahi. Chat history + attachments use karo; hidden timestamps, verbatim repeat, reference-context numbers mat dohrao. Files ka extracted text padho; na dikhe to bolo aur .txt/.md export maango. Notes/PDF/formula sheets/images → clean downloadable Markdown. Tasks sirf tool actions se; tool confirm na ho to "kar diya"/"ho gaya" mat bolo; sirf maanga hua karo. Marathi me user bole to Roman Marathi me jawab do — Hindi ke "hai/kya/aa" jaise words kabhi mix mat karo (jab tak user khud na bole).';
    const upgraded = chat.createSession('old-script', { ...defaultChatPrefs(), systemPrompt: oldPersona, userPersona: '' });
    expect(upgraded.prefs.systemPrompt).toBe(INTERNAL_SYSTEM_PROMPT);

    // Custom personas are left untouched even if they mention the Marathi rule.
    const customText = 'Mera apna persona — sab kuch thoda different';
    const custom = chat.createSession('custom-script', { ...defaultChatPrefs(), systemPrompt: customText, userPersona: '' });
    expect(custom.prefs.systemPrompt).toBe(customText);
  });

  it('injects a user-added persona into the actual LLM system prompt', async () => {
    const store = makeStore({
      providers: { openrouter: { id: 'openrouter', label: 'OpenRouter', model: 'a', enabled: true } },
      aiEnabled: true,
    });
    let captured: LLMRequest | null = null;
    const provider: LLMProvider = {
      id: 'openrouter',
      label: 'OpenRouter',
      isConfigured: () => true,
      complete: async (): Promise<LLMResponse> => ({ text: '', model: 'a' }),
      stream: async (req: LLMRequest): Promise<LLMResponse> => {
        captured = req;
        return { text: 'ok', model: 'a' };
      },
      fetchModels: async (): Promise<ModelInfo[]> => [],
      healthCheck: async (): Promise<HealthCheckResult> => ({ ok: true, provider: 'openrouter', latencyMs: 1 }),
    };
    const factory: ProviderFactory = { create: () => provider } as unknown as ProviderFactory;
    const settings = new ProviderSettingsService(store, factory);
    const llm = new LLMService(factory, settings);
    const chat = new ChatService(new MemoryChatRepository(), llm, settings, () => 'ctx', new FakeClock(), null, null, store);

    const s = chat.createSession();
    // User adds a persona in settings -> global prefs -> this session's prefs.
    chat.applyGlobalPrefs({
      temperature: 0.7,
      maxTokens: 8192,
      systemPrompt: 'Meri custom strict coach personality',
      userPersona: 'Main raat 8 baje ke baad padhta hoon, shaam ki study prefer karta hoon',
      includeContext: true,
    });

    await chat.send(s.id, 'Aaj ka plan kya hai?');

    const systemText = captured!.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n');
    // Identity guard stays locked even with a custom persona...
    expect(systemText).toContain(MISA_IDENTITY_GUARD);
    // ...the edited system persona is honoured...
    expect(systemText).toContain('Meri custom strict coach personality');
    // ...and the user persona block reaches the model.
    expect(systemText).toContain('User persona / custom instructions:');
    expect(systemText).toContain('Main raat 8 baje ke baad padhta hoon');
  });

  it('keeps the user persona out of the system prompt when blank', async () => {
    let captured: LLMRequest | null = null;
    const provider: LLMProvider = {
      id: 'openrouter',
      label: 'OpenRouter',
      isConfigured: () => true,
      complete: async (): Promise<LLMResponse> => ({ text: '', model: 'a' }),
      stream: async (req: LLMRequest): Promise<LLMResponse> => {
        captured = req;
        return { text: 'ok', model: 'a' };
      },
      fetchModels: async (): Promise<ModelInfo[]> => [],
      healthCheck: async (): Promise<HealthCheckResult> => ({ ok: true, provider: 'openrouter', latencyMs: 1 }),
    };
    const factory: ProviderFactory = { create: () => provider } as unknown as ProviderFactory;
    const store = makeStore({
      providers: { openrouter: { id: 'openrouter', label: 'OpenRouter', model: 'a', enabled: true } },
      aiEnabled: true,
    });
    const settings = new ProviderSettingsService(store, factory);
    const llm = new LLMService(factory, settings);
    const chat = new ChatService(new MemoryChatRepository(), llm, settings, () => 'ctx', new FakeClock(), null, null, store);

    const s = chat.createSession();
    chat.applyGlobalPrefs({
      temperature: 0.7,
      maxTokens: 8192,
      systemPrompt: INTERNAL_SYSTEM_PROMPT,
      userPersona: '',
      includeContext: true,
    });

    await chat.send(s.id, 'Hi');

    const systemText = captured!.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n');
    expect(systemText).not.toContain('User persona / custom instructions:');
  });

  it('limits conversation history to the configured window', async () => {
    let captured: LLMRequest | null = null;
    const repo = new MemoryChatRepository();
    const store = makeStore({
      providers: { openrouter: { id: 'openrouter', label: 'OpenRouter', model: 'a', enabled: true } },
      aiEnabled: true,
      chat: { ...emptyAppState().aiSettings.chat, conversationHistoryLength: 2 },
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
    const chat = new ChatService(repo, llm, settings, () => 'ctx', new FakeClock(), null, null, store);
    const session = chat.createSession();
    await chat.send(session.id, 'pehla');
    await chat.send(session.id, 'doosra');
    await chat.send(session.id, 'teesra');
    const history = captured!.messages.filter((m) => m.role !== 'system');
    // Only the last two messages are sent (prev reply + current question).
    expect(history).toHaveLength(2);
    const joined = history.map((m) => String(m.content)).join('\n');
    expect(joined).toContain('teesra');
    expect(joined).not.toContain('pehla');
    expect(joined).not.toContain('doosra');
  });

  it('sends the full conversation when the history window is 0', async () => {
    let captured: LLMRequest | null = null;
    const repo = new MemoryChatRepository();
    const store = makeStore({
      providers: { openrouter: { id: 'openrouter', label: 'OpenRouter', model: 'a', enabled: true } },
      aiEnabled: true,
      chat: { ...emptyAppState().aiSettings.chat, conversationHistoryLength: 0 },
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
    const chat = new ChatService(repo, llm, settings, () => 'ctx', new FakeClock(), null, null, store);
    const session = chat.createSession();
    await chat.send(session.id, 'pehla');
    await chat.send(session.id, 'doosra');
    await chat.send(session.id, 'teesra');
    const history = captured!.messages.filter((m) => m.role !== 'system');
    // 0 window -> no trimming: ALL conversation messages go to the model
    // (u1, a1, u2, a2, current u3 = 5 non-system messages).
    expect(history).toHaveLength(5);
    const joined = history.map((m) => String(m.content)).join('\n');
    expect(joined).toContain('pehla');
    expect(joined).toContain('doosra');
    expect(joined).toContain('teesra');
  });

  it('keeps new chats ephemeral when auto-save chats is off', () => {
    const repo = new MemoryChatRepository();
    const store = makeStore({
      providers: { openrouter: { id: 'openrouter', label: 'OpenRouter', model: 'a', enabled: true } },
      aiEnabled: true,
      chat: { ...emptyAppState().aiSettings.chat, autoSaveChats: false },
    });
    const provider: LLMProvider = {
      id: 'openrouter',
      label: 'OpenRouter',
      isConfigured: () => true,
      complete: async (): Promise<LLMResponse> => ({ text: '', model: 'a' }),
      stream: async (): Promise<LLMResponse> => ({ text: 'hi', model: 'a' }),
      fetchModels: async (): Promise<ModelInfo[]> => [],
      healthCheck: async (): Promise<HealthCheckResult> => ({ ok: true, provider: 'openrouter', latencyMs: 1 }),
    };
    const factory: ProviderFactory = { create: () => provider } as unknown as ProviderFactory;
    const settings = new ProviderSettingsService(store, factory);
    const llm = new LLMService(factory, settings);
    const chat = new ChatService(repo, llm, settings, () => 'ctx', new FakeClock(), null, null, store);

    const s = chat.createSession();
    expect(chat.listSessions().map((x) => x.id)).toEqual([s.id]);
    // Nothing was written to the repository — a reload loses the session.
    expect(repo.load().sessions).toHaveLength(0);
  });

  it('lists ephemeral sessions newest first (insertion order reversed)', () => {
    const repo = new MemoryChatRepository();
    const store = makeStore({
      providers: { openrouter: { id: 'openrouter', label: 'OpenRouter', model: 'a', enabled: true } },
      aiEnabled: true,
      chat: { ...emptyAppState().aiSettings.chat, autoSaveChats: false },
    });
    const provider: LLMProvider = {
      id: 'openrouter',
      label: 'OpenRouter',
      isConfigured: () => true,
      complete: async (): Promise<LLMResponse> => ({ text: '', model: 'a' }),
      stream: async (): Promise<LLMResponse> => ({ text: 'hi', model: 'a' }),
      fetchModels: async (): Promise<ModelInfo[]> => [],
      healthCheck: async (): Promise<HealthCheckResult> => ({ ok: true, provider: 'openrouter', latencyMs: 1 }),
    };
    const factory: ProviderFactory = { create: () => provider } as unknown as ProviderFactory;
    const settings = new ProviderSettingsService(store, factory);
    const llm = new LLMService(factory, settings);
    const chat = new ChatService(repo, llm, settings, () => 'ctx', new FakeClock(), null, null, store);

    const a = chat.createSession('pehla');
    const b = chat.createSession('doosra');
    const c = chat.createSession('teesra');
    // Most recent ephemeral chat surfaces at the top, like persisted sessions.
    expect(chat.listSessions().map((x) => x.id)).toEqual([c.id, b.id, a.id]);
  });

  it('applies global thinking to existing sessions', () => {
    const { chat } = buildService({});
    const s = chat.createSession();
    chat.applyGlobalPrefs({
      temperature: 0.4,
      maxTokens: 4096,
      systemPrompt: 'sys',
      userPersona: 'persona',
      includeContext: false,
      thinking: 'high',
    });
    expect(chat.getSession(s.id)?.prefs.thinking).toBe('high');
    expect(chat.getSession(s.id)?.prefs.maxTokens).toBe(4096);
  });

  it('summarizes every unread chat into AI memory blocks in one pass', async () => {
    const repo = new MemoryChatRepository();
    const store = makeStore({
      providers: { openrouter: { id: 'openrouter', label: 'OpenRouter', model: 'a', enabled: true } },
      aiEnabled: true,
    });
    const provider: LLMProvider = {
      id: 'openrouter',
      label: 'OpenRouter',
      isConfigured: () => true,
      complete: async (): Promise<LLMResponse> => ({
        text: '{"blocks":[{"title":"Aim","lines":["Target IIT Delhi","Weak in Calculus"],"longTerm":true,"tags":["goal"]},{"lines":["Prefers evening study"],"longTerm":false,"tags":[]}]}',
        model: 'a',
      }),
      stream: async (): Promise<LLMResponse> => ({ text: 'done', model: 'a' }),
      fetchModels: async (): Promise<ModelInfo[]> => [],
      healthCheck: async (): Promise<HealthCheckResult> => ({ ok: true, provider: 'openrouter', latencyMs: 1 }),
    };
    const factory: ProviderFactory = { create: () => provider } as unknown as ProviderFactory;
    const settings = new ProviderSettingsService(store, factory);
    const llm = new LLMService(factory, settings);
    const memory = new MemoryService(new FakeClock());
    const chat = new ChatService(repo, llm, settings, () => 'ctx', new FakeClock(), null, memory, store);
    const s1 = chat.createSession();
    await chat.send(s1.id, 'Meri aim IIT Delhi hai, calculus weak hai');
    const s2 = chat.createSession();
    await chat.send(s2.id, 'mujhe shaam ko padhna achha lagta hai');

    const result = await chat.summarizeAllMemoryWithAi();
    expect(result).toEqual({ count: 2, blocks: 2, pinned: 1 });

    // Processed sessions are marked so they are never read again.
    expect(repo.load().sessions.find((s) => s.id === s1.id)?.memorySummarizedAt).toBeDefined();
    expect(repo.load().sessions.find((s) => s.id === s2.id)?.memorySummarizedAt).toBeDefined();

    // Each AI block landed as its own memory entry; the long-term one is pinned.
    const entries = store.get().memory.entries.filter((e) => e.type === 'conversation' && e.context.tags.includes('ai-summary'));
    expect(entries).toHaveLength(2);
    expect(entries.find((e) => e.longTerm)?.content).toContain('Target IIT Delhi');
    expect(entries.find((e) => e.longTerm)?.importance).toBe(0.9);

    // Re-running finds nothing to read — chats are not re-read.
    await expect(chat.summarizeAllMemoryWithAi()).resolves.toEqual({ count: 0, blocks: 0, pinned: 0 });
    expect(chat.pendingSummaries()).toBe(0);
  });

  it('excludes the currently running session from AI summarization', async () => {
    const repo = new MemoryChatRepository();
    const store = makeStore({
      providers: { openrouter: { id: 'openrouter', label: 'OpenRouter', model: 'a', enabled: true } },
      aiEnabled: true,
    });
    const provider: LLMProvider = {
      id: 'openrouter',
      label: 'OpenRouter',
      isConfigured: () => true,
      complete: async (): Promise<LLMResponse> => ({
        text: '{"blocks":[{"lines":["Keep this"],"longTerm":false,"tags":[]}]}',
        model: 'a',
      }),
      stream: async (): Promise<LLMResponse> => ({ text: 'done', model: 'a' }),
      fetchModels: async (): Promise<ModelInfo[]> => [],
      healthCheck: async (): Promise<HealthCheckResult> => ({ ok: true, provider: 'openrouter', latencyMs: 1 }),
    };
    const factory: ProviderFactory = { create: () => provider } as unknown as ProviderFactory;
    const settings = new ProviderSettingsService(store, factory);
    const llm = new LLMService(factory, settings);
    const memory = new MemoryService(new FakeClock());
    const chat = new ChatService(repo, llm, settings, () => 'ctx', new FakeClock(), null, memory, store);
    const running = chat.createSession();
    await chat.send(running.id, 'yeh chat abhi chal rahi hai');
    const finished = chat.createSession();
    await chat.send(finished.id, 'yeh purani chat hai');
    chat.setActiveSessionId(running.id);

    const result = await chat.summarizeAllMemoryWithAi();
    expect(result.count).toBe(1);
    // Only the finished chat was read & marked; the running one stays unread.
    expect(repo.load().sessions.find((s) => s.id === finished.id)?.memorySummarizedAt).toBeDefined();
    expect(repo.load().sessions.find((s) => s.id === running.id)?.memorySummarizedAt).toBeUndefined();
  });

  it('passes unread transcripts + 7-day prior memory + model override to the AI', async () => {
    const repo = new MemoryChatRepository();
    const store = makeStore({
      providers: { openrouter: { id: 'openrouter', label: 'OpenRouter', model: 'a', enabled: true } },
      aiEnabled: true,
    });
    // Seed prior memory (already-summarized context the AI must see).
    let state = store.get();
    const memory = new MemoryService(new FakeClock());
    state = memory.add(state, { type: 'goal', content: 'Purana goal: NIT trichy', source: 'user', importance: 0.9, createdAt: '2026-07-30' });
    store.save(state);

    let captured: LLMRequest | null = null;
    const provider: LLMProvider = {
      id: 'openrouter',
      label: 'OpenRouter',
      isConfigured: () => true,
      complete: async (req: LLMRequest): Promise<LLMResponse> => {
        captured = req;
        return { text: '{"blocks":[{"lines":["Naya point"],"longTerm":false,"tags":[]}]}', model: 'a' };
      },
      stream: async (): Promise<LLMResponse> => ({ text: 'done', model: 'a' }),
      fetchModels: async (): Promise<ModelInfo[]> => [],
      healthCheck: async (): Promise<HealthCheckResult> => ({ ok: true, provider: 'openrouter', latencyMs: 1 }),
    };
    const factory: ProviderFactory = { create: () => provider } as unknown as ProviderFactory;
    const settings = new ProviderSettingsService(store, factory);
    const llm = new LLMService(factory, settings);
    const chat = new ChatService(repo, llm, settings, () => 'ctx', new FakeClock(), null, memory, store);
    const s1 = chat.createSession();
    await chat.send(s1.id, 'abhi wali baat: physics theek hai');

    await chat.summarizeAllMemoryWithAi({ providerId: 'openrouter', model: 'gpt-4o-mini' });

    expect(captured).not.toBeNull();
    expect(captured!.model).toBe('gpt-4o-mini');
    const userText = String(captured!.messages.find((m) => m.role === 'user')?.content);
    expect(userText).toContain('physics theek hai');
    expect(userText).toContain('Purana goal');
    const systemText = String(captured!.messages.find((m) => m.role === 'system')?.content);
    expect(systemText).toContain('----');
    expect(systemText).toContain('8 lines');
  });

  it('throws when the AI returns no usable memory blocks', async () => {
    const repo = new MemoryChatRepository();
    const store = makeStore({
      providers: { openrouter: { id: 'openrouter', label: 'OpenRouter', model: 'a', enabled: true } },
      aiEnabled: true,
    });
    const provider: LLMProvider = {
      id: 'openrouter',
      label: 'OpenRouter',
      isConfigured: () => true,
      complete: async (): Promise<LLMResponse> => ({ text: 'sorry, kuch nahi mila', model: 'a' }),
      stream: async (): Promise<LLMResponse> => ({ text: 'done', model: 'a' }),
      fetchModels: async (): Promise<ModelInfo[]> => [],
      healthCheck: async (): Promise<HealthCheckResult> => ({ ok: true, provider: 'openrouter', latencyMs: 1 }),
    };
    const factory: ProviderFactory = { create: () => provider } as unknown as ProviderFactory;
    const settings = new ProviderSettingsService(store, factory);
    const llm = new LLMService(factory, settings);
    const memory = new MemoryService(new FakeClock());
    const chat = new ChatService(repo, llm, settings, () => 'ctx', new FakeClock(), null, memory, store);
    const s1 = chat.createSession();
    await chat.send(s1.id, 'koi baat');

    await expect(chat.summarizeAllMemoryWithAi()).rejects.toThrow();
    // Nothing was marked — a retry can still pick the chat up.
    expect(repo.load().sessions.find((s) => s.id === s1.id)?.memorySummarizedAt).toBeUndefined();
  });

  it('removes a deleted chat from memory too (transcript archive + AI blocks)', async () => {
    const { chat, store } = buildService({ withMemory: true, replies: ['reply'] });
    const s1 = chat.createSession('Integrals doubt');
    await chat.send(s1.id, 'Meri integral weak hai');

    // Deterministic raw-archive pass puts the chat into memory…
    await chat.summarizePriorChats();
    expect(
      store.get().memory.entries.some((e) => e.context.tags.includes(sessionMemoryTag(s1.id))),
    ).toBe(true);

    // …but deleting the chat removes its memory footprint — no lingering archive.
    chat.deleteSession(s1.id);
    expect(chat.listSessions().some((s) => s.id === s1.id)).toBe(false);
    expect(
      store.get().memory.entries.some((e) => e.context.tags.includes(sessionMemoryTag(s1.id))),
    ).toBe(false);
    expect(chat.listMemoryConversations().some((c) => c.sessionId === s1.id)).toBe(false);
  });

  it('removes AI-condensed blocks when their chat is deleted', async () => {
    const repo = new MemoryChatRepository();
    const store = makeStore({
      providers: { openrouter: { id: 'openrouter', label: 'OpenRouter', model: 'a', enabled: true } },
      aiEnabled: true,
    });
    const provider: LLMProvider = {
      id: 'openrouter',
      label: 'OpenRouter',
      isConfigured: () => true,
      complete: async (): Promise<LLMResponse> => ({
        text: '{"blocks":[{"title":"Aim","lines":["Target IIT Delhi"],"longTerm":true,"tags":["goal"]}]}',
        model: 'a',
      }),
      stream: async (): Promise<LLMResponse> => ({ text: 'done', model: 'a' }),
      fetchModels: async (): Promise<ModelInfo[]> => [],
      healthCheck: async (): Promise<HealthCheckResult> => ({ ok: true, provider: 'openrouter', latencyMs: 1 }),
    };
    const factory: ProviderFactory = { create: () => provider } as unknown as ProviderFactory;
    const settings = new ProviderSettingsService(store, factory);
    const llm = new LLMService(factory, settings);
    const memory = new MemoryService(new FakeClock());
    const chat = new ChatService(repo, llm, settings, () => 'ctx', new FakeClock(), null, memory, store);
    const s1 = chat.createSession();
    await chat.send(s1.id, 'mujhe IIT chahiye');
    await chat.summarizeAllMemoryWithAi();
    expect(store.get().memory.entries.some((e) => e.context.tags.includes('ai-summary'))).toBe(true);

    // Delete the live session → its AI block is cleaned out of memory too.
    chat.deleteSession(s1.id);
    expect(
      store.get().memory.entries.some((e) => e.context.tags.includes(sessionMemoryTag(s1.id))),
    ).toBe(false);
    expect(chat.listMemoryConversations().some((c) => c.sessionId === s1.id)).toBe(false);
  });

  it('reconstructs AI-condensed conversations when no full transcript exists', () => {
    const { chat, store } = buildService({ withMemory: true });
    const memory = new MemoryService(new FakeClock());
    const ghostId = 'ghost-session';
    let state = store.get();
    state = memory.add(state, {
      type: 'conversation',
      source: 'ai',
      summarized: true,
      tags: ['chat', 'ai-summary', sessionMemoryTag(ghostId)],
      content: '[Physics]\nRotation weak hai',
      createdAt: '2026-07-30',
    });
    store.save(state);

    const conversations = chat.listMemoryConversations();
    const archived = conversations.find((c) => c.sessionId === ghostId);
    expect(archived).toBeDefined();
    expect(archived?.source).toBe('ai-summary');
    expect(archived?.title).toBe('Physics');
    expect(archived?.messages.some((m) => m.content.includes('Rotation weak hai'))).toBe(true);
  });

  it('drops the raw transcript archive once AI-condensed blocks exist', async () => {
    const repo = new MemoryChatRepository();
    const store = makeStore({
      providers: { openrouter: { id: 'openrouter', label: 'OpenRouter', model: 'a', enabled: true } },
      aiEnabled: true,
    });
    const provider: LLMProvider = {
      id: 'openrouter',
      label: 'OpenRouter',
      isConfigured: () => true,
      complete: async (): Promise<LLMResponse> => ({
        text: '{"blocks":[{"lines":["Goal IIT"],"longTerm":true,"tags":["goal"]}]}',
        model: 'a',
      }),
      stream: async (): Promise<LLMResponse> => ({ text: 'done', model: 'a' }),
      fetchModels: async (): Promise<ModelInfo[]> => [],
      healthCheck: async (): Promise<HealthCheckResult> => ({ ok: true, provider: 'openrouter', latencyMs: 1 }),
    };
    const factory: ProviderFactory = { create: () => provider } as unknown as ProviderFactory;
    const settings = new ProviderSettingsService(store, factory);
    const llm = new LLMService(factory, settings);
    const memory = new MemoryService(new FakeClock());
    const chat = new ChatService(repo, llm, settings, () => 'ctx', new FakeClock(), null, memory, store);
    const s1 = chat.createSession();
    await chat.send(s1.id, 'mujhe IIT chahiye');

    // Seed a raw transcript archive first (as if a prior deterministic dump ran).
    await chat.summarizePriorChats();
    expect(
      store.get().memory.entries.some(
        (e) => e.context.tags.includes('transcript') && e.context.tags.includes(sessionMemoryTag(s1.id)),
      ),
    ).toBe(true);

    // AI pass condenses the chat and removes the now-redundant raw archive.
    await chat.summarizeAllMemoryWithAi();

    const tags = store.get().memory.entries.map((e) => e.context.tags);
    expect(tags.some((t) => t.includes('transcript') && t.includes(sessionMemoryTag(s1.id)))).toBe(false);
    expect(tags.some((t) => t.includes('ai-summary') && t.includes(sessionMemoryTag(s1.id)))).toBe(true);
    const live = repo.load().sessions.find((s) => s.id === s1.id);
    expect(live?.memorySummarizedAt).toBeDefined();
    expect(live?.aiSummarizedAt).toBeDefined();
    // Pending counts are driven by the AI marker, not the archive marker.
    expect(chat.pendingSummaries()).toBe(0);
    expect(chat.pendingRawDumps()).toBe(0);
  });

  it('demotes longTerm blocks that carry no durable fact', async () => {
    const repo = new MemoryChatRepository();
    const store = makeStore({
      providers: { openrouter: { id: 'openrouter', label: 'OpenRouter', model: 'a', enabled: true } },
      aiEnabled: true,
    });
    const provider: LLMProvider = {
      id: 'openrouter',
      label: 'OpenRouter',
      isConfigured: () => true,
      complete: async (): Promise<LLMResponse> => ({
        // Model marks EVERYTHING longTerm — including a generic chatty block.
        text: '{"blocks":[{"title":"Goal","lines":["Target IIT Delhi"],"longTerm":true,"tags":["goal"]},{"title":"Chat","lines":["Mausam acha tha, masti kari"],"longTerm":true,"tags":[]}]}',
        model: 'a',
      }),
      stream: async (): Promise<LLMResponse> => ({ text: 'done', model: 'a' }),
      fetchModels: async (): Promise<ModelInfo[]> => [],
      healthCheck: async (): Promise<HealthCheckResult> => ({ ok: true, provider: 'openrouter', latencyMs: 1 }),
    };
    const factory: ProviderFactory = { create: () => provider } as unknown as ProviderFactory;
    const settings = new ProviderSettingsService(store, factory);
    const llm = new LLMService(factory, settings);
    const memory = new MemoryService(new FakeClock());
    const chat = new ChatService(repo, llm, settings, () => 'ctx', new FakeClock(), null, memory, store);
    const s1 = chat.createSession();
    await chat.send(s1.id, 'mujhe IIT chahiye');

    const result = await chat.summarizeAllMemoryWithAi();
    // Only the durable goal block stays pinned; the chatty one is demoted.
    expect(result.pinned).toBe(1);

    const entries = store.get().memory.entries.filter((e) => e.context.tags.includes('ai-summary'));
    expect(entries).toHaveLength(2);
    const goal = entries.find((e) => e.content.includes('Target IIT Delhi'));
    expect(goal?.longTerm).toBe(true);
    expect(goal?.importance).toBe(0.9);
    const chatty = entries.find((e) => e.content.includes('Mausam'));
    expect(chatty?.longTerm).toBe(false);
    expect(chatty?.importance).toBe(0.55);
  });

  it('dedups concurrent AI summary runs into a single pass (race guard)', async () => {
    const repo = new MemoryChatRepository();
    const store = makeStore({
      providers: { openrouter: { id: 'openrouter', label: 'OpenRouter', model: 'a', enabled: true } },
      aiEnabled: true,
    });
    let calls = 0;
    const provider: LLMProvider = {
      id: 'openrouter',
      label: 'OpenRouter',
      isConfigured: () => true,
      complete: async (): Promise<LLMResponse> => {
        calls += 1;
        return { text: '{"blocks":[{"lines":["Keep this"],"longTerm":false,"tags":[]}]}', model: 'a' };
      },
      stream: async (): Promise<LLMResponse> => ({ text: 'done', model: 'a' }),
      fetchModels: async (): Promise<ModelInfo[]> => [],
      healthCheck: async (): Promise<HealthCheckResult> => ({ ok: true, provider: 'openrouter', latencyMs: 1 }),
    };
    const factory: ProviderFactory = { create: () => provider } as unknown as ProviderFactory;
    const settings = new ProviderSettingsService(store, factory);
    const llm = new LLMService(factory, settings);
    const memory = new MemoryService(new FakeClock());
    const chat = new ChatService(repo, llm, settings, () => 'ctx', new FakeClock(), null, memory, store);
    const s1 = chat.createSession();
    await chat.send(s1.id, 'pehli chat');
    const s2 = chat.createSession();
    await chat.send(s2.id, 'dusri chat');

    // Two rapid taps fire before either finishes — both must share ONE AI pass.
    const [a, b] = await Promise.all([chat.summarizeAllMemoryWithAi(), chat.summarizeAllMemoryWithAi()]);
    expect(a).toEqual({ count: 2, blocks: 1, pinned: 0 });
    expect(b).toEqual(a);
    expect(calls).toBe(1);
    // Only one copy of the block landed.
    const entries = store.get().memory.entries.filter((e) => e.context.tags.includes('ai-summary'));
    expect(entries).toHaveLength(1);
  });

  it('chunks large unread sets so each AI request stays small', async () => {
    const repo = new MemoryChatRepository();
    const store = makeStore({
      providers: { openrouter: { id: 'openrouter', label: 'OpenRouter', model: 'a', enabled: true } },
      aiEnabled: true,
    });
    let calls = 0;
    const provider: LLMProvider = {
      id: 'openrouter',
      label: 'OpenRouter',
      isConfigured: () => true,
      complete: async (): Promise<LLMResponse> => {
        calls += 1;
        return { text: '{"blocks":[{"lines":["point"],"longTerm":false,"tags":[]}]}', model: 'a' };
      },
      stream: async (): Promise<LLMResponse> => ({ text: 'done', model: 'a' }),
      fetchModels: async (): Promise<ModelInfo[]> => [],
      healthCheck: async (): Promise<HealthCheckResult> => ({ ok: true, provider: 'openrouter', latencyMs: 1 }),
    };
    const factory: ProviderFactory = { create: () => provider } as unknown as ProviderFactory;
    const settings = new ProviderSettingsService(store, factory);
    const llm = new LLMService(factory, settings);
    const memory = new MemoryService(new FakeClock());
    const chat = new ChatService(repo, llm, settings, () => 'ctx', new FakeClock(), null, memory, store);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const s = chat.createSession();
      await chat.send(s.id, `chat number ${i}`);
      ids.push(s.id);
    }

    const result = await chat.summarizeAllMemoryWithAi();
    // 5 chats → chunks of 4 + 1 → two AI requests (one block each), all marked.
    expect(calls).toBe(2);
    expect(result).toEqual({ count: 5, blocks: 2, pinned: 0 });
    // All sessions are still marked so nothing is re-read later.
    expect(chat.pendingSummaries()).toBe(0);
    for (const id of ids) {
      expect(repo.load().sessions.find((s) => s.id === id)?.aiSummarizedAt).toBeDefined();
    }
  });

  describe('two-step web search', () => {
    function makeRecordingProvider(): { provider: LLMProvider; lastRequest: () => LLMRequest | null } {
      let last: LLMRequest | null = null;
      const provider: LLMProvider = {
        id: 'openrouter',
        label: 'OpenRouter',
        isConfigured: () => true,
        complete: async (): Promise<LLMResponse> => ({ text: '', model: 'a' }),
        stream: async (req: LLMRequest): Promise<LLMResponse> => {
          last = req;
          const text = 'answer';
          if (req.onDelta) for (const ch of text) req.onDelta(ch);
          return { text, model: 'a' };
        },
        fetchModels: async (): Promise<ModelInfo[]> => [],
        healthCheck: async (): Promise<HealthCheckResult> => ({ ok: true, provider: 'openrouter', latencyMs: 1 }),
      };
      return { provider, lastRequest: () => last };
    }

    function makeWs(result: WebSearchResult): { service: WebSearchService; calls: () => number; lastCtx: () => WebSearchContext | null } {
      let n = 0;
      let ctx: WebSearchContext | null = null;
      const service = {
        search: async (c: WebSearchContext): Promise<WebSearchResult> => {
          ctx = c;
          n += 1;
          return result;
        },
      } as unknown as WebSearchService;
      return { service, calls: () => n, lastCtx: () => ctx };
    }

    function buildChat(store: StateStore, ws: { service: WebSearchService; calls: () => number }) {
      const repo = new MemoryChatRepository();
      const { provider, lastRequest } = makeRecordingProvider();
      const factory: ProviderFactory = { create: () => provider } as unknown as ProviderFactory;
      const settings = new ProviderSettingsService(store, factory);
      const llm = new LLMService(factory, settings);
      const chat = new ChatService(
        repo,
        llm,
        settings,
        () => 'ctx',
        new FakeClock(),
        null,
        null,
        store,
        undefined,
        null,
        ws.service,
        () => ({ serverUrl: 'https://smartrotator.onrender.com', apiKey: 'sk-test' }),
      );
      return { chat, lastRequest };
    }

    it('fresh session key wins over a stale key saved in websearch settings', async () => {
      // Regression: typing in the SmartRotator key field used to persist an old
      // apiKey into settings, which shadowed the current login key → 401 while
      // chat itself kept working (chat uses configureServerAuth).
      const store = makeStore({
        providers: { openrouter: { id: 'openrouter', label: 'OpenRouter', model: 'a', enabled: true } },
        aiEnabled: true,
        websearch: { enabled: true, providerId: 'smartrotator', model: '', apiKey: 'sk-stale', baseUrl: '' },
      });
      const ws = makeWs({ ok: true, text: 'NEET 2026 results 15 June ko aaye.' });
      const { chat } = buildChat(store, ws);
      const s = chat.createSession('q');
      await chat.send(s.id, 'results kab aaye?', undefined, undefined, undefined, undefined, undefined, ['websearch']);
      expect(ws.calls()).toBe(1);
      // The backend must be called with the live session key, never the stale one.
      expect(ws.lastCtx()?.apiKey).toBe('sk-test');
    });

    it('injects live search results into the chat request when @websearch is pinned', async () => {
      const store = makeStore({
        providers: { openrouter: { id: 'openrouter', label: 'OpenRouter', model: 'a', enabled: true } },
        aiEnabled: true,
        websearch: { enabled: true, providerId: 'smartrotator', model: '', apiKey: '', baseUrl: '' },
      });
      const ws = makeWs({ ok: true, text: 'NEET 2026 results 15 June ko aaye.' });
      const { chat, lastRequest } = buildChat(store, ws);
      const s = chat.createSession('q');
      const result = await chat.send(s.id, 'results kab aaye?', undefined, undefined, undefined, undefined, undefined, ['websearch']);
      expect(ws.calls()).toBe(1);
      const req = lastRequest();
      expect(req).not.toBeNull();
      const system = req!.messages[0].content as string;
      expect(system).toContain('Live web search results');
      expect(system).toContain('NEET 2026');
      // Two-step already grounded the answer — no native adapter grounding on top.
      expect(req!.websearch).toBeFalsy();
      // The reply carries the search as a normal tool-use bubble record.
      expect(result.tool).toBe('websearch');
      expect(result.toolCalls).toEqual([{ action: 'websearch', ok: true, message: 'NEET 2026 results 15 June ko aaye.' }]);
    });

    it('auto mode attaches the search tool (model decides) without running the two-step backend', async () => {
      const store = makeStore({
        providers: { openrouter: { id: 'openrouter', label: 'OpenRouter', model: 'a', enabled: true } },
        aiEnabled: true,
        websearch: { enabled: true, providerId: 'smartrotator', model: '', apiKey: '', baseUrl: '' },
      });
      const ws = makeWs({ ok: true, text: 'NEET 2026 results 15 June ko aaye.' });
      const { chat, lastRequest } = buildChat(store, ws);
      const s = chat.createSession('q');
      // No @websearch pin — the two-step backend must NOT run on its own…
      const result = await chat.send(s.id, 'results kab aaye?');
      expect(ws.calls()).toBe(0);
      expect(result.tool).toBeUndefined();
      // …but the adapter's search tool IS attached: the model decides when to
      // search, exactly like the other tools.
      const req = lastRequest();
      expect(req).not.toBeNull();
      expect(req!.websearch).toBe(true);
      const system = req!.messages[0].content as string;
      expect(system).not.toContain('Live web search results');
    });

    it('skips injection when the pinned search returns nothing usable', async () => {
      const store = makeStore({
        providers: { openrouter: { id: 'openrouter', label: 'OpenRouter', model: 'a', enabled: true } },
        aiEnabled: true,
        websearch: { enabled: true, providerId: 'smartrotator', model: '', apiKey: '', baseUrl: '' },
      });
      const ws = makeWs({ ok: false, text: '', error: 'endpoint rejected web_search tool' });
      const { chat, lastRequest } = buildChat(store, ws);
      const s = chat.createSession('q');
      const result = await chat.send(s.id, 'results kab aaye?', undefined, undefined, undefined, undefined, undefined, ['websearch']);
      expect(ws.calls()).toBe(1);
      const req = lastRequest();
      const system = req!.messages[0].content as string;
      expect(system).not.toContain('Live web search results');
      // Failed search is still surfaced as a tool bubble (same as other tools).
      expect(result.tool).toBe('websearch');
      expect(result.toolCalls?.[0].ok).toBe(false);
    });

    it('does not search when no tool is pinned (default state)', async () => {
      const store = makeStore({
        providers: { openrouter: { id: 'openrouter', label: 'OpenRouter', model: 'a', enabled: true } },
        aiEnabled: true,
      });
      const ws = makeWs({ ok: true, text: 'kuch' });
      const { chat, lastRequest } = buildChat(store, ws);
      const s = chat.createSession('q');
      await chat.send(s.id, 'hello');
      expect(ws.calls()).toBe(0);
      const req = lastRequest();
      const system = req!.messages[0].content as string;
      expect(system).not.toContain('Live web search results');
    });

    it('pinned @websearch runs the search when the backend switch is on', async () => {
      const store = makeStore({
        providers: { openrouter: { id: 'openrouter', label: 'OpenRouter', model: 'a', enabled: true } },
        aiEnabled: true,
        websearch: { enabled: true, providerId: 'smartrotator', model: '', apiKey: '', baseUrl: '' },
      });
      const ws = makeWs({ ok: true, text: 'OpenAI ka naya model kal launch hua.' });
      const { chat, lastRequest } = buildChat(store, ws);
      const s = chat.createSession('q');
      const result = await chat.send(s.id, 'OpenAI kya naya aaya?', undefined, undefined, undefined, undefined, undefined, ['websearch']);
      expect(ws.calls()).toBe(1);
      expect(result.tool).toBe('websearch');
      expect(result.toolCalls).toEqual([{ action: 'websearch', ok: true, message: 'OpenAI ka naya model kal launch hua.' }]);
      const req = lastRequest();
      const system = req!.messages[0].content as string;
      expect(system).toContain('Live web search results');
      // Two-step grounded — no native adapter grounding on top.
      expect(req!.websearch).toBeFalsy();
    });

    it('pinned @websearch stays silent when the backend switch is off', async () => {
      const store = makeStore({
        providers: { openrouter: { id: 'openrouter', label: 'OpenRouter', model: 'a', enabled: true } },
        aiEnabled: true,
        websearch: { enabled: false, providerId: 'smartrotator', model: '', apiKey: '', baseUrl: '' },
      });
      const ws = makeWs({ ok: true, text: 'OpenAI ka naya model kal launch hua.' });
      const { chat } = buildChat(store, ws);
      const s = chat.createSession('q');
      const result = await chat.send(s.id, 'OpenAI kya naya aaya?', undefined, undefined, undefined, undefined, undefined, ['websearch']);
      expect(ws.calls()).toBe(0);
      // No backend search ran — the reply goes out normally (native grounding
      // may still attach for capable providers, that's the adapter's choice).
      expect(result.tool).toBeUndefined();
    });

    it('never leaks raw tool JSON from the decision hop — routes to the web search path', async () => {
      const store = makeStore({
        providers: { openrouter: { id: 'openrouter', label: 'OpenRouter', model: 'a', enabled: true } },
        aiEnabled: true,
        websearch: { enabled: true, providerId: 'smartrotator', model: '', apiKey: '', baseUrl: '' },
      });
      const repo = new MemoryChatRepository();
      let last: LLMRequest | null = null;
      let searchCalls = 0;
      const provider: LLMProvider = {
        id: 'openrouter',
        label: 'OpenRouter',
        isConfigured: () => true,
        // The decision hop keeps inventing a websearch action that is NOT a
        // valid plan/task JSON tool — this used to leak the raw JSON as the reply.
        complete: async (): Promise<LLMResponse> => ({
          text: '{"action":"websearch","query":"OpenAI new model announcement yesterday"}',
          model: 'a',
        }),
        stream: async (req: LLMRequest): Promise<LLMResponse> => {
          last = req;
          const text = 'OpenAI ne kal naya model announce kiya.';
          if (req.onDelta) for (const ch of text) req.onDelta(ch);
          return { text, model: 'a' };
        },
        fetchModels: async (): Promise<ModelInfo[]> => [],
        healthCheck: async (): Promise<HealthCheckResult> => ({ ok: true, provider: 'openrouter', latencyMs: 1 }),
      };
      const factory: ProviderFactory = { create: () => provider } as unknown as ProviderFactory;
      const settings = new ProviderSettingsService(store, factory);
      const llm = new LLMService(factory, settings);
      const tools = {
        isTaskQuery: () => true,
        isPlannerQueryOnly: () => false,
        hasPlannerData: () => false,
        plannerActionFor: () => null,
        contextActionFor: () => null,
        parseTools: () => [],
        resolveToolScope: () => [],
      } as unknown as ChatToolsService;
      const ws = {
        search: async (): Promise<WebSearchResult> => {
          searchCalls += 1;
          return { ok: true, text: 'OpenAI ka naya model kal launch hua — abhi preview me.' };
        },
      } as unknown as WebSearchService;
      const chat = new ChatService(
        repo,
        llm,
        settings,
        () => 'ctx',
        new FakeClock(),
        tools,
        null,
        store,
        undefined,
        null,
        ws,
        () => ({ serverUrl: 'https://smartrotator.onrender.com', apiKey: 'sk-test' }),
      );
      const s = chat.createSession('q');
      const result = await chat.send(s.id, 'OpenAI new model announcement yesterday', undefined, undefined, undefined, undefined, undefined, ['websearch']);
      // No raw JSON in the reply.
      expect(result.content).not.toContain('{"action"');
      // The question reached the default streaming path instead of shorting out.
      expect(result.content).toContain('naya model');
      // And the real two-step web search actually ran — surfaced as a bubble.
      expect(searchCalls).toBe(1);
      expect(result.tool).toBe('websearch');
      expect(result.toolCalls?.[0].ok).toBe(true);
      const req: LLMRequest | null = last;
      expect(req).not.toBeNull();
      expect(req!.messages[0].content as string).toContain('Live web search results');
      expect(req!.messages[0].content as string).toContain('OpenAI ka naya model');
    });

    it('falls back to the hidden gateway default when no sync login session exists (mobile app case)', async () => {
      vi.stubEnv('VITE_DEFAULT_AI_BASE_URL', 'https://smartrotator.onrender.com/v1');
      vi.stubEnv('VITE_DEFAULT_AI_API_KEY', 'sk-gateway');
      vi.stubEnv('VITE_DEFAULT_AI_MODEL', 'internal-gateway-model');
      let last: LLMRequest | null = null;
      const provider: LLMProvider = {
        id: 'openrouter',
        label: 'OpenRouter',
        isConfigured: () => true,
        complete: async (): Promise<LLMResponse> => ({ text: '', model: 'a' }),
        stream: async (req: LLMRequest): Promise<LLMResponse> => {
          last = req;
          const text = 'answer';
          if (req.onDelta) for (const ch of text) req.onDelta(ch);
          return { text, model: 'a' };
        },
        fetchModels: async (): Promise<ModelInfo[]> => [],
        healthCheck: async (): Promise<HealthCheckResult> => ({ ok: true, provider: 'openrouter', latencyMs: 1 }),
      };
      const store = makeStore({
        providers: { openrouter: { id: 'openrouter', label: 'OpenRouter', model: 'a', enabled: true } },
        aiEnabled: true,
        websearch: { enabled: true, providerId: 'smartrotator', model: '', apiKey: '', baseUrl: '' },
      });
      const repo = new MemoryChatRepository();
      const factory: ProviderFactory = { create: () => provider } as unknown as ProviderFactory;
      const settings = new ProviderSettingsService(store, factory);
      const llm = new LLMService(factory, settings);
      let n = 0;
      const ws = {
        search: async (): Promise<WebSearchResult> => {
          n += 1;
          return { ok: true, text: 'NEET 2026 results 15 June ko aaye.' };
        },
      } as unknown as WebSearchService;
      // No auth session — exactly what an app user without a sync login hits.
      const chat = new ChatService(repo, llm, settings, () => 'ctx', new FakeClock(), null, null, store, undefined, null, ws, () => null);
      const s = chat.createSession('q');
      const result = await chat.send(s.id, 'results kab aaye?', undefined, undefined, undefined, undefined, undefined, ['websearch']);
      expect(n).toBe(1);
      expect(result.tool).toBe('websearch');
      expect(result.toolCalls?.[0].ok).toBe(true);
      const req: LLMRequest | null = last;
      expect(req).not.toBeNull();
      expect(req!.messages[0].content as string).toContain('Live web search results');
      expect(req!.messages[0].content as string).toContain('NEET 2026');
    });
  });

  // Regression: once a planner is uploaded, a message that mixes a
  // task-management request with a planner question ("day 3 mein task add
  // karo aur physics planner check karo") must NOT get scoped down to
  // planner-only tools -- that scope explicitly forbids task tools, so the
  // task half of the request would be silently dropped. Before any planner
  // exists the narrow planner-only prompt is still correct (per
  // isPlannerQueryOnly's own contract), since the merged prompt wouldn't
  // otherwise mention planners at all pre-upload.
  describe('mixed task + planner requests (no "@" pinning)', () => {
    function toolsMock(overrides: Partial<ChatToolsService>): ChatToolsService {
      return {
        isTaskQuery: () => true,
        isPlannerQueryOnly: () => true,
        plannerActionFor: () => null,
        contextActionFor: () => null,
        // Parses whatever JSON the mock provider actually returned, so the
        // test verifies which PROMPT the model was given (full vs narrow) via
        // which actions it was able to emit — not a hardcoded stub action.
        parseTools: (text: string) => {
          const start = text.indexOf('{');
          const end = text.lastIndexOf('}');
          if (start === -1 || end <= start) return [];
          try {
            const parsed = JSON.parse(text.slice(start, end + 1));
            if (Array.isArray(parsed?.actions)) return parsed.actions;
            if (parsed?.action) return [parsed];
          } catch {
            /* fall through */
          }
          return [];
        },
        resolveToolScope: () => [],
        // Matches the real ChatToolsService's default: nothing to diagnose
        // unless a test overrides it to check the retry-framing path.
        describeParseFailure: () => null,
        runMany: async (actions: { action: string }[]) => ({ ok: true, summary: 'done', results: actions.map((a) => ({ action: a.action, ok: true, summary: 'ok' })) }),
        ...overrides,
      } as unknown as ChatToolsService;
    }

    it('uses the FULL tool prompt (task + planner) once a planner has been imported', async () => {
      const store = makeStore({ providers: { openrouter: { id: 'openrouter', label: 'OpenRouter', model: 'a', enabled: true } }, aiEnabled: true });
      const repo = new MemoryChatRepository();
      let seenSystem = '';
      const provider: LLMProvider = {
        id: 'openrouter',
        label: 'OpenRouter',
        isConfigured: () => true,
        complete: async (req: LLMRequest): Promise<LLMResponse> => {
          seenSystem = (req.messages.find((m) => m.role === 'system')?.content as string) ?? '';
          return { text: '{"actions":[{"action":"addTask","day":3,"intent":"physics revision","durationMin":30},{"action":"getSubject","subject":"Physics"}]}', model: 'a' };
        },
        stream: async (req: LLMRequest): Promise<LLMResponse> => {
          req.onDelta?.('Done!');
          return { text: 'Done!', model: 'a' };
        },
        fetchModels: async (): Promise<ModelInfo[]> => [],
        healthCheck: async (): Promise<HealthCheckResult> => ({ ok: true, provider: 'openrouter', latencyMs: 1 }),
      };
      const factory: ProviderFactory = { create: () => provider } as unknown as ProviderFactory;
      const settings = new ProviderSettingsService(store, factory);
      const llm = new LLMService(factory, settings);
      const tools = toolsMock({ hasPlannerData: () => true });
      const chat = new ChatService(repo, llm, settings, () => 'ctx', new FakeClock(), tools, null, store);
      const s = chat.createSession('q');
      const result = await chat.send(s.id, 'day 3 mein ek revision task add karo aur physics planner check karo');
      expect(seenSystem).toContain('"action":"addTask"');
      expect(seenSystem).toContain('getSubject');
      expect(result.tool).toContain('addTask');
      expect(result.tool).toContain('getSubject');
    });

    it('keeps the NARROW planner-only prompt when no planner has been imported yet', async () => {
      const store = makeStore({ providers: { openrouter: { id: 'openrouter', label: 'OpenRouter', model: 'a', enabled: true } }, aiEnabled: true });
      const repo = new MemoryChatRepository();
      let seenSystem = '';
      const provider: LLMProvider = {
        id: 'openrouter',
        label: 'OpenRouter',
        isConfigured: () => true,
        complete: async (req: LLMRequest): Promise<LLMResponse> => {
          seenSystem = (req.messages.find((m) => m.role === 'system')?.content as string) ?? '';
          return { text: 'Abhi tak koi planner upload nahi hua.', model: 'a' };
        },
        stream: async (req: LLMRequest): Promise<LLMResponse> => {
          req.onDelta?.('x');
          return { text: 'x', model: 'a' };
        },
        fetchModels: async (): Promise<ModelInfo[]> => [],
        healthCheck: async (): Promise<HealthCheckResult> => ({ ok: true, provider: 'openrouter', latencyMs: 1 }),
      };
      const factory: ProviderFactory = { create: () => provider } as unknown as ProviderFactory;
      const settings = new ProviderSettingsService(store, factory);
      const llm = new LLMService(factory, settings);
      const tools = toolsMock({ hasPlannerData: () => false });
      const chat = new ChatService(repo, llm, settings, () => 'ctx', new FakeClock(), tools, null, store);
      const s = chat.createSession('q');
      await chat.send(s.id, 'physics planner check karo');
      expect(seenSystem).not.toContain('"action":"addTask"');
      expect(seenSystem).toContain('uploaded coaching planners');
    });
  });
});
