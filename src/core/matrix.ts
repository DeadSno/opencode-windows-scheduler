/**
 * Matrix Builds / Fan-Out (Спринт 15).
 *
 * Родительская задача с полем `matrix` не выполняется сама: она служит
 * шаблоном. Для каждого workspace создаётся обычный клон-задача
 * `<parent>-matrix-<workspace>`, который запускается через обычный бэкенд
 * планировщика. Родитель агрегирует результаты клонов.
 *
 * Клоны регистрируются с триггером «file» (ручной запуск): они не должны
 * срабатывать по cron независимо от матрицы.
 */
import { sanitizeName } from "../types.js";
import type { MatrixConfig, TaskDefinition } from "../task-transfer.js";
import {
  getTask,
  listMatrixClones,
  listTasks,
  saveTask,
} from "../db/tasks-repo.js";
import { getHistory, recordRun } from "../db/history-repo.js";
import { notifyMatrixCompletion } from "../notifications.js";
import { getWorkspace } from "../workspaces.js";
import { createSchedulerBackend } from "./scheduler/index.js";

/** Суффикс агрегирующей задачи, запускаемой после всех клонов. */
export const MATRIX_COMPLETE_SUFFIX = "-matrix-complete";

/** Имя клона: <родитель>-matrix-<workspace>. */
export function matrixCloneName(parentName: string, workspaceName: string): string {
  const parent = parentName.trim();
  const ws = workspaceName.trim() || "workspace";
  const safeWs = ws.replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, "-");
  return `${parent}-matrix-${safeWs}`;
}

/** Имя агрегирующей задачи matrix-complete. */
export function matrixCompleteName(parentName: string): string {
  return `${parentName.trim()}${MATRIX_COMPLETE_SUFFIX}`;
}

/** Проверяет, является ли имя агрегатором матрицы. */
export function isMatrixCompleteName(name: string): boolean {
  return name.trim().toLowerCase().endsWith(MATRIX_COMPLETE_SUFFIX);
}

/**
 * Разворачивает задачу-шаблон в список клонов (без записи в БД).
 * Бросает ошибку, если workspace не найден или список пуст.
 */
export function expandMatrixTask(task: TaskDefinition): TaskDefinition[] {
  const matrix = task.matrix;
  if (!matrix || !Array.isArray(matrix.workspaceIds) || matrix.workspaceIds.length === 0) {
    throw new Error(`Задача "${task.name}": matrix.workspaceIds не может быть пустым.`);
  }

  const clones: TaskDefinition[] = [];
  const usedNames = new Set<string>();

  for (const workspaceId of matrix.workspaceIds) {
    const workspace = getWorkspace(workspaceId);
    if (!workspace) {
      throw new Error(
        `Задача "${task.name}": workspace "${workspaceId}" не найден.`
      );
    }
    const name = matrixCloneName(task.name, workspace.name);
    if (usedNames.has(name.toLowerCase())) continue;
    usedNames.add(name.toLowerCase());

    // Клон наследует промпт, модель, хуки, Quality Gate, role-scoped tools.
    // Поля матрицы/родителя не наследуются: клон — обычная задача.
    const clone: TaskDefinition = { ...task };
    delete clone.matrix;
    delete clone.isMatrixParent;
    delete clone.matrixQueue;
    delete clone.createdAt;

    // Спринт 17: per-workspace переопределения для этого клона.
    const override = matrix.overrides?.[workspace.id];
    const cloneDefinition: TaskDefinition = {
      ...clone,
      name,
      workspaceId: workspace.id,
      workingDirectory: undefined,
      matrixParentId: task.name,
      // Клоны не должны запускаться по cron — только через runMatrix().
      triggerType: "file",
      watchPath: undefined,
      mcpEvent: undefined,
      dependsOn: undefined,
      nextTaskOnSuccess: undefined,
      nextTaskOnError: undefined,
    };
    if (override) {
      const prompt = override.prompt?.trim();
      const model = override.model?.trim();
      const qualityGate = override.qualityGate?.trim();
      const beforeScript = override.beforeScript?.trim();
      const afterScript = override.afterScript?.trim();
      if (prompt) cloneDefinition.prompt = prompt;
      if (model) cloneDefinition.model = model;
      if (qualityGate) cloneDefinition.qualityGate = qualityGate;
      if (beforeScript) cloneDefinition.beforeScript = beforeScript;
      if (afterScript) cloneDefinition.afterScript = afterScript;
    }

    clones.push(cloneDefinition);
  }

  if (clones.length === 0) {
    throw new Error(`Задача "${task.name}": не удалось создать ни одного клона матрицы.`);
  }
  return clones;
}

