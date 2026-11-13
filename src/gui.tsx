import { createSignal, onCleanup, ErrorBoundary } from "solid-js"
import { Panel, Plugin } from "@opencode/plugin/gui"
import { SchedulerRpc } from "./rpc.js"
import { loadHistory, loadMetrics, type HistoryRecord } from "./history.js"

/** Статус задачи для отображения в GUI. */
type JobStatus = "running" | "success" | "error" | "partial" | "unknown"

/** Per-workspace переопределения клона (Спринт 17). */
interface MatrixOverrideFields {
  prompt?: string
  model?: string
  qualityGate?: string
  beforeScript?: string
  afterScript?: string
}

/** Matrix-настройки задачи-шаблона (Спринт 15: fan-out по workspace). */
interface MatrixConfig {
  workspaceIds: string[]
  strategy?: "parallel" | "sequential"
  failureMode?: "continue" | "stop"
  aggregation?: "summary" | "per-task"
  createAggregator?: boolean
  concurrency?: number
  overrides?: Record<string, MatrixOverrideFields>
}

/** Настройки уведомлений (webhook, шаблоны, фильтры, матрицы, дайджест — Спринт 20). */
interface NotificationSettings {
  enabled: boolean
  onlyOnError: boolean
  webhook?: {
    enabled: boolean
    url: string
    timeoutMs?: number
    retryCount?: number
    retryDelayMs?: number
  }
  templates?: { success: string; error: string }
  filters?: { include: string[]; exclude: string[] }
  matrix?: {
    enabled: boolean
    onPartial: boolean
    onAllFailed: boolean
    stuckAfterMinutes: number
  }
  digest?: {
    enabled: boolean
    frequency: "daily" | "weekly"
    time: string
    lastSentAt?: string | null
  }
}

/** Настройки ретеншна истории (Спринт 18). 0 — соответствующее ограничение выключено. */
interface HistorySettings {
  retentionDays: number
  maxRecords: number
  lastCleanupAt: string | null
  lastCleanupDeleted: number
}

interface Job {
  name: string
  schedule: string
  status: JobStatus
  nextRun?: string
  paused?: boolean
  retryCount?: number
  retryDelay?: number
  qualityGate?: string
  /** DAG-зависимости: задачи, которые должны успешно завершиться раньше этой. */
  dependsOn?: string[]
  prompt?: string
  /** LLM-модель задачи (undefined — модель OpenCode по умолчанию). */
  model?: string
  /** Приоритет задачи 0..10 (10 — наивысший). */
  priority?: number
  /** Pre-flight команда (undefined — не задана). */
  beforeScript?: string
  /** Post-flight команда (undefined — не задана). */
  afterScript?: string
  triggerType?: "cron" | "file" | "mcp-event"
  /** Параметры MCP-события. */
  mcpEvent?: { server: string; event: string; filter?: string }
  watchPath?: string
  workingDirectory?: string
  /** Привязка к multi-repo workspace. */
  workspaceId?: string
  workspaceName?: string
  workspaceColor?: string
  /** Ограничения инструментов (role-scoped, metadata-only). */
  allowedTools?: string[] | null
  deniedTools?: string[] | null
  /** Matrix (fan-out): задача-шаблон раскладывается на клоны. */
  matrix?: MatrixConfig | null
  /** Для клона матрицы — имя родительской задачи. */
  matrixParentId?: string | null
  /** true — задача является родителем матрицы. */
  isMatrixParent?: boolean
  /** Агрегат по клонам (только для родителя). */
  matrixSummary?: {
    totalCount: number
    successCount: number
    errorCount: number
    pendingCount: number
    status: string
    message: string
  } | null
  /** IANA-часовой пояс задачи (Спринт 19); null — системный. */
  timezone?: string | null
  /** Окно запуска: начало "HH:MM" (Спринт 19). */
  notBefore?: string | null
  /** Окно запуска: конец "HH:MM" (может быть меньше notBefore). */
  notAfter?: string | null
  /** Пауза до даты (ISO) — задача включится автоматически. */
  pausedUntil?: string | null
}

/** Пользовательский шаблон, сохранённый в templates.json. */
interface CustomTemplate {
  id: string
  name: string
  prompt: string
  schedule?: string
  timeoutSeconds?: number
  model?: string
  priority?: number
  retryCount?: number
  retryDelay?: number
  qualityGate?: string
  beforeScript?: string
  afterScript?: string
  dependsOn?: string[]
  triggerType?: "cron" | "file" | "mcp-event"
  mcpEvent?: { server: string; event: string; filter?: string }
  watchPath?: string
  workingDirectory?: string
  workspaceId?: string
  allowedTools?: string[]
  deniedTools?: string[]
  matrix?: MatrixConfig
}

/** Multi-repo workspace: один репозиторий = один cwd = один git-контекст. */
interface Workspace {
  id: string
  name: string
  path: string
  gitRemote?: string | null
  gitBranch?: string | null
  color?: string | null
  createdAt: string
}

function statusColor(status: JobStatus): string {
  switch (status) {
    case "running": return "#f5a623"
    case "success": return "#34c759"
    case "error": return "#ff3b30"
    case "partial": return "#ff9f0a"
    default: return "#8e8e93"
  }
}

/** Приоритет по умолчанию — «Обычный». */
const DEFAULT_PRIORITY = 5

/** Человекочитаемая подпись приоритета (0..10). */
function priorityLabel(priority?: number): string {
  const value =
    typeof priority === "number" && Number.isFinite(priority)
      ? Math.min(10, Math.max(0, Math.floor(priority)))
      : DEFAULT_PRIORITY
  if (value >= 10) return "Критический"
  if (value >= 8) return "Высокий"
  if (value <= 3) return "Низкий"
  return "Обычный"
}

/** Варианты выпадающего списка «Приоритет». */
const PRIORITY_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 2, label: "Низкий" },
  { value: 5, label: "Обычный" },
  { value: 8, label: "Высокий" },
  { value: 10, label: "Критический" },
]

/** Безопасно извлекает текст ошибки из любого thrown value. */
function errorMessage(err: any): string {
  if (err instanceof Error) return err.message
  if (typeof err === "object" && err !== null && "message" in err)
    return String((err as any).message)
  return JSON.stringify(err)
}

/**
 * Укорачивает текст ошибки для показа в интерфейсе:
 * берёт первую непустую строку и обрезает её до 150 символов.
 * Полные «простыни» из документации/стека в UI не попадают.
 */
function shortError(msg: string, limit = 150): string {
  const firstLine = (msg || "").split(/\r?\n/).map((s) => s.trim()).find(Boolean) ?? ""
  return firstLine.length > limit ? firstLine.slice(0, limit - 1).trimEnd() + "…" : firstLine
}

/** Пресеты cron-расписаний */
const CRON_PRESETS: Array<{ label: string; value: string }> = [
  { label: "Каждую минуту", value: "* * * * *" },
  { label: "Каждый час", value: "0 * * * *" },
  { label: "Каждый день в 09:00", value: "0 9 * * *" },
  { label: "Каждый понедельник в 10:00", value: "0 10 * * 1" },
  { label: "Свое расписание…", value: "__custom__" },
]

