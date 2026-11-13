import { WindowsScheduler } from "./windows.js";
import { LinuxScheduler } from "./linux.js";
import { MacScheduler } from "./mac.js";
import type { SchedulerBackend } from "./types.js";

export type {
  SchedulerBackend,
  CreateTaskOptions,
  RunTaskResult,
  TriggerType,
} from "./types.js";
export { WindowsScheduler, SchtasksError, WINDOWS_TASK_PREFIX } from "./windows.js";
export { LinuxScheduler } from "./linux.js";
export { MacScheduler } from "./mac.js";
export { TaskRegistry } from "./registry.js";
export type { RegistryEntry } from "./registry.js";

/**
 * Фабрика бэкендов планировщика по платформе.
 *
 *  - win32  → WindowsScheduler (schtasks);
 *  - darwin → MacScheduler (launchd);
 *  - linux (и прочие POSIX) → LinuxScheduler (crontab).
 */
export function createSchedulerBackend(
  platform: NodeJS.Platform = process.platform
): SchedulerBackend {
  if (platform === "win32") return new WindowsScheduler();
  if (platform === "darwin") return new MacScheduler();
  return new LinuxScheduler();
}

let cached: SchedulerBackend | null = null;

/** Возвращает общий (закэшированный) бэкенд текущей платформы. */
export function getSchedulerBackend(): SchedulerBackend {
  if (!cached) cached = createSchedulerBackend();
  return cached;
}

/** Название планировщика для текущей платформы (для GUI/логов). */
export function getSchedulerTitle(platform: NodeJS.Platform = process.platform): string {
  return createSchedulerBackend(platform).title;
}
