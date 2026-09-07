import { describe, it, expect } from 'vitest';
import type { AppState } from '../../../core/domain/state';
import { emptyAppState } from '../../../core/domain/state';
import { LEVELS, TOTAL_DAYS } from '../../../data/curriculum';
import type { ChatRepository, StateStore, StateRepository } from '../../../core/ports/repositories';
import type { ChatSession, ChatStoreState } from '../../../core/domain/chat';
import { chatToolScopeInstructions, CHAT_TOOL_CATALOG, NINETY_DAY_ONLY_ACTION_SET } from '../../../core/domain/chat-tools';
import type { LLMProvider, LLMResponse, LLMRequest, HealthCheckResult, ModelInfo, ProviderId, ContentPart } from '../../../core/domain/llm';
import type { ProviderFactory } from '../../../infra/ai/provider-factory';
import { buildSeed, TaskBankRepositoryImpl } from '../../task-bank/task-bank.repository';
import { TaskBankServiceImpl } from '../../task-bank/task-bank.service';
import { HabitProgressionService } from '../../habit-engine/planner';
import { parseTaskBankEntry } from '../../task-bank/validation';
import { LLMService } from '../../ai/llm.service';
import { ProviderSettingsService } from '../../ai/provider-settings.service';
import { ChatService } from '../chat.service';
import { ChatToolsService } from '../chat-tools.service';
import { DEFAULT_PROGRESSION_CONFIG } from '../../../core/domain/progress';
import { undoLastAiAction, redoLastAiAction, state90DayOnlyBlocked } from '../../../core/domain/ai-actions';
import { PlannerService, PlannerToolsService } from '../../planner/planner.service';
import type { TaskGenerationService } from '../../ai/task-generation.service';
import { MemoryService } from '../../ai/memory.service';
import { MemoryToolsService } from '../memory-tools.service';

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
  private t = new Date('2026-07-31T10:00:00Z');
  now(): Date {
    return new Date(this.t);
  }
}

function makeStore(): StateStore {
  let state: AppState = {
    ...emptyAppState(),
    startDateISO: '2026-07-01',
    aiSettings: {
      ...emptyAppState().aiSettings,
      providers: { openrouter: { id: 'openrouter', label: 'OpenRouter', model: 'a', enabled: true } },
      aiEnabled: true,
    },
  };
  return {
    get: () => state,
    save: (s: AppState) => {
      state = s;
    },
  };
}

/** Store with the 90-day track toggled OFF (flexible mode). */
function makeFlexibleStore(): StateStore {
  const store = makeStore();
  store.save({ ...store.get(), enable90DayTrack: false });
  return store;
}

function makeTools(store: StateStore, chatSessionsProvider?: () => ChatSession[]): { tools: ChatToolsService; taskGeneration: TaskGenerationService } {
  const stateRepo: StateRepository = { load: () => store.get(), save: (s) => store.save(s), clear: () => undefined };
  const taskBankRepo = new TaskBankRepositoryImpl(stateRepo, buildSeed());
  const taskBank = new TaskBankServiceImpl(taskBankRepo);
  const planner = new HabitProgressionService({ taskBank, habits: taskBankRepo, levels: LEVELS, totalDays: TOTAL_DAYS });
  const taskGeneration: TaskGenerationService = {
    generate: async () => ({
      entry: parseTaskBankEntry({
        id: 'ai-chat-test',
        habitId: 'h1',
        title: 'Chat se add hua task',
        description: 'added via chat tool',
        phase: 'jee-core',
        difficulty: 2,
        estimatedDurationMin: 20,
        energyLevel: 'low',
        tags: [],
        prerequisites: [],
        taskType: 'Beginner',
        revisionSuitability: 0.2,
        backlogSuitability: 0.2,
        thinkingSkills: ['recall'],
        jeeRelevance: { subject: 'physics', score: 0.5 },
        unlockConditions: [{ type: 'day', fromDay: 1 }],
        active: true,
      }),
      source: 'ai',
    }),
  } as unknown as TaskGenerationService;
  const memory = new MemoryService(new FakeClock());
  const memTools = new MemoryToolsService(store, memory);
  return { tools: new ChatToolsService(store, planner, taskBank, taskGeneration, DEFAULT_PROGRESSION_CONFIG, null, new FakeClock(), chatSessionsProvider, memTools), taskGeneration };
}

function makeChat(store: StateStore, provider: LLMProvider, tools: ChatToolsService): ChatService {
  const factory: ProviderFactory = { create: () => provider } as unknown as ProviderFactory;
  const settings = new ProviderSettingsService(store, factory);
  const llm = new LLMService(factory, settings);
  return new ChatService(new MemoryChatRepository(), llm, settings, () => 'ctx', new FakeClock(), tools, null, store);
}

function providerWith(completeText: string, streamText: string): LLMProvider {
  return {
    id: 'openrouter' as ProviderId,
    label: 'OpenRouter',
    isConfigured: () => true,
    complete: async (): Promise<LLMResponse> => ({ text: completeText, model: 'a' }),
    stream: async (req: LLMRequest): Promise<LLMResponse> => {
      if (req.onDelta) req.onDelta(streamText);
      return { text: streamText, model: 'a' };
    },
    fetchModels: async (): Promise<ModelInfo[]> => [],
    healthCheck: async (): Promise<HealthCheckResult> => ({ ok: true, provider: 'openrouter', latencyMs: 1 }),
  };
}

/** Stubs FileReader + fetch so blobToDataUrl resolves to a fake PDF data URL. */
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
          this.result = `data:${blob.type || 'application/octet-stream'};base64,${base64}`;
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

