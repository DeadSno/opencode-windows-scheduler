import fs from "node:fs/promises";
import path from "node:path";
import { PLUGIN_DIR, sanitizeName } from "./types.js";
import type { ScheduledTaskInfo } from "./types.js";
import {
  listTasks,
  saveTask,
  deleteTask,
} from "./db/tasks-repo.js";
import { normalizeOneShotRunAt } from "./core/one-shot.js";
import { isValidIanaTimeZone, validateLaunchWindow } from "./core/schedule-v2.js";

/** Триггер задачи по событию из MCP-шины. */
export interface McpEventTrigger {
  /** Имя MCP-сервера/источника (например, "github", "jira"). */
  server: string;
  /** Имя события (например, "github.pr.opened"). */
  event: string;
  /** Необязательный фильтр: `repo="my-project"` или regex. */
  filter?: string;
}

/**
 * Переопределения для конкретного workspace внутри матрицы (Спринт 17).
 * Позволяют задать отдельный промпт/модель/хуки/QG для одного клона.
 */
export interface MatrixWorkspaceOverride {
  prompt?: string;
  model?: string;
  qualityGate?: string;
  beforeScript?: string;
  afterScript?: string;
}

/**
 * Matrix (fan-out, Спринт 15): одна задача-шаблон раскладывается на N клонов,
 * по одному на каждый workspace. Родитель сам не выполняется — он управляет
 * клонами и агрегирует их результаты.
 */
export interface MatrixConfig {
  /** Список workspace id, по одному клону на каждый. Пустой запрещён. */
  workspaceIds: string[];
  /** Стратегия запуска клонов (по умолчанию parallel). */
  strategy?: "parallel" | "sequential";
  /** Поведение при ошибке клона (по умолчанию continue). */
  failureMode?: "continue" | "stop";
  /** Как агрегировать результат (по умолчанию summary). */
  aggregation?: "summary" | "per-task";
  /** Создавать ли виртуальную задачу matrix-complete (агрегатор). */
  createAggregator?: boolean;
  /**
   * Максимум одновременно выполняющихся клонов этой матрицы (Спринт 17).
   * Действует поверх глобального maxConcurrent. Для sequential всегда 1.
   */
  concurrency?: number;
  /**
   * Per-workspace переопределения промпта/модели/хуков/QG (Спринт 17).
   * Ключи — workspaceId из workspaceIds.
   */
  overrides?: Record<string, MatrixWorkspaceOverride>;
}

/**
 * Определение задачи, которое сохраняется при создании и используется
 * для экспорта/импорта. В schtasks нельзя надёжно прочитать исходный
 * cron и промпт, поэтому храним их рядом с плагином.
 */