/** Статус клона по последней записи истории. */
function latestCloneStatus(cloneName: string): {
  status: string;
  error: string | null;
  finishedAt: string | null;
} {
  const records = getHistory(cloneName, 1);
  const last = records[0];
  if (!last) return { status: "pending", error: null, finishedAt: null };
  return {
    status: last.status,
    error: last.error ?? null,
    finishedAt: last.finishedAt ?? null,
  };
}

export interface MatrixCloneResult {
  name: string;
  workspaceId: string | null;
  workspaceName: string | null;
  status: string;
  error: string | null;
  finishedAt: string | null;
}

export interface MatrixAggregate {
  parentId: string;
  totalCount: number;
  successCount: number;
  errorCount: number;
  pendingCount: number;
  /** success | error | partial | running */
  status: "success" | "error" | "partial" | "running" | "empty";
  message: string;
  clones: MatrixCloneResult[];
}

/** Собирает результаты клонов и вычисляет агрегированный статус. */
export function aggregateMatrixResults(parentId: string): MatrixAggregate {
  const parent = getTask(parentId);
  const clones = listMatrixClones(parentId);
  const failureMode = parent?.matrix?.failureMode ?? "continue";

  const results: MatrixCloneResult[] = clones.map((clone) => {
    const workspace = clone.workspaceId ? getWorkspace(clone.workspaceId) : undefined;
    const latest = latestCloneStatus(clone.name);
    return {
      name: clone.name,
      workspaceId: clone.workspaceId ?? null,
      workspaceName: workspace?.name ?? null,
      status: latest.status,
      error: latest.error,
      finishedAt: latest.finishedAt,
    };
  });

  const totalCount = results.length;
  const successCount = results.filter((r) => r.status === "success").length;
  const errorCount = results.filter((r) => r.status === "error").length;
  const pendingCount = results.filter(
    (r) => r.status !== "success" && r.status !== "error" && r.status !== "partial"
  ).length;

  let status: MatrixAggregate["status"];
  let message: string;

  if (totalCount === 0) {
    status = "empty";
    message = `У матрицы "${parentId}" нет клонов.`;
  } else if (pendingCount > 0) {
    status = "running";
    message = `Выполняется: ${totalCount - pendingCount} из ${totalCount}.`;
  } else if (errorCount === 0) {
    status = "success";
    message = `Все ${totalCount} клонов завершились успешно.`;
  } else if (failureMode === "stop") {
    const firstError = results.find((r) => r.status === "error");
    status = "error";
    message =
      `Остановлено после первой ошибки: ${errorCount} из ${totalCount} с ошибкой.` +
      (firstError?.error ? ` Первая ошибка (${firstError.name}): ${firstError.error}` : "");
  } else {
    status = "partial";
    message = `Частичный успех: ${successCount} из ${totalCount} успешно, ${errorCount} с ошибкой.`;
  }

  return {
    parentId,
    totalCount,
    successCount,
    errorCount,
    pendingCount,
    status,
    message,
    clones: results,
  };
}

export interface MatrixRunResult {
  success: boolean;
  parent: string;
  strategy: "parallel" | "sequential";
  started: string[];
  skipped: string[];
  /** Клоны, отложенные из-за matrix.concurrency (запустятся по мере завершения). */
  queued: string[];
  errors: string[];
}

/** Эффективный лимит одновременных клонов матрицы (Спринт 17). */
export function resolveMatrixConcurrency(
  matrix: MatrixConfig | undefined,
  totalClones: number
): number {
  const total = Math.max(1, totalClones);
  if (!matrix) return total;
  if ((matrix.strategy ?? "parallel") === "sequential") return 1;
  if (
    typeof matrix.concurrency === "number" &&
    Number.isFinite(matrix.concurrency) &&
    matrix.concurrency >= 1
  ) {
    return Math.min(total, Math.floor(matrix.concurrency));
  }
  return total;
}

/**
 * Запускает клоны матрицы.
 *  - parallel: все клоны сразу, но не больше matrix.concurrency одновременно
 *    (остальные — в очереди matrixQueue на родителе);
 *  - sequential: только первый, остальные — по завершении предыдущего.
 *  - failureMode "stop": при ошибке немедленного запуска остальные не стартуют.
 */
