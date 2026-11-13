import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { PLUGIN_DIR } from "./types.js";

/** Настройки webhook-уведомлений (Discord/Slack/generic). */
export interface WebhookNotificationSettings {
  /** Включён ли канал. */
  enabled: boolean;
  /** URL вебхука. */
  url: string;
  /** Таймаут запроса в мс (1000..120000). */
  timeoutMs: number;
  /** Сколько раз повторить при сетевой ошибке / 5xx / 429 (0..5). */
  retryCount: number;
  /** Базовая задержка backoff в мс; каждая следующая попытка ждёт вдвое дольше. */
  retryDelayMs: number;
}

/** Настраиваемые шаблоны сообщений о завершении задачи. */
export interface NotificationTemplates {
  /** Шаблон успеха. Плейсхолдеры: {task} {status} {duration} {error} {emoji}. */
  success: string;
  /** Шаблон ошибки. {error} разворачивается в «: текст» или пустую строку. */
  error: string;
}

/** Фильтры по задачам: include имеет приоритет, exclude сильнее include. */
export interface NotificationFilters {
  /** Уведомлять только эти задачи (пусто — все). Поддерживает `*`. */
  include: string[];
  /** Никогда не уведомлять эти задачи. Поддерживает `*`. */
  exclude: string[];
}

/** Уведомления о матрицах (Спринт 20). */
export interface MatrixNotificationSettings {
  /** Включены ли уведомления о матрицах. */
  enabled: boolean;
  /** Сообщать о partial (часть клонов упала). */
  onPartial: boolean;
  /** Сообщать, когда упали все клоны. */
  onAllFailed: boolean;
  /** Порог «матрица зависла» в минутах (0 — детектор выключен). */
  stuckAfterMinutes: number;
}

/** Периодичность дайджеста. */
export type DigestFrequency = "daily" | "weekly";

/** Дайджест по истории запусков (Спринт 20). */
export interface DigestSettings {
  /** Включён ли дайджест. */
  enabled: boolean;
  /** Ежедневно или еженедельно (по понедельникам). */
  frequency: DigestFrequency;
  /** Время отправки в формате HH:MM (локальное время сервера). */
  time: string;
  /** ISO-момент последней отправки — дедуп между перезапусками плагина. */
  lastSentAt: string | null;
}

/**
 * Уведомления о завершении задач.
 *
 * ntfy.sh намеренно не поддерживается: остаётся только webhook, который
 * работает с Discord, Slack и любым generic-эндпоинтом.
 */
export interface NotificationSettings {
  /** Главный выключатель уведомлений. */
  enabled: boolean;
  /** true — отправлять только при ошибке (экономит лимиты и не спамит). */
  onlyOnError: boolean;
  /** Webhook-канал. */
  webhook?: WebhookNotificationSettings;
  /** Шаблоны сообщений. */
  templates?: NotificationTemplates;
  /** Фильтры по задачам. */
  filters?: NotificationFilters;
  /** Уведомления о матрицах. */
  matrix?: MatrixNotificationSettings;
  /** Периодический дайджест. */
  digest?: DigestSettings;
}

/**
 * Ретеншн истории (Спринт 18).
 *
 * Дашборд и метрики живут на агрегатах, поэтому удаление старых записей
 * не искажает «Всего запусков» и стоимость: чистится только сырая история.
 * 0 — соответствующее ограничение выключено.
 */
export interface HistorySettings {
  /** Удалять завершённые записи старше N дней (0 — не удалять по возрасту). */
  retentionDays: number;
  /** Хранить не более N последних записей (0 — без ограничения). */
  maxRecords: number;
  /** Когда последний раз запускалась автоочистка (ISO). */
  lastCleanupAt: string | null;
  /** Сколько записей удалила последняя очистка (для дашборда). */
  lastCleanupDeleted: number;
}

