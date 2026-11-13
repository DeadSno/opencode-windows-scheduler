import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { sanitizeName } from "../../types.js";
import { PosixSchedulerBase } from "./posix.js";
import type { RegistryEntry } from "./registry.js";

const execFileAsync = promisify(execFile);

/** Папка пользовательских LaunchAgents. */
const LAUNCH_AGENTS_DIR = path.join(os.homedir(), "Library", "LaunchAgents");

/** Префикс label/файлов плагина. */
const LABEL_PREFIX = "com.opencode.scheduler";

/** Экранирует текст для XML. */
function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Расписание launchd, полученное из cron-выражения. */
interface LaunchdSchedule {
  /** StartInterval в секундах (для «каждые N минут»). */
  interval?: number;
  /** StartCalendarInterval (для фиксированного времени). */
  calendar?: { Minute?: number; Hour?: number; Weekday?: number };
}

/**
 * Преобразует поддерживаемое 5-полевое cron-выражение в расписание launchd.
 * Поддерживается то же подмножество, что и у Windows-бэкенда.
 */
export function cronToLaunchdSchedule(cron: string): LaunchdSchedule {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(
      `Ожидалось 5 полей cron-выражения, получено ${fields.length}.`
    );
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  const star = (v: string) => v === "*";
  const intIn = (v: string, min: number, max: number): number | undefined => {
    if (!/^\d+$/.test(v)) return undefined;
    const n = parseInt(v, 10);
    return n >= min && n <= max ? n : undefined;
  };

  if (
    star(minute) && star(hour) && star(dayOfMonth) && star(month) && star(dayOfWeek)
  ) {
    return { interval: 60 };
  }

  const step = /^\*\/(\d+)$/.exec(minute);
  if (step && star(hour) && star(dayOfMonth) && star(month) && star(dayOfWeek)) {
    const n = parseInt(step[1], 10);
    if (n > 0) return { interval: n * 60 };
  }

  const m = intIn(minute, 0, 59);
  const h = intIn(hour, 0, 23);
  if (m === undefined) {
    throw new Error("Неподдерживаемое cron-выражение для launchd.");
  }

  // M * * * * — каждый час в минуту M.
  if (star(hour) && star(dayOfMonth) && star(month) && star(dayOfWeek)) {
    return { calendar: { Minute: m } };
  }

  if (h === undefined || !star(dayOfMonth) || !star(month)) {
    throw new Error("Неподдерживаемое cron-выражение для launchd.");
  }

  // M H * * * — ежедневно.
  if (star(dayOfWeek)) {
    return { calendar: { Minute: m, Hour: h } };
  }

  // M H * * D — еженедельно (0 и 7 — воскресенье).
  const d = intIn(dayOfWeek, 0, 7);
  if (d === undefined) {
    throw new Error("Неподдерживаемое cron-выражение для launchd.");
  }
  return { calendar: { Minute: m, Hour: h, Weekday: d } };
}

/** Собирает XML plist для задачи. */
function buildPlist(label: string, entry: RegistryEntry): string {
  const schedule =
    entry.triggerType !== "cron"
      ? { interval: 315_360_000 } // file/mcp-event: 10 лет — фактически «никогда».
      : cronToLaunchdSchedule(entry.schedule);

  const scheduleXml: string[] = [];
  if (schedule.interval !== undefined) {
    scheduleXml.push(
      "  <key>StartInterval</key>",
      `  <integer>${schedule.interval}</integer>`
    );
  }
  if (schedule.calendar) {
    scheduleXml.push("  <key>StartCalendarInterval</key>", "  <dict>");
    if (schedule.calendar.Minute !== undefined) {
      scheduleXml.push(
        "    <key>Minute</key>",
        `    <integer>${schedule.calendar.Minute}</integer>`
      );
    }
    if (schedule.calendar.Hour !== undefined) {
      scheduleXml.push(
        "    <key>Hour</key>",
        `    <integer>${schedule.calendar.Hour}</integer>`
      );
    }
    if (schedule.calendar.Weekday !== undefined) {
      scheduleXml.push(
        "    <key>Weekday</key>",
        `    <integer>${schedule.calendar.Weekday}</integer>`
      );
    }
    scheduleXml.push("  </dict>");
  }

  const workdir = entry.workingDirectory || process.cwd();
  const log = entry.logFile;
  const logXml = log
    ? [
        "  <key>StandardOutPath</key>",
        `  <string>${xmlEscape(log)}</string>`,
        "  <key>StandardErrorPath</key>",
        `  <string>${xmlEscape(log)}</string>`,
      ]
    : [];

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ' +
      '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${xmlEscape(label)}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    "    <string>/bin/bash</string>",
    `    <string>${xmlEscape(entry.command)}</string>`,
    "  </array>",
    "  <key>WorkingDirectory</key>",
    `  <string>${xmlEscape(workdir)}</string>`,
    ...logXml,
    "  <key>RunAtLoad</key>",
    "  <false/>",
    ...scheduleXml,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

/**
 * Бэкенд планировщика macOS на основе launchd.
 *
 * Каждая задача — отдельный LaunchAgent:
 *   ~/Library/LaunchAgents/com.opencode.scheduler.<name>.plist
 * Управление — через launchctl load/unload -w.
 */
export class MacScheduler extends PosixSchedulerBase {
  readonly platform: NodeJS.Platform = "darwin";
  readonly title = "OpenCode Scheduler";

  constructor() {
    super("mac");
  }

  private label(name: string): string {
    return `${LABEL_PREFIX}.${sanitizeName(name)}`;
  }

  private plistPath(name: string): string {
    return path.join(LAUNCH_AGENTS_DIR, `${this.label(name)}.plist`);
  }

  /** Выполняет launchctl, не считая ошибку фатальной (unload несуществующего). */
  private async launchctl(args: string[]): Promise<void> {
    try {
      await execFileAsync("launchctl", args, { maxBuffer: 1024 * 1024 });
    } catch {
      // launchctl возвращает ошибку, если агент ещё не загружен — это нормально.
    }
  }

  protected async installEntry(entry: RegistryEntry): Promise<void> {
    await fs.mkdir(LAUNCH_AGENTS_DIR, { recursive: true });
    const plistPath = this.plistPath(entry.name);
    await this.launchctl(["unload", plistPath]);
    await fs.writeFile(plistPath, buildPlist(this.label(entry.name), entry), "utf8");
    await this.launchctl(["load", "-w", plistPath]);
  }

  protected async uninstallEntry(entry: RegistryEntry): Promise<void> {
    const plistPath = this.plistPath(entry.name);
    await this.launchctl(["unload", "-w", plistPath]);
    await fs.unlink(plistPath).catch(() => {});
  }

  protected async applyPause(entry: RegistryEntry, paused: boolean): Promise<void> {
    const plistPath = this.plistPath(entry.name);
    if (paused) {
      await this.launchctl(["unload", "-w", plistPath]);
    } else {
      await this.launchctl(["load", "-w", plistPath]);
    }
  }
}
