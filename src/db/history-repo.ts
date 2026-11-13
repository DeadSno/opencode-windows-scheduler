import { getDb, withTransaction } from "./index.js";
import { incrementMetricsUnsafe } from "./metrics-repo.js";
import type { TaskStatus } from "../history.js";

/**
 * История запусков.
 *
 * completed-запись пишется одной транзакцией вместе с инкрементом метрик.
 * Незавершённые запуски (finished_at IS NULL) при старте помечаются как error
 * в crash recovery.
 */

export type HistoryStatus = TaskStatus | "running";

export interface StoredHistoryRecord {
  id?: number;
  taskName: string;
  status: HistoryStatus;
  startedAt: string;
  finishedAt?: string | null;
  durationMs?: number | null;
  error?: string | null;
  nextTask?: string | null;
  tokens?: number;
  costUsd?: number;
  model?: string;
  preFlightStatus?: "success" | "error" | "skipped";
  postFlightStatus?: "success" | "error" | "skipped";
  workspaceId?: string | null;
  allowedTools?: string[] | null;
  deniedTools?: string[] | null;
}

/** Поля, которые пишутся в history при завершении запуска. */
export interface RunResult {
  taskName: string;
  status: TaskStatus;
  startedAt: string;
  durationMs: number;
  error?: string | null;
  nextTask?: string | null;
  tokens?: number;
  costUsd?: number;
  model?: string;
  preFlightStatus?: "success" | "error" | "skipped";
  postFlightStatus?: "success" | "error" | "skipped";
  finishedAt?: string;
}

function rowToRecord(row: any): StoredHistoryRecord {
  const status = String(row.status) as HistoryStatus;
  return {
    id: Number(row.id),
    taskName: String(row.task_name),
    status,
    startedAt: String(row.started_at),
    finishedAt: row.finished_at == null ? null : String(row.finished_at),
    durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
    error: row.error == null ? null : String(row.error),
    nextTask: row.next_task == null ? null : String(row.next_task),
    tokens: row.tokens == null ? undefined : Number(row.tokens),
    costUsd: row.cost_usd == null ? undefined : Number(row.cost_usd),
    model: row.model == null ? undefined : String(row.model),
    preFlightStatus:
      row.pre_flight_status == null
        ? undefined
        : (String(row.pre_flight_status) as "success" | "error" | "skipped"),
    postFlightStatus:
      row.post_flight_status == null
        ? undefined
        : (String(row.post_flight_status) as "success" | "error" | "skipped"),
    workspaceId: row.workspace_id == null ? null : String(row.workspace_id),
    allowedTools: row.allowed_tools == null ? null : JSON.parse(String(row.allowed_tools)),
    deniedTools: row.denied_tools == null ? null : JSON.parse(String(row.denied_tools)),
  };
}