/**
 * Входящие webhook-триггеры (Спринт 22).
 *
 * Запрос: `POST /api/hooks/<task>?token=<token>` с заголовком
 * `X-Scheduler-Signature: sha256=<hmac>` (совместим с `X-Hub-Signature-256`).
 * Токен подтверждает, кто вызывает хук, HMAC — целостность тела запроса.
 */
export interface HookSettings {
  /** Включены ли входящие webhook-триггеры. */
  enabled: boolean;
  /** Общий токен в query-параметре `token` (сравнивается timing-safe). */
  token: string;
  /** Секрет для HMAC-SHA256 по сырому телу запроса. */
  secret: string;
  /** Требовать HMAC-подпись. Выключение допустимо только для локальных тестов. */
  requireSignature: boolean;
  /** Максимальный размер тела запроса в байтах (1 KiB..5 MiB). */
  maxBodyBytes: number;
  /** Допустимое расхождение `X-Scheduler-Timestamp` с текущим временем, секунды. 0 — не проверять. */
  timestampToleranceSeconds: number;
}

/** Настройки внешних интеграций (Спринт 22). */
export interface IntegrationSettings {
  /** Входящие webhook-триггеры из CI/CD. */
  hooks: HookSettings;
}

/**
 * Глобальные настройки плагина, которые меняются из GUI.
 * Хранятся в settings.json рядом с tasks.json / history.json.
 */
export interface SchedulerSettings {
  /** Максимум одновременно выполняющихся задач. 0 — без ограничения. */
  maxConcurrent: number;
  /** Зимняя тема оформления GUI (снежинки, морозные рамки, градиент). */
  winterMode: boolean;
  /** Уведомления о завершении задач. */
  notifications: NotificationSettings;
  /** Ретеншн истории запусков. */
  history: HistorySettings;
  /** Внешние интеграции: входящие webhook-триггеры. */
  integrations: IntegrationSettings;
}

export const SETTINGS_FILE = path.join(PLUGIN_DIR, "settings.json");
export const DEFAULT_MAX_CONCURRENT = 1;
export const DEFAULT_WINTER_MODE = false;
export const DEFAULT_RETENTION_DAYS = 30;
export const DEFAULT_MAX_RECORDS = 5000;

/** Уведомления (Спринт 20): таймаут webhook, повторы и порог «зависшей» матрицы. */
export const DEFAULT_WEBHOOK_TIMEOUT_MS = 10_000;
export const DEFAULT_WEBHOOK_RETRY_COUNT = 2;
export const DEFAULT_WEBHOOK_RETRY_DELAY_MS = 1_000;
export const DEFAULT_STUCK_AFTER_MINUTES = 60;

/** Входящие хуки (Спринт 22): тело до 256 KiB, timestamp ±5 минут. */
export const DEFAULT_HOOK_MAX_BODY_BYTES = 256 * 1024;
export const DEFAULT_HOOK_TIMESTAMP_TOLERANCE_SECONDS = 300;
const MAX_HOOK_BODY_BYTES = 5 * 1024 * 1024;
const MAX_HOOK_CREDENTIAL_LENGTH = 512;

/** Значения интеграций по умолчанию: хуки выключены, подпись обязательна. */
export function defaultIntegrations(): IntegrationSettings {
  return {
    hooks: {
      enabled: false,
      token: "",
      secret: "",
      requireSignature: true,
      maxBodyBytes: DEFAULT_HOOK_MAX_BODY_BYTES,
      timestampToleranceSeconds: DEFAULT_HOOK_TIMESTAMP_TOLERANCE_SECONDS,
    },
  };
}

/** Генерирует криптостойкие учётные данные для входящего хука. */
export function generateHookCredentials(): { token: string; secret: string } {
  return {
    token: crypto.randomBytes(24).toString("hex"),
    secret: crypto.randomBytes(32).toString("hex"),
  };
}

