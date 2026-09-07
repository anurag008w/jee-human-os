// Deterministic chat tool protocol. The LLM may answer a task-related query
// with one JSON tool action — or, for multi-part requests, an array of actions
// executed together. The app executes them locally and feeds the combined
// result back for a Hinglish summary. Works on ANY provider because it never
// relies on native function-calling support.

import { z } from 'zod';

const taskMetadataSchema = {
  description: z.string().min(1).max(500).optional(),
  habitId: z.string().min(1).optional(),
  phase: z.enum(['jee-core', 'l-mindset', 'light-execution', 'peak-performance']).optional(),
  difficulty: z.number().int().min(1).max(5).optional(),
  energyLevel: z.enum(['low', 'medium', 'high']).optional(),
  tags: z.array(z.string().min(1)).max(12).optional(),
  prerequisites: z.array(z.string().min(1)).max(12).optional(),
  taskType: z.enum(['Beginner', 'Intermediate', 'Advanced', 'Review', 'Recovery', 'Reflection', 'Challenge']).optional(),
  revisionSuitability: z.number().min(0).max(1).optional(),
  backlogSuitability: z.number().min(0).max(1).optional(),
  thinkingSkills: z.array(z.enum(['planning', 'focus', 'discipline', 'recall', 'analysis', 'reasoning', 'verification', 'reflection', 'systems', 'creativity'])).max(4).optional(),
  jeeRelevance: z.object({ subject: z.string().min(1).optional(), examWindow: z.boolean().optional(), score: z.number().min(0).max(1) }).optional(),
};

