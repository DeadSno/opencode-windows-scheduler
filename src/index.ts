import { Plugin, Rpc } from "@opencode/plugin";
import { z } from "zod";
import { Tool } from "@opencode/schema/tool";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { LockManager } from "./core/lock.js";
import { LOCK_DIR, LOG_DIR, PLUGIN_DIR, sanitizeName } from "./types.js";
import { parseCron, buildScheduleGate, isValidIanaTimeZone, validateLaunchWindow, prevRun } from "./core/schedule-v2.js";
import {
  buildLaunchdOneShotCleanup,
  normalizeOneShotRunAt,
} from "./core/one-shot.js";
import {
  generateSessionId,
  normalizeSessionMode,
  preservedSessionRunCount,
  type SessionMode,
} from "./core/session.js";
import { ensureWrapper, writePromptFile, writeWrapperCmd, lockFilePath, requestImmediateRun } from "./core/ps-wrapper.js";
import { getSchedulerBackend } from "./core/scheduler/index.js";
import { SCHEDULER_SKILL_ID, loadSchedulerSkill } from "./skill.js";
import { getTaskLogs } from "./core/scheduler/logs.js";
import { writeBashWrapper } from "./core/wrappers/bash.js";
import { simulatePipeline } from "./core/dry-run.js";
import {
  aggregateMatrixResults,
  cancelPendingMatrixClones,
  expandMatrixTask,
  findOrphanedMatrixTasks,
  getMatrixDeletionGuard,
  matrixCompleteName,
  planMatrixFamilyDelete,
  removeMatrixChildren,
  runMatrix,
  syncMatrixFamily,
} from "./core/matrix.js";
import { SchedulerRpc } from "./rpc.js";
import { latestHistoryByTask, loadHistory, loadMetrics } from "./history.js";
import { loadSettings, saveSettings } from "./settings.js";
import type {
  HistorySettings,
  IntegrationSettings,
  NotificationSettings,
} from "./settings.js";
import { runHistoryRetention, maybeRunHistoryRetention } from "./core/retention.js";
import { buildAnalytics } from "./core/analytics.js";
import { getHistory, listRunningRecords } from "./db/history-repo.js";
import { getAllMetrics } from "./db/metrics-repo.js";
import {
  findStuckMatrixClones,
  maybeSendDigest,
  notifyStuckMatrix,
  sendDigestNow,
  sendTestNotification,
} from "./notifications.js";
import {
  loadTaskDefinitions,
  saveTaskDefinition,
  removeTaskDefinition,
  buildExportJson,
  parseImportJson,
  normalizePriority,
} from "./task-transfer.js";
import { FileWatchManager } from "./core/file-watcher.js";
import type {
  McpEventTrigger,
  MatrixConfig,
  MatrixWorkspaceOverride,
  TaskDefinition,
} from "./task-transfer.js";
import { loadTemplates, saveTemplate, deleteTemplate } from "./templates.js";
import type { TaskTemplate } from "./templates.js";
import { startDashboardServer, closeDashboardServer, getDashboardPort } from "./server.js";
import {
  DEFAULT_PROFILE,
  createProfile,
  deleteProfile,
  getProfileDir,
  getProfileName,
  isProfilePinnedByEnv,
  listProfiles,
  sanitizeProfileName,
  setActiveProfile,
} from "./profiles.js";
import { closeDb, initDb } from "./db/index.js";
import { migrateJsonToDb } from "./db/migrate.js";
import { checkJsonBackups, recoverInterruptedRuns } from "./db/recovery.js";
import { getTask, listMatrixClones, saveTask } from "./db/tasks-repo.js";
import {
  addWorkspace,
  deleteWorkspace,
  getWorkspace,
  listWorkspaces,
  updateWorkspace,
  validateWorkspacePath,
  readGitBranch,
  writeWorkspaceEnvFile,
  maskEnvForLog,
} from "./workspaces.js";

// Путь к вспомогательному node-скрипту записи истории/метрик (dist/core/record-history.js).
const require = createRequire(import.meta.url);
const resolvedRecorder = require.resolve("./core/record-history.js");

/**
 * Плагин может загружаться как из dist, так и напрямую из src (tsx/транспиляция).
 * Node не умеет исполнять .ts, поэтому для фоновых задач всегда берём
 * скомпилированный dist/core/record-history.js.
 */
const recorderPath = (() => {
  if (!resolvedRecorder.endsWith(".ts")) return resolvedRecorder;
  const distPath = resolvedRecorder
    .replace(/([\\/])src([\\/])/, "$1dist$2")
    .replace(/\.ts$/, ".js");
  if (existsSync(distPath)) return distPath;
  console.warn(
    "[windows-scheduler] Не найден собранный record-history.js: " +
      `${distPath}. История/метрики не будут записываться. Выполните npm run build.`
  );
  return distPath;
})();

/**
 * Путь к гейту расписания (dist/core/schedule-gate.js). Обёртка запускает его
 * перед opencode и выходит, если cron не сработал или запуск перенесён.
 */
const gatePath = (() => {
  const resolved = require.resolve("./core/schedule-gate.js");
  if (!resolved.endsWith(".ts")) return resolved;
  const distPath = resolved
    .replace(/([\\/])src([\\/])/, "$1dist$2")
    .replace(/\.ts$/, ".js");
  if (existsSync(distPath)) return distPath;
  console.warn(
    "[windows-scheduler] Не найден собранный schedule-gate.js: " +
      `${distPath}. Гейт расписания не будет проверяться. Выполните npm run build.`
  );
  return distPath;
})();

/** Бэкенд планировщика текущей ОС (schtasks / crontab / launchd). */
const scheduler = getSchedulerBackend();

/** Per-workspace overrides for matrix clones (Sprint 17). */
export const matrixOverrideSchema = z.object({
  prompt: z.string().optional(),
  model: z.string().optional(),
  qualityGate: z.string().optional(),
  beforeScript: z.string().optional(),
  afterScript: z.string().optional(),
});

/** Matrix (fan-out) configuration. */
export const matrixSchema = z.object({
  workspaceIds: z
    .array(z.string())
    .describe("Workspace ids to fan out to. Cannot be combined with workspaceId."),
  strategy: z
    .enum(["parallel", "sequential"])
    .optional()
    .describe(
      "parallel (default) starts all clones at once; sequential starts the next clone only after the previous one finishes."
    ),
  failureMode: z
    .enum(["continue", "stop"])
    .optional()
    .describe(
      "continue (default) keeps running the remaining clones after a failure; stop aborts the rest."
    ),
  aggregation: z
    .enum(["summary", "per-task"])
    .optional()
    .describe(
      "summary (default) writes one aggregate record for the parent; per-task keeps per-clone records."
    ),
  createAggregator: z
    .boolean()
    .optional()
    .describe(
      "Also create the <parent>-matrix-complete task depending on every clone."
    ),
  concurrency: z
    .number()
    .optional()
    .describe(
      "Maximum number of clones running at the same time (>= 1). Ignored for sequential (always 1) and capped by the global maxConcurrent setting."
    ),
  overrides: z
    .record(z.string(), matrixOverrideSchema)
    .optional()
    .describe(
      "Per-workspace overrides keyed by workspace id. Keys must be present in workspaceIds."
    ),
});

/** Zod-схема аргументов schedule_task */
export const scheduleTaskSchema = z.object({
  name: z.string().describe("Unique task name (the plugin prefix is applied automatically)."),
  schedule: z
    .string()
    .optional()
    .describe(
      "Cron expression (5 fields: minute hour day-of-month month day-of-week). Required for triggerType=cron; ignored for file/mcp-event. Supports ranges, lists, */N steps, month/weekday names, @every 15m|2h|1d, L (last day of month) and FRI#3 (third Friday). Expressions schtasks cannot express are checked every minute inside the wrapper."
    ),
  runAt: z
    .string()
    .optional()
    .describe(
      "Absolute one-shot start time in ISO-8601 (e.g. 2026-12-01T09:00:00Z). Requires triggerType=once; mutually exclusive with delaySeconds (runAt wins)."
    ),
  delaySeconds: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "One-shot delay in seconds from now. Requires triggerType=once. Convenient alternative to runAt."
    ),
  session: z
    .enum(["new", "reuse", "last"])
    .optional()
    .describe(
      "OpenCode session mode for the task: new (default, fresh session per run), reuse (keep a persistent session stored on the task — sessionId is auto-generated), last (continue the latest session via --continue)."
    ),
  sessionMaxRuns: z
    .number()
    .int()
    .min(1)
    .max(10000)
    .optional()
    .describe(
      "Only for session=reuse: how many runs the reused session survives before it is deleted and a fresh one is created. Unset/0 — no limit."
    ),
  timezone: z
    .string()
    .optional()
    .describe(
      "IANA timezone of the schedule, e.g. Europe/Moscow. Defaults to the system timezone. A zone different from the system one is evaluated by the wrapper (poll mode)."
    ),
  notBefore: z
    .string()
    .optional()
    .describe(
      "Launch window start in HH:MM (24h). Together with notAfter: a run outside the window is postponed to the next window opening, not skipped."
    ),
  notAfter: z
    .string()
    .optional()
    .describe("Launch window end in HH:MM (24h). May be earlier than notBefore (window crosses midnight)."),
  prompt: z
    .string()
    .describe("Prompt passed to the agent on every run."),
  timeoutSeconds: z
    .number()
    .optional()
    .describe("Run timeout in seconds (default 3600)."),
  model: z
    .string()
    .optional()
    .describe(
      "LLM model in OpenCode format, e.g. anthropic/claude-3-5-sonnet. Defaults to the OpenCode default model."
    ),
  priority: z
    .number()
    .optional()
    .describe("Task priority 0..10 (10 is the highest). Default 5 (normal)."),
  beforeScript: z
    .string()
    .optional()
    .describe(
      "Pre-flight shell command executed before the run (e.g. git pull). A non-zero exit code cancels the run."
    ),
  afterScript: z
    .string()
    .optional()
    .describe(
      "Post-flight shell command executed after the run (e.g. git push). Runs even when the task fails."
    ),
  qualityGate: z
    .string()
    .optional()
    .describe(
      "Shell command executed after a successful AI response (e.g. npm test). A non-zero exit code marks the run as a Quality Gate failure."
    ),
  dependsOn: z
    .array(z.string())
    .optional()
    .describe(
      "DAG dependencies: tasks that must finish successfully before this task starts."
    ),
  retryCount: z
    .number()
    .optional()
    .describe("How many times to retry a failed run (default 0)."),
  retryDelay: z
    .number()
    .optional()
    .describe("Delay between retries in seconds (default 60)."),
  nextTaskOnSuccess: z
    .string()
    .optional()
    .describe("Task started after a successful run."),
  nextTaskOnError: z
    .string()
    .optional()
    .describe("Compensation/rollback task started after a failed run."),
  triggerType: z
    .enum(["cron", "file", "mcp-event", "once"])
    .optional()
    .describe(
      "Trigger type: cron (default), file, mcp-event or once (single run at runAt/delaySeconds)."
    ),
  mcpEvent: z
    .object({
      server: z.string(),
      event: z.string(),
      filter: z.string().optional(),
    })
    .optional()
    .describe(
      "MCP event trigger: server, event name and an optional filter (key=value or regex)."
    ),
  watchPath: z
    .string()
    .optional()
    .describe(
      "File or directory to watch when triggerType is \"file\". Can be set here or later via update_task."
    ),
  workingDirectory: z
    .string()
    .optional()
    .describe(
      "Working directory of the task. Defaults to the current project folder so opencode run picks up the project's opencode.json with MCP servers."
    ),
  workspaceId: z
    .string()
    .optional()
    .describe(
      "Multi-repo workspace binding. When set, cwd = workspace path and workingDirectory is ignored."
    ),
  allowedTools: z
    .array(z.string())
    .optional()
    .describe(
      "Role-scoped tool allow-list. Metadata-only: logged and recorded in history, not enforced by opencode run yet. An empty array is rejected."
    ),
  deniedTools: z
    .array(z.string())
    .optional()
    .describe(
      "Role-scoped tool deny-list (takes precedence over allowedTools). Metadata-only."
    ),
  matrix: matrixSchema
    .optional()
    .describe(
      "Matrix fan-out: the task becomes a template that is expanded into clones, one per workspace. The parent never runs itself. Cannot be combined with workspaceId."
    ),
}).superRefine((value, ctx) => {
  const trigger = value.triggerType ?? "cron";
  if (trigger === "cron" && !value.schedule?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["schedule"],
      message: "Для triggerType=cron нужно cron-выражение schedule.",
    });
  }
  if (
    trigger === "once" &&
    !value.runAt &&
    value.delaySeconds === undefined
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["runAt"],
      message: "Для triggerType=once нужен runAt (ISO-8601) или delaySeconds.",
    });
  }
  if (trigger === "once" && value.matrix) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["matrix"],
      message: "One-shot нельзя комбинировать с matrix: матрица запускается только вручную.",
    });
  }
  if (trigger !== "once" && (value.runAt || value.delaySeconds !== undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["runAt"],
      message: "runAt/delaySeconds допустимы только при triggerType=once.",
    });
  }
});

const listTasksSchema = z.object({});

const deleteTaskSchema = z.object({
  name: z.string().describe("Task name to delete."),
});

const runTaskNowSchema = z.object({
  name: z.string().describe("Task name to run immediately."),
});

export const updateTaskSchema = z.object({
  name: z.string().describe("Name of the task to update."),
  schedule: z
    .string()
    .optional()
    .describe("New cron expression. Keeps the current value when omitted."),
  runAt: z
    .string()
    .optional()
    .describe(
      "New one-shot time in ISO-8601. Requires triggerType=once. Empty string clears it."
    ),
  delaySeconds: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "New one-shot delay in seconds from now. Requires triggerType=once."
    ),
  session: z
    .enum(["new", "reuse", "last"])
    .optional()
    .describe(
      "OpenCode session mode for the task: new (fresh session per run), reuse (keep a persistent session stored on the task — sessionId is auto-generated), last (continue the latest session via --continue)."
    ),
  sessionMaxRuns: z
    .number()
    .int()
    .min(1)
    .max(10000)
    .optional()
    .describe(
      "Only for session=reuse: how many runs the reused session survives before it is deleted and a fresh one is created. Unset/0 — no limit."
    ),
  timezone: z
    .string()
    .optional()
    .describe("New IANA timezone. Empty string clears it (system timezone)."),
  notBefore: z
    .string()
    .optional()
    .describe("New launch window start HH:MM. Empty string clears the window."),
  notAfter: z
    .string()
    .optional()
    .describe("New launch window end HH:MM. Empty string clears the window."),
  prompt: z
    .string()
    .optional()
    .describe("New prompt. Keeps the current value when omitted."),
  timeoutSeconds: z.number().optional().describe("New run timeout in seconds."),
  model: z
    .string()
    .optional()
    .describe("New model in OpenCode format. Empty string clears it (default model)."),
  priority: z.number().optional().describe("New priority 0..10."),
  beforeScript: z
    .string()
    .optional()
    .describe("New pre-flight command. Empty string clears it."),
  afterScript: z
    .string()
    .optional()
    .describe("New post-flight command. Empty string clears it."),
  qualityGate: z
    .string()
    .optional()
    .describe("New Quality Gate command. Empty string clears it."),
  dependsOn: z
    .array(z.string())
    .optional()
    .describe("New DAG dependencies. Empty array clears them."),
  retryCount: z.number().optional().describe("New retry count."),
  retryDelay: z.number().optional().describe("New retry delay in seconds."),
  nextTaskOnSuccess: z
    .string()
    .optional()
    .describe("New success-chain task. Empty string clears it."),
  nextTaskOnError: z
    .string()
    .optional()
    .describe("New error-chain task. Empty string clears it."),
  triggerType: z
    .enum(["cron", "file", "mcp-event", "once"])
    .optional()
    .describe("New trigger type."),
  mcpEvent: z
    .object({
      server: z.string(),
      event: z.string(),
      filter: z.string().optional(),
    })
    .optional()
    .describe("New MCP event trigger."),
  watchPath: z
    .string()
    .optional()
    .describe("New file-trigger path. Empty string clears it."),
  workingDirectory: z
    .string()
    .optional()
    .describe("New working directory. Empty string clears it."),
  workspaceId: z
    .string()
    .optional()
    .describe("New workspace binding. Empty string clears it."),
  allowedTools: z
    .array(z.string())
    .optional()
    .describe("New tool allow-list. Empty array clears it."),
  deniedTools: z
    .array(z.string())
    .optional()
    .describe("New tool deny-list. Empty array clears it."),
  matrix: matrixSchema
    .nullable()
    .optional()
    .describe(
      "New matrix configuration. Pass null to turn the matrix off (clones and aggregator are removed)."
    ),
}).superRefine((value, ctx) => {
  if (
    value.triggerType !== undefined &&
    value.triggerType !== "once" &&
    (value.runAt || value.delaySeconds !== undefined)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["runAt"],
      message: "runAt/delaySeconds допустимы только при triggerType=once.",
    });
  }
  if (value.triggerType === "once" && value.matrix) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["matrix"],
      message: "One-shot нельзя комбинировать с matrix.",
    });
  }
});

