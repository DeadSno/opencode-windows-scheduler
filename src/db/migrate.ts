import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PLUGIN_DIR } from "../types.js";
import { getDb, isDatabaseEmpty, withTransaction } from "./index.js";
import {
  LEGACY_METRICS_TASK,
  upsertMetricsRow,
  type TaskMetricsRow,
} from "./metrics-repo.js";

/**
 * Безопасная миграция JSON → SQLite (Спринт 12).
 *
 * Порядок:
 *  1. Проверяем, что БД пуста (иначе миграция уже была).
 *  2. Читаем и валидируем все JSON-файлы ДО открытия транзакции.
 *  3. Переносим данные одной транзакцией. Любая ошибка → ROLLBACK,
 *     БД остаётся пустой, JSON-файлы не тронуты.
 *  4. Только после COMMIT переименовываем JSON в .json.bak.
 */

export interface MigrationResult {
  migrated: boolean;
  tasks: number;
  history: number;
  templates: number;
  metrics: number;
  backups: string[];
}

const EMPTY_RESULT: MigrationResult = {
  migrated: false,
  tasks: 0,
  history: 0,
  templates: 0,
  metrics: 0,
  backups: [],
};

const JSON_FILES = ["tasks.json", "history.json", "metrics.json", "templates.json"] as const;

interface LoadedFile {
  path: string;
  exists: boolean;
  value: unknown;
}

