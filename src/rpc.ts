import { Rpc } from "@opencode/plugin/rpc"

/**
 * Общее определение RPC-контракта между серверной частью плагина (src/index.ts)
 * и GUI-панелью (src/gui.tsx).
 *
 * Сервер регистрирует обработчики через ctx.rpc.register(SchedulerRpc, handlers).
 * GUI вызывает методы через ctx.client.rpc(SchedulerRpc).<имя>(аргументы).
 *
 * Схемы ввода/вывода — чистый JSON Schema (не Zod), чтобы сервер мог
 * надёжно кодировать/декодировать ответы через RPC-мост.
 */

/** Параметры MCP-события (triggerType === "mcp-event"). */
const McpEventSchema = {
  type: ["object", "null"] as const,
  properties: {
    server: { type: "string" },
    event: { type: "string" },
    filter: { type: "string" },
  },
  required: ["server", "event"],
} as const;

/** Настройки matrix (fan-out, Спринт 15). */
const MatrixSchema = {
  type: ["object", "null"] as const,
  properties: {
    workspaceIds: { type: "array", items: { type: "string" } },
    strategy: { type: ["string", "null"] },
    failureMode: { type: ["string", "null"] },
    aggregation: { type: ["string", "null"] },
    createAggregator: { type: ["boolean", "null"] },
    /** Лимит одновременных клонов матрицы (Спринт 17). */
    concurrency: { type: ["number", "null"] },
    /** Per-workspace переопределения промпта/модели/хуков/QG (Спринт 17). */
    overrides: {
      type: ["object", "null"],
      additionalProperties: {
        type: "object",
        properties: {
          prompt: { type: ["string", "null"] },
          model: { type: ["string", "null"] },
          qualityGate: { type: ["string", "null"] },
          beforeScript: { type: ["string", "null"] },
          afterScript: { type: ["string", "null"] },
        },
      },
    },
  },
  required: ["workspaceIds"],
} as const;

/** Запись задачи, возвращаемая get_tasks. */
const TaskItem = {
  type: "object" as const,
  properties: {
    name: { type: "string" },
    schedule: { type: "string" },
    status: { type: "string" },
    nextRun: { type: ["string", "null"] },
    /** LLM-модель задачи (null — модель OpenCode по умолчанию). */
    model: { type: ["string", "null"] },
    /** Приоритет задачи 0..10 (10 — наивысший). */
    priority: { type: ["number", "null"] },
    /** Количество повторов при ошибке (опционально). */
    retryCount: { type: ["number", "null"] },
    /** Задержка перед повтором в секундах (опционально). */
    retryDelay: { type: ["number", "null"] },
    /** Проверочная команда после успешного ответа ИИ. */
    qualityGate: { type: ["string", "null"] },
    /** Задача, запускаемая при успехе. */
    nextTaskOnSuccess: { type: ["string", "null"] },
    /** Компенсирующая задача, запускаемая при ошибке. */
    nextTaskOnError: { type: ["string", "null"] },
    /** DAG-зависимости: задачи, которые должны успешно завершиться раньше этой. */
    dependsOn: { type: "array", items: { type: "string" } },
    /** Промпт задачи (для заполнения формы редактирования). */
    prompt: { type: "string" },
    /** Pre-flight команда (null — не задана). */
    beforeScript: { type: ["string", "null"] },
    /** Post-flight команда (null — не задана). */
    afterScript: { type: ["string", "null"] },
    /** Тип триггера: "cron" (по умолчанию), "file" или "mcp-event". */
    triggerType: { type: ["string", "null"] },
    /** Параметры MCP-события (null — не MCP-триггер). */
    mcpEvent: McpEventSchema,
    /** Путь к файлу/папке для файлового триггера. */
    watchPath: { type: ["string", "null"] },
    /** Рабочая директория задачи (null — папка проекта по умолчанию). */
    workingDirectory: { type: ["string", "null"] },
    /** Привязка к multi-repo workspace (null — без workspace). */
    workspaceId: { type: ["string", "null"] },
    /** Имя workspace для отображения (null — без workspace). */
    workspaceName: { type: ["string", "null"] },
    /** Цвет маркера workspace. */
    workspaceColor: { type: ["string", "null"] },
    /** Белый список инструментов задачи (role-scoped, null — без ограничений). */
    allowedTools: { type: ["array", "null"], items: { type: "string" } },
    /** Чёрный список инструментов задачи (приоритет над allowedTools). */
    deniedTools: { type: ["array", "null"], items: { type: "string" } },
    /** Matrix-настройки родителя (null — обычная задача). */
    matrix: MatrixSchema,
    /** Для клона матрицы — имя родителя (null — не клон). */
    matrixParentId: { type: ["string", "null"] },
    /** true — задача является родителем матрицы. */
    isMatrixParent: { type: "boolean" },
    /** Агрегат по клонам для родителя (null — не матрица). */
    matrixSummary: {
      type: ["object", "null"],
      properties: {
        totalCount: { type: "number" },
        successCount: { type: "number" },
        errorCount: { type: "number" },
        pendingCount: { type: "number" },
        status: { type: "string" },
        message: { type: "string" },
      },
    },
  },
  required: ["name", "schedule", "status"],
} as const;

