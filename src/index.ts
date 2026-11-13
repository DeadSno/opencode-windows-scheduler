import { Plugin, Rpc } from "@opencode/plugin";
import { z } from "zod";
import { Tool } from "@opencode/schema/tool";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { LockManager } from "./core/lock.js";
import { LOCK_DIR, LOG_DIR, PLUGIN_DIR, sanitizeName } from "./types.js";
import { convertCronToSchTasks, previousRunTime } from "./core/cron-to-schtasks.js";
import { ensureWrapper, writePromptFile, writeWrapperCmd, lockFilePath } from "./core/ps-wrapper.js";
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
import { loadHistory, loadMetrics } from "./history.js";
import { loadSettings, saveSettings } from "./settings.js";
import type { NotificationSettings } from "./settings.js";
import { sendTestNotification } from "./notifications.js";
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
import { closeDb, initDb } from "./db/index.js";
import { migrateJsonToDb } from "./db/migrate.js";
import { checkJsonBackups, recoverInterruptedRuns } from "./db/recovery.js";
import { getTask, listMatrixClones } from "./db/tasks-repo.js";
import {
  addWorkspace,
  deleteWorkspace,
  getWorkspace,
  listWorkspaces,
  updateWorkspace,
  validateWorkspacePath,
  readGitBranch,
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
    .describe(
      "5-field cron expression (minute hour day-of-month month day-of-week). Supported patterns: * * * * *, */N * * * *, M H * * *, M H * * D."
    ),
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
    .enum(["cron", "file", "mcp-event"])
    .optional()
    .describe("Trigger type: cron (default), file or mcp-event."),
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
    .describe("New 5-field cron expression. Keeps the current value when omitted."),
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
    .enum(["cron", "file", "mcp-event"])
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
});

const pauseTaskSchema = z.object({
  name: z.string().describe("Task name to pause."),
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
});

export const matrixControlSchema = z.object({
  action: z
    .enum(["results", "cancel", "cleanup"])
    .describe(
      "results — aggregate status of a matrix; cancel — cancel pending clones; cleanup — delete orphaned clones and aggregators."
    ),
  name: z
    .string()
    .optional()
    .describe("Matrix parent name (required for results and cancel)."),
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
    workingDirectory,
    workspaceId,
    allowedTools,
    deniedTools,
    matrix,
  } = args;

  try {
    await schedulerCreateTask(
      name,
      schedule,
      prompt,
      timeoutSeconds,
      workingDirectory,
      retryCount,
      retryDelay,
      qualityGate,
      nextTaskOnSuccess,
      nextTaskOnError,
      triggerType,
      undefined,
      dependsOn,
      model,
      priority,
      beforeScript,
      afterScript,
      mcpEvent,
      workspaceId,
      allowedTools,
      deniedTools,
      matrix
    );
  } catch (err: any) {
    return {
      content: JSON.stringify({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      }),
    };
  }

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
        definition.name
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
): Promise<{ removed: string[] }> {
  const trimmed = name.trim();
  const guard = getMatrixDeletionGuard(trimmed);
  if (guard) throw new Error(guard);

  const plan = planMatrixFamilyDelete(trimmed);
  const removed: string[] = [];

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

  return { removed };
}

