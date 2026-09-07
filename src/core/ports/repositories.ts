import type { AppState } from '../domain/state';
import type { TaskBankEntry } from '../domain/task-bank';
import type { Habit } from '../domain/habit';
import type { ModelInfo } from '../domain/llm';
import type { ChatStoreState } from '../domain/chat';

// Persistence ports. Implementations live in infra/storage and are injected.

export interface StateRepository {
  load(): AppState;
  save(state: AppState): void;
  clear(): void;
  /** One-time notice when a save silently had to trim memory to fit the
   *  storage quota (M7). Returns and clears it so the UI shows it at most
   *  once per prune. Optional — storage backends that never prune return null. */
  consumePruneNotice?(): string | null;
  /** One-time notice when the last persist hit a storage WRITE failure (quota,
   *  private-mode denial, etc.). Returns and clears it so the UI can warn the
   *  user instead of silently dropping their data on the next restart.
   *  Optional — backends that can't report write failures return null. */
  consumeWriteError?(): string | null;
}

/** Read/write handle with an in-memory copy; preferred by services. */
export interface StateStore {
  get(): AppState;
  save(state: AppState): void;
}

export interface TaskBankRepository {
  /** All active + inactive entries (static seed merged with dynamic bank). */
  getAll(): TaskBankEntry[];
  getById(id: string): TaskBankEntry | undefined;
  /** Persist an AI-generated / user-created task into the dynamic bank. */
  saveEntry(entry: TaskBankEntry): void;
  /** Replace the whole dynamic bank (e.g. after removal). */
  replaceDynamic(entries: TaskBankEntry[]): void;
}

export interface HabitRepository {
  getAllHabits(): Habit[];
  getHabitById(id: string): Habit | undefined;
  getHabitsByLevel(levelId: number): Habit[];
}

export interface ModelCacheRepository {
  get(providerId: string): ModelInfo[] | null;
  set(providerId: string, models: ModelInfo[]): void;
  clear(providerId: string): void;
}

export interface KeyValueRepository {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface ChatRepository {
  load(): ChatStoreState;
  save(state: ChatStoreState): void;
  /** AUDIT FIX (round 2): one-shot notice when the LAST save hit a storage
   *  write failure (quota). Consumed by the UI so chat data loss is never
   *  silent. Optional — backends that can't report it return null. */
  consumeWriteError?(): string | null;
}
