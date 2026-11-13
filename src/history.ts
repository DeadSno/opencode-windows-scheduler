import path from "node:path";
import { PLUGIN_DIR } from "./types.js";
import {
  getHistory,
  insertHistory,
  recordRun,
} from "./db/history-repo.js";
import { getTotals, incrementGlobalMetrics } from "./db/metrics-repo.js";

/**
 * Публичный фасад истории/метрик (Спринт 12).
 *
 * Раньше модуль читал history.json и metrics.json. Теперь источник данных —
 * SQLite, но экспортируемые типы и функции сохранены: index.ts, server.ts и
 * внешние потребители (GUI/агент) не заметят разницы.
 */

/** @deprecated Оставлено для обратной совместимости импортов. */
export const HISTORY_FILE = path.join(PLUGIN_DIR, "history.json");
/** @deprecated Оставлено для обратной совместимости импортов. */
export const METRICS_FILE = path.join(PLUGIN_DIR, "metrics.json");

export type TaskStatus = "success" | "error" | "timeout" | "partial";

export interface HistoryRecord {
  taskName: string;
  status: TaskStatus;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  error?: string | null;
  /** Имя задачи, запущенной по цепочке после этого запуска (если была). */
  nextTask?: string | null;
  /** Сколько токенов потратил запуск (если удалось распарсить лог). */
  tokens?: number;
  /** Стоимость запуска в USD (если в логе была информация о цене). */
  costUsd?: number;
  /** LLM-модель, использованная в запуске (если задана в задаче). */
  model?: string;
  /** Итог pre-flight хука: success / error / skipped (хук не задан). */
  preFlightStatus?: "success" | "error" | "skipped";
  /** Итог post-flight хука: success / error / skipped (хук не задан). */
  postFlightStatus?: "success" | "error" | "skipped";
  /** Ограничения инструментов, действовавшие на момент запуска. */
  allowedTools?: string[] | null;
  deniedTools?: string[] | null;
}

export interface Metrics {
  total: number;
  success: number;
  error: number;
  tokens?: number;
  costUsd?: number;
}

/**
 * Оставляет по одной самой свежей записи на задачу.
 * `records` должны быть отсортированы от новых к старым (как loadHistory).
 */
export function latestHistoryByTask(
  records: readonly HistoryRecord[]
): Map<string, HistoryRecord> {
  const latest = new Map<string, HistoryRecord>();
  for (const record of records) {
    const key = record.taskName.toLowerCase();
    if (!latest.has(key)) latest.set(key, record);
  }
  return latest;
}

/** Читает историю запусков из БД (от новых к старым, как раньше — 200 записей). */
export async function loadHistory(): Promise<HistoryRecord[]> {
  return getHistory(null, 200).map((record) => ({
    taskName: record.taskName,
    // Незавершённые записи до recovery показываем как error для GUI.
    status: (record.status === "running" ? "error" : record.status) as TaskStatus,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt ?? "",
    durationMs: record.durationMs ?? 0,
    error: record.error ?? null,
    nextTask: record.nextTask ?? null,
    ...(record.tokens !== undefined ? { tokens: record.tokens } : {}),
    ...(record.costUsd !== undefined ? { costUsd: record.costUsd } : {}),
    ...(record.model !== undefined ? { model: record.model } : {}),
    ...(record.preFlightStatus !== undefined
      ? { preFlightStatus: record.preFlightStatus }
      : {}),
    ...(record.postFlightStatus !== undefined
      ? { postFlightStatus: record.postFlightStatus }
      : {}),
    ...(record.allowedTools ? { allowedTools: record.allowedTools } : {}),
    ...(record.deniedTools ? { deniedTools: record.deniedTools } : {}),
  }));
}

/** Добавляет запись истории (без изменения метрик — совместимость). */
export async function appendHistory(record: HistoryRecord): Promise<void> {
  insertHistory(record);
}

/** Читает суммарные метрики из БД. */
export async function loadMetrics(): Promise<Metrics> {
  return getTotals();
}

/** Старый appendMetric(status): глобальный счётчик без привязки к задаче. */
export async function appendMetric(status: TaskStatus): Promise<void> {
  incrementGlobalMetrics(status);
}

/** Записывает завершённый запуск: история + метрики одной транзакцией. */
export async function recordTaskRun(
  taskName: string,
  status: TaskStatus,
  durationMs: number,
  error?: string | null
): Promise<void> {
  const finishedAt = new Date().toISOString();
  const startedAt = new Date(Date.now() - durationMs).toISOString();
  recordRun(taskName, status, startedAt, durationMs, error, null, undefined, undefined, undefined, undefined, undefined, finishedAt);
}