describe('ChatToolsService', () => {
  it('detects task-related queries and parses valid tool actions', () => {
    const store = makeStore();
    const { tools } = makeTools(store);
    expect(tools.isTaskQuery('kal ke tasks kya hain?')).toBe(true);
    expect(tools.isTaskQuery('day 30 ka plan batao')).toBe(true);
    // General concept questions stay on the normal chat path — they must NOT
    // consume a tool hop (this was the wrong-tool-pick bug).
    expect(tools.isTaskQuery('concept samjhao')).toBe(false);
    expect(tools.isTaskQuery('is problem ka solution batao')).toBe(false);
    expect(tools.isTaskQuery('physics kaise padhein')).toBe(false);
    // Custom-block commands still route to tools thanks to the block anchor.
    expect(tools.isTaskQuery('concept building block banao')).toBe(true);
    expect(tools.isTaskQuery('physics block create karo')).toBe(true);
    expect(tools.isTaskQuery('block-bogus ko extend karo')).toBe(true);
    expect(tools.parseTool('{"action":"getPlan","day":15}')).toEqual({ action: 'getPlan', day: 15 });
    expect(tools.parseTool('sure! {"action":"markDone","day":2,"taskId":"x"} ok')).toEqual({ action: 'markDone', day: 2, taskId: 'x' });
    expect(tools.parseTool('no json here')).toBeNull();
    expect(tools.parseTool('{"action":"hack"}')).toBeNull();
  });

  it('routes real-user plan/task/rest phrasings to the tool hop', () => {
    const store = makeStore();
    const { tools } = makeTools(store);
    // Real Hinglish/English phrasings users actually type (high-precision set).
    expect(tools.isTaskQuery('aaj ke kitne tasks bache hain?')).toBe(true);
    expect(tools.isTaskQuery('kal chutti rakhni hai')).toBe(true);
    expect(tools.isTaskQuery('aaj rest day hai?')).toBe(true);
    expect(tools.isTaskQuery('yeh task skip karo')).toBe(true);
    expect(tools.isTaskQuery('kal ka test cancel karo')).toBe(true);
    expect(tools.isTaskQuery('plan postpone karo')).toBe(true);
    expect(tools.isTaskQuery('routine batao')).toBe(true);
    expect(tools.isTaskQuery('exam ki taiyari kaise karein')).toBe(true);
    expect(tools.isTaskQuery('kab tak complete karna hai deadline?')).toBe(true);
    // Generic conversation must STILL stay off the tool hop (cost guard).
    expect(tools.isTaskQuery('concept samjhao')).toBe(false);
    expect(tools.isTaskQuery('is problem ka solution batao')).toBe(false);
    expect(tools.isTaskQuery('physics kaise padhein')).toBe(false);
    expect(tools.isTaskQuery('what comes next in the story?')).toBe(false);
  });

  it('does NOT hijack ordinary chat words that merely contain a plan word (M1 word-boundary fix)', () => {
    const store = makeStore();
    const { tools } = makeTools(store);
    // Substring matches that previously routed to tools by accident: "Today"
    // contains "day", "Remark" contains "mark", "contest"/"latest" contain
    // "test", "listening" contains "list", "addition" contains "add", etc.
    expect(tools.isTaskQuery('today ka kya scene hai')).toBe(false);
    expect(tools.isTaskQuery('monday ko kya hua')).toBe(false);
    expect(tools.isTaskQuery('remark dena hai')).toBe(false);
    expect(tools.isTaskQuery('market mein kya chal raha hai')).toBe(false);
    expect(tools.isTaskQuery('i am listening to you')).toBe(false);
    expect(tools.isTaskQuery('contest ka winner kaun hai')).toBe(false);
    expect(tools.isTaskQuery('latest news kya hai')).toBe(false);
    expect(tools.isTaskQuery('addition sum batao')).toBe(false);
    expect(tools.isTaskQuery('address batao')).toBe(false);
    expect(tools.isTaskQuery('clarify please')).toBe(false);
    expect(tools.isTaskQuery('clearly samjhao')).toBe(false);
    expect(tools.isTaskQuery('wall kya hai')).toBe(false);
    expect(tools.isTaskQuery('call me later')).toBe(false);
    // The same words in a REAL task context still route to tools.
    expect(tools.isTaskQuery('mark yahi task done')).toBe(true);
    expect(tools.isTaskQuery('aaj ke tasks list karo')).toBe(true);
    expect(tools.isTaskQuery('add task kal ke liye')).toBe(true);
    expect(tools.isTaskQuery('clear aaj ka backlog')).toBe(true);
    expect(tools.isTaskQuery('all tasks dikhao')).toBe(true);
    expect(tools.isTaskQuery('test ka result kya hai')).toBe(true);
    expect(tools.isTaskQuery('day 30 ka plan batao')).toBe(true);
    expect(tools.isTaskQuery('today ka plan batao')).toBe(true);
  });

  it('getPlan returns the deterministic plan for any day with ids', async () => {
    const store = makeStore();
    const { tools } = makeTools(store);
    const result = await tools.run({ action: 'getPlan', day: 1 });
    expect(result.ok).toBe(true);
    expect(result.summary).toContain('Day 1 plan');
    expect(result.summary).toContain('id:d1_t1');
    expect(result.summary).toContain('[todo]');
  });

  it('getRange auto-chunks ranges wider than 7 days instead of failing', async () => {
    const store = makeStore();
    const { tools } = makeTools(store);
    const tooBig = await tools.run({ action: 'getRange', fromDay: 1, toDay: 30 });
    expect(tooBig.ok).toBe(true);
    expect(tooBig.summary).toContain('Plan overview Day 1-10');
    expect(tooBig.summary).toContain('Plan overview Day 11-20');
    expect(tooBig.summary).toContain('Day 30');
    const ok = await tools.run({ action: 'getRange', fromDay: 60, toDay: 62 });
    expect(ok.ok).toBe(true);
    expect(ok.summary).toContain('Day 60');
  });

  it('markDone persists through the store', async () => {
    const store = makeStore();
    const { tools } = makeTools(store);
    const result = await tools.run({ action: 'markDone', day: 1, taskId: 'd1_t1' });
    expect(result.ok).toBe(true);
    expect(store.get().taskLogs['2026-07-01']?.['d1_t1']).toBe(true);
  });

  it('markDone uses special plan log keys such as mock days', async () => {
    const store = makeStore();
    const { tools } = makeTools(store);
    // Sundays are NOT auto mock anymore — Day 33 (2026-08-02) becomes a mock
    // day only when explicitly marked as a TEST day via setDayMode.
    await tools.run({ action: 'setDayMode', day: 33, mode: 'test', confirmed: true });
    const result = await tools.run({ action: 'markDone', day: 33, taskId: 'mock_1' });
    expect(result.ok).toBe(true);
    expect(store.get().taskLogs['mock:2026-08-02']?.mock_1).toBe(true);
    expect(store.get().taskLogs['2026-08-02']?.mock_1).toBeUndefined();
  });

  it('addTask appends a dynamic entry through the store', async () => {
    const store = makeStore();
    const { tools } = makeTools(store);
    const result = await tools.run({ action: 'addTask', day: 3, intent: 'chat se task', durationMin: 20 });
    expect(result.ok).toBe(true);
    expect(store.get().dynamicTaskBank.some((e) => e.id === 'ai-chat-test')).toBe(true);
  });



  it('addTask clones bank matches into editable dynamic tasks', async () => {
    const store = makeStore();
    const { tools, taskGeneration } = makeTools(store);
    // Use a late-unlock seed task so it is NOT already scheduled on Day 4 (the
    // duplicate guard must not block this legitimate clone).
    taskGeneration.generate = async () => ({ entry: buildSeed().tasks.find((t) => t.id === 'd11_t1')!, source: 'bank' });
    const result = await tools.run({ action: 'addTask', day: 4, intent: 'existing bank task', durationMin: 20 });
    expect(result.ok).toBe(true);
    const added = store.get().dynamicTaskBank[0];
    expect(added.id).toMatch(/^ai-/);
    expect(added.legacy).toBeUndefined();
    expect(added.unlockConditions).toEqual([{ type: 'day-exact', day: 4 }]);
  });

  it('addTask schedules the task only for that exact day', async () => {
    const store = makeStore();
    const { tools } = makeTools(store);
    await tools.run({ action: 'addTask', day: 5, intent: 'chat se task', durationMin: 20 });
    const day5 = store.get().dynamicTaskBank.find((e) => e.id === 'ai-chat-test');
    expect(day5?.unlockConditions).toEqual([{ type: 'day-exact', day: 5 }]);
    const planDay5 = tools.run({ action: 'getPlan', day: 5 });
    const planDay6 = tools.run({ action: 'getPlan', day: 6 });
    expect((await planDay5).summary).toContain('Chat se add hua task');
    expect((await planDay6).summary).not.toContain('Chat se add hua task');
  });

  it('addTask applies provided full metadata and exposes it in the plan', async () => {
    const store = makeStore();
    const { tools } = makeTools(store);
    await tools.run({
      action: 'addTask',
      day: 5,
      intent: 'chat se task',
      durationMin: 45,
      description: 'Custom thermodynamics practice',
      difficulty: 4,
      energyLevel: 'high',
      tags: ['physics', 'thermo'],
      taskType: 'Advanced',
      revisionSuitability: 0.7,
      backlogSuitability: 0.3,
      thinkingSkills: ['analysis', 'verification'],
      jeeRelevance: { subject: 'physics', score: 0.9 },
    });
    const entry = store.get().dynamicTaskBank.find((e) => e.id === 'ai-chat-test');
    expect(entry?.description).toBe('Custom thermodynamics practice');
    expect(entry?.difficulty).toBe(4);
    expect(entry?.energyLevel).toBe('high');
    expect(entry?.tags).toEqual(['physics', 'thermo']);
    expect(entry?.taskType).toBe('Advanced');
    expect(entry?.thinkingSkills).toEqual(['analysis', 'verification']);
    const plan = await tools.run({ action: 'getPlan', day: 5 });
    expect(plan.summary).toContain('difficulty:4/5');
    expect(plan.summary).toContain('subject:physics');
  });

  it('editTask fails without any concrete edit field so the AI can retry with full info', async () => {
    const store = makeStore();
    const { tools } = makeTools(store);
    const result = await tools.run({ action: 'editTask', day: 1, taskId: 'd1_t1' });
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('edit ke liye');
    expect(result.missingTaskIdDays).toEqual([1]);
  });

  it('creates and activates blocks while updating post-journey extension days', async () => {
    const store = makeStore();
    const { tools } = makeTools(store);
    const result = await tools.run({
      action: 'createBlock',
      name: 'Physics Mastery',
      description: 'Thermo and mechanics focus',
      days: 12,
      focusAreas: ['physics'],
      difficulty: 'hard',
    });
    expect(result.ok).toBe(true);
    const block = store.get().postJourney.customPhases[0];
    expect(block.name).toBe('Physics Mastery');
    expect(block.description).toBe('Thermo and mechanics focus');
    expect(block.dayStart).toBe(91);
    expect(block.dayEnd).toBe(102);
    expect(store.get().postJourney.activeCustomPhaseId).toBe(block.id);
    expect(store.get().postJourney.extensionDays).toBe(12);
    expect(store.get().postJourney.journeyComplete).toBe(true);
  });

  it('edits, extends, lists, and deletes active blocks safely', async () => {
    const store = makeStore();
    const { tools } = makeTools(store);
    await tools.run({ action: 'createBlock', name: 'Physics Block', days: 7, focusAreas: ['physics'], difficulty: 'medium' });
    const blockId = store.get().postJourney.customPhases[0].id;

    const edit = await tools.run({ action: 'editBlock', blockId, name: 'Hard Physics Block', days: 10, habits: ['HCV drills'], goals: ['Finish mechanics'], difficulty: 'hard' });
    expect(edit.ok).toBe(true);
    expect(store.get().postJourney.customPhases[0]).toMatchObject({ name: 'Hard Physics Block', dayStart: 91, dayEnd: 100, difficulty: 'hard' });

    const extend = await tools.run({ action: 'extendBlock', blockId, days: 5 });
    expect(extend.ok).toBe(true);
    expect(store.get().postJourney.customPhases[0].dayEnd).toBe(105);
    expect(store.get().postJourney.extensionDays).toBe(15);

    const list = await tools.run({ action: 'listBlocks' });
    expect(list.summary).toContain(blockId);
    expect(list.summary).toContain('Hard Physics Block');

    const preview = await tools.run({ action: 'deleteBlock', blockId });
    expect(preview.requiresConfirmation).toBe(true);
    const deleted = await tools.run({ action: 'deleteBlock', blockId, confirmed: true });
    expect(deleted.ok).toBe(true);
    expect(store.get().postJourney.customPhases).toHaveLength(0);
    expect(store.get().postJourney.activeCustomPhaseId).toBeNull();
    expect(store.get().postJourney.extensionDays).toBe(0);
  });

  it('removeTask hides a built-in task for one day only; the bank entry is untouched', async () => {
    const store = makeStore();
    const { tools } = makeTools(store);
    const preview = await tools.run({ action: 'removeTask', day: 1, taskId: 'd1_t1' });
    expect(preview.ok).toBe(false);
    expect(preview.requiresConfirmation).toBe(true);
    expect(store.get().dynamicTaskBank.some((e) => e.id === 'd1_t1')).toBe(false);

    const result = await tools.run({ action: 'removeTask', day: 1, taskId: 'd1_t1', confirmed: true });
    expect(result.ok).toBe(true);
    const override = store.get().dynamicTaskBank.find((e) => e.id === 'd1_t1');
    expect(override?.active).toBe(true);
    expect(override?.unlockConditions).toEqual([{ type: 'day', fromDay: 1 }, { type: 'not-day', day: 1 }]);
    // The bank seed is still present (never deleted).
    expect(buildSeed().tasks.some((t) => t.id === 'd1_t1')).toBe(true);
    // Gone from day 1, still planned on day 2.
    expect((await tools.run({ action: 'getPlan', day: 1 })).summary).not.toContain('id:d1_t1');
    expect((await tools.run({ action: 'getPlan', day: 2 })).summary).toContain('id:d1_t1');
  });

  it('removeTask deletes an explicitly scheduled dynamic task for that day', async () => {
    const store = makeStore();
    const { tools } = makeTools(store);
    await tools.run({ action: 'addTask', day: 3, intent: 'chat se task', durationMin: 20 });
    expect(store.get().dynamicTaskBank.some((e) => e.id === 'ai-chat-test')).toBe(true);
    const result = await tools.run({ action: 'removeTask', day: 3, taskId: 'ai-chat-test', confirmed: true });
    expect(result.ok).toBe(true);
    expect(store.get().dynamicTaskBank.some((e) => e.id === 'ai-chat-test')).toBe(false);
  });

  it('bulkRemoveTasks removes multiple built-in tasks from one day only', async () => {
    const store = makeStore();
    const { tools } = makeTools(store);
    const result = await tools.run({ action: 'bulkRemoveTasks', day: 1, taskIds: ['d1_t1', 'd1_t2'], confirmed: true });
    expect(result.ok).toBe(true);
    const overrides = store.get().dynamicTaskBank.filter((e) => e.unlockConditions.some((c) => c.type === 'not-day' && c.day === 1));
    expect(overrides.length).toBe(2);
    const day1 = await tools.run({ action: 'getPlan', day: 1 });
    expect(day1.summary).not.toContain('id:d1_t1');
    expect(day1.summary).not.toContain('id:d1_t2');
    const day2 = await tools.run({ action: 'getPlan', day: 2 });
    expect(day2.summary).toContain('id:d1_t1');
    expect(day2.summary).toContain('id:d1_t2');
  });

  it('setDayMode rest empties the plan and study restores it', async () => {
    const store = makeStore();
    const { tools } = makeTools(store);
    const preview = await tools.run({ action: 'setDayMode', day: 35, mode: 'rest' });
    expect(preview.ok).toBe(false);
    expect(preview.requiresConfirmation).toBe(true);
    expect(store.get().restDays).toEqual([]);
    const rest = await tools.run({ action: 'setDayMode', day: 35, mode: 'rest', confirmed: true });
    expect(rest.ok).toBe(true);
    expect(store.get().restDays).toEqual([35]);
    const restPlan = await tools.run({ action: 'getPlan', day: 35 });
    expect(restPlan.summary).toContain('REST DAY');
    expect(restPlan.summary).not.toContain('id:d');
    const study = await tools.run({ action: 'setDayMode', day: 35, mode: 'study', confirmed: true });
    expect(study.ok).toBe(true);
    expect(store.get().restDays).toEqual([]);
    const studyPlan = await tools.run({ action: 'getPlan', day: 35 });
    expect(studyPlan.summary).toContain('id:d1_t');
  });

  it('setDayMode marks a TEST day: mock protocol appears, restDays untouched; study removes it', async () => {
    const store = makeStore();
    const { tools } = makeTools(store);
    // Sunday 2026-08-02 is a NORMAL study day by default — no mock tasks.
    const before = await tools.run({ action: 'getPlan', day: 33 });
    expect(before.summary).not.toContain('id:mock_1');

    const preview = await tools.run({ action: 'setDayMode', day: 33, mode: 'test' });
    expect(preview.ok).toBe(false);
    expect(preview.requiresConfirmation).toBe(true);
    expect(store.get().testDays).toEqual([]);

    const test = await tools.run({ action: 'setDayMode', day: 33, mode: 'test', confirmed: true });
    expect(test.ok).toBe(true);
    expect(store.get().testDays).toEqual([33]);
    expect(store.get().restDays).toEqual([]);
    const testPlan = await tools.run({ action: 'getPlan', day: 33 });
    expect(testPlan.summary).toContain('id:mock_1');
    // A test day is NOT a rest day — it is not empty.
    expect(testPlan.summary).not.toContain('REST DAY');

    const study = await tools.run({ action: 'setDayMode', day: 33, mode: 'study', confirmed: true });
    expect(study.ok).toBe(true);
    expect(store.get().testDays).toEqual([]);
    const after = await tools.run({ action: 'getPlan', day: 33 });
    expect(after.summary).not.toContain('id:mock_1');
  });

  it('setDayMode rest clears a test day and test clears a rest day atomically', async () => {
    const store = makeStore();
    const { tools } = makeTools(store);
    await tools.run({ action: 'setDayMode', day: 35, mode: 'test', confirmed: true });
    await tools.run({ action: 'setDayMode', day: 35, mode: 'rest', confirmed: true });
    expect(store.get().testDays).toEqual([]);
    expect(store.get().restDays).toEqual([35]);
    await tools.run({ action: 'setDayMode', day: 35, mode: 'test', confirmed: true });
    expect(store.get().testDays).toEqual([35]);
    expect(store.get().restDays).toEqual([]);
  });

  it('setDayMode test/rest/study changes are undoable and redoable (combined dayModes entity)', async () => {
    const store = makeStore();
    const { tools } = makeTools(store);
    await tools.run({ action: 'setDayMode', day: 35, mode: 'test', confirmed: true });
    expect(store.get().testDays).toEqual([35]);
    store.save(undoLastAiAction(store.get()));
    expect(store.get().testDays).toEqual([]);
    store.save(redoLastAiAction(store.get()));
    expect(store.get().testDays).toEqual([35]);
    // Rest + test toggling stays atomic through undo.
    await tools.run({ action: 'setDayMode', day: 35, mode: 'rest', confirmed: true });
    expect(store.get().testDays).toEqual([]);
    expect(store.get().restDays).toEqual([35]);
    store.save(undoLastAiAction(store.get()));
    expect(store.get().testDays).toEqual([35]);
    expect(store.get().restDays).toEqual([]);
  });

  describe('describeParseFailure', () => {
    it('names the exact missing field for a known action instead of a generic nudge', () => {
      const { tools } = makeTools(makeStore());
      const msg = tools.describeParseFailure('{"action":"setDayMode","day":2}');
      expect(msg).toContain('setDayMode');
      expect(msg).toMatch(/mode/i);
    });

    it('flags an unrecognized enum value, not just a missing field', () => {
      const { tools } = makeTools(makeStore());
      const msg = tools.describeParseFailure('{"action":"setDayMode","day":2,"mode":"holiday"}');
      expect(msg).toContain('setDayMode');
    });

    it('reports the first bad entry inside an actions batch', () => {
      const { tools } = makeTools(makeStore());
      const msg = tools.describeParseFailure('{"actions":[{"action":"markDone","day":1,"taskId":"d1_t1"},{"action":"setDayMode","day":2}]}');
      expect(msg).toContain('actions[1]');
      expect(msg).toContain('setDayMode');
    });

    it('returns null for pure prose (no JSON object at all)', () => {
      const { tools } = makeTools(makeStore());
      expect(tools.describeParseFailure('Haan bilkul, main tumhari help karta hoon!')).toBeNull();
    });

    it('returns null for an unrecognized/hallucinated action name — falls through to the default handling unchanged', () => {
      const { tools } = makeTools(makeStore());
      expect(tools.describeParseFailure('{"action":"websearch","query":"jee syllabus"}')).toBeNull();
    });

    it('returns null when the JSON actually parses fine (no failure to explain)', () => {
      const { tools } = makeTools(makeStore());
      expect(tools.describeParseFailure('{"action":"getPlan","day":1}')).toBeNull();
    });
  });

  it('can add tasks on a mock Sunday and they appear in that plan', async () => {
    const store = makeStore();
    const { tools } = makeTools(store);
    // Sundays are normal study days by default — Day 33 (2026-08-02) gets the
    // mock protocol ONLY when explicitly marked as a TEST day.
    const normal = await tools.run({ action: 'getPlan', day: 33 });
    expect(normal.summary).not.toContain('id:mock_1');
    await tools.run({ action: 'setDayMode', day: 33, mode: 'test', confirmed: true });
    const sunday = await tools.run({ action: 'getPlan', day: 33 });
    expect(sunday.summary).toContain('id:mock_1');
    const add = await tools.run({ action: 'addTask', day: 33, intent: 'sunday revision', durationMin: 20 });
    expect(add.ok).toBe(true);
    const updated = await tools.run({ action: 'getPlan', day: 33 });
    expect(updated.summary).toContain('Chat se add hua task');
  });

  it('bulkMarkDone previews and then marks all visible day tasks together', async () => {
    const store = makeStore();
    const { tools } = makeTools(store);
    const preview = await tools.run({ action: 'bulkMarkDone', day: 1 });
    expect(preview.ok).toBe(false);
    expect(preview.requiresConfirmation).toBe(true);
    expect(store.get().taskLogs['2026-07-01']).toBeUndefined();

    const result = await tools.run({ action: 'bulkMarkDone', day: 1, confirmed: true });
    expect(result.ok).toBe(true);
    expect(result.versionId).toBeTruthy();
    expect(Object.values(store.get().taskLogs['2026-07-01'] ?? {}).every(Boolean)).toBe(true);
  });

  it('editTask can override a built-in seed entry', async () => {
    const store = makeStore();
    const { tools } = makeTools(store);
    const result = await tools.run({ action: 'editTask', day: 1, taskId: 'd1_t1', title: 'Updated built-in task', durationMin: 25, dayTo: 2 });
    expect(result.ok).toBe(true);
    const override = store.get().dynamicTaskBank.find((e) => e.id === 'd1_t1');
    expect(override?.title).toBe('Updated built-in task');
    expect(override?.estimatedDurationMin).toBe(25);
    expect(override?.unlockConditions).toEqual([{ type: 'day-exact', day: 2 }]);
  });

  it('reports missingTaskIdDays when an action targets an unknown task id', async () => {
    const store = makeStore();
    const { tools } = makeTools(store);
    const edit = await tools.run({ action: 'editTask', day: 1, taskId: 'nope', durationMin: 25 });
    expect(edit.ok).toBe(false);
    expect(edit.missingTaskIdDays).toEqual([1]);
    const mark = await tools.run({ action: 'markDone', day: 2, taskId: 'nope' });
    expect(mark.ok).toBe(false);
    expect(mark.missingTaskIdDays).toEqual([2]);
    const remove = await tools.run({ action: 'removeTask', day: 3, taskId: 'nope', confirmed: true });
    expect(remove.ok).toBe(false);
    expect(remove.missingTaskIdDays).toEqual([3]);
  });

  it('bulkAddTasks keeps the tasks that generated when one intent fails', async () => {
    const store = makeStore();
    const { tools, taskGeneration } = makeTools(store);
    taskGeneration.generate = async (_state, input) => {
      if (input.intent === 'bogus') throw new Error('generate failed');
      return {
        entry: parseTaskBankEntry({
          id: `ai-${input.intent}`,
          habitId: 'h1',
          title: input.intent,
          description: 'added via chat tool',
          phase: 'jee-core',
          difficulty: 2,
          estimatedDurationMin: 20,
          energyLevel: 'low',
          tags: [],
          prerequisites: [],
          taskType: 'Beginner',
          revisionSuitability: 0.2,
          backlogSuitability: 0.2,
          thinkingSkills: ['recall'],
          jeeRelevance: { subject: 'physics', score: 0.5 },
          unlockConditions: [{ type: 'day', fromDay: 1 }],
          active: true,
        }),
        source: 'ai',
      };
    };
    const result = await tools.run({ action: 'bulkAddTasks', day: 3, intents: ['pehla', 'bogus', 'dusra'], durationMin: 20 });
    expect(result.ok).toBe(true);
    expect(result.summary).toContain('Added 3 task(s)');
    expect(result.summary).toContain('local fallback se add kar diye');
    const ids = store.get().dynamicTaskBank.map((e) => e.id);
    expect(ids).toContain('ai-pehla');
    expect(ids).toContain('ai-dusra');
    expect(store.get().dynamicTaskBank.map((e) => e.title)).toContain('bogus');
  });

  it('bulkAddTasks falls back to local tasks when every AI intent fails', async () => {
    const store = makeStore();
    const { tools, taskGeneration } = makeTools(store);
    taskGeneration.generate = async () => {
      throw new Error('generate failed');
    };
    const result = await tools.run({ action: 'bulkAddTasks', day: 3, intents: ['a', 'b'], durationMin: 20 });
    expect(result.ok).toBe(true);
    expect(result.summary).toContain('Added 2 task(s)');
    expect(store.get().dynamicTaskBank.map((t) => t.title)).toEqual(['a', 'b']);
  });

  it('accepts and runs up to 100 tool actions in one batch', async () => {
    const store = makeStore();
    const { tools, taskGeneration } = makeTools(store);
    taskGeneration.generate = async (_state, input) => ({
      entry: parseTaskBankEntry({
        id: `ai-${input.intent}`,
        habitId: 'h1',
        title: input.intent,
        description: 'added via chat tool',
        phase: 'jee-core',
        difficulty: 2,
        estimatedDurationMin: input.durationMin ?? 20,
        energyLevel: 'low',
        tags: [],
        prerequisites: [],
        taskType: 'Beginner',
        revisionSuitability: 0.2,
        backlogSuitability: 0.2,
        thinkingSkills: ['recall'],
        jeeRelevance: { subject: 'physics', score: 0.5 },
        unlockConditions: [{ type: 'day-exact', day: input.dayNumber ?? 1 }],
        active: true,
      }),
      source: 'ai',
    });
    const actions = Array.from({ length: 100 }, (_, i) => ({ action: 'addTask' as const, day: 3, intent: `task-${i}`, durationMin: 20 }));
    const result = await tools.runMany(actions);
    expect(result.ok).toBe(true);
    expect(store.get().dynamicTaskBank).toHaveLength(100);
  });

  it('parses 100-action wrappers without dropping valid actions', () => {
    const store = makeStore();
    const { tools } = makeTools(store);
    const actions = Array.from({ length: 100 }, (_, i) => ({ action: 'addTask', day: 3, intent: `task-${i}`, durationMin: 20 }));
    expect(tools.parseTools(JSON.stringify({ actions }))).toHaveLength(100);
    expect(tools.parseTools(JSON.stringify(actions))).toHaveLength(100);
  });

  it('smoke-tests task bank view/edit/delete tools end-to-end', async () => {
    const store = makeStore();
    const { tools } = makeTools(store);

    const add = await tools.run({ action: 'addTask', day: 4, intent: 'chemistry revision dummy', durationMin: 25, tags: ['chemistry'] });
    expect(add.ok).toBe(true);
    const taskId = store.get().dynamicTaskBank[0].id;

    const allTasks = await tools.run({ action: 'getAllTasks', day: 4 });
    expect(allTasks.ok).toBe(true);
    expect(allTasks.summary).toContain(taskId);

    const bank = await tools.run({ action: 'getTaskBank', category: 'chemistry' });
    expect(bank.ok).toBe(true);
    expect(bank.summary).toContain(taskId);

    const edit = await tools.run({ action: 'editAnyTask', taskId, title: 'Updated chemistry revision', durationMin: 35, category: 'revision' });
    expect(edit.ok).toBe(true);
    expect(store.get().dynamicTaskBank[0]).toMatchObject({ title: 'Updated chemistry revision', estimatedDurationMin: 35 });

    const preview = await tools.run({ action: 'deleteAnyTask', taskId });
    expect(preview.requiresConfirmation).toBe(true);
    expect(store.get().dynamicTaskBank).toHaveLength(1);

    const deleted = await tools.run({ action: 'deleteAnyTask', taskId, confirmed: true });
    expect(deleted.ok).toBe(true);
    expect(store.get().dynamicTaskBank).toHaveLength(0);
  });

  it('addTask defaults the duration when the model omits durationMin', async () => {
    const store = makeStore();
    const { tools, taskGeneration } = makeTools(store);
    // Force the local-fallback path so the tool itself applies the default.
    taskGeneration.generate = async () => { throw new Error('provider down'); };
    const result = await tools.run({ action: 'addTask', day: 3, intent: 'no duration task' });
    expect(result.ok).toBe(true);
    const added = store.get().dynamicTaskBank.find((e) => e.title === 'no duration task');
    expect(added).toBeDefined();
    expect(added?.estimatedDurationMin).toBe(45);
  });

  it('bulkAddTasks defaults the duration when the model omits durationMin', async () => {
    const store = makeStore();
    const { tools, taskGeneration } = makeTools(store);
    // Force the local-fallback path so the tool itself applies the default.
    taskGeneration.generate = async () => { throw new Error('provider down'); };
    const result = await tools.run({ action: 'bulkAddTasks', day: 3, intents: ['no duration task'] });
    expect(result.ok).toBe(true);
    const added = store.get().dynamicTaskBank.find((e) => e.title === 'no duration task');
    expect(added).toBeDefined();
    expect(added?.estimatedDurationMin).toBe(45);
  });

  it('markDone on an unlocked-but-unscheduled bank task fails retryable instead of fake-logging', async () => {
    const store = makeStore();
    const { tools } = makeTools(store);
    // d11_t1 exists in the seed bank but only unlocks at Day 11 — on Day 3 it
    // is NOT planned. The old code logged it under Day 3 anyway (fake success);
    // now it must fail retryable with no log written.
    const result = await tools.run({ action: 'markDone', day: 3, taskId: 'd11_t1' });
    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(true);
    expect(result.missingTaskIdDays).toEqual([3]);
    expect(store.get().taskLogs['2026-07-03']?.['d11_t1']).toBeUndefined();
  });

  it('markDone on an unknown id fails retryable and writes nothing', async () => {
    const store = makeStore();
    const { tools } = makeTools(store);
    const result = await tools.run({ action: 'markDone', day: 1, taskId: 'd1_nope' });
    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(true);
    expect(store.get().taskLogs['2026-07-01']?.['d1_nope']).toBeUndefined();
  });

  it('editAnyTask edits a base seed task via an id-matched override', async () => {
    const store = makeStore();
    const { tools } = makeTools(store);
    const result = await tools.run({ action: 'editAnyTask', taskId: 'd1_t1', title: 'Physics Fundamentals', durationMin: 50 });
    expect(result.ok).toBe(true);
    const override = store.get().dynamicTaskBank.find((e) => e.id === 'd1_t1');
    expect(override).toMatchObject({ title: 'Physics Fundamentals', estimatedDurationMin: 50, active: true });
  });

  it('deleteAnyTask hides a base seed task with an active:false override', async () => {
    const store = makeStore();
    const { tools } = makeTools(store);
    const preview = await tools.run({ action: 'deleteAnyTask', taskId: 'd1_t1' });
    expect(preview.requiresConfirmation).toBe(true);
    const deleted = await tools.run({ action: 'deleteAnyTask', taskId: 'd1_t1', confirmed: true });
    expect(deleted.ok).toBe(true);
    const override = store.get().dynamicTaskBank.find((e) => e.id === 'd1_t1');
    expect(override?.active).toBe(false);
  });

  it('routes uploaded-planner questions to the SAME tools hop and runs getTests/getSubject/getRoutine', async () => {
    const store = makeStore();
    const stateRepo: StateRepository = { load: () => store.get(), save: (s) => store.save(s), clear: () => undefined };
    const taskBankRepo = new TaskBankRepositoryImpl(stateRepo, buildSeed());
    const taskBank = new TaskBankServiceImpl(taskBankRepo);
    const planner = new HabitProgressionService({ taskBank, habits: taskBankRepo, levels: LEVELS, totalDays: TOTAL_DAYS });
    const taskGeneration = { generate: async () => ({ entry: null as never, source: 'ai' as const }) } as unknown as TaskGenerationService;

    const plannerService = new PlannerService(store);
    plannerService.importPlanners(
      JSON.stringify({
        version: 2,
        type: 'levelup-subject-planner',
        planners: [
          { kind: 'test', subject: 'Full Test Schedule', title: 'JEE 2027 Tests', tests: [
            { name: 'Short Test-1', date: '2026-07-10', testType: 'Part Test', pattern: 'JEE Advanced', syllabus: { Physics: ['Electrostatic Potential'], Chemistry: ['Mole Concept'], Maths: ['Matrices (Complete Chapter)'] } },
            { name: 'JEE Main-1', date: '2026-07-28', testType: 'Full Syllabus', pattern: 'JEE Main', syllabus: { Physics: ['Electrostatics of Conductor'] } },
          ] },
          { kind: 'routine', subject: 'Class Timetable', title: 'Lakshya Weekly Routine', routine: [
            { day: 'Monday', slots: [{ time: '06:00 PM - 07:30 PM', activity: 'Physics' }, { time: '08:00 PM - 09:00 PM', activity: 'Maths' }] },
            { day: 'Tuesday', slots: [{ time: '06:00 PM - 07:30 PM', activity: 'Chemistry' }] },
          ] },
        ],
      }),
    );
    const plannerTools = new PlannerToolsService(store, plannerService);
    const tools = new ChatToolsService(store, planner, taskBank, taskGeneration, undefined, plannerTools);

    expect(tools.hasPlannerData()).toBe(true);
    // Planner schedule questions reach the same decision gate as task queries.
    expect(tools.isTaskQuery('tests dekho')).toBe(true);
    expect(tools.isTaskQuery('kal koi test hai kya')).toBe(true);
    expect(tools.isTaskQuery('routine batao')).toBe(true);
    expect(tools.isTaskQuery('monday ko kya class hai')).toBe(true);
    expect(tools.isTaskQuery('physics mein kya kya hai')).toBe(true);
    expect(tools.isTaskQuery('concept samjhao')).toBe(false);

    const tests = await tools.run({ action: 'getTests', from: '2026-07-01', to: '2026-07-15' });
    expect(tests.ok).toBe(true);
    expect(tests.summary).toContain('Short Test-1');
    expect(tests.summary).not.toContain('JEE Main-1');

    const routine = await tools.run({ action: 'getRoutine', day: 'Monday' });
    expect(routine.ok).toBe(true);
    expect(routine.summary).toContain('Physics');

    const subject = await tools.run({ action: 'getSubject', subject: 'Physics' });
    expect(subject.ok).toBe(true);
    expect(subject.summary).toContain('Short Test-1');
    expect(subject.summary).toContain('JEE Main-1');

    const missing = await tools.run({ action: 'getTests', from: '2026-09-01', to: '2026-09-30' });
    expect(missing.ok).toBe(false);
    expect(missing.retryable).toBe(true);
  });

  it('resolves unambiguous planner questions deterministically (no LLM needed)', async () => {
    const store = makeStore();
    const stateRepo: StateRepository = { load: () => store.get(), save: (s) => store.save(s), clear: () => undefined };
    const taskBankRepo = new TaskBankRepositoryImpl(stateRepo, buildSeed());
    const taskBank = new TaskBankServiceImpl(taskBankRepo);
    const planner = new HabitProgressionService({ taskBank, habits: taskBankRepo, levels: LEVELS, totalDays: TOTAL_DAYS });
    const taskGeneration = { generate: async () => ({ entry: null as never, source: 'ai' as const }) } as unknown as TaskGenerationService;

    const plannerService = new PlannerService(store);
    plannerService.importPlanners(
      JSON.stringify({
        version: 2,
        type: 'levelup-subject-planner',
        planners: [
          { kind: 'routine', subject: 'Class Timetable', title: 'Lakshya Weekly Routine', routine: [
            { day: 'Friday', slots: [{ time: '04:00 PM - 05:45 PM', activity: 'Physics' }, { time: '06:15 PM - 08:00 PM', activity: 'Maths' }] },
          ] },
          { kind: 'test', subject: 'Full Test Schedule', title: 'JEE 2027 Tests', tests: [
            { name: 'Short Test-1', date: '2026-07-10', testType: 'Part Test', pattern: 'JEE Advanced', syllabus: { Physics: ['Electrostatic Potential'] } },
          ] },
          { kind: 'subject', subject: 'Physics', title: 'Class 11 Physics', items: [{ title: 'Kinematics', type: 'chapter', week: 1 }] },
        ],
      }),
    );
    const plannerTools = new PlannerToolsService(store, plannerService);
    const tools = new ChatToolsService(store, planner, taskBank, taskGeneration, undefined, plannerTools);
    const today = '2026-08-05';

    expect(tools.plannerActionFor('friday ka schedule batao', today)).toEqual({ action: 'getRoutine', day: 'Friday' });
    expect(tools.plannerActionFor('routine batao', today)).toEqual({ action: 'getRoutine' });
    expect(tools.plannerActionFor('kal koi test hai kya', today)).toEqual({ action: 'getTests', from: '2026-08-06', to: '2026-08-06' });
    expect(tools.plannerActionFor('physics mein kya kya hai', today)).toEqual({ action: 'getSubject', subject: 'Physics' });
    // A guessed subject that is NOT in the data falls back to the LLM hop.
    expect(tools.plannerActionFor('biology mein kya kya hai', today)).toBeNull();
    expect(tools.plannerActionFor('concept samjhao', today)).toBeNull();
  });

  it('routes date-range phrasing to getDay and runs getDay/getPlanner ranges', async () => {
    const store = makeStore();
    const stateRepo: StateRepository = { load: () => store.get(), save: (s) => store.save(s), clear: () => undefined };
    const taskBankRepo = new TaskBankRepositoryImpl(stateRepo, buildSeed());
    const taskBank = new TaskBankServiceImpl(taskBankRepo);
    const planner = new HabitProgressionService({ taskBank, habits: taskBankRepo, levels: LEVELS, totalDays: TOTAL_DAYS });
    const taskGeneration = { generate: async () => ({ entry: null as never, source: 'ai' as const }) } as unknown as TaskGenerationService;

    const plannerService = new PlannerService(store);
    plannerService.importPlanners(
      JSON.stringify({
        version: 2,
        type: 'levelup-subject-planner',
        planners: [
          {
            kind: 'routine',
            subject: 'Class Timetable',
            title: 'Lakshya Weekly Routine',
            routine: [{ day: 'Friday', slots: [{ time: '04:00 PM - 05:45 PM', activity: 'Physics' }] }],
          },
          {
            kind: 'test',
            subject: 'Full Test Schedule',
            title: 'JEE 2027 Tests',
            tests: [
              { name: 'Short Test-1', date: '2026-07-10', testType: 'Part Test', pattern: 'JEE Advanced', syllabus: { Physics: ['Electrostatic Potential'] } },
              { name: 'JEE Main-1', date: '2026-07-28', testType: 'Full Syllabus', pattern: 'JEE Main', syllabus: { Physics: ['Electrostatics of Conductor'] } },
            ],
          },
          {
            kind: 'subject',
            subject: 'Maths',
            title: 'Algebra',
            items: [
              { title: 'Determinants', type: 'chapter', week: 4, date: '2026-07-10' },
              { title: 'Matrices', type: 'chapter', week: 5, date: '2026-07-13' },
            ],
          },
        ],
      }),
    );
    const plannerTools = new PlannerToolsService(store, plannerService);
    const tools = new ChatToolsService(store, planner, taskBank, taskGeneration, undefined, plannerTools);
    const today = '2026-08-05';

    // Deterministic range routing — planner-scoped so the LLM hop stays clean.
    expect(tools.plannerActionFor('aaj se 5 din mein kya kya hai', today)).toEqual({ action: 'getDay', from: '2026-08-05', to: '2026-08-09' });
    expect(tools.plannerActionFor('1 se 10 tarikh kya kya hai', today)).toEqual({ action: 'getDay', from: '2026-08-01', to: '2026-08-10' });
    expect(tools.plannerActionFor('1 july se 10 july kya kya hai', today)).toEqual({ action: 'getDay', from: '2026-07-01', to: '2026-07-10' });
    expect(tools.isPlannerQueryOnly('uss din kya kya hai')).toBe(true);
    expect(tools.isPlannerQueryOnly('concept samjhao')).toBe(false);

    // getDay combines that weekday's classes + tests on the date.
    const day = await tools.run({ action: 'getDay', date: '2026-07-10' });
    expect(day.ok).toBe(true);
    expect(day.summary).toContain('Short Test-1');
    expect(day.summary).toContain('Physics');

    // getPlanner range keeps only dated rows inside the window.
    const testPlannerId = plannerService.list().find((p) => p.kind === 'test')!.id;
    const plannerRange = await tools.run({ action: 'getPlanner', plannerId: testPlannerId, from: '2026-07-01', to: '2026-07-15' });
    expect(plannerRange.ok).toBe(true);
    expect(plannerRange.summary).toContain('Short Test-1');
    expect(plannerRange.summary).not.toContain('JEE Main-1');
  });

  it('resolves whole-journey overview questions deterministically to getContext', () => {
    const store = makeStore();
    const { tools } = makeTools(store);

    expect(tools.contextActionFor('mera progress kya hai')).toEqual({ action: 'getContext' });
    expect(tools.contextActionFor('status batao')).toEqual({ action: 'getContext' });
    expect(tools.contextActionFor('context batao')).toEqual({ action: 'getContext' });
    expect(tools.contextActionFor('mera streak kitna hai')).toEqual({ action: 'getContext' });
    expect(tools.contextActionFor('journey ka overview de do')).toEqual({ action: 'getContext' });
    // Explicit plan/test/subject anchors stay on the normal LLM decision hop.
    expect(tools.contextActionFor('day 5 ka summary batao')).toBeNull();
    expect(tools.contextActionFor('aaj ka plan kya hai')).toBeNull();
    expect(tools.contextActionFor('physics revision samjhao')).toBeNull();
    expect(tools.contextActionFor('progress mat dikhao')).toBeNull();
    expect(tools.contextActionFor('status nahi batao')).toBeNull();
    expect(tools.contextActionFor('')).toBeNull();
  });

  it('getContext returns the full journey snapshot deterministically', async () => {
    const store = makeStore();
    const stateRepo: StateRepository = { load: () => store.get(), save: (s) => store.save(s), clear: () => undefined };
    const taskBankRepo = new TaskBankRepositoryImpl(stateRepo, buildSeed());
    const taskBank = new TaskBankServiceImpl(taskBankRepo);
    const planner = new HabitProgressionService({ taskBank, habits: taskBankRepo, levels: LEVELS, totalDays: TOTAL_DAYS });
    const taskGeneration = { generate: async () => ({ entry: null as never, source: 'ai' as const }) } as unknown as TaskGenerationService;
    const now = { now: () => new Date('2026-07-31T10:00:00Z') };
    const tools = new ChatToolsService(store, planner, taskBank, taskGeneration, undefined, null, now);

    const result = await tools.run({ action: 'getContext' });

    expect(result.ok).toBe(true);
    expect(result.summary).toContain('2026-07-31');
    expect(result.summary).toContain('Journey Day');
    expect(result.summary).toContain('Today\'s scheduled tasks');
    expect(result.summary).toContain('Journey so far');
  });

  it('runs a mixed bulk batch: planner tools AND task tools in ONE call', async () => {
    const store = makeStore();
    const stateRepo: StateRepository = { load: () => store.get(), save: (s) => store.save(s), clear: () => undefined };
    const taskBankRepo = new TaskBankRepositoryImpl(stateRepo, buildSeed());
    const taskBank = new TaskBankServiceImpl(taskBankRepo);
    const planner = new HabitProgressionService({ taskBank, habits: taskBankRepo, levels: LEVELS, totalDays: TOTAL_DAYS });
    const taskGeneration = {
      generate: async () => ({
        entry: parseTaskBankEntry({
          id: 'ai-chat-test',
          habitId: 'h1',
          title: 'Chat se add hua task',
          description: 'added via chat tool',
          phase: 'jee-core',
          difficulty: 2,
          estimatedDurationMin: 20,
          energyLevel: 'low',
          tags: [],
          prerequisites: [],
          taskType: 'Beginner',
          revisionSuitability: 0.2,
          backlogSuitability: 0.2,
          thinkingSkills: ['recall'],
          jeeRelevance: { subject: 'physics', score: 0.5 },
          unlockConditions: [{ type: 'day', fromDay: 1 }],
          active: true,
        }),
        source: 'ai',
      }),
    } as unknown as TaskGenerationService;

    const plannerService = new PlannerService(store);
    plannerService.importPlanners(
      JSON.stringify({
        version: 2,
        type: 'levelup-subject-planner',
        planners: [
          { kind: 'routine', subject: 'Class Timetable', title: 'Weekly Routine', routine: [
            { day: 'Monday', slots: [{ time: '04:00 PM - 05:45 PM', activity: 'Physics' }] },
          ] },
          { kind: 'test', subject: 'Full Test Schedule', title: 'Tests', tests: [
            { name: 'Short Test-1', date: '2026-07-10', testType: 'Part Test', pattern: 'JEE Advanced', syllabus: { Physics: ['Electrostatic Potential'] } },
          ] },
        ],
      }),
    );
    const plannerTools = new PlannerToolsService(store, plannerService);
    const tools = new ChatToolsService(store, planner, taskBank, taskGeneration, undefined, plannerTools);

    const result = await tools.runMany([
      { action: 'getRoutine', day: 'Monday' },
      { action: 'getTests' },
      { action: 'addTask', day: 3, intent: 'mixed batch physics revision', durationMin: 30 },
    ]);

    expect(result.ok).toBe(true);
    expect(result.results).toHaveLength(3);
    expect(result.results?.map((r) => r.action)).toEqual(['getRoutine', 'getTests', 'addTask']);
    expect(result.results?.every((r) => r.ok)).toBe(true);
    expect(result.summary).toContain('Physics');
    expect(result.summary).toContain('Short Test-1');
    expect(result.summary).toContain('Chat se add hua task');
    expect(store.get().dynamicTaskBank).toHaveLength(1);
  });

  it('does not route planner questions to a separate hop when no planner data exists', () => {
    const store = makeStore();
    const { tools } = makeTools(store);
    expect(tools.hasPlannerData()).toBe(false);
    expect(tools.isTaskQuery('physics mein kya kya hai')).toBe(false);
    expect(tools.isTaskQuery('concept samjhao')).toBe(false);
  });
});