export interface TaskDefinition {
  name: string;
  schedule: string;
  prompt: string;
  timeoutSeconds?: number;
  /**
   * LLM-модель в формате OpenCode (например, "anthropic/claude-3-5-sonnet",
   * "openai/gpt-4o"). Если не задана — используется модель по умолчанию OpenCode.
   */
  model?: string;
  /**
   * Приоритет задачи от 0 до 10 (10 — наивысший). Влияет на порядок запуска
   * готовых задач (catch-up и DAG-зависимости). По умолчанию — 5 (Обычный).
   */
  priority?: number;
  /**
   * Рабочая директория задачи. Если не задана, обёртка запускает задачу
   * в папке проекта (process.cwd() / директория воркспейса OpenCode),
   * благодаря чему `opencode run` подхватывает opencode.json с MCP-серверами.
   */
  workingDirectory?: string;
  /**
   * Привязка к multi-repo workspace. Если задана, cwd задачи = path workspace,
   * а workingDirectory игнорируется (с предупреждением в логе).
   */
  workspaceId?: string;
  /** @deprecated Старое имя поля; поддерживается только при чтении/импорте. */
  workdir?: string;
  /** Сколько раз повторять задачу при ошибке (0 — не повторять). */
  retryCount?: number;
  /** Задержка перед повтором в секундах. */
  retryDelay?: number;
  /** Проверочная команда, выполняемая после успешного ответа ИИ. */
  qualityGate?: string;
  /** Команда перед запуском (pre-flight). Ненулевой код отменяет задачу. */
  beforeScript?: string;
  /** Команда после запуска (post-flight). Выполняется даже при ошибке задачи. */
  afterScript?: string;
  /** Задача, запускаемая при успешном завершении этой задачи. */
  nextTaskOnSuccess?: string;
  /** Компенсирующая задача, запускаемая при ошибке этой задачи. */
  nextTaskOnError?: string;
  /**
   * DAG-зависимости: имена задач, которые должны успешно завершиться,
   * прежде чем эта задача будет запущена. Пустой массив — без зависимостей.
   */
  dependsOn?: string[];
  /**
   * Чем запускается задача: по расписанию ("cron", по умолчанию),
   * при изменении файла ("file"), по MCP-событию ("mcp-event") или
   * однократно в runAt ("once"). Для file/mcp-event/once расписание не нужно.
   */
  triggerType?: "cron" | "file" | "mcp-event" | "once";
  /** Абсолютное время однократного запуска (ISO-8601, triggerType "once"). */
  runAt?: string;
  /** Путь к файлу/папке, изменения которого запускают задачу (для triggerType === "file"). */
  watchPath?: string;
  /** Параметры MCP-события (для triggerType === "mcp-event"). */
  mcpEvent?: McpEventTrigger;
  /**
   * Ограничения инструментов (role-scoped tools): список разрешённых инструментов
   * OpenCode. Пустой массив отклоняется (нет смысла — «запрещено всё»).
   * Пока opencode run не поддерживает флаги allow/deny — metadata-only.
   */
  allowedTools?: string[];
  /** Запрещённые инструменты. При конфликте denied выигрывает у allowed. */
  deniedTools?: string[];
  /** Настройки fan-out матрицы (родитель). */
  matrix?: MatrixConfig;
  /** Для клона матрицы — имя родительской задачи-шаблона. */
  matrixParentId?: string;
  /**
   * Внутреннее поле матрицы (Спринт 17): очередь клонов, ожидающих запуска
   * из-за ограничения matrix.concurrency. Хранится в определении родителя,
   * чтобы переживать перезапуск плагина. Экспортируется как обычные данные,
   * но не входит в matrix.overrides и не используется клонами.
   */
  matrixQueue?: string[];
  /** Для родителя матрицы — true (флаг для фильтров/DAG). */
  isMatrixParent?: boolean;
  /**
   * IANA-часовой пояс задачи (Спринт 19), например "Europe/Moscow".
   * Не задан — системный пояс. Если отличается от системного, задача
   * регистрируется в poll-режиме: ОС будит её каждую минуту, а cron
   * проверяется в обёртке с учётом этого пояса.
   */
  timezone?: string;
  /** Начало окна запуска "HH:MM" (Спринт 19); вне окна запуск переносится. */
  notBefore?: string;
  /** Конец окна запуска "HH:MM"; может быть меньше notBefore (через полночь). */
  notAfter?: string;
  /** Пауза до даты (ISO, Спринт 19): плагин включит задачу автоматически. */
  pausedUntil?: string;
  /** Когда задача была создана — защита от ложного catch-up сразу после создания. */
  createdAt?: string;
}

const PREFIX = "\\OpenCode\\windows-scheduler\\";

/** Приоритет по умолчанию — «Обычный». */
export const DEFAULT_PRIORITY = 5;
/** Максимальный приоритет (10 — «Критический»). */
export const MAX_PRIORITY = 10;

/**
 * Приводит приоритет к целому числу 0..10.
 * Возвращает undefined, если значение не задано или не является числом.
 */
export function normalizePriority(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(MAX_PRIORITY, Math.max(0, Math.floor(value)));
}

/** Человекочитаемая подпись приоритета для GUI/дашборда. */
export function priorityLabel(priority?: number): string {
  const value = normalizePriority(priority) ?? DEFAULT_PRIORITY;
  if (value >= 10) return "Критический";
  if (value >= 8) return "Высокий";
  if (value <= 3) return "Низкий";
  return "Обычный";
}

/**
 * Читает определения задач из SQLite.
 * Сигнатура сохранена: вызывающий код не знает, JSON это или БД.
 */
