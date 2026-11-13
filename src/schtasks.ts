/**
 * Совместимость: раньше здесь жила вся логика schtasks.
 * Теперь она перенесена в ./core/scheduler/windows.js (класс WindowsScheduler),
 * а этот файл оставлен как тонкая обёртка для старых скриптов/тестов.
 *
 * @deprecated Используйте WindowsScheduler из ./core/scheduler/index.js.
 */
import type { ScheduledTaskInfo } from "./types.js";
import {
  SchtasksError,
  WindowsScheduler,
  runSchtasks,
  taskFullName,
} from "./core/scheduler/windows.js";
import { getTaskLogs } from "./core/scheduler/logs.js";

export { SchtasksError, runSchtasks, taskFullName, getTaskLogs };
export type { SchtasksResult } from "./core/scheduler/windows.js";

const backend = new WindowsScheduler();

/**
 * Старый API создания задачи с уже готовыми флагами schtasks.
 * Оставлен для test-create.cjs и внешних скриптов.
 *
 * @deprecated Используйте backend.createTask({ name, command, schedule }).
 */
export async function createTask(
  name: string,
  trCommand: string,
  scheduleFlags: string[]
): Promise<void> {
  const args = [
    "/create",
    "/tn",
    taskFullName(name),
    "/tr",
    trCommand,
    ...scheduleFlags,
    "/f",
  ];
  const result = await runSchtasks(args);
  if (result.code !== 0) {
    throw new SchtasksError(
      `Не удалось создать задачу "${name}": ${result.stderr || result.stdout}`,
      result.code,
      result.stderr
    );
  }
}

/** @deprecated Используйте backend.listTasks(). */
export function listTasks(): Promise<ScheduledTaskInfo[]> {
  return backend.listTasks();
}

/** @deprecated Используйте backend.deleteTask(name). */
export function deleteTask(name: string): Promise<void> {
  return backend.deleteTask(name);
}

/** @deprecated Используйте backend.runTask(name). */
export function runTask(name: string): Promise<{ alreadyRunning: boolean }> {
  return backend.runTask(name);
}

/** @deprecated Используйте backend.pauseTask(name). */
export function pauseTask(name: string): Promise<void> {
  return backend.pauseTask(name);
}

/** @deprecated Используйте backend.resumeTask(name). */
export function resumeTask(name: string): Promise<void> {
  return backend.resumeTask(name);
}