describe('ChatService with tools', () => {
  it('executes a tool action and streams a Hinglish summary', async () => {
    const store = makeStore();
    const { tools } = makeTools(store);
    const provider = providerWith('{"action":"markDone","day":1,"taskId":"d1_t1"}', 'Ho gaya! Day 1 ka d1_t1 done mark.');
    const chat = makeChat(store, provider, tools);
    const session = chat.createSession();
    const reply = await chat.send(session.id, 'day 1 ka pehla task mark karo');
    expect(reply.content).toBe('Ho gaya! Day 1 ka d1_t1 done mark.');
    expect(store.get().taskLogs['2026-07-01']?.['d1_t1']).toBe(true);
  });

  it('tells the summary model a blocked (unconfirmed) destructive action must NOT be narrated as done', async () => {
    // Regression for: setDayMode (or any confirmationRequired action) without
    // "confirmed":true executes as a blocked ⚠️ preview — nothing actually
    // changes — but the summary-writing model previously had no instruction
    // for the ⚠️ marker (only ❌) and could narrate false success ("rest day
    // mark ho gaya") for an action that never actually applied.
    const store = makeStore();
    const { tools } = makeTools(store);
    let seenSummarySystem = '';
    const provider: LLMProvider = {
      id: 'openrouter' as ProviderId,
      label: 'OpenRouter',
      isConfigured: () => true,
      // No "confirmed":true — this must come back blocked/⚠️, not applied.
      complete: async (): Promise<LLMResponse> => ({ text: '{"action":"setDayMode","day":35,"mode":"rest"}', model: 'a' }),
      stream: async (req: LLMRequest): Promise<LLMResponse> => {
        const sys = req.messages.find((m) => m.role === 'system');
        if (sys && typeof sys.content === 'string') seenSummarySystem = sys.content;
        req.onDelta?.('Rest day banane ke liye confirm karo.');
        return { text: 'Rest day banane ke liye confirm karo.', model: 'a' };
      },
      fetchModels: async (): Promise<ModelInfo[]> => [],
      healthCheck: async (): Promise<HealthCheckResult> => ({ ok: true, provider: 'openrouter', latencyMs: 1 }),
    };
    const chat = makeChat(store, provider, tools);
    const session = chat.createSession();
    await chat.send(session.id, 'day 1 ko rest day bana do');
    // The summary model must be explicitly told what ⚠️ means and told not
    // to claim success for it.
    expect(seenSummarySystem).toContain('⚠️');
    expect(seenSummarySystem).toMatch(/BLOCKED pending confirmation/i);
    expect(seenSummarySystem).toMatch(/has NOT happened yet/i);
    // And the state must genuinely be untouched — nothing was applied.
    expect(store.get().restDays).toEqual([]);
  });

  it('confirmPendingAction("Yes"): replays the exact blocked setDayMode with confirmed:true, no model round-trip for execution', async () => {
    const store = makeStore();
    const { tools } = makeTools(store);
    let calls = 0;
    const provider: LLMProvider = {
      id: 'openrouter' as ProviderId,
      label: 'OpenRouter',
      isConfigured: () => true,
      complete: async (): Promise<LLMResponse> => {
        calls += 1;
        return { text: '{"action":"setDayMode","day":35,"mode":"rest"}', model: 'a' };
      },
      stream: async (req: LLMRequest): Promise<LLMResponse> => {
        req.onDelta?.('Rest day confirm ho gaya.');
        return { text: 'Rest day confirm ho gaya.', model: 'a' };
      },
      fetchModels: async (): Promise<ModelInfo[]> => [],
      healthCheck: async (): Promise<HealthCheckResult> => ({ ok: true, provider: 'openrouter', latencyMs: 1 }),
    };
    const chat = makeChat(store, provider, tools);
    const session = chat.createSession();
    const preview = await chat.send(session.id, 'day 1 ko rest day bana do');
    expect(preview.pendingConfirmation?.kind).toBe('tools');
    expect(store.get().restDays).toEqual([]);
    expect(calls).toBe(1); // only the initial (blocked) decision hop — no retry needed, it parsed fine

    const confirmed = await chat.confirmPendingAction(session.id, preview.id, true);
    expect(calls).toBe(1); // "Yes" did NOT call the model again for the execution itself
    expect(store.get().restDays).toEqual([35]);
    expect(confirmed.content).toBe('Rest day confirm ho gaya.');
    expect(chat.getSession(session.id)?.messages.find((m) => m.id === preview.id)?.pendingConfirmation).toBeUndefined();
  });

  it('confirmPendingAction("No"): cancels without applying anything, and the buttons cannot be tapped twice', async () => {
    const store = makeStore();
    const { tools } = makeTools(store);
    const provider = providerWith('{"action":"setDayMode","day":35,"mode":"rest"}', 'ignored');
    const chat = makeChat(store, provider, tools);
    const session = chat.createSession();
    const preview = await chat.send(session.id, 'day 1 ko rest day bana do');

    const cancelled = await chat.confirmPendingAction(session.id, preview.id, false);
    expect(cancelled.content).toContain('cancel');
    expect(store.get().restDays).toEqual([]);

    // Tapping again (stale UI, double-tap, etc.) must not resurrect it.
    await expect(chat.confirmPendingAction(session.id, preview.id, true)).rejects.toThrow();
    expect(store.get().restDays).toEqual([]);
  });

  describe('every confirmationRequired tool works through the full Yes-button flow', () => {
    // setDayMode is covered above. These cover the rest: removeTask,
    // bulkRemoveTasks, bulkMarkDone, deleteAnyTask, deleteBlock. Each checks
    // the SAME three things: (1) the model's first attempt gets blocked with
    // nothing applied, (2) tapping "Yes" applies it for real with no further
    // model call, (3) the buttons are resolved afterwards.

    it('removeTask', async () => {
      const store = makeStore();
      const { tools } = makeTools(store);
      let calls = 0;
      const provider = providerWith('{"action":"removeTask","day":1,"taskId":"d1_t1"}', 'Task hata diya.');
      const wrapped: LLMProvider = { ...provider, complete: async (req) => { calls += 1; return provider.complete(req); } };
      const chat = makeChat(store, wrapped, tools);
      const session = chat.createSession();
      const preview = await chat.send(session.id, 'day 1 se pehla task hata do');
      expect(preview.pendingConfirmation?.kind).toBe('tools');
      expect(store.get().dynamicTaskBank.some((e) => e.id === 'd1_t1')).toBe(false); // not hidden yet

      const confirmed = await chat.confirmPendingAction(session.id, preview.id, true);
      expect(calls).toBe(1);
      const override = store.get().dynamicTaskBank.find((e) => e.id === 'd1_t1');
      expect(override?.unlockConditions).toEqual([{ type: 'day', fromDay: 1 }, { type: 'not-day', day: 1 }]);
      expect(confirmed.content).toBe('Task hata diya.');
      expect(chat.getSession(session.id)?.messages.find((m) => m.id === preview.id)?.pendingConfirmation).toBeUndefined();
    });

    it('bulkRemoveTasks', async () => {
      const store = makeStore();
      const { tools } = makeTools(store);
      const provider = providerWith('{"action":"bulkRemoveTasks","day":1,"taskIds":["d1_t1","d1_t2"]}', 'Dono tasks hata diye.');
      const chat = makeChat(store, provider, tools);
      const session = chat.createSession();
      const preview = await chat.send(session.id, 'day 1 ke saare tasks hata do');
      expect(preview.pendingConfirmation?.kind).toBe('tools');
      const dayOnePlan = await tools.run({ action: 'getPlan', day: 1 });
      expect(dayOnePlan.summary).toContain('d1_t1');

      const confirmed = await chat.confirmPendingAction(session.id, preview.id, true);
      const afterPlan = await tools.run({ action: 'getPlan', day: 1 });
      expect(afterPlan.summary).not.toContain('id:d1_t1');
      expect(afterPlan.summary).not.toContain('id:d1_t2');
      expect(confirmed.content).toBe('Dono tasks hata diye.');
    });

    it('bulkMarkDone', async () => {
      const store = makeStore();
      const { tools } = makeTools(store);
      const provider = providerWith('{"action":"bulkMarkDone","day":1}', 'Sab tasks done mark kar diye.');
      const chat = makeChat(store, provider, tools);
      const session = chat.createSession();
      const preview = await chat.send(session.id, 'day 1 ke saare tasks done kar do');
      expect(preview.pendingConfirmation?.kind).toBe('tools');
      expect(store.get().taskLogs['2026-07-01']).toBeUndefined();

      const confirmed = await chat.confirmPendingAction(session.id, preview.id, true);
      expect(store.get().taskLogs['2026-07-01']?.['d1_t1']).toBe(true);
      expect(confirmed.content).toBe('Sab tasks done mark kar diye.');
    });

    it('deleteAnyTask', async () => {
      const store = makeStore();
      const { tools } = makeTools(store);
      const provider = providerWith('{"action":"deleteAnyTask","taskId":"d1_t1"}', 'Task bank se hata diya.');
      const chat = makeChat(store, provider, tools);
      const session = chat.createSession();
      const preview = await chat.send(session.id, 'd1_t1 ko task bank se permanently delete karo');
      expect(preview.pendingConfirmation?.kind).toBe('tools');
      expect(store.get().dynamicTaskBank.some((e) => e.id === 'd1_t1')).toBe(false);

      const confirmed = await chat.confirmPendingAction(session.id, preview.id, true);
      const override = store.get().dynamicTaskBank.find((e) => e.id === 'd1_t1');
      expect(override?.active).toBe(false); // base seed task hidden, not mutated
      expect(confirmed.content).toBe('Task bank se hata diya.');
    });

    it('deleteBlock', async () => {
      const store = makeStore();
      const { tools } = makeTools(store);
      await tools.run({ action: 'createBlock', name: 'Physics Block', days: 7, focusAreas: ['physics'], difficulty: 'medium' });
      const blockId = store.get().postJourney.customPhases[0].id;
      const provider = providerWith(`{"action":"deleteBlock","blockId":"${blockId}"}`, 'Block delete kar diya.');
      const chat = makeChat(store, provider, tools);
      const session = chat.createSession();
      const preview = await chat.send(session.id, 'ye block delete kar do');
      expect(preview.pendingConfirmation?.kind).toBe('tools');
      expect(store.get().postJourney.customPhases).toHaveLength(1);

      const confirmed = await chat.confirmPendingAction(session.id, preview.id, true);
      expect(store.get().postJourney.customPhases).toHaveLength(0);
      expect(confirmed.content).toBe('Block delete kar diya.');
    });
  });

  it('activateBlock switches the active custom block (no confirmation needed — reversible)', async () => {
    const store = makeStore();
    const { tools } = makeTools(store);
    await tools.run({ action: 'createBlock', name: 'Physics Block', days: 7, focusAreas: ['physics'], difficulty: 'medium' });
    await tools.run({ action: 'createBlock', name: 'Chemistry Block', days: 7, focusAreas: ['chemistry'], difficulty: 'medium' });
    const [physicsId, chemId] = store.get().postJourney.customPhases.map((b) => b.id);
    // createBlock auto-activates the most recently created one.
    expect(store.get().postJourney.activeCustomPhaseId).toBe(chemId);

    const result = await tools.run({ action: 'activateBlock', blockId: physicsId });
    expect(result.ok).toBe(true);
    expect(store.get().postJourney.activeCustomPhaseId).toBe(physicsId);
    expect(store.get().postJourney.journeyComplete).toBe(true);

    const missing = await tools.run({ action: 'activateBlock', blockId: 'no-such-id' });
    expect(missing.ok).toBe(false);
    expect(missing.retryable).toBe(true);
  });

  it('runs getRoutine deterministically for "friday ka schedule batao" even when the model is broken', async () => {
    const store = makeStore();
    const stateRepo: StateRepository = { load: () => store.get(), save: (s) => store.save(s), clear: () => undefined };
    const taskBankRepo = new TaskBankRepositoryImpl(stateRepo, buildSeed());
    const taskBank = new TaskBankServiceImpl(taskBankRepo);
    const planner = new HabitProgressionService({ taskBank, habits: taskBankRepo, levels: LEVELS, totalDays: TOTAL_DAYS });
    const taskGeneration = { generate: async () => ({ entry: null as never, source: 'ai' as const }) } as unknown as TaskGenerationService;
    const plannerService = new PlannerService(store);
    plannerService.importPlanners(
      JSON.stringify({
        version: 2,
        type: 'levelup-subject-planner',
        planners: [
          { kind: 'routine', subject: 'Class Timetable', title: 'Weekly Routine', routine: [
            { day: 'Friday', slots: [{ time: '04:00 PM - 05:45 PM', activity: 'Physics' }, { time: '06:15 PM - 08:00 PM', activity: 'Maths' }] },
          ] },
        ],
      }),
    );
    const plannerTools = new PlannerToolsService(store, plannerService);
    const tools = new ChatToolsService(store, planner, taskBank, taskGeneration, undefined, plannerTools);

    let completeCalled = false;
    const provider: LLMProvider = {
      id: 'openrouter' as ProviderId,
      label: 'OpenRouter',
      isConfigured: () => true,
      // A broken model: decision hop would return prose, not JSON.
      complete: async (): Promise<LLMResponse> => {
        completeCalled = true;
        return { text: 'Main aapko Friday ka plan bata deta hoon.', model: 'a' };
      },
      stream: async (_req: LLMRequest): Promise<LLMResponse> => {
        return { text: 'Friday ka class schedule: 04:00-05:45 Physics, 06:15-08:00 Maths.', model: 'a' };
      },
      fetchModels: async (): Promise<ModelInfo[]> => [],
      healthCheck: async (): Promise<HealthCheckResult> => ({ ok: true, provider: 'openrouter', latencyMs: 1 }),
    };
    const chat = makeChat(store, provider, tools);
    const session = chat.createSession();

    const reply = await chat.send(session.id, 'friday ka schedule batao');

    // The deterministic fast path never asked the LLM for a decision.
    expect(completeCalled).toBe(false);
    expect(reply.tool).toBe('getRoutine');
    expect(reply.toolCalls?.[0]).toMatchObject({ action: 'getRoutine', ok: true });
    expect(reply.content).toContain('Physics');
    expect(reply.content).not.toContain('"action"');
  });

  it('runs getContext deterministically for "mera progress kya hai" even when the model is broken', async () => {
    const store = makeStore();
    const stateRepo: StateRepository = { load: () => store.get(), save: (s) => store.save(s), clear: () => undefined };
    const taskBankRepo = new TaskBankRepositoryImpl(stateRepo, buildSeed());
    const taskBank = new TaskBankServiceImpl(taskBankRepo);
    const planner = new HabitProgressionService({ taskBank, habits: taskBankRepo, levels: LEVELS, totalDays: TOTAL_DAYS });
    const taskGeneration = { generate: async () => ({ entry: null as never, source: 'ai' as const }) } as unknown as TaskGenerationService;
    const now = { now: () => new Date('2026-07-31T10:00:00Z') };
    const tools = new ChatToolsService(store, planner, taskBank, taskGeneration, undefined, null, now);

    let completeCalled = false;
    const provider: LLMProvider = {
      id: 'openrouter' as ProviderId,
      label: 'OpenRouter',
      isConfigured: () => true,
      // A broken model: decision hop would return prose, not JSON.
      complete: async (): Promise<LLMResponse> => {
        completeCalled = true;
        return { text: 'Main aapko progress bata deta hoon.', model: 'a' };
      },
      stream: async (_req: LLMRequest): Promise<LLMResponse> => {
        return { text: 'Aapki journey Day 30 par hai.', model: 'a' };
      },
      fetchModels: async (): Promise<ModelInfo[]> => [],
      healthCheck: async (): Promise<HealthCheckResult> => ({ ok: true, provider: 'openrouter', latencyMs: 1 }),
    };
    const chat = makeChat(store, provider, tools);
    const session = chat.createSession();

    const reply = await chat.send(session.id, 'mera progress kya hai');

    // The deterministic fast path never asked the LLM for a decision.
    expect(completeCalled).toBe(false);
    expect(reply.tool).toBe('getContext');
    expect(reply.toolCalls?.[0]).toMatchObject({ action: 'getContext', ok: true });
    expect(reply.content).toContain('Day 30');
    expect(reply.content).not.toContain('"action"');
  });

  it('delivers a normal answer directly when the model does not emit a tool action', async () => {
    const store = makeStore();
    const { tools } = makeTools(store);
    let streamCalled = false;
    const provider: LLMProvider = {
      id: 'openrouter' as ProviderId,
      label: 'OpenRouter',
      isConfigured: () => true,
      complete: async (): Promise<LLMResponse> => ({ text: 'Plan bata deta hoon: konse din kya karna hai.', model: 'a' }),
      stream: async (_req: LLMRequest): Promise<LLMResponse> => {
        streamCalled = true;
        return { text: 'nope', model: 'a' };
      },
      fetchModels: async (): Promise<ModelInfo[]> => [],
      healthCheck: async (): Promise<HealthCheckResult> => ({ ok: true, provider: 'openrouter', latencyMs: 1 }),
    };
    const chat = makeChat(store, provider, tools);
    const session = chat.createSession();
    const reply = await chat.send(session.id, 'mere tasks kya hain?');
    expect(reply.content).toContain('konse din');
    expect(streamCalled).toBe(false);
  });

  it('executes Python-style tool calls from a Python-trained model and never leaks them', async () => {
    const store = makeStore();
    const { tools } = makeTools(store);
    const provider: LLMProvider = {
      id: 'openrouter' as ProviderId,
      label: 'OpenRouter',
      isConfigured: () => true,
      // A Python/agent-trained model answers the decision hop with print() calls.
      complete: async (): Promise<LLMResponse> => ({
        text: 'print(addTask(day=3, intent="physics revision", durationMin=40))',
        model: 'a',
      }),
      stream: async (_req: LLMRequest): Promise<LLMResponse> => {
        return { text: 'Day 3 mein physics revision add ho gaya.', model: 'a' };
      },
      fetchModels: async (): Promise<ModelInfo[]> => [],
      healthCheck: async (): Promise<HealthCheckResult> => ({ ok: true, provider: 'openrouter', latencyMs: 1 }),
    };
    const chat = makeChat(store, provider, tools);
    const session = chat.createSession();

    const reply = await chat.send(session.id, 'day 3 mein physics revision add karo');

    expect(reply.tool).toBe('addTask');
    expect(reply.toolCalls?.[0]).toMatchObject({ action: 'addTask', ok: true });
    // The action really ran...
    expect(store.get().dynamicTaskBank.some((t) => t.id === 'ai-chat-test')).toBe(true);
    // ...and the print() call never reached the user.
    expect(reply.content).toContain('add ho gaya');
    expect(reply.content).not.toContain('print(');
    expect(reply.content).not.toContain('removeTask');
    expect(reply.content).not.toContain('"action"');
  });

  it('sends file attachments straight to the model — skips the tool decision hop', async () => {
    const restore = stubBlobUtils();
    try {
      const store = makeStore();
      const { tools } = makeTools(store);
      let completeCalled = false;
      let streamCalled = false;
      let lastRequest: LLMRequest | null = null;
      const provider: LLMProvider = {
        id: 'openrouter' as ProviderId,
        label: 'OpenRouter',
        isConfigured: () => true,
        complete: async (): Promise<LLMResponse> => {
          completeCalled = true;
          return { text: '', model: 'a' };
        },
        stream: async (req: LLMRequest): Promise<LLMResponse> => {
          streamCalled = true;
          lastRequest = req;
          return { text: 'PDF ka analysis:', model: 'a' };
        },
        fetchModels: async (): Promise<ModelInfo[]> => [],
        healthCheck: async (): Promise<HealthCheckResult> => ({ ok: true, provider: 'openrouter', latencyMs: 1 }),
      };
      const chat = makeChat(store, provider, tools);
      const session = chat.createSession();
      // "concept" is a TASK_QUERY_WORD — without the routing fix this message
      // would hit the JSON tool decision hop (complete) instead of the real
      // chat completion (stream), and a PDF could never reach the model.
      const reply = await chat.send(
        session.id,
        'Is PDF ka concept samjhao',
        undefined,
        undefined,
        undefined,
        undefined,
        [{ id: 'a1', name: 'notes.pdf', kind: 'file', previewUrl: 'blob:fake-pdf' }],
      );
      expect(completeCalled).toBe(false);
      expect(streamCalled).toBe(true);
      expect(reply.content).toBe('PDF ka analysis:');
      const lastUser = lastRequest!.messages.filter((m) => m.role === 'user').pop()!;
      const parts = lastUser.content as ContentPart[];
      expect(parts.some((p) => p.type === 'file')).toBe(true);
    } finally {
      restore();
    }
  });
});