export async function loadTaskDefinitions(): Promise<TaskDefinition[]> {
  return listTasks();
}

/** Добавляет или обновляет определение задачи (сравнение по имени без учёта регистра). */
export async function saveTaskDefinition(definition: TaskDefinition): Promise<void> {
  saveTask(definition);
}

/** Удаляет определение задачи из хранилища. */
export async function removeTaskDefinition(name: string): Promise<void> {
  deleteTask(name);
}

/** Убирает префикс папки плагина из полного имени задачи. */
export function stripTaskPrefix(fullName: string): string {
  return fullName.startsWith(PREFIX) ? fullName.slice(PREFIX.length) : fullName;
}

/**
 * Собирает JSON для экспорта.
 *
 * Расписание и промпт берутся из tasks.json; для задач, созданных до появления
 * хранилища, промпт подхватывается из файла prompts/<sanitized>.txt.
 * Если расписания нет, оно останется пустым — импорт такую запись пропустит.
 */
export async function buildExportJson(
  tasks: ScheduledTaskInfo[]
): Promise<{ data: string; count: number }> {
  const definitions = await loadTaskDefinitions();
  const byName = new Map(
    definitions.map((item) => [item.name.toLowerCase(), item])
  );

  const exported: TaskDefinition[] = [];
  for (const task of tasks) {
    const name = stripTaskPrefix(task.taskName ?? "");
    if (!name) continue;

    const definition = byName.get(name.toLowerCase());

    let prompt = definition?.prompt ?? "";
    if (!prompt) {
      try {
        prompt = (
          await fs.readFile(
            path.join(PLUGIN_DIR, "prompts", `${sanitizeName(name)}.txt`),
            "utf8"
          )
        ).replace(/^\uFEFF/, "");
      } catch {
        // Промпт не найден — экспортируем пустой, импорт пропустит запись.
      }
    }

    exported.push({
      name,
      schedule: definition?.schedule ?? "",
      prompt,
      ...(definition?.timeoutSeconds !== undefined
        ? { timeoutSeconds: definition.timeoutSeconds }
        : {}),
      ...(definition?.model ? { model: definition.model } : {}),
      ...(definition?.priority !== undefined
        ? { priority: definition.priority }
        : {}),
      ...(definition?.workingDirectory
        ? { workingDirectory: definition.workingDirectory }
        : {}),
      ...(definition?.workspaceId ? { workspaceId: definition.workspaceId } : {}),
      ...(definition?.retryCount !== undefined
        ? { retryCount: definition.retryCount }
        : {}),
      ...(definition?.retryDelay !== undefined
        ? { retryDelay: definition.retryDelay }
        : {}),
      ...(definition?.qualityGate ? { qualityGate: definition.qualityGate } : {}),
      ...(definition?.beforeScript ? { beforeScript: definition.beforeScript } : {}),
      ...(definition?.afterScript ? { afterScript: definition.afterScript } : {}),
      ...(definition?.nextTaskOnSuccess
        ? { nextTaskOnSuccess: definition.nextTaskOnSuccess }
        : {}),
      ...(definition?.nextTaskOnError
        ? { nextTaskOnError: definition.nextTaskOnError }
        : {}),
      ...(Array.isArray(definition?.dependsOn) && definition.dependsOn.length > 0
        ? { dependsOn: definition.dependsOn }
        : {}),
      ...(definition?.triggerType === "file" ? { triggerType: "file" as const } : {}),
      ...(definition?.triggerType === "mcp-event"
        ? { triggerType: "mcp-event" as const }
        : {}),
      ...(definition?.triggerType === "once"
        ? {
            triggerType: "once" as const,
            ...(definition.runAt ? { runAt: definition.runAt } : {}),
          }
        : {}),
      ...(definition?.watchPath ? { watchPath: definition.watchPath } : {}),
      ...(definition?.timezone ? { timezone: definition.timezone } : {}),
      ...(definition?.notBefore ? { notBefore: definition.notBefore } : {}),
      ...(definition?.notAfter ? { notAfter: definition.notAfter } : {}),
      ...(definition?.pausedUntil ? { pausedUntil: definition.pausedUntil } : {}),
      ...(Array.isArray(definition?.allowedTools) && definition.allowedTools.length > 0
        ? { allowedTools: definition.allowedTools }
        : {}),
      ...(Array.isArray(definition?.deniedTools) && definition.deniedTools.length > 0
        ? { deniedTools: definition.deniedTools }
        : {}),
      ...(definition?.matrix &&
      Array.isArray(definition.matrix.workspaceIds) &&
      definition.matrix.workspaceIds.length > 0
        ? { matrix: definition.matrix }
        : {}),
      ...(definition?.matrixParentId
        ? { matrixParentId: definition.matrixParentId }
        : {}),
      ...(definition?.mcpEvent &&
      definition.mcpEvent.event &&
      definition.mcpEvent.server
        ? {
            mcpEvent: {
              server: definition.mcpEvent.server,
              event: definition.mcpEvent.event,
              ...(definition.mcpEvent.filter
                ? { filter: definition.mcpEvent.filter }
                : {}),
            },
          }
        : {}),
    });
  }

  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    tasks: exported,
  };

  return { data: JSON.stringify(payload, null, 2), count: exported.length };
}

