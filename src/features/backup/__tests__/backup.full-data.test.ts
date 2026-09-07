// PRODUCTION-GRADE, full-app-data backup test.
//
// This is the "sab kuch export/import hota hai" proof: it builds a state that
// touches EVERY user-modifiable section of the app — journey, task logs,
// reviews, memory, summaries, AI providers + model cache, the phase task bank
// (dynamic tasks across all phases), every cached daily plan/block, the
// undoable AI action history, the post-journey system, user profile, timezone
// — and verifies a backup round-trip is LOSSLESS (deep equality), including a
// real-repository restore that proves the static seed bank + habits survive.

import { describe, it, expect } from 'vitest';
import { emptyAppState, STATE_SCHEMA_VERSION, type AppState, type ChatSettings } from '../../../core/domain/state';
import { defaultChatPrefs, type ChatSession, type ChatStoreState } from '../../../core/domain/chat';
import type { TaskBankEntry, PhaseId, TaskType } from '../../../core/domain/task-bank';
import type { DailyPlan } from '../../../core/domain/progress';
import type { DailySummary } from '../../../core/domain/summary';
import { CachedStateStore, LocalStateRepository, normalizeState } from '../../../infra/storage/state-repository';
import { TaskBankRepositoryImpl, buildSeed } from '../../task-bank/task-bank.repository';
import type { StateStore } from '../../../core/ports/repositories';
import { applyBackup, buildBackupPayload, parseBackup, serializeBackup } from '../backup.service';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function buildTask(id: string, phase: PhaseId, title: string, taskType: TaskType): TaskBankEntry {
  return {
    id,
    habitId: `habit-${phase}`,
    title,
    description: `Description for ${title}`,
    phase,
    difficulty: 2,
    estimatedDurationMin: 45,
    energyLevel: 'medium',
    tags: ['fixture'],
    prerequisites: [],
    taskType,
    revisionSuitability: 0.5,
    backlogSuitability: 0.6,
    thinkingSkills: ['focus'],
    jeeRelevance: { subject: 'physics', score: 0.8 },
    unlockConditions: [{ type: 'day', fromDay: 1 }],
    active: true,
  };
}

function buildPlan(dateISO: string, dayNumber: number, phase: PhaseId): DailyPlan {
  return {
    dateISO,
    dayNumber,
    tasks: [
      {
        entry: buildTask('dyn-jee', phase, 'Planned block', 'Review'),
        source: 'bank',
        reason: 'fixture block',
        slot: 'morning',
        group: 'morning',
        required: true,
        score: 0.9,
        logKey: `bank:${dateISO}:dyn-jee`,
      },
    ],
    generatedAt: `${dateISO}T05:00:00.000Z`,
    generationStrategy: 'bank',
    contextSummary: `day ${dayNumber} in ${phase}`,
  };
}

function buildSummary(dateISO: string): DailySummary {
  return {
    id: `sum-${dateISO}`,
    dateISO,
    completedTaskIds: ['seed_a1'],
    missedTaskIds: ['seed_b2'],
    habitProgress: { physics: 80 },
    streak: 3,
    weakHabitIds: ['chemistry'],
    strongHabitIds: ['physics'],
    revisionCompletedIds: [],
    backlogStatus: { count: 1, cleared: 0 },
    journalInsights: ['better focus'],
    aiObservations: ['rotation weak'],
    thinkingScore: 70,
    productivityScore: 85,
    planForTomorrow: ['more practice'],
    gapsDetected: 0,
    aiFallback: true,
    createdAt: `${dateISO}T22:00:00.000Z`,
  };
}

