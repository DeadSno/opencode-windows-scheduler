/**
 * Аналитика по истории запусков (Спринт 18).
 *
 * Чистые функции без БД и HTTP: дашборд и RPC отдают JSON, экспорт — CSV.
 * Так агрегаты легко тестировать без запуска сервера.
 */

/** Оценка стоимости, если запись истории не содержит costUsd. */
export const ESTIMATED_COST_PER_1K_TOKENS_USD = 0.003;

/** Минимальный вид записи истории, нужный аналитике. */
export interface AnalyticsRecord {
  taskName: string;
  status: string;
  startedAt: string;
  finishedAt?: string | null;
  durationMs?: number | null;
  error?: string | null;
  tokens?: number;
  costUsd?: number;
  model?: string;
  workspaceId?: string | null;
}

/** Описание задачи для группировки по матрицам. */
export interface AnalyticsTaskRef {
  name: string;
  matrixParentId?: string | null;
}

export interface DailyBucket {
  /** YYYY-MM-DD (UTC). */
  date: string;
  total: number;
  success: number;
  error: number;
  partial: number;
  tokens: number;
  costUsd: number;
  avgDurationMs: number;
}

export interface TaskAnalyticsRow {
  taskName: string;
  total: number;
  success: number;
  error: number;
  /** Процент успешных запусков (0..100, один знак после запятой). */
  successRate: number;
  avgDurationMs: number;
  tokens: number;
  costUsd: number;
  /** Задача — клон матрицы (matrixParentId задан). */
  isMatrixClone: boolean;
  matrixParentId: string | null;
}

export interface MatrixAnalyticsRow {
  parentId: string;
  clones: number;
  total: number;
  success: number;
  error: number;
  successRate: number;
  tokens: number;
  costUsd: number;
}

export interface ModelAnalyticsRow {
  model: string;
  total: number;
  costUsd: number;
}

export interface AnalyticsReport {
  generatedAt: string;
  /** Окно анализа в днях. */
  windowDays: number;
  totals: {
    total: number;
    success: number;
    error: number;
    partial: number;
    successRate: number;
    avgDurationMs: number;
    tokens: number;
    costUsd: number;
  };
  daily: DailyBucket[];
  tasks: TaskAnalyticsRow[];
  topByCost: TaskAnalyticsRow[];
  matrices: MatrixAnalyticsRow[];
  byModel: ModelAnalyticsRow[];
  sources: {
    historyRecords: number;
    /** Сколько записей попало в окно. */
    recordsInWindow: number;
    /** Ограничение по количеству строк в топах. */
    topLimit: number;
  };
}

export interface BuildAnalyticsOptions {
  /** Окно анализа в днях (по умолчанию 14). */
  days?: number;
  /** Опорный момент (для тестов). */
  now?: Date;
  /** Сколько строк оставлять в топах (по умолчанию 10). */
  topLimit?: number;
  /** Известные задачи — нужны для группировки матриц. */
  tasks?: AnalyticsTaskRef[];
}

function toNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Стоимость записи: явная цена, иначе оценка по токенам. */
export function recordCost(record: AnalyticsRecord): number {
  const cost = toNumber(record.costUsd);
  if (cost > 0) return cost;
  const tokens = toNumber(record.tokens);
  return tokens > 0 ? (tokens / 1000) * ESTIMATED_COST_PER_1K_TOKENS_USD : 0;
}

/** Дата записи в UTC-формате YYYY-MM-DD. */
export function recordDate(record: AnalyticsRecord): string {
  const time = new Date(record.startedAt).getTime();
  if (!Number.isFinite(time)) return "";
  return new Date(time).toISOString().slice(0, 10);
}

function utcDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function percent(part: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((part / total) * 1000) / 10;
}

/**
 * Строит отчёт по истории: итоги, дневные бакеты, разбивка по задачам,
 * матрицам и моделям.
 */
