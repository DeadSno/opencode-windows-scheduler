import { getAllMetrics } from "../db/metrics-repo.js";
import { countHistory, countRunningRecords, getHistory } from "../db/history-repo.js";
import { getPluginVersion } from "../version.js";
import { getProfileName } from "../profiles.js";
import { getSchedulerTitle } from "./scheduler/index.js";

/**
 * Prometheus-метрики (Спринт 22).
 *
 * Формат — текстовый exposition format 0.0.4, отдаётся по GET /metrics.
 * Никаких клиентских библиотек: собираем снимок из SQLite и рендерим строку.
 *
 * Имена метрик стабильны и документированы в docs/FEATURES.md:
 *   opencode_scheduler_info
 *   opencode_scheduler_up
 *   opencode_scheduler_queue_depth
 *   opencode_scheduler_history_records
 *   opencode_scheduler_runs_total{task,status}
 *   opencode_scheduler_errors_total{task}
 *   opencode_scheduler_tokens_total{task}
 *   opencode_scheduler_cost_usd_total{task}
 *   opencode_scheduler_run_duration_seconds{task,le} (+ _sum/_count)
 */

export const PROMETHEUS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

const DURATION_BUCKETS_SECONDS = [1, 5, 15, 30, 60, 120, 300, 600, 1800, 3600];

/** Экранирование значения label по правилам Prometheus. */
export function escapePrometheusLabel(value: string): string {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");
}

function labels(pairs: Record<string, string | number>): string {
  const entries = Object.entries(pairs);
  if (entries.length === 0) return "";
  return `{${entries
    .map(([key, value]) => `${key}="${escapePrometheusLabel(String(value))}"`)
    .join(",")}}`;
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

function metric(
  lines: string[],
  name: string,
  type: "counter" | "gauge" | "histogram",
  help: string,
  samples: Array<{ labels?: Record<string, string | number>; value: number }>
): void {
  lines.push(`# HELP ${name} ${help}`);
  lines.push(`# TYPE ${name} ${type}`);
  for (const sample of samples) {
    lines.push(`${name}${labels(sample.labels ?? {})} ${formatNumber(sample.value)}`);
  }
}

interface DurationStats {
  buckets: number[];
  sumSeconds: number;
  count: number;
}

function emptyDurationStats(): DurationStats {
  return { buckets: new Array(DURATION_BUCKETS_SECONDS.length).fill(0), sumSeconds: 0, count: 0 };
}

/** Собирает и рендерит снимок метрик. Чистая функция от состояния БД. */
export function renderPrometheusMetrics(): string {
  const metrics = getAllMetrics(false);
  const history = getHistory(null, 100000);
  const queueDepth = countRunningRecords();
  const historyRecords = countHistory();

  const durations = new Map<string, DurationStats>();
  for (const record of history) {
    if (record.status === "running") continue;
    const durationMs = Number(record.durationMs ?? 0);
    if (!Number.isFinite(durationMs) || durationMs < 0) continue;
    const task = record.taskName;
    const stats = durations.get(task) ?? emptyDurationStats();
    const seconds = durationMs / 1000;
    stats.sumSeconds += seconds;
    stats.count += 1;
    for (let i = 0; i < DURATION_BUCKETS_SECONDS.length; i += 1) {
      if (seconds <= DURATION_BUCKETS_SECONDS[i]) stats.buckets[i] += 1;
    }
    durations.set(task, stats);
  }

  const lines: string[] = [];

  metric(lines, "opencode_scheduler_info", "gauge", "Информация о планировщике.", [
    {
      labels: {
        version: getPluginVersion(),
        profile: getProfileName(),
        scheduler: getSchedulerTitle(),
      },
      value: 1,
    },
  ]);
  metric(lines, "opencode_scheduler_up", "gauge", "1 — HTTP-сервер метрик доступен.", [
    { value: 1 },
  ]);
  metric(
    lines,
    "opencode_scheduler_queue_depth",
    "gauge",
    "Количество незавершённых запусков (глубина очереди).",
    [{ value: queueDepth }]
  );
  metric(
    lines,
    "opencode_scheduler_history_records",
    "gauge",
    "Количество записей в истории запусков.",
    [{ value: historyRecords }]
  );

  const runSamples: Array<{ labels: Record<string, string | number>; value: number }> = [];
  const errorSamples: Array<{ labels: Record<string, string | number>; value: number }> = [];
  const tokenSamples: Array<{ labels: Record<string, string | number>; value: number }> = [];
  const costSamples: Array<{ labels: Record<string, string | number>; value: number }> = [];
  for (const row of metrics) {
    runSamples.push({
      labels: { task: row.taskName, status: "success" },
      value: row.success,
    });
    runSamples.push({
      labels: { task: row.taskName, status: "error" },
      value: row.error,
    });
    runSamples.push({
      labels: { task: row.taskName, status: "partial" },
      value: row.partial,
    });
    errorSamples.push({ labels: { task: row.taskName }, value: row.error });
    tokenSamples.push({ labels: { task: row.taskName }, value: row.tokens });
    costSamples.push({ labels: { task: row.taskName }, value: row.costUsd });
  }
  metric(
    lines,
    "opencode_scheduler_runs_total",
    "counter",
    "Количество завершённых запусков по задачам и статусам.",
    runSamples
  );
  metric(
    lines,
    "opencode_scheduler_errors_total",
    "counter",
    "Количество ошибок и таймаутов по задачам (partial не входит).",
    errorSamples
  );
  metric(
    lines,
    "opencode_scheduler_tokens_total",
    "counter",
    "Суммарное количество токенов по задачам.",
    tokenSamples
  );
  metric(
    lines,
    "opencode_scheduler_cost_usd_total",
    "counter",
    "Суммарная стоимость запусков в USD по задачам.",
    costSamples
  );

  lines.push(
    "# HELP opencode_scheduler_run_duration_seconds Длительность запусков в секундах."
  );
  lines.push("# TYPE opencode_scheduler_run_duration_seconds histogram");
  const taskNames = Array.from(durations.keys()).sort((a, b) => a.localeCompare(b));
  for (const task of taskNames) {
    const stats = durations.get(task)!;
    let cumulative = 0;
    for (let i = 0; i < DURATION_BUCKETS_SECONDS.length; i += 1) {
      cumulative += stats.buckets[i];
      lines.push(
        `opencode_scheduler_run_duration_seconds_bucket${labels({
          task,
          le: DURATION_BUCKETS_SECONDS[i],
        })} ${cumulative}`
      );
    }
    lines.push(
      `opencode_scheduler_run_duration_seconds_bucket${labels({ task, le: "+Inf" })} ${stats.count}`
    );
    lines.push(
      `opencode_scheduler_run_duration_seconds_sum${labels({ task })} ${formatNumber(
        stats.sumSeconds
      )}`
    );
    lines.push(
      `opencode_scheduler_run_duration_seconds_count${labels({ task })} ${stats.count}`
    );
  }
  if (taskNames.length === 0) {
    // Пустой histogram всё равно должен быть валидным: отдаём +Inf = 0.
    lines.push(`opencode_scheduler_run_duration_seconds_bucket${labels({ le: "+Inf" })} 0`);
    lines.push("opencode_scheduler_run_duration_seconds_sum 0");
    lines.push("opencode_scheduler_run_duration_seconds_count 0");
  }

  return `${lines.join("\n")}\n`;
}
