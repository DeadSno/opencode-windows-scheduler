import { getDb } from "./index.js";
import type { TaskStatus } from "../history.js";

/**
 * Агрегированные метрики по задачам.
 *
 * Помимо обычных задач в таблице могут лежать служебные строки:
 *  - `__global__` — вызовы старого appendMetric() без имени задачи;
 *  - `__legacy__` — «хвост» metrics.json, не попавший в историю (она хранила
 *    только 200 записей).
 * Такие строки не показываются в списке задач, но входят в общие итоги.
 */

export interface TaskMetricsRow {
  taskName: string;
  total: number;
  success: number;
  error: number;
  tokens: number;
  costUsd: number;
}

export interface MetricsTotals {
  total: number;
  success: number;
  error: number;
  tokens: number;
  costUsd: number;
}

const GLOBAL_TASK = "__global__";
export const LEGACY_METRICS_TASK = "__legacy__";

function isInternal(taskName: string): boolean {
  return taskName.startsWith("__");
}

function rowToMetrics(row: any): TaskMetricsRow {
  return {
    taskName: String(row.task_name),
    total: Number(row.total) || 0,
    success: Number(row.success) || 0,
    error: Number(row.error) || 0,
    tokens: Number(row.total_tokens) || 0,
    costUsd: Number(row.total_cost) || 0,
  };
}

/** Инкремент метрик без собственной транзакции (для использования внутри recordRun). */
export function incrementMetricsUnsafe(
  taskName: string,
  status: TaskStatus,
  tokens = 0,
  costUsd = 0
): void {
  // В таблице metrics два счётчика: success и error. Сюда попадают все
  // неуспешные статусы, включая partial; в аналитике partial считается отдельно.
  const success = status === "success" ? 1 : 0;
  const error = status === "success" ? 0 : 1;
  const safeTokens = Number.isFinite(tokens) && tokens > 0 ? Math.floor(tokens) : 0;
  const safeCost = Number.isFinite(costUsd) && costUsd > 0 ? costUsd : 0;

  getDb()
    .prepare(
      `INSERT INTO metrics (task_name, total, success, error, total_tokens, total_cost)
       VALUES (?, 1, ?, ?, ?, ?)
       ON CONFLICT(task_name) DO UPDATE SET
         total = total + 1,
         success = success + excluded.success,
         error = error + excluded.error,
         total_tokens = total_tokens + excluded.total_tokens,
         total_cost = total_cost + excluded.total_cost`
    )
    .run(taskName, success, error, safeTokens, safeCost);
}

/** Атомарно увеличивает счётчики задачи: +1 запуск, +1 success/error, токены, стоимость. */
export function incrementMetrics(
  taskName: string,
  status: TaskStatus,
  tokens?: number,
  costUsd?: number
): void {
  incrementMetricsUnsafe(taskName, status, tokens, costUsd);
}

/** Метрики одной задачи (нули, если задача ещё не запускалась). */
export function getMetrics(taskName: string): TaskMetricsRow {
  const row = getDb()
    .prepare("SELECT * FROM metrics WHERE lower(task_name) = lower(?) LIMIT 1")
    .get(taskName) as any;
  if (!row) {
    return { taskName, total: 0, success: 0, error: 0, tokens: 0, costUsd: 0 };
  }
  return rowToMetrics(row);
}

/** Метрики всех реальных задач (служебные строки исключены). */
export function getAllMetrics(includeInternal = false): TaskMetricsRow[] {
  const rows = getDb()
    .prepare("SELECT * FROM metrics ORDER BY task_name COLLATE NOCASE ASC")
    .all() as any[];
  return rows.map(rowToMetrics).filter((row) => includeInternal || !isInternal(row.taskName));
}

/** Суммарные метрики (включая служебные строки). */
export function getTotals(): MetricsTotals {
  const row = getDb()
    .prepare(
      `SELECT
         COALESCE(SUM(total), 0) AS total,
         COALESCE(SUM(success), 0) AS success,
         COALESCE(SUM(error), 0) AS error,
         COALESCE(SUM(total_tokens), 0) AS tokens,
         COALESCE(SUM(total_cost), 0) AS cost_usd
       FROM metrics`
    )
    .get() as any;
  return {
    total: Number(row?.total) || 0,
    success: Number(row?.success) || 0,
    error: Number(row?.error) || 0,
    tokens: Number(row?.tokens) || 0,
    costUsd: Number(row?.cost_usd) || 0,
  };
}

/** Старый appendMetric(status) без имени задачи. */
export function incrementGlobalMetrics(status: TaskStatus): void {
  incrementMetricsUnsafe(GLOBAL_TASK, status);
}

/** Прямая запись строки метрик — используется миграцией. */
export function upsertMetricsRow(row: TaskMetricsRow): void {
  getDb()
    .prepare(
      `INSERT INTO metrics (task_name, total, success, error, total_tokens, total_cost)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(task_name) DO UPDATE SET
         total = excluded.total,
         success = excluded.success,
         error = excluded.error,
         total_tokens = excluded.total_tokens,
         total_cost = excluded.total_cost`
    )
    .run(
      row.taskName,
      Math.max(0, Math.floor(row.total)),
      Math.max(0, Math.floor(row.success)),
      Math.max(0, Math.floor(row.error)),
      Math.max(0, Math.floor(row.tokens)),
      Math.max(0, row.costUsd)
    );
}

/** Количество строк метрик. */
export function countMetrics(): number {
  const row = getDb().prepare("SELECT COUNT(*) AS count FROM metrics").get() as any;
  return Number(row?.count) || 0;
}