const GetTasksInput = {
  type: "object" as const,
  properties: {},
  additionalProperties: false,
} as const;

const GetTasksOutput = {
  type: "object" as const,
  properties: {
    tasks: {
      type: "array",
      items: TaskItem,
    },
  },
  required: ["tasks"],
} as const;

const CreateTaskInput = {
  type: "object" as const,
  properties: {
    name: { type: "string" },
    schedule: { type: "string" },
    prompt: { type: "string" },
    /** LLM-модель (например, anthropic/claude-3-5-sonnet). */
    model: { type: "string" },
    /** Приоритет задачи 0..10 (10 — наивысший). */
    priority: { type: "number" },
    /** Сколько раз повторять при ошибке (по умолчанию 0). */
    retryCount: { type: "number" },
    /** Задержка перед повтором в секундах (по умолчанию 60). */
    retryDelay: { type: "number" },
    /** Проверочная команда (Quality Gate), выполняется после успешного ответа ИИ. */
    qualityGate: { type: "string" },
    /** Имя задачи, запускаемой при успехе. */
    nextTaskOnSuccess: { type: "string" },
    /** Имя компенсирующей задачи, запускаемой при ошибке. */
    nextTaskOnError: { type: "string" },
    /** DAG-зависимости: задачи, которые должны успешно завершиться раньше этой. */
    dependsOn: { type: "array", items: { type: "string" } },
    /** Команда перед запуском (pre-flight). */
    beforeScript: { type: "string" },
    /** Команда после запуска (post-flight). */
    afterScript: { type: "string" },
    /** Тип триггера: "cron" (по умолчанию), "file" или "mcp-event". */
    triggerType: { type: "string" },
    /** Параметры MCP-события. */
    mcpEvent: McpEventSchema,
    /** Путь к файлу/папке для файлового триггера. */
    watchPath: { type: "string" },
    /** Привязка к multi-repo workspace. */
    workspaceId: { type: "string" },
    /** Рабочая директория задачи (по умолчанию — папка проекта). */
    workingDirectory: { type: "string" },
    /** Белый список инструментов задачи (role-scoped, metadata-only). Пустой массив запрещён. */
    allowedTools: { type: "array", items: { type: "string" } },
    /** Чёрный список инструментов задачи (приоритет над allowedTools). Metadata-only. */
    deniedTools: { type: "array", items: { type: "string" } },
    /** Matrix (fan-out): раскладывает задачу-шаблон на клоны по workspace. */
    matrix: MatrixSchema,
  },
  required: ["name", "schedule", "prompt"],
} as const;

const CreateTaskOutput = {
  type: "object" as const,
  properties: {
    success: { type: "boolean" },
    message: { type: "string" },
  },
  required: ["success", "message"],
} as const;

const NameOnly = {
  type: "object" as const,
  properties: {
    name: { type: "string" },
  },
  required: ["name"],
} as const;

const DeleteTaskInput = NameOnly;
const RunTaskInput = NameOnly;

const DeleteTaskOutput = {
  type: "object" as const,
  properties: {
    success: { type: "boolean" },
    message: { type: "string" },
  },
  required: ["success", "message"],
} as const;

const RunTaskOutput = DeleteTaskOutput;

const GetTaskLogsInput = NameOnly;

