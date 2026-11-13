import fs from "node:fs/promises";
import path from "node:path";
import { PLUGIN_DIR } from "../../types.js";
import type { TriggerType } from "./types.js";

/**
 * Запись реестра задач POSIX-бэкендов.
 *
 * crontab и launchd не хранят исходный cron-текст в удобном виде, а для
 * файловых триггеров вообще не создают расписание. Поэтому источником правды
 * для Linux/macOS служит собственный JSON-реестр плагина.
 */
export interface RegistryEntry {
  name: string;
  schedule: string;
  command: string;
  logFile?: string;
  workingDirectory?: string;
  triggerType: TriggerType;
  /** Абсолютное время однократного запуска (ISO-8601, только для once). */
  runAt?: string;
  /** Идентификатор задания `at` на Linux (для отмены one-shot). */
  atJobId?: string;
  paused: boolean;
  createdAt: string;
  /** LLM-модель задачи (опционально). */
  model?: string;
  /** Приоритет задачи 0..10 (опционально). */
  priority?: number;
}

/** Реестр задач конкретного бэкенда: PLUGIN_DIR/scheduler-<backend>.json. */
export class TaskRegistry {
  private readonly file: string;

  constructor(backendId: string) {
    this.file = path.join(PLUGIN_DIR, `scheduler-${backendId}.json`);
  }

  /** Путь к файлу реестра (для диагностики). */
  get path(): string {
    return this.file;
  }

  async load(): Promise<RegistryEntry[]> {
    try {
      const raw = await fs.readFile(this.file, "utf8");
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (entry): entry is RegistryEntry =>
          entry && typeof entry.name === "string" && typeof entry.command === "string"
      );
    } catch {
      return [];
    }
  }

  async save(entries: RegistryEntry[]): Promise<void> {
    await fs.mkdir(PLUGIN_DIR, { recursive: true });
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(entries, null, 2), "utf8");
    await fs.rename(tmp, this.file);
  }

  async find(name: string): Promise<RegistryEntry | undefined> {
    const entries = await this.load();
    return entries.find((e) => e.name.toLowerCase() === name.toLowerCase());
  }

  async upsert(entry: RegistryEntry): Promise<void> {
    const entries = await this.load();
    const index = entries.findIndex(
      (e) => e.name.toLowerCase() === entry.name.toLowerCase()
    );
    if (index === -1) entries.push(entry);
    else entries[index] = entry;
    await this.save(entries);
  }

  async remove(name: string): Promise<void> {
    const entries = await this.load();
    await this.save(
      entries.filter((e) => e.name.toLowerCase() !== name.toLowerCase())
    );
  }

  async setPaused(name: string, paused: boolean): Promise<void> {
    const entries = await this.load();
    const entry = entries.find(
      (e) => e.name.toLowerCase() === name.toLowerCase()
    );
    if (!entry) return;
    entry.paused = paused;
    await this.save(entries);
  }
}
