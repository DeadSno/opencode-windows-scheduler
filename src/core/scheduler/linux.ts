import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { buildAtTimestamp } from "../one-shot.js";
import { PosixSchedulerBase, shellQuote } from "./posix.js";
import type { RegistryEntry } from "./registry.js";

const execFileAsync = promisify(execFile);

const BLOCK_BEGIN = "# >>> opencode-scheduler >>>";
const BLOCK_END = "# <<< opencode-scheduler <<<";

/**
 * Бэкенд планировщика Linux на основе пользовательского crontab.
 *
 * Все задачи плагина живут в одном управляемом блоке:
 *   # >>> opencode-scheduler >>>
 *   # task: <имя>
 *   <cron> /bin/bash '<обёртка>' >> '<лог>' 2>&1
 *   # <<< opencode-scheduler <<<
 * При паузе строка задачи комментируется ("# PAUSED: ..."), при удалении —
 * блок перегенерируется из реестра.
 */
export class LinuxScheduler extends PosixSchedulerBase {
  readonly platform: NodeJS.Platform = "linux";
  readonly title = "OpenCode Scheduler";

  constructor() {
    super("linux");
  }

  private cronLine(entry: RegistryEntry): string {
    if (entry.triggerType !== "cron") {
      // Файловый/MCP-триггер не имеет расписания — держим задачу только в реестре.
      return "";
    }
    const log = entry.logFile ? ` >> ${shellQuote(entry.logFile)} 2>&1` : "";
    const cmd = `/bin/bash ${shellQuote(entry.command)}${log}`;
    return `${entry.schedule} ${cmd}`;
  }

  private renderBlock(entries: RegistryEntry[]): string {
    const lines: string[] = [BLOCK_BEGIN];
    for (const entry of entries) {
      const line = this.cronLine(entry);
      if (!line) continue;
      lines.push(`# task: ${entry.name}`);
      lines.push(entry.paused ? `# PAUSED: ${line}` : line);
    }
    lines.push(BLOCK_END);
    return lines.join("\n");
  }

  /** Читает текущий crontab (пустая строка, если crontab ещё не создан). */
  private async readCrontab(): Promise<string> {
    try {
      const { stdout } = await execFileAsync("crontab", ["-l"], {
        maxBuffer: 10 * 1024 * 1024,
      });
      return stdout;
    } catch {
      // "no crontab for user" — это нормальное состояние.
      return "";
    }
  }

  /** Убирает управляемый блок плагина из текста crontab. */
  private stripBlock(content: string): string {
    const lines = content.split(/\r?\n/);
    const result: string[] = [];
    let inside = false;
    for (const line of lines) {
      if (line.trim() === BLOCK_BEGIN) {
        inside = true;
        continue;
      }
      if (line.trim() === BLOCK_END) {
        inside = false;
        continue;
      }
      if (!inside) result.push(line);
    }
    return result.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
  }

  /** Записывает crontab через stdin: `crontab -`. */
  private async writeCrontab(content: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("crontab", ["-"], { stdio: ["pipe", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`crontab - завершился с кодом ${code}: ${stderr.trim()}`));
      });
      child.stdin.end(content.endsWith("\n") ? content : `${content}\n`);
    });
  }

  /** Перегенерирует блок плагина из реестра. */
  private async rebuildCrontab(): Promise<void> {
    const entries = await this.registry.load();
    const current = await this.readCrontab();
    const base = this.stripBlock(current);
    const block = this.renderBlock(entries);

    // Пустой блок (нет задач) не пишем, чтобы не оставлять мусор в crontab.
    const hasTasks = block.split("\n").some((line) => line.trim().startsWith("# task:"));
    const next = [base, hasTasks ? block : ""].filter(Boolean).join("\n");
    await this.writeCrontab(next);
  }

  /** Строка команды one-shot для stdin `at`. */
  private atCommand(entry: RegistryEntry): string {
    const log = entry.logFile ? ` >> ${shellQuote(entry.logFile)} 2>&1` : "";
    return `/bin/bash ${shellQuote(entry.command)}${log}`;
  }

  /**
   * Ставит one-shot в `at` и возвращает id задания.
   * `at -t` принимает локальное время системы в формате YYYYMMDDHHMM.
   */
  private async scheduleAt(entry: RegistryEntry): Promise<string> {
    if (!entry.runAt) {
      throw new Error(`Задача "${entry.name}": не задано runAt для one-shot.`);
    }
    const timestamp = buildAtTimestamp(entry.runAt);
    return new Promise<string>((resolve, reject) => {
      const child = spawn("at", ["-t", timestamp], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.on("error", (err) => {
        reject(
          new Error(
            `Не удалось вызвать at (установите пакет at): ${
              err instanceof Error ? err.message : String(err)
            }`
          )
        );
      });
      child.on("close", (code) => {
        if (code !== 0) {
          reject(
            new Error(
              `at завершился с кодом ${code}: ${stderr.trim() || stdout.trim()}`
            )
          );
          return;
        }
        const match = /job\s+(\d+)/i.exec(stdout);
        if (!match) {
          reject(new Error(`at не вернул id задания: ${stdout.trim()}`));
          return;
        }
        resolve(match[1]);
      });
      child.stdin.end(`${this.atCommand(entry)}\n`);
    });
  }

  /** Отменяет задание at, если оно ещё существует. */
  private async cancelAt(entry: RegistryEntry): Promise<void> {
    if (!entry.atJobId) return;
    try {
      await execFileAsync("atrm", [entry.atJobId]);
    } catch {
      // Задание уже выполнилось или было удалено — это не ошибка.
    }
    delete entry.atJobId;
  }

  protected async installEntry(entry: RegistryEntry): Promise<void> {
    if (entry.triggerType === "once") {
      if (!entry.paused) {
        entry.atJobId = await this.scheduleAt(entry);
      }
      return;
    }
    await this.rebuildCrontab();
  }

  protected async uninstallEntry(entry: RegistryEntry): Promise<void> {
    if (entry.triggerType === "once") {
      await this.cancelAt(entry);
      return;
    }
    await this.rebuildCrontab();
  }

  protected async applyPause(entry: RegistryEntry, paused: boolean): Promise<void> {
    if (entry.triggerType === "once") {
      if (paused) {
        await this.cancelAt(entry);
      } else if (entry.runAt && Date.parse(entry.runAt) > Date.now()) {
        entry.atJobId = await this.scheduleAt(entry);
      }
      await this.registry.upsert(entry);
      return;
    }
    await this.rebuildCrontab();
  }
}