const GetTaskLogsOutput = {
  type: "object" as const,
  properties: {
    success: { type: "boolean" },
    logs: { type: "string" },
    error: { type: "string" },
  },
  required: ["success", "logs"],
} as const;

const HistoryRecord = {
  type: "object" as const,
  properties: {
    taskName: { type: "string" },
    status: { type: "string" },
    startedAt: { type: "string" },
    finishedAt: { type: "string" },
    durationMs: { type: "number" },
    error: { type: ["string", "null"] },
    nextTask: { type: ["string", "null"] },
    /** LLM-модель, использованная в запуске. */
    model: { type: ["string", "null"] },
    /** Итог pre-flight: success / error / skipped. */
    preFlightStatus: { type: ["string", "null"] },
    /** Итог post-flight: success / error / skipped. */
    postFlightStatus: { type: ["string", "null"] },
    /** Ограничения инструментов, действовавшие на момент запуска. */
    allowedTools: { type: ["array", "null"], items: { type: "string" } },
    deniedTools: { type: ["array", "null"], items: { type: "string" } },
  },
  required: ["taskName", "status", "startedAt", "finishedAt", "durationMs", "error"],
} as const;

const GetHistoryInput = {
  type: "object" as const,
  properties: {
    limit: { type: "number" },
  },
  additionalProperties: false,
} as const;

const GetHistoryOutput = {
  type: "object" as const,
  properties: {
    records: {
      type: "array",
      items: HistoryRecord,
    },
  },
  required: ["records"],
} as const;

const Metrics = {
  type: "object" as const,
  properties: {
    total: { type: "number" },
    success: { type: "number" },
    error: { type: "number" },
  },
  required: ["total", "success", "error"],
} as const;

const GetMetricsInput = {
  type: "object" as const,
  properties: {},
  additionalProperties: false,
} as const;

const GetMetricsOutput = Metrics;

const GetDashboardPortInput = {
  type: "object" as const,
  properties: {},
  additionalProperties: false,
} as const;

const GetDashboardPortOutput = {
  type: "object" as const,
  properties: {
    /** Фактический порт дашборда (null, если сервер ещё не поднялся). */
    port: { type: ["number", "null"] },
  },
  required: ["port"],
} as const;

const GetPlatformInput = {
  type: "object" as const,
  properties: {},
  additionalProperties: false,
} as const;

const GetPlatformOutput = {
  type: "object" as const,
  properties: {
    /** process.platform: 'win32' | 'darwin' | 'linux' | ... */
    platform: { type: "string" },
    /** Название планировщика для заголовка GUI. */
    title: { type: "string" },
  },
  required: ["platform", "title"],
} as const;

const ExportTasksInput = {
  type: "object" as const,
  properties: {},
  additionalProperties: false,
} as const;

const ExportTasksOutput = {
  type: "object" as const,
  properties: {
    success: { type: "boolean" },
    data: { type: "string" },
    count: { type: "number" },
    error: { type: "string" },
  },
  required: ["success"],
} as const;

const ImportTasksInput = {
  type: "object" as const,
  properties: {
    data: { type: "string" },
  },
  required: ["data"],
} as const;

const ImportTasksOutput = {
  type: "object" as const,
  properties: {
    success: { type: "boolean" },
    imported: { type: "number" },
    errors: { type: "array", items: { type: "string" } },
    error: { type: "string" },
  },
  required: ["success"],
} as const;

const GetSettingsInput = {
  type: "object" as const,
  properties: {},
  additionalProperties: false,
} as const;

/** Настройки уведомлений: webhook (Discord/Slack/generic). */
const NotificationSettingsSchema = {
  type: "object" as const,
  properties: {
    enabled: { type: "boolean" },
    onlyOnError: { type: "boolean" },
    webhook: {
      type: "object" as const,
      properties: {
        enabled: { type: "boolean" },
        url: { type: "string" },
      },
      required: ["enabled", "url"],
    },
  },
  required: ["enabled", "onlyOnError"],
} as const;

const GetSettingsOutput = {
  type: "object" as const,
  properties: {
    maxConcurrent: { type: "number" },
    winterMode: { type: "boolean" },
    notifications: NotificationSettingsSchema,
  },
  required: ["maxConcurrent", "winterMode", "notifications"],
} as const;