export default Plugin.define({
  setup(ctx) {
    const rpc = ctx.client.rpc(SchedulerRpc)

    const [jobs, setJobs] = createSignal<Job[]>([])
    const [workspaces, setWorkspaces] = createSignal<Workspace[]>([])
    const [workspacesCollapsed, setWorkspacesCollapsed] = createSignal(false)
    const [workspaceFilter, setWorkspaceFilter] = createSignal("all")
    const [workspaceBusy, setWorkspaceBusy] = createSignal(false)
    const [workspaceId, setWorkspaceId] = createSignal("")
    const [logs, setLogs] = createSignal("")
    const [logsTask, setLogsTask] = createSignal<string | null>(null)
    const [busy, setBusy] = createSignal(false)
    const [cronError, setCronError] = createSignal("")

    // Метрики и история запусков
    const [metrics, setMetrics] = createSignal<{ total: number; success: number; error: number }>({ total: 0, success: 0, error: 0 })
    const [historyOpen, setHistoryOpen] = createSignal<string | null>(null)
    const [history, setHistory] = createSignal<HistoryRecord[]>([])

    // Шаблоны промптов
    const TEMPLATES: Array<{ label: string; value: string; prompt: string }> = [
      { label: "Свой промпт", value: "custom", prompt: "" },
      {
        label: "Ночной сторож (тесты)",
        value: "night-watch",
        prompt: "Запусти ночные проверки: прогнали тесты, зафиксируй ошибки и составь краткий отчёт о состоянии репозитория.",
      },
      {
        label: "Утренний дайджест",
        value: "morning-digest",
        prompt: "Собери утренний дайджест: какие изменения были за ночь, есть ли проваленные сборки, что требует внимания сегодня.",
      },
      {
        label: "Гигиена кода",
        value: "code-hygiene",
        prompt: "Проведи аудит гигиены кода: найди неиспользуемые импорты, неиспользуемые переменные, лишние зависимости и предложи правки.",
      },
    ]
    const [template, setTemplate] = createSignal<string>("custom")

    // Пользовательские шаблоны (templates.json) — загружаются при монтировании панели.
    const [customTemplates, setCustomTemplates] = createSignal<CustomTemplate[]>([])

    // Таймер для выполнения задачи (секунды)
    const [runningSec, setRunningSec] = createSignal(0)
    setInterval(() => setRunningSec((s) => s + 1), 1000)

    // Глобальные настройки (макс. одновременных задач, зимняя тема)
    const [maxConcurrent, setMaxConcurrent] = createSignal(1)
    const [winterMode, setWinterMode] = createSignal(false)

    // Настройки уведомлений (webhook)
    const [notificationsEnabled, setNotificationsEnabled] = createSignal(false)
    const [onlyOnError, setOnlyOnError] = createSignal(true)
    const [webhookEnabled, setWebhookEnabled] = createSignal(false)
    const [webhookUrl, setWebhookUrl] = createSignal("")
    const [notificationsCollapsed, setNotificationsCollapsed] = createSignal(true)
    const [testNotificationBusy, setTestNotificationBusy] = createSignal(false)
    // Спринт 20: webhook-ретраи, шаблоны, фильтры, матрицы и дайджест.
    const [webhookTimeoutMs, setWebhookTimeoutMs] = createSignal(10000)
    const [webhookRetryCount, setWebhookRetryCount] = createSignal(2)
    const [webhookRetryDelayMs, setWebhookRetryDelayMs] = createSignal(1000)
    const [templateSuccess, setTemplateSuccess] = createSignal("")
    const [templateError, setTemplateError] = createSignal("")
    const [filterInclude, setFilterInclude] = createSignal("")
    const [filterExclude, setFilterExclude] = createSignal("")
    const [matrixNotifyEnabled, setMatrixNotifyEnabled] = createSignal(true)
    const [matrixNotifyPartial, setMatrixNotifyPartial] = createSignal(true)
    const [matrixNotifyAllFailed, setMatrixNotifyAllFailed] = createSignal(true)
    const [matrixStuckMinutes, setMatrixStuckMinutes] = createSignal(60)
    const [digestEnabled, setDigestEnabled] = createSignal(false)
    const [digestFrequency, setDigestFrequency] = createSignal<"daily" | "weekly">("daily")
    const [digestTime, setDigestTime] = createSignal("09:00")
    const [digestLastSentAt, setDigestLastSentAt] = createSignal<string | null>(null)
    const [digestBusy, setDigestBusy] = createSignal(false)

    // Настройки ретеншна истории (Спринт 18): очистка старых записей.
    const [historyRetentionDays, setHistoryRetentionDays] = createSignal(30)
    const [historyMaxRecords, setHistoryMaxRecords] = createSignal(5000)
    const [historyLastCleanupAt, setHistoryLastCleanupAt] = createSignal<string | null>(null)
    const [historyLastCleanupDeleted, setHistoryLastCleanupDeleted] = createSignal(0)
    const [historyCollapsed, setHistoryCollapsed] = createSignal(true)
    const [historyCleanupBusy, setHistoryCleanupBusy] = createSignal(false)

    // Таймеры ожидания завершения ручных запусков (для тостов OpenCode).
    const pendingRunTimers = new Map<string, ReturnType<typeof setInterval>>()
    onCleanup(() => {
      for (const timer of pendingRunTimers.values()) clearInterval(timer)
      pendingRunTimers.clear()
    })

    // Название планировщика приходит с бэкенда: на Windows — «Планировщик Windows»,
    // на macOS/Linux — «OpenCode Scheduler». GUI не зависит от ОС напрямую.
    const [schedulerTitle, setSchedulerTitle] = createSignal("Планировщик задач")

    async function loadPlatformGui() {
      try {
        const info = await rpc.get_platform({})
        if (info?.title) setSchedulerTitle(info.title)
      } catch (err: any) {
        console.error("RPC Error (get_platform):", err)
      }
    }

    /** Разложить настройки уведомлений по сигналам формы (Спринт 20). */
    function applyNotificationSettings(n: NotificationSettings | undefined) {
      setNotificationsEnabled(Boolean(n?.enabled))
      setOnlyOnError(n?.onlyOnError !== false)
      setWebhookEnabled(Boolean(n?.webhook?.enabled))
      setWebhookUrl(n?.webhook?.url ?? "")
      setWebhookTimeoutMs(Number(n?.webhook?.timeoutMs ?? 10000))
      setWebhookRetryCount(Number(n?.webhook?.retryCount ?? 2))
      setWebhookRetryDelayMs(Number(n?.webhook?.retryDelayMs ?? 1000))
      setTemplateSuccess(n?.templates?.success ?? "")
      setTemplateError(n?.templates?.error ?? "")
      setFilterInclude((n?.filters?.include ?? []).join(", "))
      setFilterExclude((n?.filters?.exclude ?? []).join(", "))
      setMatrixNotifyEnabled(n?.matrix?.enabled !== false)
      setMatrixNotifyPartial(n?.matrix?.onPartial !== false)
      setMatrixNotifyAllFailed(n?.matrix?.onAllFailed !== false)
      setMatrixStuckMinutes(Number(n?.matrix?.stuckAfterMinutes ?? 60))
      setDigestEnabled(Boolean(n?.digest?.enabled))
      setDigestFrequency(n?.digest?.frequency === "weekly" ? "weekly" : "daily")
      setDigestTime(n?.digest?.time ?? "09:00")
      setDigestLastSentAt(n?.digest?.lastSentAt ?? null)
    }

    async function loadSettingsGui() {
      try {
        const s = await rpc.get_settings({})
        setMaxConcurrent(s.maxConcurrent ?? 1)
        setWinterMode(Boolean(s.winterMode))
        applyNotificationSettings(s.notifications)
        const h = s.history
        setHistoryRetentionDays(Number(h?.retentionDays ?? 30))
        setHistoryMaxRecords(Number(h?.maxRecords ?? 5000))
        setHistoryLastCleanupAt(h?.lastCleanupAt ?? null)
        setHistoryLastCleanupDeleted(Number(h?.lastCleanupDeleted ?? 0))
      } catch (err: any) {
        console.error("RPC Error (get_settings):", err)
      }
    }

    /** Текущие настройки уведомлений из сигналов формы. */
    function currentNotificationSettings(): NotificationSettings {
      const splitList = (value: string) =>
        value
          .split(",")
          .map((item) => item.trim())
          .filter((item) => item.length > 0)
      return {
        enabled: notificationsEnabled(),
        onlyOnError: onlyOnError(),
        webhook: {
          enabled: webhookEnabled(),
          url: (webhookUrl() || "").trim(),
          timeoutMs: Math.max(1000, Math.min(120000, Math.floor(Number(webhookTimeoutMs()) || 10000))),
          retryCount: Math.max(0, Math.min(5, Math.floor(Number(webhookRetryCount()) || 0))),
          retryDelayMs: Math.max(100, Math.min(60000, Math.floor(Number(webhookRetryDelayMs()) || 1000))),
        },
        templates: {
          success: templateSuccess().trim(),
          error: templateError().trim(),
        },
        filters: {
          include: splitList(filterInclude()),
          exclude: splitList(filterExclude()),
        },
        matrix: {
          enabled: matrixNotifyEnabled(),
          onPartial: matrixNotifyPartial(),
          onAllFailed: matrixNotifyAllFailed(),
          stuckAfterMinutes: Math.max(
            0,
            Math.min(10080, Math.floor(Number(matrixStuckMinutes()) || 0))
          ),
        },
        digest: {
          enabled: digestEnabled(),
          frequency: digestFrequency(),
          time: (digestTime() || "09:00").trim(),
          lastSentAt: digestLastSentAt(),
        },
      }
    }

    /** Текущие настройки ретеншна из сигналов формы. */
    function currentHistorySettings(): HistorySettings {
      return {
        retentionDays: Math.max(0, Math.floor(Number(historyRetentionDays()) || 0)),
        maxRecords: Math.max(0, Math.floor(Number(historyMaxRecords()) || 0)),
        lastCleanupAt: historyLastCleanupAt(),
        lastCleanupDeleted: Math.max(0, Math.floor(Number(historyLastCleanupDeleted()) || 0)),
      }
    }

    async function persistSettings(patch: {
      maxConcurrent?: number
      winterMode?: boolean
      notifications?: NotificationSettings
      history?: HistorySettings
    }) {
      try {
        const s = await rpc.save_settings(patch)
        if (patch.maxConcurrent !== undefined) setMaxConcurrent(s.maxConcurrent)
        if (patch.winterMode !== undefined) setWinterMode(Boolean(s.winterMode))
        if (patch.notifications !== undefined) {
          applyNotificationSettings(s.notifications)
        }
        if (patch.history !== undefined) {
          const h = s.history
          setHistoryRetentionDays(Number(h?.retentionDays ?? 30))
          setHistoryMaxRecords(Number(h?.maxRecords ?? 5000))
          setHistoryLastCleanupAt(h?.lastCleanupAt ?? null)
          setHistoryLastCleanupDeleted(Number(h?.lastCleanupDeleted ?? 0))
        }
      } catch (err: any) {
        console.error("RPC Error (save_settings):", err)
        ctx.toast.show({ title: "Не удалось сохранить настройки", variant: "error", description: errorMessage(err) })
      }
    }

    /** Сохраняет настройки уведомлений (вызывается после изменения любого поля). */
    async function saveNotificationSettings() {
      await persistSettings({ notifications: currentNotificationSettings() })
    }

    /** Сохраняет настройки ретеншна (вызывается после изменения любого поля). */
    async function saveHistorySettings() {
      await persistSettings({ history: currentHistorySettings() })
    }

    /** Кнопка «🧹 Очистить сейчас»: фиксирует форму и запускает очистку. */
    async function handleHistoryCleanup() {
      setHistoryCleanupBusy(true)
      try {
        // Сначала фиксируем значения формы — очистка использует settings.json.
        await persistSettings({ history: currentHistorySettings() })
        const result = await rpc.cleanup_history({})
        // cleanup_history обновляет lastCleanupAt/lastCleanupDeleted в settings.json.
        const s = await rpc.get_settings({})
        const h = s.history
        setHistoryRetentionDays(Number(h?.retentionDays ?? 30))
        setHistoryMaxRecords(Number(h?.maxRecords ?? 5000))
        setHistoryLastCleanupAt(h?.lastCleanupAt ?? null)
        setHistoryLastCleanupDeleted(Number(h?.lastCleanupDeleted ?? 0))
        ctx.toast.show({
          title: result.success ? "Очистка истории завершена" : "Очистка не удалась",
          variant: result.success ? "success" : "error",
          description: result.message,
        })
      } catch (err: any) {
        console.error("RPC Error (cleanup_history):", err)
        ctx.toast.show({
          title: "Очистка не удалась",
          variant: "error",
          description: errorMessage(err),
        })
      } finally {
        setHistoryCleanupBusy(false)
      }
    }

    /** Кнопка «🧪 Тестовое уведомление». */
    async function handleTestNotification() {
      setTestNotificationBusy(true)
      try {
        // Сначала фиксируем текущие значения, чтобы тест использовал введённый URL.
        await saveNotificationSettings()
        const result = await rpc.test_notification({})
        ctx.toast.show({
          title: result.success ? "Тестовое уведомление отправлено" : "Тест не удался",
          variant: result.success ? "success" : "error",
          description: result.message,
        })
      } catch (err: any) {
        console.error("RPC Error (test_notification):", err)
        ctx.toast.show({
          title: "Тест не удался",
          variant: "error",
          description: errorMessage(err),
        })
      } finally {
        setTestNotificationBusy(false)
      }
    }

    /** Кнопка «📊 Отправить дайджест сейчас» (Спринт 20). */
    async function handleSendDigest() {
      setDigestBusy(true)
      try {
        // Сначала фиксируем настройки формы — дайджест читает settings.json.
        await saveNotificationSettings()
        const result = await rpc.send_digest({})
        ctx.toast.show({
          title: result.success ? "Дайджест отправлен" : "Дайджест не отправлен",
          variant: result.success ? "success" : "error",
          description: result.message,
        })
      } catch (err: any) {
        console.error("RPC Error (send_digest):", err)
        ctx.toast.show({
          title: "Дайджест не отправлен",
          variant: "error",
          description: errorMessage(err),
        })
      } finally {
        setDigestBusy(false)
      }
    }

    async function saveSettingsGui(val: number) {
      setMaxConcurrent(val)
      await persistSettings({ maxConcurrent: val })
    }

    /** Переключатель зимней темы: сразу применяем в UI и сохраняем в settings.json. */
    async function toggleWinterMode(next: boolean) {
      setWinterMode(next)
      await persistSettings({ winterMode: next })
    }

    // Режим редактирования
    const [editingJob, setEditingJob] = createSignal<Job | null>(null)

    // Свёрнута ли форма создания/редактирования (чтобы не скроллить длинную форму)
    const [formCollapsed, setFormCollapsed] = createSignal(false)

    // Поля формы создания/редактирования задачи
    const [name, setName] = createSignal("")
    const [schedule, setSchedule] = createSignal("* * * * *")
    const [prompt, setPrompt] = createSignal("")
    const [cronPreset, setCronPreset] = createSignal<"* * * * *" | "0 * * * *" | "0 9 * * *" | "0 10 * * 1" | "__custom__">("* * * * *")

    // Повторы при ошибке
    const [retryCount, setRetryCount] = createSignal(0)
    const [retryDelay, setRetryDelay] = createSignal(60)

    // Модель LLM и приоритет запуска
    const [model, setModel] = createSignal("")
    const [priority, setPriority] = createSignal(DEFAULT_PRIORITY)

    // Quality Gate и DAG-зависимости
    const [qualityGate, setQualityGate] = createSignal("")
    const [dependsOn, setDependsOn] = createSignal<string[]>([])

    // Lifecycle hooks (CI/CD): pre-flight и post-flight команды
    const [beforeScript, setBeforeScript] = createSignal("")
    const [afterScript, setAfterScript] = createSignal("")

    // Триггеры (cron / file / mcp-event) и рабочая директория
    const [triggerType, setTriggerType] = createSignal<"cron" | "file" | "mcp-event">("cron")
    const [watchPath, setWatchPath] = createSignal("")
    // Часовой пояс и окно запуска (Спринт 19). Пусто = системный пояс / без окна.
    const [timezone, setTimezone] = createSignal("")
    const [notBefore, setNotBefore] = createSignal("")
    const [notAfter, setNotAfter] = createSignal("")
    const [mcpServer, setMcpServer] = createSignal("")
    const [mcpEventName, setMcpEventName] = createSignal("")
    const [mcpFilter, setMcpFilter] = createSignal("")
    const [workingDirectory, setWorkingDirectory] = createSignal("")

    // Ограничения инструментов (role-scoped, Спринт 14): metadata-only,
    // denied имеет приоритет над allowed.
    const [allowedTools, setAllowedTools] = createSignal<string[]>([])
    const [deniedTools, setDeniedTools] = createSignal<string[]>([])
    const [customTool, setCustomTool] = createSignal("")
    // Matrix (fan-out, Спринт 15): задача-шаблон + список workspace.
    const [matrixMode, setMatrixMode] = createSignal(false)
    const [matrixWorkspaceIds, setMatrixWorkspaceIds] = createSignal<string[]>([])
    const [matrixStrategy, setMatrixStrategy] = createSignal<"parallel" | "sequential">("parallel")
    const [matrixFailureMode, setMatrixFailureMode] = createSignal<"continue" | "stop">("continue")
    const [matrixAggregation, setMatrixAggregation] = createSignal<"summary" | "per-task">("summary")
    const [matrixAggregator, setMatrixAggregator] = createSignal(false)
    // Спринт 17: лимит одновременных клонов и per-workspace переопределения.
    const [matrixConcurrency, setMatrixConcurrency] = createSignal("")
    const [matrixOverrides, setMatrixOverrides] = createSignal<Record<string, MatrixOverrideFields>>({})
    const [dryRunOpen, setDryRunOpen] = createSignal(false)
    const [dryRunBusy, setDryRunBusy] = createSignal(false)
    const [dryRunReport, setDryRunReport] = createSignal<any>(null)
    const [dryRunName, setDryRunName] = createSignal("")

    /** Популярные инструменты для мультивыбора. */
    const POPULAR_TOOLS = ["bash", "edit", "write", "read", "grep", "glob", "webfetch"]

    function toggleTool(target: "allowed" | "denied", tool: string) {
      if (target === "allowed") {
        setAllowedTools((prev) => (prev.includes(tool) ? prev.filter((t) => t !== tool) : [...prev, tool]))
      } else {
        setDeniedTools((prev) => (prev.includes(tool) ? prev.filter((t) => t !== tool) : [...prev, tool]))
      }
    }

    function addCustomTool(target: "allowed" | "denied") {
      const name = customTool().trim()
      if (!name) return
      if (target === "allowed") {
        if (!allowedTools().includes(name)) setAllowedTools([...allowedTools(), name])
      } else {
        if (!deniedTools().includes(name)) setDeniedTools([...deniedTools(), name])
      }
      setCustomTool("")
    }

    /** Добавляет/убирает workspace из матрицы. */
    function toggleMatrixWorkspace(id: string, checked: boolean) {
      setMatrixWorkspaceIds((current) => {
        if (checked) return current.includes(id) ? current : [...current, id]
        return current.filter((item) => item !== id)
      })
    }

    /** Имя клона — та же санитизация, что и на бэкенде (expandMatrixTask). */
    function matrixClonePreviewName(parent: string, workspaceName: string): string {
      const base = parent.trim() || "task"
      const safe = workspaceName.trim().replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, "-")
      return `${base}-matrix-${safe || "workspace"}`
    }

    /** Превью имён клонов по текущим полям формы. */
    const matrixPreview = () =>
      matrixWorkspaceIds()
        .map((id) => workspaces().find((w) => w.id === id))
        .filter((w): w is Workspace => Boolean(w))
        .map((w) => matrixClonePreviewName(name(), w.name))

    /** Обновляет одно поле per-workspace переопределения. */
    function updateMatrixOverride(
      workspaceId: string,
      field: keyof MatrixOverrideFields,
      value: string
    ) {
      setMatrixOverrides((prev) => {
        const current: MatrixOverrideFields = { ...(prev[workspaceId] ?? {}) }
        if (value.trim()) {
          current[field] = value
        } else {
          delete current[field]
        }
        const next = { ...prev }
        if (Object.keys(current).length > 0) {
          next[workspaceId] = current
        } else {
          delete next[workspaceId]
        }
        return next
      })
    }

    /** Сколько workspace имеют переопределения (для подписи). */
    const matrixOverrideCount = () => Object.keys(matrixOverrides()).length

    /** Matrix-поле для payload RPC (undefined — обычная задача). */
    const matrixPayload = (): MatrixConfig | undefined => {
      if (!matrixMode()) return undefined
      const concurrencyRaw = matrixConcurrency().trim()
      const concurrency = concurrencyRaw ? Number(concurrencyRaw) : undefined
      const overrides = matrixOverrides()
      return {
        workspaceIds: matrixWorkspaceIds(),
        strategy: matrixStrategy(),
        failureMode: matrixFailureMode(),
        aggregation: matrixAggregation(),
        createAggregator: matrixAggregator(),
        ...(concurrency !== undefined && Number.isFinite(concurrency) && concurrency >= 1
          ? { concurrency: Math.floor(concurrency) }
          : {}),
        ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
      }
    }

    /** Сбрасывает поля формы матрицы. */
    function resetMatrixForm() {
      setMatrixMode(false)
      setMatrixWorkspaceIds([])
      setMatrixStrategy("parallel")
      setMatrixFailureMode("continue")
      setMatrixAggregation("summary")
      setMatrixAggregator(false)
      setMatrixConcurrency("")
      setMatrixOverrides({})
    }

    /** Превью конвейера по текущим полям формы (dry_run требует сохранённую задачу —
     *  для несохранённой формы показываем локальную оценку без RPC). */
    function buildFormCommand(): string {
      const modelArg = model().trim() ? ` --model ${model().trim()}` : ""
      return `opencode run${modelArg} "${prompt().replace(/\s+/g, " ").trim()}"`
    }

    // Экспорт/импорт задач
    const [exportData, setExportData] = createSignal<string | null>(null)
    const [exportBusy, setExportBusy] = createSignal(false)
    const [importBusy, setImportBusy] = createSignal(false)
    const [importFile, setImportFile] = createSignal<File | null>(null)

    async function handleExport() {
      setExportBusy(true)
      try {
        const result = await rpc.export_tasks({})
        if (!result.success) {
          ctx.toast.show({ title: "Ошибка экспорта", variant: "error", description: result.error })
          return
        }
        setExportData(result.data)
        const blob = new Blob([result.data], { type: "application/json" })
        const url = URL.createObjectURL(blob)
        const a = document.createElement("a")
        a.href = url
        a.download = `windows-scheduler-tasks-${new Date().toISOString().slice(0, 10)}.json`
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(url)
        ctx.toast.show({ title: `Экспортировано задач: ${result.count}`, variant: "success" })
      } catch (err: any) {
        console.error("RPC Error (export_tasks):", err)
        ctx.toast.show({ title: "Ошибка экспорта", variant: "error", description: errorMessage(err) })
      } finally {
        setExportBusy(false)
      }
    }

    function handleImportFile(e: Event) {
      const input = e.target as HTMLInputElement
      const file = input.files?.[0] ?? null
      setImportFile(file)
    }

    async function handleImport() {
      const file = importFile()
      if (!file) {
        ctx.toast.show({ title: "Выберите файл", variant: "error", description: "Не выбран файл для импорта." })
        return
      }
      setImportBusy(true)
      try {
        const text = await file.text()
        const result = await rpc.import_tasks({ data: text })
        if (!result.success) {
          ctx.toast.show({ title: "Ошибка импорта", variant: "error", description: result.error })
          return
        }
        setImportFile(null)
        ctx.toast.show({ title: `Импортировано задач: ${result.imported}`, variant: "success" })
        await loadJobs()
      } catch (err: any) {
        console.error("RPC Error (import_tasks):", err)
        ctx.toast.show({ title: "Ошибка импорта", variant: "error", description: errorMessage(err) })
      } finally {
        setImportBusy(false)
      }
    }

    async function loadTemplatesGui() {
      try {
        const result = await rpc.get_templates({})
        const list = Array.isArray(result?.templates) ? (result.templates as CustomTemplate[]) : []
        setCustomTemplates(list)
      } catch (err: any) {
        console.error("RPC Error (get_templates):", err)
      }
    }

    async function loadWorkspacesGui() {
      try {
        const result = await rpc.get_workspaces({})
        const list = Array.isArray(result?.workspaces) ? (result.workspaces as Workspace[]) : []
        setWorkspaces(list)
      } catch (err: any) {
        console.error("RPC Error (get_workspaces):", err)
      }
    }

    /** Активный workspace выбранной задачи (для dry-run подсказки). */
    const selectedWorkspace = () => workspaces().find((w) => w.id === workspaceId())

    async function handleAddWorkspace() {
      const workspacePath = (window.prompt("Путь к git-репозиторию (workspace)", "") ?? "").trim()
      if (!workspacePath) return
      const workspaceName = (window.prompt("Название workspace (необязательно)", "") ?? "").trim()
      setWorkspaceBusy(true)
      try {
        const result = await rpc.add_workspace({
          path: workspacePath,
          ...(workspaceName ? { name: workspaceName } : {}),
        })
        if (!result.success) {
          ctx.toast.show({ title: "Ошибка добавления workspace", variant: "error", description: result.error ?? "Неизвестная ошибка" })
          return
        }
        await loadWorkspacesGui()
        if (result.workspace?.id) setWorkspaceId(result.workspace.id)
        ctx.toast.show({ title: "Workspace добавлен", variant: "success" })
      } catch (err: any) {
        console.error("RPC Error (add_workspace):", err)
        ctx.toast.show({ title: "Ошибка добавления workspace", variant: "error", description: shortError(errorMessage(err)) })
      } finally {
        setWorkspaceBusy(false)
      }
    }

    async function handleEditWorkspace(workspace: Workspace) {
      const nextPath = (window.prompt("Путь к git-репозиторию", workspace.path) ?? "").trim()
      if (!nextPath) return
      const nextName = (window.prompt("Название workspace", workspace.name) ?? "").trim()
      setWorkspaceBusy(true)
      try {
        const result = await rpc.update_workspace({
          id: workspace.id,
          path: nextPath,
          ...(nextName ? { name: nextName } : {}),
        })
        if (!result.success) {
          ctx.toast.show({ title: "Ошибка обновления workspace", variant: "error", description: result.error ?? "Неизвестная ошибка" })
          return
        }
        await loadWorkspacesGui()
        ctx.toast.show({ title: "Workspace обновлён", variant: "success" })
      } catch (err: any) {
        console.error("RPC Error (update_workspace):", err)
        ctx.toast.show({ title: "Ошибка обновления workspace", variant: "error", description: shortError(errorMessage(err)) })
      } finally {
        setWorkspaceBusy(false)
      }
    }

    async function handleDeleteWorkspace(workspace: Workspace) {
      if (!window.confirm(`Удалить workspace "${workspace.name}"? Задачи сохранены, привязка будет очищена.`)) return
      setWorkspaceBusy(true)
      try {
        const result = await rpc.delete_workspace({ id: workspace.id })
        if (!result.success) {
          ctx.toast.show({ title: "Ошибка удаления workspace", variant: "error", description: result.message ?? "Неизвестная ошибка" })
          return
        }
        if (workspaceId() === workspace.id) setWorkspaceId("")
        if (workspaceFilter() === workspace.id) setWorkspaceFilter("all")
        await loadWorkspacesGui()
        await loadJobs()
        ctx.toast.show({ title: "Workspace удалён", variant: "success", description: result.message })
      } catch (err: any) {
        console.error("RPC Error (delete_workspace):", err)
        ctx.toast.show({ title: "Ошибка удаления workspace", variant: "error", description: shortError(errorMessage(err)) })
      } finally {
        setWorkspaceBusy(false)
      }
    }

    /**
     * При выборе шаблона:
     * — встроенный подставляет только промпт (как раньше);
     * — пользовательский заполняет ВСЕ поля формы (расписание, ретраи,
     *   Quality Gate, цепочки, триггер и рабочую директорию).
     */
    const selectTemplate = (val: string) => {
      setTemplate(val)

      if (val.startsWith("custom:")) {
        const t = customTemplates().find((item) => `custom:${item.id}` === val)
        if (!t) return
        setPrompt(t.prompt ?? "")
        if (t.schedule) {
          setSchedule(t.schedule)
          const preset = CRON_PRESETS.find((p) => p.value === t.schedule)
          setCronPreset((preset ? preset.value : "__custom__") as any)
        }
        setRetryCount(t.retryCount ?? 0)
        setRetryDelay(t.retryDelay ?? 60)
        setQualityGate(t.qualityGate ?? "")
        setModel(t.model ?? "")
        setPriority(typeof t.priority === "number" ? t.priority : DEFAULT_PRIORITY)
        setDependsOn(Array.isArray(t.dependsOn) ? t.dependsOn : [])
        setBeforeScript(t.beforeScript ?? "")
        setAfterScript(t.afterScript ?? "")
        setTriggerType(
          t.triggerType === "file"
            ? "file"
            : t.triggerType === "mcp-event"
            ? "mcp-event"
            : "cron"
        )
        setWatchPath(t.watchPath ?? "")
        setTimezone(t.timezone ?? "")
        setNotBefore(t.notBefore ?? "")
        setNotAfter(t.notAfter ?? "")
        setMcpServer(t.mcpEvent?.server ?? "")
        setMcpEventName(t.mcpEvent?.event ?? "")
        setMcpFilter(t.mcpEvent?.filter ?? "")
        setWorkingDirectory(t.workingDirectory ?? "")
        setWorkspaceId(t.workspaceId ?? "")
        setAllowedTools(Array.isArray(t.allowedTools) ? t.allowedTools : [])
        setDeniedTools(Array.isArray(t.deniedTools) ? t.deniedTools : [])
        if (t.matrix) {
          setMatrixMode(true)
          setMatrixWorkspaceIds(Array.isArray(t.matrix.workspaceIds) ? t.matrix.workspaceIds : [])
          setMatrixStrategy(t.matrix.strategy === "sequential" ? "sequential" : "parallel")
          setMatrixFailureMode(t.matrix.failureMode === "stop" ? "stop" : "continue")
          setMatrixAggregation(t.matrix.aggregation === "per-task" ? "per-task" : "summary")
          setMatrixAggregator(Boolean(t.matrix.createAggregator))
          setMatrixConcurrency(
            typeof t.matrix.concurrency === "number" ? String(t.matrix.concurrency) : ""
          )
          const overrides = (t.matrix as MatrixConfig).overrides
          setMatrixOverrides(overrides ? { ...overrides } : {})
        } else {
          resetMatrixForm()
        }
        return
      }

      const builtin = TEMPLATES.find((t) => t.value === val)
      if (builtin) setPrompt(builtin.prompt)
    }

    /** Сохраняет текущие значения формы как пользовательский шаблон. */
    async function handleSaveAsTemplate() {
      if (!(prompt() || "").trim()) {
        ctx.toast.show({
          title: "Нечего сохранять",
          variant: "error",
          description: "Сначала заполните промпт — он обязателен для шаблона.",
        })
        return
      }

      const templateName = (window.prompt("Название шаблона", "") ?? "").trim()
      if (!templateName) return

      try {
        const result = await rpc.save_template({
          name: templateName,
          prompt: (prompt() || "").trim(),
          schedule: (schedule() || "").trim(),
          timeoutSeconds: 3600,
          model: (model() || "").trim(),
          priority: priority(),
          retryCount: retryCount(),
          retryDelay: retryDelay(),
          qualityGate: (qualityGate() || "").trim(),
          beforeScript: (beforeScript() || "").trim(),
          afterScript: (afterScript() || "").trim(),
          dependsOn: dependsOn(),
          triggerType: triggerType(),
          timezone: (timezone() || "").trim() || undefined,
          notBefore: (notBefore() || "").trim() || undefined,
          notAfter: (notAfter() || "").trim() || undefined,
          mcpEvent:
            triggerType() === "mcp-event"
              ? {
                  server: (mcpServer() || "").trim(),
                  event: (mcpEventName() || "").trim(),
                  ...(mcpFilter().trim() ? { filter: mcpFilter().trim() } : {}),
                }
              : undefined,
          watchPath: (watchPath() || "").trim(),
          workingDirectory: (workingDirectory() || "").trim(),
          workspaceId: (workspaceId() || "").trim() || undefined,
          allowedTools: allowedTools().length > 0 ? allowedTools() : undefined,
          deniedTools: deniedTools().length > 0 ? deniedTools() : undefined,
          matrix: matrixPayload(),
        })
        if (!result.success) {
          ctx.toast.show({
            title: "Не удалось сохранить шаблон",
            variant: "error",
            description: result.error || "Неизвестная ошибка",
          })
          return
        }
        await loadTemplatesGui()
        const saved = (result as any).template
        if (saved?.id) setTemplate(`custom:${saved.id}`)
        ctx.toast.show({ title: `Шаблон "${templateName}" сохранён`, variant: "success" })
      } catch (err: any) {
        console.error("RPC Error (save_template):", err)
        ctx.toast.show({
          title: "Ошибка сохранения шаблона",
          variant: "error",
          description: errorMessage(err),
        })
      }
    }

    /** Удаляет пользовательский шаблон по id. */
    async function handleDeleteTemplate(t: CustomTemplate) {
      if (!window.confirm(`Удалить шаблон "${t.name}"?`)) return
      try {
        const result = await rpc.delete_template({ id: t.id })
        if (!result.success) {
          ctx.toast.show({
            title: "Не удалось удалить шаблон",
            variant: "error",
            description: result.error || "Неизвестная ошибка",
          })
          return
        }
        if (template() === `custom:${t.id}`) setTemplate("custom")
        await loadTemplatesGui()
        ctx.toast.show({ title: `Шаблон "${t.name}" удалён`, variant: "success" })
      } catch (err: any) {
        console.error("RPC Error (delete_template):", err)
        ctx.toast.show({
          title: "Ошибка удаления шаблона",
          variant: "error",
          description: errorMessage(err),
        })
      }
    }

    async function loadJobs() {
      try {
        const result = await rpc.get_tasks({})
        console.log("[GUI] Received tasks:", result)
        const tasks = Array.isArray(result?.tasks) ? (result.tasks as any[]) : []
        console.log("[GUI] tasks count:", tasks.length)
        const mapped: Job[] = tasks.map((t: any) => ({
          name: t.name,
          schedule: t.schedule,
          status: (t.status as JobStatus) ?? "unknown",
          nextRun: t.nextRun ?? undefined,
          paused: t.status?.toLowerCase().includes("disabled"),
          retryCount: t.retryCount ?? 0,
          retryDelay: t.retryDelay ?? 60,
          qualityGate: t.qualityGate ?? undefined,
          dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn : undefined,
          model: t.model ?? undefined,
          priority: typeof t.priority === "number" ? t.priority : DEFAULT_PRIORITY,
          beforeScript: t.beforeScript ?? undefined,
          afterScript: t.afterScript ?? undefined,
          triggerType: (t.triggerType ?? "cron") as "cron" | "file" | "mcp-event",
          mcpEvent: t.mcpEvent ?? undefined,
          watchPath: t.watchPath ?? undefined,
          timezone: t.timezone ?? undefined,
          notBefore: t.notBefore ?? undefined,
          notAfter: t.notAfter ?? undefined,
          pausedUntil: t.pausedUntil ?? undefined,
          workingDirectory: t.workingDirectory ?? undefined,
          workspaceId: t.workspaceId ?? undefined,
          workspaceName: t.workspaceName ?? undefined,
          workspaceColor: t.workspaceColor ?? undefined,
          allowedTools: Array.isArray(t.allowedTools) ? t.allowedTools : undefined,
          deniedTools: Array.isArray(t.deniedTools) ? t.deniedTools : undefined,
          matrix: (t as any).matrix ?? null,
          matrixParentId: (t as any).matrixParentId ?? null,
          isMatrixParent: Boolean((t as any).isMatrixParent),
          matrixSummary: (t as any).matrixSummary ?? null,
          prompt: t.prompt ?? "",
        }))
        setJobs(mapped)
        console.log("[GUI] jobs:", jobs())
        await loadMetrics()
      } catch (err: any) {
        console.error("RPC Error (get_tasks):", err)
        // Оставляем старые данные на экране, не роняем UI
        ctx.toast.show({ title: "Ошибка загрузки задач", variant: "error", description: shortError(errorMessage(err)) })
      }
    }

    async function loadMetrics() {
      try {
        const m = await rpc.get_metrics({})
        setMetrics({ total: m.total ?? 0, success: m.success ?? 0, error: m.error ?? 0 })
      } catch (err: any) {
        console.error("RPC Error (get_metrics):", err)
      }
    }

    async function fetchHistory(taskName: string) {
      setHistoryOpen(taskName)
      try {
        const result = await rpc.get_history({ limit: 10 })
        setHistory(result.records ?? [])
      } catch (err: any) {
        console.error("RPC Error (get_history):", err)
        ctx.toast.show({ title: "Ошибка загрузки истории", variant: "error", description: errorMessage(err) })
      }
    }

    /** Dry-Run: симуляция конвейера задачи без реального запуска (Спринт 14). */
    async function openDryRun(taskName: string) {
      setDryRunOpen(true)
      setDryRunName(taskName)
      setDryRunBusy(true)
      setDryRunReport(null)
      try {
        const result: any = await rpc.dry_run({ taskName })
        setDryRunReport(result)
      } catch (err: any) {
        console.error("RPC Error (dry_run):", err)
        setDryRunReport({ success: false, error: errorMessage(err), tasks: [], warnings: [] })
      } finally {
        setDryRunBusy(false)
      }
    }

    function closeDryRun() {
      setDryRunOpen(false)
      setDryRunName("")
      setDryRunReport(null)
    }

    async function handleCreate() {
      setBusy(true)
      setCronError("")
      try {
        const result = await rpc.create_task({
          name: (name() || "").trim(),
          schedule: (schedule() || "").trim(),
          prompt: (prompt() || "").trim(),
          model: (model() || "").trim(),
          priority: priority(),
          retryCount: retryCount(),
          retryDelay: retryDelay(),
          qualityGate: (qualityGate() || "").trim(),
          beforeScript: (beforeScript() || "").trim(),
          afterScript: (afterScript() || "").trim(),
          dependsOn: dependsOn(),
          triggerType: triggerType(),
          timezone: (timezone() || "").trim() || undefined,
          notBefore: (notBefore() || "").trim() || undefined,
          notAfter: (notAfter() || "").trim() || undefined,
          mcpEvent:
            triggerType() === "mcp-event"
              ? {
                  server: (mcpServer() || "").trim(),
                  event: (mcpEventName() || "").trim(),
                  ...(mcpFilter().trim() ? { filter: mcpFilter().trim() } : {}),
                }
              : undefined,
          watchPath: (watchPath() || "").trim(),
          workingDirectory: (workingDirectory() || "").trim(),
          workspaceId: (workspaceId() || "").trim() || undefined,
          allowedTools: allowedTools().length > 0 ? allowedTools() : undefined,
          deniedTools: deniedTools().length > 0 ? deniedTools() : undefined,
          matrix: matrixPayload(),
        })
        if (!result.success) {
          const short = shortError(result.message)
          setCronError(short)
          ctx.toast.show({ title: "Ошибка создания задачи", variant: "error", description: short })
          return
        }
        // Windows регистрирует задачу в Планировщике не мгновенно:
        // даём schtasks ~500 мс, иначе get_tasks может вернуть список без новой задачи.
        await new Promise((r) => setTimeout(r, 500))
        await loadJobs()

        // Форму очищаем только после успешного создания и обновления списка.
        setName("")
        setSchedule("* * * * *")
        setPrompt("")
        setCronPreset("* * * * *")
        setRetryCount(0)
        setRetryDelay(60)
        setQualityGate("")
        setDependsOn([])
        setModel("")
        setPriority(DEFAULT_PRIORITY)
        setBeforeScript("")
        setAfterScript("")
        setTriggerType("cron")
        setWatchPath("")
    setTimezone("")
    setNotBefore("")
    setNotAfter("")
        setMcpServer("")
        setMcpEventName("")
        setMcpFilter("")
        setWorkingDirectory("")
        setWorkspaceId("")
        setAllowedTools([])
        setDeniedTools([])
        resetMatrixForm()
        setEditingJob(null)
        setTemplate("custom")
        ctx.toast.show({ title: "Задача создана", variant: "success" })
      } catch (err: any) {
        console.error("RPC Error (create_task):", err)
        const msg = shortError(errorMessage(err))
        setCronError(msg)
        ctx.toast.show({ title: "Ошибка создания задачи", variant: "error", description: msg })
      } finally {
        setBusy(false)
      }
    }

    /**
     * Следит за завершением ручного запуска и показывает тост OpenCode.
     *
     * Серверный контекст плагина не имеет ctx.toast, поэтому тост показываем
     * в GUI: опрашиваем историю и ждём запись с taskName и startedAt >= since.
     */
    function watchManualRun(jobName: string) {
      const since = new Date().toISOString()
      const previous = pendingRunTimers.get(jobName)
      if (previous) clearInterval(previous)

      let attempts = 0
      const timer = setInterval(() => {
        attempts += 1
        // 900 попыток × 2 с = 30 минут; дальше просто прекращаем опрос.
        if (attempts > 900) {
          clearInterval(timer)
          pendingRunTimers.delete(jobName)
          return
        }

        void (async () => {
          try {
            const result = await rpc.get_history({ limit: 50 })
            const records = (result.records ?? []) as HistoryRecord[]
            const record = records.find(
              (r) =>
                String(r.taskName ?? "").toLowerCase() === jobName.toLowerCase() &&
                typeof r.startedAt === "string" &&
                r.startedAt >= since
            )
            if (!record) return

            clearInterval(timer)
            pendingRunTimers.delete(jobName)

            const ok = record.status === "success"
            const seconds = ((Number(record.durationMs) || 0) / 1000).toFixed(1)
            const reason = record.error ? `: ${record.error}` : ""
            ctx.toast.show({
              title: ok ? `Задача "${jobName}" выполнена` : `Задача "${jobName}" упала`,
              variant: ok ? "success" : "error",
              description: `${seconds}s${reason}`,
            })
            await loadJobs()
          } catch (err: any) {
            console.error("RPC Error (get_history):", err)
          }
        })()
      }, 2000)

      pendingRunTimers.set(jobName, timer)
    }

    async function handleRun(jobName: string) {
      // Защита от { name: undefined }: без валидного имени RPC не отправляем.
      if (!jobName || typeof jobName !== "string") {
        console.error("[GUI] run_task aborted: empty task name")
        return
      }
      try {
        const result = await rpc.run_task({ name: jobName })
        if (!result.success) {
          ctx.toast.show({ title: `Не удалось запустить "${jobName}"`, variant: "error", description: result.message })
          return
        }
        // Уже выполняющаяся задача приходит как success с сообщением
        // «Задача ... уже выполняется» — показываем мягкое уведомление, не ошибку.
        ctx.toast.show({ title: result.message || `Задача "${jobName}" запущена`, variant: "success" })
        // Для уже идущего запуска не ждём новую запись истории.
        if (!/уже выполняется/i.test(result.message || "")) {
          watchManualRun(jobName)
        }
        await loadJobs()
      } catch (err: any) {
        console.error("RPC Error (run_task):", err)
        ctx.toast.show({ title: "Ошибка запуска", variant: "error", description: errorMessage(err) })
      }
    }

    async function handlePause(jobName: string) {
      try {
        const result = await rpc.pause_task({ name: jobName })
        if (!result.success) {
          ctx.toast.show({ title: `Не удалось поставить на паузу "${jobName}"`, variant: "error", description: result.message })
          return
        }
        ctx.toast.show({ title: `Задача "${jobName}" поставлена на паузу`, variant: "success" })
        await loadJobs()
      } catch (err: any) {
        console.error("RPC Error (pause_task):", err)
        ctx.toast.show({ title: "Ошибка паузы", variant: "error", description: errorMessage(err) })
      }
    }

    async function handleResume(jobName: string) {
      try {
        const result = await rpc.resume_task({ name: jobName })
        if (!result.success) {
          ctx.toast.show({ title: `Не удалось возобновить "${jobName}"`, variant: "error", description: result.message })
          return
        }
        ctx.toast.show({ title: `Задача "${jobName}" возобновлена`, variant: "success" })
        await loadJobs()
      } catch (err: any) {
        console.error("RPC Error (resume_task):", err)
        ctx.toast.show({ title: "Ошибка возобновления", variant: "error", description: errorMessage(err) })
      }
    }

    async function handleCancelMatrix(jobName: string) {
      if (!window.confirm(`Отменить выполняющиеся клоны матрицы "${jobName}"?`)) return
      try {
        const result = await rpc.cancel_matrix({ name: jobName })
        if (!result.success) {
          ctx.toast.show({ title: "Не удалось отменить матрицу", variant: "error", description: result.message })
          return
        }
        ctx.toast.show({ title: result.message, variant: "success" })
        await loadJobs()
      } catch (err: any) {
        console.error("RPC Error (cancel_matrix):", err)
        ctx.toast.show({ title: "Ошибка отмены матрицы", variant: "error", description: errorMessage(err) })
      }
    }

    async function handleDelete(jobName: string) {
      const target = jobs().find((job) => job.name === jobName)
      const message = target?.matrix
        ? `Удалить матрицу "${jobName}" вместе со всеми клонами и агрегатором?`
        : `Удалить задачу "${jobName}"?`
      if (!window.confirm(message)) return
      try {
        const result = await rpc.delete_task({ name: jobName })
        if (!result.success) {
          ctx.toast.show({ title: "Ошибка удаления", variant: "error", description: result.message })
          return
        }
        ctx.toast.show({ title: `Задача "${jobName}" удалена`, variant: "success" })
        if (logsTask() === jobName) {
          setLogs("")
          setLogsTask(null)
        }
        if (editingJob()?.name === jobName) setEditingJob(null)
        await loadJobs()
      } catch (err: any) {
        console.error("RPC Error (delete_task):", err)
        ctx.toast.show({ title: "Ошибка удаления", variant: "error", description: errorMessage(err) })
      }
    }

    async function showLogs(jobName: string) {
      setLogsTask(jobName)
      setLogs("Загрузка логов…")
      try {
        const result = await rpc.get_task_logs({ name: jobName })
        if (!result.success) {
          setLogs(result.error || "Не удалось загрузить логи")
          ctx.toast.show({ title: "Ошибка чтения логов", variant: "error", description: result.error })
          return
        }
        setLogs(result.logs || "(пусто)")
      } catch (err: any) {
        console.error("RPC Error (get_task_logs):", err)
        setLogs("Ошибка чтения логов: " + errorMessage(err))
      }
    }

    async function handleUpdate() {
      const job = editingJob()
      if (!job) return
      setBusy(true)
      try {
        const result = await rpc.update_task({
          name: job.name,
          newSchedule: (schedule() || "").trim(),
          newPrompt: (prompt() || "").trim(),
          model: (model() || "").trim(),
          priority: priority(),
          retryCount: retryCount(),
          retryDelay: retryDelay(),
          qualityGate: (qualityGate() || "").trim(),
          beforeScript: (beforeScript() || "").trim(),
          afterScript: (afterScript() || "").trim(),
          dependsOn: dependsOn(),
          triggerType: triggerType(),
          timezone: (timezone() || "").trim() || undefined,
          notBefore: (notBefore() || "").trim() || undefined,
          notAfter: (notAfter() || "").trim() || undefined,
          mcpEvent:
            triggerType() === "mcp-event"
              ? {
                  server: (mcpServer() || "").trim(),
                  event: (mcpEventName() || "").trim(),
                  ...(mcpFilter().trim() ? { filter: mcpFilter().trim() } : {}),
                }
              : undefined,
          watchPath: (watchPath() || "").trim(),
          workingDirectory: (workingDirectory() || "").trim(),
          workspaceId: (workspaceId() || "").trim() || undefined,
          allowedTools: allowedTools().length > 0 ? allowedTools() : [],
          deniedTools: deniedTools().length > 0 ? deniedTools() : [],
          matrix: matrixPayload(),
        })
        if (!result.success) {
          setCronError(result.message)
          ctx.toast.show({ title: "Ошибка обновления задачи", variant: "error", description: result.message })
          return
        }
        setEditingJob(null)
        setName("")
        setSchedule("* * * * *")
        setPrompt("")
        setRetryCount(0)
        setRetryDelay(60)
        setQualityGate("")
        setDependsOn([])
        setModel("")
        setPriority(DEFAULT_PRIORITY)
        setBeforeScript("")
        setAfterScript("")
        setTriggerType("cron")
        setWatchPath("")
    setTimezone("")
    setNotBefore("")
    setNotAfter("")
        setMcpServer("")
        setMcpEventName("")
        setMcpFilter("")
        setWorkingDirectory("")
        setWorkspaceId("")
        setAllowedTools([])
        setDeniedTools([])
        resetMatrixForm()
        setCronPreset("* * * * *")
        await loadJobs()
        ctx.toast.show({ title: "Задача обновлена", variant: "success" })
      } catch (err: any) {
        console.error("RPC Error (update_task):", err)
        const msg = errorMessage(err)
        setCronError(msg)
        ctx.toast.show({ title: "Ошибка обновления задачи", variant: "error", description: msg })
      } finally {
        setBusy(false)
      }
    }

    function startEditing(job: Job) {
      setEditingJob(job)
      setFormCollapsed(false)
      setName(job.name)
      setSchedule(job.schedule)
      setPrompt(job.prompt ?? "")
      setModel(job.model ?? "")
      setPriority(typeof job.priority === "number" ? job.priority : DEFAULT_PRIORITY)
      setRetryCount(job.retryCount ?? 0)
      setRetryDelay(job.retryDelay ?? 60)
      setQualityGate(job.qualityGate ?? "")
      setDependsOn(Array.isArray(job.dependsOn) ? job.dependsOn : [])
      setBeforeScript(job.beforeScript ?? "")
      setAfterScript(job.afterScript ?? "")
      setTriggerType(job.triggerType ?? "cron")
      setWatchPath(job.watchPath ?? "")
      setTimezone(job.timezone ?? "")
      setNotBefore(job.notBefore ?? "")
      setNotAfter(job.notAfter ?? "")
      setMcpServer(job.mcpEvent?.server ?? "")
      setMcpEventName(job.mcpEvent?.event ?? "")
      setMcpFilter(job.mcpEvent?.filter ?? "")
      setWorkingDirectory(job.workingDirectory ?? "")
      setWorkspaceId(job.workspaceId ?? "")
      setAllowedTools(Array.isArray(job.allowedTools) ? job.allowedTools : [])
      setDeniedTools(Array.isArray(job.deniedTools) ? job.deniedTools : [])
      if (job.matrix) {
        setMatrixMode(true)
        setMatrixWorkspaceIds(Array.isArray(job.matrix.workspaceIds) ? job.matrix.workspaceIds : [])
        setMatrixStrategy(job.matrix.strategy === "sequential" ? "sequential" : "parallel")
        setMatrixFailureMode(job.matrix.failureMode === "stop" ? "stop" : "continue")
        setMatrixAggregation(job.matrix.aggregation === "per-task" ? "per-task" : "summary")
        setMatrixAggregator(Boolean(job.matrix.createAggregator))
        setMatrixConcurrency(
          typeof job.matrix.concurrency === "number" ? String(job.matrix.concurrency) : ""
        )
        setMatrixOverrides(job.matrix.overrides ? { ...job.matrix.overrides } : {})
      } else {
        resetMatrixForm()
      }
      // Определяем пресет по расписанию
      const preset = CRON_PRESETS.find((p) => p.value === job.schedule)
      setCronPreset((preset ? preset.value : "__custom__") as any)
    }

    // Автообновление списка задач каждые 5 секунд
    loadJobs()
    loadWorkspacesGui()
    loadSettingsGui()
    loadPlatformGui()
    loadTemplatesGui()
    const timer = setInterval(loadJobs, 5000)
    onCleanup(() => clearInterval(timer))

    const showCustomCron = cronPreset() === "__custom__"
    const isEditing = editingJob() !== null

    const jobsArr = () => jobs() ?? []
    const visibleJobs = () => {
      const filter = workspaceFilter()
      if (filter === "all") return jobsArr()
      if (filter === "none") return jobsArr().filter((job) => !job.workspaceId)
      return jobsArr().filter((job) => job.workspaceId === filter)
    }

    /**
     * Кандидаты в зависимости: все задачи, кроме редактируемой/создаваемой.
     * Сравнение без учёта регистра — как в tasks.json.
     */
    const dependencyCandidates = () => {
      const self = (editingJob()?.name ?? name()).trim().toLowerCase()
      return jobsArr()
        .map((job) => job.name)
        .filter((taskName) => taskName.trim().toLowerCase() !== self)
    }

    /** Добавляет/убирает задачу из списка DAG-зависимостей. */
    function toggleDependsOn(taskName: string, checked: boolean) {
      setDependsOn((current) => {
        if (checked) {
          return current.some((n) => n.toLowerCase() === taskName.toLowerCase())
            ? current
            : [...current, taskName]
        }
        return current.filter((n) => n.toLowerCase() !== taskName.toLowerCase())
      })
    }

    // Имя задачи, на кнопке «Запустить» которой сейчас курсор (для снежинки в зимнем режиме).
    const [hoveredRun, setHoveredRun] = createSignal<string | null>(null)

    /** Базовый стиль маленькой иконки-кнопки в карточке задачи. */
    function iconButtonStyle(active = false): string {
      return `background:${active ? "rgba(90,200,250,0.16)" : "transparent"};border:1px solid ${active ? "rgba(90,200,250,0.5)" : "#333"};border-radius:6px;width:32px;height:32px;display:flex;align-items:center;justify-content:center;cursor:pointer;color:${active ? "#5ac8fa" : "#cfcfd2"};font-size:14px;line-height:1;padding:0;transition:background 0.18s ease, border-color 0.18s ease, color 0.18s ease`
    }

    /** Плавный hover: лёгкая подсветка фона + смена цвета иконки. */
    function iconHover(e: MouseEvent, on: boolean, active = false) {
      const btn = e.currentTarget as HTMLButtonElement | null
      if (!btn) return
      btn.style.background = on
        ? "rgba(255,255,255,0.09)"
        : active
        ? "rgba(90,200,250,0.16)"
        : "transparent"
      btn.style.borderColor = on ? "#5ac8fa" : active ? "rgba(90,200,250,0.5)" : "#333"
      btn.style.color = on || active ? "#5ac8fa" : "#cfcfd2"
    }

    /**
     * Карточка задачи.
     * SolidJS вызывает компонент с объектом пропсов, поэтому сигнатура
     * `(props: { job: Job })` соответствует вызову `<JobCard job={job} />`.
     * Обращаемся к `props.job` (а не деструктурируем) — так сохраняется реактивность.
     */
    const JobCard = (props: { job: Job }) => {
      const job = props.job
      // Защита: без имени задача не может быть отрендерена и не должна слать RPC.
      if (!job || !job.name) return null
      return (
      <div
        style={`background:#252526;border-radius:10px;padding:16px;margin-bottom:12px;display:flex;flex-direction:column;gap:10px;border:1px solid ${winterMode() ? "rgba(135, 206, 250, 0.4)" : "#333"}`}
      >
        <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;width:100%">
        <div style="display:flex;align-items:center;gap:12px;flex:1;min-width:0">
          <div style="flex:1;min-width:0">
            <div style="display:flex;align-items:center;gap:6px;min-width:0">
              <div style="font-weight:700;font-size:16px;color:#ffffff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
                {job.name}
              </div>
              {job.workspaceName && (
                <span
                  title={`Workspace: ${job.workspaceName}${job.workingDirectory ? ` (${job.workingDirectory})` : ""}`}
                  style={`font-size:11px;font-weight:600;flex-shrink:0;cursor:help;white-space:nowrap;padding:2px 7px;border-radius:999px;border:1px solid ${job.workspaceColor || "#5ac8fa"};color:${job.workspaceColor || "#5ac8fa"};background:${(job.workspaceColor || "#5ac8fa")}1a`}
                >📦 {job.workspaceName}</span>
              )}
              {job.isMatrixParent && job.matrix && (
                <span
                  title={`Matrix fan-out: ${job.matrix.workspaceIds.length} клонов, стратегия: ${job.matrix.strategy ?? "parallel"}, при ошибке: ${job.matrix.failureMode ?? "continue"}${
                    job.matrix.concurrency
                      ? `, одновременно: ${job.matrix.concurrency}`
                      : ""
                  }${
                    job.matrix.overrides
                      ? `, переопределено workspace: ${Object.keys(job.matrix.overrides).length}`
                      : ""
                  }`}
                  style="font-size:11px;font-weight:600;flex-shrink:0;cursor:help;white-space:nowrap;padding:2px 7px;border-radius:999px;border:1px solid #ff9f0a;color:#ff9f0a;background:rgba(255,159,10,0.12)"
                >📦 Matrix ({job.matrix.workspaceIds.length}){job.matrix.concurrency ? ` ⚙${job.matrix.concurrency}` : ""}</span>
              )}
              {job.matrixParentId && (
                <span
                  title={`Клон матрицы. Родитель: ${job.matrixParentId}`}
                  style="font-size:11px;font-weight:600;flex-shrink:0;cursor:help;white-space:nowrap;padding:2px 7px;border-radius:999px;border:1px solid #8e8e93;color:#b0b0b6;background:rgba(142,142,147,0.12)"
                >↳ matrix {job.matrixParentId}</span>
              )}
              {job.watchPath && (
                <span title={`Отслеживание файла: ${job.watchPath}`} style="font-size:13px;flex-shrink:0;cursor:help">👁️</span>
              )}
              {job.timezone && (
                <span title={`Часовой пояс задачи: ${job.timezone}`} style="font-size:11px;font-weight:600;flex-shrink:0;cursor:help;white-space:nowrap;padding:2px 7px;border-radius:999px;border:1px solid #64d2ff;color:#64d2ff;background:rgba(100,210,255,0.12)">🌍 {job.timezone}</span>
              )}
              {job.notBefore && job.notAfter && (
                <span title={`Окно запуска: ${job.notBefore}–${job.notAfter}. Вне окна запуск переносится на его открытие.`} style="font-size:11px;font-weight:600;flex-shrink:0;cursor:help;white-space:nowrap;padding:2px 7px;border-radius:999px;border:1px solid #bf5af2;color:#bf5af2;background:rgba(191,90,242,0.12)">🪟 {job.notBefore}–{job.notAfter}</span>
              )}
              {job.pausedUntil && (
                <span title={`Пауза до ${new Date(job.pausedUntil).toLocaleString()} — задача включится автоматически.`} style="font-size:11px;font-weight:600;flex-shrink:0;cursor:help;white-space:nowrap;padding:2px 7px;border-radius:999px;border:1px solid #ffd60a;color:#ffd60a;background:rgba(255,214,10,0.12)">⏸ до {new Date(job.pausedUntil).toLocaleDateString()}</span>
              )}
              {(job.beforeScript || job.afterScript) && (
                <span
                  title={`Lifecycle hooks: ${[job.beforeScript ? `pre: ${job.beforeScript}` : "", job.afterScript ? `post: ${job.afterScript}` : ""].filter(Boolean).join(" · ")}`}
                  style="font-size:13px;flex-shrink:0;cursor:help"
                >⚡</span>
              )}
              {job.triggerType === "mcp-event" && (
                <span
                  title={`MCP-событие: ${job.mcpEvent?.event ?? "—"}${job.mcpEvent?.filter ? ` (фильтр: ${job.mcpEvent.filter})` : ""}`}
                  style="font-size:13px;flex-shrink:0;cursor:help"
                >📡</span>
              )}
              {job.model && (
                <span title={`Модель LLM: ${job.model}`} style="font-size:12px;flex-shrink:0;cursor:help;color:#c084fc;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:200px">🧠 {job.model}</span>
              )}
              {typeof job.priority === "number" && job.priority !== DEFAULT_PRIORITY && (
                <span title={`Приоритет: ${priorityLabel(job.priority)} (${job.priority})`} style="font-size:12px;flex-shrink:0;cursor:help;color:#f5a623;white-space:nowrap">🚀 {priorityLabel(job.priority)}</span>
              )}
              {(Array.isArray(job.allowedTools) && job.allowedTools.length > 0) || (Array.isArray(job.deniedTools) && job.deniedTools.length > 0) ? (
                <span
                  title={`Ограничения инструментов: ${[
                    job.allowedTools?.length ? `allowed=[${job.allowedTools.join(", ")}]` : "",
                    job.deniedTools?.length ? `denied=[${job.deniedTools.join(", ")}]` : "",
                  ].filter(Boolean).join(" · ")}`}
                  style="font-size:13px;flex-shrink:0;cursor:help"
                >🔒</span>
              ) : null}
            </div>
            {Array.isArray(job.dependsOn) && job.dependsOn.length > 0 && (
              <div style="display:flex;flex-direction:column;gap:2px;margin-top:4px;font-size:11px;line-height:1.35">
                <span style="color:#5ac8fa;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">🔗 Зависит от: {job.dependsOn.join(" + ")}</span>
              </div>
            )}
            {job.isMatrixParent && job.matrixSummary && (
              <div style="display:flex;flex-direction:column;gap:2px;margin-top:4px;font-size:11px;line-height:1.35">
                <span
                  title={job.matrixSummary.message}
                  style={`cursor:help;color:${statusColor(job.matrixSummary.status as JobStatus)};white-space:nowrap;overflow:hidden;text-overflow:ellipsis`}
                >
                  📦 Matrix: {job.matrixSummary.successCount}/{job.matrixSummary.totalCount} успешных
                  {job.matrixSummary.errorCount > 0 ? ` · ❌ ${job.matrixSummary.errorCount}` : ""}
                  {job.matrixSummary.pendingCount > 0 ? ` · ⏳ ${job.matrixSummary.pendingCount}` : ""}
                </span>
              </div>
            )}
            <div style="font-size:12px;color:#a0a0a6;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
              📊 Всего: {metrics().total} | ✅ {metrics().success} | ❌ {metrics().error}
            </div>
            {(job.schedule || job.nextRun) && (
              <div style="display:flex;align-items:center;gap:8px;font-size:12px;color:#a0a0a6;margin-top:2px">
                <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{job.schedule}</span>
                {job.nextRun && <span>→ {job.nextRun}</span>}
              </div>
            )}
          </div>
          <div style="display:flex;align-items:center;gap:8px;flex-shrink:0;min-width:110px">
            {job.status === "running" ? (
              <div style="font-size:12px;color:#f5a623;font-weight:600;white-space:nowrap">
                🟡 Выполняется: {runningSec()} сек
              </div>
            ) : (
              <div style="font-size:12px;font-weight:600;white-space:nowrap">
                {job.status === "success"
                  ? "🟢 Готова"
                  : job.status === "error"
                  ? "🔴 Ошибка"
                  : job.status === "partial"
                  ? "🟠 Частично"
                  : "⚪ Пауза"}
              </div>
            )}
          </div>
        </div>
        <div style="display:flex;gap:6px">
          <button
            onClick={() => void handleRun(job.name)}
            title={`Запустить "${job.name}"`}
            style={iconButtonStyle()}
            onMouseEnter={(e) => {
              iconHover(e, true)
              if (winterMode()) setHoveredRun(job.name)
            }}
            onMouseLeave={(e) => {
              iconHover(e, false)
              setHoveredRun((n) => (n === job.name ? null : n))
            }}
          >
            {winterMode() && hoveredRun() === job.name ? "❄️" : "▶"}
          </button>
          <button
            onClick={() => void (job.paused ? handleResume(job.name) : handlePause(job.name))}
            title={job.paused ? `Возобновить "${job.name}"` : `Поставить на паузу "${job.name}"`}
            style={iconButtonStyle()}
            onMouseEnter={(e) => iconHover(e, true)}
            onMouseLeave={(e) => iconHover(e, false)}
          >
            {job.paused ? "▶" : "⏸"}
          </button>
          <button
            onClick={() => void showLogs(job.name)}
            title={`Логи "${job.name}"`}
            style={iconButtonStyle()}
            onMouseEnter={(e) => iconHover(e, true)}
            onMouseLeave={(e) => iconHover(e, false)}
          >
            📄
          </button>
          <button
            onClick={() => void openDryRun(job.name)}
            title={`Dry-Run симуляция "${job.name}"`}
            style={iconButtonStyle(dryRunOpen() && dryRunName() === job.name)}
            onMouseEnter={(e) => iconHover(e, true, dryRunOpen() && dryRunName() === job.name)}
            onMouseLeave={(e) => iconHover(e, false, dryRunOpen() && dryRunName() === job.name)}
          >
            🧪
          </button>
          <button
            onClick={() => void fetchHistory(job.name)}
            title={`История "${job.name}"`}
            style={iconButtonStyle(historyOpen() === job.name)}
            onMouseEnter={(e) => iconHover(e, true, historyOpen() === job.name)}
            onMouseLeave={(e) => iconHover(e, false, historyOpen() === job.name)}
          >
            📜
          </button>
          <button
            onClick={() => void startEditing(job)}
            title={`Редактировать "${job.name}"`}
            style={iconButtonStyle()}
            onMouseEnter={(e) => iconHover(e, true)}
            onMouseLeave={(e) => iconHover(e, false)}
          >
            ✏️
          </button>
          {job.matrix && (
            <button
              onClick={() => void handleCancelMatrix(job.name)}
              title={`Отменить выполняющиеся клоны матрицы "${job.name}"`}
              style={iconButtonStyle()}
              onMouseEnter={(e) => iconHover(e, true)}
              onMouseLeave={(e) => iconHover(e, false)}
            >
              ⛔
            </button>
          )}
          {!job.matrixParentId && (
            <button
              onClick={() => void handleDelete(job.name)}
              title={job.matrix ? `Удалить матрицу "${job.name}" вместе с клонами` : `Удалить "${job.name}"`}
              style={iconButtonStyle()}
              onMouseEnter={(e) => iconHover(e, true)}
              onMouseLeave={(e) => iconHover(e, false)}
            >
              🗑
            </button>
          )}
        </div>
        </div>
        {historyOpen() === job.name && (
          <div style="margin-top:8px;padding:8px 12px;background:#1e1e1e;border:1px solid #333;border-radius:6px;display:flex;flex-direction:column;gap:6px;width:100%">
            <div style="font-size:12px;font-weight:600;color:#ffffff;display:flex;align-items:center;gap:6px">
              📜 История последних запусков
              <button
                onClick={() => setHistoryOpen(null)}
                style="background:none;border:none;color:#8e8e93;cursor:pointer;font-size:14px;padding:0"
                onMouseEnter={(e) => { (e.target as HTMLButtonElement).style.color = "#ffffff" }}
                onMouseLeave={(e) => { (e.target as HTMLButtonElement).style.color = "#8e8e93" }}
              >
                ✕
              </button>
            </div>
            {history().length === 0 ? (
              <div style="font-size:12px;color:#8e8e93;padding:6px 0">Запусков пока нет.</div>
            ) : (
              history().map((r) => (
                <div key={r.startedAt + r.durationMs} style="display:flex;align-items:flex-start;gap:10px;font-size:12px;color:#e0e0e0;padding:4px 0;border-bottom:1px solid #333">
                  <span style="color:#8e8e93;white-space:nowrap">{new Date(r.startedAt).toLocaleString()}</span>
                  <span style={{color: r.status === "success" ? "#34c759" : "#ff3b30", fontWeight: 600, whiteSpace: "nowrap"}}>
                    {r.status === "success" ? "✅ Успех" : "❌ Ошибка"}
                  </span>
                  <span style="color:#b0b0b0;white-space:nowrap">{r.durationMs} мс</span>
                  {r.model && (
                    <span style="color:#c084fc;white-space:nowrap" title={`Модель: ${r.model}`}>🧠 {r.model}</span>
                  )}
                  {r.preFlightStatus && r.preFlightStatus !== "skipped" && (
                    <span
                      title={`Pre-flight: ${r.preFlightStatus}`}
                      style={{ color: r.preFlightStatus === "success" ? "#34c759" : "#ff3b30", whiteSpace: "nowrap" }}
                    >
                      ⚡ pre: {r.preFlightStatus === "success" ? "✅" : "❌"}
                    </span>
                  )}
                  {r.postFlightStatus && r.postFlightStatus !== "skipped" && (
                    <span
                      title={`Post-flight: ${r.postFlightStatus}`}
                      style={{ color: r.postFlightStatus === "success" ? "#34c759" : "#ff3b30", whiteSpace: "nowrap" }}
                    >
                      ⚡ post: {r.postFlightStatus === "success" ? "✅" : "❌"}
                    </span>
                  )}
                  {r.error && (
                    <div style="margin-top:2px;color:#ff6b6b;font-size:11px;white-space:pre-wrap;word-break:break-word">{r.error}</div>
                  )}
                  {r.nextTask && (
                    <span style="color:#5ac8fa;font-size:11px;white-space:nowrap" title="Запущена следующая задача в цепочке">🔗 → {r.nextTask}</span>
                  )}
                </div>
              ))
            )}
          </div>
        )}
        {dryRunOpen() && dryRunName() === job.name && (
          <div style="margin-top:8px;padding:8px 12px;background:#1e1e1e;border:1px solid #333;border-radius:6px;display:flex;flex-direction:column;gap:6px;width:100%">
            <div style="font-size:12px;font-weight:600;color:#ffffff;display:flex;align-items:center;gap:6px">
              🧪 Dry-Run: {job.name}
              <button
                onClick={() => closeDryRun()}
                style="background:none;border:none;color:#8e8e93;cursor:pointer;font-size:14px;padding:0"
                onMouseEnter={(e) => { (e.target as HTMLButtonElement).style.color = "#ffffff" }}
                onMouseLeave={(e) => { (e.target as HTMLButtonElement).style.color = "#8e8e93" }}
              >
                ✕
              </button>
            </div>
            {dryRunBusy() && <div style="font-size:12px;color:#8e8e93;padding:6px 0">Симуляция…</div>}
            {!dryRunBusy() && dryRunReport() && !dryRunReport().success && (
              <div style="font-size:12px;color:#ff6b6b;padding:6px 0">❌ {dryRunReport().error ?? "Симуляция не удалась"}</div>
            )}
            {!dryRunBusy() && dryRunReport() && dryRunReport().success && (
              <div style="display:flex;flex-direction:column;gap:4px">
                {Array.isArray(dryRunReport().warnings) && dryRunReport().warnings.length > 0 && (
                  <div style="font-size:11px;color:#f5a623;padding:4px 0">
                    ⚠ {dryRunReport().warnings.map((w: string) => `· ${w}`).join(" | ")}
                  </div>
                )}
                {dryRunReport().tasks.map((t: any) => (
                  <div key={`${t.name}-${t.order}`} style="font-size:11px;color:#e0e0e0;padding:4px 0;border-bottom:1px solid #333;display:flex;flex-wrap:wrap;gap:6px;align-items:baseline">
                    <span style="color:#8e8e93;white-space:nowrap">#{(t.order ?? 0) + 1} {t.trigger}</span>
                    <span style="font-weight:600;white-space:nowrap">🧪 {t.name}</span>
                    {t.workspace && <span style="color:#5ac8fa;white-space:nowrap">📦 {t.workspace.name}</span>}
                    {t.matrixParent && <span style="color:#ff9f0a;white-space:nowrap">↳ matrix {t.matrixParent}</span>}
                    <span style="color:#8e8e93;white-space:nowrap">cwd: {t.cwd || "(папка проекта)"}</span>
                    {t.roleScoped && <span style="cursor:help" title={`allowed=[${(t.roleScoped.allowed ?? []).join(", ")}] · denied=[${(t.roleScoped.denied ?? []).join(", ")}]`}>🔒</span>}
                    {t.estimatedDurationSec != null && <span style="color:#8e8e93;white-space:nowrap">⏱ ~{t.estimatedDurationSec} с</span>}
                    {t.estimatedTokens != null && <span style="color:#8e8e93;white-space:nowrap">· ~{t.estimatedTokens} ток.</span>}
                    {t.estimatedCostUsd != null && <span style="color:#8e8e93;white-space:nowrap">· ~${Number(t.estimatedCostUsd).toFixed(4)}</span>}
                    <div style="width:100%;color:#a0a0a6;overflow-wrap:anywhere">$ {t.command}</div>
                    {t.preFlight && <div style="width:100%;color:#8e8e93;overflow-wrap:anywhere">⚡ pre: {t.preFlight}</div>}
                    {t.postFlight && <div style="width:100%;color:#8e8e93;overflow-wrap:anywhere">⚡ post: {t.postFlight}</div>}
                    {t.qualityGate && <div style="width:100%;color:#8e8e93;overflow-wrap:anywhere">✅ QG: {t.qualityGate}</div>}
                  </div>
                ))}
                {dryRunReport().totals && (dryRunReport().totals.estimatedDurationSec != null || dryRunReport().totals.estimatedTokens != null) && (
                  <div style="font-size:11px;color:#b0b0b0;padding:4px 0">
                    Σ {(dryRunReport().totals.estimatedDurationSec ?? "—") + " с · " +
                      (dryRunReport().totals.estimatedTokens ?? "—") + " токенов" +
                      (dryRunReport().totals.estimatedCostUsd != null ? ` · ~$${Number(dryRunReport().totals.estimatedCostUsd).toFixed(4)}` : "")}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
      )
    }

    try {
      return ctx.add(Panel, {
        id: "scheduler-jobs",
        region: "side",
        list: () => [{ id: "jobs", title: "Планировщик", pinned: true }],
        render: () => (
          <ErrorBoundary fallback={(err: any) => (
            <div style="padding:16px;color:#ff3b30;font-size:13px">
              Ошибка UI: {err.message}
            </div>
          )}>
            <div style={`display:flex;flex-direction:column;width:100%;height:100%;max-height:100vh;min-height:0;box-sizing:border-box;overflow-y:auto;overflow-x:hidden;gap:24px;padding:20px;font-size:13px;font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;color:#e0e0e0;transition:background 0.3s ease;scrollbar-width:thin;scrollbar-color:#444 transparent;background:${winterMode() ? "linear-gradient(180deg, #0f172a 0%, #000000 100%)" : "#0f0f0f"}`}>
            <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap">
              <div style="min-width:0">
                <h2 style="margin:0;font-size:22px;font-weight:800;letter-spacing:0.2px;line-height:1.2;color:#ffffff">
                  {winterMode() ? `❄️ ${schedulerTitle()} ❄️` : schedulerTitle()}
                </h2>
                <div style="margin-top:5px;font-size:11px;font-weight:600;letter-spacing:1.2px;text-transform:uppercase;color:#8e8e93">
                  Local AI CI/CD Orchestrator
                </div>
              </div>
              <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
                <select
                  value={workspaceFilter()}
                  onChange={(e) => setWorkspaceFilter(e.currentTarget.value)}
                  title="Фильтр задач по workspace"
                  style="padding:6px 10px;border-radius:999px;cursor:pointer;font-size:12px;border:1px solid #333;background:#1e1e1e;color:#e0e0e0;outline:none;max-width:200px"
                >
                  <option value="all">Все workspace</option>
                  {workspaces().map((workspace) => (
                    <option key={workspace.id} value={workspace.id}>📦 {workspace.name}</option>
                  ))}
                  <option value="none">Без workspace</option>
                </select>
                <button
                  onClick={async () => {
                    // Открываем окно сразу (внутри клика), чтобы не сработал блокировщик попапов.
                    const win = window.open("", "_blank");
                    let port = 3782;
                    try {
                      const info = await rpc.get_dashboard_port({});
                      if (info && typeof info.port === "number" && info.port > 0) {
                        port = info.port;
                      }
                    } catch (err) {
                      console.warn("[scheduler] Не удалось получить порт дашборда:", err);
                    }
                    const url = "http://localhost:" + port;
                    if (win) win.location.href = url;
                    else window.open(url, "_blank");
                  }}
                  title="Открыть локальный веб-дашборд (фактический порт сервера)"
                  style="display:flex;align-items:center;gap:6px;padding:6px 12px;border-radius:999px;cursor:pointer;font-size:12px;user-select:none;white-space:nowrap;transition:background 0.2s ease, border-color 0.2s ease;border:1px solid #333;background:#1e1e1e;color:#e0e0e0"
                  onMouseEnter={(e) => { const b = e.currentTarget; b.style.borderColor = "#5ac8fa"; b.style.background = "rgba(90,200,250,0.12)"; b.style.color = "#5ac8fa" }}
                  onMouseLeave={(e) => { const b = e.currentTarget; b.style.borderColor = "#333"; b.style.background = "#1e1e1e"; b.style.color = "#e0e0e0" }}
                >
                  🌐 Открыть дашборд
                </button>
                <label
                  title="Переключить зимнюю тему"
                  style={`display:flex;align-items:center;gap:6px;padding:6px 12px;border-radius:999px;cursor:pointer;font-size:12px;user-select:none;white-space:nowrap;transition:background 0.2s ease, border-color 0.2s ease;border:1px solid ${winterMode() ? "rgba(135, 206, 250, 0.5)" : "#333"};background:${winterMode() ? "rgba(135, 206, 250, 0.12)" : "#1e1e1e"};color:#e0e0e0`}
                >
                  <input
                    type="checkbox"
                    checked={winterMode()}
                    onChange={(e) => void toggleWinterMode(e.currentTarget.checked)}
                    style="accent-color:#5ac8fa;cursor:pointer;margin:0"
                  />
                  ❄️ Зимний режим
                </label>
              </div>
            </div>

            <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
              <button
                onClick={handleExport}
                disabled={exportBusy()}
                style={`padding:6px 12px;background:#007acc;color:white;border:none;border-radius:6px;cursor:${exportBusy() ? "not-allowed" : "pointer"};font-size:12px;font-weight:500;opacity:${exportBusy() ? 0.6 : 1};transition:background 0.18s ease`}
              >
                {exportBusy() ? "Экспорт..." : "Экспорт"}
              </button>
              <input
                type="file"
                accept=".json"
                onChange={handleImportFile}
                style="display:none"
              />
              <button
                onClick={() => document.querySelector('input[type="file"]')?.click()}
                disabled={importBusy()}
                style={`padding:6px 12px;background:#007acc;color:white;border:none;border-radius:6px;cursor:${importBusy() ? "not-allowed" : "pointer"};font-size:12px;font-weight:500;opacity:${importBusy() ? 0.6 : 1};transition:background 0.18s ease`}
              >
                {importBusy() ? "Импорт..." : "Импорт"}
              </button>
            </div>

            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:8px">
              <label style="font-size:12px;color:#b0b0b0;font-weight:500;white-space:nowrap">Макс. одновременных задач:</label>
              <input
                type="number"
                min="0"
                value={maxConcurrent()}
                onChange={(e) => saveSettingsGui(Number(e.currentTarget.value) || 1)}
                style="width:60px;padding:4px 6px;background:#1e1e1e;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;outline:none"
              />
              <span style="font-size:11px;color:#8e8e93;white-space:nowrap">(0 = без ограничений)</span>
            </div>

            {/* 🔔 Уведомления (сворачиваемая секция, чтобы не загромождать форму) */}
            <div style="width:100%;max-width:700px;box-sizing:border-box;margin-top:8px;background:#1e1e1e;border:1px solid #333;border-radius:10px;overflow:hidden">
              <button
                onClick={() => setNotificationsCollapsed(!notificationsCollapsed())}
                style="display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;box-sizing:border-box;padding:10px 14px;background:transparent;border:none;color:#e0e0e0;font-size:12px;font-weight:600;cursor:pointer;text-align:left"
              >
                <span>🔔 Уведомления</span>
                <span style="display:flex;align-items:center;gap:8px;font-size:11px;font-weight:400;color:#8e8e93">
                  {notificationsEnabled() ? (onlyOnError() ? "только ошибки" : "все запуски") : "выключены"}
                  <span>{notificationsCollapsed() ? "▾" : "▴"}</span>
                </span>
              </button>

              {!notificationsCollapsed() && (
                <div style="padding:0 14px 14px;display:flex;flex-direction:column;gap:10px">
                  <label style="display:flex;align-items:center;gap:8px;font-size:12px;color:#e0e0e0;cursor:pointer">
                    <input
                      type="checkbox"
                      checked={notificationsEnabled()}
                      onChange={(e) => {
                        setNotificationsEnabled(e.currentTarget.checked)
                        void saveNotificationSettings()
                      }}
                      style="accent-color:#5ac8fa;cursor:pointer;margin:0"
                    />
                    Включить уведомления
                  </label>

                  <label style={`display:flex;align-items:center;gap:8px;font-size:12px;cursor:pointer;opacity:${notificationsEnabled() ? 1 : 0.5}`}>
                    <input
                      type="checkbox"
                      checked={onlyOnError()}
                      disabled={!notificationsEnabled()}
                      onChange={(e) => {
                        setOnlyOnError(e.currentTarget.checked)
                        void saveNotificationSettings()
                      }}
                      style="accent-color:#5ac8fa;cursor:pointer;margin:0"
                    />
                    Только при ошибке
                  </label>

                  <div style="border-top:1px solid #333;padding-top:10px;display:flex;flex-direction:column;gap:8px">
                    <label style={`display:flex;align-items:center;gap:8px;font-size:12px;cursor:pointer;opacity:${notificationsEnabled() ? 1 : 0.5}`}>
                      <input
                        type="checkbox"
                        checked={webhookEnabled()}
                        disabled={!notificationsEnabled()}
                        onChange={(e) => {
                          setWebhookEnabled(e.currentTarget.checked)
                          void saveNotificationSettings()
                        }}
                        style="accent-color:#5ac8fa;cursor:pointer;margin:0"
                      />
                      Webhook (Discord / Slack / generic)
                    </label>
                    <input
                      type="url"
                      value={webhookUrl() || ""}
                      disabled={!notificationsEnabled() || !webhookEnabled()}
                      onInput={(e) => setWebhookUrl(e.currentTarget.value)}
                      onChange={() => void saveNotificationSettings()}
                      placeholder="https://discord.com/api/webhooks/..."
                      style={`display:block;width:100%;box-sizing:border-box;padding:8px;background:#1e1e1e;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;outline:none;opacity:${notificationsEnabled() && webhookEnabled() ? 1 : 0.5}`}
                    />
                    <div style="font-size:11px;color:#8e8e93">
                      POST с JSON {"{ content, text }"} — совместимо с Discord и Slack.
                    </div>
                    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:11px;color:#b0b0b0">
                      <span>Таймаут, мс:</span>
                      <input
                        type="number"
                        min="1000"
                        max="120000"
                        step="1000"
                        value={webhookTimeoutMs()}
                        disabled={!notificationsEnabled() || !webhookEnabled()}
                        onInput={(e) => setWebhookTimeoutMs(Number(e.currentTarget.value) || 10000)}
                        onChange={() => void saveNotificationSettings()}
                        style="width:80px;padding:4px 6px;background:#1e1e1e;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;outline:none"
                      />
                      <span>повторов:</span>
                      <input
                        type="number"
                        min="0"
                        max="5"
                        value={webhookRetryCount()}
                        disabled={!notificationsEnabled() || !webhookEnabled()}
                        onInput={(e) => setWebhookRetryCount(Number(e.currentTarget.value) || 0)}
                        onChange={() => void saveNotificationSettings()}
                        style="width:56px;padding:4px 6px;background:#1e1e1e;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;outline:none"
                      />
                      <span>пауза, мс:</span>
                      <input
                        type="number"
                        min="100"
                        max="60000"
                        step="100"
                        value={webhookRetryDelayMs()}
                        disabled={!notificationsEnabled() || !webhookEnabled()}
                        onInput={(e) => setWebhookRetryDelayMs(Number(e.currentTarget.value) || 1000)}
                        onChange={() => void saveNotificationSettings()}
                        style="width:80px;padding:4px 6px;background:#1e1e1e;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;outline:none"
                      />
                    </div>
                    <div style="font-size:11px;color:#8e8e93">
                      Повтор при сетевой ошибке, таймауте, 5xx и 429 (экспоненциальная пауза).
                    </div>
                  </div>

                  {/* Фильтры по задачам (Спринт 20) */}
                  <div style="border-top:1px solid #333;padding-top:10px;display:flex;flex-direction:column;gap:8px">
                    <div style="font-size:12px;color:#e0e0e0;font-weight:600">Фильтры по задачам</div>
                    <input
                      type="text"
                      value={filterInclude() || ""}
                      disabled={!notificationsEnabled()}
                      onInput={(e) => setFilterInclude(e.currentTarget.value)}
                      onChange={() => void saveNotificationSettings()}
                      placeholder="Только эти задачи (через запятую, * — маска)"
                      style={`display:block;width:100%;box-sizing:border-box;padding:8px;background:#1e1e1e;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;outline:none;opacity:${notificationsEnabled() ? 1 : 0.5}`}
                    />
                    <input
                      type="text"
                      value={filterExclude() || ""}
                      disabled={!notificationsEnabled()}
                      onInput={(e) => setFilterExclude(e.currentTarget.value)}
                      onChange={() => void saveNotificationSettings()}
                      placeholder="Исключить задачи (через запятую, * — маска)"
                      style={`display:block;width:100%;box-sizing:border-box;padding:8px;background:#1e1e1e;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;outline:none;opacity:${notificationsEnabled() ? 1 : 0.5}`}
                    />
                    <div style="font-size:11px;color:#8e8e93">
                      Пустой список «только» = все задачи. Исключения важнее включений.
                    </div>
                  </div>

                  {/* Шаблоны сообщений (Спринт 20) */}
                  <div style="border-top:1px solid #333;padding-top:10px;display:flex;flex-direction:column;gap:8px">
                    <div style="font-size:12px;color:#e0e0e0;font-weight:600">Шаблоны сообщений</div>
                    <input
                      type="text"
                      value={templateSuccess() || ""}
                      disabled={!notificationsEnabled()}
                      onInput={(e) => setTemplateSuccess(e.currentTarget.value)}
                      onChange={() => void saveNotificationSettings()}
                      placeholder={'✅ Задача "{task}" выполнена ({duration})'}
                      style={`display:block;width:100%;box-sizing:border-box;padding:8px;background:#1e1e1e;border:1px solid #333;border-radius:6px;color:#fff;font-size:12px;outline:none;opacity:${notificationsEnabled() ? 1 : 0.5}`}
                    />
                    <input
                      type="text"
                      value={templateError() || ""}
                      disabled={!notificationsEnabled()}
                      onInput={(e) => setTemplateError(e.currentTarget.value)}
                      onChange={() => void saveNotificationSettings()}
                      placeholder={'❌ Задача "{task}" упала ({duration}){error}'}
                      style={`display:block;width:100%;box-sizing:border-box;padding:8px;background:#1e1e1e;border:1px solid #333;border-radius:6px;color:#fff;font-size:12px;outline:none;opacity:${notificationsEnabled() ? 1 : 0.5}`}
                    />
                    <div style="font-size:11px;color:#8e8e93">
                      Плейсхолдеры: {"{task} {status} {duration} {error} {emoji}"}. Пусто = шаблон по умолчанию.
                    </div>
                  </div>

                  {/* Уведомления о матрицах (Спринт 20) */}
                  <div style="border-top:1px solid #333;padding-top:10px;display:flex;flex-direction:column;gap:8px">
                    <div style="font-size:12px;color:#e0e0e0;font-weight:600">Матрицы</div>
                    <label style={`display:flex;align-items:center;gap:8px;font-size:12px;cursor:pointer;opacity:${notificationsEnabled() ? 1 : 0.5}`}>
                      <input
                        type="checkbox"
                        checked={matrixNotifyEnabled()}
                        disabled={!notificationsEnabled()}
                        onChange={(e) => {
                          setMatrixNotifyEnabled(e.currentTarget.checked)
                          void saveNotificationSettings()
                        }}
                        style="accent-color:#5ac8fa;cursor:pointer;margin:0"
                      />
                      Уведомлять о завершении матриц
                    </label>
                    <div style={`display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:12px;color:#b0b0b0;opacity:${notificationsEnabled() && matrixNotifyEnabled() ? 1 : 0.5}`}>
                      <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
                        <input
                          type="checkbox"
                          checked={matrixNotifyPartial()}
                          disabled={!notificationsEnabled() || !matrixNotifyEnabled()}
                          onChange={(e) => {
                            setMatrixNotifyPartial(e.currentTarget.checked)
                            void saveNotificationSettings()
                          }}
                          style="accent-color:#5ac8fa;cursor:pointer;margin:0"
                        />
                        partial
                      </label>
                      <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
                        <input
                          type="checkbox"
                          checked={matrixNotifyAllFailed()}
                          disabled={!notificationsEnabled() || !matrixNotifyEnabled()}
                          onChange={(e) => {
                            setMatrixNotifyAllFailed(e.currentTarget.checked)
                            void saveNotificationSettings()
                          }}
                          style="accent-color:#5ac8fa;cursor:pointer;margin:0"
                        />
                        все упали
                      </label>
                      <span>зависший клон, мин:</span>
                      <input
                        type="number"
                        min="0"
                        max="10080"
                        value={matrixStuckMinutes()}
                        disabled={!notificationsEnabled() || !matrixNotifyEnabled()}
                        onInput={(e) => setMatrixStuckMinutes(Number(e.currentTarget.value) || 0)}
                        onChange={() => void saveNotificationSettings()}
                        style="width:72px;padding:4px 6px;background:#1e1e1e;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;outline:none"
                      />
                    </div>
                    <div style="font-size:11px;color:#8e8e93">
                      Клон, выполняющийся дольше указанного времени, уведомляется один раз. 0 — выключить.
                    </div>
                  </div>

                  {/* Дайджест (Спринт 20) */}
                  <div style="border-top:1px solid #333;padding-top:10px;display:flex;flex-direction:column;gap:8px">
                    <div style="font-size:12px;color:#e0e0e0;font-weight:600">Дайджест</div>
                    <label style={`display:flex;align-items:center;gap:8px;font-size:12px;cursor:pointer;opacity:${notificationsEnabled() ? 1 : 0.5}`}>
                      <input
                        type="checkbox"
                        checked={digestEnabled()}
                        disabled={!notificationsEnabled()}
                        onChange={(e) => {
                          setDigestEnabled(e.currentTarget.checked)
                          void saveNotificationSettings()
                        }}
                        style="accent-color:#5ac8fa;cursor:pointer;margin:0"
                      />
                      Отправлять дайджест
                    </label>
                    <div style={`display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;color:#b0b0b0;opacity:${notificationsEnabled() && digestEnabled() ? 1 : 0.5}`}>
                      <select
                        value={digestFrequency()}
                        disabled={!notificationsEnabled() || !digestEnabled()}
                        onChange={(e) => {
                          setDigestFrequency(e.currentTarget.value === "weekly" ? "weekly" : "daily")
                          void saveNotificationSettings()
                        }}
                        style="padding:4px 6px;background:#1e1e1e;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;outline:none"
                      >
                        <option value="daily">ежедневно</option>
                        <option value="weekly">еженедельно (Пн)</option>
                      </select>
                      <input
                        type="time"
                        value={digestTime()}
                        disabled={!notificationsEnabled() || !digestEnabled()}
                        onInput={(e) => setDigestTime(e.currentTarget.value)}
                        onChange={() => void saveNotificationSettings()}
                        style="padding:4px 6px;background:#1e1e1e;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;outline:none"
                      />
                      <span style="font-size:11px;color:#8e8e93">
                        {digestLastSentAt()
                          ? `последняя отправка: ${new Date(digestLastSentAt()!).toLocaleString()}`
                          : "ещё не отправлялся"}
                      </span>
                    </div>
                    <div style="font-size:11px;color:#8e8e93">
                      Запуски, success rate, стоимость и топ ошибок за сутки/неделю.
                    </div>
                  </div>

                  <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
                    <button
                      onClick={() => void handleTestNotification()}
                      disabled={testNotificationBusy() || !webhookEnabled()}
                      style={`padding:6px 12px;background:#007acc;color:white;border:none;border-radius:6px;cursor:${testNotificationBusy() || !webhookEnabled() ? "not-allowed" : "pointer"};font-size:12px;font-weight:500;opacity:${testNotificationBusy() || !webhookEnabled() ? 0.6 : 1}`}
                    >
                      {testNotificationBusy() ? "Отправка..." : "🧪 Тестовое уведомление"}
                    </button>
                    <button
                      onClick={() => void handleSendDigest()}
                      disabled={digestBusy() || !webhookEnabled()}
                      style={`padding:6px 12px;background:#2d7d46;color:white;border:none;border-radius:6px;cursor:${digestBusy() || !webhookEnabled() ? "not-allowed" : "pointer"};font-size:12px;font-weight:500;opacity:${digestBusy() || !webhookEnabled() ? 0.6 : 1}`}
                    >
                      {digestBusy() ? "Отправка..." : "📊 Отправить дайджест сейчас"}
                    </button>
                    <span style="font-size:11px;color:#8e8e93">
                      ntfy.sh не используется — только webhook.
                    </span>
                  </div>
                </div>
              )}
            </div>

            {/* 🧹 История и ретеншн (Спринт 18) */}
            <div style="width:100%;max-width:700px;box-sizing:border-box;margin-top:8px;background:#1e1e1e;border:1px solid #333;border-radius:10px;overflow:hidden">
              <button
                onClick={() => setHistoryCollapsed(!historyCollapsed())}
                style="display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;box-sizing:border-box;padding:10px 14px;background:transparent;border:none;color:#e0e0e0;font-size:12px;font-weight:600;cursor:pointer;text-align:left"
              >
                <span>🧹 История и ретеншн</span>
                <span style="display:flex;align-items:center;gap:8px;font-size:11px;font-weight:400;color:#8e8e93">
                  {historyRetentionDays() > 0 ? `старше ${historyRetentionDays()} дн.` : "без срока"} · {historyMaxRecords() > 0 ? `до ${historyMaxRecords()} записей` : "без лимита"}
                  <span>{historyCollapsed() ? "▾" : "▴"}</span>
                </span>
              </button>

              {!historyCollapsed() && (
                <div style="padding:0 14px 14px;display:flex;flex-direction:column;gap:10px">
                  <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
                    <label style="font-size:12px;color:#e0e0e0;white-space:nowrap">Удалять записи старше, дней</label>
                    <input
                      type="number"
                      min="0"
                      value={historyRetentionDays()}
                      onChange={(e) => {
                        setHistoryRetentionDays(Math.max(0, Math.floor(Number(e.currentTarget.value) || 0)))
                        void saveHistorySettings()
                      }}
                      style="width:70px;padding:4px 6px;background:#1e1e1e;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;outline:none"
                    />
                    <span style="font-size:11px;color:#8e8e93">0 = не удалять по возрасту</span>
                  </div>

                  <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
                    <label style="font-size:12px;color:#e0e0e0;white-space:nowrap">Хранить не более записей</label>
                    <input
                      type="number"
                      min="0"
                      value={historyMaxRecords()}
                      onChange={(e) => {
                        setHistoryMaxRecords(Math.max(0, Math.floor(Number(e.currentTarget.value) || 0)))
                        void saveHistorySettings()
                      }}
                      style="width:80px;padding:4px 6px;background:#1e1e1e;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;outline:none"
                    />
                    <span style="font-size:11px;color:#8e8e93">0 = без ограничения</span>
                  </div>

                  <div style="font-size:11px;color:#8e8e93">
                    Последняя очистка:{" "}
                    {historyLastCleanupAt()
                      ? `${new Date(historyLastCleanupAt()!).toLocaleString()} · удалено ${historyLastCleanupDeleted()}`
                      : "ещё не выполнялась"}
                  </div>

                  <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
                    <button
                      onClick={() => void handleHistoryCleanup()}
                      disabled={historyCleanupBusy()}
                      style={`padding:6px 12px;background:#007acc;color:white;border:none;border-radius:6px;cursor:${historyCleanupBusy() ? "not-allowed" : "pointer"};font-size:12px;font-weight:500;opacity:${historyCleanupBusy() ? 0.6 : 1}`}
                    >
                      {historyCleanupBusy() ? "Очистка..." : "🧹 Очистить сейчас"}
                    </button>
                    <span style="font-size:11px;color:#8e8e93">
                      Удаляются только завершённые записи; незавершённые запуски не трогаются.
                    </span>
                  </div>
                </div>
              )}
            </div>

            {/* 📦 Multi-repo workspaces */}
            <div style="width:100%;max-width:700px;box-sizing:border-box;background:#1e1e1e;border:1px solid #333;border-radius:10px;overflow:hidden">
              <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 14px">
                <button
                  onClick={() => setWorkspacesCollapsed(!workspacesCollapsed())}
                  style="display:flex;align-items:center;gap:8px;background:transparent;border:none;color:#e0e0e0;font-size:12px;font-weight:600;cursor:pointer;text-align:left;padding:0"
                >
                  <span>📦 Workspaces</span>
                  <span style="font-size:11px;font-weight:400;color:#8e8e93">{workspaces().length}</span>
                  <span style="font-size:11px;color:#8e8e93">{workspacesCollapsed() ? "▾" : "▴"}</span>
                </button>
                <button
                  onClick={() => void handleAddWorkspace()}
                  disabled={workspaceBusy()}
                  title="Добавить workspace (git-репозиторий)"
                  style={`padding:5px 10px;border-radius:6px;border:1px solid #333;background:#252526;color:${workspaceBusy() ? "#666" : "#5ac8fa"};font-size:11px;font-weight:600;cursor:${workspaceBusy() ? "not-allowed" : "pointer"}`}
                >
                  ＋ Добавить
                </button>
              </div>
              {!workspacesCollapsed() && (
                <div style="display:flex;flex-direction:column;gap:6px;padding:0 14px 12px">
                  {workspaces().length === 0 ? (
                    <div style="font-size:12px;color:#8e8e93;padding:4px 0">
                      Workspace не добавлен. Задача без workspace использует рабочую директорию проекта.
                    </div>
                  ) : (
                    workspaces().map((workspace) => (
                      <div style="display:flex;align-items:center;gap:10px;padding:8px 10px;background:#252526;border:1px solid #333;border-radius:8px;min-width:0">
                        <span style={`width:9px;height:9px;border-radius:50%;background:${workspace.color || "#5ac8fa"};flex-shrink:0`}></span>
                        <div style="display:flex;flex-direction:column;gap:2px;flex:1;min-width:0">
                          <span style="font-size:12px;font-weight:700;color:#ffffff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">📦 {workspace.name}</span>
                          <span style="font-size:10px;color:#8e8e93;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title={workspace.path}>{workspace.path}</span>
                          <span style="font-size:10px;color:#a0a0a6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
                            git: {workspace.gitBranch || "—"} · {workspace.gitRemote || "remote не задан"}
                          </span>
                        </div>
                        <div style="display:flex;gap:4px;flex-shrink:0">
                          <button
                            onClick={() => void handleEditWorkspace(workspace)}
                            disabled={workspaceBusy()}
                            title="Редактировать workspace"
                            style="background:transparent;border:none;color:#a0a0a6;cursor:pointer;font-size:14px;padding:2px"
                          >✏️</button>
                          <button
                            onClick={() => void handleDeleteWorkspace(workspace)}
                            disabled={workspaceBusy()}
                            title="Удалить workspace (задачи сохраняются)"
                            style="background:transparent;border:none;color:#ff3b30;cursor:pointer;font-size:14px;padding:2px"
                          >🗑</button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>

            {/* Форма создания/редактирования задачи (сворачиваемая) */}
            {formCollapsed() ? (
              <button
                onClick={() => setFormCollapsed(false)}
                title="Развернуть форму создания задачи"
                style="display:flex;align-items:center;justify-content:center;gap:8px;width:100%;max-width:700px;box-sizing:border-box;padding:12px 16px;background:#1e1e1e;border:1px dashed #3a3a3a;border-radius:10px;color:#e0e0e0;font-size:13px;font-weight:600;cursor:pointer;transition:border-color 0.18s ease, background 0.18s ease"
                onMouseEnter={(e) => { const b = e.currentTarget; b.style.borderColor = "#5ac8fa"; b.style.background = "#232326" }}
                onMouseLeave={(e) => { const b = e.currentTarget; b.style.borderColor = "#3a3a3a"; b.style.background = "#1e1e1e" }}
              >
                ➕ Создать задачу
              </button>
            ) : (
            <div style="display:block;width:100%;max-width:700px;box-sizing:border-box;background:#1e1e1e;padding:20px;border-radius:10px;box-shadow:0 4px 12px rgba(0,0,0,0.2)">
              <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:16px">
                <h3 style="margin:0;font-size:14px;font-weight:600;color:#ffffff">
                  {isEditing ? "Редактирование задачи" : "Новая задача"}
                </h3>
                <div style="display:flex;align-items:center;gap:8px">
                  <button
                    onClick={handleSaveAsTemplate}
                    title="Сохранить текущие настройки формы как шаблон"
                    style="background:transparent;border:1px solid #333;border-radius:6px;padding:4px 10px;color:#a0a0a6;font-size:11px;cursor:pointer;white-space:nowrap;transition:color 0.18s ease, border-color 0.18s ease"
                    onMouseEnter={(e) => { const b = e.currentTarget; b.style.color = "#5ac8fa"; b.style.borderColor = "#5ac8fa" }}
                    onMouseLeave={(e) => { const b = e.currentTarget; b.style.color = "#a0a0a6"; b.style.borderColor = "#333" }}
                  >
                    💾 Сохранить как шаблон
                  </button>
                  <button
                    onClick={() => setFormCollapsed(true)}
                    title="Свернуть форму"
                    style="background:transparent;border:1px solid #333;border-radius:6px;padding:4px 10px;color:#a0a0a6;font-size:11px;cursor:pointer;white-space:nowrap;transition:color 0.18s ease, border-color 0.18s ease"
                    onMouseEnter={(e) => { const b = e.currentTarget; b.style.color = "#5ac8fa"; b.style.borderColor = "#5ac8fa" }}
                    onMouseLeave={(e) => { const b = e.currentTarget; b.style.color = "#a0a0a6"; b.style.borderColor = "#333" }}
                  >
                    Скрыть форму ▴
                  </button>
                </div>
              </div>

              {/* Matrix (fan-out, Спринт 15): вместо одного workspace — список. */}
              <div style="display:block;width:100%;margin-bottom:12px;padding:10px 12px;background:#1a1a1a;border:1px solid #333;border-radius:8px">
                <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;font-weight:600;color:#fff">
                  <input
                    type="checkbox"
                    checked={matrixMode()}
                    onChange={(e) => {
                      const on = e.currentTarget.checked
                      setMatrixMode(on)
                      if (on) {
                        setWorkspaceId("")
                        if (matrixWorkspaceIds().length === 0) {
                          setMatrixWorkspaceIds(workspaces().map((w) => w.id))
                        }
                      }
                    }}
                    style="accent-color:#ff9f0a"
                  />
                  📦 Matrix (Fan-Out)
                </label>
                <div style="font-size:11px;color:#8e8e93;margin-top:4px;line-height:1.45">
                  Задача-шаблон раскладывается на клоны по workspace. Родитель сам не выполняется — он запускает клоны и агрегирует результат.
                </div>

                {matrixMode() && (
                  <div style="margin-top:10px;display:flex;flex-direction:column;gap:10px">
                    <div>
                      <div style="font-size:12px;color:#b0b0b0;font-weight:500;margin-bottom:6px">
                        Workspaces (для матрицы) — выбрано {matrixWorkspaceIds().length}
                      </div>
                      {workspaces().length === 0 ? (
                        <div style="font-size:11px;color:#f5a623">Сначала добавьте хотя бы один workspace.</div>
                      ) : (
                        <div style="display:flex;flex-direction:column;gap:4px;max-height:170px;overflow:auto;padding:6px 8px;background:#141414;border:1px solid #333;border-radius:6px">
                          {workspaces().map((workspace) => (
                            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:12px;color:#e0e0e0">
                              <input
                                type="checkbox"
                                checked={matrixWorkspaceIds().includes(workspace.id)}
                                onChange={(e) => toggleMatrixWorkspace(workspace.id, e.currentTarget.checked)}
                                style="accent-color:#ff9f0a"
                              />
                              <span style={`color:${workspace.color || "#5ac8fa"}`}>📦 {workspace.name}</span>
                              <span style="font-size:10px;color:#8e8e93;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{workspace.path}</span>
                            </label>
                          ))}
                        </div>
                      )}
                    </div>

                    <div style="display:flex;gap:8px;flex-wrap:wrap">
                      <label style="flex:1;min-width:150px;font-size:11px;color:#b0b0b0">
                        Стратегия
                        <select
                          value={matrixStrategy()}
                          onChange={(e) => setMatrixStrategy(e.currentTarget.value === "sequential" ? "sequential" : "parallel")}
                          style="display:block;width:100%;box-sizing:border-box;margin-top:4px;padding:6px;background:#1e1e1e;border:1px solid #333;border-radius:6px;color:#fff;font-size:12px;outline:none"
                        >
                          <option value="parallel">parallel — все сразу</option>
                          <option value="sequential">sequential — по одному</option>
                        </select>
                      </label>
                      <label style="flex:1;min-width:150px;font-size:11px;color:#b0b0b0">
                        При ошибке
                        <select
                          value={matrixFailureMode()}
                          onChange={(e) => setMatrixFailureMode(e.currentTarget.value === "stop" ? "stop" : "continue")}
                          style="display:block;width:100%;box-sizing:border-box;margin-top:4px;padding:6px;background:#1e1e1e;border:1px solid #333;border-radius:6px;color:#fff;font-size:12px;outline:none"
                        >
                          <option value="continue">continue — продолжать</option>
                          <option value="stop">stop — остановить</option>
                        </select>
                      </label>
                      <label style="flex:1;min-width:150px;font-size:11px;color:#b0b0b0">
                        Агрегация
                        <select
                          value={matrixAggregation()}
                          onChange={(e) => setMatrixAggregation(e.currentTarget.value === "per-task" ? "per-task" : "summary")}
                          style="display:block;width:100%;box-sizing:border-box;margin-top:4px;padding:6px;background:#1e1e1e;border:1px solid #333;border-radius:6px;color:#fff;font-size:12px;outline:none"
                        >
                          <option value="summary">summary — сводка</option>
                          <option value="per-task">per-task — по задачам</option>
                        </select>
                      </label>
                    </div>

                    <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:12px;color:#e0e0e0">
                      <input
                        type="checkbox"
                        checked={matrixAggregator()}
                        onChange={(e) => setMatrixAggregator(e.currentTarget.checked)}
                        style="accent-color:#ff9f0a"
                      />
                      Создать aggregator-задачу matrix-complete (запустится после всех клонов)
                    </label>

                    <label style="font-size:11px;color:#b0b0b0;max-width:240px">
                      Одновременно клонов (concurrency)
                      <input
                        type="number"
                        min="1"
                        step="1"
                        value={matrixConcurrency()}
                        onInput={(e) => setMatrixConcurrency(e.currentTarget.value)}
                        placeholder={
                          matrixStrategy() === "sequential" ? "1 (sequential)" : "без лимита"
                        }
                        style="display:block;width:100%;box-sizing:border-box;margin-top:4px;padding:6px;background:#1e1e1e;border:1px solid #333;border-radius:6px;color:#fff;font-size:12px;outline:none"
                      />
                    </label>

                    {matrixWorkspaceIds().length > 0 && (
                      <details style="padding:8px 10px;background:#141414;border:1px solid #333;border-radius:6px">
                        <summary style="cursor:pointer;font-size:12px;color:#b0b0b0;font-weight:500">
                          ⚙ Настройки по workspace — переопределено {matrixOverrideCount()}
                        </summary>
                        <div style="margin-top:8px;display:flex;flex-direction:column;gap:8px;max-height:340px;overflow:auto">
                          {matrixWorkspaceIds().map((wsId) => {
                            const workspace = workspaces().find((w) => w.id === wsId)
                            if (!workspace) return null
                            const override = matrixOverrides()[wsId] ?? {}
                            const inputStyle =
                              "padding:6px;background:#1e1e1e;border:1px solid #333;border-radius:6px;color:#fff;font-size:12px;outline:none;box-sizing:border-box"
                            return (
                              <div style="padding:8px;background:#101010;border:1px solid #2a2a2a;border-radius:6px">
                                <div style={`font-size:12px;font-weight:600;margin-bottom:6px;color:${workspace.color || "#5ac8fa"}`}>
                                  📦 {workspace.name}
                                  <span style="margin-left:6px;font-size:10px;color:#8e8e93">{matrixClonePreviewName(name(), workspace.name)}</span>
                                </div>
                                <div style="display:flex;flex-direction:column;gap:6px">
                                  <textarea
                                    rows={2}
                                    placeholder="Промпт (по умолчанию — общий промпт формы)"
                                    value={override.prompt ?? ""}
                                    onInput={(e) => updateMatrixOverride(wsId, "prompt", e.currentTarget.value)}
                                    style={`${inputStyle};width:100%;resize:vertical;font-family:inherit`}
                                  />
                                  <div style="display:flex;gap:6px;flex-wrap:wrap">
                                    <input
                                      placeholder="Модель (override)"
                                      value={override.model ?? ""}
                                      onInput={(e) => updateMatrixOverride(wsId, "model", e.currentTarget.value)}
                                      style={`${inputStyle};flex:1;min-width:150px`}
                                    />
                                    <input
                                      placeholder="Quality Gate (override)"
                                      value={override.qualityGate ?? ""}
                                      onInput={(e) => updateMatrixOverride(wsId, "qualityGate", e.currentTarget.value)}
                                      style={`${inputStyle};flex:1;min-width:150px`}
                                    />
                                  </div>
                                  <div style="display:flex;gap:6px;flex-wrap:wrap">
                                    <input
                                      placeholder="beforeScript (override)"
                                      value={override.beforeScript ?? ""}
                                      onInput={(e) => updateMatrixOverride(wsId, "beforeScript", e.currentTarget.value)}
                                      style={`${inputStyle};flex:1;min-width:150px`}
                                    />
                                    <input
                                      placeholder="afterScript (override)"
                                      value={override.afterScript ?? ""}
                                      onInput={(e) => updateMatrixOverride(wsId, "afterScript", e.currentTarget.value)}
                                      style={`${inputStyle};flex:1;min-width:150px`}
                                    />
                                  </div>
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      </details>
                    )}

                    <div style="padding:8px 10px;background:#141414;border:1px solid #333;border-radius:6px;font-size:11px;line-height:1.55;color:#a0a0a6">
                      {matrixPreview().length > 0 ? (
                        <>
                          <div style="color:#ff9f0a;font-weight:600">Будет создано {matrixPreview().length} клон(а/ов):</div>
                          <div style="color:#e0e0e0;word-break:break-all">{matrixPreview().join(", ")}</div>
                        </>
                      ) : (
                        <span style="color:#f5a623">Выберите хотя бы один workspace — превью клонов появится здесь.</span>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {!matrixMode() && (
              <div style="display:block;width:100%;margin-bottom:12px">
                <label style="display:block;margin-bottom:8px;font-size:12px;color:#b0b0b0;font-weight:500">Workspace (multi-repo)</label>
                <select
                  value={workspaceId()}
                  onChange={(e) => {
                    setWorkspaceId(e.currentTarget.value)
                    if (e.currentTarget.value) setWorkingDirectory("")
                  }}
                  style="display:block;width:100%;box-sizing:border-box;padding:8px;background:#1e1e1e;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;outline:none"
                >
                  <option value="">Без workspace — рабочая директория</option>
                  {workspaces().map((workspace) => (
                    <option key={workspace.id} value={workspace.id}>📦 {workspace.name}</option>
                  ))}
                </select>
                {selectedWorkspace() && (
                  <div style="margin-top:8px;padding:8px 10px;background:#141414;border:1px solid #333;border-radius:6px;font-size:11px;line-height:1.55;color:#a0a0a6">
                    <div>cwd = <span style="color:#e0e0e0">{selectedWorkspace()!.path}</span></div>
                    <div>git branch = <span style="color:#5ac8fa">{selectedWorkspace()!.gitBranch || "—"}</span></div>
                    <div>git remote = <span style="color:#e0e0e0">{selectedWorkspace()!.gitRemote || "—"}</span></div>
                  </div>
                )}
              </div>
              )}

              <div style="display:block;width:100%;margin-bottom:12px">
                <label style="display:block;margin-bottom:8px;font-size:12px;color:#b0b0b0;font-weight:500">Имя задачи</label>
                <input
                  type="text"
                  value={name() || ""}
                  onInput={(e) => setName(e.currentTarget.value)}
                  placeholder="например, Gui-Test"
                  style="display:block;width:100%;box-sizing:border-box;padding:8px;background:#1e1e1e;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;outline:none"
                />
              </div>

              {!workspaceId() && !matrixMode() && (
              <div style="display:block;width:100%;margin-bottom:12px">
                <label style="display:block;margin-bottom:8px;font-size:12px;color:#b0b0b0;font-weight:500">Рабочая директория</label>
                <input
                  type="text"
                  value={workingDirectory() || ""}
                  onInput={(e) => setWorkingDirectory(e.currentTarget.value)}
                  placeholder="по умолчанию — папка проекта"
                  style="display:block;width:100%;box-sizing:border-box;padding:8px;background:#1e1e1e;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;outline:none"
                />
                <div style="font-size:11px;color:#8e8e93;margin-top:6px">В этой папке задача запустит opencode run — здесь подхватятся MCP-серверы из opencode.json.</div>
              </div>
              )}

              <div style="display:block;width:100%;margin-bottom:12px">
                <label style="display:block;margin-bottom:8px;font-size:12px;color:#b0b0b0;font-weight:500">Тип триггера</label>
                <div style="display:flex;gap:8px">
                  <label style="display:flex;align-items:center;gap:6px;cursor:pointer;flex:1">
                    <input
                      type="radio"
                      name="triggerType"
                      checked={triggerType() === "cron"}
                      onChange={() => setTriggerType("cron")}
                      style="accent-color:#007acc"
                    />
                    По расписанию (Cron)
                  </label>
                  <label style="display:flex;align-items:center;gap:6px;cursor:pointer;flex:1">
                    <input
                      type="radio"
                      name="triggerType"
                      checked={triggerType() === "file"}
                      onChange={() => setTriggerType("file")}
                      style="accent-color:#007acc"
                    />
                    При изменении файла
                  </label>
                  <label style="display:flex;align-items:center;gap:6px;cursor:pointer;flex:1">
                    <input
                      type="radio"
                      name="triggerType"
                      checked={triggerType() === "mcp-event"}
                      onChange={() => setTriggerType("mcp-event")}
                      style="accent-color:#007acc"
                    />
                    MCP Event
                  </label>
                </div>
              </div>

              {triggerType() === "file" && (
                <div style="display:block;width:100%;margin-bottom:12px">
                  <label style="display:block;margin-bottom:8px;font-size:12px;color:#b0b0b0;font-weight:500">Путь к файлу для отслеживания</label>
                  <input
                    type="text"
                    value={watchPath() || ""}
                    onInput={(e) => setWatchPath(e.currentTarget.value)}
                    placeholder="например, C:\project\src\main.ts"
                    style="display:block;width:100%;box-sizing:border-box;padding:8px;background:#1e1e1e;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;outline:none"
                  />
                </div>
              )}

              {triggerType() === "mcp-event" && (
                <>
                  <div style="display:block;width:100%;margin-bottom:12px">
                    <label style="display:block;margin-bottom:8px;font-size:12px;color:#b0b0b0;font-weight:500">MCP-сервер / источник</label>
                    <input
                      type="text"
                      value={mcpServer() || ""}
                      onInput={(e) => setMcpServer(e.currentTarget.value)}
                      placeholder="например, github"
                      style="display:block;width:100%;box-sizing:border-box;padding:8px;background:#1e1e1e;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;outline:none"
                    />
                  </div>
                  <div style="display:block;width:100%;margin-bottom:12px">
                    <label style="display:block;margin-bottom:8px;font-size:12px;color:#b0b0b0;font-weight:500">Имя события</label>
                    <input
                      type="text"
                      value={mcpEventName() || ""}
                      onInput={(e) => setMcpEventName(e.currentTarget.value)}
                      placeholder="например, github.pr.opened"
                      style="display:block;width:100%;box-sizing:border-box;padding:8px;background:#1e1e1e;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;outline:none"
                    />
                  </div>
                  <div style="display:block;width:100%;margin-bottom:12px">
                    <label style="display:block;margin-bottom:8px;font-size:12px;color:#b0b0b0;font-weight:500">Фильтр (опционально)</label>
                    <input
                      type="text"
                      value={mcpFilter() || ""}
                      onInput={(e) => setMcpFilter(e.currentTarget.value)}
                      placeholder='например, repo="my-project" или regex'
                      style="display:block;width:100%;box-sizing:border-box;padding:8px;background:#1e1e1e;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;outline:none"
                    />
                    <div style="font-size:11px;color:#8e8e93;margin-top:6px">key=value сравнивается с полем payload, иначе фильтр считается regex/подстрокой. События приходят через RPC emit_event.</div>
                  </div>
                </>
              )}

              <div
                style={{
                  display: triggerType() !== "cron" ? "none" : "block",
                  width: "100%",
                  marginBottom: "12px",
                }}
              >
                <label style="display:block;margin-bottom:8px;font-size:12px;color:#b0b0b0;font-weight:500">Расписание</label>
                <select
                  value={cronPreset()}
                  onChange={(e) => {
                    const val = e.currentTarget.value
                    setCronPreset(val)
                    if (val !== "__custom__") setSchedule(val)
                  }}
                  style="display:block;width:100%;box-sizing:border-box;padding:8px;background:#1e1e1e;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;outline:none"
                >
                  {CRON_PRESETS.map((p) => (
                    <option key={p.value} value={p.value}>{p.label}</option>
                  ))}
                </select>
                {showCustomCron && (
                  <div style="display:block;width:100%;margin-top:8px">
                    <label style="display:block;margin-bottom:8px;font-size:12px;color:#b0b0b0;font-weight:500">Cron-выражение</label>
                    <input
                      type="text"
                      value={schedule() || ""}
                      onInput={(e) => setSchedule(e.currentTarget.value)}
                      placeholder="* * * * *"
                      style="display:block;width:100%;box-sizing:border-box;padding:8px;background:#1e1e1e;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;outline:none"
                    />
                  </div>
                )}
                {cronError() && (
                  <div style="display:block;max-height:80px;overflow-y:auto;margin-top:8px;padding:8px;background:#2a1113;border:1px solid #5a1d21;border-radius:6px;font-size:11px;line-height:1.4;color:#ff6b6b;white-space:pre-wrap;word-break:break-word">{cronError()}</div>
                )}
                <div style="display:block;width:100%;margin-top:12px">
                  <label style="display:block;margin-bottom:8px;font-size:12px;color:#b0b0b0;font-weight:500">Часовой пояс (IANA)</label>
                  <input
                    type="text"
                    list="iana-timezones"
                    value={timezone() || ""}
                    onInput={(e) => setTimezone(e.currentTarget.value)}
                    placeholder="Пусто — системный пояс"
                    style="display:block;width:100%;box-sizing:border-box;padding:8px;background:#1e1e1e;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;outline:none"
                  />
                  <datalist id="iana-timezones">
                    <option value="Europe/Moscow" />
                    <option value="Europe/London" />
                    <option value="Europe/Berlin" />
                    <option value="America/New_York" />
                    <option value="America/Los_Angeles" />
                    <option value="Asia/Almaty" />
                    <option value="Asia/Tokyo" />
                    <option value="UTC" />
                  </datalist>
                  <div style="display:block;margin-top:6px;font-size:11px;color:#808080">
                    Другая зона — задача будится каждую минуту, cron проверяется с учётом пояса.
                  </div>
                </div>
                <div style="display:block;width:100%;margin-top:12px">
                  <label style="display:block;margin-bottom:8px;font-size:12px;color:#b0b0b0;font-weight:500">Окно запуска (необязательно)</label>
                  <div style="display:flex;gap:8px;align-items:center">
                    <input
                      type="time"
                      value={notBefore() || ""}
                      onInput={(e) => setNotBefore(e.currentTarget.value)}
                      title="Начало окна"
                      style="display:block;flex:1;box-sizing:border-box;padding:8px;background:#1e1e1e;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;outline:none"
                    />
                    <span style="color:#808080;font-size:12px">—</span>
                    <input
                      type="time"
                      value={notAfter() || ""}
                      onInput={(e) => setNotAfter(e.currentTarget.value)}
                      title="Конец окна (может быть меньше начала)"
                      style="display:block;flex:1;box-sizing:border-box;padding:8px;background:#1e1e1e;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;outline:none"
                    />
                  </div>
                  <div style="display:block;margin-top:6px;font-size:11px;color:#808080">
                    Вне окна запуск переносится на его открытие, а не пропускается. Например 22:00 — 06:00.
                  </div>
                </div>
              </div>

              <div style="display:block;width:100%;margin-bottom:12px">
                <label style="display:block;margin-bottom:8px;font-size:12px;color:#b0b0b0;font-weight:500">Промпт</label>
                <textarea
                  value={prompt() || ""}
                  onInput={(e) => setPrompt(e.currentTarget.value)}
                  placeholder="Напиши краткий отчет о состоянии рынка"
                  rows={2}
                  style="display:block;width:100%;box-sizing:border-box;padding:8px;background:#1e1e1e;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;outline:none;resize:vertical"
                />
              </div>

              <div style="display:block;width:100%;margin-bottom:12px">
                <label style="display:block;margin-bottom:8px;font-size:12px;color:#b0b0b0;font-weight:500">Шаблон промпта</label>
                <select
                  value={template()}
                  onChange={(e) => selectTemplate(e.currentTarget.value)}
                  style="display:block;width:100%;box-sizing:border-box;padding:8px;background:#1e1e1e;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;outline:none"
                >
                  {TEMPLATES.map((t) => (
                    <option key={t.value} value={t.value}>{t.label}</option>
                  ))}
                  {customTemplates().map((t) => (
                    <option key={t.id} value={`custom:${t.id}`}>{t.name}</option>
                  ))}
                </select>
                {template().startsWith("custom:") && (
                  <div style="display:flex;align-items:center;gap:6px;margin-top:8px">
                    <span style="font-size:10px;color:#8e8e93">Кастомный шаблон:</span>
                    {customTemplates().map((t) => {
                      if (`custom:${t.id}` !== template()) return null;
                      return (
                        <span key={t.id} style="font-size:11px;color:#ff3b30;font-weight:500;cursor:default">
                          {t.name}
                        </span>
                      );
                    })}
                    <button
                      onClick={() => {
                        const t = customTemplates().find((x) => `custom:${x.id}` === template());
                        if (t) handleDeleteTemplate(t);
                      }}
                      title="Удалить шаблон"
                      style="background:transparent;border:none;color:#ff3b30;cursor:pointer;font-size:14px;line-height:1;padding:0"
                      onMouseEnter={(e) => { e.currentTarget.style.color = "#c92a2a"; }}
                      onMouseLeave={(e) => { e.currentTarget.style.color = "#ff3b30"; }}
                    >
                      🗑
                    </button>
                  </div>
                )}
              </div>

              <div style="display:block;width:100%;margin-bottom:12px">
                <label style="display:block;margin-bottom:8px;font-size:12px;color:#b0b0b0;font-weight:500">Модель LLM</label>
                <input
                  type="text"
                  list="scheduler-model-presets"
                  value={model() || ""}
                  onInput={(e) => setModel(e.currentTarget.value)}
                  placeholder="по умолчанию (как в OpenCode)"
                  style="display:block;width:100%;box-sizing:border-box;padding:8px;background:#1e1e1e;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;outline:none"
                />
                <datalist id="scheduler-model-presets">
                  <option value="anthropic/claude-3-5-sonnet" />
                  <option value="openai/gpt-4o" />
                  <option value="deepseek/deepseek-coder" />
                  <option value="google/gemini-2.5-pro" />
                  <option value="openai/gpt-4o-mini" />
                </datalist>
                <div style="font-size:11px;color:#8e8e93;margin-top:6px">Пусто — модель OpenCode по умолчанию. Иначе будет передан флаг --model.</div>
              </div>

              <div style="display:block;width:100%;margin-bottom:12px">
                <label style="display:block;margin-bottom:8px;font-size:12px;color:#b0b0b0;font-weight:500">Приоритет</label>
                <select
                  value={String(priority())}
                  onChange={(e) => setPriority(Number(e.currentTarget.value) || DEFAULT_PRIORITY)}
                  style="display:block;width:100%;box-sizing:border-box;padding:8px;background:#1e1e1e;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;outline:none"
                >
                  {PRIORITY_OPTIONS.map((p) => (
                    <option key={p.value} value={String(p.value)}>{p.label}</option>
                  ))}
                  {!PRIORITY_OPTIONS.some((p) => p.value === priority()) && (
                    <option value={String(priority())}>Другой ({priority()})</option>
                  )}
                </select>
                <div style="font-size:11px;color:#8e8e93;margin-top:6px">Если готовы несколько задач сразу, первой запускается задача с более высоким приоритетом.</div>
              </div>

              <div style="display:block;width:100%;margin-bottom:12px">
                <label style="display:block;margin-bottom:8px;font-size:12px;color:#b0b0b0;font-weight:500">Кол-во повторов при ошибке</label>
                <input
                  type="number"
                  min="0"
                  value={retryCount()}
                  onInput={(e) => setRetryCount(Number(e.currentTarget.value) || 0)}
                  placeholder="0"
                  style="display:block;width:100%;box-sizing:border-box;padding:8px;background:#1e1e1e;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;outline:none"
                />
              </div>

              <div style="display:block;width:100%;margin-bottom:12px">
                <label style="display:block;margin-bottom:8px;font-size:12px;color:#b0b0b0;font-weight:500">Задержка перед повтором (сек)</label>
                <input
                  type="number"
                  min="1"
                  value={retryDelay()}
                  onInput={(e) => setRetryDelay(Number(e.currentTarget.value) || 60)}
                  placeholder="60"
                  style="display:block;width:100%;box-sizing:border-box;padding:8px;background:#1e1e1e;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;outline:none"
                />
              </div>

              <div style="display:block;width:100%;margin-bottom:12px">
                <label style="display:block;margin-bottom:8px;font-size:12px;color:#b0b0b0;font-weight:500">Проверочная команда (Quality Gate)</label>
                <input
                  type="text"
                  value={qualityGate() || ""}
                  onInput={(e) => setQualityGate(e.currentTarget.value)}
                  placeholder="например: npm run test"
                  style="display:block;width:100%;box-sizing:border-box;padding:8px;background:#1e1e1e;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;outline:none"
                />
                <div style="font-size:11px;color:#8e8e93;margin-top:6px">Выполняется после успешного ответа ИИ. Ненулевой код = ошибка задачи.</div>
              </div>

              <div style="display:block;width:100%;margin-bottom:12px">
                <label style="display:block;margin-bottom:8px;font-size:12px;color:#b0b0b0;font-weight:500">Команда перед запуском (Pre-flight)</label>
                <input
                  type="text"
                  value={beforeScript() || ""}
                  onInput={(e) => setBeforeScript(e.currentTarget.value)}
                  placeholder="например: git pull"
                  style="display:block;width:100%;box-sizing:border-box;padding:8px;background:#1e1e1e;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;outline:none"
                />
                <div style="font-size:11px;color:#8e8e93;margin-top:6px">Например: git pull или npm install. Выполняется в рабочей директории задачи. Ненулевой код отменяет запуск (Pre-flight script failed).</div>
              </div>

              <div style="display:block;width:100%;margin-bottom:12px">
                <label style="display:block;margin-bottom:8px;font-size:12px;color:#b0b0b0;font-weight:500">Команда после запуска (Post-flight)</label>
                <input
                  type="text"
                  value={afterScript() || ""}
                  onInput={(e) => setAfterScript(e.currentTarget.value)}
                  placeholder="например: git push"
                  style="display:block;width:100%;box-sizing:border-box;padding:8px;background:#1e1e1e;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;outline:none"
                />
                <div style="font-size:11px;color:#8e8e93;margin-top:6px">Например: git push или npm run build. Выполняется в рабочей директории задачи даже при ошибке основной задачи.</div>
              </div>

              <div style="display:block;width:100%;margin-bottom:12px">
                <label style="display:block;margin-bottom:8px;font-size:12px;color:#b0b0b0;font-weight:500">Зависит от задач (успешное завершение)</label>
                <div style="display:flex;flex-wrap:wrap;gap:6px;padding:8px;background:#1e1e1e;border:1px solid #333;border-radius:6px;min-height:38px;box-sizing:border-box">
                  {dependencyCandidates().length === 0 ? (
                    <span style="font-size:12px;color:#8e8e93">Других задач пока нет</span>
                  ) : (
                    dependencyCandidates().map((candidate) => (
                      <label style={`display:flex;align-items:center;gap:6px;padding:6px 10px;border-radius:14px;border:1px solid ${dependsOn().includes(candidate) ? "#5ac8fa" : "#333"};background:${dependsOn().includes(candidate) ? "rgba(90,200,250,0.12)" : "transparent"};color:${dependsOn().includes(candidate) ? "#5ac8fa" : "#cfcfd2"};font-size:12px;cursor:pointer;user-select:none`}>
                        <input
                          type="checkbox"
                          checked={dependsOn().includes(candidate)}
                          onChange={(e) => toggleDependsOn(candidate, e.currentTarget.checked)}
                          style="margin:0"
                        />
                        {candidate}
                      </label>
                    ))
                  )}
                </div>
                <div style="font-size:11px;color:#8e8e93;margin-top:6px">Задача запустится автоматически, когда все отмеченные задачи завершатся успешно.</div>
              </div>

              {/* Role-scoped tools (Спринт 14): metadata-only, denied имеет приоритет */}
              <details style="display:block;width:100%;margin-bottom:12px">
                <summary style="cursor:pointer;font-size:12px;color:#b0b0b0;font-weight:500;margin-bottom:8px;user-select:none">
                  🔒 Ограничения инструментов
                  {(allowedTools().length > 0 || deniedTools().length > 0) && (
                    <span style="color:#5ac8fa;font-size:11px;margin-left:6px">
                      ({allowedTools().length} allowed · {deniedTools().length} denied)
                    </span>
                  )}
                </summary>
                <div style="display:block;width:100%;padding:10px;background:#1e1e1e;border:1px solid #333;border-radius:6px;box-sizing:border-box">
                  <div style="font-size:11px;color:#8e8e93;margin-bottom:8px">
                    ⚠ Metadata-only: opencode 2.2.3 не поддерживает allow/deny флаги — ограничения фиксируются в логе и истории.
                    При конфликте приоритет у <b>denied</b>. Пустой allowedTools запрещён.
                  </div>
                  <div style="font-size:11px;color:#b0b0b0;margin-bottom:4px">Белый список (allowedTools)</div>
                  <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px">
                    {POPULAR_TOOLS.map((tool) => (
                      <label style={`display:flex;align-items:center;gap:5px;padding:4px 9px;border-radius:12px;border:1px solid ${allowedTools().includes(tool) ? "#34c759" : "#333"};background:${allowedTools().includes(tool) ? "rgba(52,199,89,0.12)" : "transparent"};color:${allowedTools().includes(tool) ? "#34c759" : "#cfcfd2"};font-size:11px;cursor:pointer;user-select:none`}>
                        <input
                          type="checkbox"
                          checked={allowedTools().includes(tool)}
                          onChange={() => toggleTool("allowed", tool)}
                          style="margin:0"
                        />
                        {tool}
                      </label>
                    ))}
                  </div>
                  <div style="font-size:11px;color:#b0b0b0;margin-bottom:4px">Чёрный список (deniedTools)</div>
                  <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px">
                    {POPULAR_TOOLS.map((tool) => (
                      <label style={`display:flex;align-items:center;gap:5px;padding:4px 9px;border-radius:12px;border:1px solid ${deniedTools().includes(tool) ? "#ff3b30" : "#333"};background:${deniedTools().includes(tool) ? "rgba(255,59,48,0.12)" : "transparent"};color:${deniedTools().includes(tool) ? "#ff3b30" : "#cfcfd2"};font-size:11px;cursor:pointer;user-select:none`}>
                        <input
                          type="checkbox"
                          checked={deniedTools().includes(tool)}
                          onChange={() => toggleTool("denied", tool)}
                          style="margin:0"
                        />
                        {tool}
                      </label>
                    ))}
                  </div>
                  <div style="display:flex;gap:6px">
                    <input
                      type="text"
                      value={customTool()}
                      onInput={(e) => setCustomTool(e.currentTarget.value)}
                      placeholder="свой инструмент, например websearch"
                      style="flex:1;padding:6px 8px;background:#141414;border:1px solid #333;border-radius:6px;color:#fff;font-size:12px;outline:none"
                    />
                    <button onClick={() => addCustomTool("allowed")} style="padding:6px 10px;background:transparent;border:1px solid #34c759;color:#34c759;border-radius:6px;cursor:pointer;font-size:12px">+ allowed</button>
                    <button onClick={() => addCustomTool("denied")} style="padding:6px 10px;background:transparent;border:1px solid #ff3b30;color:#ff3b30;border-radius:6px;cursor:pointer;font-size:12px">+ denied</button>
                  </div>
                  {(allowedTools().length > 0 || deniedTools().length > 0) && (
                    <div style="font-size:11px;color:#cfcfd2;margin-top:8px">
                      {allowedTools().length > 0 && <div>allowed: [{allowedTools().join(", ")}]</div>}
                      {deniedTools().length > 0 && <div>denied: [{deniedTools().join(", ")}]</div>}
                    </div>
                  )}
                </div>
              </details>

              <div style="display:block;width:100%;margin-top:8px">
                <button
                  onClick={() => {
                    setDryRunName("(форма)")
                    const baseTask = {
                      order: 0,
                      trigger: "manual",
                      command: buildFormCommand(),
                      roleScoped:
                        allowedTools().length > 0 || deniedTools().length > 0
                          ? { allowed: allowedTools(), denied: deniedTools() }
                          : null,
                      preFlight: (beforeScript() || "").trim() || null,
                      postFlight: (afterScript() || "").trim() || null,
                      qualityGate: (qualityGate() || "").trim() || null,
                    }
                    const matrixTasks = matrixWorkspaceIds()
                      .map((id) => workspaces().find((w) => w.id === id))
                      .filter((w): w is Workspace => Boolean(w))
                      .map((w, index) => ({
                        ...baseTask,
                        name: matrixClonePreviewName(name(), w.name),
                        order: index,
                        cwd: w.path,
                        matrixParent: name() || "(без имени)",
                      }))
                    setDryRunReport({
                      tasks: matrixMode()
                        ? matrixTasks
                        : [
                            {
                              ...baseTask,
                              name: name() || "(без имени)",
                              cwd:
                                selectedWorkspace()?.path ||
                                (workingDirectory() || "").trim() ||
                                "(папка проекта)",
                            },
                          ],
                      totals: {},
                      warnings: [
                        ...(!name().trim() ? ["Не указано имя — превью локальное (форма не сохранена)."] : []),
                        ...(matrixMode()
                          ? [
                              `Matrix: будет создано ${matrixTasks.length} клон(а/ов) по workspace; родитель сам не выполняется.`,
                            ]
                          : []),
                      ],
                    })
                    setDryRunOpen(true)
                  }}
                  title="Локальное превью команды по текущим полям формы (без RPC и без запуска)"
                  style="display:block;width:100%;padding:8px;margin-top:4px;background:transparent;border:1px solid #333;border-radius:6px;color:#d4e6ff;cursor:pointer;font-size:12px"
                >
                  🧪 Превью
                </button>
                <button
                  onClick={handleCreate}
                  disabled={busy() || !(name() || "").trim() || !(schedule() || "").trim() || !(prompt() || "").trim() || (matrixMode() && matrixWorkspaceIds().length === 0)}
                  style={`display:block;width:100%;padding:10px;margin-top:8px;background:${busy() ? "#666" : "#007acc"};color:white;border-radius:6px;border:none;cursor:${busy() || (!(name() || "").trim() || !(schedule() || "").trim() || !(prompt() || "").trim()) ? "not-allowed" : "pointer"};font-size:13px;font-weight:500;opacity:${(busy() || !(name() || "").trim() || !(schedule() || "").trim() || !(prompt() || "").trim()) ? 0.6 : 1}`}
                >
                  {busy() ? "Создание..." : isEditing ? "Сохранить" : "Создать задачу"}
                </button>
                {isEditing && (
                  <button
                    onClick={() => { setEditingJob(null); setName(""); setSchedule("* * * * *"); setPrompt(""); setModel(""); setPriority(DEFAULT_PRIORITY); setRetryCount(0); setRetryDelay(60); setQualityGate(""); setDependsOn([]); setBeforeScript(""); setAfterScript(""); setTriggerType("cron"); setWatchPath(""); setTimezone(""); setNotBefore(""); setNotAfter(""); setMcpServer(""); setMcpEventName(""); setMcpFilter(""); setWorkingDirectory(""); setWorkspaceId(""); setAllowedTools([]); setDeniedTools([]); resetMatrixForm(); setCronPreset("* * * * *"); setCronError("") }}
                    style="background:transparent;border:1px solid #333;border-radius:6px;padding:8px 16px;color:#ff3b30;cursor:pointer;font-size:13px;width:100%"
                  >
                    Отмена
                  </button>
                )}
              </div>

              {dryRunOpen() && dryRunName() === "(форма)" && (
                <div style="display:block;width:100%;margin-top:8px;padding:10px;background:#1e1e1e;border:1px solid #333;border-radius:6px">
                  <div style="font-size:12px;font-weight:600;color:#ffffff;display:flex;justify-content:space-between;align-items:center">
                    🧪 Превью (локальное, по полям формы)
                    <button onClick={() => closeDryRun()} style="background:none;border:none;color:#8e8e93;cursor:pointer;font-size:14px;padding:0">✕</button>
                  </div>
                  {(() => {
                    const r: any = dryRunReport()
                    if (!r) return null
                    const t = r.tasks?.[0]
                    return (
                      <div style="display:flex;flex-direction:column;gap:4px;font-size:11px;color:#e0e0e0;margin-top:6px">
                        <div style="overflow-wrap:anywhere">$ {t?.command}</div>
                        <div style="color:#8e8e93">cwd: {t?.cwd}</div>
                        {t?.roleScoped && (
                          <div style="color:#8e8e93">
                            🔒 allowed=[{(t.roleScoped.allowed ?? []).join(", ")}] · denied=[{(t.roleScoped.denied ?? []).join(", ")}]
                          </div>
                        )}
                        {t?.preFlight && <div style="color:#8e8e93">⚡ pre: {t.preFlight}</div>}
                        {t?.postFlight && <div style="color:#8e8e93">⚡ post: {t.postFlight}</div>}
                        {t?.qualityGate && <div style="color:#8e8e93">✅ QG: {t.qualityGate}</div>}
                        {Array.isArray(r.warnings) && r.warnings.length > 0 && (
                          <div style="color:#f5a623">⚠ {r.warnings.join(" | ")}</div>
                        )}
                      </div>
                    )
                  })()}
                </div>
              )}
            </div>
            )}

            {/* Список задач */}
            <div style="display:block;width:100%;margin-top:24px">
              <h3 style="margin:0;margin-bottom:8px;font-size:14px;font-weight:600;color:#ffffff">Задачи</h3>
              {workspaceFilter() !== "all" && (
                <div style="font-size:11px;color:#8e8e93;margin-bottom:8px">
                  Фильтр: {workspaceFilter() === "none" ? "без workspace" : `📦 ${workspaces().find((w) => w.id === workspaceFilter())?.name ?? "workspace"}`} · показано {visibleJobs().length} из {jobsArr().length}
                </div>
              )}
              {visibleJobs().length === 0 ?
                <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:40px 16px;color:#a0a0a6;font-size:13px;gap:10px">
                  <span style="font-size:40px;line-height:1">{winterMode() ? "🎄" : "📅"}</span>
                  <span style="max-width:380px;line-height:1.5">
                    {winterMode()
                      ? "Задач пока нет. Самое время украсить ёлку!"
                      : "Нет активных задач. Создайте первую и доверьте рутину ИИ!"}
                  </span>
                </div>
              :
                <div style="display:flex;flex-direction:column;gap:0">
                  {visibleJobs().map(job => <JobCard key={job.name} job={job} />)}
                </div>
              }
            </div>

            {/* Панель логов */}
            {logsTask() && (
              <div style="position:fixed;bottom:16px;left:16px;right:16px;background:#1e1e1e;border:1px solid #333;border-radius:8px;padding:0;max-height:300px;overflow:hidden;display:flex;flex-direction:column;z-index:1000">
                <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid #333;background:#252526;border-radius:8px 8px 0 0">
                  <div style="display:flex;align-items:center;gap:8px">
                    <span style="font-size:13px;font-weight:600;color:#ffffff">Логи</span>
                    <span style="font-size:11px;color:#8e8e93">{logsTask()}</span>
                  </div>
                  <button
                    onClick={() => { setLogsTask(null); setLogs("") }}
                    style="background:transparent;border:none;color:#8e8e93;cursor:pointer;font-size:18px;line-height:1;padding:0;width:24px;height:24px;display:flex;align-items:center;justify-content:center"
                    onMouseEnter={(e) => { (e.target as HTMLButtonElement).style.color = "#ff3b30" }}
                    onMouseLeave={(e) => { (e.target as HTMLButtonElement).style.color = "#8e8e93" }}
                  >
                    ✕
                  </button>
                </div>
                <div style="flex:1;overflow-y:auto;padding:12px;font-family:Menlo, Monaco, 'Courier New', monospace;font-size:11px;line-height:1.5;color:#d4d4d4;background:#1e1e1e;border-radius:0 0 8px 8px">
                  {logs().split("\n").map((line, i) => (
                    <div key={i} style="white-space:pre-wrap;margin-bottom:2px">{line}</div>
                  ))}
                </div>
              </div>
            )}
            </div>
          </ErrorBoundary>
        ),
      })
    } catch (err: any) {
      // Error boundary: если рендеринг падает, выводим сообщение вместо исчезновения панели
      console.error("GUI render error:", err)
      return ctx.add(Panel, {
        id: "scheduler-jobs",
        region: "side",
        list: () => [{ id: "jobs", title: "Планировщик", pinned: true }],
        render: () => (
          <ErrorBoundary fallback={(err: any) => (
            <div style="padding:16px;color:#ff3b30;font-size:13px">
              Ошибка UI: {err.message}
            </div>
          )}>
            <div style="padding:16px;display:flex;flex-direction:column;gap:16px;font-size:13px;font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;color:#e0e0e0;background:#0f0f0f">
            <h2 style="margin:0;font-size:22px;font-weight:800;color:#ffffff">{schedulerTitle()}</h2>
            <div style="margin-top:5px;font-size:11px;font-weight:600;letter-spacing:1.2px;text-transform:uppercase;color:#8e8e93">Local AI CI/CD Orchestrator</div>
            <div style="background:#2a1a1a;border:1px solid #ff3b30;border-radius:8px;padding:16px;color:#ff3b30">
              Произошла ошибка отображения. Попробуйте перезагрузить панель.
            </div>
            </div>
          </ErrorBoundary>
        ),
      })
    }
  },
})