/** Ретеншн по умолчанию: 30 дней и не больше 5000 записей. */
export function defaultHistorySettings(): HistorySettings {
  return {
    retentionDays: DEFAULT_RETENTION_DAYS,
    maxRecords: DEFAULT_MAX_RECORDS,
    lastCleanupAt: null,
    lastCleanupDeleted: 0,
  };
}

/** Приводит счётчик ретеншна к безопасному целому (>= 0). */
function normalizeRetentionLimit(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const int = Math.floor(n);
  return int >= 0 ? int : fallback;
}

/** Приводит настройки ретеншна к безопасному виду. */
function normalizeHistorySettings(
  value: unknown,
  fallback: HistorySettings
): HistorySettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...fallback };
  }
  const raw = value as Partial<HistorySettings>;
  const lastCleanupAt =
    typeof raw.lastCleanupAt === "string" && raw.lastCleanupAt.trim()
      ? raw.lastCleanupAt.trim()
      : null;
  return {
    retentionDays: normalizeRetentionLimit(raw.retentionDays, fallback.retentionDays),
    maxRecords: normalizeRetentionLimit(raw.maxRecords, fallback.maxRecords),
    lastCleanupAt,
    lastCleanupDeleted: normalizeRetentionLimit(
      raw.lastCleanupDeleted,
      fallback.lastCleanupDeleted
    ),
  };
}

/** Значения уведомлений по умолчанию: всё выключено, только ошибки. */
export function defaultNotifications(): NotificationSettings {
  return {
    enabled: false,
    onlyOnError: true,
    webhook: {
      enabled: false,
      url: "",
      timeoutMs: DEFAULT_WEBHOOK_TIMEOUT_MS,
      retryCount: DEFAULT_WEBHOOK_RETRY_COUNT,
      retryDelayMs: DEFAULT_WEBHOOK_RETRY_DELAY_MS,
    },
    templates: {
      success: '✅ Задача "{task}" выполнена ({duration})',
      error: '❌ Задача "{task}" упала ({duration}){error}',
    },
    filters: { include: [], exclude: [] },
    matrix: {
      enabled: true,
      onPartial: true,
      onAllFailed: true,
      stuckAfterMinutes: DEFAULT_STUCK_AFTER_MINUTES,
    },
    digest: {
      enabled: false,
      frequency: "daily",
      time: "09:00",
      lastSentAt: null,
    },
  };
}

/** Приводит значение лимита к безопасному целому (>= 0). */
function normalizeMaxConcurrent(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const int = Math.floor(n);
  return int >= 0 ? int : fallback;
}

/** Приводит значение зимнего режима к boolean. */
function normalizeWinterMode(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

/** Приводит значение к конечному целому в диапазоне [min, max]. */
function normalizeIntInRange(
  value: unknown,
  fallback: number,
  min: number,
  max: number
): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/** Приводит время HH:MM к безопасному виду. */
function normalizeDailyTime(value: unknown, fallback: string): string {
  if (typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value.trim())) {
    return value.trim();
  }
  return fallback;
}