const SaveSettingsInput = {
  type: "object" as const,
  properties: {
    maxConcurrent: { type: "number" },
    winterMode: { type: "boolean" },
    notifications: NotificationSettingsSchema,
  },
  additionalProperties: false,
} as const;

const SaveSettingsOutput = {
  type: "object" as const,
  properties: {
    success: { type: "boolean" },
    maxConcurrent: { type: "number" },
    winterMode: { type: "boolean" },
    notifications: NotificationSettingsSchema,
  },
  required: ["success", "maxConcurrent", "winterMode", "notifications"],
} as const;

const TestNotificationInput = {
  type: "object" as const,
  properties: {},
  additionalProperties: false,
} as const;

const TestNotificationOutput = {
  type: "object" as const,
  properties: {
    success: { type: "boolean" },
    message: { type: "string" },
  },
  required: ["success", "message"],
} as const;

const TemplateItem = {
  type: "object" as const,
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    prompt: { type: "string" },
    schedule: { type: "string" },
    timeoutSeconds: { type: "number" },
    /** LLM-модель шаблона. */
    model: { type: "string" },
    /** Приоритет задачи 0..10. */
    priority: { type: "number" },
    retryCount: { type: "number" },
    retryDelay: { type: "number" },
    qualityGate: { type: "string" },
    nextTaskOnSuccess: { type: "string" },
    nextTaskOnError: { type: "string" },
    /** DAG-зависимости: задачи, которые должны успешно завершиться раньше этой. */
    dependsOn: { type: "array", items: { type: "string" } },
    beforeScript: { type: "string" },
    afterScript: { type: "string" },
    triggerType: { type: "string" },
    mcpEvent: McpEventSchema,
    watchPath: { type: "string" },
    workspaceId: { type: "string" },
    workingDirectory: { type: "string" },
    /** Белый список инструментов задачи (role-scoped, metadata-only). */
    allowedTools: { type: "array", items: { type: "string" } },
    /** Чёрный список инструментов задачи (приоритет над allowedTools). */
    deniedTools: { type: "array", items: { type: "string" } },
  },
  required: ["id", "name", "prompt"],
} as const;

const GetTemplatesInput = {
  type: "object" as const,
  properties: {},
  additionalProperties: false,
} as const;

const GetTemplatesOutput = {
  type: "object" as const,
  properties: {
    templates: {
      type: "array",
      items: TemplateItem,
    },
  },
  required: ["templates"],
} as const;

const SaveTemplateInput = {
  type: "object" as const,
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    prompt: { type: "string" },
    schedule: { type: "string" },
    timeoutSeconds: { type: "number" },
    /** LLM-модель шаблона. */
    model: { type: "string" },
    /** Приоритет задачи 0..10. */
    priority: { type: "number" },
    retryCount: { type: "number" },
    retryDelay: { type: "number" },
    qualityGate: { type: "string" },
    nextTaskOnSuccess: { type: "string" },
    nextTaskOnError: { type: "string" },
    /** DAG-зависимости: задачи, которые должны успешно завершиться раньше этой. */
    dependsOn: { type: "array", items: { type: "string" } },
    beforeScript: { type: "string" },
    afterScript: { type: "string" },
    triggerType: { type: "string" },
    mcpEvent: McpEventSchema,
    watchPath: { type: "string" },
    workspaceId: { type: "string" },
    workingDirectory: { type: "string" },
    /** Белый список инструментов шаблона (role-scoped). */
    allowedTools: { type: "array", items: { type: "string" } },
    /** Чёрный список инструментов шаблона. */
    deniedTools: { type: "array", items: { type: "string" } },
  },
  required: ["name", "prompt"],
  additionalProperties: false,
} as const;

const SaveTemplateOutput = {
  type: "object" as const,
  properties: {
    success: { type: "boolean" },
    template: TemplateItem,
    error: { type: "string" },
  },
  required: ["success"],
} as const;

const DeleteTemplateInput = {
  type: "object" as const,
  properties: {
    id: { type: "string" },
  },
  required: ["id"],
} as const;

const DeleteTemplateOutput = {
  type: "object" as const,
  properties: {
    success: { type: "boolean" },
    error: { type: "string" },
  },
  required: ["success"],
} as const;

const PauseResumeInput = NameOnly;