describe('model self-confirmation is structurally impossible (strip "confirmed" from parsed actions)', () => {
  it('blocks a mixed add+delete batch even when the model emits confirmed:true on its own', async () => {
    const store = makeStore();
    const { tools } = makeTools(store);
    // User asks "add + delete". A model that "helpfully" decides the user
    // already agreed emits removeTask WITH confirmed:true — before the strip
    // that silently ran the delete (no buttons, no preview). Now the whole
    // batch must land in the blocked preview + Yes/No button flow.
    const provider = providerWith(
      '{"actions":[{"action":"addTask","day":1,"intent":"maths 10 questions","durationMin":30},{"action":"removeTask","day":1,"taskId":"d1_t1","confirmed":true}]}',
      'Sab kuch ho gaya.',
    );
    const chat = makeChat(store, provider, tools);
    const session = chat.createSession();
    const preview = await chat.send(session.id, 'day 1 mein maths add karo aur d1_t1 hata do');

    // NOTHING applied: the add is blocked along with the delete (all-or-nothing),
    // d1_t1 is not hidden yet, and the tap-carrying actions have no confirmed set.
    expect(preview.pendingConfirmation?.kind).toBe('tools');
    expect(preview.pendingConfirmation?.actions).toHaveLength(2);
    expect(preview.pendingConfirmation?.actions.every((a) => !('confirmed' in a) || a.confirmed !== true)).toBe(true);
    const before = await tools.run({ action: 'getPlan', day: 1 });
    expect(before.summary).toContain('d1_t1'); // not hidden yet

    // Only the user's tap applies the WHOLE batch (add + delete).
    const confirmed = await chat.confirmPendingAction(session.id, preview.id, true);
    expect(confirmed.content).toBe('Sab kuch ho gaya.');
    const after = await tools.run({ action: 'getPlan', day: 1 });
    expect(after.summary).toContain('ai-chat-test'); // add applied
    expect(after.summary).not.toContain('d1_t1'); // delete applied
  });

  it('parseTools drops confirmed from single, batch and bare-array replies', () => {
    const { tools } = makeTools(makeStore());
    const single = tools.parseTools('{"action":"removeTask","day":1,"taskId":"d1_t1","confirmed":true}');
    expect(single).toHaveLength(1);
    expect(single[0]).not.toMatchObject({ confirmed: true });
    const batch = tools.parseTools('{"actions":[{"action":"removeTask","day":1,"taskId":"d1_t1","confirmed":true}]}');
    expect(batch[0]).not.toMatchObject({ confirmed: true });
    const arr = tools.parseTools('[{"action":"removeTask","day":1,"taskId":"d1_t1","confirmed":true}]');
    expect(arr[0]).not.toMatchObject({ confirmed: true });
  });
});

