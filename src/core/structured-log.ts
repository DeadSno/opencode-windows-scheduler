import fs from "node:fs";
import path from "node:path";
import { LOG_DIR } from "../types.js";
import { redactSecretsInText } from "./secrets.js";

/**
 * Машиночитаемые логи запусков (Спринт 22).
 *
 * Формат — JSONL: одна строка = один JSON-объект. Файл лежит рядом с
 * человекочитаемыми логами задач: `<PLUGIN_DIR>/logs/runs.jsonl`.
 *
 * Ротация простая: при превышении лимита текущий файл переименовывается
 * в `runs.jsonl.1` (предыдущий `.1` перезаписывается). Этого достаточно,
 * чтобы лог не рос бесконечно, и не требуется внешних зависимостей.
 *
 * Любая ошибка записи логируется в console.warn и **никогда** не ломает
 * запуск задачи: наблюдаемость не должна влиять на планировщик.
 */

/** События структурированного лога. */
export type StructuredLogEvent = "run.started" | "run.finished" | "hook.received" | string;

export interface StructuredLogRecord {
  /** Время записи (ISO). */
  ts: string;
  event: StructuredLogEvent;
  /** id записи history (для run.*). */
  runId?: number;
  task?: string;
  status?: string;
  startedAt?: string;
  finishedAt?: string | null;
  durationMs?: number | null;
  error?: string | null;
  nextTask?: string | null;
  tokens?: number;
  costUsd?: number;
  model?: string;
  workspaceId?: string | null;
  preFlightStatus?: string;
  postFlightStatus?: string;
  /** Источник события: schedule, dashboard, hook, cli, mcp и т.п. */
  source?: string;
  /** HTTP-статус ответа на hook.received. */
  httpStatus?: number;
  /** Адрес отправителя хука (без порта). */
  remote?: string | null;
  /** Размер тела хука в байтах. */
  payloadBytes?: number;
  /** Причина отказа/пропуска. */
  reason?: string;
}

export interface ReadStructuredLogsFilter {
  task?: string;
  status?: string;
  event?: string;
  /** ISO-время: записи не раньше. */
  since?: string;
  /** ISO-время: записи не позже. */
  until?: string;
  limit?: number;
}

export interface ReadStructuredLogsResult {
  records: StructuredLogRecord[];
  /** Сколько всего записей подошло под фильтр (до применения limit). */
  total: number;
  /** Сколько строк не удалось разобрать как JSON. */
  malformed: number;
  file: string;
}

/** Текущий файл и его архив после ротации. */
export const STRUCTURED_LOG_FILE = path.join(LOG_DIR, "runs.jsonl");
export const STRUCTURED_LOG_ARCHIVE = `${STRUCTURED_LOG_FILE}.1`;
export const STRUCTURED_LOG_MAX_BYTES = 10 * 1024 * 1024;

function warn(message: string, err: unknown): void {
  try {
    console.warn(
      `[structured-log] ${message}: ${err instanceof Error ? err.message : String(err)}`
    );
  } catch {
    // console может быть недоступен в урезанном окружении — молча игнорируем.
  }
}

function ensureLogDir(): void {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

/** Ротирует лог, если он превысил лимит. Вызывается перед append. */
function rotateIfNeeded(): void {
  try {
    const stat = fs.statSync(STRUCTURED_LOG_FILE);
    if (stat.size < STRUCTURED_LOG_MAX_BYTES) return;
    try {
      fs.rmSync(STRUCTURED_LOG_ARCHIVE, { force: true });
    } catch {
      // Нет старого архива — не страшно.
    }
    fs.renameSync(STRUCTURED_LOG_FILE, STRUCTURED_LOG_ARCHIVE);
  } catch (err: any) {
    // ENOENT — файла ещё нет, это нормально.
    if (err?.code !== "ENOENT") warn("не удалось ротировать лог", err);
  }
}

/**
 * Добавляет запись в JSONL-лог. Возвращает true при успешной записи.
 * Не бросает исключений.
 */
export function appendStructuredLog(
  record: Omit<StructuredLogRecord, "ts"> & { ts?: string }
): boolean {
  try {
    ensureLogDir();
    rotateIfNeeded();
    const payload: StructuredLogRecord = {
      ...record,
      ts: record.ts ?? new Date().toISOString(),
    };
    // Спринт 26: даже если ошибка пришла из внешнего процесса, известные
    // значения секретов и присваивания TOKEN=/password: вырезаются.
    if (typeof payload.error === "string") {
      payload.error = redactSecretsInText(payload.error);
    }
    if (typeof payload.reason === "string") {
      payload.reason = redactSecretsInText(payload.reason);
    }
    fs.appendFileSync(STRUCTURED_LOG_FILE, `${JSON.stringify(payload)}\n`, "utf8");
    return true;
  } catch (err) {
    warn("не удалось записать событие", err);
    return false;
  }
}

function readLines(file: string): string[] {
  try {
    return fs
      .readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0);
  } catch (err: any) {
    if (err?.code !== "ENOENT") warn(`не удалось прочитать ${file}`, err);
    return [];
  }
}

/**
 * Читает JSONL-лог (текущий + архив), фильтрует и сортирует новые сверху.
 *
 * `limit` по умолчанию 200, максимум 5000 — как у HTTP-эндпоинта.
 * `total` считается до применения limit, чтобы клиент знал полный объём.
 */
export function readStructuredLogs(
  filter: ReadStructuredLogsFilter = {}
): ReadStructuredLogsResult {
  const limit = Math.max(1, Math.min(5000, Math.floor(filter.limit ?? 200) || 200));
  const task = filter.task?.trim().toLowerCase();
  const status = filter.status?.trim().toLowerCase();
  const event = filter.event?.trim().toLowerCase();
  const since = filter.since?.trim();
  const until = filter.until?.trim();

  const records: StructuredLogRecord[] = [];
  let malformed = 0;

  // Архив старше текущего файла; порядок не важен, ниже сортируем по ts.
  for (const file of [STRUCTURED_LOG_ARCHIVE, STRUCTURED_LOG_FILE]) {
    for (const line of readLines(file)) {
      let parsed: any;
      try {
        parsed = JSON.parse(line);
      } catch {
        malformed += 1;
        continue;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        malformed += 1;
        continue;
      }
      if (typeof parsed.ts !== "string") parsed.ts = "";
      if (typeof parsed.event !== "string") parsed.event = "";
      if (task && String(parsed.task ?? "").toLowerCase() !== task) continue;
      if (status && String(parsed.status ?? "").toLowerCase() !== status) continue;
      if (event && String(parsed.event).toLowerCase() !== event) continue;
      if (since && String(parsed.ts) < since) continue;
      if (until && String(parsed.ts) > until) continue;
      records.push(parsed as StructuredLogRecord);
    }
  }

  const total = records.length;
  records.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  return {
    records: records.slice(0, limit),
    total,
    malformed,
    file: STRUCTURED_LOG_FILE,
  };
}

/** Удаляет JSONL-логи (для тестов и обслуживания). */
export function clearStructuredLogs(): void {
  try {
    fs.rmSync(STRUCTURED_LOG_FILE, { force: true });
    fs.rmSync(STRUCTURED_LOG_ARCHIVE, { force: true });
  } catch (err) {
    warn("не удалось очистить лог", err);
  }
}