/** A state that exercises every persisted field of the app. */
function buildFullState(): AppState {
  const state = emptyAppState();
  state.startDateISO = '2026-06-01';
  state.examDateISO = '2026-08-30';
  state.bonusDaysUsed = 2;
  state.studyTimeMinutes = 420;
  state.timeZone = 'Asia/Kolkata';
  state.lastSummaryDate = '2026-07-20';
  state.clearedLevels = [1, 2];
  state.restDays = [7, 21];

  state.taskLogs['2026-06-01'] = { seed_a1: true, seed_b2: false, dyn_x: true };
  state.taskLogs['2026-06-02'] = { seed_a1: true, seed_b2: true };

  state.weeklyReviews = [
    { weekNumber: 1, dateISO: '2026-06-07', strongest: 'Physics', weakest: 'Calculus', planForNextWeek: 'More integration practice' },
  ];
  state.monthlyAssessments = [{ monthNumber: 1, dateISO: '2026-06-30', reflection: 'Solid start' }];
  state.failureLog = [{ dateISO: '2026-06-03', completionPct: 40, note: 'Caught up next day' }];

  state.memory = {
    entries: [
      { id: 'm1', type: 'goal', createdAt: '2026-06-02T00:00:00.000Z', content: 'IIT Delhi target', importance: 0.9, summarized: false, source: 'user', context: { tags: ['goal'] }, blockId: 'b1', longTerm: true },
      { id: 'm2', type: 'observation', createdAt: '2026-06-03T00:00:00.000Z', content: 'Weak in rotation', importance: 0.6, summarized: false, source: 'ai', context: { habitId: 'h1', tags: ['physics'] } },
    ],
    summaries: [{ id: 'ms1', type: 'summary', createdAt: '2026-06-10T00:00:00.000Z', content: 'Week 1 condensed', importance: 0.8, summarized: true, source: 'system', context: { tags: [] } }],
    lastSummarizedAt: '2026-06-10T00:00:00.000Z',
  };

  state.summaries = [buildSummary('2026-06-01'), buildSummary('2026-06-02')];

  const chat: ChatSettings = {
    temperature: 0.6,
    maxTokens: 8192,
    systemPrompt: 'custom Misa coach prompt',
    userPersona: 'shy student',
    memoryEnabled: true,
    autoSaveChats: true,
    conversationHistoryLength: 8,
    includeJourneyContext: true,
    showThinking: false,
    toolMaxTokens: 1024,
    memorySummaryMaxTokens: 8000,
  };
  state.aiSettings = {
    providers: {
      openrouter: { id: 'openrouter', label: 'OpenRouter', apiKey: 'sk-test-key', model: 'gpt-4o-mini', temperature: 0.5, maxTokens: 4096, streaming: true, enabled: true },
      gemini: { id: 'gemini', label: 'Gemini', apiKey: 'gem-test-key', enabled: true },
    },
    activeProviderId: 'openrouter',
    modelCache: {
      openrouter: [
        { id: 'gpt-4o-mini', name: 'GPT-4o Mini', provider: 'openrouter', contextLength: 128000, modalities: { input: ['text', 'image'], output: ['text'] }, supportsStreaming: true, supportsVision: true, supportsReasoning: false, supportsToolCalling: true, supportsStructuredOutputs: true, supportsThinking: false, pricing: null, isFree: false, deprecated: false, fetchedAt: 1234567890 },
      ],
    },
    aiEnabled: true,
    chat,
    websearch: { enabled: true, providerId: 'google', model: 'gemini-2.5-flash', apiKey: 'AIza-test', baseUrl: '' },
  };

  // Phase task bank — dynamic (AI/user) tasks in every phase.
  state.dynamicTaskBank = [
    buildTask('dyn-jee-1', 'jee-core', 'Integration marathon', 'Advanced'),
    buildTask('dyn-mind-1', 'l-mindset', 'Focus journal', 'Beginner'),
    buildTask('dyn-exec-1', 'light-execution', 'Mock review', 'Intermediate'),
    buildTask('dyn-peak-1', 'peak-performance', 'Exam sprint', 'Challenge'),
    buildTask('dyn-jee-2', 'jee-core', 'Revision block', 'Review'),
  ];

  // Every day's phases/blocks — cached daily plans.
  state.planCache['2026-06-01'] = buildPlan('2026-06-01', 1, 'jee-core');
  state.planCache['2026-06-02'] = buildPlan('2026-06-02', 2, 'jee-core');
  state.planCache['2026-06-21'] = buildPlan('2026-06-21', 21, 'l-mindset');

  // Undoable AI action trail.
  state.aiActionHistory = {
    versions: [{ id: 'v1', timestamp: '2026-06-01T00:00:00.000Z', action: 'create', entityType: 'task', entityId: 'dyn-jee-1', summary: 'added task', permissions: ['create'], beforeState: {}, afterState: {}, changedFields: ['title'], confirmationRequired: false, confirmed: true, status: 'applied' }],
    undone: [{ id: 'v2', timestamp: '2026-06-02T00:00:00.000Z', action: 'delete', entityType: 'task', entityId: 'dyn-old', summary: 'removed', permissions: ['delete'], beforeState: {}, afterState: {}, changedFields: [], confirmationRequired: false, confirmed: true, status: 'undone' }],
  };

  // Post-journey system.
  state.postJourney = {
    journeyComplete: true,
    completedAt: '2026-08-29T00:00:00.000Z',
    extensionDays: 5,
    mastery: { level: 'intermediate', topicScores: { electrostatics: 75, kinematics: 60 }, unlockedAt: '2026-07-01T00:00:00.000Z' },
    customPhases: [
      { id: 'cp1', name: 'Advanced Mechanics', description: 'Rotational deep dive', dayStart: 91, dayEnd: 105, goals: ['Master rotation'], habits: ['h-rotation'], difficulty: 'hard', createdBy: 'user', createdAt: '2026-06-15T00:00:00.000Z' },
    ],
    activeCustomPhaseId: 'cp1',
    pendingAISuggestions: [],
    finalStats: { totalTasksCompleted: 300, averageAccuracy: 82, strongestHabit: 'physics', weakestHabit: 'chemistry', totalStudyHours: 540, streakDays: 12, levelCleared: 4, phaseReached: 'peak-performance' },
  };

  state.userProfile = { name: 'Anurag', classLevel: '12th', examTarget: 'IIT Delhi', studyStyle: 'short bursts', notes: 'weak in calculus' };

  return state;
}

