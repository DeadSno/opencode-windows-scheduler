import os from "node:os";
import path from "node:path";
import { z } from "zod";

/** Префикс всех задач плагина (историческое имя, сохраняется для совместимости). */
export const TASK_PREFIX = "OpenCode\\windows-scheduler";

/** Папка задач плагина в планировщике ОС (Windows). */
export const TASK_FOLDER = "OpenCode";
export const TASK_FOLDER_NAME = "windows-scheduler";

/**
 * Директория для хранения файлов плагина (обёртки, логи, блокировки, история).
 *
 * Windows: %APPDATA%\opencode\windows-scheduler (как раньше — без миграции).
 * macOS/Linux: $XDG_CONFIG_HOME/opencode/windows-scheduler или
 *              ~/.config/opencode/windows-scheduler.
 */
function resolvePluginDir(): string {
  // Explicit override (tests, custom installations). Takes precedence on every platform.
  const custom = process.env.OPENCODE_SCHEDULER_HOME?.trim();
  if (custom) return path.resolve(custom);

  if (process.platform === "win32") {
    const base = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(base, "opencode", TASK_FOLDER_NAME);
  }

  const configHome =
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(configHome, "opencode", TASK_FOLDER_NAME);
}

export const PLUGIN_DIR = resolvePluginDir();

export const LOCK_DIR = path.join(PLUGIN_DIR, "locks");
export const LOG_DIR = path.join(PLUGIN_DIR, "logs");
export const WRAPPER_DIR = path.join(PLUGIN_DIR, "wrappers");

/** true, если плагин запущен на Windows. */
export const IS_WINDOWS = process.platform === "win32";

/** Порог возраста lock-файла, после которого он считается зависшим (24 часа). */
export const STALE_LOCK_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Приводит имя задачи к безопасному виду для имён файлов (обёртка, промпт, lock, лог).
 * Кириллица транслитерируется, прочие спецсимволы заменяются на дефис.
 * Используется единообразно при создании задачи (index.ts) и при чтении логов (schtasks.ts).
 */
export function sanitizeName(name: string): string {
  const translit: Record<string, string> = {
    а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e",
    ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m",
    н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u",
    ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch",
    ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
  };

  let result = name.toLowerCase();
  result = result.split("").map((c) => translit[c] || c).join("");
  result = result.replace(/[^a-z0-9_\-]/g, "-");
  result = result.replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  return result || "task";
}

/**
 * Схема аргументов для schedule_job.
 * schedule принимает только 5-полевые cron-выражения.
 */
export const ScheduleJobArgs = z.object({
  name: z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9_\-]+$/, "Имя задачи должно содержать только буквы, цифры, подчёркивание и дефис")
    .describe("Имя задачи (уникально в рамках префикса OpenCode\\windows-scheduler)"),
  schedule: z
    .string()
    .min(1)
    .describe("5-полевое cron-выражение (минута час день_месяца месяц день_недели)"),
  prompt: z.string().min(1).describe("Промпт, который передаётся в opencode run при запуске задачи"),
  timeoutSeconds: z
    .number()
    .int()
    .positive()
    .optional()
    .default(3600)
    .describe("Таймаут выполнения задачи в секундах (по умолчанию 3600)"),
  workdir: z
    .string()
    .optional()
    .describe("Рабочая директория для выполнения opencode run (по умолчанию текущая)"),
});

export type ScheduleJobArgs = z.infer<typeof ScheduleJobArgs>;

export const DeleteJobArgs = z.object({
  name: z.string().min(1).describe("Имя задачи для удаления"),
});
export type DeleteJobArgs = z.infer<typeof DeleteJobArgs>;

export const RunJobNowArgs = z.object({
  name: z.string().min(1).describe("Имя задачи для немедленного запуска"),
});
export type RunJobNowArgs = z.infer<typeof RunJobNowArgs>;

export const ListJobsArgs = z.object({});
export type ListJobsArgs = z.infer<typeof ListJobsArgs>;

/**
 * Результат преобразования cron в флаги schtasks.
 */
export interface CronConversion {
  /** Тип расписания schtasks: MINUTE, DAILY или WEEKLY. */
  sc: "MINUTE" | "HOURLY" | "DAILY" | "WEEKLY";
  /** Дополнительные флаги командной строки (кроме /sc и /tn /tr /f). */
  extraFlags: string[];
  /** Время начала для /st (HH:MM) или undefined. */
  startTime?: string;
  /** Дни недели для /d (при WEEKLY). */
  days?: string;
  /** Интервал в минутах для /mo (при MINUTE). */
  interval?: number;
}

/**
 * Информация о задаче, полученная из schtasks /query.
 */
export interface ScheduledTaskInfo {
  /** Короткое имя задачи (без папки планировщика). */
  taskName: string;
  folder?: string;
  taskNameToRun?: string;
  nextRunTime?: string;
  status?: string;
  logonMode?: string;
  lastRunTime?: string;
  lastResult?: string;
  author?: string;
  taskToRun?: string;
  comment?: string;
  triggers?: string[];
  /** true — задача поставлена на паузу (disabled). */
  paused?: boolean;
}