const INSERT_SQL = `INSERT INTO history (
  task_name, status, started_at, finished_at, duration_ms, error,
  tokens, cost_usd, model, pre_flight_status, post_flight_status, next_task,
  workspace_id, allowed_tools, denied_tools
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function lastId(result: { lastInsertRowid: number | bigint }): number {
  return Number(result.lastInsertRowid) || 0;
}

/** Вставляет запись истории без инкремента метрик (совместимость с appendHistory). */
export function insertHistory(record: StoredHistoryRecord): number {
  const result = getDb()
    .prepare(INSERT_SQL)
    .run(
      record.taskName,
      record.status,
      record.startedAt,
      record.finishedAt ?? null,
      record.durationMs ?? null,
      record.error ?? null,
      record.tokens ?? null,
      record.costUsd ?? null,
      record.model ?? null,
      record.preFlightStatus ?? null,
      record.postFlightStatus ?? null,
      record.nextTask ?? null,
      record.workspaceId ?? null,
      record.allowedTools == null ? null : JSON.stringify(record.allowedTools),
      record.deniedTools == null ? null : JSON.stringify(record.deniedTools)
    );
  return lastId(result);
}

/** Начало запуска: строка с finished_at = NULL (переживёт сбой процесса). */
export function startRun(
  taskName: string,
  startedAt = new Date().toISOString(),
  workspaceId?: string | null,
  allowedTools?: string[] | null,
  deniedTools?: string[] | null
): number {
  return insertHistory({
    taskName,
    status: "running",
    startedAt,
    finishedAt: null,
    workspaceId,
    allowedTools,
    deniedTools,
  });
}

/**
 * Завершает ранее начатый запуск и инкрементирует метрики.
 * Возвращает false, если запись уже завершена/не найдена (защита от двойного учёта).
 */
export function finishRun(
  id: number,
  status: TaskStatus,
  durationMs: number,
  error?: string | null,
  nextTask?: string | null,
  tokens?: number,
  costUsd?: number,
  model?: string,
  preFlightStatus?: "success" | "error" | "skipped",
  postFlightStatus?: "success" | "error" | "skipped"
): boolean {
  return withTransaction(() => {
    const instance = getDb();
    const row = instance
      .prepare("SELECT finished_at FROM history WHERE id = ?")
      .get(id) as any;
    if (!row || row.finished_at != null) return false;

    instance
      .prepare(
        `UPDATE history SET
           status = ?, finished_at = ?, duration_ms = ?, error = ?, next_task = ?,
           tokens = ?, cost_usd = ?, model = ?,
           pre_flight_status = ?, post_flight_status = ?
         WHERE id = ?`
      )
      .run(
        status,
        new Date().toISOString(),
        Number.isFinite(durationMs) ? Math.max(0, Math.floor(durationMs)) : 0,
        error ?? null,
        nextTask ?? null,
        tokens ?? null,
        costUsd ?? null,
        model ?? null,
        preFlightStatus ?? null,
        postFlightStatus ?? null,
        id
      );

    const taskRow = instance
      .prepare("SELECT task_name FROM history WHERE id = ?")
      .get(id) as any;
    incrementMetricsUnsafe(String(taskRow.task_name), status, tokens, costUsd);
    return true;
  });
}

/**
 * Записывает завершённый запуск: history + metrics в одной транзакции.
 * Заменяет старый recordTaskRun/recordRun.
 */
export function recordRun(
  taskName: string,
  status: TaskStatus,
  startedAt: string,
  durationMs: number,
  error?: string | null,
  nextTask?: string | null,
  tokens?: number,
  costUsd?: number,
  model?: string,
  preFlightStatus?: "success" | "error" | "skipped",
  postFlightStatus?: "success" | "error" | "skipped",
  finishedAt = new Date().toISOString(),
  workspaceId?: string | null,
  allowedTools?: string[] | null,
  deniedTools?: string[] | null
): number {
  return withTransaction(() => {
    const result = getDb()
      .prepare(INSERT_SQL)
      .run(
        taskName,
        status,
        startedAt,
        finishedAt,
        Math.max(0, Math.floor(Number(durationMs) || 0)),
        error ?? null,
        tokens ?? null,
        costUsd ?? null,
        model ?? null,
        preFlightStatus ?? null,
        postFlightStatus ?? null,
        nextTask ?? null,
        workspaceId ?? null,
        allowedTools == null ? null : JSON.stringify(allowedTools),
        deniedTools == null ? null : JSON.stringify(deniedTools)
      );
    incrementMetricsUnsafe(taskName, status, tokens, costUsd);
    return lastId(result);
  });
}

/** История запусков (новые сверху). Без taskName — по всем задачам. */
export function getHistory(
  taskName?: string | null,
  limit = 200
): StoredHistoryRecord[] {
  const safeLimit = Math.max(1, Math.min(100000, Math.floor(limit) || 1));
  const instance = getDb();
  const rows = taskName
    ? (instance
        .prepare(
          `SELECT * FROM history
           WHERE lower(task_name) = lower(?)
           ORDER BY started_at DESC, id DESC
           LIMIT ?`
        )
        .all(taskName, safeLimit) as any[])
    : (instance
        .prepare(
          `SELECT * FROM history
           ORDER BY started_at DESC, id DESC
           LIMIT ?`
        )
        .all(safeLimit) as any[]);
  return rows.map(rowToRecord);
}

/** История запусков, начатых не раньше timestamp (ISO-строка). */
export function getHistorySince(
  timestamp: string,
  limit = 5000
): StoredHistoryRecord[] {
  const safeLimit = Math.max(1, Math.min(100000, Math.floor(limit) || 1));
  const rows = getDb()
    .prepare(
      `SELECT * FROM history
       WHERE started_at >= ?
       ORDER BY started_at DESC, id DESC
       LIMIT ?`
    )
    .all(timestamp, safeLimit) as any[];
  return rows.map(rowToRecord);
}

/**
 * Crash recovery: все незавершённые записи (finished_at IS NULL) помечаются
 * как error. Длительность считается от started_at до текущего момента.
 * Возвращает количество восстановленных записей.
 */
export function recoverInterrupted(): number {
  const now = new Date().toISOString();
  const result = getDb()
    .prepare(
      `UPDATE history SET
         status = 'error',
         error = CASE
           WHEN error IS NULL OR error = '' THEN 'Прервано (сбой/перезагрузка)'
           ELSE error
         END,
         finished_at = COALESCE(finished_at, ?),
         duration_ms = COALESCE(
           duration_ms,
           CAST((julianday(?) - julianday(started_at)) * 86400000 AS INTEGER)
         )
       WHERE finished_at IS NULL`
    )
    .run(now, now);
  return Number(result.changes) || 0;
}

/** Количество записей истории (для миграции и тестов). */
export function countHistory(): number {
  const row = getDb().prepare("SELECT COUNT(*) AS count FROM history").get() as any;
  return Number(row?.count) || 0;
}

/** Число активных (незавершённых) запусков: глубина очереди для /api/health. */
export function countRunningRecords(): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS count FROM history WHERE finished_at IS NULL")
    .get() as any;
  return Number(row?.count) || 0;
}

/** Запись о незавершённом запуске — для детектора зависших матриц (Спринт 20). */
export interface RunningHistoryRecord {
  id: number;
  taskName: string;
  startedAt: string;
}

/** Список активных запусков (finished_at IS NULL), самые старые сверху. */
export function listRunningRecords(): RunningHistoryRecord[] {
  const rows = getDb()
    .prepare(
      `SELECT id, task_name, started_at FROM history
       WHERE finished_at IS NULL
       ORDER BY started_at ASC, id ASC`
    )
    .all() as any[];
  return rows.map((row) => ({
    id: Number(row.id) || 0,
    taskName: String(row.task_name ?? ""),
    startedAt: String(row.started_at ?? ""),
  }));
}

/** Параметры очистки истории (Спринт 18). 0 — ограничение выключено. */
export interface PruneHistoryOptions {
  /** Удалять завершённые записи старше N дней. */
  retentionDays?: number;
  /** Оставить не более N последних записей. */
  maxRecords?: number;
  /** Опорный момент времени (для тестов). */
  now?: Date;
}

export interface PruneHistoryResult {
  deletedByAge: number;
  deletedByCount: number;
  deleted: number;
  kept: number;
  /** Граница по возрасту (ISO) или null, если возраст не ограничивали. */
  cutoff: string | null;
}

/**
 * Чистит сырую историю: по возрасту и/или по количеству записей.
 *
 * Незавершённые запуски (`finished_at IS NULL`) не удаляются никогда — их
 * обрабатывает crash recovery. Агрегаты в таблице metrics не трогаются:
 * ретеншн чистит детали, а не статистику.
 */
export function pruneHistory(options: PruneHistoryOptions = {}): PruneHistoryResult {
  const instance = getDb();
  const now = options.now ?? new Date();
  let deletedByAge = 0;
  let deletedByCount = 0;
  let cutoff: string | null = null;

  const days = Number(options.retentionDays ?? 0);
  if (Number.isFinite(days) && days > 0) {
    cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
    const result = instance
      .prepare(
        `DELETE FROM history
         WHERE finished_at IS NOT NULL AND finished_at < ?`
      )
      .run(cutoff);
    deletedByAge = Number(result.changes) || 0;
  }

  const maxRecords = Number(options.maxRecords ?? 0);
  if (Number.isFinite(maxRecords) && maxRecords > 0) {
    const result = instance
      .prepare(
        `DELETE FROM history
         WHERE finished_at IS NOT NULL
           AND id NOT IN (
             SELECT id FROM history
             WHERE finished_at IS NOT NULL
             ORDER BY started_at DESC, id DESC
             LIMIT ?
           )`
      )
      .run(Math.max(0, Math.floor(maxRecords)));
    deletedByCount = Number(result.changes) || 0;
  }

  return {
    deletedByAge,
    deletedByCount,
    deleted: deletedByAge + deletedByCount,
    kept: countHistory(),
    cutoff,
  };
}

/**
 * Освобождает место после массового удаления. `PRAGMA incremental_vacuum`
 * работает только при auto_vacuum = INCREMENTAL; иначе это no-op, поэтому
 * вызов безопасен и не требует проверки режима.
 */
export function vacuumHistory(): boolean {
  try {
    getDb().exec("PRAGMA incremental_vacuum");
    return true;
  } catch {
    return false;
  }
}