const UpdateTaskInput = {
  type: "object" as const,
  properties: {
    name: { type: "string" },
    newSchedule: { type: "string" },
    newPrompt: { type: "string" },
    /** LLM-модель задачи. */
    model: { type: "string" },
    /** Приоритет задачи 0..10. */
    priority: { type: "number" },
    retryCount: { type: "number" },
    retryDelay: { type: "number" },
    qualityGate: { type: "string" },
    nextTaskOnSuccess: { type: "string" },
    nextTaskOnError: { type: "string" },
    /** DAG-зависимости: задачи, которые должны успешно завершиться раньше этой. */
    dependsOn: { type: "array", items: { type: "string" } },
    /** Команда перед запуском (pre-flight). */
    beforeScript: { type: "string" },
    /** Команда после запуска (post-flight). */
    afterScript: { type: "string" },
    /** Тип триггера: "cron" (по умолчанию), "file" или "mcp-event". */
    triggerType: { type: "string" },
    /** Параметры MCP-события. */
    mcpEvent: McpEventSchema,
    /** Путь к файлу/папке для файлового триггера. */
    watchPath: { type: "string" },
    /** Привязка к multi-repo workspace. */
    workspaceId: { type: "string" },
    /** Рабочая директория задачи (по умолчанию — папка проекта). */
    workingDirectory: { type: "string" },
    /** Белый список инструментов задачи (role-scoped). Пустой массив запрещён. */
    allowedTools: { type: "array", items: { type: "string" } },
    /** Чёрный список инструментов задачи (приоритет над allowedTools). */
    deniedTools: { type: "array", items: { type: "string" } },
    /** Matrix (fan-out): раскладывает задачу-шаблон на клоны по workspace. */
    matrix: MatrixSchema,
  },
  required: ["name"],
} as const;

const UpdateTaskOutput = DeleteTaskOutput;

const WorkspaceItem = {
  type: "object" as const,
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    path: { type: "string" },
    gitRemote: { type: ["string", "null"] },
    gitBranch: { type: ["string", "null"] },
    color: { type: ["string", "null"] },
    createdAt: { type: "string" },
  },
  required: ["id", "name", "path", "createdAt"],
} as const;

const GetWorkspacesInput = {
  type: "object" as const,
  properties: {},
  additionalProperties: false,
} as const;

const GetWorkspacesOutput = {
  type: "object" as const,
  properties: {
    workspaces: { type: "array", items: WorkspaceItem },
  },
  required: ["workspaces"],
} as const;

const AddWorkspaceInput = {
  type: "object" as const,
  properties: {
    name: { type: "string" },
    path: { type: "string" },
    color: { type: "string" },
  },
  required: ["path"],
  additionalProperties: false,
} as const;

const AddWorkspaceOutput = {
  type: "object" as const,
  properties: {
    success: { type: "boolean" },
    workspace: WorkspaceItem,
    error: { type: "string" },
  },
  required: ["success"],
} as const;

const UpdateWorkspaceInput = {
  type: "object" as const,
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    path: { type: "string" },
    color: { type: "string" },
  },
  required: ["id"],
  additionalProperties: false,
} as const;

const DeleteWorkspaceInput = {
  type: "object" as const,
  properties: {
    id: { type: "string" },
  },
  required: ["id"],
} as const;

const DeleteWorkspaceOutput = {
  type: "object" as const,
  properties: {
    success: { type: "boolean" },
    message: { type: "string" },
  },
  required: ["success"],
} as const;

const EmitEventInput = {
  type: "object" as const,
  properties: {
    /** Имя события, например github.pr.opened. */
    eventName: { type: "string" },
    /** Произвольный payload события (используется фильтрами задач). */
    payload: { type: ["object", "null", "string", "number", "boolean", "array"] },
  },
  required: ["eventName"],
} as const;

const EmitEventOutput = {
  type: "object" as const,
  properties: {
    success: { type: "boolean" },
    message: { type: "string" },
    /** Задачи, запущенные по событию (в порядке приоритета). */
    triggered: { type: "array", items: { type: "string" } },
  },
  required: ["success", "triggered"],
} as const;