async function loadJsonFile(file: string): Promise<LoadedFile> {
  try {
    const raw = await fs.readFile(file, "utf8");
    try {
      return { path: file, exists: true, value: JSON.parse(raw) };
    } catch (err: any) {
      throw new Error(
        `Некорректный JSON в ${path.basename(file)}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  } catch (err: any) {
    if (err?.code === "ENOENT") return { path: file, exists: false, value: null };
    throw err;
  }
}

function asArray(value: unknown): any[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && Array.isArray((value as any).tasks)) {
    return (value as any).tasks;
  }
  return [];
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Приводит старую запись истории к колонкам БД. */
function normalizeHistoryRow(raw: any): any | null {
  if (!raw || typeof raw !== "object") return null;
  const taskName = typeof raw.taskName === "string" ? raw.taskName.trim() : "";
  const startedAt = typeof raw.startedAt === "string" ? raw.startedAt : "";
  if (!taskName || !startedAt) return null;

  const status =
    raw.status === "success" || raw.status === "timeout" ? raw.status : "error";

  return {
    taskName,
    status,
    startedAt,
    finishedAt: toStringOrNull(raw.finishedAt),
    durationMs: toNumber(raw.durationMs),
    error: toStringOrNull(raw.error),
    tokens: toNumber(raw.tokens),
    costUsd: toNumber(raw.costUsd),
    model: toStringOrNull(raw.model),
    preFlightStatus: toStringOrNull(raw.preFlightStatus),
    postFlightStatus: toStringOrNull(raw.postFlightStatus),
    nextTask: toStringOrNull(raw.nextTask),
  };
}

/**
 * Выполняет миграцию. Возвращает статистику; если БД не пуста или JSON нет —
 * migrated: false и нули.
 */
export async function migrateJsonToDb(
  pluginDir: string = PLUGIN_DIR
): Promise<MigrationResult> {
  if (!isDatabaseEmpty()) return { ...EMPTY_RESULT };

  const files = await Promise.all(
    JSON_FILES.map((name) => loadJsonFile(path.join(pluginDir, name)))
  );
  if (!files.some((file) => file.exists)) return { ...EMPTY_RESULT };

  const byName = new Map<string, LoadedFile>();
  for (const file of files) byName.set(path.basename(file.path), file);

  const taskItems = asArray(byName.get("tasks.json")?.value);
  const historyItems = asArray(byName.get("history.json")?.value)
    .map(normalizeHistoryRow)
    .filter((row): row is any => row !== null);
  const templateItems = asArray(byName.get("templates.json")?.value);
  const legacyMetrics =
    byName.get("metrics.json")?.value &&
    typeof byName.get("metrics.json")?.value === "object"
      ? (byName.get("metrics.json")!.value as any)
      : null;

  const now = new Date().toISOString();
  let insertedTasks = 0;
  let insertedHistory = 0;
  let insertedTemplates = 0;
  let insertedMetrics = 0;

  withTransaction(() => {
    const db = getDb();

    // --- tasks ---
    const insertTask = db.prepare(
      "INSERT INTO tasks (name, definition_json, created_at, updated_at) VALUES (?, ?, ?, ?)"
    );
    const seenTasks = new Set<string>();
    for (const item of taskItems) {
      if (!item || typeof item !== "object") continue;
      const name = typeof item.name === "string" ? item.name.trim() : "";
      if (!name || seenTasks.has(name.toLowerCase())) continue;
      seenTasks.add(name.toLowerCase());

      // workdir → workingDirectory, как в старом loadTaskDefinitions().
      const definition: any = { ...item, name };
      if (
        definition.workingDirectory === undefined &&
        typeof definition.workdir === "string" &&
        definition.workdir.trim()
      ) {
        definition.workingDirectory = definition.workdir.trim();
      }
      delete definition.workdir;

      const createdAt =
        typeof definition.createdAt === "string" && definition.createdAt
          ? definition.createdAt
          : now;
      definition.createdAt = createdAt;

      insertTask.run(name, JSON.stringify(definition), createdAt, now);
      insertedTasks += 1;
    }

    // --- history ---
    const insertHistory = db.prepare(
      `INSERT INTO history (
         task_name, status, started_at, finished_at, duration_ms, error,
         tokens, cost_usd, model, pre_flight_status, post_flight_status, next_task
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const row of historyItems) {
      insertHistory.run(
        row.taskName,
        row.status,
        row.startedAt,
        row.finishedAt,
        row.durationMs === null ? null : Math.max(0, Math.trunc(row.durationMs)),
        row.error,
        row.tokens === null ? null : Math.max(0, Math.trunc(row.tokens)),
        row.costUsd === null ? null : Math.max(0, row.costUsd),
        row.model,
        row.preFlightStatus,
        row.postFlightStatus,
        row.nextTask
      );
      insertedHistory += 1;
    }

    // --- templates ---
    const insertTemplate = db.prepare(
      "INSERT INTO templates (id, name, definition_json) VALUES (?, ?, ?)"
    );
    const seenTemplates = new Set<string>();
    for (const item of templateItems) {
      if (!item || typeof item !== "object") continue;
      if (typeof item.prompt !== "string") continue;
      const name = typeof item.name === "string" ? item.name.trim() : "";
      if (!name) continue;
      const id =
        typeof item.id === "string" && item.id.trim() ? item.id.trim() : randomUUID();
      const key = id.toLowerCase();
      if (seenTemplates.has(key)) continue;
      seenTemplates.add(key);

      const template = { ...item, id, name };
      insertTemplate.run(id, name, JSON.stringify(template));
      insertedTemplates += 1;
    }

    // --- metrics ---
    // Сначала агрегируем по истории, затем добавляем «хвост» из metrics.json:
    // старый history.json хранил только 200 записей, а счётчики — всё время.
    const perTask = new Map<string, TaskMetricsRow>();
    for (const row of historyItems) {
      const key = row.taskName.toLowerCase();
      const current =
        perTask.get(key) ??
        ({
          taskName: row.taskName,
          total: 0,
          success: 0,
          error: 0,
          tokens: 0,
          costUsd: 0,
        } satisfies TaskMetricsRow);
      current.total += 1;
      if (row.status === "success") current.success += 1;
      else current.error += 1;
      current.tokens += Math.max(0, row.tokens ?? 0);
      current.costUsd += Math.max(0, row.costUsd ?? 0);
      perTask.set(key, current);
    }

    if (legacyMetrics) {
      const migrated = [...perTask.values()].reduce(
        (acc, row) => ({
          total: acc.total + row.total,
          success: acc.success + row.success,
          error: acc.error + row.error,
          tokens: acc.tokens + row.tokens,
          costUsd: acc.costUsd + row.costUsd,
        }),
        { total: 0, success: 0, error: 0, tokens: 0, costUsd: 0 }
      );

      const extra = {
        total: Math.max(0, (toNumber(legacyMetrics.total) ?? 0) - migrated.total),
        success: Math.max(0, (toNumber(legacyMetrics.success) ?? 0) - migrated.success),
        error: Math.max(0, (toNumber(legacyMetrics.error) ?? 0) - migrated.error),
        tokens: Math.max(0, (toNumber(legacyMetrics.tokens) ?? 0) - migrated.tokens),
        costUsd: Math.max(0, (toNumber(legacyMetrics.costUsd) ?? 0) - migrated.costUsd),
      };

      if (
        extra.total > 0 ||
        extra.tokens > 0 ||
        extra.costUsd > 0
      ) {
        perTask.set(LEGACY_METRICS_TASK, {
          taskName: LEGACY_METRICS_TASK,
          total: extra.total,
          success: extra.success,
          error: extra.error,
          tokens: extra.tokens,
          costUsd: extra.costUsd,
        });
      }
    }

    for (const row of perTask.values()) {
      upsertMetricsRow(row);
      insertedMetrics += 1;
    }
  });

  // --- backups (после успешного COMMIT) ---
  const backups: string[] = [];
  for (const file of files) {
    if (!file.exists) continue;
    const backup = `${file.path}.bak`;
    try {
      await fs.rm(backup, { force: true });
      await fs.rename(file.path, backup);
      backups.push(path.basename(backup));
    } catch (err: any) {
      console.error(
        `[migrate] Не удалось переименовать ${path.basename(file.path)} в .bak: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  console.log(
    `[migrate] Перемещено ${insertedTasks} задач, ${insertedHistory} записей истории, ${insertedTemplates} шаблонов.`
  );

  return {
    migrated: true,
    tasks: insertedTasks,
    history: insertedHistory,
    templates: insertedTemplates,
    metrics: insertedMetrics,
    backups,
  };
}
