import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createSchedulerBackend } from "./scheduler/index.js";
import { notifyTaskCompletion } from "../notifications.js";
import { finishRun, getHistory, recordRun, startRun } from "../db/history-repo.js";
import { getSetting, setSetting } from "../db/settings-repo.js";
import { getTask, listTasks } from "../db/tasks-repo.js";
import { rotateSessionIfNeeded } from "./session.js";
import type { TaskDefinition } from "../task-transfer.js";
import type { HistoryRecord } from "../history.js";
import {
  advanceMatrixAfterClone,
  finalizeMatrixIfComplete,
} from "./matrix.js";

type Status = "success" | "error" | "timeout";

const RETRY_STATE_KEY = "retry_state";

/**
 * Ищет настройку повторов задачи в БД.
 * Возвращает 0, если повторы не настроены.
 */
async function loadRetryConfig(taskName: string): Promise<{ count: number; delay: number }> {
  const definition = getTask(taskName);
  const count = Math.max(0, Math.floor(Number(definition?.retryCount) || 0));
  const delay = Math.max(1, Math.floor(Number(definition?.retryDelay) || 60));
  return { count, delay };
}

/**
 * Запускает задачу по имени через бэкенд планировщика текущей ОС
 * (schtasks / crontab / launchd). Используется цепочками задач
 * (nextTaskOnSuccess / nextTaskOnError).
 */