const DryRunTaskItem = {
  type: "object" as const,
  properties: {
    name: { type: "string" },
    /** Порядок выполнения в конвейере (0 — первый). */
    order: { type: "number" },
    /** Триггер запуска: manual (первая в конвейере), cron или dag (по dependsOn). */
    trigger: { type: "string" },
    /** Рабочая директория, в которой будет выполнена задача. */
    cwd: { type: "string" },
    /** Команда, которую фактически выполнит обёртка (без реального запуска). */
    command: { type: "string" },
    /** Workspace задачи (null — без workspace). */
    workspace: {
      type: ["object", "null"],
      properties: {
        name: { type: "string" },
        path: { type: "string" },
      },
      required: ["name", "path"],
    },
    /** Pre-flight команда (null — не задана). */
    preFlight: { type: ["string", "null"] },
    /** Post-flight команда (null — не задана). */
    postFlight: { type: ["string", "null"] },
    /** Quality Gate (null — не задан). */
    qualityGate: { type: ["string", "null"] },
    /** Ограничения инструментов (null — без ограничений). */
    roleScoped: {
      type: ["object", "null"],
      properties: {
        allowed: { type: "array", items: { type: "string" } },
        denied: { type: "array", items: { type: "string" } },
      },
    },
    /** Оценка длительности по последним запускам (null — нет истории). */
    estimatedDurationSec: { type: ["number", "null"] },
    /** Оценка стоимости по последним запускам (null — нет истории). */
    estimatedCostUsd: { type: ["number", "null"] },
    /** Оценка токенов по последним запускам (null — нет истории). */
    estimatedTokens: { type: ["number", "null"] },
    /** Для клона матрицы — имя родителя-шаблона (Спринт 15). */
    matrixParent: { type: "string" },
  },
  required: ["name", "order", "trigger", "cwd", "command"],
} as const;

const DryRunReportOutput = {
  type: "object" as const,
  properties: {
    success: { type: "boolean" },
    taskName: { type: "string" },
    /** Упорядоченный список задач конвейера (топологический порядок зависимостей). */
    tasks: { type: "array", items: DryRunTaskItem },
    /** Суммарные оценки по всем задачам. */
    totals: {
      type: "object",
      properties: {
        estimatedDurationSec: { type: ["number", "null"] },
        estimatedCostUsd: { type: ["number", "null"] },
        estimatedTokens: { type: ["number", "null"] },
      },
      required: [],
    },
    /** Предупреждения: опасные команды, недоступные пути, отсутствие истории. */
    warnings: { type: "array", items: { type: "string" } },
    error: { type: "string" },
  },
  required: ["success", "taskName", "tasks", "warnings"],
} as const;

const DryRunInput = {
  type: "object" as const,
  properties: {
    taskName: { type: "string" },
  },
  required: ["taskName"],
  additionalProperties: false,
} as const;

const DryRunAllOutput = {
  type: "object" as const,
  properties: {
    success: { type: "boolean" },
    reports: {
      type: "array",
      items: DryRunReportOutput,
    },
  },
  required: ["success", "reports"],
} as const;

/** Детальный отчёт по одному клону матрицы. */
const MatrixCloneResult = {
  type: "object" as const,
  properties: {
    name: { type: "string" },
    workspaceId: { type: ["string", "null"] },
    workspaceName: { type: ["string", "null"] },
    /** success | error | timeout | partial | pending | running */
    status: { type: "string" },
    error: { type: ["string", "null"] },
    finishedAt: { type: ["string", "null"] },
  },
  required: ["name", "status"],
} as const;

const GetMatrixResultsInput = {
  type: "object" as const,
  properties: {
    parentId: { type: "string" },
  },
  required: ["parentId"],
  additionalProperties: false,
} as const;

const MatrixReport = {
  type: "object" as const,
  properties: {
    parentId: { type: "string" },
    totalCount: { type: "number" },
    successCount: { type: "number" },
    errorCount: { type: "number" },
    pendingCount: { type: "number" },
    /** success | error | partial | running | empty */
    status: { type: "string" },
    message: { type: "string" },
    clones: { type: "array", items: MatrixCloneResult },
  },
  required: ["parentId", "totalCount", "successCount", "errorCount", "status"],
} as const;

const GetMatrixResultsOutput = {
  type: "object" as const,
  properties: {
    success: { type: "boolean" },
    report: MatrixReport,
    error: { type: "string" },
  },
  required: ["success"],
} as const;

