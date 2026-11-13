import crypto from "node:crypto";
import { getPluginVersion } from "../version.js";
import { getProfileName } from "../profiles.js";
import { getSchedulerTitle } from "./scheduler/index.js";
import type { StoredHistoryRecord } from "../db/history-repo.js";

/**
 * Экспорт истории в OpenTelemetry-совместимом виде (Спринт 22).
 *
 * Формат — OTLP/JSON (`resourceSpans` → `scopeSpans` → `spans`), который
 * принимают Collector, Jaeger, Tempo и большинство бэкендов после
 * `otlp`-приёмника. Один запуск = один span.
 *
 * Идентификаторы детерминированы: sha256 от задачи, времени старта и id,
 * поэтому повторный экспорт даёт стабильные traceId/spanId.
 */

interface OtlpAttributeValue {
  stringValue?: string;
  intValue?: string;
  doubleValue?: number;
  boolValue?: boolean;
}

interface OtlpAttribute {
  key: string;
  value: OtlpAttributeValue;
}

function stringAttr(key: string, value: string | null | undefined): OtlpAttribute | null {
  if (value == null || value === "") return null;
  return { key, value: { stringValue: String(value) } };
}

function intAttr(key: string, value: number | null | undefined): OtlpAttribute | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return { key, value: { intValue: String(Math.trunc(value)) } };
}

function doubleAttr(key: string, value: number | null | undefined): OtlpAttribute | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return { key, value: { doubleValue: value } };
}

function compact(attrs: Array<OtlpAttribute | null>): OtlpAttribute[] {
  return attrs.filter((attr): attr is OtlpAttribute => attr != null);
}

function toUnixNano(value: string | null | undefined): string | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  if (!Number.isFinite(ms)) return null;
  return (BigInt(Math.trunc(ms)) * 1000000n).toString();
}

function hashIds(record: StoredHistoryRecord): { traceId: string; spanId: string } {
  const digest = crypto
    .createHash("sha256")
    .update(
      `${record.taskName}|${record.startedAt}|${record.id ?? 0}`,
      "utf8"
    )
    .digest("hex");
  return { traceId: digest.slice(0, 32), spanId: digest.slice(32, 48) };
}

/** Строит OTLP/JSON-документ из записей истории. */
export function buildOtlpExport(records: StoredHistoryRecord[]): Record<string, unknown> {
  const version = getPluginVersion();
  const spans = records.map((record) => {
    const { traceId, spanId } = hashIds(record);
    const start = toUnixNano(record.startedAt) ?? "0";
    const end = toUnixNano(record.finishedAt) ?? start;
    const isRunning = record.status === "running";
    const isError = !isRunning && record.status !== "success";
    const attributes = compact([
      stringAttr("task.name", record.taskName),
      intAttr("run.id", record.id),
      stringAttr("run.status", record.status),
      intAttr("run.duration_ms", record.durationMs),
      intAttr("run.tokens", record.tokens),
      doubleAttr("run.cost_usd", record.costUsd),
      stringAttr("llm.model", record.model),
      stringAttr("error.message", record.error),
      stringAttr("next.task", record.nextTask),
      stringAttr("workspace.id", record.workspaceId),
      stringAttr("pre_flight.status", record.preFlightStatus),
      stringAttr("post_flight.status", record.postFlightStatus),
    ]);
    return {
      traceId,
      spanId,
      name: `${record.taskName} run`,
      kind: 1,
      startTimeUnixNano: start,
      endTimeUnixNano: end,
      attributes,
      status: {
        code: isRunning ? 0 : isError ? 2 : 1,
        ...(isError && record.error ? { message: String(record.error) } : {}),
      },
    };
  });

  return {
    resourceSpans: [
      {
        resource: {
          attributes: compact([
            stringAttr("service.name", "opencode-windows-scheduler"),
            stringAttr("service.version", version),
            stringAttr("scheduler.profile", getProfileName()),
            stringAttr("scheduler.backend", getSchedulerTitle()),
          ]),
        },
        scopeSpans: [
          {
            scope: {
              name: "opencode-windows-scheduler",
              version,
            },
            spans,
          },
        ],
      },
    ],
  };
}