function buildChatSessions(): ChatSession[] {
  return [
    {
      id: 's1',
      title: 'Physics doubts',
      messages: [
        { id: 'm1', role: 'user', content: 'Rotation kaise improve karoon?', createdAt: '2026-06-01T10:00:00.000Z', attachments: [{ id: 'a1', name: 'notes.png', kind: 'image', previewUrl: 'blob:fake' }] },
        { id: 'm2', role: 'assistant', content: 'Rotational motion mein torque aur angular momentum pe focus karo.', createdAt: '2026-06-01T10:00:05.000Z', model: 'gpt-4o-mini', reasoning: 'User needs physics help', tool: 'getPlan', stopped: false },
      ],
      prefs: { ...defaultChatPrefs(), systemPrompt: 'custom', userPersona: 'shy student', thinking: 'high', temperature: 0.4, providerId: 'openrouter', model: 'gpt-4o-mini' },
      createdAt: '2026-06-01T09:59:00.000Z',
      updatedAt: '2026-06-01T10:00:05.000Z',
      memorySummarizedAt: '2026-06-02T00:00:00.000Z',
    },
    {
      id: 's2',
      title: 'Plan review',
      messages: [{ id: 'm3', role: 'user', content: 'Aaj ka plan?', createdAt: '2026-06-02T08:00:00.000Z' }],
      prefs: defaultChatPrefs(),
      createdAt: '2026-06-02T07:59:00.000Z',
      updatedAt: '2026-06-02T08:00:00.000Z',
      aiSummarizedAt: '2026-06-02T08:05:00.000Z',
    },
  ];
}

class FakeStore implements StateStore {
  current: AppState = emptyAppState();
  saved: AppState[] = [];
  get() {
    return this.current;
  }
  save(state: AppState) {
    this.saved.push(state);
    this.current = state;
  }
}