/** Список имён задач: массив строк, обрезанных и без пустых значений. */
function normalizeNameList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Приводит настройки уведомлений к безопасному виду. */
function normalizeNotifications(
  value: unknown,
  fallback: NotificationSettings
): NotificationSettings {
  const fallbackWebhook = fallback.webhook ?? defaultNotifications().webhook!;
  const fallbackTemplates = fallback.templates ?? defaultNotifications().templates!;
  const fallbackFilters = fallback.filters ?? { include: [], exclude: [] };
  const fallbackMatrix = fallback.matrix ?? defaultNotifications().matrix!;
  const fallbackDigest = fallback.digest ?? defaultNotifications().digest!;

  const raw = asRecord(value);
  if (!raw) {
    return {
      ...fallback,
      webhook: { ...fallbackWebhook },
      templates: { ...fallbackTemplates },
      filters: {
        include: [...fallbackFilters.include],
        exclude: [...fallbackFilters.exclude],
      },
      matrix: { ...fallbackMatrix },
      digest: { ...fallbackDigest },
    };
  }

  const rawWebhook = asRecord(raw.webhook);
  const rawTemplates = asRecord(raw.templates);
  const rawFilters = asRecord(raw.filters);
  const rawMatrix = asRecord(raw.matrix);
  const rawDigest = asRecord(raw.digest);

  const frequency: DigestFrequency =
    rawDigest?.frequency === "weekly" || rawDigest?.frequency === "daily"
      ? rawDigest.frequency
      : fallbackDigest.frequency;

  const lastSentAt =
    typeof rawDigest?.lastSentAt === "string" && rawDigest.lastSentAt.trim()
      ? rawDigest.lastSentAt.trim()
      : null;

  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : fallback.enabled,
    onlyOnError:
      typeof raw.onlyOnError === "boolean" ? raw.onlyOnError : fallback.onlyOnError,
    webhook: {
      enabled:
        typeof rawWebhook?.enabled === "boolean"
          ? rawWebhook.enabled
          : fallbackWebhook.enabled,
      url:
        typeof rawWebhook?.url === "string"
          ? rawWebhook.url.trim()
          : fallbackWebhook.url,
      timeoutMs: normalizeIntInRange(
        rawWebhook?.timeoutMs,
        fallbackWebhook.timeoutMs,
        1_000,
        120_000
      ),
      retryCount: normalizeIntInRange(
        rawWebhook?.retryCount,
        fallbackWebhook.retryCount,
        0,
        5
      ),
      retryDelayMs: normalizeIntInRange(
        rawWebhook?.retryDelayMs,
        fallbackWebhook.retryDelayMs,
        100,
        60_000
      ),
    },
    templates: {
      success:
        typeof rawTemplates?.success === "string" && rawTemplates.success.trim()
          ? rawTemplates.success
          : fallbackTemplates.success,
      error:
        typeof rawTemplates?.error === "string" && rawTemplates.error.trim()
          ? rawTemplates.error
          : fallbackTemplates.error,
    },
    filters: {
      include: normalizeNameList(rawFilters?.include, fallbackFilters.include),
      exclude: normalizeNameList(rawFilters?.exclude, fallbackFilters.exclude),
    },
    matrix: {
      enabled:
        typeof rawMatrix?.enabled === "boolean"
          ? rawMatrix.enabled
          : fallbackMatrix.enabled,
      onPartial:
        typeof rawMatrix?.onPartial === "boolean"
          ? rawMatrix.onPartial
          : fallbackMatrix.onPartial,
      onAllFailed:
        typeof rawMatrix?.onAllFailed === "boolean"
          ? rawMatrix.onAllFailed
          : fallbackMatrix.onAllFailed,
      stuckAfterMinutes: normalizeIntInRange(
        rawMatrix?.stuckAfterMinutes,
        fallbackMatrix.stuckAfterMinutes,
        0,
        10_080
      ),
    },
    digest: {
      enabled:
        typeof rawDigest?.enabled === "boolean"
          ? rawDigest.enabled
          : fallbackDigest.enabled,
      frequency,
      time: normalizeDailyTime(rawDigest?.time, fallbackDigest.time),
      lastSentAt,
    },
  };
}

