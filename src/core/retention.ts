/**
 * Ретеншн истории (Спринт 18).
 *
 * Раз в сутки (и по запросу `cleanup_history`) плагин чистит сырую историю
 * запусков: удаляет записи старше `history.retentionDays` и всё, что выходит
 * за `history.maxRecords`. Агрегированные метрики (таблица metrics) при этом
 * не меняются — «Всего запусков» и суммарная стоимость остаются корректными.
 *
 * Очистка никогда не удаляет незавершённые запуски (`finished_at IS NULL`):
 * их обрабатывает crash recovery.
 */
import {
  defaultHistorySettings,
  loadSettings,
  saveSettings,
  type HistorySettings,
} from "../settings.js";
import {
  countHistory,
  pruneHistory,
  vacuumHistory,
  type PruneHistoryResult,
} from "../db/history-repo.js";

/** Период автоочистки: раз в сутки. */
export const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Переопределения лимитов для одного прогона `cleanup_history`. */
export interface RetentionOverrides {
  retentionDays?: number;
  maxRecords?: number;
}

export interface RetentionReport extends PruneHistoryResult {
  retentionDays: number;
  maxRecords: number;
  /** Удалось ли выполнить PRAGMA incremental_vacuum. */
  vacuumed: boolean;
  /** Причина, по которой очистка пропущена (лимиты выключены). */
  skipped: string | null;
  ranAt: string;
}

/** Приводит переопределение к безопасному целому (>= 0) или undefined. */
function normalizeOverride(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  const int = Math.floor(n);
  return int >= 0 ? int : undefined;
}

function effectiveLimits(
  settings: HistorySettings,
  overrides: RetentionOverrides
): { retentionDays: number; maxRecords: number } {
  return {
    retentionDays:
      normalizeOverride(overrides.retentionDays) ?? settings.retentionDays,
    maxRecords: normalizeOverride(overrides.maxRecords) ?? settings.maxRecords,
  };
}

/**
 * Выполняет очистку истории по текущим настройкам.
 * Переопределения (если переданы) сохраняются в settings.json — так
 * `cleanup_history` заодно настраивает ретеншн.
 */
export async function runHistoryRetention(
  overrides: RetentionOverrides = {}
): Promise<RetentionReport> {
  const settings = await loadSettings();
  const base = settings.history ?? defaultHistorySettings();
  const limits = effectiveLimits(base, overrides);
  const ranAt = new Date().toISOString();

  const shouldPersistLimits =
    normalizeOverride(overrides.retentionDays) !== undefined ||
    normalizeOverride(overrides.maxRecords) !== undefined;

  if (limits.retentionDays === 0 && limits.maxRecords === 0) {
    const report: RetentionReport = {
      deletedByAge: 0,
      deletedByCount: 0,
      deleted: 0,
      kept: countHistory(),
      cutoff: null,
      retentionDays: 0,
      maxRecords: 0,
      vacuumed: false,
      skipped: "Ретеншн выключен: history.retentionDays и history.maxRecords равны 0.",
      ranAt,
    };
    if (shouldPersistLimits) {
      await saveSettings({ history: { ...base, ...limits, lastCleanupAt: ranAt, lastCleanupDeleted: 0 } });
    }
    return report;
  }

  const pruned = pruneHistory({
    retentionDays: limits.retentionDays,
    maxRecords: limits.maxRecords,
  });
  const vacuumed = pruned.deleted > 0 ? vacuumHistory() : false;

  await saveSettings({
    history: {
      ...base,
      ...limits,
      lastCleanupAt: ranAt,
      lastCleanupDeleted: pruned.deleted,
    },
  });

  return {
    ...pruned,
    retentionDays: limits.retentionDays,
    maxRecords: limits.maxRecords,
    vacuumed,
    skipped: null,
    ranAt,
  };
}

/**
 * Автоочистка при старте плагина: не чаще одного раза в сутки.
 * `force` игнорирует интервал (используется в тестах).
 */
export async function maybeRunHistoryRetention(
  force = false
): Promise<RetentionReport | undefined> {
  const settings = await loadSettings();
  const history = settings.history ?? defaultHistorySettings();
  if (!force && history.lastCleanupAt) {
    const last = new Date(history.lastCleanupAt).getTime();
    if (Number.isFinite(last) && Date.now() - last < CLEANUP_INTERVAL_MS) {
      return undefined;
    }
  }
  return await runHistoryRetention();
}