describe('ChatService tool retry + reasoning', () => {
  it('retries the decision hop once when the model refuses with prose', async () => {
    const store = makeStore();
    const { tools } = makeTools(store);
    let calls = 0;
    const provider: LLMProvider = {
      id: 'openrouter' as ProviderId,
      label: 'OpenRouter',
      isConfigured: () => true,
      complete: async (): Promise<LLMResponse> => {
        calls += 1;
        if (calls === 1) return { text: 'Main tasks delete nahi kar sakta. Skip karke chalo.', model: 'a' };
        return { text: '{"action":"removeTask","day":1,"taskId":"d1_t1","confirmed":true}', model: 'a' };
      },
      stream: async (req: LLMRequest): Promise<LLMResponse> => {
        req.onDelta?.('Hata diya.');
        return { text: 'Hata diya.', model: 'a' };
      },
      fetchModels: async (): Promise<ModelInfo[]> => [],
      healthCheck: async (): Promise<HealthCheckResult> => ({ ok: true, provider: 'openrouter', latencyMs: 1 }),
    };
    const chat = makeChat(store, provider, tools);
    const session = chat.createSession();
    const reply = await chat.send(session.id, 'aaj ka d1_t1 task delete karo');
    expect(calls).toBe(2);
    // The retried action is destructive, so it must land in the blocked
    // preview + Yes/No flow — the model's own "confirmed":true is stripped and
    // NOTHING is applied until the user taps Yes.
    expect(reply.pendingConfirmation?.kind).toBe('tools');
    expect(reply.pendingConfirmation?.actions).toHaveLength(1);
    expect(reply.pendingConfirmation?.actions[0]).toMatchObject({ action: 'removeTask' });
    expect(reply.pendingConfirmation?.actions[0]).not.toMatchObject({ confirmed: true });
    const planBefore = await tools.run({ action: 'getPlan', day: 1 });
    expect(planBefore.summary).toContain('d1_t1'); // not hidden yet
    // The user's Yes (not the model) is the only path that applies it.
    const confirmed = await chat.confirmPendingAction(session.id, reply.id, true);
    expect(confirmed.content).toBe('Hata diya.');
    expect(confirmed.toolCalls).toHaveLength(1);
    expect(confirmed.toolCalls?.[0]).toMatchObject({ action: 'removeTask', ok: true });
    const planAfter = await tools.run({ action: 'getPlan', day: 1 });
    expect(planAfter.summary).not.toContain('d1_t1');
  });

  it('retry prompt names the exact missing field when the model half-attempts a tool call, so it can self-correct', async () => {
    const store = makeStore();
    const { tools } = makeTools(store);
    let calls = 0;
    const seenSystemPrompts: string[] = [];
    const provider: LLMProvider = {
      id: 'openrouter' as ProviderId,
      label: 'OpenRouter',
      isConfigured: () => true,
      complete: async (req: LLMRequest): Promise<LLMResponse> => {
        calls += 1;
        const sys = req.messages.find((m) => m.role === 'system');
        if (sys && typeof sys.content === 'string') seenSystemPrompts.push(sys.content);
        // Turn 1: forgets the required "mode" field on setDayMode.
        if (calls === 1) return { text: '{"action":"setDayMode","day":35}', model: 'a' };
        // Turn 2 (retry): corrects itself using the specific feedback.
        return { text: '{"action":"setDayMode","day":35,"mode":"rest","confirmed":true}', model: 'a' };
      },
      stream: async (req: LLMRequest): Promise<LLMResponse> => {
        req.onDelta?.('Rest day set kar diya.');
        return { text: 'Rest day set kar diya.', model: 'a' };
      },
      fetchModels: async (): Promise<ModelInfo[]> => [],
      healthCheck: async (): Promise<HealthCheckResult> => ({ ok: true, provider: 'openrouter', latencyMs: 1 }),
    };
    const chat = makeChat(store, provider, tools);
    const session = chat.createSession();
    const reply = await chat.send(session.id, 'day 2 ko rest day bana do, confirm hai');
    expect(calls).toBe(2);
    // The retry prompt must call out the actual problem (missing "mode"),
    // not the generic "you answered with normal text" nudge — that framing
    // is wrong here since the model DID attempt JSON.
    expect(seenSystemPrompts[1]).toMatch(/mode/i);
    expect(seenSystemPrompts[1]).not.toMatch(/you (just )?answered with normal text/i);
    // setDayMode is destructive → the corrected attempt is previewed (its
    // own confirmed:true is stripped) and NOT applied until the user taps Yes.
    expect(reply.pendingConfirmation?.kind).toBe('tools');
    expect(reply.pendingConfirmation?.actions).toHaveLength(1);
    expect(reply.pendingConfirmation?.actions[0]).toMatchObject({ action: 'setDayMode', day: 35, mode: 'rest' });
    expect(reply.pendingConfirmation?.actions[0]).not.toMatchObject({ confirmed: true });
    expect(store.get().restDays).toEqual([]);
    // The user's tap is the only path that marks the day rest.
    await chat.confirmPendingAction(session.id, reply.id, true);
    expect(store.get().restDays).toEqual([35]);
    expect(reply.tool).toBe('setDayMode');
  });

  it('auto-fetches the day plan and replans when the model guesses a wrong task id', async () => {
    const store = makeStore();
    const { tools } = makeTools(store);
    let calls = 0;
    const provider: LLMProvider = {
      id: 'openrouter' as ProviderId,
      label: 'OpenRouter',
      isConfigured: () => true,
      complete: async (): Promise<LLMResponse> => {
        calls += 1;
        if (calls === 1) return { text: '{"action":"editTask","day":1,"taskId":"d1_bogus","durationMin":25}', model: 'a' };
        return { text: '{"action":"editTask","day":1,"taskId":"d1_t1","durationMin":25}', model: 'a' };
      },
      stream: async (req: LLMRequest): Promise<LLMResponse> => {
        req.onDelta?.('Edit kar diya.');
        return { text: 'Edit kar diya.', model: 'a' };
      },
      fetchModels: async (): Promise<ModelInfo[]> => [],
      healthCheck: async (): Promise<HealthCheckResult> => ({ ok: true, provider: 'openrouter', latencyMs: 1 }),
    };
    const chat = makeChat(store, provider, tools);
    const session = chat.createSession();
    const reply = await chat.send(session.id, 'day 1 ka pehla task 25 min ka kar do');
    expect(calls).toBe(2);
    expect(reply.content).toBe('Edit kar diya.');
    const override = store.get().dynamicTaskBank.find((e) => e.id === 'd1_t1');
    expect(override?.estimatedDurationMin).toBe(25);
  });

  it('keeps partial non-destructive mutations when the replan also fails', async () => {
    const store = makeStore();
    const { tools } = makeTools(store);
    let calls = 0;
    const provider: LLMProvider = {
      id: 'openrouter' as ProviderId,
      label: 'OpenRouter',
      isConfigured: () => true,
      complete: async (): Promise<LLMResponse> => {
        calls += 1;
        if (calls === 1) return { text: '{"actions":[{"action":"addTask","day":3,"intent":"pehla","durationMin":20},{"action":"editTask","day":3,"taskId":"bad","durationMin":25}]}', model: 'a' };
        return { text: 'koi tool nahi, bas prose', model: 'a' };
      },
      stream: async (req: LLMRequest): Promise<LLMResponse> => {
        req.onDelta?.('Nahi ho paya.');
        return { text: 'Nahi ho paya.', model: 'a' };
      },
      fetchModels: async (): Promise<ModelInfo[]> => [],
      healthCheck: async (): Promise<HealthCheckResult> => ({ ok: true, provider: 'openrouter', latencyMs: 1 }),
    };
    const chat = makeChat(store, provider, tools);
    const session = chat.createSession();
    const reply = await chat.send(session.id, 'day 3 mein task add karo aur edit karo');
    expect(calls).toBe(2);
    expect(reply.content).toBe('Nahi ho paya.');
    // The addTask that succeeded before the guessed-id failure stays applied.
    expect(store.get().dynamicTaskBank.some((e) => e.id === 'ai-chat-test')).toBe(true);
  });

  it('feeds a retryable non-id tool error back so the model can fix and re-emit', async () => {
    const store = makeStore();
    const { tools } = makeTools(store);
    let calls = 0;
    let sawErrorFeedback = false;
    const provider: LLMProvider = {
      id: 'openrouter' as ProviderId,
      label: 'OpenRouter',
      isConfigured: () => true,
      complete: async (req: LLMRequest): Promise<LLMResponse> => {
        calls += 1;
        if (calls === 1) return { text: '{"action":"editBlock","blockId":"block-bogus","days":5}', model: 'a' };
        const lastUser = req.messages.filter((m) => m.role === 'user').pop();
        const content = typeof lastUser?.content === 'string' ? lastUser.content : '';
        if (content.includes('Failed actions and errors')) sawErrorFeedback = true;
        return { text: '{"action":"listBlocks"}', model: 'a' };
      },
      stream: async (req: LLMRequest): Promise<LLMResponse> => {
        req.onDelta?.('Dekh rahe hain.');
        return { text: 'Dekh rahe hain.', model: 'a' };
      },
      fetchModels: async (): Promise<ModelInfo[]> => [],
      healthCheck: async (): Promise<HealthCheckResult> => ({ ok: true, provider: 'openrouter', latencyMs: 1 }),
    };
    const chat = makeChat(store, provider, tools);
    const session = chat.createSession();
    const reply = await chat.send(session.id, 'block-bogus ko 5 din extend karo');
    expect(calls).toBe(2);
    expect(sawErrorFeedback).toBe(true);
    expect(reply.content).toBe('Dekh rahe hain.');
    expect(reply.tool).toBe('listBlocks');
  });

  it('stops retrying when the error-feedback hop also fails to emit JSON', async () => {
    const store = makeStore();
    const { tools } = makeTools(store);
    let calls = 0;
    const provider: LLMProvider = {
      id: 'openrouter' as ProviderId,
      label: 'OpenRouter',
      isConfigured: () => true,
      complete: async (): Promise<LLMResponse> => {
        calls += 1;
        if (calls === 1) return { text: '{"action":"editBlock","blockId":"block-bogus","days":5}', model: 'a' };
        return { text: 'mujhe nahi pata, prose hi bhej raha hoon', model: 'a' };
      },
      stream: async (req: LLMRequest): Promise<LLMResponse> => {
        req.onDelta?.('Nahi ho paya.');
        return { text: 'Nahi ho paya.', model: 'a' };
      },
      fetchModels: async (): Promise<ModelInfo[]> => [],
      healthCheck: async (): Promise<HealthCheckResult> => ({ ok: true, provider: 'openrouter', latencyMs: 1 }),
    };
    const chat = makeChat(store, provider, tools);
    const session = chat.createSession();
    const reply = await chat.send(session.id, 'block-bogus ko 5 din extend karo');
    expect(calls).toBe(2);
    expect(reply.content).toBe('Nahi ho paya.');
  });

  it('error-retry re-applies the whole batch so a succeeded action is not dropped', async () => {
    const store = makeStore();
    const { tools } = makeTools(store);
    await tools.run({ action: 'createBlock', name: 'Physics Block', days: 7, focusAreas: ['physics'], difficulty: 'medium' });
    const blockId = store.get().postJourney.customPhases[0].id;
    let calls = 0;
    const provider: LLMProvider = {
      id: 'openrouter' as ProviderId,
      label: 'OpenRouter',
      isConfigured: () => true,
      complete: async (): Promise<LLMResponse> => {
        calls += 1;
        if (calls === 1) {
          return { text: '{"actions":[{"action":"addTask","day":3,"intent":"retry batch add","durationMin":20},{"action":"editBlock","blockId":"block-bogus","days":5}]}', model: 'a' };
        }
        // Re-emits the ENTIRE batch with only the failed block id corrected.
        return { text: `{"actions":[{"action":"addTask","day":3,"intent":"retry batch add","durationMin":20},{"action":"editBlock","blockId":"${blockId}","days":5}]}`, model: 'a' };
      },
      stream: async (req: LLMRequest): Promise<LLMResponse> => {
        req.onDelta?.('Dono ho gaye.');
        return { text: 'Dono ho gaye.', model: 'a' };
      },
      fetchModels: async (): Promise<ModelInfo[]> => [],
      healthCheck: async (): Promise<HealthCheckResult> => ({ ok: true, provider: 'openrouter', latencyMs: 1 }),
    };
    const chat = makeChat(store, provider, tools);
    const session = chat.createSession();
    const reply = await chat.send(session.id, 'day 3 mein task add karo aur block ko 5 din badhao');
    expect(calls).toBe(2);
    expect(reply.content).toBe('Dono ho gaye.');
    // The succeeded addTask must survive the retry rollback…
    expect(store.get().dynamicTaskBank.some((e) => e.id === 'ai-chat-test')).toBe(true);
    // …and the corrected editBlock must also apply (91 + 5 - 1 = 95).
    expect(store.get().postJourney.customPhases[0].dayEnd).toBe(95);
  });

  it('captures reasoning on the assistant message and forwards deltas', async () => {
    const store = makeStore();
    const { tools } = makeTools(store);
    const provider: LLMProvider = {
      id: 'openrouter' as ProviderId,
      label: 'OpenRouter',
      isConfigured: () => true,
      complete: async (): Promise<LLMResponse> => ({ text: '{"action":"getPlan","day":1}', model: 'a' }),
      stream: async (req: LLMRequest): Promise<LLMResponse> => {
        req.onReasoningDelta?.('pehle soch raha hoon...');
        req.onDelta?.('Day 1 ka plan 4 tasks ka hai.');
        return { text: 'Day 1 ka plan 4 tasks ka hai.', model: 'a', reasoning: 'pehle soch raha hoon...' };
      },
      fetchModels: async (): Promise<ModelInfo[]> => [],
      healthCheck: async (): Promise<HealthCheckResult> => ({ ok: true, provider: 'openrouter', latencyMs: 1 }),
    };
    const chat = makeChat(store, provider, tools);
    const session = chat.createSession();
    const seenReasoning: string[] = [];
    const reply = await chat.send(
      session.id,
      'day 1 ka plan batao',
      undefined,
      undefined,
      undefined,
      (d) => seenReasoning.push(d),
    );
    expect(reply.reasoning).toBe('pehle soch raha hoon...');
    expect(seenReasoning.join('')).toBe('pehle soch raha hoon...');
  });

  it('reports status while executing tools and passes thinking level', async () => {
    // The active provider offers the pinned model (must be honored by resolveModel).
    const store = makeStore();
    store.save({
      ...store.get(),
      aiSettings: {
        ...store.get().aiSettings,
        providers: {
          openrouter: {
            id: 'openrouter' as ProviderId,
            label: 'OpenRouter',
            model: 'custom-tool-model',
            models: ['custom-tool-model'],
            enabled: true,
          },
        },
      },
    });
    const { tools } = makeTools(store);
    const requests: LLMRequest[] = [];
    const provider: LLMProvider = {
      id: 'openrouter' as ProviderId,
      label: 'OpenRouter',
      isConfigured: () => true,
      complete: async (req: LLMRequest): Promise<LLMResponse> => {
        requests.push(req);
        return { text: '{"action":"getPlan","day":2}', model: 'a' };
      },
      stream: async (req: LLMRequest): Promise<LLMResponse> => {
        requests.push(req);
        req.onDelta?.('day 2 ka plan.');
        return { text: 'day 2 ka plan.', model: 'a' };
      },
      fetchModels: async (): Promise<ModelInfo[]> => [],
      healthCheck: async (): Promise<HealthCheckResult> => ({ ok: true, provider: 'openrouter', latencyMs: 1 }),
    };
    const chat = makeChat(store, provider, tools);
    const session = chat.createSession();
    session.prefs = { ...session.prefs, model: 'custom-tool-model', thinking: 'high' };
    const statuses: string[] = [];
    await chat.send(session.id, 'day 2 ka plan kya hai?', undefined, undefined, (s) => statuses.push(s));
    expect(statuses.join(' | ')).toContain('AI soch raha hai');
    expect(statuses.join(' | ')).toContain('getPlan');
    expect(statuses.join(' | ')).toContain('Jawab likh raha hai');
    // Decision hops stay deterministic JSON (thinking off); only the streamed
    // summary carries the chat's thinking level.
    expect(requests[0].model).toBe('custom-tool-model');
    expect(requests[0].thinking).toBe('off');
    expect(requests[1].thinking).toBe('high');
  });

  it('parseTools accepts a batch wrapper, a bare array and prose-wrapped json', () => {
    const store = makeStore();
    const { tools } = makeTools(store);
    expect(
      tools.parseTools(
        '{"actions":[{"action":"addTask","day":5,"intent":"maths","durationMin":30},{"action":"removeTask","day":5,"taskId":"d1_t1","confirmed":true}]}',
      ),
    ).toEqual([
      { action: 'addTask', day: 5, intent: 'maths', durationMin: 30 },
      { action: 'removeTask', day: 5, taskId: 'd1_t1' },
    ]);
    expect(tools.parseTools('[{"action":"markDone","day":3,"taskId":"d1_t2"}]')).toEqual([
      { action: 'markDone', day: 3, taskId: 'd1_t2' },
    ]);
    expect(tools.parseTools('ok so {"actions":[{"action":"getPlan","day":9}]} done')).toEqual([
      { action: 'getPlan', day: 9 },
    ]);
    // durationMin is optional — an addTask that omits it parses and gets a
    // sensible default at execution time instead of rejecting the whole batch.
    // Model-emitted confirmed is always stripped (the app adds it after Yes).
    expect(tools.parseTools('{"actions":[{"action":"addTask","day":5,"intent":"maths"},{"action":"removeTask","day":5,"taskId":"d1_t1","confirmed":true}]}')).toEqual([
      { action: 'addTask', day: 5, intent: 'maths' },
      { action: 'removeTask', day: 5, taskId: 'd1_t1' },
    ]);
    expect(tools.parseTools('koi json nahi')).toEqual([]);
  });

  it('parseTools converts Python-style tool calls into real actions', () => {
    const store = makeStore();
    const { tools } = makeTools(store);

    expect(
      tools.parseTools(
        'print(removeTask(task_id="d1_t3", day_id="Day 1"))\nprint(removeTask(task_id="d1_t4", day_id="Day 1"))',
      ),
    ).toEqual([
      { action: 'removeTask', day: 1, taskId: 'd1_t3' },
      { action: 'removeTask', day: 1, taskId: 'd1_t4' },
    ]);

    expect(tools.parseTools('removeTask(day=5, task_id="d1_t1", confirmed=True)')).toEqual([
      { action: 'removeTask', day: 5, taskId: 'd1_t1' },
    ]);

    expect(tools.parseTools('bulkAddTasks(day_id="Day 2", intents=["maths 10 questions","thermo revision"], duration_min=30)')).toEqual([
      { action: 'bulkAddTasks', day: 2, intents: ['maths 10 questions', 'thermo revision'], durationMin: 30 },
    ]);

    expect(tools.parseTools('addTask(day=3, intent="physics revision", durationMin=40)')).toEqual([
      { action: 'addTask', day: 3, intent: 'physics revision', durationMin: 40 },
    ]);

    expect(tools.parseTools('getRoutine(day="Monday")')).toEqual([{ action: 'getRoutine', day: 'Monday' }]);
    expect(tools.parseTools('getTests(from="2026-07-01", to="2026-07-31")')).toEqual([
      { action: 'getTests', from: '2026-07-01', to: '2026-07-31' },
    ]);
    expect(tools.parseTools('getContext()')).toEqual([{ action: 'getContext' }]);
    // Unknown/unsupported calls are ignored, not mis-executed.
    expect(tools.parseTools('print(unknownTool(x=1))')).toEqual([]);
  });

  it('runs Python-style tool calls from a broken model as a real batch', async () => {
    const store = makeStore();
    const { tools } = makeTools(store);

    const result = await tools.runMany(
      tools.parseTools('print(addTask(day=3, intent="python call add", durationMin=25))'),
    );

    expect(result.ok).toBe(true);
    // The makeTools stub generates a fixed entry title, but the action itself ran.
    expect(store.get().dynamicTaskBank.some((t) => t.id === 'ai-chat-test')).toBe(true);
  });

  it('runMany applies several actions in order on fresh state', async () => {
    const store = makeStore();
    const { tools } = makeTools(store);
    const result = await tools.runMany([
      { action: 'addTask', day: 3, intent: 'pehla task', durationMin: 20 },
      { action: 'addTask', day: 3, intent: 'dusra task', durationMin: 20 },
      { action: 'markDone', day: 1, taskId: 'd1_t1' },
    ]);
    expect(result.ok).toBe(true);
    expect(result.summary).toContain('Day 3');
    const planDay3 = await tools.run({ action: 'getPlan', day: 3 });
    expect(planDay3.summary).toContain('ai-chat-test');
    const log = store.get().taskLogs['2026-07-03'] ?? store.get().taskLogs['2026-07-01'];
    expect(Object.values(log).some(Boolean)).toBe(true);
  });

  it('runMany previews the WHOLE batch when a destructive action lacks confirmation', async () => {
    const store = makeStore();
    const { tools } = makeTools(store);
    const before = store.get().taskLogs;
    const result = await tools.runMany([
      { action: 'addTask', day: 4, intent: 'add hona chahiye', durationMin: 20 },
      { action: 'removeTask', day: 1, taskId: 'd1_t1' },
    ]);
    expect(result.ok).toBe(false);
    expect(result.requiresConfirmation).toBe(true);
    expect(result.summary).toContain('Preview');
    // Nothing applied: the addTask in the same batch must NOT have run.
    const planDay4 = await tools.run({ action: 'getPlan', day: 4 });
    expect(planDay4.summary).not.toContain('ai-chat-test');
    expect(store.get().taskLogs).toEqual(before);
  });

  it('runMany previews the WHOLE batch when bulkRemoveTasks (bulk-destructive) lacks confirmation — regression for missing ACTIONS registration', async () => {
    const store = makeStore();
    const { tools } = makeTools(store);
    const before = store.get().dynamicTaskBank;
    const result = await tools.runMany([
      { action: 'bulkRemoveTasks', day: 1, taskIds: ['d1_t1', 'd1_t2'] },
      { action: 'addTask', day: 4, intent: 'add hona chahiye', durationMin: 20 },
    ]);
    expect(result.ok).toBe(false);
    expect(result.requiresConfirmation).toBe(true);
    // Nothing applied: the addTask sharing the batch with an unconfirmed
    // bulkRemoveTasks must NOT have run either — whole-batch atomicity.
    const planDay4 = await tools.run({ action: 'getPlan', day: 4 });
    expect(planDay4.summary).not.toContain('ai-chat-test');
    expect(store.get().dynamicTaskBank).toEqual(before);
  });

  it('runMany applies destructive actions once confirmed', async () => {
    const store = makeStore();
    const { tools } = makeTools(store);
    const result = await tools.runMany([
      { action: 'setDayMode', day: 35, mode: 'rest', confirmed: true },
      { action: 'bulkMarkDone', day: 1, taskIds: ['d1_t1', 'd1_t2'], confirmed: true },
    ]);
    expect(result.ok).toBe(true);
    const restPlan = await tools.run({ action: 'getPlan', day: 35 });
    expect(restPlan.summary).toContain('REST');
    const log = store.get().taskLogs['2026-07-01'];
    expect(log['d1_t1']).toBe(true);
    expect(log['d1_t2']).toBe(true);
  });
});