export async function runMatrix(task: TaskDefinition): Promise<MatrixRunResult> {
  const matrix = task.matrix;
  if (!matrix) {
    throw new Error(`Задача "${task.name}" не является матрицей.`);
  }
  const clones = listMatrixClones(task.name);
  if (clones.length === 0) {
    throw new Error(
      `У матрицы "${task.name}" нет клонов — пересоздайте задачу, чтобы развернуть её по workspace.`
    );
  }

  const strategy = matrix.strategy === "sequential" ? "sequential" : "parallel";
  const failureMode = matrix.failureMode === "stop" ? "stop" : "continue";
  const backend = createSchedulerBackend();

  const started: string[] = [];
  const skipped: string[] = [];
  const errors: string[] = [];

  const concurrency = resolveMatrixConcurrency(matrix, clones.length);
  const toStart = strategy === "sequential" ? clones.slice(0, 1) : clones.slice(0, concurrency);
  if (strategy === "sequential") {
    skipped.push(...clones.slice(1).map((c) => c.name));
  }
  // Очередь параллельных клонов сверх лимита сохраняется в определении
  // родителя, чтобы пережить перезапуск плагина.
  const queued =
    strategy === "parallel" ? clones.slice(concurrency).map((c) => c.name) : [];

  for (const clone of toStart) {
    try {
      const result = await backend.runTask(clone.name);
      if (result.alreadyRunning) {
        skipped.push(clone.name);
      } else {
        started.push(clone.name);
      }
    } catch (err: any) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`${clone.name}: ${message}`);
      if (failureMode === "stop") {
        const rest = clones
          .slice(clones.indexOf(clone) + 1)
          .map((c) => c.name);
        skipped.push(...rest);
        break;
      }
    }
  }

  // stop + ошибка запуска: очередь не имеет смысла — вся матрица остановлена.
  const queueToSave =
    failureMode === "stop" && errors.length > 0 ? [] : queued;
  try {
    saveTask({ ...task, matrixQueue: queueToSave.length > 0 ? queueToSave : undefined });
  } catch (err: any) {
    console.log(
      `[matrix] ${task.name}: не удалось сохранить очередь: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  console.log(
    `[matrix] ${task.name}: strategy=${strategy}, failureMode=${failureMode}, ` +
      `concurrency=${concurrency}, started=${started.length}, skipped=${skipped.length}, ` +
      `queued=${queueToSave.length}, errors=${errors.length}`
  );

  return {
    success: errors.length === 0 || failureMode === "continue",
    parent: task.name,
    strategy,
    started,
    skipped,
    queued: queueToSave,
    errors,
  };
}

/**
 * Продолжает последовательную матрицу: запускает следующий клон после
 * завершения текущего. Вызывается из record-history после финиша клона.
 * Возвращает имя запущенного клона или undefined.
 */
export async function advanceSequentialMatrix(
  cloneName: string
): Promise<string | undefined> {
  const clone = getTask(cloneName);
  if (!clone?.matrixParentId) return undefined;
  const parent = getTask(clone.matrixParentId);
  if (!parent?.matrix) return undefined;
  if ((parent.matrix.strategy ?? "parallel") !== "sequential") return undefined;

  const clones = listMatrixClones(parent.name);
  const workspaceOrder = parent.matrix.workspaceIds;
  const orderIndex = (workspaceId: string | undefined): number => {
    const index = workspaceId ? workspaceOrder.indexOf(workspaceId) : -1;
    return index < 0 ? Number.MAX_SAFE_INTEGER : index;
  };
  const ordered = clones
    .slice()
    .sort((a, b) => orderIndex(a.workspaceId) - orderIndex(b.workspaceId));
  const index = ordered.findIndex((c) => c.name.toLowerCase() === cloneName.toLowerCase());
  if (index < 0) return undefined;

  // stop: после ошибки последовательная цепочка обрывается.
  if ((parent.matrix.failureMode ?? "continue") === "stop") {
    const latest = latestCloneStatus(cloneName);
    if (latest.status === "error") {
      console.log(`[matrix] ${parent.name}: sequential остановлена после ошибки ${cloneName}`);
      return undefined;
    }
  }

  const next = ordered[index + 1];
  if (!next) return undefined;

  try {
    const result = await createSchedulerBackend().runTask(next.name);
    if (result.alreadyRunning) return undefined;
    console.log(`[matrix] ${parent.name}: sequential -> ${next.name}`);
    return next.name;
  } catch (err: any) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`[matrix] ${parent.name}: не удалось запустить ${next.name}: ${message}`);
    return undefined;
  }
}

/**
 * Продолжает матрицу после завершения клона (Спринт 17):
 *  - sequential — запускает следующий клон по порядку workspaceIds;
 *  - parallel с matrix.concurrency — добирает клоны из очереди matrixQueue,
 *    пока не заполнены свободные слоты.
 * Возвращает имена запущенных клонов.
 */
export async function advanceMatrixAfterClone(
  cloneName: string
): Promise<string[]> {
  const sequentialNext = await advanceSequentialMatrix(cloneName);
  if (sequentialNext) return [sequentialNext];

  const clone = getTask(cloneName);
  const parentId = clone?.matrixParentId?.trim();
  if (!parentId) return [];
  const parent = getTask(parentId);
  if (!parent?.matrix) return [];
  if ((parent.matrix.strategy ?? "parallel") !== "parallel") return [];

  const queue = Array.isArray(parent.matrixQueue) ? parent.matrixQueue.slice() : [];
  if (queue.length === 0) return [];

  const clones = listMatrixClones(parent.name);
  const concurrency = resolveMatrixConcurrency(parent.matrix, clones.length);
  const running = clones.filter(
    (item) => latestCloneStatus(item.name).status === "running"
  ).length;
  let slots = Math.max(0, concurrency - running);
  if (slots === 0) return [];

  const backend = createSchedulerBackend();
  const started: string[] = [];
  const failureMode = parent.matrix.failureMode === "stop" ? "stop" : "continue";

  while (slots > 0 && queue.length > 0) {
    const nextName = queue.shift()!;
    try {
      const result = await backend.runTask(nextName);
      started.push(nextName);
      slots -= 1;
      if (result.alreadyRunning) slots += 0; // слот уже занят этим клоном
      console.log(`[matrix] ${parent.name}: из очереди -> ${nextName}`);
    } catch (err: any) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(
        `[matrix] ${parent.name}: не удалось запустить из очереди ${nextName}: ${message}`
      );
      // Попытка запуска «съедает» слот: иначе при недоступном бэкенде
      // цикл уйдёт по всей очереди, проигнорировав лимит.
      slots -= 1;
      if (failureMode === "stop") {
        queue.length = 0;
        break;
      }
    }
  }

  try {
    saveTask({ ...parent, matrixQueue: queue.length > 0 ? queue : undefined });
  } catch (err: any) {
    console.log(
      `[matrix] ${parent.name}: не удалось сохранить очередь: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  return started;
}

/**
 * Создаёт (или обновляет) виртуальную задачу matrix-complete:
 * без workspace, dependsOn = все клоны. Запускается DAG-движком,
 * когда все клоны успешны.
 */
export function ensureMatrixCompleteTask(parent: TaskDefinition): TaskDefinition | undefined {
  if (!parent.matrix?.createAggregator) return undefined;
  const clones = listMatrixClones(parent.name);
  if (clones.length === 0) return undefined;

  const name = matrixCompleteName(parent.name);
  const existing = getTask(name);
  const definition: TaskDefinition = {
    ...(existing ?? {}),
    name,
    schedule: parent.schedule,
    prompt:
      existing?.prompt ??
      `Все клоны матрицы "${parent.name}" завершились. Проверь результаты: ` +
        `${clones.map((c) => c.name).join(", ")}.`,
    triggerType: "file",
    watchPath: undefined,
    mcpEvent: undefined,
    workspaceId: undefined,
    matrix: undefined,
    isMatrixParent: undefined,
    matrixParentId: undefined,
    dependsOn: clones.map((c) => c.name),
    model: parent.model,
    priority: parent.priority,
    qualityGate: undefined,
    beforeScript: undefined,
    afterScript: undefined,
    allowedTools: parent.allowedTools,
    deniedTools: parent.deniedTools,
    createdAt: existing?.createdAt,
  };
  saveTask(definition);
  return definition;
}

/** Удаляет клоны и агрегатор (используется при пересоздании матрицы). */
export function removeMatrixChildren(parentName: string): string[] {
  const removed: string[] = [];
  const all = listTasks();
  for (const definition of all) {
    const isClone =
      definition.matrixParentId &&
      definition.matrixParentId.trim().toLowerCase() === parentName.trim().toLowerCase();
    const isAggregator =
      definition.name.trim().toLowerCase() === matrixCompleteName(parentName).toLowerCase();
    if (isClone || isAggregator) removed.push(definition.name);
  }
  return removed;
}

/** Подпись клона: если меняется — клон нужно обновить (Спринт 17). */
function cloneSignature(definition: TaskDefinition): string {
  return JSON.stringify({
    workspaceId: definition.workspaceId ?? null,
    schedule: definition.schedule ?? null,
    prompt: definition.prompt ?? null,
    model: definition.model ?? null,
    priority: definition.priority ?? null,
    timeoutSeconds: definition.timeoutSeconds ?? null,
    qualityGate: definition.qualityGate ?? null,
    beforeScript: definition.beforeScript ?? null,
    afterScript: definition.afterScript ?? null,
    allowedTools: definition.allowedTools ?? null,
    deniedTools: definition.deniedTools ?? null,
    triggerType: definition.triggerType ?? "cron",
  });
}

/** План синхронизации семьи матрицы с её текущим определением. */
export interface MatrixSyncPlan {
  parent: TaskDefinition;
  /** Какими клоны должны быть по текущему определению. */
  desired: TaskDefinition[];
  create: TaskDefinition[];
  update: TaskDefinition[];
  remove: string[];
  /** Клоны в статусе running — их нельзя менять/удалять. */
  running: string[];
  warnings: string[];
}

/**
 * Сравнивает текущих клонов матрицы с тем, что должно быть по определению
 * родителя (workspaceIds/overrides/общие поля). Ничего не меняет в БД/ОС.
 */
export function planMatrixSync(parent: TaskDefinition): MatrixSyncPlan {
  if (!parent.matrix) {
    throw new Error(`Задача "${parent.name}" не является матрицей.`);
  }
  const desired = expandMatrixTask(parent);
  const existing = listMatrixClones(parent.name);
  const byName = new Map(
    existing.map((definition) => [definition.name.toLowerCase(), definition])
  );
  const desiredNames = new Set(desired.map((definition) => definition.name.toLowerCase()));

  const create: TaskDefinition[] = [];
  const update: TaskDefinition[] = [];
  const remove: string[] = [];
  const running: string[] = [];
  const warnings: string[] = [];

  for (const wanted of desired) {
    const current = byName.get(wanted.name.toLowerCase());
    if (!current) {
      create.push(wanted);
      continue;
    }

    const latest = latestCloneStatus(current.name);
    if (latest.status === "running") {
      // Выполняющийся клон не трогаем: не обновляем, не удаляем.
      running.push(current.name);
      if (cloneSignature(current) !== cloneSignature(wanted)) {
        warnings.push(
          `Клон "${current.name}" выполняется — изменения применятся после завершения.`
        );
      }
      continue;
    }

    if (cloneSignature(current) === cloneSignature(wanted)) continue;
    update.push(wanted);
  }

  for (const current of existing) {
    if (desiredNames.has(current.name.toLowerCase())) continue;
    const latest = latestCloneStatus(current.name);
    if (latest.status === "running") {
      running.push(current.name);
      warnings.push(
        `Клон "${current.name}" выполняется — удаление отложено до завершения.`
      );
      continue;
    }
    remove.push(current.name);
  }

  return { parent, desired, create, update, remove, running, warnings };
}

/** Колбэки для применения плана синхронизации (реализуются в index.ts). */
export interface MatrixSyncHooks {
  removeChild?(name: string): Promise<void> | void;
  createChild?(definition: TaskDefinition): Promise<void> | void;
  updateChild?(definition: TaskDefinition): Promise<void> | void;
  /** Пересоздать/обновить/удалить агрегатор; возвращает имя или undefined. */
  syncAggregator?(parent: TaskDefinition): Promise<string | undefined> | string | undefined;
}

export interface MatrixSyncResult {
  parent: string;
  created: string[];
  updated: string[];
  removed: string[];
  running: string[];
  warnings: string[];
  aggregator?: string;
}

/**
 * Синхронизирует клонов матрицы с её текущим определением, не удаляя
 * выполняющиеся клоны. Используется при update_task матрицы (Спринт 17).
 */
export async function syncMatrixFamily(
  parent: TaskDefinition,
  hooks: MatrixSyncHooks = {}
): Promise<MatrixSyncResult> {
  const plan = planMatrixSync(parent);

  for (const name of plan.remove) {
    await hooks.removeChild?.(name);
  }
  for (const definition of plan.update) {
    await hooks.updateChild?.(definition);
  }
  for (const definition of plan.create) {
    await hooks.createChild?.(definition);
  }
  const aggregator = await hooks.syncAggregator?.(parent);

  return {
    parent: parent.name,
    created: plan.create.map((definition) => definition.name),
    updated: plan.update.map((definition) => definition.name),
    removed: plan.remove,
    running: plan.running,
    warnings: plan.warnings,
    ...(aggregator !== undefined ? { aggregator } : {}),
  };
}

/** Имя родителя по имени агрегатора (`<parent>-matrix-complete`). */
export function matrixParentOfCompleteTask(
  taskName: string
): string | undefined {
  const trimmed = taskName.trim();
  if (!isMatrixCompleteName(trimmed)) return undefined;
  const parent = trimmed.slice(0, -MATRIX_COMPLETE_SUFFIX.length).trim();
  return parent || undefined;
}

/**
 * План каскадного удаления: для матрицы-родителя возвращает её клоны
 * и агрегатор. Для обычной задачи/клона возвращает undefined.
 */
export interface MatrixFamilyPlan {
  parent: string;
  children: string[];
}

export function planMatrixFamilyDelete(
  taskName: string
): MatrixFamilyPlan | undefined {
  const definition = getTask(taskName);
  if (!definition?.matrix) return undefined;
  return {
    parent: definition.name,
    children: removeMatrixChildren(definition.name),
  };
}

/**
 * Защита от ручного удаления клона: клон живёт только в составе матрицы,
 * поэтому удалять его поодиночке нельзя — иначе родитель останется
 * с «пустым» workspace в списке и навсегда в статусе running.
 * Возвращает текст ошибки или undefined, если удаление разрешено.
 */
export function getMatrixDeletionGuard(
  taskName: string
): string | undefined {
  const definition = getTask(taskName);
  const parentId = definition?.matrixParentId?.trim();
  if (!parentId) return undefined;
  return (
    `Задача "${definition?.name ?? taskName}" — клон матрицы "${parentId}". ` +
    `Удалите матрицу целиком (родитель + все клоны) или измените список ` +
    `workspace-ов родителя.`
  );
}

/**
 * Осиротевшие задачи матриц: клоны, чей родитель уже удалён, и агрегаторы,
 * у которых больше нет родителя-матрицы. Такие задачи нельзя запустить и
 * они навсегда остаются в списке — их нужно вычищать.
 */
export function findOrphanedMatrixTasks(): string[] {
  const all = listTasks();
  const names = new Set(all.map((definition) => definition.name.toLowerCase()));
  const orphans: string[] = [];

  for (const definition of all) {
    const parentId = definition.matrixParentId?.trim();
    if (parentId) {
      if (!names.has(parentId.toLowerCase())) orphans.push(definition.name);
      continue;
    }

    const aggregatorParent = matrixParentOfCompleteTask(definition.name);
    if (aggregatorParent) {
      const parent = getTask(aggregatorParent);
      if (!parent?.matrix) orphans.push(definition.name);
    }
  }

  return orphans;
}

/** Результат отмены выполняющейся матрицы. */
export interface MatrixCancelResult {
  parent: string;
  /** Клоны, которые были незавершены и помечены отменой. */
  cancelled: string[];
  /** Из них те, что были в статусе running (их процесс нужно остановить). */
  running: string[];
  /** Клоны, которые уже завершились и не тронуты отменой. */
  alreadyFinished: string[];
  aggregate: MatrixAggregate;
}

/**
 * Отмена матрицы «одной кнопкой»: все незавершённые клоны помечаются
 * error-записью в истории с причиной отмены, после чего родителю пишется
 * агрегированный итог. Реальные процессы клонов останавливает вызывающая
 * сторона (index.ts), т.к. для этого нужен бэкенд планировщика ОС.
 */
export async function cancelPendingMatrixClones(
  parentName: string,
  reason = "Отменено пользователем."
): Promise<MatrixCancelResult> {
  const parent = getTask(parentName);
  if (!parent?.matrix) {
    throw new Error(`Задача "${parentName}" не является матрицей.`);
  }

  const clones = listMatrixClones(parent.name);
  const cancelled: string[] = [];
  const running: string[] = [];
  const alreadyFinished: string[] = [];

  // Снимаем очередь параллельных клонов — после отмены она не нужна.
  if (Array.isArray(parent.matrixQueue) && parent.matrixQueue.length > 0) {
    try {
      saveTask({ ...parent, matrixQueue: undefined });
    } catch (err: any) {
      console.log(
        `[matrix] ${parent.name}: не удалось очистить очередь: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  for (const clone of clones) {
    const latest = latestCloneStatus(clone.name);
    const isFinished =
      latest.status === "success" ||
      latest.status === "error" ||
      latest.status === "timeout" ||
      latest.status === "partial";
    if (isFinished) {
      alreadyFinished.push(clone.name);
      continue;
    }

    if (latest.status === "running") running.push(clone.name);

    try {
      recordRun(
        clone.name,
        "error",
        new Date().toISOString(),
        0,
        reason,
        undefined,
        undefined,
        undefined,
        clone.model ?? undefined,
        "skipped",
        "skipped"
      );
      cancelled.push(clone.name);
    } catch (err: any) {
      console.log(
        `[matrix] ${parent.name}: не удалось записать отмену клона ${clone.name}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  if (cancelled.length > 0 && clones.length > 0) {
    await finalizeMatrixIfComplete(clones[0].name);
  }

  return {
    parent: parent.name,
    cancelled,
    running,
    alreadyFinished,
    aggregate: aggregateMatrixResults(parent.name),
  };
}

/** Санитизированное имя клона для файлов промптов/обёрток. */
export function cloneFileKey(cloneName: string): string {
  return sanitizeName(cloneName);
}

/**
 * Вызывается после завершения клона: если все клоны матрицы уже финишировали,
 * пишет агрегированную запись истории для родителя (status может быть
 * success/error/partial) и запускает matrix-complete, если он создан.
 */
export async function finalizeMatrixIfComplete(
  cloneName: string
): Promise<MatrixAggregate | undefined> {
  const clone = getTask(cloneName);
  const parentId = clone?.matrixParentId?.trim();
  if (!parentId) return undefined;

  const parent = getTask(parentId);
  if (!parent?.matrix) return undefined;

  // Пока есть клоны в очереди (matrix.concurrency) — матрица ещё не завершена.
  const queued = Array.isArray(parent.matrixQueue) ? parent.matrixQueue : [];
  if (queued.length > 0) return undefined;

  const aggregate = aggregateMatrixResults(parent.name);
  if (aggregate.totalCount === 0 || aggregate.pendingCount > 0) return undefined;

  // Защита от повторной записи: если такая же агрегированная запись уже есть
  // и она свежее последнего клона — ничего не делаем.
  const existing = getHistory(parent.name, 1)[0];
  if (existing) {
    const existingAt = existing.finishedAt ? new Date(existing.finishedAt).getTime() : 0;
    const latestCloneAt = aggregate.clones.reduce((max, item) => {
      const time = item.finishedAt ? new Date(item.finishedAt).getTime() : 0;
      return Number.isFinite(time) ? Math.max(max, time) : max;
    }, 0);
    if (existing.status === aggregate.status && existingAt >= latestCloneAt) {
      return aggregate;
    }
  }

  try {
    const finalStatus: "success" | "error" | "partial" =
      aggregate.status === "success"
        ? "success"
        : aggregate.status === "partial"
          ? "partial"
          : "error";
    recordRun(
      parent.name,
      finalStatus,
      new Date().toISOString(),
      0,
      finalStatus === "success" ? null : aggregate.message,
      undefined,
      undefined,
      undefined,
      parent.model ?? undefined,
      "skipped",
      "skipped"
    );
    // Спринт 20: уведомление о завершении матрицы (partial / все упали / успех).
    void notifyMatrixCompletion({
      parentName: parent.name,
      status: finalStatus,
      total: aggregate.totalCount,
      success: aggregate.successCount,
      error: aggregate.errorCount,
      message: aggregate.message,
    });
  } catch (err: any) {
    console.log(
      `[matrix] ${parent.name}: не удалось записать агрегат: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  if (parent.matrix.createAggregator) {
    const aggregator = getTask(matrixCompleteName(parent.name));
    if (aggregator) {
      try {
        await createSchedulerBackend().runTask(aggregator.name);
        console.log(`[matrix] ${parent.name}: запущен агрегатор ${aggregator.name}`);
      } catch (err: any) {
        console.log(
          `[matrix] ${parent.name}: не удалось запустить агрегатор: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }
  }

  return aggregate;
}