/** delete_task — удаление задачи по имени (/f) */
const deleteTaskExecute = wrapExecute<DeleteArgs>(async (args) => {
  const { name } = args;

  try {
    const { removed } = await deleteTaskWithFamily(name);
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
    const result = await scheduler.runTask(name);
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

  const matrixWas = previous.matrix;
  const matrixNext =
    input.matrix === undefined ? matrixWas : input.matrix ?? undefined;

  try {
    // Обновление = пересоздание в планировщике с сохранением старых значений.
    await scheduler.deleteTask(name);
    await schedulerCreateTask(
      name,
      schedule ?? "* * * * *",
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
      matrixWas && matrixNext ? "sync" : "create"
    );

    // Матрица отключена при обновлении — убираем клонов и агрегатор.
    if (matrixWas && !matrixNext) {
      await removeMatrixChildrenFromScheduler(name);
    }

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
  paused: boolean
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

  const verb = paused ? "поставлена на паузу" : "возобновлена";
  const message = definition.matrix
    ? `Матрица "${trimmed}" ${verb}: ${affected.length} из ${targets.length} клонов.` +
      (warnings.length > 0 ? ` Ошибки: ${warnings.join("; ")}.` : "")
    : `Задача "${trimmed}" ${verb}.` +
      (warnings.length > 0 ? ` Ошибка: ${warnings.join("; ")}.` : "");

  return {
    success: warnings.length === 0,
    message,
    affected,
    warnings,
  };
}

const pauseTaskExecute = wrapExecute<PauseArgs>(async (args) => {
  const result = await pauseOrResumeTask(args.name, true);
  return { content: JSON.stringify(result) };
});

const resumeTaskExecute = wrapExecute<ResumeArgs>(async (args) => {
  const result = await pauseOrResumeTask(args.name, false);
  return { content: JSON.stringify(result) };
});

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

/** manage_workspaces — CRUD multi-repo workspace-ов. */
const manageWorkspacesExecute = wrapExecute<WorkspacesArgs>(async (args) => {
  try {
    switch (args.action) {
      case "list": {
        const workspaces = listWorkspaces().map((workspace) => ({
          ...workspace,
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
        });
        return {
          content: JSON.stringify({
            success: true,
            workspace: {
              ...workspace,
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
        });
        if (!workspace) {
          return {
            content: JSON.stringify({
              success: false,
              error: "Workspace не найден.",
            }),
          };
        }
        return {
          content: JSON.stringify({
            success: true,
            workspace: {
              ...workspace,
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

/** matrix_control — результаты, отмена и очистка матриц. */
const matrixControlExecute = wrapExecute<MatrixControlArgs>(async (args) => {
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
          const prevRun = previousRunTime(def.schedule, now);
          if (!prevRun) continue;
          const ageMs = now.getTime() - prevRun.getTime();
          if (ageMs < catchUpThresholdMs) continue;

          // Есть ли запись в истории после предполагаемого времени запуска?
          const ranAfter = history.some(
            (r) =>
              r.taskName.toLowerCase() === def.name.toLowerCase() &&
              new Date(r.startedAt).getTime() >= prevRun.getTime()
          );
          if (ranAfter) continue;

          // Запускаем задачу и пишем в лог.
          try {
            await scheduler.runTask(def.name);
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
    const fileWatcherManager = new FileWatchManager(async (taskName) => {
      try {
        await scheduler.runTask(taskName);
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
    void fileWatcherManager.refresh();

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
          "Matrix lifecycle: results (aggregate status/counters of a matrix), cancel (cancel pending clones, stop running ones) or cleanup (delete orphaned clones and aggregators whose parent is gone).",
        options: { codemode: true },
        execute: matrixControlExecute as any,
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
        } = input as {
          name: string;
          schedule: string;
          prompt: string;
          retryCount?: number;
          retryDelay?: number;
          qualityGate?: string;
          nextTaskOnSuccess?: string;
          nextTaskOnError?: string;
          dependsOn?: string[];
          triggerType?: "cron" | "file" | "mcp-event";
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
        };
        try {
          await schedulerCreateTask(
            name,
            schedule,
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
            matrix
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
            await scheduler.runTask(def.name);
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
        const { name } = input as { name: string };
        const result = await pauseOrResumeTask(name, true);
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
        const { limit } = input as { limit?: number };
        const records = await loadHistory();
        return { records: records.slice(0, limit ?? 10) };
      },
      get_metrics: async () => {
        return await loadMetrics();
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
            gitBranch: readGitBranch(workspace.path) ?? null,
          })),
        };
      },
      add_workspace: async (input: unknown) => {
        try {
          const { name, path: workspacePath, color } = input as {
            name?: string;
            path: string;
            color?: string;
          };
          const workspace = addWorkspace({ name, path: workspacePath, color });
          return { success: true, workspace: { ...workspace, gitBranch: readGitBranch(workspace.path) ?? null } };
        } catch (err: any) {
          return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
      update_workspace: async (input: unknown) => {
        try {
          const { id, name, path: workspacePath, color } = input as {
            id: string;
            name?: string;
            path?: string;
            color?: string;
          };
          const workspace = updateWorkspace(id, { name, path: workspacePath, color });
          if (!workspace) {
            return { success: false, error: "Workspace не найден." };
          }
          return { success: true, workspace: { ...workspace, gitBranch: readGitBranch(workspace.path) ?? null } };
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
      get_settings: async () => {
        return await loadSettings();
      },
      save_settings: async (input: unknown) => {
        const { maxConcurrent, winterMode, notifications } = input as {
          maxConcurrent?: number;
          winterMode?: boolean;
          notifications?: NotificationSettings;
        };
        const current = await loadSettings();
        if (
          maxConcurrent === undefined &&
          winterMode === undefined &&
          notifications === undefined
        ) {
          return {
            success: false,
            maxConcurrent: current.maxConcurrent,
            winterMode: current.winterMode,
            notifications: current.notifications,
          };
        }
        const settings = await saveSettings({ maxConcurrent, winterMode, notifications });
        return {
          success: true,
          maxConcurrent: settings.maxConcurrent,
          winterMode: settings.winterMode,
          notifications: settings.notifications,
        };
      },
      test_notification: async () => {
        return await sendTestNotification();
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
                def.matrixParentId
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
      rpcRegistration.dispose();
      registration.dispose();
      void skillRegistration?.dispose();
      void fileWatcherManager.stop();
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
  triggerType?: "cron" | "file" | "mcp-event",
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
  matrixMode: "create" | "sync" = "create"
): Promise<void> {
  const normalizedModel = model?.trim() || undefined;
  const normalizedPriority = normalizePriority(priority);
  const normalizedBefore = beforeScript?.trim() || undefined;
  const normalizedAfter = afterScript?.trim() || undefined;
  const normalizedMcpEvent =
    mcpEvent && mcpEvent.event?.trim()
      ? {
          server: mcpEvent.server?.trim() || "",
          event: mcpEvent.event.trim(),
          ...(mcpEvent.filter?.trim() ? { filter: mcpEvent.filter.trim() } : {}),
        }
      : undefined;
  let effectiveTriggerType = triggerType ?? "cron";
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
      convertCronToSchTasks(schedule);
    } catch (err: any) {
      throw new Error(err.message || String(err));
    }
  }

  const sanitized = sanitizeName(name);
  const lockFile = lockFilePath(sanitized);
  const logFile = path.join(LOG_DIR, `${sanitized}.log`);
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
        normalizedDeniedTools
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
      workingDirectory: effectiveWorkingDirectory,
      logFile,
      model: normalizedModel,
      priority: normalizedPriority,
    });
  } catch (err: any) {
    throw new Error(err instanceof Error ? err.message : String(err));
  }

  // Сохраняем определение задачи для последующего экспорта/импорта.
  const existingQueue = matrixMode === "sync" ? getTask(name)?.matrixQueue : undefined;
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
    watchPath: normalizedMatrix ? undefined : watchPath,
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
        name
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
  return scheduler.runTask(name);
}

/**
 * Собирает задачи плагина в формате, который отдают оба потребителя:
 * RPC get_tasks (GUI) и инструмент list_tasks (агент).
 */
async function collectTasksView() {
  const tasks = await scheduler.listTasks();

  // Читаем историю один раз, чтобы определить финальный статус по последней записи.
  const history = await loadHistory();
  const lastByTask = new Map<string, { status: string; error?: string | null }>();
  for (const record of history) {
    lastByTask.set(record.taskName, {
      status: record.status,
      error: record.error,
    });
  }

  // Читаем определения задач один раз (расписание, повторы, цепочки, директория).
  const defs = await loadTaskDefinitions();
  const workspaces = listWorkspaces();
  const workspaceById = new Map(workspaces.map((workspace) => [workspace.id, workspace]));

  return tasks.map((t) => {
    // Все бэкенды возвращают короткие имена (без папки планировщика).
    const name = t.taskName || "";

    // Приоритет 1: статус, который сообщает планировщик ОС.
    let status = mapStatus(t.status);

    // Приоритет 2: если последняя запись в истории — error/timeout, перебиваем на error.
    const last = lastByTask.get(name);
    if (last && (last.status === "error" || last.status === "timeout")) {
      status = "error";
    } else if (last && last.status === "success") {
      status = "success";
    }

    const def = defs.find((d) => d.name.toLowerCase() === name.toLowerCase());
    const workspace = def?.workspaceId ? workspaceById.get(def.workspaceId) : undefined;

    // Matrix-родитель: статус = агрегат по клонам (success/error/partial/running).
    const matrixAggregate = def?.matrix ? aggregateMatrixResults(name) : null;
    if (matrixAggregate && matrixAggregate.status !== "empty") {
      status = matrixAggregate.status === "running" ? "running" : matrixAggregate.status;
    }

    return {
      name,
      schedule: def?.schedule ?? "",
      status,
      nextRun: t.nextRunTime ? String(t.nextRunTime) : null,
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
  if (s.includes("ready") || s.includes("готов")) return "success";
  if (s.includes("disabled")) return "unknown";
  return "unknown";
}