const pauseTaskSchema = z.object({
  name: z.string().describe("Task name to pause."),
  until: z
    .string()
    .optional()
    .describe(
      "Optional ISO date/time to resume automatically (e.g. 2026-12-01T09:00:00Z). The plugin re-enables the task at that moment."
    ),
});

const resumeTaskSchema = z.object({
  name: z.string().describe("Task name to resume."),
});

const getHistorySchema = z.object({
  taskName: z
    .string()
    .optional()
    .describe("Only return runs of this task (case-insensitive)."),
  status: z
    .enum(["running", "success", "error", "timeout", "partial"])
    .optional()
    .describe("Only return runs with this status."),
  limit: z
    .number()
    .optional()
    .describe("Maximum number of records to return (default 20, max 200)."),
});

const getTaskLogsSchema = z.object({
  name: z.string().describe("Task name to read logs for."),
  lines: z
    .number()
    .optional()
    .describe("Return only the last N log lines (default 200)."),
});

const dryRunSchema = z.object({
  name: z
    .string()
    .optional()
    .describe(
      "Task name to simulate. When omitted, every task is simulated (pipeline dry run, nothing is executed)."
    ),
});

const manageWorkspacesSchema = z.object({
  action: z
    .enum(["list", "add", "update", "delete"])
    .describe("Workspace operation to perform."),
  id: z.string().optional().describe("Workspace id (update/delete)."),
  name: z.string().optional().describe("Workspace display name (add/update)."),
  path: z.string().optional().describe("Absolute workspace path (add/update)."),
  color: z.string().optional().describe("Marker color, e.g. #4f8cff (add/update)."),
  env: z
    .record(z.string(), z.string())
    .nullable()
    .optional()
    .describe(
      "Env-переменные workspace (ключ → значение). Переопределяют значения из envFile; секреты маскируются в логах (add/update)."
    ),
  envFile: z
    .string()
    .nullable()
    .optional()
    .describe("Путь к .env-файлу workspace (add/update, null — очистить)."),
});

export const matrixControlSchema = z.object({
  action: z
    .enum(["results", "cancel", "cleanup", "preview"])
    .describe(
      "results — aggregate status of a matrix; cancel — cancel pending clones; cleanup — delete orphaned clones and aggregators; preview — dry-expand a matrix config into clone names without creating anything."
    ),
  name: z
    .string()
    .optional()
    .describe("Matrix parent name (required for results and cancel; used as clone prefix for preview)."),
  workspaceIds: z
    .array(z.string())
    .optional()
    .describe("Preview only: workspace ids to fan out to (omit for every workspace)."),
  strategy: z
    .enum(["parallel", "sequential"])
    .optional()
    .describe("Preview only: clone execution strategy."),
  failureMode: z
    .enum(["continue", "stop"])
    .optional()
    .describe("Preview only: what to do when one clone fails."),
  aggregation: z
    .enum(["summary", "per-task"])
    .optional()
    .describe("Preview only: how clone results are aggregated."),
});

/** get_metrics — общая статистика запусков. */
export const getMetricsSchema = z.object({});

/** get_analytics — аналитика за период. */
export const getAnalyticsSchema = z.object({
  days: z
    .number()
    .int()
    .min(1)
    .max(365)
    .optional()
    .describe("Analysis window in days (default 14)."),
  topLimit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe("How many top tasks to include (default 10)."),
});

/** manage_settings — глобальные настройки планировщика. */
export const manageSettingsSchema = z.object({
  action: z
    .enum(["get", "update"])
    .describe("get — current settings; update — merge the provided fields and save."),
  maxConcurrent: z
    .number()
    .int()
    .min(1)
    .max(16)
    .optional()
    .describe("How many task runs may execute at the same time."),
  winterMode: z
    .boolean()
    .optional()
    .describe("Winter mode: gentler scheduling of deferred runs."),
  notifications: z
    .any()
    .optional()
    .describe("Notification settings patch (enabled, onlyOnError, webhook, templates, filters, matrix, digest)."),
  history: z
    .object({
      retentionDays: z.number().int().min(1).max(3650).optional(),
      maxRecords: z.number().int().min(100).max(1000000).optional(),
    })
    .optional()
    .describe("History retention policy."),
  integrations: z
    .any()
    .optional()
    .describe(
      "Integration settings patch (hooks: enabled, token, secret, requireSignature, maxBodyBytes, timestampToleranceSeconds)."
    ),
});

/** manage_templates — пользовательские шаблоны задач. */
export const manageTemplatesSchema = z.object({
  action: z
    .enum(["list", "save", "delete"])
    .describe("list — all templates; save — create or update (id omitted = create); delete — remove by id."),
  id: z.string().optional().describe("Template id for update/delete."),
  name: z.string().optional().describe("Template name."),
  prompt: z.string().optional().describe("Prompt text stored in the template."),
  schedule: z.string().optional().describe("Cron expression."),
  timeoutSeconds: z.number().int().positive().optional(),
  model: z.string().optional(),
  priority: z.number().int().min(0).max(10).optional(),
  retryCount: z.number().int().min(0).optional(),
  retryDelay: z.number().int().min(0).optional(),
  qualityGate: z.string().optional(),
  beforeScript: z.string().optional(),
  afterScript: z.string().optional(),
  nextTaskOnSuccess: z.string().optional(),
  nextTaskOnError: z.string().optional(),
  dependsOn: z.array(z.string()).optional(),
  triggerType: z.enum(["cron", "file", "mcp-event"]).optional(),
  mcpEvent: z
    .object({
      server: z.string(),
      event: z.string(),
      filter: z.string().optional(),
    })
    .optional(),
  watchPath: z.string().optional(),
  workingDirectory: z.string().optional(),
  allowedTools: z.array(z.string()).optional(),
  deniedTools: z.array(z.string()).optional(),
});

/** manage_profiles — изолированные профили планировщика. */
export const manageProfilesSchema = z.object({
  action: z
    .enum(["list", "create", "switch", "delete"])
    .describe("list — profiles; create — new profile; switch — make active (restart required); delete — remove profile data."),
  name: z.string().optional().describe("Profile name (required for create/switch/delete)."),
  port: z.number().int().min(1).max(65535).optional().describe("Dashboard port for a new profile."),
});

/** transfer_tasks — экспорт и импорт задач. */
export const transferTasksSchema = z.object({
  action: z.enum(["export", "import"]).describe("export — JSON snapshot; import — recreate tasks from a snapshot."),
  data: z.string().optional().describe("JSON produced by export (required for import)."),
});

/** send_notification — проверка уведомлений и дайджест. */
export const sendNotificationSchema = z.object({
  action: z
    .enum(["test", "digest"])
    .describe("test — send a test message through the configured channel; digest — send the digest now."),
});

/** get_dashboard_info — сведения о панели управления. */
export const getDashboardInfoSchema = z.object({});

/** cleanup_history — удаление старой истории. */
export const cleanupHistorySchema = z.object({
  retentionDays: z.number().int().min(1).max(3650).optional().describe("Override the retention window."),
  maxRecords: z.number().int().min(100).max(1000000).optional().describe("Override the record cap."),
});

/** emit_event — запуск задач по MCP-событию. */
export const emitEventSchema = z.object({
  eventName: z.string().min(1).describe("Event name, for example 'deploy.finished'."),
  payload: z.any().optional().describe("Event payload passed to trigger filters."),
});

type ScheduleArgs = z.infer<typeof scheduleTaskSchema>;
type ListArgs = z.infer<typeof listTasksSchema>;
type DeleteArgs = z.infer<typeof deleteTaskSchema>;
type RunNowArgs = z.infer<typeof runTaskNowSchema>;
type UpdateArgs = z.infer<typeof updateTaskSchema>;
type PauseArgs = z.infer<typeof pauseTaskSchema>;
type ResumeArgs = z.infer<typeof resumeTaskSchema>;
type HistoryArgs = z.infer<typeof getHistorySchema>;
type TaskLogsArgs = z.infer<typeof getTaskLogsSchema>;
type DryRunArgs = z.infer<typeof dryRunSchema>;
type WorkspacesArgs = z.infer<typeof manageWorkspacesSchema>;
type MatrixControlArgs = z.infer<typeof matrixControlSchema>;
type MetricsArgs = z.infer<typeof getMetricsSchema>;
type AnalyticsArgs = z.infer<typeof getAnalyticsSchema>;
type SettingsArgs = z.infer<typeof manageSettingsSchema>;
type TemplatesArgs = z.infer<typeof manageTemplatesSchema>;
type ProfilesArgs = z.infer<typeof manageProfilesSchema>;
type TransferArgs = z.infer<typeof transferTasksSchema>;
type NotificationArgs = z.infer<typeof sendNotificationSchema>;
type DashboardInfoArgs = z.infer<typeof getDashboardInfoSchema>;
type CleanupHistoryArgs = z.infer<typeof cleanupHistorySchema>;
type EmitEventArgs = z.infer<typeof emitEventSchema>;

/**
 * Директория проекта, в которой запущен OpenCode. Используется как рабочая
 * директория задачи по умолчанию, чтобы `opencode run` подхватил opencode.json
 * с MCP-серверами проекта. Заполняется в setup из ctx.location.directory.
 */
let projectDirectory: string | undefined;

/**
 * Обёртка execute-функции: ловит ошибки и возвращает Tool.Result с content.
 * Использует Tool.Context из @opencode/schema/tool.
 */
function wrapExecute<Args>(
  fn: (args: Args, ctx: Tool.Context) => Promise<Tool.Result>
): (input: Args, context: Tool.Context) => Promise<Tool.Result> {
  return async (input, context) => {
    try {
      return await fn(input, context);
    } catch (err: any) {
      return {
        content: JSON.stringify({
          success: false,
          error: err instanceof Error ? err.message : String(err),
        }),
      };
    }
  };
}

/** schedule_task — создаёт задачу в schtasks через общий schedulerCreateTask. */
const scheduleTaskExecute = wrapExecute<ScheduleArgs>(async (args) => {
  const {
    name,
    schedule,
    runAt,
    delaySeconds,
    prompt,
    timeoutSeconds,
    model,
    priority,
    beforeScript,
    afterScript,
    qualityGate,
    dependsOn,
    retryCount,
    retryDelay,
    nextTaskOnSuccess,
    nextTaskOnError,
    triggerType,
    mcpEvent,
    watchPath,
    workingDirectory,
    workspaceId,
    allowedTools,
    deniedTools,
    matrix,
    timezone,
    notBefore,
    notAfter,
    session,
    sessionMaxRuns,
  } = args;

  let effectiveRunAt: string | undefined;
  if ((triggerType ?? "cron") === "once") {
    const normalized = normalizeOneShotRunAt({ runAt, delaySeconds });
    if (!normalized.ok) {
      return {
        content: JSON.stringify({ success: false, error: normalized.error }),
      };
    }
    effectiveRunAt = normalized.runAt;
  }

  // Спринт 24: режим сессии. По умолчанию "new" (старое поведение).
  // sessionId пользователя никогда не принимаем — он создаётся автоматически.
  const effectiveSession: "new" | "reuse" | "last" =
    normalizeSessionMode(session) ?? "new";
  const effectiveSessionId =
    effectiveSession === "reuse" ? generateSessionId() : undefined;

  try {
    await schedulerCreateTask(
      name,
      schedule ?? "",
      prompt,
      timeoutSeconds,
      workingDirectory,
      retryCount,
      retryDelay,
      qualityGate,
      nextTaskOnSuccess,
      nextTaskOnError,
      triggerType,
      watchPath,
      dependsOn,
      model,
      priority,
      beforeScript,
      afterScript,
      mcpEvent,
      workspaceId,
      allowedTools,
      deniedTools,
      matrix,
      undefined,
      "create",
      timezone,
      notBefore,
      notAfter,
      undefined,
      effectiveRunAt,
      effectiveSession,
      effectiveSessionId,
      sessionMaxRuns
    );
  } catch (err: any) {
    return {
      content: JSON.stringify({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      }),
    };
  }

  // Новый файловый триггер должен начать работать сразу, без перезапуска
  // OpenCode: пересобираем набор watcher-ов после создания задачи.
  await refreshFileTriggers();

  const workspace = workspaceId ? getWorkspace(workspaceId) : undefined;
  const effectiveWorkdir =
    workspace?.path || workingDirectory?.trim() || projectDirectory || process.cwd();
  return {
    content: JSON.stringify({
      success: true,
      message: `Задача "${name}" успешно создана.`,
      task: {
        name,
        schedule,
        timeoutSeconds: timeoutSeconds ?? 3600,
        model: model?.trim() || null,
        priority: priority ?? 5,
        beforeScript: beforeScript?.trim() || null,
        afterScript: afterScript?.trim() || null,
        qualityGate: qualityGate?.trim() || null,
        dependsOn: dependsOn ?? [],
        retryCount: retryCount ?? 0,
        retryDelay: retryDelay ?? null,
        nextTaskOnSuccess: nextTaskOnSuccess?.trim() || null,
        nextTaskOnError: nextTaskOnError?.trim() || null,
        triggerType: triggerType ?? "cron",
        runAt: effectiveRunAt ?? null,
        session: effectiveSession,
        sessionId: effectiveSessionId ?? null,
        sessionMaxRuns: sessionMaxRuns ?? null,
        timezone: timezone?.trim() || null,
        notBefore: notBefore?.trim() || null,
        notAfter: notAfter?.trim() || null,
        mcpEvent: mcpEvent ?? null,
        workingDirectory: effectiveWorkdir,
        workspaceId: workspace?.id ?? null,
        workspaceName: workspace?.name ?? null,
        matrix: matrix ?? null,
      },
    }),
  };
});

/** list_tasks — список задач плагина (та же логика, что и у get_tasks). */
const listTasksExecute = wrapExecute<ListArgs>(async () => {
  const tasks = await collectTasksView();

  if (tasks.length === 0) {
    return {
      content: JSON.stringify({
        success: true,
        message: "Задачи плагина не найдены.",
        tasks: [],
      }),
    };
  }

  return {
    content: JSON.stringify({
      success: true,
      message: `Найдено задач: ${tasks.length}.`,
      tasks,
    }),
  };
});

/**
 * Отмена выполняющейся матрицы: незавершённые клоны помечаются отменой
 * в истории, а реально запущенные — останавливаются (удаление задачи в
 * планировщике ОС завершает процесс) и пересоздаются как placeholder,
 * чтобы матрицу можно было запустить повторно.
 */