export const chatToolActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('getPlan'), day: z.number().int() }),
  z.object({ action: z.literal('getRange'), fromDay: z.number().int(), toDay: z.number().int() }),
  z.object({ action: z.literal('addTask'), day: z.number().int(), intent: z.string().min(1), durationMin: z.number().int().min(1).max(600).optional(), ...taskMetadataSchema }),
  z.object({
    action: z.literal('bulkAddTasks'),
    day: z.number().int(),
    intents: z.array(z.string().min(1)).min(1).max(100),
    durationMin: z.number().int().min(1).max(600).optional(),
    tags: taskMetadataSchema.tags,
    taskType: taskMetadataSchema.taskType,
    difficulty: taskMetadataSchema.difficulty,
    energyLevel: taskMetadataSchema.energyLevel,
  }),
  z.object({ action: z.literal('removeTask'), day: z.number().int(), taskId: z.string().min(1), confirmed: z.boolean().optional() }),
  z.object({ action: z.literal('bulkRemoveTasks'), day: z.number().int(), taskIds: z.array(z.string().min(1)).min(1), confirmed: z.boolean().optional() }),
  z.object({ action: z.literal('setDayMode'), day: z.number().int(), mode: z.enum(['study', 'rest', 'test']), confirmed: z.boolean().optional() }),
  z.object({
    action: z.literal('editTask'),
    day: z.number().int(),
    taskId: z.string().min(1),
    title: z.string().min(1).max(200).optional(),
    durationMin: z.number().int().min(1).max(600).optional(),
    dayTo: z.number().int().min(1).max(90).optional(),
    ...taskMetadataSchema,
  }),
  z.object({ action: z.literal('markDone'), day: z.number().int(), taskId: z.string().min(1), confirmed: z.boolean().optional() }),
  z.object({ action: z.literal('bulkMarkDone'), day: z.number().int(), taskIds: z.array(z.string().min(1)).min(1).optional(), confirmed: z.boolean().optional() }),
  // Task Bank Management (view, edit, delete any task)
  z.object({ action: z.literal('getAllTasks'), day: z.number().int() }),
  z.object({ action: z.literal('getTaskBank'), category: z.string().optional() }),
  z.object({ action: z.literal('editAnyTask'), taskId: z.string().min(1), title: z.string().min(1).max(200).optional(), durationMin: z.number().int().min(1).max(600).optional(), category: z.string().optional(), ...taskMetadataSchema }),
  z.object({ action: z.literal('deleteAnyTask'), taskId: z.string().min(1), confirmed: z.boolean().optional() }),
  // Block management actions
  z.object({
    action: z.literal('createBlock'),
    name: z.string().min(1).max(100),
    description: z.string().min(1).max(500).optional(),
    days: z.number().int().min(1).max(90).optional(),
    dayStart: z.number().int().min(91).optional(),
    focusAreas: z.array(z.string()).optional(),
    difficulty: z.enum(['easy', 'medium', 'hard', 'extreme']).optional(),
    goals: z.array(z.string()).optional(),
    habits: z.array(z.string()).optional(),
  }),
  z.object({ action: z.literal('deleteBlock'), blockId: z.string().min(1), confirmed: z.boolean().optional() }),
  z.object({ action: z.literal('activateBlock'), blockId: z.string().min(1) }),
  z.object({ action: z.literal('editBlock'), blockId: z.string().min(1), name: z.string().min(1).max(100).optional(), description: z.string().min(1).max(500).optional(), dayStart: z.number().int().min(91).optional(), dayEnd: z.number().int().min(91).optional(), days: z.number().int().min(1).max(90).optional(), difficulty: z.enum(['easy', 'medium', 'hard', 'extreme']).optional(), goals: z.array(z.string()).optional(), habits: z.array(z.string()).optional() }),
  z.object({ action: z.literal('listBlocks') }),
  z.object({ action: z.literal('extendBlock'), blockId: z.string().min(1), days: z.number().int().min(1).max(30) }),
  // Read-only uploaded-coaching-planner actions (subjects / tests / routine).
  z.object({ action: z.literal('listPlanners'), type: z.enum(['subject', 'test', 'routine']).optional() }),
  z.object({ action: z.literal('getSubject'), subject: z.string().min(1).max(60), from: z.string().max(60).optional(), to: z.string().max(60).optional() }),
  z.object({ action: z.literal('getPlanner'), plannerId: z.string().min(1), from: z.string().max(60).optional(), to: z.string().max(60).optional() }),
  z.object({ action: z.literal('getTest'), testName: z.string().min(1).max(160) }),
  z.object({
    action: z.literal('getTests'),
    from: z.string().max(60).optional(),
    to: z.string().max(60).optional(),
    subject: z.string().max(60).optional(),
  }),
  z.object({ action: z.literal('getRoutine'), day: z.string().max(60).optional() }),
  z.object({ action: z.literal('getDay'), date: z.string().max(60).optional(), from: z.string().max(60).optional(), to: z.string().max(60).optional() }),
  z.object({ action: z.literal('getContext') }),
  // Custom To-Do & Task Management
  z.object({
    action: z.literal('addTodo'),
    title: z.string().min(1).max(300),
    priority: z.enum(['high', 'medium', 'low']).optional(),
    estimatedMinutes: z.number().int().min(1).max(600).optional(),
    category: z.enum(['physics', 'chemistry', 'maths', 'general', 'revision']).optional(),
  }),
  z.object({
    action: z.literal('listTodos'),
    filter: z.enum(['all', 'pending', 'completed']).optional(),
    date: z.string().optional(),
    daysBack: z.number().int().min(1).max(365).optional(),
    category: z.enum(['physics', 'chemistry', 'maths', 'general', 'revision']).optional(),
  }),
  z.object({
    action: z.literal('toggleTodo'),
    todoId: z.string().optional(),
    title: z.string().optional(),
    completed: z.boolean().optional(),
  }),
  z.object({
    action: z.literal('editTodo'),
    todoId: z.string().optional(),
    title: z.string().optional(),
    newTitle: z.string().min(1).max(300).optional(),
    priority: z.enum(['high', 'medium', 'low']).optional(),
    estimatedMinutes: z.number().int().min(1).max(600).optional(),
    category: z.enum(['physics', 'chemistry', 'maths', 'general', 'revision']).optional(),
    completed: z.boolean().optional(),
    order: z.number().int().min(0).optional(),
  }),
  z.object({
    action: z.literal('reorderTodos'),
    todoId: z.string().optional(),
    title: z.string().optional(),
    position: z.enum(['top', 'bottom', 'up', 'down']).or(z.number().int()).optional(),
    todoIds: z.array(z.string().min(1)).min(1).optional(),
  }),
  z.object({
    action: z.literal('deleteTodo'),
    todoId: z.string().optional(),
    title: z.string().optional(),
    confirmed: z.boolean().optional(),
  }),
  z.object({
    action: z.literal('listVaultResources'),
    subject: z.string().optional(),
  }),
  // AI Chat History Search & Deep Browsing
  z.object({
    action: z.literal('searchChatHistory'),
    query: z.string().optional(),
    date: z.string().max(60).optional(),
    fromDate: z.string().max(60).optional(),
    toDate: z.string().max(60).optional(),
    sessionId: z.string().optional(),
    role: z.enum(['user', 'assistant', 'all']).optional(),
    limit: z.number().int().min(1).max(50).optional(),
    includeSurrounding: z.boolean().optional(),
  }),
  z.object({
    action: z.literal('listChatSessions'),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  z.object({
    action: z.literal('getChatSession'),
    sessionId: z.string().min(1),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  // AI Memory Management
  z.object({ action: z.literal('readMemory'), limit: z.number().int().min(1).max(50).optional() }),
  z.object({ action: z.literal('searchMemory'), query: z.string().min(1), type: z.string().optional(), tag: z.string().optional(), limit: z.number().int().min(1).max(50).optional() }),
  z.object({ action: z.literal('addMemory'), content: z.string().min(1), type: z.enum(['fact', 'goal', 'preference', 'observation', 'summary']).optional(), tags: z.array(z.string()).optional(), longTerm: z.boolean().optional() }),
  z.object({ action: z.literal('editMemory'), id: z.string().min(1), content: z.string().min(1) }),
  z.object({ action: z.literal('deleteMemory'), id: z.string().min(1), confirmed: z.boolean().optional() }),
  z.object({ action: z.literal('pinMemory'), id: z.string().min(1) }),
  z.object({ action: z.literal('unpinMemory'), id: z.string().min(1) }),
  // Proactive: Misa future me message/call schedule kar sakti hai (AI tools).
  z.object({
    action: z.literal('scheduleMessage'),
    text: z.string().min(1).max(500),
    scheduledAtISO: z.string().min(1).max(40).describe('ISO-8601 timestamp — kab message bhejna hai (future)'),
    topic: z.string().max(60).optional(),
    linkedEntity: z.object({
      type: z.enum(['todo', 'task', 'memory', 'keyword']),
      value: z.string().min(1).max(200).describe('Entity ka naam/id — jab ye complete ho toh scheduled auto-cancel'),
    }).optional(),
    confirmed: z.boolean().optional(),
  }),
  z.object({
    action: z.literal('makeCall'),
    reason: z.string().min(1).max(300).describe('Call ka reason — user ko dikhega'),
    confirmed: z.boolean().optional(),
  }),
  z.object({
    action: z.literal('scheduleCall'),
    reason: z.string().min(1).max(300).describe('Call ka reason'),
    scheduledAtISO: z.string().min(1).max(40).describe('ISO-8601 timestamp — kab call karna hai (future)'),
    confirmed: z.boolean().optional(),
  }),
  z.object({
    action: z.literal('listScheduled'),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  z.object({
    action: z.literal('cancelScheduled'),
    id: z.string().min(1),
  }),
]);

export type ChatToolAction = z.infer<typeof chatToolActionSchema>;

/** Wrapper the model may emit to request several actions in one reply. */
export const chatToolBatchSchema = z.object({
  actions: z.array(chatToolActionSchema).min(1).max(100),
});

export type ChatToolBatch = z.infer<typeof chatToolBatchSchema>;

export interface ChatToolResult {
  ok: boolean;
  /** Human/machine-readable structured summary fed back to the LLM. */
  summary: string;
  /** True when the action is a preview and must be retried with confirmed:true. */
  requiresConfirmation?: boolean;
  /** Version id recorded for an applied mutation. */
  versionId?: string;
  /** Days whose task-id action failed because the id wasn't in that day's
   *  plan. Lets the chat service auto-fetch the day's plan and retry once with
   *  the real ids — the "pehle plan dekho, phir edit karo" chaining. */
  missingTaskIdDays?: number[];
  /** True when this failure is FIXABLE by the model re-emitting better JSON —
   *  e.g. a wrong/guessed id, a missing edit field, or a block not found. Lets
   *  the chat service feed the exact error back and let the model retry. */
  retryable?: boolean;
  /** Per-action execution results — lets the chat service show the model
   *  exactly which actions succeeded and which failed, so a retry only
   *  re-emits the failures instead of double-applying the batch. */
  results?: ChatToolActionResult[];
}

/** Per-action outcome recorded by runMany. */
export interface ChatToolActionResult {
  action: string;
  ok: boolean;
  summary: string;
  requiresConfirmation?: boolean;
  missingTaskIdDays?: number[];
  /** Same semantics as ChatToolResult.retryable. */
  retryable?: boolean;
}

/** Description of the tool protocol embedded in the system prompt. */
export const CHAT_TOOL_INSTRUCTIONS = `You can VIEW or MODIFY the study plan for ANY day (1-90) and manage custom study blocks.

When the user asks about a day's plan, or wants to add/remove/edit/complete tasks, your ENTIRE reply must be exactly one JSON object, no extra text.

ALL TOOLS (pick the MOST specific one):
- getContext — journey snapshot: date, day/phase/streak, today's tasks + progress, XP/habits, weak habits, gaps, blocks, planners. Use for "mera progress/status/context batao".
- getPlan{day} — one day's plan. getRange{fromDay,toDay} — plan for a range (max 10 days/call; auto-splits bigger).
- getAllTasks{day} — ALL tasks (AI + user) for a day. getTaskBank — whole bank (optionally by category).
- addTask / bulkAddTasks{day,intents} — add one/many tasks to a day. editTask / editAnyTask — edit a task.
- removeTask / bulkRemoveTasks — hide tasks for ONE day (bank safe). deleteAnyTask — delete from bank (destructive).
- markDone / bulkMarkDone — complete tasks. setDayMode{day,mode:study|rest|test} — set day as study, rest (holiday) or test (mock test) day.
- listBlocks / createBlock / editBlock / extendBlock / activateBlock / deleteBlock — custom study blocks.
- listPlanners / getSubject / getPlanner / getTest / getTests / getRoutine / getDay — uploaded coaching planners (read-only).

PROACTIVE TOOLS (only when the student explicitly asks — NEVER push unsolicited messages/calls):
- scheduleMessage{text,scheduledAtISO,topic?} — schedule a reminder message for a future time (ISO-8601). Use when the student says "kal 5 baje yaad dilana", "raat ko message karna".
- scheduleCall{reason,scheduledAtISO} — schedule a voice-call check-in at a future time.
- makeCall{reason} — call the student RIGHT NOW (student asked you to call them).
- listScheduled — list currently pending scheduled messages/calls.
- cancelScheduled{id} — cancel a scheduled message/call by id.
Only use these when the student EXPLICITLY requests scheduling/calling. Never initiate unprompted.

CURRENT CONTEXT:
- Whole-journey questions ("mera progress kya hai", "status batao", "context batao", "mera streak kitna hai", "overview de") → {"action":"getContext"} — the complete snapshot (date, day/phase/streak, today's tasks + progress, XP, habits, gaps, blocks, planners). Prefer it over getPlan for these.

TASK MANAGEMENT:
- Plan for a day: {"action":"getPlan","day":N}
- Range overview: {"action":"getRange","fromDay":A,"toDay":B} (max 10 days per call; auto-splits if larger)
- View ALL tasks for a day (AI + user): {"action":"getAllTasks","day":N}
- View task bank: {"action":"getTaskBank"} or {"action":"getTaskBank","category":"physics"}
- Add a task: {"action":"addTask","day":N,"intent":"<what task>","durationMin":30}. durationMin REQUIRED; infer a sensible value if the user didn't say it. Appears ONLY on Day N.
  Optional metadata when known: description, habitId, phase, difficulty (1-5), energyLevel (low/medium/high), tags, prerequisites, taskType, revisionSuitability (0-1), backlogSuitability (0-1), thinkingSkills, jeeRelevance:{subject,examWindow,score}.
- Add multiple tasks at once: {"action":"bulkAddTasks","day":N,"intents":["maths 10 questions","thermo revision"],"durationMin":30}. durationMin REQUIRED; infer if needed. All appear ONLY on Day N. Optional shared info: tags, taskType, difficulty, energyLevel.
- Edit a task: {"action":"editTask","day":N,"taskId":"<id from plan>","title":"New title","durationMin":20,"dayTo":5,"difficulty":3,"tags":["physics"]}. "dayTo" moves it so it only appears on that exact day. If you lack info, first use getPlan/getAllTasks/getTaskBank, then retry with the real id + fields to change.
- Remove a task from ONE day: {"action":"removeTask","day":N,"taskId":"<id from plan>"}. Hides it ONLY for Day N — the Task Bank is NEVER modified; the same task still appears on other days. Destructive: NEVER set "confirmed":true yourself — the app shows the user a Yes/No prompt and adds it after they tap Yes. Without confirmed the action is previewed and NOTHING changes.
- Remove several tasks from one day: {"action":"bulkRemoveTasks","day":N,"taskIds":["id1","id2"]}. Same confirmation rule + bank-safe behavior.
- Rest/holiday day: {"action":"setDayMode","day":N,"mode":"rest"}. On a rest day no auto curriculum or AI tasks appear, only tasks the user explicitly scheduled. Test day: {"action":"setDayMode","day":N,"mode":"test"} — mock test tasks (mock protocol) appear on that day. "mode":"study" restores a normal study day. "Sunday/holiday/chhuti/rest" → this tool; "test/mock" → this tool with mode "test". Undoable, so it needs confirmation: NEVER set "confirmed":true yourself — the app asks the user and adds it.
- Mark a task done: {"action":"markDone","day":N,"taskId":"<id from plan>"}
- Mark many/all tasks done for one day: {"action":"bulkMarkDone","day":N,"taskIds":["id1","id2"]}. Omit taskIds to target ALL visible plan tasks ("all/saare tasks"). Bulk edit: NEVER set "confirmed":true yourself — the app shows the Yes/No prompt and adds it after the user taps Yes.

TASK BANK MANAGEMENT (full control):
- View all tasks: {"action":"getTaskBank"} (shows ids). By category: {"action":"getTaskBank","category":"physics"}.
- Edit any dynamic task: {"action":"editAnyTask","taskId":"<taskId>","title":"New Title","durationMin":45,"category":"chemistry","difficulty":3,"energyLevel":"medium","tags":["chemistry"]}. Also updatable: description, habitId, phase, prerequisites, taskType, revisionSuitability, backlogSuitability, thinkingSkills, jeeRelevance. Base/seed tasks cannot be edited directly — add/edit creates dynamic copies only.
- Delete from bank: {"action":"deleteAnyTask","taskId":"<taskId>"} — DESTRUCTIVE, needs confirmation.

CUSTOM TO-DO & TASK MANAGEMENT:
- Add a To-Do: {"action":"addTodo","title":"Physics Electrostatics Revision","priority":"high","estimatedMinutes":45,"category":"physics"}
- Edit a To-Do: {"action":"editTodo","title":"Physics Electrostatics Revision","priority":"high","estimatedMinutes":60,"category":"physics"}
- Reorder To-Dos: {"action":"reorderTodos","title":"Physics Electrostatics Revision","position":"top"}
- List To-Dos (current, past dates, or multi-day history):
  {"action":"listTodos","filter":"pending"}
  {"action":"listTodos","filter":"all","date":"yesterday"}
  {"action":"listTodos","filter":"all","date":"2026-08-30"}
  {"action":"listTodos","filter":"completed","daysBack":10}
- Toggle To-Do: {"action":"toggleTodo","title":"Physics Electrostatics Revision","completed":true}
- Delete a To-Do: {"action":"deleteTodo","title":"Physics Electrostatics Revision"}
- Study Vault Resources: {"action":"listVaultResources","subject":"physics"} (lists uploaded PDFs, notes, formula sheets)

CHAT HISTORY & CONVERSATION BROWSING:
- Search messages across all or specific chats by keyword, sentence, or date:
  {"action":"searchChatHistory","query":"thermodynamics question"}
  {"action":"searchChatHistory","date":"2026-08-25"}
  {"action":"searchChatHistory","query":"formula","fromDate":"2026-08-20","toDate":"2026-08-30"}
  Returns full message text, exact timestamps (e.g. 2026-08-25 04:30 PM IST), speaker role (Student / Misa), and session title with conversational context.
- List all past chat sessions: {"action":"listChatSessions"}
- View full transcript of a specific chat session: {"action":"getChatSession","sessionId":"<session-id>"}

AI PERSISTENT MEMORY MANAGEMENT:
- Search saved memory facts/goals/weaknesses: {"action":"searchMemory","query":"weakness in rotation"}
- Read all saved memory facts: {"action":"readMemory"}
- Save a new fact to memory ("yaad rakho X"): {"action":"addMemory","content":"Formula revision 15 min daily zaroori hai","type":"goal"}
- Edit a saved memory: {"action":"editMemory","id":"<entryId>","content":"<new text>"}
- Delete a memory: {"action":"deleteMemory","id":"<entryId>"} (needs confirmation)
- Pin/unpin memory to long-term: {"action":"pinMemory","id":"<entryId>"} / {"action":"unpinMemory","id":"<entryId>"}

CUSTOM BLOCK MANAGEMENT (post-journey, after Day 90):
- List all blocks: {"action":"listBlocks"} (shows status).
- Create a block: {"action":"createBlock","name":"Physics Mastery","description":"15-day physics focus","days":15,"focusAreas":["physics"],"difficulty":"medium"}.
  - name: required. description: optional (include if user gave a purpose). days: optional (default 15). dayStart: >=91 (optional; else app appends after last block). focusAreas: "physics","chemistry","maths","revision","mock","concept","problem" (optional; auto-detected from name). difficulty: "easy","medium","hard","extreme" (optional; default "medium"). habits/goals: custom arrays (optional).
  - Examples: "create a 15 day physics block" → auto-detects physics focus; "banao ek chemistry revision block 7 din ka" → auto-detects chemistry + revision.
- Edit a block: {"action":"editBlock","blockId":"<id>","name":"New Name","description":"New details","difficulty":"hard","days":20,"dayStart":91,"dayEnd":110,"goals":["goal1"],"habits":["habit1"]} — updates metadata and dates. Unknown blockId? Use listBlocks first.
- Extend a block: {"action":"extendBlock","blockId":"<id>","days":5} — adds more days to the end and shifts later blocks forward.
- Delete a block: {"action":"deleteBlock","blockId":"<block-id>"} — DESTRUCTIVE, needs confirmation. Deleting the active block auto-activates the next one or clears active.
- Activate a block: {"action":"activateBlock","blockId":"<block-id>"} — makes this block guide your daily study.

Examples:
- "saare tasks dikhao day 5 ke" → getAllTasks for day 5
- "task bank mein kya kya hai" → getTaskBank
- "physics wale tasks dekho" → getTaskBank with category
- "task xyz ka naam badal do" → editAnyTask
- "ye task delete karo" → deleteAnyTask (needs confirm)
- "10 din ka plan dikhao" → getRange with 10 days
- "edit block block-xxx make it harder" → editBlock with difficulty:hard
- "add 5 more days to physics block" → extendBlock with days:5
- "delete the chemistry block" → deleteBlock (needs confirm)
- "show all my blocks" → listBlocks
- "activate revision block" → activateBlock (use exact block id from listBlocks)
- "purani chat mein physics formula dhoondo" → searchChatHistory with query:"physics formula"
- "kal kya baat hui thi" → searchChatHistory with query:"" and date of yesterday
- "25 august ko humne kya discuss kiya tha" → searchChatHistory with date:"2026-08-25"
- "saari purani chats dikhao" → listChatSessions
- "chat sess-1 ka poora transcript dikhao" → getChatSession with sessionId:"sess-1"
- "meri memory mein kya saved hai" → readMemory
- "rotation ke baare mein kya yaad hai" → searchMemory with query:"rotation"
- "yaad rakhna thermo meri weakness hai" → addMemory with content:"thermo meri weakness hai"

Task ids come from today's plan context or a plan you saw in this chat (format "id:<taskId>", e.g. d1_t1, mock_1, ai-xxxxx). If a day's plan is NOT visible to you yet, do NOT refuse — still emit the requested action with your best guess for the task id. The system will automatically fetch that day's plan (with the real ids) and let you retry with the correct id next.

SEVERAL changes in ONE request (e.g. "3 tasks add karo, ek hatao, aur memory mein note karo"):
emit EVERY change together in an actions array, e.g.
{"actions":[{"action":"addTask","day":5,"intent":"maths 10 questions","durationMin":30},{"action":"addTask","day":5,"intent":"thermo revision","durationMin":40},{"action":"removeTask","day":5,"taskId":"d1_t1"},{"action":"addMemory","content":"Maths speed slow hai"}]}
Multi-action rules:
- Do EVERYTHING the user asked for in the same reply — never execute only one of several requested changes.
- Max 100 actions per reply. Actions run top-to-bottom; results come back combined with task ids.
- Destructive/bulk actions (removeTask, bulkRemoveTasks, setDayMode, bulkMarkDone, deleteBlock, deleteAnyTask, deleteMemory) are confirmed by the APP, not by you: NEVER emit "confirmed":true yourself — that would let a destructive action run without the user's explicit Yes. Just emit the action without "confirmed"; the app previews the WHOLE batch, shows Yes/No buttons, and adds "confirmed":true only after the user taps Yes. Without confirmed the WHOLE batch is only previewed and NOTHING is applied.
- Ranges longer than 10 days auto-split into multiple calls.

The tool result returns updated plans/task-bank rows with task ids and full task metadata when relevant. Days are NOT automatically mock or holiday: every day is a normal study day unless the user sets it as a REST day ("chhuti") or TEST day via setDayMode. On a TEST day the mock protocol tasks (Full Mock, Analysis, Weak Topic Focus) appear AND you can still add tasks. On a REST day no auto curriculum or AI tasks appear, only explicitly scheduled ones.
There is NO web search tool here. Never emit an action like {"action":"websearch",...} — it does not exist and will be ignored.
For ANYTHING else (concepts, motivation, general questions, block suggestions, study strategies, or requests for fresh/latest/current information) reply normally in Hinglish (always ROMAN script).`;

/** Correction prompt used when the model answered with prose instead of a tool action. */
export const CHAT_TOOL_RETRY =
  'You just answered with normal text, but this message was about study tasks, plans, past chat history, or AI memory and MUST be a tool action. ' +
  'Do NOT refuse, do NOT explain your limitations, do NOT apologize. ' +
  'Searching past chats, checking memory, viewing sessions, and modifying tasks are all fully supported and safe. ' +
  'Your ENTIRE reply must be exactly one JSON object chosen from the allowed actions above — ' +
  'either ONE action (e.g. {"action":"searchChatHistory","query":"physics"}, {"action":"searchMemory","query":"physics"}, or {"action":"addTask","day":10,"intent":"revision"}), ' +
  'or {"actions":[...]} when the user asked for several changes at once.';

export const FLEXIBLE_MODE_CHAT_TOOL_INSTRUCTIONS = `You are Misa, an AI study mentor in Flexible Study Planner mode (the 90-day challenge curriculum is off).
You can manage the student's daily To-Dos, check uploaded study resources in the Study Vault, search chat history, manage AI memory, and view coaching planners.

When the user asks to add/complete/list/delete tasks, search chats, read/save memory, or view resources, your ENTIRE reply must be exactly one JSON object, no extra text.

AVAILABLE TOOLS:
- addTodo — Add a task to student's To-Do list: {"action":"addTodo","title":"Electrostatics 20 Questions","priority":"high","estimatedMinutes":45,"category":"physics"}
- editTodo — Edit a To-Do task: {"action":"editTodo","title":"Electrostatics 20 Questions","priority":"high","estimatedMinutes":60,"category":"physics"}
- reorderTodos — Move To-Do up/down/top/bottom: {"action":"reorderTodos","title":"Electrostatics 20 Questions","position":"top"}
- listTodos — View active/pending/completed tasks: {"action":"listTodos","filter":"pending"}
- toggleTodo — Mark a task done or undone: {"action":"toggleTodo","title":"Electrostatics 20 Questions","completed":true}
- deleteTodo — Remove a task from the list: {"action":"deleteTodo","title":"Electrostatics 20 Questions"}
- listVaultResources — List uploaded PDFs / notes in Study Vault: {"action":"listVaultResources","subject":"physics"}
- searchChatHistory — Search past chat history by query or date: {"action":"searchChatHistory","query":"electrostatics doubt"}
- listChatSessions — List all previous chat sessions: {"action":"listChatSessions"}
- getChatSession — View a full chat transcript: {"action":"getChatSession","sessionId":"<id>"}
- searchMemory — Search saved memory: {"action":"searchMemory","query":"physics"}
- readMemory — Read saved memory facts: {"action":"readMemory"}
- addMemory — Save fact to memory: {"action":"addMemory","content":"Physics formulas revision daily"}
- editMemory — Edit a saved memory entry: {"action":"editMemory","id":"<entryId>","content":"<new text>"}
- deleteMemory — Delete a saved memory entry (confirmation required): {"action":"deleteMemory","id":"<entryId>"}
- pinMemory — Pin a memory entry to long-term: {"action":"pinMemory","id":"<entryId>"}
- unpinMemory — Unpin a memory entry from long-term: {"action":"unpinMemory","id":"<entryId>"}
- getContext — Get overview of student's current status and to-dos: {"action":"getContext"}
- listPlanners / getSubject / getPlanner / getTest / getTests / getRoutine / getDay — uploaded coaching planners (read-only).

Only when the student EXPLICITLY asks to schedule/call:
- scheduleMessage — Schedule a future reminder message: {"action":"scheduleMessage","text":"Aaj ka revision karo!","scheduledAtISO":"2026-09-03T18:30:00+05:30","topic":"revision"}
- scheduleCall — Schedule a future voice-call check-in: {"action":"scheduleCall","reason":"Weekly progress check","scheduledAtISO":"2026-09-04T20:00:00+05:30"}
- makeCall — Call the student right now: {"action":"makeCall","reason":"Study check-in"}
- listScheduled — List pending scheduled messages/calls: {"action":"listScheduled"}
- cancelScheduled — Cancel a scheduled message/call: {"action":"cancelScheduled","id":"<id>"}

JSON FORMAT ONLY: Emit JSON directly without backticks or extra words.`;

/** Planner-tools section appended to the system prompt ONLY when the student
 *  has imported coaching planners — so the model can read them in the SAME
 *  decision hop as the task tools (never a separate flow). Read-only. */
export const CHAT_PLANNER_INSTRUCTIONS = `UPLOADED COACHING PLANNERS (read-only): the student may have imported coaching files — SUBJECT planners (chapters/topics/lectures per subject, each item may carry a date), a TEST planner (test name, date, pattern, per-subject syllabus) and a ROUTINE planner (weekly class time-table, day → slots → subject):

{"action":"listPlanners"}                                   # all planners with ids, grouped by kind
{"action":"listPlanners","type":"test"}                     # planners of one kind only: subject | test | routine
{"action":"getSubject","subject":"Physics"}                 # a subject's planner items AND the tests covering it
{"action":"getSubject","subject":"Physics","from":"2026-07-01","to":"2026-07-31"}  # only items/tests inside the date range
{"action":"getPlanner","plannerId":"<id>"}                  # one planner's full content (id comes from listPlanners)
{"action":"getPlanner","plannerId":"<id>","from":"2026-07-01","to":"2026-07-31"}  # same, only dated items/tests inside the range
{"action":"getTest","testName":"JEE Main-1"}                # one test by name (exact or partial)
{"action":"getTests"}                                       # ALL tests, sorted by date
{"action":"getTests","from":"2026-07-01","to":"2026-08-15","subject":"Maths"}  # tests inside a date range, optionally one subject
{"action":"getRoutine","day":"Monday"}                      # weekly routine (omit day for the full week)
{"action":"getDay","date":"2026-07-05"}                     # EVERYTHING on one day at once: routine classes + tests + dated lectures/items
{"action":"getDay","from":"2026-07-05","to":"2026-07-11"}   # same for a whole date range (max 31 days)

DATE RANGES: use "from"/"to" (inclusive, YYYY-MM-DD) on getTests/getSubject/getPlanner/getDay whenever the data could be large or the user names a window ("is week ke tests", "july ke tests", "kal koi test hai", "1 se 10 tarikh kya kya hai"). Resolve "aaj"/"kal"/"is week" from the date given below. For the weekly routine pass the weekday ("monday ko kya class hai" → getRoutine day:"Monday"). For "uss din kya kya hai" / "aaj kya kya hai" / "5 july ko kya hoga" / "1 se 10 tarikh kya kya hai" → getDay (combines classes + tests + lectures for that day or range).
Pick the MOST SPECIFIC action that answers the question — "tests dekho" → getTests, "physics mein kya kya hai" → getSubject, "routine batao" → getRoutine, "aaj kya kya hai" → getDay. Only use listPlanners when you need real ids / exact subject or test names. If nothing is uploaded, answer normally in Hinglish (ROMAN script) instead of JSON.`;

// ---- Tool catalog for the chat "select tools" (@ mentions) picker ----

export interface ChatToolMeta {
  id: string;
  label: string;
  description: string;
  example: string;
  /** Destructive / bulk tools still require the user's explicit "confirmed":true. */
  confirmationRequired?: boolean;
  /** Read-only tools never mutate the student's plan/bank/blocks. */
  readOnly?: boolean;
}

/** The full, user-pickable tool set — mirrors CHAT_TOOL_INSTRUCTIONS + planner tools. */
export const CHAT_TOOL_CATALOG: ChatToolMeta[] = [
  { id: 'getContext', label: 'Journey status', description: 'Current journey snapshot: date, day/phase/streak, today\'s tasks + progress, XP/habits, gaps, blocks, planners.', example: '{"action":"getContext"}', readOnly: true },
  { id: 'searchChatHistory', label: 'Search Chat History', description: 'Purani chats me words, sentences, ya specific dates se messages search karo.', example: '{"action":"searchChatHistory","query":"physics doubt"}', readOnly: true },
  { id: 'listChatSessions', label: 'List Chat Sessions', description: 'Saari past chat sessions ki list dekho.', example: '{"action":"listChatSessions"}', readOnly: true },
  { id: 'getChatSession', label: 'Get Chat Session', description: 'Kisi specific chat ka poora transcript dekho.', example: '{"action":"getChatSession","sessionId":"<id>"}', readOnly: true },
  { id: 'getPlan', label: 'Day plan', description: 'One day ka plan with real task ids.', example: '{"action":"getPlan","day":3}', readOnly: true },
  { id: 'getRange', label: 'Range overview', description: 'Plan overview for a day range (max 10 days).', example: '{"action":"getRange","fromDay":1,"toDay":7}', readOnly: true },
  { id: 'getAllTasks', label: 'All tasks of a day', description: 'AI + user tasks for one day.', example: '{"action":"getAllTasks","day":3}', readOnly: true },
  { id: 'getTaskBank', label: 'Task bank', description: 'Poora task bank (category filter optional).', example: '{"action":"getTaskBank","category":"physics"}', readOnly: true },
  { id: 'addTask', label: 'Add task', description: 'Ek task add karo ek day ke plan mein (sirf usi din).', example: '{"action":"addTask","day":3,"intent":"physics revision","durationMin":40}' },
  { id: 'bulkAddTasks', label: 'Bulk add tasks', description: 'Ek saath kai tasks add karo ek day par.', example: '{"action":"bulkAddTasks","day":3,"intents":["maths 10 questions","thermo revision"],"durationMin":30}' },
  { id: 'editTask', label: 'Edit day task', description: 'Ek day ke planned task ka title/duration/dayTo/metadata badlo.', example: '{"action":"editTask","day":3,"taskId":"d1_t1","durationMin":25}' },
  { id: 'editAnyTask', label: 'Edit bank task', description: 'Task bank ke kisi bhi task ko edit karo (title, duration, category, metadata).', example: '{"action":"editAnyTask","taskId":"ai-123","title":"New title","durationMin":45}' },
  { id: 'removeTask', label: 'Remove from day', description: 'Ek task ko sirf is day se hatao (bank kabhi delete nahi hota).', example: '{"action":"removeTask","day":3,"taskId":"d1_t1"}', confirmationRequired: true },
  { id: 'bulkRemoveTasks', label: 'Bulk remove from day', description: 'Kai tasks ko ek day se hatao.', example: '{"action":"bulkRemoveTasks","day":3,"taskIds":["d1_t1","d1_t2"]}', confirmationRequired: true },
  { id: 'deleteAnyTask', label: 'Delete bank task', description: 'Task bank se task permanently delete karo.', example: '{"action":"deleteAnyTask","taskId":"ai-123"}', confirmationRequired: true },
  { id: 'markDone', label: 'Mark done', description: 'Ek task ko complete mark karo.', example: '{"action":"markDone","day":3,"taskId":"d1_t1"}' },
  { id: 'bulkMarkDone', label: 'Bulk mark done', description: 'Kai tasks ko complete mark karo.', example: '{"action":"bulkMarkDone","day":3,"taskIds":["d1_t1","d1_t2"]}', confirmationRequired: true },
  { id: 'setDayMode', label: 'Set day mode', description: 'Day ko study / rest (chhuti) / test (mock test) day banao.', example: '{"action":"setDayMode","day":3,"mode":"test"}', confirmationRequired: true },
  { id: 'listBlocks', label: 'List blocks', description: 'Saare custom study blocks dikhao.', example: '{"action":"listBlocks"}', readOnly: true },
  { id: 'createBlock', label: 'Create block', description: 'Custom study block banao (post-journey).', example: '{"action":"createBlock","name":"Physics Mastery","days":15,"focusAreas":["physics"],"difficulty":"medium"}' },
  { id: 'editBlock', label: 'Edit block', description: 'Block ka naam/days/difficulty/habits badlo.', example: '{"action":"editBlock","blockId":"bk-1","days":20,"difficulty":"hard"}' },
  { id: 'extendBlock', label: 'Extend block', description: 'Block mein extra days jodo.', example: '{"action":"extendBlock","blockId":"bk-1","days":5}' },
  { id: 'activateBlock', label: 'Activate block', description: 'Block ko active banao.', example: '{"action":"activateBlock","blockId":"bk-1"}' },
  { id: 'deleteBlock', label: 'Delete block', description: 'Custom block delete karo.', example: '{"action":"deleteBlock","blockId":"bk-1"}', confirmationRequired: true },
  { id: 'listPlanners', label: 'List planners', description: 'Uploaded coaching planners dikhao.', example: '{"action":"listPlanners"}', readOnly: true },
  { id: 'getSubject', label: 'Subject detail', description: 'Uploaded planner se subject detail (topics, chapters, tests).', example: '{"action":"getSubject","subject":"Physics"}', readOnly: true },
  { id: 'getPlanner', label: 'Planner detail', description: 'Kisi planner ka poora structure.', example: '{"action":"getPlanner","plannerId":"<id>"}', readOnly: true },
  { id: 'getTest', label: 'Test detail', description: 'Uploaded planner se ek test ka detail.', example: '{"action":"getTest","testName":"JEE Main-1"}', readOnly: true },
  { id: 'getTests', label: 'Tests list', description: 'Uploaded planner se tests list (date range optional).', example: '{"action":"getTests","from":"2026-07-01","to":"2026-07-31"}', readOnly: true },
  { id: 'getRoutine', label: 'Routine', description: 'Uploaded planner se weekly routine.', example: '{"action":"getRoutine","day":"Monday"}', readOnly: true },
  { id: 'getDay', label: 'Day detail', description: 'Uploaded planner se ek din ka poora detail (classes + tests + lectures).', example: '{"action":"getDay","date":"2026-07-05"}', readOnly: true },
  // Custom To-Dos & Tasks
  { id: 'addTodo', label: 'Add To-Do', description: 'Student ki daily To-Do list me naya task add karo.', example: '{"action":"addTodo","title":"Physics Electrostatics Revision","priority":"high","estimatedMinutes":45,"category":"physics"}' },
  { id: 'editTodo', label: 'Edit To-Do', description: 'To-Do ka title, priority (high/med/low), duration (min), category ya position badlo.', example: '{"action":"editTodo","title":"Physics Electrostatics Revision","priority":"high","estimatedMinutes":60}' },
  { id: 'reorderTodos', label: 'Reorder To-Dos', description: 'To-Do list me task ko upar/niche ya custom order me lagao.', example: '{"action":"reorderTodos","title":"Physics Electrostatics Revision","position":"top"}' },
  { id: 'listTodos', label: 'List To-Dos', description: 'Student ke active ya pending to-dos dekho.', example: '{"action":"listTodos","filter":"pending"}', readOnly: true },
  { id: 'toggleTodo', label: 'Toggle To-Do', description: 'To-Do ko complete/uncomplete mark karo.', example: '{"action":"toggleTodo","title":"Physics Electrostatics Revision","completed":true}' },
  { id: 'deleteTodo', label: 'Delete To-Do', description: 'To-Do list se task delete karo.', example: '{"action":"deleteTodo","title":"Physics Electrostatics Revision"}' },
  // Study Resource Vault
  { id: 'listVaultResources', label: 'Study Vault', description: 'Uploaded study resources (PDFs, formula sheets, notes) ki list dekho.', example: '{"action":"listVaultResources","subject":"physics"}', readOnly: true },
  // AI Persistent Memory
  { id: 'readMemory', label: 'Read Memory', description: 'Student ki saved AI memory facts aur observations dekho.', example: '{"action":"readMemory"}', readOnly: true },
  { id: 'searchMemory', label: 'Search Memory', description: 'Memory mein keyword, weakness, ya goal search karo.', example: '{"action":"searchMemory","query":"rotation"}', readOnly: true },
  { id: 'addMemory', label: 'Save to Memory', description: 'Naya fact, goal ya preference persistent memory mein save karo.', example: '{"action":"addMemory","content":"Daily 20 physics problems"}' },
  { id: 'editMemory', label: 'Edit Memory', description: 'Saved memory entry ka text update karo.', example: '{"action":"editMemory","id":"mem-1","content":"Updated note"}' },
  { id: 'deleteMemory', label: 'Delete Memory', description: 'Saved memory entry delete karo.', example: '{"action":"deleteMemory","id":"mem-1"}', confirmationRequired: true },
  { id: 'pinMemory', label: 'Pin Memory', description: 'Memory entry ko long-term memory mein pin karo.', example: '{"action":"pinMemory","id":"mem-1"}' },
  { id: 'unpinMemory', label: 'Unpin Memory', description: 'Memory entry ko long-term memory se unpin karo.', example: '{"action":"unpinMemory","id":"mem-1"}' },
  { id: 'websearch', label: 'Web search', description: 'Live Google Search — current/recent info (news, syllabus changes, results, dates). Model khud decide karta hai kab search karna hai; raw results nahi dikhte, sirf summarized jawab.', example: 'auto — model decide karega', readOnly: true },
  // Proactive scheduling / calls
  { id: 'scheduleMessage', label: 'Schedule message', description: 'Future time par ek reminder message schedule karo (student jab pooche "kal yaad dilana").', example: '{"action":"scheduleMessage","text":"Aaj ka revision karo!","scheduledAtISO":"2026-09-03T18:30:00+05:30","topic":"revision"}' },
  { id: 'makeCall', label: 'Call now', description: 'Student ko abhi voice-call karo (jab wo khud kahu ki call karo).', example: '{"action":"makeCall","reason":"Study check-in"}' },
  { id: 'scheduleCall', label: 'Schedule call', description: 'Future time par ek voice-call check-in schedule karo.', example: '{"action":"scheduleCall","reason":"Weekly progress check","scheduledAtISO":"2026-09-04T20:00:00+05:30"}' },
  { id: 'listScheduled', label: 'List scheduled', description: 'Pending scheduled messages/calls list karo.', example: '{"action":"listScheduled"}', readOnly: true },
  { id: 'cancelScheduled', label: 'Cancel scheduled', description: 'A scheduled message/call cancel karo id se.', example: '{"action":"cancelScheduled","id":"<id>"}' },
];

/**
 * Tool actions that belong to the 90-day curriculum track. These are the ONLY
 * tools gated off when `enable90DayTrack` is OFF: the rest (to-dos, memory,
 * chat history, study vault, coaching planners, scheduler/calls, web search)
 * are mode-independent and stay available in flexible mode.
 *
 * This array is the SINGLE source of truth for the 90-day capability boundary.
 * The UI catalog filtering (`getAvailableChatTools`) is derived from it, AND the
 * execution layer gate (`ChatToolsService.runMany`/`run`/`executeAiAction`)
 * consults it — so the two can never drift apart and a toggle-off is enforced
 * at the capability level, not just cosmetically in the picker.
 */
export const NINETY_DAY_ONLY_ACTIONS: readonly string[] = [
  'getPlan',
  'getRange',
  'getAllTasks',
  'getTaskBank',
  'addTask',
  'bulkAddTasks',
  'editTask',
  'editAnyTask',
  'removeTask',
  'bulkRemoveTasks',
  'deleteAnyTask',
  'markDone',
  'bulkMarkDone',
  'setDayMode',
  'listBlocks',
  'createBlock',
  'editBlock',
  'extendBlock',
  'activateBlock',
  'deleteBlock',
];

/** Set form of NINETY_DAY_ONLY_ACTIONS for O(1) membership checks. */
export const NINETY_DAY_ONLY_ACTION_SET: ReadonlySet<string> = new Set(NINETY_DAY_ONLY_ACTIONS);

/** Every catalog action NOT gated to the 90-day track — i.e. what stays
 *  available when the track is OFF (flexible mode). Derived so the gate and the
 *  flexible-mode boundary always agree with the catalog. */
export const FLEXIBLE_SAFE_ACTIONS: readonly string[] = CHAT_TOOL_CATALOG.map((t) => t.id).filter(
  (id) => !NINETY_DAY_ONLY_ACTION_SET.has(id),
);

/**
 * Returns available chat tools based on whether the 90-day challenge track is
 * active. Derived from NINETY_DAY_ONLY_ACTIONS, so it always mirrors the
 * execution-layer capability gate (single source of truth).
 */
export function getAvailableChatTools(enable90DayTrack = true): ChatToolMeta[] {
  if (!enable90DayTrack) {
    return CHAT_TOOL_CATALOG.filter((t) => !NINETY_DAY_ONLY_ACTION_SET.has(t.id));
  }
  return CHAT_TOOL_CATALOG;
}

/**
 * Decision-hop system prompt when the user pinned a set of tools with "@"
 * mentions: ONLY those tools may be used this run, and the model must reply
 * with exactly one JSON object (or an actions array) built from them.
 *
 * `websearch` is special: it is NOT a JSON tool action — it maps to live
 * Google Search grounding on capable models. It is excluded from the JSON-only
 * list; when it is the ONLY pinned tool the model replies normally (grounded,
 * never JSON). When pinned alongside JSON tools it stays available for the
 * final answer while the JSON tools run the plan work.
 *
 * Defense-in-depth: 90-day-only tools are ALWAYS stripped from the scope here,
 * even if a caller hands them in directly. A 90-day tool must never appear in
 * the decision prompt, so a model cannot be tempted to emit one while the
 * track is off. (Normally `resolveToolScope` already filters these out; this
 * is an independent guarantee for any future caller.)
 */
export function chatToolScopeInstructions(onlyTools: string[]): string {
  const hasWebSearch = onlyTools.includes('websearch');
  const selected = CHAT_TOOL_CATALOG.filter(
    (t) => onlyTools.includes(t.id) && t.id !== 'websearch' && !NINETY_DAY_ONLY_ACTION_SET.has(t.id),
  );
  const webSearchLine = hasWebSearch
    ? `\nWEB SEARCH is enabled for this run: you can pull CURRENT/recent information (news, syllabus changes, NTA updates, results, dates) with live Google Search grounding. Use it whenever the user's request needs fresh info. Raw search results are internal — the user sees only your synthesized answer.`
    : '';
  // websearch-only run: no JSON tool protocol — answer normally with grounding.
  if (selected.length === 0) {
    return (
      `The user selected ONLY the web search tool for this run.` +
      webSearchLine +
      `\nReply normally in Hinglish (always ROMAN script — no Devanagari unless the user explicitly asked). Use live web search for current/recent facts; do NOT emit JSON or any tool-call protocol text. If a question is about the study plan and NOT something that needs fresh info, answer from your own knowledge.`
    );
  }
  const lines = selected.map((t) => {
    const confirm = t.confirmationRequired ? ' [needs the user\'s "confirmed":true first]' : '';
    const ro = t.readOnly ? ' (read-only)' : '';
    return `- ${t.id} — ${t.description}${ro}${confirm}. Example: ${t.example}`;
  });
  const multiToolRule =
    selected.length > 1
      ? `\nMULTIPLE tools are selected. Use EVERY selected tool that the user's request touches — never run just one when the request needs several. ` +
        `When several are needed, emit them TOGETHER in one {"actions":[...]} array: READ/view tools first (getPlan, getDay, getTests, getSubject, getTaskBank, getContext...), then MODIFY tools after them (addTask, editTask, markDone, removeTask...). ` +
        `Example: request "aaj ke tasks batao aur ek revision add karo" with getDay+addTask selected → {"actions":[{"action":"getDay",...},{"action":"addTask",...}]}. ` +
        `Do NOT silently drop a selected tool the request asks about.\n`
      : '';
  return (
    `The user selected ONLY these tools for this run. Your ENTIRE reply must be exactly one JSON object ` +
    `(single action, or an {"actions":[...]} array when several changes are requested) that uses ONLY the selected tools below.\n` +
    `NEVER use any tool that is NOT listed. If the request cannot be fulfilled with the selected tools, reply with a short normal-text message in Hinglish (always ROMAN script) explaining which tool is missing.\n` +
    multiToolRule +
    webSearchLine +
    `\nSelected tools:\n${lines.join('\n')}`
  );
}

export const TOOL_LABELS: Record<string, string> = {
  getPlan: 'Plan dekha',
  getRange: 'Range dekhi',
  getContext: 'Journey status dekha',
  listPlanners: 'Planners dekhe',
  getSubject: 'Subject detail dekha',
  getPlanner: 'Planner detail dekha',
  getTest: 'Test detail dekha',
  getTests: 'Tests dekhe',
  getRoutine: 'Routine dekhi',
  getDay: 'Day detail dekha',
  addTask: 'Task add kiya',
  bulkAddTasks: 'Tasks add kiye',
  removeTask: 'Task hata diya',
  bulkRemoveTasks: 'Tasks hata diye',
  setDayMode: 'Din mode badla',
  editTask: 'Task edit kiya',
  markDone: 'Task done kiya',
  bulkMarkDone: 'Tasks done kiye',
  getAllTasks: 'Tasks dekhe',
  getTaskBank: 'Task bank dekha',
  editAnyTask: 'Task bank edit kiya',
  deleteAnyTask: 'Task bank delete kiya',
  createBlock: 'Block banaya',
  deleteBlock: 'Block delete kiya',
  activateBlock: 'Block activate kiya',
  editBlock: 'Block edit kiya',
  listBlocks: 'Blocks dekhe',
  extendBlock: 'Block extend kiya',
  addTodo: 'To-do add kiya',
  editTodo: 'To-do edit kiya',
  reorderTodos: 'To-dos reorder kiye',
  listTodos: 'To-dos dekhe',
  toggleTodo: 'To-do status badla',
  deleteTodo: 'To-do delete kiya',
  listVaultResources: 'Study vault dekha',
  searchChatHistory: 'Purani chats search ki',
  listChatSessions: 'Chat sessions dekhe',
  getChatSession: 'Chat transcript dekha',
  searchMemory: 'Memory search ki',
  readMemory: 'Memory dekhi',
  addMemory: 'Memory me save kiya',
  editMemory: 'Memory edit ki',
  deleteMemory: 'Memory delete ki',
  pinMemory: 'Memory pin ki',
  unpinMemory: 'Memory unpin ki',
  websearch: 'Web search hua',
  webSearch: 'Web search hua',
  getTime: 'Time & Date dekha',
  saveCustomMemory: 'Memory me save kiya',
  scheduleMessage: 'Message schedule kiya',
  makeCall: 'Call shuru ki',
  scheduleCall: 'Call schedule ki',
  listScheduled: 'Scheduled items list ki',
  cancelScheduled: 'Scheduled item cancel kiya',
};