export interface ParsedImport {
  tasks: TaskDefinition[];
  errors: string[];
}

/**
 * Разбирает файл импорта. Поддерживает как { tasks: [...] }, так и просто массив.
 * Ошибки отдельных записей не прерывают импорт остальных.
 */
export function parseImportJson(raw: string): ParsedImport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: any) {
    throw new Error(
      `Файл не является корректным JSON: ${err?.message ?? String(err)}`
    );
  }

  const list = Array.isArray(parsed)
    ? parsed
    : (parsed as { tasks?: unknown } | null)?.tasks;

  if (!Array.isArray(list)) {
    throw new Error("В файле нет массива задач (ожидается поле tasks).");
  }
  if (list.length === 0) {
    throw new Error("В файле нет задач для импорта.");
  }

  const tasks: TaskDefinition[] = [];
  const errors: string[] = [];

  list.forEach((item, index) => {
    const position = index + 1;
    if (!item || typeof item !== "object") {
      errors.push(`Запись ${position}: ожидался объект.`);
      return;
    }

    const source = item as Record<string, unknown>;
    const name = typeof source.name === "string" ? source.name.trim() : "";
    const schedule =
      typeof source.schedule === "string" ? source.schedule.trim() : "";
    const prompt = typeof source.prompt === "string" ? source.prompt.trim() : "";
    const triggerType: "cron" | "file" | "mcp-event" | "once" =
      source.triggerType === "file"
        ? "file"
        : source.triggerType === "mcp-event"
        ? "mcp-event"
        : source.triggerType === "once"
        ? "once"
        : "cron";
    const watchPath =
      typeof source.watchPath === "string" ? source.watchPath.trim() : "";
    const rawRunAt =
      typeof source.runAt === "string" ? source.runAt.trim() : "";
    const rawDelaySeconds =
      typeof source.delaySeconds === "number" ? source.delaySeconds : undefined;

    const rawMcpEvent =
      source.mcpEvent && typeof source.mcpEvent === "object"
        ? (source.mcpEvent as Record<string, unknown>)
        : undefined;
    const mcpEvent: McpEventTrigger | undefined =
      rawMcpEvent &&
      typeof rawMcpEvent.event === "string" &&
      rawMcpEvent.event.trim()
        ? {
            server:
              typeof rawMcpEvent.server === "string"
                ? rawMcpEvent.server.trim()
                : "",
            event: rawMcpEvent.event.trim(),
            ...(typeof rawMcpEvent.filter === "string" && rawMcpEvent.filter.trim()
              ? { filter: rawMcpEvent.filter.trim() }
              : {}),
          }
        : undefined;

    // Для файлового/MCP-триггера расписание не нужно.
    // Клоны матрицы (matrixParentId) запускаются только через runMatrix(),
    // поэтому watchPath для файлового триггера им не требуется.
    const matrixParentHint =
      typeof source.matrixParentId === "string" ? source.matrixParentId.trim() : "";
    const scheduleOk = triggerType === "cron" ? Boolean(schedule) : true;
    const watchOk =
      triggerType === "file" ? Boolean(watchPath) || Boolean(matrixParentHint) : true;
    const eventOk = triggerType === "mcp-event" ? Boolean(mcpEvent?.event) : true;
    const onceOk =
      triggerType === "once" ? Boolean(rawRunAt) || rawDelaySeconds !== undefined : true;

    if (!name || !scheduleOk || !watchOk || !eventOk || !onceOk || !prompt) {
      errors.push(
        `Запись ${position}${name ? ` (${name})` : ""}: нужны непустые поля name и prompt` +
          (triggerType === "file"
            ? ", а также watchPath для файлового триггера."
            : triggerType === "mcp-event"
            ? ", а также mcpEvent.event для MCP-триггера."
            : triggerType === "once"
            ? ", а также runAt или delaySeconds для one-shot."
            : ", а также schedule.")
      );
      return;
    }

    let runAt: string | undefined;
    if (triggerType === "once") {
      const normalized = normalizeOneShotRunAt({
        runAt: rawRunAt || undefined,
        delaySeconds: rawDelaySeconds,
      });
      if (!normalized.ok) {
        errors.push(
          `Запись ${position}${name ? ` (${name})` : ""}: ${normalized.error}`
        );
        return;
      }
      runAt = normalized.runAt;
    }

    const timeoutSeconds =
      typeof source.timeoutSeconds === "number" &&
      Number.isFinite(source.timeoutSeconds) &&
      source.timeoutSeconds > 0
        ? Math.floor(source.timeoutSeconds)
        : undefined;

    // Новое поле workingDirectory; workdir читаем для обратной совместимости.
    const workingDirectory =
      typeof source.workingDirectory === "string" && source.workingDirectory.trim()
        ? source.workingDirectory.trim()
        : typeof source.workdir === "string" && source.workdir.trim()
        ? source.workdir.trim()
        : undefined;

    const retryCount =
      typeof source.retryCount === "number" &&
      Number.isFinite(source.retryCount) &&
      source.retryCount > 0
        ? Math.floor(source.retryCount)
        : undefined;

    const retryDelay =
      typeof source.retryDelay === "number" &&
      Number.isFinite(source.retryDelay) &&
      source.retryDelay > 0
        ? Math.floor(source.retryDelay)
        : undefined;

    const readOptionalString = (value: unknown): string | undefined =>
      typeof value === "string" && value.trim() ? value.trim() : undefined;

    const qualityGate = readOptionalString(source.qualityGate);
    const beforeScript = readOptionalString(source.beforeScript);
    const afterScript = readOptionalString(source.afterScript);
    const nextTaskOnSuccess = readOptionalString(source.nextTaskOnSuccess);
    const nextTaskOnError = readOptionalString(source.nextTaskOnError);
    const model = readOptionalString(source.model);
    const priority = normalizePriority(source.priority);
    const workspaceId = readOptionalString(source.workspaceId);

    // Планирование 2.0 (Спринт 19): IANA-зона, окно запуска, пауза до даты.
    const timezone = readOptionalString(source.timezone);
    if (timezone && !isValidIanaTimeZone(timezone)) {
      errors.push(
        `Запись ${position}${name ? ` (${name})` : ""}: неизвестный часовой пояс ` +
          `«${timezone}» (нужна IANA-зона, например Europe/Moscow).`
      );
    }
    const notBefore = readOptionalString(source.notBefore);
    const notAfter = readOptionalString(source.notAfter);
    const windowError = validateLaunchWindow(notBefore, notAfter);
    if (windowError) {
      errors.push(`Запись ${position}${name ? ` (${name})` : ""}: ${windowError}`);
    }
    const pausedUntil = readOptionalString(source.pausedUntil);
    if (pausedUntil && Number.isNaN(Date.parse(pausedUntil))) {
      errors.push(
        `Запись ${position}${name ? ` (${name})` : ""}: pausedUntil должен быть ` +
          `датой в формате ISO (например 2026-12-01T09:00:00Z).`
      );
    }

    // Ограничения инструментов (Спринт 14): массив непустых строк без дублей.
    // Пустой allowedTools отклоняется с явной ошибкой (избегаем «запрещено всё»).
    const readToolList = (raw: unknown, fieldLabel: string): string[] | undefined | "empty" => {
      if (raw === undefined || raw === null) return undefined;
      if (!Array.isArray(raw)) {
        errors.push(`Запись ${position}${name ? ` (${name})` : ""}: ${fieldLabel} должен быть массивом строк.`);
        return undefined;
      }
      const seen = new Set<string>();
      const list: string[] = [];
      for (const value of raw) {
        if (typeof value !== "string") continue;
        const tool = value.trim();
        if (!tool || seen.has(tool.toLowerCase())) continue;
        seen.add(tool.toLowerCase());
        list.push(tool);
      }
      if (list.length === 0) return "empty";
      return list;
    };

    const allowedRaw = readToolList(source.allowedTools, "allowedTools");
    const deniedRaw = readToolList(source.deniedTools, "deniedTools");
    let allowedTools: string[] | undefined;
    let deniedTools: string[] | undefined;
    if (allowedRaw !== undefined) {
      if (allowedRaw === "empty") {
        errors.push(
          `Запись ${position}${name ? ` (${name})` : ""}: пустой allowedTools запрещён — ` +
            `задайте список инструментов или уберите поле.`
        );
      } else {
        allowedTools = allowedRaw;
      }
    }
    if (deniedRaw !== undefined && deniedRaw !== "empty") {
      deniedTools = deniedRaw;
    }

    // Matrix (fan-out, Спринт 15): список workspace id + стратегия.
    // Одновременно workspaceId и matrix.workspaceIds использовать нельзя.
    let matrix: MatrixConfig | undefined;
    const rawMatrix = (source as { matrix?: unknown }).matrix;
    if (rawMatrix !== undefined && rawMatrix !== null) {
      const label = `Запись ${position}${name ? ` (${name})` : ""}`;
      if (typeof rawMatrix !== "object" || Array.isArray(rawMatrix)) {
        errors.push(`${label}: matrix должен быть объектом.`);
      } else {
        const candidate = rawMatrix as Record<string, unknown>;
        if (workspaceId) {
          errors.push(
            `${label}: нельзя одновременно workspaceId и matrix.workspaceIds.`
          );
        } else {
          const idsRaw = candidate.workspaceIds;
          if (!Array.isArray(idsRaw)) {
            errors.push(`${label}: matrix.workspaceIds должен быть массивом строк.`);
          } else {
            const seen = new Set<string>();
            const ids: string[] = [];
            for (const value of idsRaw) {
              if (typeof value !== "string") continue;
              const id = value.trim();
              if (!id || seen.has(id.toLowerCase())) continue;
              seen.add(id.toLowerCase());
              ids.push(id);
            }
            if (ids.length === 0) {
              errors.push(`${label}: matrix.workspaceIds не может быть пустым.`);
            } else {
              const strategy =
                candidate.strategy === "sequential" ? "sequential" : "parallel";
              const failureMode =
                candidate.failureMode === "stop" ? "stop" : "continue";
              const aggregation =
                candidate.aggregation === "per-task" ? "per-task" : "summary";

              // Спринт 17: ограничение параллелизма и per-workspace настройки.
              let concurrency: number | undefined;
              if (candidate.concurrency !== undefined && candidate.concurrency !== null) {
                if (
                  typeof candidate.concurrency !== "number" ||
                  !Number.isFinite(candidate.concurrency) ||
                  candidate.concurrency < 1
                ) {
                  errors.push(
                    `${label}: matrix.concurrency должен быть числом не меньше 1.`
                  );
                } else {
                  concurrency = Math.floor(candidate.concurrency);
                }
              }

              let overrides: Record<string, MatrixWorkspaceOverride> | undefined;
              const rawOverrides = candidate.overrides;
              if (rawOverrides !== undefined && rawOverrides !== null) {
                if (typeof rawOverrides !== "object" || Array.isArray(rawOverrides)) {
                  errors.push(`${label}: matrix.overrides должен быть объектом.`);
                } else {
                  const allowed = new Set(ids);
                  const parsedOverrides: Record<string, MatrixWorkspaceOverride> = {};
                  for (const [key, value] of Object.entries(
                    rawOverrides as Record<string, unknown>
                  )) {
                    const workspaceKey = key.trim();
                    if (!workspaceKey || !allowed.has(workspaceKey)) {
                      errors.push(
                        `${label}: matrix.overrides содержит workspace "${workspaceKey}", ` +
                          `которого нет в workspaceIds.`
                      );
                      continue;
                    }
                    if (typeof value !== "object" || value === null || Array.isArray(value)) {
                      errors.push(
                        `${label}: matrix.overrides["${workspaceKey}"] должен быть объектом.`
                      );
                      continue;
                    }
                    const raw = value as Record<string, unknown>;
                    const override: MatrixWorkspaceOverride = {};
                    for (const field of [
                      "prompt",
                      "model",
                      "qualityGate",
                      "beforeScript",
                      "afterScript",
                    ] as const) {
                      const stringValue = readOptionalString(raw[field]);
                      if (stringValue !== undefined) override[field] = stringValue;
                    }
                    if (Object.keys(override).length > 0) {
                      parsedOverrides[workspaceKey] = override;
                    }
                  }
                  if (Object.keys(parsedOverrides).length > 0) {
                    overrides = parsedOverrides;
                  }
                }
              }

              matrix = {
                workspaceIds: ids,
                strategy,
                failureMode,
                aggregation,
                ...(candidate.createAggregator === true
                  ? { createAggregator: true }
                  : {}),
                ...(concurrency !== undefined ? { concurrency } : {}),
                ...(overrides !== undefined ? { overrides } : {}),
              };
            }
          }
        }
      }
    }
    const matrixParentId = readOptionalString(
      (source as { matrixParentId?: unknown }).matrixParentId
    );

    // DAG-зависимости: массив непустых имён без дублей (сравнение без регистра).
    let dependsOn: string[] | undefined;
    if (Array.isArray(source.dependsOn)) {
      const seen = new Set<string>();
      const deps: string[] = [];
      for (const value of source.dependsOn) {
        if (typeof value !== "string") continue;
        const dep = value.trim();
        if (!dep || seen.has(dep.toLowerCase())) continue;
        seen.add(dep.toLowerCase());
        deps.push(dep);
      }
      if (deps.length > 0) dependsOn = deps;
    }

    tasks.push({
      name,
      schedule,
      prompt,
      ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(priority !== undefined ? { priority } : {}),
      ...(workingDirectory !== undefined ? { workingDirectory } : {}),
      ...(workspaceId !== undefined ? { workspaceId } : {}),
      ...(retryCount !== undefined ? { retryCount } : {}),
      ...(retryDelay !== undefined ? { retryDelay } : {}),
      ...(qualityGate !== undefined ? { qualityGate } : {}),
      ...(beforeScript !== undefined ? { beforeScript } : {}),
      ...(afterScript !== undefined ? { afterScript } : {}),
      ...(nextTaskOnSuccess !== undefined ? { nextTaskOnSuccess } : {}),
      ...(nextTaskOnError !== undefined ? { nextTaskOnError } : {}),
      ...(dependsOn !== undefined ? { dependsOn } : {}),
      ...(triggerType === "cron" ? {} : { triggerType }),
      ...(runAt ? { runAt } : {}),
      ...(watchPath ? { watchPath } : {}),
      ...(timezone !== undefined ? { timezone } : {}),
      ...(notBefore !== undefined ? { notBefore } : {}),
      ...(notAfter !== undefined ? { notAfter } : {}),
      ...(pausedUntil !== undefined ? { pausedUntil } : {}),
      ...(mcpEvent ? { mcpEvent } : {}),
      ...(allowedTools !== undefined ? { allowedTools } : {}),
      ...(deniedTools !== undefined ? { deniedTools } : {}),
      ...(matrix !== undefined ? { matrix } : {}),
      ...(matrixParentId !== undefined ? { matrixParentId } : {}),
    });
  });

  return { tasks, errors };
}