function memKV(): { getItem(k: string): string | null; setItem(k: string, v: string): void } {
  const data = new Map<string, string>();
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      data.set(k, v);
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('full app data backup (production-grade)', () => {
  it('round-trips EVERY user-data section losslessly (deep equality)', () => {
    const source = buildFullState();
    const chatStore: ChatStoreState = { version: 1, sessions: buildChatSessions() };
    const store = new FakeStore();
    let replaced: ChatSession[] | null = null as ChatSession[] | null;

    const payload = parseBackup(serializeBackup(buildBackupPayload(source, chatStore)));
    applyBackup(payload, { store, chat: { replaceStore: (sessions) => (replaced = sessions) } });

    // The restored state must match what the normalizer produces, with the
    // regenerable model catalog stripped (API cache, not user data) AND the
    // provider/websearch secrets redacted (AUDIT FIX round 2). Import into a
    // fresh store can't resurrect keys the backup no longer carries.
    const expected = normalizeState(source);
    expected.aiSettings = {
      ...expected.aiSettings,
      modelCache: {},
      providers: {
        ...expected.aiSettings.providers,
        openrouter: { ...expected.aiSettings.providers.openrouter, apiKey: undefined, customHeaders: undefined },
        gemini: { ...expected.aiSettings.providers.gemini, apiKey: undefined, customHeaders: undefined },
      },
      websearch: { ...expected.aiSettings.websearch, apiKey: '' },
    };
    expect(store.saved).toHaveLength(1);
    expect(store.saved[0]).toEqual(expected);
    // Chat history restored in order.
    expect(replaced).toEqual(chatStore.sessions);
  });

  it('keeps the phase task bank (dynamic tasks in every phase)', () => {
    const source = buildFullState();
    const store = new FakeStore();
    applyBackup(parseBackup(serializeBackup(buildBackupPayload(source, null))), { store });

    const restored = store.current.dynamicTaskBank;
    expect(restored).toHaveLength(5);
    expect(restored.map((t) => t.id)).toEqual(['dyn-jee-1', 'dyn-mind-1', 'dyn-exec-1', 'dyn-peak-1', 'dyn-jee-2']);
    const phases = [...new Set(restored.map((t) => t.phase))].sort();
    expect(phases).toEqual(['jee-core', 'l-mindset', 'light-execution', 'peak-performance']);
    // Full entry fidelity — not just ids.
    expect(restored.find((t) => t.id === 'dyn-jee-1')).toEqual(source.dynamicTaskBank[0]);
  });

  it('keeps every daily phase/block (planCache) with its tasks', () => {
    const source = buildFullState();
    const store = new FakeStore();
    applyBackup(parseBackup(serializeBackup(buildBackupPayload(source, null))), { store });

    const planCache = store.current.planCache;
    expect(Object.keys(planCache).sort()).toEqual(['2026-06-01', '2026-06-02', '2026-06-21']);
    expect(planCache['2026-06-21']).toEqual(source.planCache['2026-06-21']);
    expect(planCache['2026-06-01'].tasks[0].entry.phase).toBe('jee-core');
    expect(planCache['2026-06-21'].tasks[0].entry.phase).toBe('l-mindset');
  });

  it('restores the static seed bank + habits through a real repository (new-device simulation)', () => {
    // Device 1: source state with dynamic tasks.
    const sourceKV = memKV();
    const sourceRepo = new LocalStateRepository(sourceKV);
    sourceRepo.save(buildFullState());
    const sourceBank = new TaskBankRepositoryImpl(sourceRepo, buildSeed());
    const sourceDynamic = sourceBank.getAll().filter((t) => t.id.startsWith('dyn-'));

    // Device 2: brand new storage — user imports the backup here.
    const freshKV = memKV();
    const freshRepo = new LocalStateRepository(freshKV);
    const freshStore = new CachedStateStore(freshRepo);
    applyBackup(parseBackup(serializeBackup(buildBackupPayload(sourceRepo.load(), { version: 1, sessions: [] }))), {
      store: freshStore,
    });
    // CachedStateStore defers repo writes — flush so the repo read below sees
    // the imported state (same durability as before, just explicit).
    freshStore.flush();

    const restoredBank = new TaskBankRepositoryImpl(freshRepo, buildSeed());
    const all = restoredBank.getAll();

    // Dynamic (AI/user) phase tasks came through the backup…
    for (const dyn of sourceDynamic) {
      expect(all.some((t) => t.id === dyn.id && t.title === dyn.title && t.phase === dyn.phase)).toBe(true);
    }
    // …and the static curriculum bank + habits are baked into the app itself.
    expect(all.some((t) => t.id === 'd1_t1')).toBe(true);
    expect(all.length).toBeGreaterThan(sourceDynamic.length);
    expect(restoredBank.getAllHabits().length).toBeGreaterThan(0);
  });

  it('preserves post-journey state, user profile, providers, memory and action history', () => {
    const source = buildFullState();
    const store = new FakeStore();
    applyBackup(parseBackup(serializeBackup(buildBackupPayload(source, null))), { store });
    const restored = store.current;

    expect(restored.postJourney).toEqual(source.postJourney);
    expect(restored.userProfile).toEqual(source.userProfile);
    // AUDIT FIX (round 2): backups no longer ship API keys — they are redacted.
    // On import into an EMPTY store there's no current device key to preserve,
    // so the provider config survives (label/model/enabled) but the secret is gone.
    expect(restored.aiSettings.providers.openrouter?.apiKey).toBeUndefined();
    expect(restored.aiSettings.providers.openrouter?.label).toBe('OpenRouter');
    // Model catalog is regenerable → excluded from the backup entirely.
    expect(restored.aiSettings.modelCache).toEqual({});
    expect(restored.aiSettings.chat.systemPrompt).toBe('custom Misa coach prompt');
    expect(restored.memory).toEqual(source.memory);
    expect(restored.aiActionHistory).toEqual(source.aiActionHistory);
    expect(restored.summaries).toEqual(source.summaries);
    expect(restored.taskLogs).toEqual(source.taskLogs);
    expect(restored.timeZone).toBe('Asia/Kolkata');
    expect(restored.restDays).toEqual([7, 21]);
  });

  it('keeps chat prefs, personas, thinking level, attachments and summarized timestamps', () => {
    const source = buildFullState();
    const chatStore: ChatStoreState = { version: 1, sessions: buildChatSessions() };
    const store = new FakeStore();
    let replaced: ChatSession[] | null = null as ChatSession[] | null;
    applyBackup(parseBackup(serializeBackup(buildBackupPayload(source, chatStore))), { store, chat: { replaceStore: (s) => { replaced = s; } } });

    const s1 = replaced?.[0];
    expect(s1?.messages[0].attachments?.[0].kind).toBe('image');
    expect(s1?.messages[1].model).toBe('gpt-4o-mini');
    expect(s1?.messages[1].tool).toBe('getPlan');
    expect(s1?.prefs.thinking).toBe('high');
    expect(s1?.prefs.providerId).toBe('openrouter');
    expect(s1?.memorySummarizedAt).toBe('2026-06-02T00:00:00.000Z');
    expect(replaced?.[1].aiSummarizedAt).toBe('2026-06-02T08:05:00.000Z');
  });
});

describe('full app data + schema hygiene', () => {
  it('always exports at the current schema version', () => {
    const payload = buildBackupPayload(buildFullState(), null);
    expect(payload.data.state).toMatchObject({ schemaVersion: STATE_SCHEMA_VERSION });
    expect(payload.version).toBe(1);
    expect(payload.scope).toBe('full');
  });

  it('exported state JSON is parseable and round-trips through normalizeState — secrets redacted', () => {
    const source = buildFullState();
    const json = serializeBackup(buildBackupPayload(source, null));
    const parsed = JSON.parse(json) as { data: { state: unknown } };
    const expected = normalizeState(source);
    // AUDIT FIX (round 2): backups no longer carry provider/websearch secrets.
    expected.aiSettings = {
      ...expected.aiSettings,
      modelCache: {},
      providers: {
        ...expected.aiSettings.providers,
        openrouter: { ...expected.aiSettings.providers.openrouter, apiKey: undefined, customHeaders: undefined },
        gemini: { ...expected.aiSettings.providers.gemini, apiKey: undefined, customHeaders: undefined },
      },
      websearch: { ...expected.aiSettings.websearch, apiKey: '' },
    };
    expect(normalizeState(parsed.data.state)).toEqual(expected);
  });

  it('scoped tasks backup round-trips ONLY the task data into a fresh store', () => {
    const source = buildFullState();
    const store = new FakeStore();
    const payload = buildBackupPayload(source, null, 'tasks');
    const summary = applyBackup(parseBackup(serializeBackup(payload)), { store });

    expect(payload.data.chat).toBeUndefined();
    expect(summary.scope).toBe('tasks');
    expect(store.current.dynamicTaskBank).toHaveLength(5);
    expect(Object.keys(store.current.planCache).sort()).toEqual(['2026-06-01', '2026-06-02', '2026-06-21']);
    expect(store.current.taskLogs['2026-06-01']).toEqual({ seed_a1: true, seed_b2: false, dyn_x: true });
    expect(store.current.restDays).toEqual([7, 21]);
    // Anything outside the tasks scope starts from the base defaults (fresh store).
    expect(store.current.clearedLevels).toEqual([]);
    expect(store.current.startDateISO).toBeNull();
    // The summary reflects ONLY what the scoped backup carries.
    expect(summary.state.dynamicTasks).toBe(5);
    expect(summary.state.planDays).toBe(3);
    expect(summary.chat.sessions).toBe(0);
  });

  it('scoped levels backup round-trips ONLY the progression data into a fresh store', () => {
    const source = buildFullState();
    const store = new FakeStore();
    const payload = buildBackupPayload(source, null, 'levels');
    const summary = applyBackup(parseBackup(serializeBackup(payload)), { store });

    expect(payload.data.chat).toBeUndefined();
    expect(summary.scope).toBe('levels');
    expect(store.current.clearedLevels).toEqual([1, 2]);
    expect(store.current.weeklyReviews).toHaveLength(1);
    expect(store.current.monthlyAssessments).toHaveLength(1);
    expect(store.current.postJourney).toEqual(source.postJourney);
    // Fresh store → task data stays at defaults.
    expect(store.current.dynamicTaskBank).toHaveLength(0);
    expect(store.current.taskLogs).toEqual({});
    expect(summary.state.clearedLevels).toBe(2);
    expect(summary.state.weeklyReviews).toBe(1);
  });

  it('scoped backups never touch chat when imported over a store with sessions', () => {
    const source = buildFullState();
    const store = new FakeStore();
    let replaced: ChatSession[] | null = null as ChatSession[] | null;
    const payload = buildBackupPayload(source, { version: 1, sessions: buildChatSessions() }, 'tasks');
    applyBackup(parseBackup(serializeBackup(payload)), { store, chat: { replaceStore: (s) => (replaced = s) } });
    expect(replaced).toBeNull();
  });
});