export function buildAnalytics(
  records: AnalyticsRecord[],
  options: BuildAnalyticsOptions = {}
): AnalyticsReport {
  const windowDays = Math.max(1, Math.floor(options.days ?? 14));
  const topLimit = Math.max(1, Math.floor(options.topLimit ?? 10));
  const now = options.now ?? new Date();

  const dayKeys: string[] = [];
  const dayBuckets = new Map<string, DailyBucket>();
  for (let i = windowDays - 1; i >= 0; i -= 1) {
    const key = utcDayKey(new Date(now.getTime() - i * 24 * 60 * 60 * 1000));
    dayKeys.push(key);
    dayBuckets.set(key, {
      date: key,
      total: 0,
      success: 0,
      error: 0,
      partial: 0,
      tokens: 0,
      costUsd: 0,
      avgDurationMs: 0,
    });
  }

  const byTask = new Map<string, TaskAnalyticsRow>();
  const byModel = new Map<string, ModelAnalyticsRow>();
  const cloneParent = new Map<string, string>();
  for (const task of options.tasks ?? []) {
    const parentId = task.matrixParentId?.trim();
    if (parentId) cloneParent.set(task.name.toLowerCase(), parentId);
  }

  let totalsTotal = 0;
  let totalsSuccess = 0;
  let totalsError = 0;
  let totalsPartial = 0;
  let totalsTokens = 0;
  let totalsCost = 0;
  let durationsSum = 0;
  let durationsCount = 0;
  let recordsInWindow = 0;

  for (const record of records) {
    const date = recordDate(record);
    if (!date) continue;
    const bucket = dayBuckets.get(date);
    // Итоги считаются только по окну — это «аналитика за период».
    if (!bucket) continue;
    recordsInWindow += 1;

    const tokens = toNumber(record.tokens);
    const cost = recordCost(record);
    const status = String(record.status ?? "");
    // Незавершённые запуски не участвуют в аналитике: их ещё нельзя оценить.
    if (status === "running") continue;
    const duration = toNumber(record.durationMs);

    bucket.total += 1;
    bucket.tokens += tokens;
    bucket.costUsd += cost;
    if (status === "success") bucket.success += 1;
    else if (status === "partial") bucket.partial += 1;
    else bucket.error += 1;
    if (duration > 0) {
      bucket.avgDurationMs =
        (bucket.avgDurationMs * (bucket.total - 1) + duration) / bucket.total;
    }

    totalsTotal += 1;
    totalsTokens += tokens;
    totalsCost += cost;
    if (status === "success") totalsSuccess += 1;
    else if (status === "partial") totalsPartial += 1;
    else totalsError += 1;
    if (duration > 0) {
      durationsSum += duration;
      durationsCount += 1;
    }

    const taskKey = record.taskName.toLowerCase();
    const existing = byTask.get(taskKey) ?? {
      taskName: record.taskName,
      total: 0,
      success: 0,
      error: 0,
      successRate: 0,
      avgDurationMs: 0,
      tokens: 0,
      costUsd: 0,
      isMatrixClone: cloneParent.has(taskKey),
      matrixParentId: cloneParent.get(taskKey) ?? null,
    };
    existing.total += 1;
    if (status === "success") existing.success += 1;
    else existing.error += 1;
    existing.tokens += tokens;
    existing.costUsd += cost;
    if (duration > 0) {
      existing.avgDurationMs =
        (existing.avgDurationMs * (existing.total - 1) + duration) / existing.total;
    }
    byTask.set(taskKey, existing);

    const model = record.model?.trim() || "(default)";
    const modelRow = byModel.get(model) ?? { model, total: 0, costUsd: 0 };
    modelRow.total += 1;
    modelRow.costUsd += cost;
    byModel.set(model, modelRow);
  }

  const tasks = [...byTask.values()]
    .map((row) => ({
      ...row,
      successRate: percent(row.success, row.total),
      avgDurationMs: Math.round(row.avgDurationMs),
      costUsd: Math.round(row.costUsd * 1e6) / 1e6,
    }))
    .sort((a, b) => b.total - a.total || a.taskName.localeCompare(b.taskName));

  const matrices = new Map<string, MatrixAnalyticsRow>();
  for (const row of tasks) {
    if (!row.matrixParentId) continue;
    const key = row.matrixParentId.toLowerCase();
    const matrix = matrices.get(key) ?? {
      parentId: row.matrixParentId,
      clones: 0,
      total: 0,
      success: 0,
      error: 0,
      successRate: 0,
      tokens: 0,
      costUsd: 0,
    };
    matrix.clones += 1;
    matrix.total += row.total;
    matrix.success += row.success;
    matrix.error += row.error;
    matrix.tokens += row.tokens;
    matrix.costUsd += row.costUsd;
    matrices.set(key, matrix);
  }

  const daily = dayKeys.map((key) => {
    const bucket = dayBuckets.get(key)!;
    return {
      ...bucket,
      avgDurationMs: Math.round(bucket.avgDurationMs),
      costUsd: Math.round(bucket.costUsd * 1e6) / 1e6,
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    windowDays,
    totals: {
      total: totalsTotal,
      success: totalsSuccess,
      error: totalsError,
      partial: totalsPartial,
      successRate: percent(totalsSuccess, totalsTotal),
      avgDurationMs: durationsCount > 0 ? Math.round(durationsSum / durationsCount) : 0,
      tokens: totalsTokens,
      costUsd: Math.round(totalsCost * 1e6) / 1e6,
    },
    daily,
    tasks,
    topByCost: [...tasks].sort((a, b) => b.costUsd - a.costUsd).slice(0, topLimit),
    matrices: [...matrices.values()]
      .map((row) => ({
        ...row,
        successRate: percent(row.success, row.total),
        costUsd: Math.round(row.costUsd * 1e6) / 1e6,
      }))
      .sort((a, b) => b.costUsd - a.costUsd),
    byModel: [...byModel.values()]
      .map((row) => ({ ...row, costUsd: Math.round(row.costUsd * 1e6) / 1e6 }))
      .sort((a, b) => b.costUsd - a.costUsd),
    sources: {
      historyRecords: records.length,
      recordsInWindow,
      topLimit,
    },
  };
}

/** Экранирование значения для CSV (RFC 4180). */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (/[",\r\n;]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/** Заголовок CSV-экспорта истории. */
export const HISTORY_CSV_HEADER = [
  "startedAt",
  "finishedAt",
  "taskName",
  "status",
  "durationMs",
  "tokens",
  "costUsd",
  "model",
  "workspaceId",
  "error",
] as const;

/** История в CSV: точки с запятой как разделитель — дружелюбно к Excel (RU). */
export function historyToCsv(records: AnalyticsRecord[]): string {
  const rows = [HISTORY_CSV_HEADER.join(";")];
  for (const record of records) {
    rows.push(
      [
        record.startedAt,
        record.finishedAt ?? "",
        record.taskName,
        record.status,
        record.durationMs ?? "",
        record.tokens ?? "",
        record.costUsd ?? "",
        record.model ?? "",
        record.workspaceId ?? "",
        record.error ?? "",
      ]
        .map(csvCell)
        .join(";")
    );
  }
  // BOM, чтобы Excel корректно открыл UTF-8 с кириллицей.
  return `\uFEFF${rows.join("\r\n")}`;
}
