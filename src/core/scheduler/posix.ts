import { spawn } from "node:child_process";
import type { ScheduledTaskInfo } from "../../types.js";
import { TaskRegistry, type RegistryEntry } from "./registry.js";
import type {
  CreateTaskOptions,
  RunTaskResult,
  SchedulerBackend,
} from "./types.js";

/**
 * Общая база для LinuxScheduler и MacScheduler.
 *
 * Инкапсулирует всё, что одинаково на POSIX: реестр задач, немедленный запуск
 * bash-обёртки detached-процессом, список задач и удаление.
 * Различия (crontab vs launchd) реализуют наследники через installEntry,
 * uninstallEntry и applyPause.
 */
export abstract class PosixSchedulerBase implements SchedulerBackend {
  abstract readonly platform: NodeJS.Platform;
  abstract readonly title: string;

  protected readonly registry: TaskRegistry;

  constructor(backendId: string) {
    this.registry = new TaskRegistry(backendId);
  }

  /** Регистрирует запись в планировщике ОС (crontab-строка или plist). */
  protected abstract installEntry(entry: RegistryEntry): Promise<void>;
  /** Убирает запись из планировщика ОС. */
  protected abstract uninstallEntry(entry: RegistryEntry): Promise<void>;
  /** Применяет состояние паузы к записи в планировщике ОС. */
  protected abstract applyPause(entry: RegistryEntry, paused: boolean): Promise<void>;

  async createTask(options: CreateTaskOptions): Promise<void> {
    const entry: RegistryEntry = {
      name: options.name,
      schedule: options.schedule,
      command: options.command,
      logFile: options.logFile,
      workingDirectory: options.workingDirectory,
      triggerType: options.triggerType ?? "cron",
      paused: false,
      createdAt: new Date().toISOString(),
      ...(options.model ? { model: options.model } : {}),
      ...(options.priority !== undefined ? { priority: options.priority } : {}),
    };

    await this.registry.upsert(entry);
    await this.installEntry(entry);
  }

  async deleteTask(name: string): Promise<void> {
    const entry = await this.registry.find(name);
    await this.registry.remove(name);
    if (entry) {
      await this.uninstallEntry(entry);
    }
  }

  async pauseTask(name: string): Promise<void> {
    const entry = await this.registry.find(name);
    if (!entry) throw new Error(`Задача "${name}" не найдена.`);
    await this.registry.setPaused(name, true);
    await this.applyPause(entry, true);
  }

  async resumeTask(name: string): Promise<void> {
    const entry = await this.registry.find(name);
    if (!entry) throw new Error(`Задача "${name}" не найдена.`);
    await this.registry.setPaused(name, false);
    await this.applyPause(entry, false);
  }

  async listTasks(): Promise<ScheduledTaskInfo[]> {
    const entries = await this.registry.load();
    return entries.map((entry) => ({
      taskName: entry.name,
      status: entry.paused ? "Disabled" : "Ready",
      paused: entry.paused,
    }));
  }

  /**
   * Запускает обёртку напрямую, минуя планировщик ОС. Это одинаково работает
   * и для cron-, и для файловых задач. Сама обёртка отвечает за lock-файл,
   * таймаут и запись истории.
   */
  async runTask(name: string): Promise<RunTaskResult> {
    const entry = await this.registry.find(name);
    if (!entry) throw new Error(`Задача "${name}" не найдена.`);

    const child = spawn("/bin/bash", [entry.command], {
      detached: true,
      stdio: "ignore",
      cwd: entry.workingDirectory || process.cwd(),
    });
    child.unref();

    return { alreadyRunning: false };
  }
}

/**
 * Экранирует строку для безопасной вставки в POSIX shell
 * (одинарные кавычки: ' -> '\'').
 */
export function shellQuote(value: string): string {
  if (value === "") return "''";
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