describe('"@" tool scoping', () => {
  it('listTools exposes the full user-pickable catalog with schema-safe ids', () => {
    const store = makeStore();
    const { tools } = makeTools(store);
    const catalog = tools.listTools();
    expect(catalog.length).toBeGreaterThan(0);
    const ids = catalog.map((t) => t.id);
    expect(ids).toContain('addTask');
    expect(ids).toContain('getPlan');
    expect(ids).toContain('getDay');
    // Every entry the picker shows must carry a human label + description.
    for (const t of catalog) {
      expect(t.label.length).toBeGreaterThan(0);
      expect(t.description.length).toBeGreaterThan(0);
    }
  });

  it('resolveToolScope keeps only known ids and drops unknown mentions', () => {
    const store = makeStore();
    const { tools } = makeTools(store);
    expect(tools.resolveToolScope(['getDay', 'listPlanners'])).toEqual(['getDay', 'listPlanners']);
    expect(tools.resolveToolScope(['bogus-tool'])).toEqual([]);
    expect(tools.resolveToolScope(['addTask', 'unknown'])).toEqual(['addTask']);
  });

  it('blocks an out-of-scope action even when the model emits it', async () => {
    const store = makeStore();
    const { tools } = makeTools(store);
    // The model ignores the scope and tries addTask — the pinned set says no.
    const provider: LLMProvider = {
      id: 'openrouter' as ProviderId,
      label: 'OpenRouter',
      isConfigured: () => true,
      complete: async (): Promise<LLMResponse> => ({
        text: 'print(addTask(day=3, intent="physics revision", durationMin=40))',
        model: 'a',
      }),
      stream: async (_req: LLMRequest): Promise<LLMResponse> => ({
        text: 'Day 3 mein physics revision add ho gaya.',
        model: 'a',
      }),
      fetchModels: async (): Promise<ModelInfo[]> => [],
      healthCheck: async (): Promise<HealthCheckResult> => ({ ok: true, provider: 'openrouter', latencyMs: 1 }),
    };
    const chat = makeChat(store, provider, tools);
    const session = chat.createSession();

    // User pinned only the READ-ONLY planner tools via "@".
    const reply = await chat.send(session.id, 'day 3 mein physics revision add karo', undefined, undefined, undefined, undefined, undefined, [
      'getDay',
    ]);

    // Nothing was added — the out-of-scope action never executed.
    expect(reply.tool).toBeUndefined();
    expect(store.get().dynamicTaskBank.some((t) => t.id === 'ai-chat-test')).toBe(false);
    // The tool JSON is scrubbed from the reply (leak sanitizer) — it must not
    // reach the user as fake success either.
    expect(reply.content).not.toContain('addTask');
  });

  it('runs a pinned context fast-path action when the query matches it', async () => {
    const store = makeStore();
    const { tools } = makeTools(store);
    // "mera progress kya hai" resolves deterministically to getContext — and
    // the user pinned getContext, so it must run WITHOUT any LLM round-trip.
    let completeCalled = false;
    const provider: LLMProvider = {
      id: 'openrouter' as ProviderId,
      label: 'OpenRouter',
      isConfigured: () => true,
      complete: async (): Promise<LLMResponse> => {
        completeCalled = true;
        return { text: '', model: 'a' };
      },
      stream: async (_req: LLMRequest): Promise<LLMResponse> => ({ text: 'Day 30 tak ka progress summary', model: 'a' }),
      fetchModels: async (): Promise<ModelInfo[]> => [],
      healthCheck: async (): Promise<HealthCheckResult> => ({ ok: true, provider: 'openrouter', latencyMs: 1 }),
    };
    const chat = makeChat(store, provider, tools);
    const session = chat.createSession();
    const reply = await chat.send(session.id, 'mera progress kya hai', undefined, undefined, undefined, undefined, undefined, ['getContext']);
    expect(reply.tool).toBe('getContext');
    expect(completeCalled).toBe(false);
    expect(reply.content).toContain('Day 30');
  });

  it('skips the fast-path action when its tool is NOT pinned', async () => {
    const store = makeStore();
    const { tools } = makeTools(store);
    const provider: LLMProvider = {
      id: 'openrouter' as ProviderId,
      label: 'OpenRouter',
      isConfigured: () => true,
      complete: async (): Promise<LLMResponse> => ({
        text: 'print(addTask(day=3, intent="physics revision", durationMin=40))',
        model: 'a',
      }),
      stream: async (_req: LLMRequest): Promise<LLMResponse> => ({ text: 'stream', model: 'a' }),
      fetchModels: async (): Promise<ModelInfo[]> => [],
      healthCheck: async (): Promise<HealthCheckResult> => ({ ok: true, provider: 'openrouter', latencyMs: 1 }),
    };
    const chat = makeChat(store, provider, tools);
    const session = chat.createSession();
    // "mera progress kya hai" maps to getContext — user pinned only addTask, so
    // the fast path is skipped and the decision hop runs. The model emits
    // addTask which IS pinned, so it executes (the scope says yes).
    const reply = await chat.send(session.id, 'mera progress kya hai', undefined, undefined, undefined, undefined, undefined, ['addTask']);
    expect(reply.tool).toBe('addTask');
    expect(reply.tool).not.toBe('getContext');
    expect(store.get().dynamicTaskBank.some((t) => t.id === 'ai-chat-test')).toBe(true);
  });

  it('runs EVERY selected tool the request needs — a combined actions array', async () => {
    const store = makeStore();
    const { tools } = makeTools(store);
    // The model answers with an actions array covering BOTH pinned tools:
    // getDay (view) first, then addTask (modify).
    const provider: LLMProvider = {
      id: 'openrouter' as ProviderId,
      label: 'OpenRouter',
      isConfigured: () => true,
      complete: async (): Promise<LLMResponse> => ({
        text: 'print({"actions":[{"action":"getDay","date":"2026-07-31"},{"action":"addTask","day":3,"intent":"physics revision","durationMin":40}]})',
        model: 'a',
      }),
      stream: async (_req: LLMRequest): Promise<LLMResponse> => ({ text: 'Dono kar diye.', model: 'a' }),
      fetchModels: async (): Promise<ModelInfo[]> => [],
      healthCheck: async (): Promise<HealthCheckResult> => ({ ok: true, provider: 'openrouter', latencyMs: 1 }),
    };
    const chat = makeChat(store, provider, tools);
    const session = chat.createSession();

    const reply = await chat.send(
      session.id,
      'aaj ke tasks batao aur ek revision add karo',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      ['getDay', 'addTask'],
    );

    // BOTH actions ran, not just one. getDay may be out-of-range for that
    // date (ok:false), but the important thing is it was ATTEMPTED — neither
    // pinned tool was silently dropped for addTask.
    expect(reply.toolCalls?.length).toBe(2);
    const byAction = Object.fromEntries(reply.toolCalls!.map((c) => [c.action, c]));
    expect(byAction['getDay']).toBeDefined();
    expect(byAction['addTask']).toMatchObject({ action: 'addTask', ok: true });
    expect(store.get().dynamicTaskBank.some((t) => t.id === 'ai-chat-test')).toBe(true);
    expect(reply.content).toContain('Dono kar diye');
  });

  it('falls back to the deterministic fast-path action when the multi-tool model gives up', async () => {
    const store = makeStore();
    const { tools } = makeTools(store);
    // "mera progress kya hai" maps deterministically to getContext. User pinned
    // getContext + addTask (multiple tools), so the fast path is NOT taken
    // directly — but the model fails to emit JSON, so the fast path must be
    // the safety net instead of an error.
    const provider: LLMProvider = {
      id: 'openrouter' as ProviderId,
      label: 'OpenRouter',
      isConfigured: () => true,
      complete: async (): Promise<LLMResponse> => ({ text: '', model: 'a' }),
      stream: async (_req: LLMRequest): Promise<LLMResponse> => ({ text: 'Day 30 tak ka progress summary', model: 'a' }),
      fetchModels: async (): Promise<ModelInfo[]> => [],
      healthCheck: async (): Promise<HealthCheckResult> => ({ ok: true, provider: 'openrouter', latencyMs: 1 }),
    };
    const chat = makeChat(store, provider, tools);
    const session = chat.createSession();

    const reply = await chat.send(session.id, 'mera progress kya hai', undefined, undefined, undefined, undefined, undefined, [
      'getContext',
      'addTask',
    ]);

    expect(reply.tool).toBe('getContext');
    expect(reply.content).toContain('Day 30');
  });

  it('multi-tool scoped prompt tells the model to use every relevant selected tool', () => {
    const instructions = chatToolScopeInstructions(['getDay', 'addTodo']);
    expect(instructions).toContain('MULTIPLE tools are selected');
    expect(instructions).toContain('Use EVERY selected tool');
    expect(instructions).toContain('getDay');
    expect(instructions).toContain('addTodo');
  });

  // 90-day-only tools must NEVER surface in the @-scope prompt, even if a
  // caller passes them in directly. Only mode-independent (flexible-safe)
  // tools may appear there — this is the scope-level half of the capability
  // boundary (the execution layer enforces it independently).
  it('strips 90-day-only tools from the scoped prompt even when passed in directly', () => {
    const instructions = chatToolScopeInstructions(['getPlan', 'addTask', 'markDone', 'deleteBlock']);
    expect(instructions).not.toContain('getPlan');
    expect(instructions).not.toContain('addTask');
    expect(instructions).not.toContain('markDone');
    expect(instructions).not.toContain('deleteBlock');
  });

  /**
   * Regression: CHAT_TOOL_CATALOG (used to build the @-scope prompt + picker)
   * and the ACTIONS registry (used at execution time) are two separate lists
   * that must agree on confirmationRequired — a mismatch means the model is
   * never told a pinned tool needs "confirmed":true, so execution silently
   * rejects it as a preview and the tool looks broken from the "@" flow.
   *
   * NOTE: 90-day-only confirmation tools (removeTask, deleteBlock, …) are
   * stripped from the scoped prompt by the capability boundary, so they are
   * tested separately below — here we assert on the confirmation flag for the
   * mode-independent (flexible-safe) tools that CAN actually be pinned.
   */
  it('every confirmation-required flexible-safe tool in the catalog is flagged in its scoped prompt', () => {
    const confirmationTools = CHAT_TOOL_CATALOG.filter((t) => t.confirmationRequired && !NINETY_DAY_ONLY_ACTION_SET.has(t.id)).map((t) => t.id);
    // deleteMemory is the mode-independent destructive tool; the 90-day
    // confirmation tools (removeTask, deleteBlock, ...) are stripped from the
    // scoped prompt by the capability boundary.
    expect(confirmationTools).toEqual(['deleteMemory']);
    for (const id of confirmationTools) {
      const instructions = chatToolScopeInstructions([id]);
      expect(instructions).toContain('needs the user\'s "confirmed":true first');
    }
  });
});