async function cancelMatrixRun(
  name: string
): Promise<{ cancelled: string[]; running: string[]; message: string; warnings: string[] }> {
  const definition = (await loadTaskDefinitions()).find(
    (def) => def.name.toLowerCase() === name.trim().toLowerCase()
  );
  if (!definition?.matrix) {
    throw new Error(`Задача "${name}" не является матрицей.`);
  }

  const result = await cancelPendingMatrixClones(definition.name);
  const warnings: string[] = [];

  for (const cloneName of result.running) {
    const clone = (await loadTaskDefinitions()).find(
      (def) => def.name.toLowerCase() === cloneName.toLowerCase()
    );
    if (!clone) continue;

    // Удаление запущенной задачи планировщика останавливает её процесс.
    try {
      await scheduler.deleteTask(clone.name);
    } catch (err: any) {
      warnings.push(
        `${clone.name}: не удалось остановить — ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      continue;
    }

    // Возвращаем placeholder-задачу, чтобы следующая fan-out-волна работала.
    try {
      await schedulerCreateTask(
        clone.name,
        clone.schedule,
        clone.prompt,
        clone.timeoutSeconds,
        undefined,
        clone.retryCount,
        clone.retryDelay,
        clone.qualityGate,
        undefined,
        undefined,
        "file",
        undefined,
        undefined,
        clone.model,
        clone.priority,
        clone.beforeScript,
        clone.afterScript,
        undefined,
        clone.workspaceId,
        clone.allowedTools,
        clone.deniedTools,
        undefined,
        definition.name,
        "create",
        clone.timezone,
        clone.notBefore,
        clone.notAfter,
        clone.pausedUntil
      );
    } catch (err: any) {
      warnings.push(
        `${clone.name}: не удалось пересоздать — ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  const parts = [
    `Матрица "${definition.name}": отменено ${result.cancelled.length} из ${
      result.aggregate.totalCount
    } клонов.`,
  ];
  if (result.running.length > 0) {
    parts.push(`Остановлено выполнявшихся: ${result.running.length}.`);
  }
  if (result.alreadyFinished.length > 0) {
    parts.push(`Уже завершены и не тронуты: ${result.alreadyFinished.length}.`);
  }
  if (warnings.length > 0) {
    parts.push(`Предупреждения: ${warnings.join("; ")}.`);
  }

  return {
    cancelled: result.cancelled,
    running: result.running,
    message: parts.join(" "),
    warnings,
  };
}

/** Вычищает клоны и агрегаторы, чьи матрицы уже удалены. */
async function cleanupOrphanedMatrixTasks(): Promise<string[]> {
  const orphans = findOrphanedMatrixTasks();
  const removed: string[] = [];

  for (const orphan of orphans) {
    try {
      await scheduler.deleteTask(orphan);
    } catch {
      // Записи могло уже не быть в планировщике.
    }
    try {
      await removeTaskDefinition(orphan);
    } catch {
      // Не критично.
    }
    removed.push(orphan);
  }

  if (removed.length > 0) {
    console.log(
      `[matrix] Очищены осиротевшие задачи матриц: ${removed.join(", ")}`
    );
  }
  return removed;
}

/**
 * Удаляет задачу из планировщика ОС и из БД.
 *
 * Lifecycle матриц (Спринт 16):
 *  - удаление родителя-матрицы каскадно удаляет клоны и агрегатор;
 *  - удаление клона поодиночке запрещено (защита от «сирот» и вечного running).
 */
async function deleteTaskWithFamily(
  name: string
): Promise<{ removed: string[]; existed: boolean }> {
  const trimmed = name.trim();
  const guard = getMatrixDeletionGuard(trimmed);
  if (guard) throw new Error(guard);

  const plan = planMatrixFamilyDelete(trimmed);
  const removed: string[] = [];

  // Отличаем реальное удаление от «удаления пустоты»: раньше инструмент
  // отвечал success даже на имя, которого никогда не существовало.
  let existed = Boolean(getTask(trimmed));
  if (!existed) {
    try {
      const osTasks = await scheduler.listTasks();
      existed = osTasks.some(
        (task) => task.taskName.toLowerCase() === trimmed.toLowerCase()
      );
    } catch {
      // ОС-планировщик недоступен — довольствуемся данными БД.
    }
  }
  if (plan && plan.children.length > 0) existed = true;

  if (plan) {
    for (const child of plan.children) {
      try {
        await scheduler.deleteTask(child);
      } catch {
        // Клона могло уже не быть в планировщике.
      }
      try {
        await removeTaskDefinition(child);
      } catch {
        // Не критично.
      }
      removed.push(child);
    }
  }

  await scheduler.deleteTask(trimmed);
  try {
    await removeTaskDefinition(trimmed);
  } catch {
    // Определения могло уже не быть — задача всё равно удалена из ОС.
  }

  return { removed, existed };
}

/** delete_task — удаление задачи по имени (/f) */
const deleteTaskExecute = wrapExecute<DeleteArgs>(async (args) => {
  const { name } = args;

  try {
    const { removed, existed } = await deleteTaskWithFamily(name);
    // Убираем watcher удалённой задачи, не дожидаясь перезапуска плагина.
    await refreshFileTriggers();
    if (!existed && removed.length === 0) {
      return {
        content: JSON.stringify({
          success: false,
          error: `Задача "${name}" не найдена — удалять нечего.`,
        }),
      };
    }
    return {
      content: JSON.stringify({
        success: true,
        message:
          removed.length > 0
            ? `Матрица "${name}" удалена вместе с клонами: ${removed.join(", ")}.`
            : `Задача "${name}" успешно удалена.`,
      }),
    };
  } catch (err: any) {
    return {
      content: JSON.stringify({
        success: false,
        error: err.message || String(err),
      }),
    };
  }
});

/** run_task_now — немедленный запуск задачи */
const runTaskNowExecute = wrapExecute<RunNowArgs>(async (args) => {
  const { name } = args;

  let alreadyRunning = false;
  try {
    const result = await runTaskEntry(name);
    alreadyRunning = result.alreadyRunning;
  } catch (err: any) {
    return {
      content: JSON.stringify({
        success: false,
        error: err.message || String(err),
      }),
    };
  }

  return {
    content: JSON.stringify({
      success: true,
      message: alreadyRunning
        ? `Задача "${name}" уже выполняется.`
        : `Задача "${name}" запущена.`,
    }),
  };
});

/**
 * Хелперы частичного обновления задачи: undefined — «не трогать»,
 * пустая строка/массив — «очистить».
 */
function clearableString(
  next: string | undefined,
  current: string | undefined
): string | undefined {
  if (next === undefined) return current;
  const trimmed = next.trim();
  return trimmed ? trimmed : undefined;
}

function clearableList(
  next: string[] | undefined,
  current: string[] | undefined
): string[] | undefined {
  if (next === undefined) return current;
  const cleaned = next.map((value) => value.trim()).filter(Boolean);
  return cleaned.length > 0 ? cleaned : undefined;
}

/** Удаляет клонов и агрегатор матрицы из планировщика ОС и из БД. */
async function removeMatrixChildrenFromScheduler(name: string): Promise<string[]> {
  const removed: string[] = [];
  for (const child of removeMatrixChildren(name)) {
    try {
      await scheduler.deleteTask(child);
    } catch {
      // ОС-задачи могло уже не быть.
    }
    try {
      await removeTaskDefinition(child);
    } catch {
      // Не критично.
    }
    removed.push(child);
  }
  return removed;
}

/**
 * Обновляет задачу, сохраняя все поля, которые не были переданы.
 * Используется инструментом update_task и RPC-методом update_task.
 */
async function updateTaskFromInput(
  input: UpdateArgs & { newSchedule?: string; newPrompt?: string }
): Promise<{ success: boolean; message: string }> {
  const name = input.name?.trim();
  if (!name) {
    return { success: false, message: "Не передано имя задачи." };
  }

  const previous = getTask(name);
  if (!previous) {
    return { success: false, message: `Задача "${name}" не найдена.` };
  }

  const schedule = clearableString(input.schedule ?? input.newSchedule, previous.schedule);
  const prompt = clearableString(input.prompt ?? input.newPrompt, previous.prompt);
  const triggerType = input.triggerType ?? previous.triggerType ?? "cron";
  const timezone = clearableString(input.timezone, previous.timezone);
  const notBefore = clearableString(input.notBefore, previous.notBefore);
  const notAfter = clearableString(input.notAfter, previous.notAfter);

  if (triggerType === "cron" && !schedule) {
    return {
      success: false,
      message: `Для обновления задачи "${name}" нужен cron-график.`,
    };
  }
  if (!prompt) {
    return {
      success: false,
      message: `Для обновления задачи "${name}" нужен промпт.`,
    };
  }

  // One-shot: без нового runAt/delaySeconds сохраняем прежнее время.
  // При смене триггера на once время обязательно, иначе задача не запустится.
  let runAt: string | undefined;
  if (triggerType === "once") {
    const candidateRunAt =
      input.runAt !== undefined
        ? input.runAt
        : input.delaySeconds !== undefined
        ? undefined
        : previous.runAt;
    const normalized = normalizeOneShotRunAt({
      runAt: candidateRunAt,
      delaySeconds: input.delaySeconds,
    });
    if (!normalized.ok) {
      return {
        success: false,
        message: `Задача "${name}": ${normalized.error}`,
      };
    }
    runAt = normalized.runAt;
  }

  // Спринт 24: режим сессии. Без новых session/sessionMaxRuns сохраняем прежние.
  // sessionId пользователя не принимаем — генерируем сами при переходе на reuse.
  let session: "new" | "reuse" | "last" = "new";
  if (input.session !== undefined) {
    const normalizedSession = normalizeSessionMode(input.session);
    if (!normalizedSession) {
      return {
        success: false,
        message: `Задача "${name}": неизвестный режим сессии "${String(input.session)}".`,
      };
    }
    session = normalizedSession;
  } else if (previous.session) {
    session = previous.session;
  }
  const sessionMaxRuns =
    input.sessionMaxRuns !== undefined ? input.sessionMaxRuns : previous.sessionMaxRuns;
  if (
    sessionMaxRuns !== undefined &&
    (!Number.isInteger(sessionMaxRuns) || sessionMaxRuns < 1)
  ) {
    return {
      success: false,
      message: `Задача "${name}": sessionMaxRuns должен быть целым числом ≥ 1.`,
    };
  }
  let sessionId = previous.sessionId;
  if (session === "reuse" && !sessionId) {
    sessionId = generateSessionId();
  }
  if (session !== "reuse") {
    sessionId = undefined;
  }

  const matrixWas = previous.matrix;
  const matrixNext =
    input.matrix === undefined ? matrixWas : input.matrix ?? undefined;
  if (triggerType === "once" && matrixNext) {
    return {
      success: false,
      message:
        `Задача "${name}": one-shot нельзя комбинировать с matrix. ` +
        `Запустите матрицу вручную или используйте cron/file-триггер.`,
    };
  }

  try {
    // Обновление = пересоздание в планировщике с сохранением старых значений.
    await scheduler.deleteTask(name);
    await schedulerCreateTask(
      name,
      schedule ?? "",
      prompt,
      input.timeoutSeconds ?? previous.timeoutSeconds,
      clearableString(input.workingDirectory, previous.workingDirectory),
      input.retryCount ?? previous.retryCount,
      input.retryDelay ?? previous.retryDelay,
      clearableString(input.qualityGate, previous.qualityGate),
      clearableString(input.nextTaskOnSuccess, previous.nextTaskOnSuccess),
      clearableString(input.nextTaskOnError, previous.nextTaskOnError),
      triggerType,
      clearableString(input.watchPath, previous.watchPath),
      clearableList(input.dependsOn, previous.dependsOn),
      clearableString(input.model, previous.model),
      input.priority ?? previous.priority,
      clearableString(input.beforeScript, previous.beforeScript),
      clearableString(input.afterScript, previous.afterScript),
      input.mcpEvent ?? previous.mcpEvent,
      clearableString(input.workspaceId, previous.workspaceId),
      clearableList(input.allowedTools, previous.allowedTools),
      clearableList(input.deniedTools, previous.deniedTools),
      matrixNext,
      undefined,
      // Если задача была матрицей — синхронизируем клонов, а не
      // пересоздаём их с нуля (Спринт 17).
      matrixWas && matrixNext ? "sync" : "create",
      timezone,
      notBefore,
      notAfter,
      previous.pausedUntil,
      runAt,
      session,
      sessionId,
      sessionMaxRuns
    );

    // Матрица отключена при обновлении — убираем клонов и агрегатор.
    if (matrixWas && !matrixNext) {
      await removeMatrixChildrenFromScheduler(name);
    }

    // Пересоздание могло изменить triggerType/watchPath — сразу
    // пересобираем набор файловых watcher-ов.
    await refreshFileTriggers();

    return { success: true, message: `Задача "${name}" обновлена.` };
  } catch (err: any) {
    return {
      success: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/** update_task — частичное обновление существующей задачи. */
const updateTaskExecute = wrapExecute<UpdateArgs>(async (args) => {
  const result = await updateTaskFromInput(args);
  return { content: JSON.stringify(result) };
});

/**
 * Пауза/возобновление задачи. Для матрицы операция применяется ко всем
 * клонам: сам родитель никогда не выполняется.
 */
async function pauseOrResumeTask(
  name: string,
  paused: boolean,
  until?: string
): Promise<{ success: boolean; message: string; affected: string[]; warnings: string[] }> {
  const trimmed = name.trim();
  const definition = getTask(trimmed);
  if (!definition) {
    return {
      success: false,
      message: `Задача "${trimmed}" не найдена.`,
      affected: [],
      warnings: [],
    };
  }

  // Пауза до даты (Спринт 19): проверяем ISO-момент до каких-либо изменений.
  let pausedUntil: string | undefined;
  if (paused && until?.trim()) {
    const parsed = Date.parse(until.trim());
    if (Number.isNaN(parsed)) {
      return {
        success: false,
        message: `Задача "${trimmed}": некорректная дата паузы "${until}". Нужен ISO-момент, например 2026-12-01T09:00:00Z.`,
        affected: [],
        warnings: [],
      };
    }
    if (parsed <= Date.now()) {
      return {
        success: false,
        message: `Задача "${trimmed}": дата паузы уже прошла.`,
        affected: [],
        warnings: [],
      };
    }
    pausedUntil = new Date(parsed).toISOString();
  }

  const targets = definition.matrix
    ? listMatrixClones(trimmed).map((clone) => clone.name)
    : [trimmed];
  if (targets.length === 0 && definition.matrix) {
    return {
      success: false,
      message: `У матрицы "${trimmed}" нет клонов.`,
      affected: [],
      warnings: [],
    };
  }

  const affected: string[] = [];
  const warnings: string[] = [];
  for (const target of targets) {
    try {
      if (paused) {
        await scheduler.pauseTask(target);
      } else {
        await scheduler.resumeTask(target);
      }
      affected.push(target);
    } catch (err: any) {
      warnings.push(
        `${target}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // Фиксируем (или снимаем) автопродолжение в определении задачи. У матрицы
  // родитель хранит pausedUntil за всех клонов — их включает авто-resume.
  const definitionUpdates = paused
    ? pausedUntil
      ? { pausedUntil }
      : undefined
    : definition.pausedUntil
      ? { pausedUntil: undefined }
      : undefined;
  if (definitionUpdates && affected.length > 0) {
    try {
      saveTask({ ...definition, ...definitionUpdates });
    } catch (err: any) {
      warnings.push(
        `не удалось сохранить автопродолжение: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  const untilText = pausedUntil
    ? ` до ${new Date(pausedUntil).toLocaleString()}`
    : "";
  const verb = paused ? "поставлена на паузу" : "возобновлена";
  const message = definition.matrix
    ? `Матрица "${trimmed}" ${verb}${untilText}: ${affected.length} из ${targets.length} клонов.` +
      (warnings.length > 0 ? ` Ошибки: ${warnings.join("; ")}.` : "")
    : `Задача "${trimmed}" ${verb}${untilText}.` +
      (warnings.length > 0 ? ` Ошибка: ${warnings.join("; ")}.` : "");

  return {
    success: warnings.length === 0,
    message,
    affected,
    warnings,
  };
}

const pauseTaskExecute = wrapExecute<PauseArgs>(async (args) => {
  const result = await pauseOrResumeTask(args.name, true, args.until);
  return { content: JSON.stringify(result) };
});

const resumeTaskExecute = wrapExecute<ResumeArgs>(async (args) => {
  const result = await pauseOrResumeTask(args.name, false);
  return { content: JSON.stringify(result) };
});

/** Периодичность проверки автопродолжения задач (Спринт 19). */
const PAUSED_UNTIL_CHECK_MS = 5 * 60 * 1000;
/** Период проверки дайджеста и зависших матриц (Спринт 20). */
const NOTIFICATION_CHECK_MS = 60 * 1000;

/**
 * Спринт 19: автопродолжение задач, поставленных на паузу до даты.
 * Включает задачу в планировщике ОС и снимает `pausedUntil` из определения.
 * Клоны матрицы не обрабатываются отдельно — за них отвечает родитель.
 */
async function resumeExpiredPauses(): Promise<void> {
  const now = Date.now();
  const definitions = await loadTaskDefinitions();
  for (const definition of definitions) {
    if (!definition.pausedUntil) continue;
    if (definition.matrixParentId) continue;
    const untilMs = Date.parse(definition.pausedUntil);
    if (!Number.isFinite(untilMs) || untilMs > now) continue;

    try {
      const targets = definition.matrix
        ? listMatrixClones(definition.name).map((clone) => clone.name)
        : [definition.name];
      for (const target of targets) {
        await scheduler.resumeTask(target);
      }
      await saveTaskDefinition({ ...definition, pausedUntil: undefined });
      console.log(
        `[windows-scheduler] Автопродолжение: задача "${definition.name}" включена (пауза истекла).`
      );
    } catch (err: any) {
      console.error(
        `[windows-scheduler] Не удалось автопродолжить задачу "${definition.name}": ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }
}

/** Уже отправленные уведомления о зависших клонах (id записи истории). */
const notifiedStuckRecords = new Set<number>();

/**
 * Детектор зависших матриц (Спринт 20): клоны, которые выполняются дольше
 * `notifications.matrix.stuckAfterMinutes`. Каждый запуск уведомляется один раз.
 */
async function checkStuckMatrices(): Promise<void> {
  const settings = await loadSettings();
  const config = settings.notifications;
  if (!config?.enabled) return;
  const matrix = config.matrix;
  if (!matrix?.enabled) return;
  const threshold = matrix.stuckAfterMinutes;
  if (!Number.isFinite(threshold) || threshold <= 0) return;

  const running = listRunningRecords();
  if (running.length === 0) {
    notifiedStuckRecords.clear();
    return;
  }
  // Снимаем отметки с завершившихся записей, чтобы Set не рос бесконечно.
  const runningIds = new Set(running.map((record) => record.id));
  for (const id of notifiedStuckRecords) {
    if (!runningIds.has(id)) notifiedStuckRecords.delete(id);
  }

  const parentByClone = new Map<string, string>();
  for (const definition of await loadTaskDefinitions()) {
    if (definition.matrixParentId) {
      parentByClone.set(definition.name.toLowerCase(), definition.matrixParentId);
    }
  }

  const stuck = findStuckMatrixClones(running, parentByClone, new Date(), threshold);
  for (const item of stuck) {
    if (notifiedStuckRecords.has(item.id)) continue;
    notifiedStuckRecords.add(item.id);
    await notifyStuckMatrix(item);
  }
}

/** get_history — история запусков с фильтрами по задаче и статусу. */
const getHistoryExecute = wrapExecute<HistoryArgs>(async (args) => {
  const limit = Math.max(1, Math.min(args.limit ?? 20, 200));
  const taskFilter = args.taskName?.trim().toLowerCase();
  const records = (await loadHistory())
    .filter(
      (record) =>
        !taskFilter || record.taskName.toLowerCase() === taskFilter
    )
    .filter((record) => !args.status || record.status === args.status)
    .slice(0, limit);

  return {
    content: JSON.stringify({
      success: true,
      count: records.length,
      records,
    }),
  };
});

/** get_task_logs — последние строки лога задачи. */
const getTaskLogsExecute = wrapExecute<TaskLogsArgs>(async (args) => {
  const result = await getTaskLogs(args.name, args.lines ?? 200);
  if (result.error) {
    return {
      content: JSON.stringify({ success: false, logs: "", error: result.error }),
    };
  }
  return {
    content: JSON.stringify({ success: true, logs: result.logs }),
  };
});

/** dry_run — симуляция пайплайна без выполнения. */
const dryRunExecute = wrapExecute<DryRunArgs>(async (args) => {
  const name = args.name?.trim();
  if (name) {
    const report = await simulatePipeline(name);
    return { content: JSON.stringify(report) };
  }

  const definitions = await loadTaskDefinitions();
  const reports: any[] = [];
  for (const definition of definitions) {
    try {
      reports.push(await simulatePipeline(definition.name));
    } catch (err: any) {
      reports.push({
        success: false,
        taskName: definition.name,
        tasks: [],
        totals: {
          estimatedDurationSec: null,
          estimatedCostUsd: null,
          estimatedTokens: null,
        },
        warnings: [],
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    content: JSON.stringify({
      success: reports.every((report) => report.success !== false),
      count: reports.length,
      reports,
    }),
  };
});

/**
 * Перегенерирует env-файлы всех задач, привязанных к workspace (Спринт 21).
 * Обёртки читают env-файл при запуске, поэтому перезапуск задач не нужен.
 */
async function refreshWorkspaceEnvFiles(workspaceId: string): Promise<number> {
  const workspace = getWorkspace(workspaceId);
  if (!workspace) return 0;
  let refreshed = 0;
  for (const task of await loadTaskDefinitions()) {
    if (task.workspaceId !== workspaceId) continue;
    writeWorkspaceEnvFile(workspace, PLUGIN_DIR, sanitizeName(task.name));
    refreshed += 1;
  }
  return refreshed;
}

/** manage_workspaces — CRUD multi-repo workspace-ов. */
const manageWorkspacesExecute = wrapExecute<WorkspacesArgs>(async (args) => {
  try {
    switch (args.action) {
      case "list": {
        const workspaces = listWorkspaces().map((workspace) => ({
          ...workspace,
          env: maskEnvForLog(workspace.env),
          gitBranch: readGitBranch(workspace.path) ?? null,
        }));
        return {
          content: JSON.stringify({
            success: true,
            count: workspaces.length,
            workspaces,
          }),
        };
      }
      case "add": {
        if (!args.path?.trim()) {
          return {
            content: JSON.stringify({
              success: false,
              error: "Для action=add нужен path.",
            }),
          };
        }
        const workspace = addWorkspace({
          name: args.name,
          path: args.path,
          color: args.color,
          env: args.env,
          envFile: args.envFile,
        });
        return {
          content: JSON.stringify({
            success: true,
            workspace: {
              ...workspace,
              env: maskEnvForLog(workspace.env),
              gitBranch: readGitBranch(workspace.path) ?? null,
            },
          }),
        };
      }
      case "update": {
        if (!args.id?.trim()) {
          return {
            content: JSON.stringify({
              success: false,
              error: "Для action=update нужен id.",
            }),
          };
        }
        const workspace = updateWorkspace(args.id, {
          name: args.name,
          path: args.path,
          color: args.color,
          env: args.env,
          envFile: args.envFile,
        });
        if (!workspace) {
          return {
            content: JSON.stringify({
              success: false,
              error: "Workspace не найден.",
            }),
          };
        }
        // Env-файлы уже созданных задач перегенерируются сразу: обёртки читают
        // файл при запуске, поэтому ждать обновления задачи не нужно.
        const refreshedTasks = await refreshWorkspaceEnvFiles(workspace.id);
        return {
          content: JSON.stringify({
            success: true,
            refreshedTasks,
            workspace: {
              ...workspace,
              env: maskEnvForLog(workspace.env),
              gitBranch: readGitBranch(workspace.path) ?? null,
            },
          }),
        };
      }
      case "delete": {
        if (!args.id?.trim()) {
          return {
            content: JSON.stringify({
              success: false,
              error: "Для action=delete нужен id.",
            }),
          };
        }
        const deleted = deleteWorkspace(args.id);
        return {
          content: JSON.stringify({
            success: deleted,
            message: deleted
              ? "Workspace удалён. Задачи сохранены, привязка очищена."
              : "Workspace не найден.",
          }),
        };
      }
    }
  } catch (err: any) {
    return {
      content: JSON.stringify({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      }),
    };
  }
});

/** matrix_control — результаты, отмена, очистка и предпросмотр матриц. */
const matrixControlExecute = wrapExecute<MatrixControlArgs>(async (args) => {
  if (args.action === "preview") {
    const clones = expandMatrixTask({
      name: (args.name ?? "").trim() || "task",
      schedule: "* * * * *",
      prompt: "preview",
      matrix: {
        workspaceIds: Array.isArray(args.workspaceIds) ? args.workspaceIds : [],
        strategy: args.strategy,
        failureMode: args.failureMode,
        aggregation: args.aggregation,
      },
    } as any);
    return {
      content: JSON.stringify({
        success: true,
        clones: clones.map((clone) => ({
          name: clone.name,
          workspaceId: clone.workspaceId ?? "",
          workspaceName: clone.workspaceId ? getWorkspace(clone.workspaceId)?.name ?? null : null,
        })),
      }),
    };
  }

  if (args.action === "cleanup") {
    const removed = await cleanupOrphanedMatrixTasks();
    return {
      content: JSON.stringify({
        success: true,
        message:
          removed.length > 0
            ? `Удалено осиротевших задач: ${removed.length}.`
            : "Осиротевших задач не найдено.",
        removed,
      }),
    };
  }

  const name = args.name?.trim();
  if (!name) {
    return {
      content: JSON.stringify({
        success: false,
        error: `Для action=${args.action} нужен name матрицы.`,
      }),
    };
  }

  if (args.action === "cancel") {
    try {
      const result = await cancelMatrixRun(name);
      return {
        content: JSON.stringify({
          success: true,
          message: result.message,
          cancelled: result.cancelled,
        }),
      };
    } catch (err: any) {
      return {
        content: JSON.stringify({
          success: false,
          error: err instanceof Error ? err.message : String(err),
        }),
      };
    }
  }

  try {
    const report = aggregateMatrixResults(name);
    return { content: JSON.stringify({ success: true, report }) };
  } catch (err: any) {
    return {
      content: JSON.stringify({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      }),
    };
  }
});

/** get_metrics — суммарная статистика запусков. */
const getMetricsExecute = wrapExecute<MetricsArgs>(async () => {
  const metrics = await loadMetrics();
  return { content: JSON.stringify({ success: true, metrics }) };
});

/** get_analytics — аналитика запусков и стоимости за период. */
const getAnalyticsExecute = wrapExecute<AnalyticsArgs>(async (args) => {
  const windowDays = Math.min(365, Math.max(1, Math.floor(Number(args.days) || 14)));
  const records = getHistory(null, 20000);
  const definitions = await loadTaskDefinitions();
  const report = buildAnalytics(records, {
    days: windowDays,
    topLimit: Math.max(1, Math.floor(Number(args.topLimit) || 10)),
    tasks: definitions.map((definition) => ({
      name: definition.name,
      matrixParentId: definition.matrixParentId,
    })),
  });
  return { content: JSON.stringify({ success: true, report }) };
});

/** manage_settings — чтение и изменение глобальных настроек. */
const manageSettingsExecute = wrapExecute<SettingsArgs>(async (args) => {
  const current = await loadSettings();
  if (args.action === "get") {
    return { content: JSON.stringify({ success: true, settings: current }) };
  }

  if (
    args.maxConcurrent === undefined &&
    args.winterMode === undefined &&
    args.notifications === undefined &&
    args.history === undefined &&
    args.integrations === undefined
  ) {
    return {
      content: JSON.stringify({
        success: false,
        error:
          "Для action=update передайте хотя бы одно поле: maxConcurrent, winterMode, notifications, history или integrations.",
        settings: current,
      }),
    };
  }

  const settings = await saveSettings({
    maxConcurrent: args.maxConcurrent,
    winterMode: args.winterMode,
    notifications: args.notifications as NotificationSettings | undefined,
    history: args.history as HistorySettings | undefined,
    integrations: args.integrations as IntegrationSettings | undefined,
  });
  return { content: JSON.stringify({ success: true, settings }) };
});

/** manage_templates — список, сохранение и удаление шаблонов задач. */
const manageTemplatesExecute = wrapExecute<TemplatesArgs>(async (args) => {
  if (args.action === "list") {
    return { content: JSON.stringify({ success: true, templates: await loadTemplates() }) };
  }

  if (args.action === "delete") {
    const id = args.id?.trim();
    if (!id) {
      return { content: JSON.stringify({ success: false, error: "Для action=delete нужен id шаблона." }) };
    }
    const before = await loadTemplates();
    const existed = before.some((template) => template.id === id);
    await deleteTemplate(id);
    return {
      content: JSON.stringify({
        success: existed,
        message: existed ? `Шаблон ${id} удалён.` : `Шаблон ${id} не найден.`,
      }),
    };
  }

  const { action, ...fields } = args;
  if (!fields.name?.trim() || !fields.prompt?.trim()) {
    return {
      content: JSON.stringify({
        success: false,
        error: "Для action=save нужны непустые name и prompt.",
      }),
    };
  }
  const template = await saveTemplate(fields as Omit<TaskTemplate, "id"> & { id?: string });
  return { content: JSON.stringify({ success: true, template }) };
});

/** manage_profiles — список, создание, переключение и удаление профилей. */
const manageProfilesExecute = wrapExecute<ProfilesArgs>(async (args) => {
  if (args.action === "list") {
    return {
      content: JSON.stringify({
        success: true,
        current: getProfileName(),
        pinnedByEnv: isProfilePinnedByEnv(),
        profiles: listProfiles(),
      }),
    };
  }

  const name = args.name?.trim();
  if (!name) {
    return {
      content: JSON.stringify({
        success: false,
        error: `Для action=${args.action} нужно имя профиля.`,
      }),
    };
  }

  if (args.action === "create") {
    const meta = createProfile(name, args.port);
    const profile = listProfiles().find((item) => item.name === meta.name);
    return {
      content: JSON.stringify({
        success: true,
        message: `Профиль "${meta.name}" создан (порт дашборда ${meta.port}).`,
        profile: profile ?? {
          name: meta.name,
          dir: getProfileDir(meta.name),
          port: meta.port,
          isDefault: meta.name === DEFAULT_PROFILE,
          active: meta.name === getProfileName(),
        },
      }),
    };
  }

  if (args.action === "switch") {
    setActiveProfile(name);
    const current = getProfileName();
    return {
      content: JSON.stringify({
        success: true,
        current,
        restartRequired: true,
        message: isProfilePinnedByEnv()
          ? `Профиль задан переменной OPENCODE_SCHEDULER_PROFILE=${current}. Перезапустите OpenCode.`
          : `Активный профиль: ${sanitizeProfileName(name)}. Перезапустите OpenCode, чтобы применить изменения.`,
      }),
    };
  }

  const removed = deleteProfile(name);
  return {
    content: JSON.stringify({
      success: removed,
      message: removed
        ? `Профиль "${sanitizeProfileName(name)}" удалён вместе с его БД и настройками.`
        : "Профиль не найден.",
    }),
  };
});

/** transfer_tasks — экспорт и импорт задач. */
const transferTasksExecute = wrapExecute<TransferArgs>(async (args) => {
  if (args.action === "export") {
    const tasks = await scheduler.listTasks();
    const { data, count } = await buildExportJson(
      tasks.map((task) => ({ ...task, name: task.taskName || "" }))
    );
    return { content: JSON.stringify({ success: true, data, count }) };
  }

  if (!args.data) {
    return { content: JSON.stringify({ success: false, error: "Для action=import нужны данные экспорта." }) };
  }
  const parsed = parseImportJson(args.data);
  if (parsed.tasks.length === 0) {
    return {
      content: JSON.stringify({
        success: false,
        error: "В данных нет задач для импорта.",
        errors: parsed.errors,
      }),
    };
  }

  const imported: string[] = [];
  const errors: string[] = [...parsed.errors];
  for (const def of parsed.tasks) {
    try {
      await schedulerCreateTask(
        def.name,
        def.schedule,
        def.prompt,
        def.timeoutSeconds,
        def.workingDirectory ?? def.workdir,
        def.retryCount,
        def.retryDelay,
        def.qualityGate,
        def.nextTaskOnSuccess,
        def.nextTaskOnError,
        def.triggerType,
        def.watchPath,
        def.dependsOn,
        def.model,
        def.priority,
        def.beforeScript,
        def.afterScript,
        def.mcpEvent,
        def.workspaceId,
        def.allowedTools,
        def.deniedTools,
        def.matrix,
        def.matrixParentId,
        "create",
        def.timezone,
        def.notBefore,
        def.notAfter,
        def.pausedUntil,
        def.runAt
      );
      await saveTaskDefinition(def);
      imported.push(def.name);
    } catch (err: any) {
      errors.push(`${def.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  await refreshFileTriggers();
  return {
    content: JSON.stringify({ success: errors.length === 0, imported, errors }),
  };
});

/** send_notification — тестовое уведомление или дайджест. */
const sendNotificationExecute = wrapExecute<NotificationArgs>(async (args) => {
  const result =
    args.action === "test"
      ? await sendTestNotification()
      : await sendDigestNow({ updateLastSentAt: false });
  return { content: JSON.stringify(result) };
});

/** get_dashboard_info — порт дашборда, платформа и активный профиль. */
const getDashboardInfoExecute = wrapExecute<DashboardInfoArgs>(async () => {
  const port = getDashboardPort();
  return {
    content: JSON.stringify({
      success: true,
      port,
      url: port ? `http://127.0.0.1:${port}` : null,
      platform: scheduler.platform,
      title: scheduler.title,
      profile: getProfileName(),
    }),
  };
});

/** cleanup_history — удаление старых записей истории. */
const cleanupHistoryExecute = wrapExecute<CleanupHistoryArgs>(async (args) => {
  const report = await runHistoryRetention({
    retentionDays: args.retentionDays,
    maxRecords: args.maxRecords,
  });
  return {
    content: JSON.stringify({
      success: true,
      message: report.skipped
        ? report.skipped
        : `Удалено ${report.deleted} записей (по возрасту: ${report.deletedByAge}, по лимиту: ${report.deletedByCount}), осталось ${report.kept}.`,
      report,
    }),
  };
});

/** emit_event — запуск задач, подписанных на MCP-событие. */
const emitEventExecute = wrapExecute<EmitEventArgs>(async (args) => {
  const eventName = args.eventName?.trim();
  if (!eventName) {
    return { content: JSON.stringify({ success: false, error: "Не передано имя события." }) };
  }
  const payload = args.payload ?? {};
  const definitions = await loadTaskDefinitions();
  const matched = definitions
    .filter(
      (def) =>
        def.triggerType === "mcp-event" &&
        def.mcpEvent?.event?.toLowerCase() === eventName.toLowerCase() &&
        matchesEventFilter(def.mcpEvent?.filter, payload)
    )
    .sort(
      (a, b) =>
        (normalizePriority(b.priority) ?? 0) - (normalizePriority(a.priority) ?? 0)
    );

  const triggered: string[] = [];
  for (const def of matched) {
    try {
      await runTaskEntry(def.name);
      triggered.push(def.name);
    } catch (err: any) {
      console.error(`[windows-scheduler] emit_event: не удалось запустить ${def.name}:`, err);
    }
  }
  return {
    content: JSON.stringify({
      success: true,
      message:
        triggered.length > 0
          ? `Запущено задач: ${triggered.length}.`
          : `Нет задач, подписанных на событие "${eventName}".`,
      triggered,
    }),
  };
});

/**
 * Менеджер файловых триггеров живёт на уровне модуля, чтобы его можно было
 * обновлять после создания/изменения/удаления задачи. Раньше refresh()
 * вызывался только при старте плагина, из-за чего новые watchPath начинали
 * работать лишь после перезапуска OpenCode.
 */
let fileWatcherManager: FileWatchManager | null = null;

async function refreshFileTriggers(): Promise<void> {
  if (!fileWatcherManager) return;
  try {
    await fileWatcherManager.refresh();
  } catch (err: any) {
    console.error(
      `[windows-scheduler] Не удалось обновить файловые триггеры: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}

export default Plugin.define({
  id: "opencode-windows-scheduler",
  setup: async (ctx) => {
    // Папка проекта — рабочая директория задач по умолчанию. Благодаря ей
    // `opencode run` подхватывает opencode.json с MCP-серверами проекта.
    projectDirectory = ctx.location?.directory || process.cwd();

    // Спринт 12: SQLite — основное хранилище. Открываем БД, при первом запуске
    // автоматически переносим данные из JSON, затем восстанавливаем прерванные
    // запуски. Ошибки миграции не должны мешать плагину стартовать.
    initDb();
    try {
      await migrateJsonToDb();
    } catch (err: any) {
      console.error(
        `[migrate] Не удалось мигрировать JSON → SQLite: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
    try {
      recoverInterruptedRuns();
    } catch (err: any) {
      console.error(
        `[recovery] Не удалось восстановить незавершённые запуски: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
    checkJsonBackups();

    // Спринт 18: ежедневная очистка истории. Ошибка ретеншна не должна мешать
    // плагину стартовать — пишем в лог и продолжаем.
    void maybeRunHistoryRetention()
      .then((report) => {
        if (report && report.deleted > 0) {
          console.log(
            `[retention] Удалено ${report.deleted} записей истории ` +
              `(по возрасту: ${report.deletedByAge}, по лимиту: ${report.deletedByCount}); ` +
              `осталось ${report.kept}.`
          );
        }
      })
      .catch((err: any) => {
        console.error(
          `[retention] Не удалось очистить историю: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      });

    // Спринт 19: автопродолжение задач, поставленных на паузу до даты.
    // Проверяем сразу при старте и далее раз в 5 минут, пока плагин жив.
    void resumeExpiredPauses().catch((err: any) => {
      console.error(
        `[windows-scheduler] Не удалось проверить автопродолжение: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    });
    const pausedUntilTimer = setInterval(() => {
      void resumeExpiredPauses().catch((err: any) => {
        console.error(
          `[windows-scheduler] Не удалось проверить автопродолжение: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      });
    }, PAUSED_UNTIL_CHECK_MS);
    pausedUntilTimer.unref?.();

    // Спринт 20: дайджест и детектор зависших матриц. Проверяем сразу при
    // старте и далее раз в минуту; таймер не держит процесс Node живым.
    const notificationTimer = setInterval(() => {
      void maybeSendDigest().catch(() => undefined);
      void checkStuckMatrices().catch((err: any) => {
        console.error(
          `[windows-scheduler] Детектор зависших матриц: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      });
    }, NOTIFICATION_CHECK_MS);
    notificationTimer.unref?.();
    void maybeSendDigest().catch(() => undefined);
    void checkStuckMatrices().catch(() => undefined);

    // Инициализация блокировок: создаём директорию и очищаем зависшие lock-файлы (>24 ч).
    const lockManager = new LockManager(LOCK_DIR);
    await lockManager.initialize();

    // Восстановление пропущенных запусков (catch-up): если OpenCode был закрыт,
    // а задача должна была выполниться (с nextRun прошло >5 мин и в истории нет
    // записи после этого времени) — запускаем её немедленно.
    void (async () => {
      try {
        const definitions = await loadTaskDefinitions();
        const history = await loadHistory();
        const now = new Date();
        const catchUpThresholdMs = 5 * 60 * 1000;

        // Сначала запускаем задачи с более высоким приоритетом (10 — максимум).
        const prioritized = [...definitions].sort(
          (a, b) => (normalizePriority(b.priority) ?? 5) - (normalizePriority(a.priority) ?? 5)
        );

        for (const def of prioritized) {
          // Catch-up имеет смысл только для cron-задач.
          if ((def.triggerType ?? "cron") !== "cron") continue;
          if (!def.schedule) continue;
          // Задача на паузе до даты — её включит авто-продолжение.
          if (def.pausedUntil) continue;
          const prev = prevRun(def.schedule, now, def.timezone);
          if (!prev) continue;
          const ageMs = now.getTime() - prev.getTime();
          if (ageMs < catchUpThresholdMs) continue;

          // Есть ли запись в истории после предполагаемого времени запуска?
          const ranAfter = history.some(
            (r) =>
              r.taskName.toLowerCase() === def.name.toLowerCase() &&
              new Date(r.startedAt).getTime() >= prev.getTime()
          );
          if (ranAfter) continue;

          // Запускаем задачу и пишем в лог.
          try {
            await runTaskEntry(def.name);
            console.log(
              `[windows-scheduler] Запущено восстановление пропущенной задачи "${def.name}" (последний срабатывал ~${Math.round(ageMs / 1000)} с назад).`
            );
          } catch (err: any) {
            console.error(
              `[windows-scheduler] Не удалось восстановить задачу "${def.name}": ${
                err instanceof Error ? err.message : String(err)
              }`
            );
          }
        }
      } catch (err: any) {
        console.error(
          `[windows-scheduler] Catch-up ошибка: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    })();

    // Файловые триггеры (File Watchers): задачи с triggerType === "file"
    // запускаются при изменении watchPath через chokidar (с дебаунсом).
    fileWatcherManager = new FileWatchManager(async (taskName) => {
      try {
        await runTaskEntry(taskName);
        console.log(
          `[windows-scheduler] Запуск задачи "${taskName}" по изменению отслеживаемого файла.`
        );
      } catch (err: any) {
        console.error(
          `[windows-scheduler] Не удалось запустить задачу "${taskName}" по файловому триггеру: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    });
    void refreshFileTriggers();

    const registration = await ctx.tool.transform((editor) => {
      // editor.add регистрирует новые инструменты плагина с codemode: true,
      // чтобы они были видны в Code Mode. Встроенные schedule_* отключены
      // через "experimental": { "schedules": false } в opencode.jsonc.
      editor.add({
        name: "schedule_task",
        input: scheduleTaskSchema,
        description:
          `Creates a task in the OS scheduler (${scheduler.title}) with a cron schedule, optional Quality Gate, DAG dependencies, retry policy and matrix fan-out. ` +
          "Every run goes through a timeout + lock-file wrapper, so overlapping runs are skipped. " +
          "Without workingDirectory the task runs in the current project folder, where opencode run picks up the project's opencode.json and MCP servers.",
        options: { codemode: true },
        execute: scheduleTaskExecute as any,
      });

      editor.add({
        name: "list_tasks",
        input: listTasksSchema,
        description:
          `Lists plugin tasks from the scheduler (${scheduler.title}) with schedule, status, next chained task and working directory. ` +
          "Matrix parents include a per-clone summary.",
        options: { codemode: true },
        execute: listTasksExecute as any,
      });

      editor.add({
        name: "update_task",
        input: updateTaskSchema,
        description:
          "Partially updates an existing task: omitted fields keep their current values, empty strings/arrays clear them. " +
          "Matrix changes are synced (clones are diffed, running clones are never touched); pass matrix: null to remove the matrix and its clones.",
        options: { codemode: true },
        execute: updateTaskExecute as any,
      });

      editor.add({
        name: "delete_task",
        input: deleteTaskSchema,
        description:
          `Deletes a task from the scheduler (${scheduler.title}) by name. ` +
          "Deleting a matrix parent also deletes its clones and aggregator; deleting a single clone is refused (delete the whole matrix instead).",
        options: { codemode: true },
        execute: deleteTaskExecute as any,
      });

      editor.add({
        name: "run_task_now",
        input: runTaskNowSchema,
        description:
          `Runs a task immediately in the scheduler (${scheduler.title}) for testing. ` +
          "Runs through the timeout + lock wrapper. For a matrix parent this starts the fan-out instead of the parent itself.",
        options: { codemode: true },
        execute: runTaskNowExecute as any,
      });

      editor.add({
        name: "pause_task",
        input: pauseTaskSchema,
        description:
          "Pauses a task in the OS scheduler. For a matrix parent every clone is paused (the parent itself never runs).",
        options: { codemode: true },
        execute: pauseTaskExecute as any,
      });

      editor.add({
        name: "resume_task",
        input: resumeTaskSchema,
        description:
          "Resumes a previously paused task. For a matrix parent every clone is resumed.",
        options: { codemode: true },
        execute: resumeTaskExecute as any,
      });

      editor.add({
        name: "get_history",
        input: getHistorySchema,
        description:
          "Returns recent run history (status, duration, tokens, cost, model, Quality Gate and pre/post-flight results). " +
          "Filter by taskName and/or status; newest first.",
        options: { codemode: true },
        execute: getHistoryExecute as any,
      });

      editor.add({
        name: "get_task_logs",
        input: getTaskLogsSchema,
        description:
          "Returns the tail of a task's log file written by the run wrapper. Use it to diagnose failed runs.",
        options: { codemode: true },
        execute: getTaskLogsExecute as any,
      });

      editor.add({
        name: "dry_run",
        input: dryRunSchema,
        description:
          "Simulates a task pipeline (or every task when name is omitted): execution order, DAG dependencies, matrix fan-out, estimated duration/cost and warnings. Nothing is executed.",
        options: { codemode: true },
        execute: dryRunExecute as any,
      });

      editor.add({
        name: "manage_workspaces",
        input: manageWorkspacesSchema,
        description:
          "Manages multi-repo workspaces: list, add, update or delete. Tasks can target a workspace by id (cwd = workspace path) or fan out to several with matrix.workspaceIds.",
        options: { codemode: true },
        execute: manageWorkspacesExecute as any,
      });

      editor.add({
        name: "matrix_control",
        input: matrixControlSchema,
        description:
          "Matrix lifecycle: results (aggregate status/counters of a matrix), cancel (cancel pending clones, stop running ones), cleanup (delete orphaned clones and aggregators whose parent is gone) or preview (expand a matrix config into clone names without creating anything).",
        options: { codemode: true },
        execute: matrixControlExecute as any,
      });

      editor.add({
        name: "get_metrics",
        input: getMetricsSchema,
        description:
          "Returns aggregate run metrics: total runs, successes and failures across all tasks.",
        options: { codemode: true },
        execute: getMetricsExecute as any,
      });

      editor.add({
        name: "get_analytics",
        input: getAnalyticsSchema,
        description:
          "Returns an analytics report for a period: run counts, success rate, duration, tokens and cost, plus top tasks.",
        options: { codemode: true },
        execute: getAnalyticsExecute as any,
      });

      editor.add({
        name: "manage_settings",
        input: manageSettingsSchema,
        description:
          "Reads or updates global scheduler settings: maxConcurrent, winterMode, notifications (webhook, filters, matrix alerts, digest) and history retention. Updates are merged into the current settings.",
        options: { codemode: true },
        execute: manageSettingsExecute as any,
      });

      editor.add({
        name: "manage_templates",
        input: manageTemplatesSchema,
        description:
          "Lists, saves or deletes reusable task templates (prompt, schedule, retries, Quality Gate, chains, triggers, tool restrictions).",
        options: { codemode: true },
        execute: manageTemplatesExecute as any,
      });

      editor.add({
        name: "manage_profiles",
        input: manageProfilesSchema,
        description:
          "Lists, creates, switches or deletes isolated scheduler profiles (separate database, settings and dashboard port). Switching requires an OpenCode restart.",
        options: { codemode: true },
        execute: manageProfilesExecute as any,
      });

      editor.add({
        name: "transfer_tasks",
        input: transferTasksSchema,
        description:
          "Exports all tasks as a portable JSON snapshot or imports tasks from such a snapshot, recreating them in the OS scheduler.",
        options: { codemode: true },
        execute: transferTasksExecute as any,
      });

      editor.add({
        name: "send_notification",
        input: sendNotificationSchema,
        description:
          "Sends a test notification through the configured channel or sends the digest immediately.",
        options: { codemode: true },
        execute: sendNotificationExecute as any,
      });

      editor.add({
        name: "get_dashboard_info",
        input: getDashboardInfoSchema,
        description:
          "Returns dashboard port and URL, OS platform, scheduler title and the active profile.",
        options: { codemode: true },
        execute: getDashboardInfoExecute as any,
      });

      editor.add({
        name: "cleanup_history",
        input: cleanupHistorySchema,
        description:
          "Deletes old run history by age and/or record cap, using the stored retention policy unless overridden.",
        options: { codemode: true },
        execute: cleanupHistoryExecute as any,
      });

      editor.add({
        name: "emit_event",
        input: emitEventSchema,
        description:
          "Emits an MCP event: every task with triggerType 'mcp-event' matching the event name (and filter) is started in priority order.",
        options: { codemode: true },
        execute: emitEventExecute as any,
      });
    });

    // Нативный скилл плагина: агент видит краткое описание в списке доступных
    // скиллов и подгружает инструкцию только когда задача действительно про
    // автоматизацию по расписанию. Файлы скилла лежат в пакете (`skills/...`),
    // поэтому ручная установка в `.opencode/skills` не нужна.
    let skillRegistration: { dispose: () => Promise<void> } | undefined;
    try {
      const skill = loadSchedulerSkill();
      if (skill && ctx.skill?.transform) {
        skillRegistration = await ctx.skill.transform((editor) => {
          editor.add({
            id: skill.id as any,
            name: skill.name as any,
            description: skill.description,
            path: skill.path as any,
            content: skill.content,
          });
        });
      }
    } catch (err: any) {
      console.error(
        `[windows-scheduler] Не удалось зарегистрировать скилл "${SCHEDULER_SKILL_ID}": ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }

    // Регистрируем RPC-методы, вызываемые из GUI-панели.
    // Общая логика создания задачи вынесена в schedulerCreateTask, чтобы
    // schedule_task и create_task использовали один и тот же путь.
    const rpcRegistration = await ctx.rpc.register(SchedulerRpc, {
      get_tasks: async () => {
        return { tasks: await collectTasksView() };
      },
      create_task: async (input: unknown) => {
        console.log("[windows-scheduler] create_task input:", input);
        const {
          name,
          schedule,
          prompt,
          retryCount,
          retryDelay,
          qualityGate,
          nextTaskOnSuccess,
          nextTaskOnError,
          dependsOn,
          triggerType,
          watchPath,
          workingDirectory,
          model,
          priority,
          beforeScript,
          afterScript,
          mcpEvent,
          workspaceId,
          allowedTools,
          deniedTools,
          matrix,
          timezone,
          notBefore,
          notAfter,
          runAt,
          delaySeconds,
          session,
          sessionMaxRuns,
        } = input as {
          name: string;
          schedule?: string;
          prompt: string;
          retryCount?: number;
          retryDelay?: number;
          qualityGate?: string;
          nextTaskOnSuccess?: string;
          nextTaskOnError?: string;
          dependsOn?: string[];
          triggerType?: "cron" | "file" | "mcp-event" | "once";
          watchPath?: string;
          workingDirectory?: string;
          model?: string;
          priority?: number;
          beforeScript?: string;
          afterScript?: string;
          mcpEvent?: McpEventTrigger;
          workspaceId?: string;
          allowedTools?: string[];
          deniedTools?: string[];
          matrix?: MatrixConfig;
          timezone?: string;
          notBefore?: string;
          notAfter?: string;
          runAt?: string;
          delaySeconds?: number;
          session?: "new" | "reuse" | "last";
          sessionMaxRuns?: number;
        };
        let effectiveRunAt: string | undefined;
        if (triggerType === "once") {
          const normalized = normalizeOneShotRunAt({ runAt, delaySeconds });
          if (!normalized.ok) {
            return { success: false, message: `Задача "${name}": ${normalized.error}` };
          }
          effectiveRunAt = normalized.runAt;
        }
        let effectiveSession: "new" | "reuse" | "last" = "new";
        if (session !== undefined) {
          const normalizedSession = normalizeSessionMode(session);
          if (!normalizedSession) {
            return { success: false, message: `Задача "${name}": неизвестный режим сессии "${String(session)}".` };
          }
          effectiveSession = normalizedSession;
        }
        if (
          sessionMaxRuns !== undefined &&
          (!Number.isInteger(sessionMaxRuns) || sessionMaxRuns < 1)
        ) {
          return { success: false, message: `Задача "${name}": sessionMaxRuns должен быть целым числом ≥ 1.` };
        }
        const effectiveSessionId =
          effectiveSession === "reuse" ? generateSessionId() : undefined;
        try {
          await schedulerCreateTask(
            name,
            schedule ?? "",
            prompt,
            undefined,
            workingDirectory,
            retryCount,
            retryDelay,
            qualityGate,
            nextTaskOnSuccess,
            nextTaskOnError,
            triggerType,
            watchPath,
            dependsOn,
            model,
            priority,
            beforeScript,
            afterScript,
            mcpEvent,
            workspaceId,
            allowedTools,
            deniedTools,
            matrix,
            undefined,
            "create",
            timezone,
            notBefore,
            notAfter,
            undefined,
            effectiveRunAt,
            effectiveSession,
            effectiveSessionId,
            sessionMaxRuns
          );
          return { success: true, message: `Задача "${name}" успешно создана.` };
        } catch (err: any) {
          const message = err instanceof Error ? err.message : String(err);
          return { success: false, message };
        }
      },
      delete_task: async (input: unknown) => {
        const { name } = input as { name: string };
        try {
          const { removed } = await deleteTaskWithFamily(name);
          return {
            success: true,
            message:
              removed.length > 0
                ? `Матрица "${name}" удалена вместе с ${removed.length} задачами (клоны и агрегатор).`
                : `Задача "${name}" успешно удалена.`,
          };
        } catch (err: any) {
          return { success: false, message: err instanceof Error ? err.message : String(err) };
        }
      },
      cancel_matrix: async (input: unknown) => {
        const { name } = input as { name: string };
        try {
          const result = await cancelMatrixRun(name);
          return {
            success: true,
            message: result.message,
            cancelled: result.cancelled,
          };
        } catch (err: any) {
          return {
            success: false,
            message: err instanceof Error ? err.message : String(err),
            cancelled: [],
          };
        }
      },
      cleanup_matrix_orphans: async () => {
        try {
          const removed = await cleanupOrphanedMatrixTasks();
          return {
            success: true,
            message:
              removed.length > 0
                ? `Удалено осиротевших задач: ${removed.length}.`
                : "Осиротевших задач не найдено.",
            removed,
          };
        } catch (err: any) {
          return {
            success: false,
            message: err instanceof Error ? err.message : String(err),
            removed: [],
          };
        }
      },
      run_task: async (input: unknown) => {
        const { name } = input as { name: string };
        try {
          // Matrix-родитель не выполняется сам: запускаем его клоны (fan-out).
          const definition = (await loadTaskDefinitions()).find(
            (def) => def.name.toLowerCase() === name.trim().toLowerCase()
          );
          if (definition?.matrix) {
            const matrixResult = await runMatrix(definition);
            const total = definition.matrix.workspaceIds.length;
            const message =
              `Матрица "${name}": запущено ${matrixResult.started.length} из ${total}` +
              (matrixResult.skipped.length ? `, пропущено ${matrixResult.skipped.length}` : "") +
              (matrixResult.errors.length ? `. Ошибки: ${matrixResult.errors.join("; ")}` : ".");
            return { success: matrixResult.success, message };
          }
          // Контроль параллелизма: не позволяем запускать новую задачу,
          // если уже running столько же (или больше), сколько maxConcurrent.
          const settings = await loadSettings();
          if (settings.maxConcurrent > 0) {
            const allTasks = await scheduler.listTasks();
            const runningCount = allTasks.filter((t) =>
              /running|выполняется/i.test(t.status ?? "")
            ).length;
            if (runningCount >= settings.maxConcurrent) {
              return {
                success: false,
                message:
                  "Достигнут лимит одновременных задач. Дождитесь завершения текущих.",
              };
            }
          }

          const result = await scheduler.runTask(name);
          // История и метрики пишутся PowerShell-обёрткой (ps-wrapper.ts) при любом запуске,
          // в том числе инициированном из GUI, — дублировать запись здесь не нужно.
          if (result.alreadyRunning) {
            // Мягкое предупреждение: задача уже идёт, это не ошибка запуска.
            return { success: true, message: `Задача "${name}" уже выполняется.` };
          }
          return { success: true, message: `Задача "${name}" запущена.` };
        } catch (err: any) {
          return { success: false, message: `schtasks error: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
      emit_event: async (input: unknown) => {
        const { eventName, payload } = input as {
          eventName?: string;
          payload?: unknown;
        };
        const normalized = eventName?.trim();
        if (!normalized) {
          return { success: false, message: "Не передано имя события (eventName).", triggered: [] };
        }

        // Ищем задачи с MCP-триггером, совпадающим по имени события и фильтру.
        const definitions = await loadTaskDefinitions();
        const matched = definitions
          .filter((def) => (def.triggerType ?? "cron") === "mcp-event")
          .filter(
            (def) =>
              def.mcpEvent?.event?.trim().toLowerCase() === normalized.toLowerCase()
          )
          .filter((def) => matchesEventFilter(def.mcpEvent?.filter, payload))
          .sort(
            (a, b) =>
              (normalizePriority(b.priority) ?? 5) - (normalizePriority(a.priority) ?? 5)
          );

        const triggered: string[] = [];
        for (const def of matched) {
          try {
            await runTaskEntry(def.name);
            triggered.push(def.name);
            console.log(
              `[windows-scheduler] Запуск задачи "${def.name}" по MCP-событию "${normalized}".`
            );
          } catch (err: any) {
            console.error(
              `[windows-scheduler] Не удалось запустить "${def.name}" по событию "${normalized}": ${
                err instanceof Error ? err.message : String(err)
              }`
            );
          }
        }

        return {
          success: true,
          triggered,
          message: `Событие "${normalized}" обработано. Запущено задач: ${triggered.length}.`,
        };
      },
      pause_task: async (input: unknown) => {
        const { name, until } = input as { name: string; until?: string };
        const result = await pauseOrResumeTask(name, true, until);
        return { success: result.success, message: result.message };
      },
      resume_task: async (input: unknown) => {
        const { name } = input as { name: string };
        const result = await pauseOrResumeTask(name, false);
        return { success: result.success, message: result.message };
      },
      update_task: async (input: unknown) => {
        return await updateTaskFromInput(input as UpdateArgs);
      },
      get_task_logs: async (input: unknown) => {
        const { name } = input as { name: string };
        const result = await getTaskLogs(name);
        if (result.error) {
          return { success: false, logs: "", error: result.error };
        }
        return { success: true, logs: result.logs };
      },
      get_history: async (input: unknown) => {
        // Контракт совпадает с агентским инструментом get_history:
        // limit по умолчанию 20 (максимум 200), фильтры taskName и status.
        const { limit, taskName, status } = input as {
          limit?: number;
          taskName?: string;
          status?: string;
        };
        const filter = taskName?.trim().toLowerCase();
        const statusFilter = status?.trim().toLowerCase();
        const max = Math.max(1, Math.min(Math.floor(limit ?? 20), 200));
        const records = (await loadHistory())
          .filter((record) => !filter || record.taskName.toLowerCase() === filter)
          .filter(
            (record) => !statusFilter || String(record.status).toLowerCase() === statusFilter
          );
        return { records: records.slice(0, max) };
      },
      get_metrics: async () => {
        return await loadMetrics();
      },
      cleanup_history: async (input: unknown) => {
        const { retentionDays, maxRecords } = input as {
          retentionDays?: number;
          maxRecords?: number;
        };
        try {
          const report = await runHistoryRetention({ retentionDays, maxRecords });
          const message = report.skipped
            ? report.skipped
            : `Удалено ${report.deleted} записей (по возрасту: ${report.deletedByAge}, по лимиту: ` +
              `${report.deletedByCount}), осталось ${report.kept}.`;
          return {
            success: true,
            message,
            deleted: report.deleted,
            deletedByAge: report.deletedByAge,
            deletedByCount: report.deletedByCount,
            kept: report.kept,
            retentionDays: report.retentionDays,
            maxRecords: report.maxRecords,
            vacuumed: report.vacuumed,
          };
        } catch (err: any) {
          return {
            success: false,
            message: `Не удалось очистить историю: ${
              err instanceof Error ? err.message : String(err)
            }`,
            deleted: 0,
            deletedByAge: 0,
            deletedByCount: 0,
            kept: 0,
            retentionDays: 0,
            maxRecords: 0,
            vacuumed: false,
          };
        }
      },
      get_analytics: async (input: unknown) => {
        const { days, topLimit } = input as { days?: number; topLimit?: number };
        try {
          const windowDays = Math.min(
            365,
            Math.max(1, Math.floor(Number(days) || 14))
          );
          const records = getHistory(null, 20000);
          const definitions = await loadTaskDefinitions();
          const report = buildAnalytics(records, {
            days: windowDays,
            topLimit: Math.max(1, Math.floor(Number(topLimit) || 10)),
            tasks: definitions.map((definition) => ({
              name: definition.name,
              matrixParentId: definition.matrixParentId,
            })),
          });
          return { success: true, report };
        } catch (err: any) {
          return {
            success: false,
            report: null,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },
      get_dashboard_port: async () => {
        return { port: getDashboardPort() };
      },
      get_platform: async () => {
        return { platform: scheduler.platform, title: scheduler.title };
      },
      dry_run: async (input: unknown) => {
        const { taskName } = input as { taskName: string };
        try {
          const report = await simulatePipeline(taskName);
          return { ...report };
        } catch (err: any) {
          return {
            success: false,
            taskName,
            tasks: [],
            totals: { estimatedDurationSec: null, estimatedCostUsd: null, estimatedTokens: null },
            warnings: [],
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },
      dry_run_all: async () => {
        const tasks = await loadTaskDefinitions();
        const reports: any[] = [];
        let allSuccess = true;
        for (const task of tasks) {
          try {
            reports.push(await simulatePipeline(task.name));
          } catch (err: any) {
            allSuccess = false;
            reports.push({
              success: false,
              taskName: task.name,
              tasks: [],
              totals: { estimatedDurationSec: null, estimatedCostUsd: null, estimatedTokens: null },
              warnings: [],
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        return { success: allSuccess, reports };
      },
      get_matrix_results: async (input: unknown) => {
        const { parentId } = input as { parentId?: string; name?: string };
        const target = (parentId ?? "").trim();
        if (!target) {
          return { success: false, error: "Не передан parentId матрицы." };
        }
        try {
          const report = aggregateMatrixResults(target);
          return { success: true, report };
        } catch (err: any) {
          return {
            success: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },
      expand_matrix_preview: async (input: unknown) => {
        const { name, workspaceIds, strategy, failureMode, aggregation } = input as {
          name?: string;
          workspaceIds?: string[];
          strategy?: "parallel" | "sequential";
          failureMode?: "continue" | "stop";
          aggregation?: "summary" | "per-task";
        };
        try {
          const clones = expandMatrixTask({
            name: (name ?? "").trim() || "task",
            schedule: "* * * * *",
            prompt: "preview",
            matrix: {
              workspaceIds: Array.isArray(workspaceIds) ? workspaceIds : [],
              strategy,
              failureMode,
              aggregation,
            },
          });
          return {
            success: true,
            clones: clones.map((clone) => ({
              name: clone.name,
              workspaceId: clone.workspaceId ?? "",
              workspaceName: clone.workspaceId
                ? getWorkspace(clone.workspaceId)?.name ?? null
                : null,
            })),
          };
        } catch (err: any) {
          return {
            success: false,
            clones: [],
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },
      get_workspaces: async () => {
        return {
          workspaces: listWorkspaces().map((workspace) => ({
            ...workspace,
            env: maskEnvForLog(workspace.env),
            gitBranch: readGitBranch(workspace.path) ?? null,
          })),
        };
      },
      add_workspace: async (input: unknown) => {
        try {
          const { name, path: workspacePath, color, env, envFile } = input as {
            name?: string;
            path: string;
            color?: string;
            env?: Record<string, string> | null;
            envFile?: string | null;
          };
          const workspace = addWorkspace({ name, path: workspacePath, color, env, envFile });
          return {
            success: true,
            workspace: {
              ...workspace,
              env: maskEnvForLog(workspace.env),
              gitBranch: readGitBranch(workspace.path) ?? null,
            },
          };
        } catch (err: any) {
          return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
      update_workspace: async (input: unknown) => {
        try {
          const { id, name, path: workspacePath, color, env, envFile } = input as {
            id: string;
            name?: string;
            path?: string;
            color?: string;
            env?: Record<string, string> | null;
            envFile?: string | null;
          };
          const workspace = updateWorkspace(id, { name, path: workspacePath, color, env, envFile });
          if (!workspace) {
            return { success: false, error: "Workspace не найден." };
          }
          // env-файлы существующих задач перегенерируются сразу (Спринт 21).
          await refreshWorkspaceEnvFiles(workspace.id);
          return {
            success: true,
            workspace: {
              ...workspace,
              env: maskEnvForLog(workspace.env),
              gitBranch: readGitBranch(workspace.path) ?? null,
            },
          };
        } catch (err: any) {
          return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
      delete_workspace: async (input: unknown) => {
        try {
          const { id } = input as { id: string };
          const deleted = deleteWorkspace(id);
          return {
            success: deleted,
            message: deleted
              ? "Workspace удалён. Задачи сохранены, привязка очищена."
              : "Workspace не найден.",
          };
        } catch (err: any) {
          return { success: false, message: err instanceof Error ? err.message : String(err) };
        }
      },
      get_profiles: async () => {
        return {
          current: getProfileName(),
          pinnedByEnv: isProfilePinnedByEnv(),
          profiles: listProfiles(),
        };
      },
      set_profile: async (input: unknown) => {
        const { name } = input as { name: string };
        try {
          setActiveProfile(name);
          const current = getProfileName();
          return {
            success: true,
            current,
            restartRequired: true,
            message: isProfilePinnedByEnv()
              ? `Профиль задан переменной OPENCODE_SCHEDULER_PROFILE=${current}. Перезапустите OpenCode, чтобы применить изменения.`
              : `Активный профиль: ${sanitizeProfileName(name)}. Перезапустите OpenCode, чтобы применить изменения.`,
          };
        } catch (err: any) {
          return {
            success: false,
            current: getProfileName(),
            restartRequired: false,
            message: err instanceof Error ? err.message : String(err),
          };
        }
      },
      create_profile: async (input: unknown) => {
        const { name, port } = input as { name: string; port?: number };
        try {
          const meta = createProfile(name, port);
          const profile = listProfiles().find((item) => item.name === meta.name);
          return {
            success: true,
            message: `Профиль "${meta.name}" создан (порт дашборда ${meta.port}).`,
            profile: profile ?? {
              name: meta.name,
              dir: getProfileDir(meta.name),
              port: meta.port,
              isDefault: meta.name === DEFAULT_PROFILE,
              active: meta.name === getProfileName(),
            },
          };
        } catch (err: any) {
          return {
            success: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },
      delete_profile: async (input: unknown) => {
        const { name } = input as { name: string };
        try {
          const removed = deleteProfile(name);
          return {
            success: removed,
            message: removed
              ? `Профиль "${sanitizeProfileName(name)}" удалён вместе с его БД и настройками.`
              : "Профиль не найден.",
          };
        } catch (err: any) {
          return { success: false, message: err instanceof Error ? err.message : String(err) };
        }
      },
      get_settings: async () => {
        return await loadSettings();
      },
      save_settings: async (input: unknown) => {
        const { maxConcurrent, winterMode, notifications, history, integrations } = input as {
          maxConcurrent?: number;
          winterMode?: boolean;
          notifications?: NotificationSettings;
          history?: HistorySettings;
          integrations?: IntegrationSettings;
        };
        const current = await loadSettings();
        if (
          maxConcurrent === undefined &&
          winterMode === undefined &&
          notifications === undefined &&
          history === undefined &&
          integrations === undefined
        ) {
          return {
            success: false,
            maxConcurrent: current.maxConcurrent,
            winterMode: current.winterMode,
            notifications: current.notifications,
            history: current.history,
            integrations: current.integrations,
          };
        }
        const settings = await saveSettings({
          maxConcurrent,
          winterMode,
          notifications,
          history,
          integrations,
        });
        return {
          success: true,
          maxConcurrent: settings.maxConcurrent,
          winterMode: settings.winterMode,
          notifications: settings.notifications,
          history: settings.history,
          integrations: settings.integrations,
        };
      },
      test_notification: async () => {
        return await sendTestNotification();
      },
      send_digest: async () => {
        // Ручная отправка не сдвигает плановое расписание дайджеста.
        return await sendDigestNow({ updateLastSentAt: false });
      },
      get_templates: async () => {
        try {
          return { templates: await loadTemplates() };
        } catch (err: any) {
          console.error("[windows-scheduler] get_templates error:", err);
          return { templates: [] };
        }
      },
      save_template: async (input: unknown) => {
        try {
          const source = input as Partial<TaskTemplate> & {
            name?: string;
            prompt?: string;
          };
          if (!source?.name?.trim() || !source?.prompt?.trim()) {
            return {
              success: false,
              error: "Нужны непустые название шаблона и промпт.",
            };
          }
          const template = await saveTemplate({
            ...source,
            name: source.name,
            prompt: source.prompt,
            triggerType:
              source.triggerType === "file"
                ? "file"
                : source.triggerType === "mcp-event"
                ? "mcp-event"
                : source.triggerType
                ? "cron"
                : undefined,
          });
          return { success: true, template };
        } catch (err: any) {
          return {
            success: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },
      delete_template: async (input: unknown) => {
        const { id } = input as { id?: string };
        if (!id) {
          return { success: false, error: "Не передан id шаблона." };
        }
        try {
          await deleteTemplate(id);
          return { success: true };
        } catch (err: any) {
          return {
            success: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },
      export_tasks: async (input: unknown) => {
        try {
          const tasks = await scheduler.listTasks();
          const exportTasks = tasks.map((t) => ({
            ...t,
            name: t.taskName || "",
          }));
          const { data, count } = await buildExportJson(exportTasks);
          return { success: true, data, count };
        } catch (err: any) {
          return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
      import_tasks: async (input: unknown) => {
        const { data } = input as { data?: string };
        if (!data) {
          return { success: false, error: "Не переданы данные для импорта." };
        }
        try {
          const parsed = parseImportJson(data);
          if (parsed.tasks.length === 0) {
            return {
              success: false,
              error: "В файле нет задач для импорта.",
              errors: parsed.errors,
            };
          }

          const imported: string[] = [];
          const errors: string[] = [...parsed.errors];

          for (const def of parsed.tasks) {
            try {
              await schedulerCreateTask(
                def.name,
                def.schedule,
                def.prompt,
                def.timeoutSeconds,
                def.workingDirectory ?? def.workdir,
                def.retryCount,
                def.retryDelay,
                def.qualityGate,
                def.nextTaskOnSuccess,
                def.nextTaskOnError,
                def.triggerType,
                def.watchPath,
                def.dependsOn,
                def.model,
                def.priority,
                def.beforeScript,
                def.afterScript,
                def.mcpEvent,
                def.workspaceId,
                def.allowedTools,
                def.deniedTools,
                def.matrix,
                def.matrixParentId,
                "create",
                def.timezone,
                def.notBefore,
                def.notAfter,
                def.pausedUntil,
                def.runAt
              );
              await saveTaskDefinition(def);
              imported.push(def.name);
            } catch (err: any) {
              errors.push(`${def.name}: ${err instanceof Error ? err.message : String(err)}`);
            }
          }

          return {
            success: imported.length > 0,
            imported: imported.length,
            errors: errors.length ? errors : undefined,
          };
        } catch (err: any) {
          return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
    });

    // Lifecycle матриц (Спринт 16): при старте вычищаем клоны/агрегаторы,
    // чьи родители были удалены в прошлых сессиях.
    void cleanupOrphanedMatrixTasks().catch((err: any) => {
      console.log(
        `[matrix] Не удалось очистить осиротевшие задачи: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    });

    // Локальный веб-дашборд (Спринт 5): HTTP-сервер на 3782 (фолбэки 4782/5782).
    // Повторный вызов не создаёт второй сервер — защита от двойного запуска
    // реализована внутри startDashboardServer.
    const dashboard = await startDashboardServer({
      getTasks: collectTasksView,
      runTask: (name) => runTaskEntry(name),
      deleteTask: async (name) => {
        await deleteTaskWithFamily(name);
      },
      cancelMatrix: (name) => cancelMatrixRun(name),
      cleanupMatrixOrphans: () => cleanupOrphanedMatrixTasks(),
    });
    if (dashboard) {
      console.log(
        `[windows-scheduler] Открыть дашборд в браузере: http://localhost:${dashboard.port}`
      );
    }

    return () => {
      clearInterval(pausedUntilTimer);
      clearInterval(notificationTimer);
      rpcRegistration.dispose();
      registration.dispose();
      void skillRegistration?.dispose();
      if (fileWatcherManager) void fileWatcherManager.stop();
      // При выгрузке плагина обязательно закрываем HTTP-сервер дашборда,
      // затем соединение SQLite (чекпойнт WAL выполняется в closeDb).
      void closeDashboardServer().finally(() => closeDb());
    };
  },
});

/**
 * Дополнительные настройки матрицы (Спринт 17): matrix.concurrency и
 * matrix.overrides. Валидирует и нормализует, бросая понятные ошибки.
 */
function resolveMatrixExtraConfig(
  name: string,
  matrix: MatrixConfig,
  ids: string[]
): { concurrency?: number; overrides?: Record<string, MatrixWorkspaceOverride> } {
  const extra: {
    concurrency?: number;
    overrides?: Record<string, MatrixWorkspaceOverride>;
  } = {};

  if (matrix.concurrency !== undefined && matrix.concurrency !== null) {
    if (
      typeof matrix.concurrency !== "number" ||
      !Number.isFinite(matrix.concurrency) ||
      matrix.concurrency < 1
    ) {
      throw new Error(
        `Задача "${name}": matrix.concurrency должен быть числом не меньше 1.`
      );
    }
    extra.concurrency = Math.floor(matrix.concurrency);
  }

  if (matrix.overrides) {
    const allowed = new Set(ids);
    const overrides: Record<string, MatrixWorkspaceOverride> = {};
    for (const [key, value] of Object.entries(matrix.overrides)) {
      const workspaceKey = key.trim();
      if (!allowed.has(workspaceKey)) {
        throw new Error(
          `Задача "${name}": matrix.overrides содержит workspace "${workspaceKey}", ` +
            `которого нет в workspaceIds.`
        );
      }
      if (!value || typeof value !== "object") continue;
      const override: MatrixWorkspaceOverride = {};
      for (const field of [
        "prompt",
        "model",
        "qualityGate",
        "beforeScript",
        "afterScript",
      ] as const) {
        const raw = (value as Record<string, unknown>)[field];
        if (typeof raw === "string" && raw.trim()) override[field] = raw.trim();
      }
      if (Object.keys(override).length > 0) overrides[workspaceKey] = override;
    }
    if (Object.keys(overrides).length > 0) extra.overrides = overrides;
  }

  return extra;
}

/**
 * Общая логика создания задачи: используется и schedule_task (инструмент),
 * и create_task (RPC-метод для GUI).
 */
async function schedulerCreateTask(
  name: string,
  schedule: string,
  prompt: string,
  timeoutSeconds?: number,
  workingDirectory?: string,
  retryCount?: number,
  retryDelay?: number,
  qualityGate?: string,
  nextTaskOnSuccess?: string,
  nextTaskOnError?: string,
  triggerType?: "cron" | "file" | "mcp-event" | "once",
  watchPath?: string,
  dependsOn?: string[],
  model?: string,
  priority?: number,
  beforeScript?: string,
  afterScript?: string,
  mcpEvent?: McpEventTrigger,
  workspaceId?: string,
  allowedTools?: string[],
  deniedTools?: string[],
  matrix?: MatrixConfig,
  matrixParentId?: string,
  /** create — пересоздать клонов с нуля; sync — только diff (Спринт 17). */
  matrixMode: "create" | "sync" = "create",
  /** IANA-зона задачи (Спринт 19). Не системная зона → poll-режим шлюза. */
  timezone?: string,
  /** Окно запуска: начало "HH:MM" (вне окна запуск переносится). */
  notBefore?: string,
  /** Окончание окна "HH:MM"; может быть меньше notBefore (через полночь). */
  notAfter?: string,
  /** Пауза до момента ISO; после него задача возобновляется автоматически. */
  pausedUntil?: string,
  /** Абсолютное время однократного запуска (ISO, только triggerType=once). */
  runAt?: string,
  /** Режим сессии OpenCode (Спринт 24): new (по умолчанию), reuse, last. */
  session?: "new" | "reuse" | "last",
  /** ID сессии для reuse (генерируется автоматически; пользователь не задаёт). */
  sessionId?: string,
  /** Сколько запусков переживает reuse-сессия до ротации (0/undefined — без ограничения). */
  sessionMaxRuns?: number
): Promise<void> {
  const normalizedModel = model?.trim() || undefined;
  const normalizedPriority = normalizePriority(priority);
  const normalizedBefore = beforeScript?.trim() || undefined;
  const normalizedAfter = afterScript?.trim() || undefined;
  const normalizedTz = timezone?.trim() || undefined;
  const normalizedNotBefore = notBefore?.trim() || undefined;
  const normalizedNotAfter = notAfter?.trim() || undefined;
  const normalizedPausedUntil = pausedUntil?.trim() || undefined;
  const normalizedMcpEvent =
    mcpEvent && mcpEvent.event?.trim()
      ? {
          server: mcpEvent.server?.trim() || "",
          event: mcpEvent.event.trim(),
          ...(mcpEvent.filter?.trim() ? { filter: mcpEvent.filter.trim() } : {}),
        }
      : undefined;
  let effectiveTriggerType = triggerType ?? "cron";
  // One-shot: нормализуем время до создания файлов и задачи в ОС.
  // Для остальных триггеров runAt не имеет смысла и отбрасывается.
  let effectiveRunAt: string | undefined;
  if (effectiveTriggerType === "once") {
    const normalized = normalizeOneShotRunAt({ runAt });
    if (!normalized.ok) {
      throw new Error(`Задача "${name}": ${normalized.error}`);
    }
    effectiveRunAt = normalized.runAt;
  }
  // Спринт 24: режим сессии. sessionId генерируется автоматически для reuse;
  // значение пользователя никогда не принимаем.
  let effectiveSession: "new" | "reuse" | "last" = "new";
  let effectiveSessionId: string | undefined;
  if (session !== undefined) {
    const normalizedSession = normalizeSessionMode(session);
    if (!normalizedSession) {
      throw new Error(`Задача "${name}": неизвестный режим сессии "${String(session)}".`);
    }
    effectiveSession = normalizedSession;
  }
  if (effectiveSession === "reuse") {
    effectiveSessionId = sessionId?.trim() || generateSessionId();
  }
  // Role-scoped: нормализуем списки инструментов (trim, дедуп без регистра).
  // Пустой allowedTools — осознанная блокировка: «белый список из нуля
  // инструментов» это почти наверняка ошибка конфигурации.
  const normalizeToolList = (raw?: string[]): string[] | undefined => {
    if (!Array.isArray(raw)) return undefined;
    const cleaned = Array.from(
      new Map(
        raw
          .filter((t): t is string => typeof t === "string")
          .map((t) => t.trim())
          .filter(Boolean)
          .map((t) => [t.toLowerCase(), t] as const)
      ).values()
    );
    return cleaned.length > 0 ? cleaned : undefined;
  };
  if (Array.isArray(allowedTools) && allowedTools.filter((t) => typeof t === "string" && t.trim()).length === 0) {
    throw new Error(
      `Задача "${name}": пустой allowedTools запрещён — задайте список инструментов или уберите поле.`
    );
  }
  const normalizedAllowedTools = normalizeToolList(allowedTools);
  const normalizedDeniedTools = normalizeToolList(deniedTools);

  // Matrix (fan-out, Спринт 15): валидируем до создания файлов, чтобы не
  // оставить «полу-созданную» задачу. Родитель сам не выполняется — он шаблон.
  let normalizedMatrix: MatrixConfig | undefined;
  if (matrix) {
    if (workspaceId?.trim()) {
      throw new Error(
        `Задача "${name}": нельзя одновременно workspaceId и matrix.workspaceIds.`
      );
    }
    const ids = Array.from(
      new Set(
        (Array.isArray(matrix.workspaceIds) ? matrix.workspaceIds : [])
          .filter((id): id is string => typeof id === "string")
          .map((id) => id.trim())
          .filter(Boolean)
      )
    );
    if (ids.length === 0) {
      throw new Error(`Задача "${name}": matrix.workspaceIds не может быть пустым.`);
    }
    for (const id of ids) {
      const ws = getWorkspace(id);
      if (!ws) {
        throw new Error(`Задача "${name}": workspace "${id}" не найден.`);
      }
      try {
        validateWorkspacePath(ws.path);
      } catch {
        throw new Error(
          `Задача "${name}": workspace "${ws.name}" недоступен по пути "${ws.path}".`
        );
      }
    }
    normalizedMatrix = {
      workspaceIds: ids,
      strategy: matrix.strategy === "sequential" ? "sequential" : "parallel",
      failureMode: matrix.failureMode === "stop" ? "stop" : "continue",
      aggregation: matrix.aggregation === "per-task" ? "per-task" : "summary",
      ...(matrix.createAggregator ? { createAggregator: true } : {}),
      ...resolveMatrixExtraConfig(name, matrix, ids),
    };
  }

  // Matrix-родитель и её клоны регистрируются как ручные задачи (ONCE 2099):
  // клоны стартует только runMatrix(), иначе cron запускал бы их независимо.
  if (normalizedMatrix || matrixParentId) {
    effectiveTriggerType = "file";
  }

  // MCP-триггер без имени события бессмыслен — валидируем до создания файлов.
  if (effectiveTriggerType === "mcp-event" && !normalizedMcpEvent) {
    throw new Error("Для MCP-триггера нужно указать имя события (mcpEvent.event).");
  }
  // Валидируем cron-выражение до создания файлов. Для file/mcp-event
  // расписание не используется вовсе.
  if (effectiveTriggerType === "cron") {
    try {
      // Расширенная грамматика (Спринт 19): диапазоны, списки, шаги,
      // имена месяцев/дней, @every, L и FRI#3.
      parseCron(schedule);
    } catch (err: any) {
      throw new Error(err.message || String(err));
    }
    if (normalizedTz && !isValidIanaTimeZone(normalizedTz)) {
      throw new Error(
        `Задача "${name}": неизвестный часовой пояс "${normalizedTz}". ` +
          `Укажите IANA-зону, например Europe/Moscow.`
      );
    }
    const windowError = validateLaunchWindow(
      normalizedNotBefore,
      normalizedNotAfter
    );
    if (windowError) {
      throw new Error(`Задача "${name}": ${windowError}`);
    }
  }

  const sanitized = sanitizeName(name);
  const lockFile = lockFilePath(sanitized);
  const logFile = path.join(LOG_DIR, `${sanitized}.log`);
  // Шлюз расписания (Спринт 19): нужен только для cron в poll-режиме
  // (нестандартный cron или чужая IANA-зона) либо при окне запуска.
  const gate =
    effectiveTriggerType === "cron"
      ? buildScheduleGate(
          schedule,
          normalizedTz,
          normalizedNotBefore,
          normalizedNotAfter
        )
      : undefined;
  const wrapperGate = gate
    ? {
        ...gate,
        gateFile: gatePath,
        deferFile: `${lockFile}.defer`,
        forceFile: `${lockFile}.force`,
      }
    : undefined;
  // Workspace имеет приоритет над workingDirectory: одна задача = один repo
  // = один cwd. Мы не угадываем, куда мержить, и не смешиваем контексты.
  const normalizedWorkspaceId = workspaceId?.trim() || undefined;
  const workspace = normalizedWorkspaceId ? getWorkspace(normalizedWorkspaceId) : undefined;
  if (normalizedWorkspaceId && !workspace) {
    throw new Error(`Workspace '${normalizedWorkspaceId}' не найден.`);
  }
  if (workspace) {
    try {
      validateWorkspacePath(workspace.path);
    } catch {
      throw new Error(`Workspace '${workspace.name}' недоступен по пути '${workspace.path}'`);
    }
    if (workingDirectory?.trim() && workingDirectory.trim() !== workspace.path) {
      console.warn(
        `[workspace] Задача "${name}": workingDirectory "${workingDirectory.trim()}" ` +
          `игнорируется, cwd = workspace "${workspace.name}" (${workspace.path}).`
      );
    }
  }
  const effectiveWorkingDirectory =
    workspace?.path || workingDirectory?.trim() || projectDirectory || process.cwd();

  // Спринт 21: env-переменные workspace → отдельный файл, который читает обёртка.
  // Значения не логируются; в лог попадает только факт загрузки.
  const taskEnvFile = writeWorkspaceEnvFile(workspace, PLUGIN_DIR, sanitized);
  if (taskEnvFile) {
    console.log(`[workspace] Задача "${name}": env-переменные workspace подключены.`);
  }

  let promptFile: string;
  try {
    promptFile = await writePromptFile(sanitized, prompt);
    await fs.mkdir(LOG_DIR, { recursive: true });
    await fs.writeFile(logFile, "", "utf8");
  } catch (err: any) {
    throw new Error(`Не удалось подготовить файлы задачи: ${err.message || String(err)}`);
  }

  // Обёртка зависит от платформы:
  //  - Windows: .cmd → PowerShell-скрипт (lock, таймаут, метрики);
  //  - Linux/macOS: .sh с тем же набором гарантий.
  let wrapperPath: string;
  try {
    if (scheduler.platform === "win32") {
      await ensureWrapper();
      wrapperPath = await writeWrapperCmd(
        sanitized,
        name,
        promptFile,
        timeoutSeconds ?? 3600,
        lockFile,
        effectiveWorkingDirectory,
        logFile,
        recorderPath,
        qualityGate,
        normalizedModel,
        normalizedBefore,
        normalizedAfter,
        workspace?.name,
        normalizedAllowedTools,
        normalizedDeniedTools,
        wrapperGate,
        taskEnvFile,
        effectiveSession,
        effectiveSessionId
      );
    } else {
      wrapperPath = await writeBashWrapper({
        sanitizedName: sanitized,
        taskName: name,
        promptFile,
        timeoutSeconds: timeoutSeconds ?? 3600,
        lockFile,
        workdir: effectiveWorkingDirectory,
        logFile,
        recorderFile: recorderPath,
        qualityGate,
        model: normalizedModel,
        beforeScript: normalizedBefore,
        afterScript: normalizedAfter,
        workspaceName: workspace?.name,
        allowedTools: normalizedAllowedTools,
        deniedTools: normalizedDeniedTools,
        scheduleGate: wrapperGate,
        envFile: taskEnvFile,
        sessionMode: effectiveSession,
        sessionId: effectiveSessionId,
        ...(effectiveTriggerType === "once" && scheduler.platform === "darwin"
          ? { oneShotCleanupCommand: buildLaunchdOneShotCleanup(sanitized) }
          : {}),
      });
    }
  } catch (err: any) {
    throw new Error(`Не удалось создать обёртку задачи: ${err.message || String(err)}`);
  }

  try {
    // Бэкенд сам преобразует cron в родное расписание ОС.
    await scheduler.createTask({
      name,
      command: wrapperPath,
      schedule,
      timeoutSeconds: timeoutSeconds ?? 3600,
      triggerType: effectiveTriggerType,
      ...(effectiveRunAt ? { runAt: effectiveRunAt } : {}),
      workingDirectory: effectiveWorkingDirectory,
      logFile,
      model: normalizedModel,
      priority: normalizedPriority,
      timezone: normalizedTz,
      notBefore: normalizedNotBefore,
      notAfter: normalizedNotAfter,
    });
  } catch (err: any) {
    throw new Error(err instanceof Error ? err.message : String(err));
  }

  // Сохраняем определение задачи для последующего экспорта/импорта.
  // Определение до перезаписи: нужно и для очереди матрицы, и для счётчика сессии.
  const previousDefinition = getTask(name);
  const existingQueue =
    matrixMode === "sync" ? previousDefinition?.matrixQueue : undefined;
  const taskDefinition: TaskDefinition = {
    name,
    schedule,
    prompt,
    timeoutSeconds,
    model: normalizedModel,
    priority: normalizedPriority,
    beforeScript: normalizedBefore,
    afterScript: normalizedAfter,
    mcpEvent: normalizedMcpEvent,
    workingDirectory: workspace ? undefined : workingDirectory?.trim() || undefined,
    workspaceId: workspace?.id,
    retryCount,
    retryDelay,
    qualityGate,
    nextTaskOnSuccess,
    nextTaskOnError,
    triggerType: effectiveTriggerType,
    runAt: effectiveRunAt,
    // Спринт 24: сессия. sessionRunCount не экспортируется (internal).
    session: effectiveSession,
    sessionId: effectiveSessionId,
    sessionMaxRuns,
    // Раньше редактирование всегда сбрасывало счётчик в 0, из-за чего лимит
    // sessionMaxRuns обходился правкой любого поля задачи. Сохраняем счётчик,
    // только если сессия и её id не изменились.
    sessionRunCount: preservedSessionRunCount(
      previousDefinition,
      effectiveSession,
      effectiveSessionId
    ),
    watchPath: normalizedMatrix ? undefined : watchPath,
    timezone: normalizedTz,
    notBefore: normalizedNotBefore,
    notAfter: normalizedNotAfter,
    pausedUntil: normalizedPausedUntil,
    allowedTools: normalizedAllowedTools,
    deniedTools: normalizedDeniedTools,
    matrix: normalizedMatrix,
    isMatrixParent: normalizedMatrix ? true : undefined,
    matrixParentId,
    // Очередь concurrency-лимита переживает обновление определения.
    ...(existingQueue && existingQueue.length > 0
      ? { matrixQueue: existingQueue }
      : {}),
    dependsOn:
      Array.isArray(dependsOn) && dependsOn.length > 0
        ? Array.from(
            new Set(
              dependsOn
                .filter((dep): dep is string => typeof dep === "string")
                .map((dep) => dep.trim())
                .filter(Boolean)
            )
          )
        : undefined,
  };
  try {
    await saveTaskDefinition(taskDefinition);
  } catch {
    // Не критично — основная задача уже создана.
  }

  // Matrix (fan-out): создаём клоны по workspace и, при необходимости,
  // виртуальную задачу matrix-complete, которая запускается DAG-движком.
  // Спринт 17: при обновлении (matrixMode === "sync") клоны не пересоздаются
  // с нуля, а синхронизируются с новым определением; выполняющиеся — не трогаем.
  if (normalizedMatrix) {
    const createClone = async (clone: TaskDefinition): Promise<void> => {
      await schedulerCreateTask(
        clone.name,
        clone.schedule,
        clone.prompt,
        clone.timeoutSeconds,
        undefined,
        clone.retryCount,
        clone.retryDelay,
        clone.qualityGate,
        undefined,
        undefined,
        "file",
        undefined,
        undefined,
        clone.model,
        clone.priority,
        clone.beforeScript,
        clone.afterScript,
        undefined,
        clone.workspaceId,
        clone.allowedTools,
        clone.deniedTools,
        undefined,
        name,
        "create",
        clone.timezone,
        clone.notBefore,
        clone.notAfter,
        clone.pausedUntil
      );
    };

    const removeChild = async (child: string): Promise<void> => {
      try {
        await scheduler.deleteTask(child);
      } catch {
        // Старого клона могло уже не быть в планировщике.
      }
      try {
        await removeTaskDefinition(child);
      } catch {
        // Не критично.
      }
    };

    // Создаёт/обновляет/удаляет matrix-complete по текущему определению.
    const syncAggregator = async (): Promise<string | undefined> => {
      const aggregatorName = matrixCompleteName(name);
      if (!normalizedMatrix.createAggregator) {
        if (getTask(aggregatorName)) await removeChild(aggregatorName);
        return undefined;
      }
      const cloneNames = listMatrixClones(name).map((clone) => clone.name);
      if (cloneNames.length === 0) return undefined;
      await schedulerCreateTask(
        aggregatorName,
        schedule,
        `Матрица "${name}" завершена. Проверь результаты клонов: ` +
          `${cloneNames.join(", ")}.`,
        timeoutSeconds,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "file",
        undefined,
        cloneNames,
        normalizedModel,
        normalizedPriority
      );
      return aggregatorName;
    };

    if (matrixMode === "sync") {
      const syncResult = await syncMatrixFamily(taskDefinition, {
        removeChild,
        createChild: createClone,
        updateChild: createClone,
        syncAggregator,
      });
      if (syncResult.warnings.length > 0) {
        console.log(`[matrix] ${name}: ${syncResult.warnings.join(" ")}`);
      }
      if (
        syncResult.created.length > 0 ||
        syncResult.updated.length > 0 ||
        syncResult.removed.length > 0
      ) {
        console.log(
          `[matrix] ${name}: синхронизация — создано ${syncResult.created.length}, ` +
            `обновлено ${syncResult.updated.length}, удалено ${syncResult.removed.length}, ` +
            `занято ${syncResult.running.length}`
        );
      }
    } else {
      for (const child of removeMatrixChildren(name)) {
        await removeChild(child);
      }
      const clones = expandMatrixTask(taskDefinition);
      for (const clone of clones) {
        await createClone(clone);
      }
      await syncAggregator();
    }
  }
}

/**
 * Запуск задачи «как есть», но с учётом матрицы: родитель раскладывается
 * на клоны, а не выполняет свой промпт.
 */
async function runTaskEntry(name: string): Promise<{ alreadyRunning: boolean }> {
  const definition = (await loadTaskDefinitions()).find(
    (def) => def.name.toLowerCase() === name.trim().toLowerCase()
  );
  if (definition?.matrix) {
    await runMatrix(definition);
    return { alreadyRunning: false };
  }

  // Любой запуск через этот вход — «сейчас», а не «по расписанию»:
  // run_task_now, RPC GUI, файловый триггер, MCP-событие и catch-up.
  // Маркер снимает проверку cron/окна внутри обёртки (poll-режим), иначе
  // запуск молча отменялся бы schedule-gate с кодом 3.
  const forceFile = await requestImmediateRun(name);
  try {
    return await scheduler.runTask(name);
  } catch (err) {
    // Планировщик не принял запуск — маркер не нужен, иначе он мог бы
    // «разрешить» следующий плановый тик в обход расписания.
    await fs.unlink(forceFile).catch(() => {
      /* не критично */
    });
    throw err;
  }
}

/**
 * Собирает задачи плагина в формате, который отдают оба потребителя:
 * RPC get_tasks (GUI) и инструмент list_tasks (агент).
 */
async function collectTasksView() {
  const tasks = await scheduler.listTasks();

  // Читаем историю один раз, чтобы определить финальный статус по последней записи.
  const history = await loadHistory();
  // loadHistory() отдаёт записи от новых к старым; helper оставляет самую свежую.
  const lastByTask = latestHistoryByTask(history);

  // Читаем определения задач один раз (расписание, повторы, цепочки, директория).
  const defs = await loadTaskDefinitions();
  const workspaces = listWorkspaces();
  const workspaceById = new Map(workspaces.map((workspace) => [workspace.id, workspace]));

  // Счётчики запусков по задачам. Основной источник — таблица metrics
  // (накопительные итоги, не зависят от retention истории). Для задач, у
  // которых метрик ещё нет, считаем по загруженной истории.
  const metricsByName = new Map(
    getAllMetrics(true).map((row) => [row.taskName.toLowerCase(), row])
  );
  const historyCounts = new Map<string, { total: number; success: number; error: number }>();
  for (const record of history) {
    const key = record.taskName.toLowerCase();
    const counts = historyCounts.get(key) ?? { total: 0, success: 0, error: 0 };
    counts.total += 1;
    if (record.status === "success") counts.success += 1;
    else counts.error += 1;
    historyCounts.set(key, counts);
  }

  // ОС-планировщик — источник истины о запуске, но определения в БД могут
  // существовать без задачи в ОС (сбой удаления, миграция, ручная чистка).
  // Показываем и их, помечая orphaned: раньше такие задачи были невидимы
  // для list_tasks, хотя dry_run/история их видели.
  const osNames = new Set(tasks.map((t) => (t.taskName || "").toLowerCase()));
  const orphanNames = defs
    .filter((def) => !osNames.has(def.name.toLowerCase()))
    .map((def) => def.name);
  const sources: Array<{ task: (typeof tasks)[number]; orphaned: boolean }> = [
    ...tasks.map((task) => ({ task, orphaned: false })),
    ...orphanNames.map((name) => ({
      task: { taskName: name } as (typeof tasks)[number],
      orphaned: true,
    })),
  ];

  return sources.map(({ task: t, orphaned }) => {
    // Все бэкенды возвращают короткие имена (без папки планировщика).
    const name = t.taskName || "";

    // Приоритет 1: статус, который сообщает планировщик ОС.
    let status = mapStatus(t.status);

    // Приоритет 2: если последняя запись в истории — error/timeout, перебиваем на error.
    const last = lastByTask.get(name.toLowerCase());
    if (last) {
      if (last.status === "error" || last.status === "timeout") status = "error";
      else if (last.status === "success") status = "success";
      // partial раньше терялся: задача после частичного запуска выглядела
      // как «готова»/«не запускалась», хотя запуск был неуспешным.
      else if (last.status === "partial") status = "partial";
    }

    const def = defs.find((d) => d.name.toLowerCase() === name.toLowerCase());
    const workspace = def?.workspaceId ? workspaceById.get(def.workspaceId) : undefined;

    // Matrix-родитель: статус = агрегат по клонам (success/error/partial/running).
    const matrixAggregate = def?.matrix ? aggregateMatrixResults(name) : null;
    if (matrixAggregate && matrixAggregate.status !== "empty") {
      status = matrixAggregate.status === "running" ? "running" : matrixAggregate.status;
    }

    // Счётчики именно этой задачи (раньше GUI показывал на каждой карточке
    // общие итоги по всем задачам — отсюда одинаковые 201/130/71).
    const metricsRow = metricsByName.get(name.toLowerCase());
    const counts = metricsRow
      ? { total: metricsRow.total, success: metricsRow.success, error: metricsRow.error }
      : historyCounts.get(name.toLowerCase()) ?? { total: 0, success: 0, error: 0 };

    return {
      name,
      schedule: def?.schedule ?? "",
      status,
      orphaned,
      // Спринт 24 (фикс): явный признак паузы. Раньше GUI пытался вывести его
      // из текстового статуса, но mapStatus() превращает "disabled" в "unknown",
      // поэтому кнопка «возобновить» была недоступна.
      paused: Boolean(t.paused),
      runsTotal: counts.total,
      runsSuccess: counts.success,
      runsError: counts.error,
      // Для разовой задачи показываем запланированное время, а не пустое расписание.
      nextRun: def?.triggerType === "once"
        ? def?.runAt ?? (t.nextRunTime ? String(t.nextRunTime) : null)
        : t.nextRunTime ? String(t.nextRunTime) : null,
      runAt: def?.runAt ?? null,
      session: def?.session ?? "new",
      sessionId: def?.sessionId ?? null,
      sessionMaxRuns: def?.sessionMaxRuns ?? null,
      sessionRunCount: def?.sessionRunCount ?? 0,
      model: def?.model ?? null,
      priority: def?.priority ?? 5,
      beforeScript: def?.beforeScript ?? null,
      afterScript: def?.afterScript ?? null,
      mcpEvent: def?.mcpEvent ?? null,
      retryCount: def?.retryCount ?? 0,
      retryDelay: def?.retryDelay ?? 0,
      qualityGate: def?.qualityGate ?? null,
      nextTaskOnSuccess: def?.nextTaskOnSuccess ?? null,
      nextTaskOnError: def?.nextTaskOnError ?? null,
      dependsOn: Array.isArray(def?.dependsOn) ? def.dependsOn : [],
      triggerType: def?.triggerType ?? "cron",
      watchPath: def?.watchPath ?? null,
      timezone: def?.timezone ?? null,
      notBefore: def?.notBefore ?? null,
      notAfter: def?.notAfter ?? null,
      pausedUntil: def?.pausedUntil ?? null,
      workingDirectory: workspace?.path ?? def?.workingDirectory ?? def?.workdir ?? null,
      workspaceId: workspace?.id ?? def?.workspaceId ?? null,
      workspaceName: workspace?.name ?? null,
      workspaceColor: workspace?.color ?? null,
      allowedTools: Array.isArray(def?.allowedTools) ? def.allowedTools : null,
      deniedTools: Array.isArray(def?.deniedTools) ? def.deniedTools : null,
      matrix: def?.matrix ?? null,
      matrixParentId: def?.matrixParentId ?? null,
      isMatrixParent: Boolean(def?.matrix),
      matrixSummary: matrixAggregate
        ? {
            totalCount: matrixAggregate.totalCount,
            successCount: matrixAggregate.successCount,
            errorCount: matrixAggregate.errorCount,
            pendingCount: matrixAggregate.pendingCount,
            status: matrixAggregate.status,
            message: matrixAggregate.message,
          }
        : null,
      prompt: def?.prompt ?? "",
    };
  });
}

/**
 * Проверяет фильтр MCP-события.
 *
 * Поддерживаются два формата:
 *  - `key=value` — сравнивается с верхнеуровневым полем payload (регистр значения важен);
 *  - regex/подстрока — проверяется по сериализованному payload (без учёта регистра).
 * Пустой фильтр пропускает любое событие.
 */
function matchesEventFilter(filter: string | undefined, payload: unknown): boolean {
  const raw = (filter ?? "").trim();
  if (!raw) return true;

  let text: string;
  try {
    text = JSON.stringify(payload ?? {});
  } catch {
    text = String(payload ?? "");
  }

  const pair = /^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(raw);
  if (pair && payload !== null && typeof payload === "object") {
    const fieldValue = (payload as Record<string, unknown>)[pair[1]];
    const expected = pair[2].trim().replace(/^["']|["']$/g, "");
    return String(fieldValue ?? "") === expected;
  }

  try {
    return new RegExp(raw, "i").test(text);
  } catch {
    return text.toLowerCase().includes(raw.toLowerCase());
  }
}

/** Превращает текстовый статус планировщика в короткий статус для GUI. */
function mapStatus(status?: string): string {
  if (!status) return "unknown";
  const s = status.toLowerCase();
  if (s.includes("running") || s.includes("выполняется")) return "running";
  // "Ready" в планировщике Windows означает лишь «готова к запуску», а не
  // успешное выполнение. Раньше такие задачи показывались зелёными, хотя
  // могли ни разу не запускаться.
  if (s.includes("ready") || s.includes("готов")) return "idle";
  if (s.includes("disabled")) return "unknown";
  return "unknown";
}