/** Приводит настройки интеграций к безопасному виду. */
function normalizeIntegrations(
  value: unknown,
  fallback: IntegrationSettings
): IntegrationSettings {
  const fallbackHooks = fallback.hooks ?? defaultIntegrations().hooks;
  const raw = asRecord(value);
  const rawHooks = asRecord(raw?.hooks);

  const readCredential = (input: unknown, previous: string): string => {
    if (typeof input !== "string") return previous;
    return input.trim().slice(0, MAX_HOOK_CREDENTIAL_LENGTH);
  };

  return {
    hooks: {
      enabled:
        typeof rawHooks?.enabled === "boolean"
          ? rawHooks.enabled
          : fallbackHooks.enabled,
      token: readCredential(rawHooks?.token, fallbackHooks.token),
      secret: readCredential(rawHooks?.secret, fallbackHooks.secret),
      requireSignature:
        typeof rawHooks?.requireSignature === "boolean"
          ? rawHooks.requireSignature
          : fallbackHooks.requireSignature,
      maxBodyBytes: normalizeIntInRange(
        rawHooks?.maxBodyBytes,
        fallbackHooks.maxBodyBytes,
        1_024,
        MAX_HOOK_BODY_BYTES
      ),
      timestampToleranceSeconds: normalizeIntInRange(
        rawHooks?.timestampToleranceSeconds,
        fallbackHooks.timestampToleranceSeconds,
        0,
        86_400
      ),
    },
  };
}

/** Читает настройки. Битый/отсутствующий файл — значения по умолчанию. */
export async function loadSettings(): Promise<SchedulerSettings> {
  const fallbackNotifications = defaultNotifications();
  const fallbackHistory = defaultHistorySettings();
  const fallbackIntegrations = defaultIntegrations();
  try {
    const raw = await fs.readFile(SETTINGS_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<SchedulerSettings> | null;
    return {
      maxConcurrent: normalizeMaxConcurrent(
        parsed?.maxConcurrent,
        DEFAULT_MAX_CONCURRENT
      ),
      winterMode: normalizeWinterMode(
        parsed?.winterMode,
        DEFAULT_WINTER_MODE
      ),
      notifications: normalizeNotifications(
        parsed?.notifications,
        fallbackNotifications
      ),
      history: normalizeHistorySettings(parsed?.history, fallbackHistory),
      integrations: normalizeIntegrations(
        parsed?.integrations,
        fallbackIntegrations
      ),
    };
  } catch {
    return {
      maxConcurrent: DEFAULT_MAX_CONCURRENT,
      winterMode: DEFAULT_WINTER_MODE,
      notifications: fallbackNotifications,
      history: fallbackHistory,
      integrations: fallbackIntegrations,
    };
  }
}

/** Сохраняет настройки (частичное обновление поверх текущих). */
export async function saveSettings(
  patch: Partial<SchedulerSettings>
): Promise<SchedulerSettings> {
  const current = await loadSettings();
  const next: SchedulerSettings = {
    maxConcurrent:
      patch.maxConcurrent !== undefined
        ? normalizeMaxConcurrent(patch.maxConcurrent, current.maxConcurrent)
        : current.maxConcurrent,
    winterMode:
      patch.winterMode !== undefined
        ? normalizeWinterMode(patch.winterMode, current.winterMode)
        : current.winterMode,
    notifications:
      patch.notifications !== undefined
        ? normalizeNotifications(patch.notifications, current.notifications)
        : current.notifications,
    history:
      patch.history !== undefined
        ? normalizeHistorySettings(patch.history, current.history)
        : current.history,
    integrations:
      patch.integrations !== undefined
        ? normalizeIntegrations(patch.integrations, current.integrations)
        : current.integrations,
  };

  // Удобство: при включении хуков без явных учётных данных генерируем их,
  // чтобы функция сразу работала, а секреты не приходилось придумывать вручную.
  if (next.integrations.hooks.enabled) {
    if (!next.integrations.hooks.token || !next.integrations.hooks.secret) {
      const generated = generateHookCredentials();
      if (!next.integrations.hooks.token) next.integrations.hooks.token = generated.token;
      if (!next.integrations.hooks.secret) next.integrations.hooks.secret = generated.secret;
    }
  }

  await fs.mkdir(PLUGIN_DIR, { recursive: true });
  await fs.writeFile(SETTINGS_FILE, JSON.stringify(next, null, 2), "utf8");
  return next;
}