describe('notification reply flow', () => {
  // Mirrors src/lib/notification-actions.ts exactly: a notification "Reply"
  // action calls `container.chat.send(sessionId, inputValue.trim())` — 2
  // positional args, no signal, on an EXISTING session. This must resolve
  // (not hang on "Sending") and produce content notifyAiReply can display.
  it('replies to an existing chat session like the notification action does', async () => {
    const store = makeStore();
    const { tools } = makeTools(store);
    const provider: LLMProvider = {
      id: 'openrouter' as ProviderId,
      label: 'OpenRouter',
      isConfigured: () => true,
      complete: async (): Promise<LLMResponse> => ({ text: '', model: 'a' }),
      stream: async (_req: LLMRequest): Promise<LLMResponse> => ({ text: 'Achha, theek hai!', model: 'a' }),
      fetchModels: async (): Promise<ModelInfo[]> => [],
      healthCheck: async (): Promise<HealthCheckResult> => ({ ok: true, provider: 'openrouter', latencyMs: 1 }),
    };
    const chat = makeChat(store, provider, tools);
    const session = chat.createSession();

    // A normal in-app message first (so the session is not fresh).
    await chat.send(session.id, 'hello, kaise ho?');

    // Now the notification-style reply — send resolves with usable content.
    const reply = await chat.send(session.id, 'thank you');

    expect(reply.role).toBe('assistant');
    expect(reply.content).toContain('theek hai');
    // The reply is appended to the same session so it shows up in chat later.
    const msgs = chat.listSessions().find((s) => s.id === session.id)?.messages ?? [];
    expect(msgs.filter((m) => m.role === 'assistant').length).toBe(2);
  });

  it('notification reply to a TASK message also resolves through the tool hop', async () => {
    const store = makeStore();
    const { tools } = makeTools(store);
    const provider: LLMProvider = {
      id: 'openrouter' as ProviderId,
      label: 'OpenRouter',
      isConfigured: () => true,
      complete: async (): Promise<LLMResponse> => ({
        text: 'print(addTask(day=3, intent="notification se task", durationMin=40))',
        model: 'a',
      }),
      stream: async (_req: LLMRequest): Promise<LLMResponse> => ({ text: 'Day 3 mein add ho gaya.', model: 'a' }),
      fetchModels: async (): Promise<ModelInfo[]> => [],
      healthCheck: async (): Promise<HealthCheckResult> => ({ ok: true, provider: 'openrouter', latencyMs: 1 }),
    };
    const chat = makeChat(store, provider, tools);
    const session = chat.createSession();

    const reply = await chat.send(session.id, 'day 3 mein physics revision add karo');

    expect(reply.tool).toBe('addTask');
    expect(reply.content).toContain('add ho gaya');
    // The tool really ran — so the notification summary reflects real state.
    expect(store.get().dynamicTaskBank.some((t) => t.id === 'ai-chat-test')).toBe(true);
  });

  describe('Chat History Search & Browsing Tools', () => {
    const mockSessions: ChatSession[] = [
      {
        id: 'sess-1',
        title: 'Physics Electrostatics Doubt',
        createdAt: '2026-08-25T10:00:00.000Z',
        updatedAt: '2026-08-25T10:30:00.000Z',
        prefs: { providerId: null, model: null, temperature: 0.7, maxTokens: 1000, systemPrompt: '', userPersona: '', includeContext: true },
        messages: [
          { id: 'm1', role: 'user', content: 'Sir Gauss Law ka flux formula kya hai?', createdAt: '2026-08-25T10:05:00.000Z' },
          { id: 'm2', role: 'assistant', content: 'Electric flux through closed surface is Q_enclosed / epsilon_0.', createdAt: '2026-08-25T10:06:00.000Z' },
          { id: 'm3', role: 'user', content: 'Got it, thanks!', createdAt: '2026-08-25T10:07:00.000Z' },
        ],
      },
      {
        id: 'sess-2',
        title: 'Chemistry Thermodynamics Revision',
        createdAt: '2026-08-28T14:00:00.000Z',
        updatedAt: '2026-08-28T14:45:00.000Z',
        prefs: { providerId: null, model: null, temperature: 0.7, maxTokens: 1000, systemPrompt: '', userPersona: '', includeContext: true },
        messages: [
          { id: 'm4', role: 'user', content: 'Gibbs free energy change delta G ka relation batao', createdAt: '2026-08-28T14:15:00.000Z' },
          { id: 'm5', role: 'assistant', content: 'Delta G = Delta H - T * Delta S. Spontaneous process ke liye Delta G negative hota hai.', createdAt: '2026-08-28T14:16:00.000Z' },
        ],
      },
    ];

    it('searchChatHistory finds matching messages with formatted timestamps and surrounding context', async () => {
      const store = makeStore();
      const { tools } = makeTools(store, () => mockSessions);

      const res = await tools.runMany([
        { action: 'searchChatHistory', query: 'Gauss Law' },
      ]);

      expect(res.ok).toBe(true);
      expect(res.summary).toContain('Physics Electrostatics Doubt');
      expect(res.summary).toContain('Gauss Law ka flux formula');
      expect(res.summary).toContain('Electric flux through closed surface');
      expect(res.summary).toContain('Student (User)');
      expect(res.summary).toContain('Misa (AI)');
    });

    it('searchChatHistory filters by specific date or date range', async () => {
      const store = makeStore();
      const { tools } = makeTools(store, () => mockSessions);

      // Search on 2026-08-28 only
      const res = await tools.runMany([
        { action: 'searchChatHistory', date: '2026-08-28' },
      ]);

      expect(res.ok).toBe(true);
      expect(res.summary).toContain('Chemistry Thermodynamics Revision');
      expect(res.summary).toContain('Gibbs free energy');
      expect(res.summary).not.toContain('Gauss Law');
    });

    it('listChatSessions lists previous sessions with message counts', async () => {
      const store = makeStore();
      const { tools } = makeTools(store, () => mockSessions);

      const res = await tools.runMany([{ action: 'listChatSessions' }]);
      expect(res.ok).toBe(true);
      expect(res.summary).toContain('Physics Electrostatics Doubt');
      expect(res.summary).toContain('Chemistry Thermodynamics Revision');
      expect(res.summary).toContain('3 msgs');
      expect(res.summary).toContain('2 msgs');
    });

    it('getChatSession returns full chronological transcript with timestamps', async () => {
      const store = makeStore();
      const { tools } = makeTools(store, () => mockSessions);

      const res = await tools.runMany([
        { action: 'getChatSession', sessionId: 'sess-1' },
      ]);
      expect(res.ok).toBe(true);
      expect(res.summary).toContain('CHAT TRANSCRIPT: "Physics Electrostatics Doubt"');
      expect(res.summary).toContain('Sir Gauss Law ka flux formula kya hai?');
      expect(res.summary).toContain('Q_enclosed / epsilon_0');
      expect(res.summary).toContain('Got it, thanks!');
    });

    it('unifies memory tools (addMemory, searchMemory, readMemory) in ChatToolsService', async () => {
      const store = makeStore();
      const { tools } = makeTools(store, () => mockSessions);

      // Add a memory
      const addRes = await tools.runMany([
        { action: 'addMemory', content: 'Rotational dynamics formulas revision zaroori hai' },
      ]);
      expect(addRes.ok).toBe(true);
      expect(addRes.summary).toContain('Rotational dynamics formulas');

      // Search the memory
      const searchRes = await tools.runMany([
        { action: 'searchMemory', query: 'Rotational dynamics' },
      ]);
      expect(searchRes.ok).toBe(true);
      expect(searchRes.summary).toContain('Rotational dynamics');

      // Read all memory
      const readRes = await tools.runMany([
        { action: 'readMemory' },
      ]);
      expect(readRes.ok).toBe(true);
      expect(readRes.summary).toContain('Rotational dynamics');
    });

    it('executes multi-tool batch combining chat tools and memory tools in one hop', async () => {
      const store = makeStore();
      const { tools } = makeTools(store, () => mockSessions);

      const multiRes = await tools.runMany([
        { action: 'addTask', day: 1, intent: 'Rotation 20 PYQs', durationMin: 45 },
        { action: 'addMemory', content: 'Rotation is weak, focus on moment of inertia' },
        { action: 'searchChatHistory', query: 'Gauss Law' },
      ]);

      expect(multiRes.ok).toBe(true);
      expect(multiRes.results).toHaveLength(3);
      expect(multiRes.results?.[0].action).toBe('addTask');
      expect(multiRes.results?.[1].action).toBe('addMemory');
      expect(multiRes.results?.[2].action).toBe('searchChatHistory');
      // addTask uses mocked taskGeneration which outputs "Chat se add hua task", not raw intent
      expect(multiRes.summary).toContain('Day 1');
      expect(multiRes.summary).toContain('Rotation is weak');
      expect(multiRes.summary).toContain('Gauss Law');
    });

    it('handles addTodo, editTodo, reorderTodos, toggleTodo, and deleteTodo seamlessly', async () => {
      const store = makeStore();
      const { tools } = makeTools(store, () => mockSessions);

      // 1. Add low and high priority todos
      const add1 = await tools.run({
        action: 'addTodo',
        title: 'Formula revision',
        priority: 'low',
        estimatedMinutes: 20,
        category: 'revision',
      });
      expect(add1.ok).toBe(true);

      const add2 = await tools.run({
        action: 'addTodo',
        title: 'HC Verma Mechanics 15 questions',
        priority: 'high',
        estimatedMinutes: 60,
        category: 'physics',
      });
      expect(add2.ok).toBe(true);

      const todos = store.get().customTodos ?? [];
      expect(todos).toHaveLength(2);

      // 2. Edit a todo (change title, priority to high, duration to 90m)
      const editRes = await tools.run({
        action: 'editTodo',
        title: 'Formula revision',
        newTitle: 'Complete Formula Sheet Revision',
        priority: 'high',
        estimatedMinutes: 90,
        category: 'physics',
      });
      expect(editRes.ok).toBe(true);
      expect(editRes.summary).toContain('Complete Formula Sheet Revision');
      expect(editRes.summary).toContain('HIGH');

      const updatedTodos = store.get().customTodos ?? [];
      const edited = updatedTodos.find((t) => t.title === 'Complete Formula Sheet Revision');
      expect(edited).toBeDefined();
      expect(edited?.estimatedMinutes).toBe(90);
      expect(edited?.priority).toBe('high');

      // 3. Reorder todos (move to top)
      const reorderRes = await tools.run({
        action: 'reorderTodos',
        title: 'HC Verma',
        position: 'top',
      });
      expect(reorderRes.ok).toBe(true);
      expect(reorderRes.summary).toContain('position 1');

      // 4. Toggle todo to completed -> automatically moves to bottom
      const toggleRes = await tools.run({
        action: 'toggleTodo',
        title: 'HC Verma',
        completed: true,
      });
      expect(toggleRes.ok).toBe(true);
      expect(toggleRes.summary).toContain('COMPLETED');
      // 5. Query todos by date and daysBack
      const listToday = await tools.run({
        action: 'listTodos',
        date: 'today',
      });
      expect(listToday.ok).toBe(true);
      expect(listToday.summary).toContain('Complete Formula Sheet');

      const listPastDays = await tools.run({
        action: 'listTodos',
        daysBack: 10,
        filter: 'all',
      });
      expect(listPastDays.ok).toBe(true);
      expect(listPastDays.summary).toContain('last 10 days');

      // 6. Delete todo (requires confirmation preview, then confirmed execution)
      const delPreview = await tools.run({
        action: 'deleteTodo',
        title: 'HC Verma',
      });
      expect(delPreview.requiresConfirmation).toBe(true);
      expect(store.get().customTodos).toHaveLength(2);

      const delRes = await tools.run({
        action: 'deleteTodo',
        title: 'HC Verma',
        confirmed: true,
      });
      expect(delRes.ok).toBe(true);
      expect(store.get().customTodos).toHaveLength(1);
    });
  });
});