const ExpandMatrixPreviewInput = {
  type: "object" as const,
  properties: {
    /** Имя задачи-родителя (используется в именах клонов). */
    name: { type: "string" },
    workspaceIds: { type: "array", items: { type: "string" } },
    strategy: { type: "string" },
    failureMode: { type: "string" },
    aggregation: { type: "string" },
  },
  required: ["workspaceIds"],
  additionalProperties: false,
} as const;

const ExpandMatrixPreviewOutput = {
  type: "object" as const,
  properties: {
    success: { type: "boolean" },
    clones: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          workspaceId: { type: "string" },
          workspaceName: { type: ["string", "null"] },
        },
        required: ["name", "workspaceId"],
      },
    },
    error: { type: "string" },
  },
  required: ["success", "clones"],
} as const;

const CancelMatrixOutput = {
  type: "object" as const,
  properties: {
    success: { type: "boolean" },
    message: { type: "string" },
    cancelled: { type: "array", items: { type: "string" } },
  },
  required: ["success", "message", "cancelled"],
} as const;

const CleanupMatrixOrphansOutput = {
  type: "object" as const,
  properties: {
    success: { type: "boolean" },
    message: { type: "string" },
    removed: { type: "array", items: { type: "string" } },
  },
  required: ["success", "message", "removed"],
} as const;

export const SchedulerRpc = Rpc.define({
  id: "opencode-windows-scheduler",
  methods: {
    get_tasks: { input: GetTasksInput, output: GetTasksOutput },
    create_task: { input: CreateTaskInput, output: CreateTaskOutput },
    delete_task: { input: DeleteTaskInput, output: DeleteTaskOutput },
    run_task: { input: RunTaskInput, output: RunTaskOutput },
    pause_task: { input: PauseResumeInput, output: DeleteTaskOutput },
    resume_task: { input: PauseResumeInput, output: DeleteTaskOutput },
    update_task: { input: UpdateTaskInput, output: UpdateTaskOutput },
    get_task_logs: { input: GetTaskLogsInput, output: GetTaskLogsOutput },
    get_history: { input: GetHistoryInput, output: GetHistoryOutput },
    get_metrics: { input: GetMetricsInput, output: GetMetricsOutput },
    get_dashboard_port: { input: GetDashboardPortInput, output: GetDashboardPortOutput },
    get_platform: { input: GetPlatformInput, output: GetPlatformOutput },
    dry_run: { input: DryRunInput, output: DryRunReportOutput },
    dry_run_all: { input: GetTasksInput, output: DryRunAllOutput },
    get_matrix_results: {
      input: GetMatrixResultsInput,
      output: GetMatrixResultsOutput,
    },
    cancel_matrix: { input: NameOnly, output: CancelMatrixOutput },
    cleanup_matrix_orphans: {
      input: GetTasksInput,
      output: CleanupMatrixOrphansOutput,
    },
    expand_matrix_preview: {
      input: ExpandMatrixPreviewInput,
      output: ExpandMatrixPreviewOutput,
    },
    get_workspaces: { input: GetWorkspacesInput, output: GetWorkspacesOutput },
    add_workspace: { input: AddWorkspaceInput, output: AddWorkspaceOutput },
    update_workspace: { input: UpdateWorkspaceInput, output: AddWorkspaceOutput },
    delete_workspace: { input: DeleteWorkspaceInput, output: DeleteWorkspaceOutput },
    export_tasks: { input: ExportTasksInput, output: ExportTasksOutput },
    import_tasks: { input: ImportTasksInput, output: ImportTasksOutput },
    get_settings: { input: GetSettingsInput, output: GetSettingsOutput },
    save_settings: { input: SaveSettingsInput, output: SaveSettingsOutput },
    get_templates: { input: GetTemplatesInput, output: GetTemplatesOutput },
    save_template: { input: SaveTemplateInput, output: SaveTemplateOutput },
    delete_template: { input: DeleteTemplateInput, output: DeleteTemplateOutput },
    emit_event: { input: EmitEventInput, output: EmitEventOutput },
    test_notification: {
      input: TestNotificationInput,
      output: TestNotificationOutput,
    },
  },
  events: {},
});

export type SchedulerRpc = typeof SchedulerRpc;