async function triggerTask(taskName: string): Promise<boolean> {
  try {
    await createSchedulerBackend().runTask(taskName);
    return true;
  } catch (err: any) {
    console.error(
      `[windows-scheduler] Не удалось запустить задачу цепочки "${taskName}": ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return false;
  }
}

/** Счётчик оставшихся повторов по задачам (ключ — имя в нижнем регистре). */
type RetryState = Record<string, number>;

async function loadRetryState(): Promise<RetryState> {
  const raw = getSetting<RetryState>(RETRY_STATE_KEY, {});
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}

async function writeRetryState(state: RetryState): Promise<void> {
  setSetting(RETRY_STATE_KEY, state);
}

async function clearRetryState(taskName: string): Promise<void> {
  const state = await loadRetryState();
  const key = Object.keys(state).find((k) => k.toLowerCase() === taskName.toLowerCase());
  if (!key) return;
  delete state[key];
  await writeRetryState(state);
}

/**
 * Планирует повторный запуск упавшей задачи.
 *
 * Сам процесс record-history вызывается из PowerShell-обёртки синхронно
 * (`& node ... "), поэтому ждать задержку внутри него нельзя: обёртка
 * не завершится и не снимет lock-файл. Вместо этого запускаем отдельный
 * detached-процесс, который спит retryDelay секунд и вызывает schtasks /run.
 */
async function scheduleRetry(taskName: string): Promise<boolean> {
  try {
    const { count, delay } = await loadRetryConfig(taskName);
    if (count <= 0) return false;

    const state = await loadRetryState();
    const key = taskName.toLowerCase();
    const remaining = Object.prototype.hasOwnProperty.call(state, key)
      ? Number(state[key]) || 0
      : count;

    if (remaining <= 0) {
      await clearRetryState(taskName);
      console.log(`[windows-scheduler] Повторы для "${taskName}" исчерпаны.`);
      return false;
    }

    state[key] = remaining - 1;
    await writeRetryState(state);

    const script = process.argv[1];
    if (!script) return false;

    // Отвязываем дочерний процесс от текущего: родитель (PowerShell) должен
    // завершиться сразу, а повтор — сработать позже независимо от него.
    const child = spawn(process.execPath, [script, "--retry", taskName, String(delay)], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();

    console.log(
      `[windows-scheduler] Задача "${taskName}" будет повторена через ${delay} с ` +
        `(осталось повторов: ${remaining - 1}).`
    );
    return true;
  } catch (err: any) {
    console.error(
      `[windows-scheduler] Не удалось запланировать повтор "${taskName}": ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return false;
  }
}

/**
 * Режим `--retry <taskName> <delaySec>`: ждёт задержку и запускает задачу
 * через бэкенд планировщика. Статус исхода запишет уже сама обёртка задачи.
 */
async function runRetry(taskName: string, delaySec: number): Promise<void> {
  if (!taskName) process.exit(1);
  const delay = Math.max(1, Math.floor(Number(delaySec) || 60));
  await new Promise<void>((resolve) => setTimeout(resolve, delay * 1000));

  try {
    await createSchedulerBackend().runTask(taskName);
    console.log(`[windows-scheduler] Повторный запуск задачи "${taskName}".`);
  } catch (err: any) {
    console.error(
      `[windows-scheduler] Повторный запуск "${taskName}" не удался: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}

/**
 * Возвращает имена задач из БД, которые пора запустить после успешного
 * завершения `completedTask` (DAG-зависимости).
 *
 * Правила:
 *  - у задачи есть непустой dependsOn, и в нём упомянута completedTask;
 *  - каждая зависимость имеет в истории последнюю запись со статусом success;
 *  - зависимая задача ещё НЕ запускалась после завершения своих зависимостей
 *    (иначе граф зациклится и будет перезапускать её на каждом завершении).
 */
export function selectDependentsToTrigger(
  completedTask: string,
  definitions: TaskDefinition[],
  history: HistoryRecord[]
): string[] {
  const key = (value: string) => value.trim().toLowerCase();

  // История хранится от новых к старым: первая запись задачи — самая свежая.
  const latestByTask = new Map<string, HistoryRecord>();
  for (const record of history) {
    const k = key(record.taskName);
    if (!latestByTask.has(k)) latestByTask.set(k, record);
  }

  const toTrigger: string[] = [];
  const defsByKey = new Map<string, TaskDefinition>();
  for (const definition of definitions) {
    defsByKey.set(key(definition.name), definition);
  }

  for (const definition of definitions) {
    const deps = (Array.isArray(definition.dependsOn) ? definition.dependsOn : [])
      .map((dep) => (typeof dep === "string" ? dep.trim() : ""))
      .filter(Boolean);
    if (deps.length === 0) continue;
    if (key(definition.name) === key(completedTask)) continue;
    if (!deps.some((dep) => key(dep) === key(completedTask))) continue;

    let allSuccess = true;
    let latestDependencyFinished = 0;
    for (const dep of deps) {
      // Matrix (Спринт 15): зависимость-матрица считается выполненной только
      // когда успешны ВСЕ её клоны (у самого родителя истории нет).
      const depDefinition = defsByKey.get(key(dep));
      const clones = depDefinition?.matrix
        ? definitions.filter(
            (item) =>
              item.matrixParentId && key(item.matrixParentId) === key(dep)
          )
        : [];
      const requiredNames = clones.length > 0 ? clones.map((c) => c.name) : [dep];

      for (const requiredName of requiredNames) {
        const record = latestByTask.get(key(requiredName));
        if (!record || record.status !== "success") {
          allSuccess = false;
          break;
        }
        const finished = new Date(record.finishedAt ?? 0).getTime();
        if (Number.isFinite(finished)) {
          latestDependencyFinished = Math.max(latestDependencyFinished, finished);
        }
      }
      if (!allSuccess) break;
    }
    if (!allSuccess) continue;

    // Защита от повторного запуска: если зависимая задача уже стартовала
    // после успешного завершения последней зависимости — не трогаем её.
    const own = latestByTask.get(key(definition.name));
    if (own) {
      const ownStarted = new Date(own.startedAt).getTime();
      if (Number.isFinite(ownStarted) && ownStarted >= latestDependencyFinished) {
        continue;
      }
    }

    toTrigger.push(definition.name);
  }

  // Приоритеты: при готовности нескольких задач первыми запускаем более важные.
  const priorityByTask = new Map<string, number>();
  for (const definition of definitions) {
    priorityByTask.set(key(definition.name), Number(definition.priority) || 5);
  }
  return toTrigger.sort(
    (a, b) => (priorityByTask.get(key(b)) ?? 5) - (priorityByTask.get(key(a)) ?? 5)
  );
}

async function main() {
  const [
    ,
    ,
    first,
    second,
    third,
    fourth,
    fifth,
    sixth,
    seventh,
    eighth,
    ninth,
    tenth,
    eleventh,
  ] = process.argv;

  // Режим повтора: node record-history.js --retry "<task>" <delaySec>
  if (first === "--retry") {
    await runRetry(second, Number(third));
    return;
  }

  const parseOptionalNumber = (value?: string): number | undefined => {
    if (!value || value === "-") return undefined;
    const num = Number(value);
    return Number.isFinite(num) && num > 0 ? num : undefined;
  };
  const parseHookStatus = (
    value?: string
  ): "success" | "error" | "skipped" | undefined => {
    if (!value || value === "-") return undefined;
    if (value === "success" || value === "error" || value === "skipped") return value;
    return undefined;
  };

  /**
   * Режим старта: node record-history.js --start "<task>" "<startedAtIso>"
   * Создаёт незавершённую запись (finished_at = NULL) и печатает её id.
   * Обёртка передаёт id в --finish; если процесс убили, останется NULL и
   * crash recovery при следующем старте плагина пометит запись как error.
   */
  if (first === "--start") {
    const taskName = second;
    if (!taskName) process.exit(1);
    const startedAt = third ?? new Date().toISOString();
    const definition = getTask(taskName);
    const runId = startRun(
      taskName,
      startedAt,
      definition?.workspaceId ?? null,
      definition?.allowedTools ?? null,
      definition?.deniedTools ?? null
    );
    console.log(String(runId));
    return;
  }

  /**
   * Режим завершения: --finish <id> <task> <status> <durationMs> <error>
   * <tokens> <cost> <model> <preFlight> <postFlight>
   */
  if (first === "--finish") {
    const runId = Number(second);
    const taskName = third;
    const status = fourth;
    if (!Number.isFinite(runId) || runId <= 0 || !taskName || !status) {
      process.exit(1);
    }
    const durationMs = Number(fifth) || 0;
    const error = sixth !== undefined ? sixth : null;
    const tokens = parseOptionalNumber(seventh);
    const costUsd = parseOptionalNumber(eighth);
    const model = ninth && ninth !== "-" ? ninth.trim() || undefined : undefined;
    const preFlightStatus = parseHookStatus(tenth);
    const postFlightStatus = parseHookStatus(eleventh);
    const st: Status =
      status === "success" ? "success" : status === "timeout" ? "timeout" : "error";

    const definition = getTask(taskName);
    const chainTarget =
      st === "success"
        ? definition?.nextTaskOnSuccess || null
        : definition?.nextTaskOnError || null;

    const completed = finishRun(
      runId,
      st,
      durationMs,
      error,
      chainTarget,
      tokens,
      costUsd,
      model,
      preFlightStatus,
      postFlightStatus
    );
    if (!completed) {
      console.error(
        `[windows-scheduler] record-history: запись #${runId} уже завершена или не найдена.`
      );
      return;
    }

    await handleCompletion(taskName, st, chainTarget, error, durationMs, tokens, costUsd);
    return;
  }

  // Обратная совместимость: старый режим без --start.
  const taskName = first;
  const status = second;
  if (!taskName || !status) {
    process.exit(1);
  }

  const startedAt = third ?? new Date().toISOString();
  const durationMs = Number(fourth) || 0;
  const error = fifth !== undefined ? fifth : null;

  // Токены и стоимость приходят из PowerShell-обёртки (ps-wrapper.ts).
  // "-" означает «данных нет» (openCode не печатал usage в лог).
  const tokens = parseOptionalNumber(sixth);
  const costUsd = parseOptionalNumber(seventh);
  // Восьмой аргумент — модель; "-" означает, что модель не задана.
  const model = eighth && eighth !== "-" ? eighth.trim() || undefined : undefined;
  // Девятый и десятый — итоги pre/post-flight хуков.
  const preFlightStatus = parseHookStatus(ninth);
  const postFlightStatus = parseHookStatus(tenth);

  const st: Status =
    status === "success" ? "success" : status === "timeout" ? "timeout" : "error";

  const definition = getTask(taskName);
  const chainTarget =
    st === "success"
      ? definition?.nextTaskOnSuccess || null
      : definition?.nextTaskOnError || null;

  recordRun(
    taskName,
    st,
    startedAt,
    durationMs,
    error,
    chainTarget,
    tokens,
    costUsd,
    model,
    preFlightStatus,
    postFlightStatus,
    new Date().toISOString(),
    definition?.workspaceId ?? null,
    definition?.allowedTools ?? null,
    definition?.deniedTools ?? null
  );

  await handleCompletion(taskName, st, chainTarget, error, durationMs, tokens, costUsd);
}

/**
 * Общая пост-обработка завершённого запуска: уведомление, цепочки задач,
 * DAG-зависимости и повторы. Используется и legacy-режимом, и --finish.
 */
async function handleCompletion(
  taskName: string,
  st: Status,
  chainTarget: string | null,
  error: string | null,
  durationMs: number,
  tokens?: number | null,
  costUsd?: number | null
): Promise<void> {
  // Уведомление о завершении (webhook). Ошибки отправки логируются внутри
  // и не влияют на историю, цепочки и повторы.
  await notifyTaskCompletion(taskName, st, durationMs, error, tokens, costUsd);

  // Matrix (Спринт 15): клон завершился — двигаем sequential-цепочку или
  // очередь concurrency-лимита (Спринт 17), а когда все клоны готовы —
  // фиксируем агрегат и запускаем matrix-complete.
  try {
    await advanceMatrixAfterClone(taskName);
    await finalizeMatrixIfComplete(taskName);
  } catch (err: any) {
    console.log(
      `[matrix] ${taskName}: ошибка обработки матрицы: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  if (st === "success") {
    // Успешный запуск сбрасывает счётчик повторов.
    await clearRetryState(taskName);
    if (chainTarget) {
      const started = await triggerTask(chainTarget);
      if (started) {
        console.log(`[windows-scheduler] Запущена следующая задача в цепочке: ${chainTarget}`);
      }
    }

    // DAG: после успеха проверяем задачи, у которых эта задача — одна из
    // зависимостей. Запускаем только если ВСЕ зависимости уже успешны и
    // зависимая задача ещё не запускалась после их завершения.
    try {
      const history = getHistory(null, 200) as HistoryRecord[];
      const definitions = listTasks();
      const dependents = selectDependentsToTrigger(taskName, definitions, history);
      for (const dependent of dependents) {
        const started = await triggerTask(dependent);
        if (started) {
          console.log(
            `[windows-scheduler] DAG: все зависимости выполнены, запущена задача "${dependent}".`
          );
        }
      }
    } catch (err: any) {
      console.error(
        `[windows-scheduler] DAG: не удалось запустить зависимые задачи: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  } else {
    // Сначала пытаемся повторить саму задачу; компенсирующая задача запускается
    // только когда повторы исчерпаны (или не настроены).
    const retryScheduled = await scheduleRetry(taskName);
    if (!retryScheduled && chainTarget) {
      const started = await triggerTask(chainTarget);
      if (started) {
        console.log(`[windows-scheduler] Запущена компенсирующая задача: ${chainTarget}`);
      }
    }
  }

  // Спринт 24: учёт запусков сессии (sessionRunCount) и ротация reuse-сессии
  // при достижении sessionMaxRuns. Не должна ломать завершение запуска.
  try {
    await rotateSessionIfNeeded(taskName);
  } catch (err: any) {
    console.warn(
      `[windows-scheduler] Не удалось обновить состояние сессии "${taskName}": ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}

/**
 * Скрипт вызывается и как CLI (node record-history.js ...), и импортируется
 * тестами. main() запускаем только при прямом вызове файла.
 */
function isDirectInvocation(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return (
      pathToFileURL(entry).href.toLowerCase() === import.meta.url.toLowerCase()
    );
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  main().catch((err) => {
    console.error(
      `[windows-scheduler] record-history: не удалось записать результат запуска: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    process.exit(1);
  });
}