describe('90-day capability gate (toggle OFF = hard block at execution layer)', () => {
  it('runMany blocks every 90-day-only action when the track is OFF', async () => {
    const store = makeFlexibleStore();
    const { tools } = makeTools(store);
    const result = await tools.runMany([
      { action: 'addTask', day: 3, intent: 'revision', durationMin: 20 },
      { action: 'markDone', day: 1, taskId: 'd1_t1' },
    ]);
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('90-day track is disabled');
    expect(result.results).toHaveLength(2);
    for (const r of result.results!) {
      expect(r.ok).toBe(false);
      expect(r.summary).toContain('Blocked because 90-day track is OFF');
    }
    // Nothing was applied.
    expect(store.get().dynamicTaskBank.some((t) => t.id === 'ai-chat-test')).toBe(false);
  });

  it('runMany still allows flexible-mode actions when the track is OFF', async () => {
    const store = makeFlexibleStore();
    const { tools } = makeTools(store);
    // A mixed batch of a blocked 90-day action + a flexible-safe addTodo is an
    // all-or-nothing block (the 90-day action poisons the batch).
    const result = await tools.runMany([
      { action: 'addTask', day: 3, intent: 'revision', durationMin: 20 },
      { action: 'addTodo', title: 'flexible task', priority: 'high', estimatedMinutes: 30 },
    ]);
    expect(result.ok).toBe(false);
    expect(store.get().customTodos ?? []).toHaveLength(0);

    // A batch of ONLY flexible-safe actions proceeds normally.
    const ok = await tools.runMany([{ action: 'addTodo', title: 'flexible task', priority: 'high', estimatedMinutes: 30 }]);
    expect(ok.ok).toBe(true);
    expect(store.get().customTodos).toHaveLength(1);
  });

  it('run() blocks a direct single 90-day action too (defense-in-depth)', async () => {
    const store = makeFlexibleStore();
    const { tools } = makeTools(store);
    const res = await tools.run({ action: 'getPlan', day: 3 });
    expect(res.ok).toBe(false);
    expect(res.summary).toContain('90-day track is disabled');
    expect(store.get().dynamicTaskBank.some((t) => t.id === 'ai-chat-test')).toBe(false);
  });

  it('run() still allows flexible-safe actions when the track is OFF', async () => {
    const store = makeFlexibleStore();
    const { tools } = makeTools(store);
    const res = await tools.run({ action: 'listTodos', filter: 'pending' });
    expect(res.ok).toBe(true);
    const ctx = await tools.run({ action: 'getContext' });
    expect(ctx.ok).toBe(true);
    expect(ctx.summary).toContain('Flexible Study Planner');
  });

  it('domain-level state90DayOnlyBlocked refuses 90-day actions when OFF, allows when ON', () => {
    const off = { enable90DayTrack: false };
    const on = { enable90DayTrack: true };
    expect(state90DayOnlyBlocked(off, 'addTask')).toBe(true);
    expect(state90DayOnlyBlocked(off, 'getPlan')).toBe(true);
    expect(state90DayOnlyBlocked(off, 'deleteBlock')).toBe(true);
    // Flexible-safe actions are never blocked by the 90-day gate.
    expect(state90DayOnlyBlocked(off, 'addTodo')).toBe(false);
    expect(state90DayOnlyBlocked(off, 'getContext')).toBe(false);
    expect(state90DayOnlyBlocked(off, 'listPlanners')).toBe(false);
    // Track ON → nothing blocked.
    expect(state90DayOnlyBlocked(on, 'addTask')).toBe(false);
  });

  it('listTools hides 90-day tools when OFF but keeps flexible-safe ones', () => {
    const off = makeFlexibleStore();
    const { tools: offTools } = makeTools(off);
    const offIds = offTools.listTools().map((t) => t.id);
    for (const id of ['addTask', 'getPlan', 'markDone', 'deleteBlock']) expect(offIds).not.toContain(id);
    for (const id of ['addTodo', 'listTodos', 'getContext', 'listPlanners', 'searchChatHistory', 'scheduleMessage']) {
      expect(offIds).toContain(id);
    }

    const on = makeStore();
    const { tools: onTools } = makeTools(on);
    const onIds = onTools.listTools().map((t) => t.id);
    expect(onIds).toContain('addTask');
    expect(onIds).toContain('getPlan');
  });
});

