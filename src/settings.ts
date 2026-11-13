import fs from "node:fs/promises";
import path from "node:path";
import { PLUGIN_DIR } from "./types.js";

/** Настройки webhook-уведомлений (Discord/Slack/generic). */
export interface WebhookNotificationSettings {
  /** Включён ли канал. */
  enabled: boolean;
  /** URL вебхука. */
  url: string;
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
}

export const SETTINGS_FILE = path.join(PLUGIN_DIR, "settings.json");
export const DEFAULT_MAX_CONCURRENT = 1;
export const DEFAULT_WINTER_MODE = false;
export const DEFAULT_RETENTION_DAYS = 30;
export const DEFAULT_MAX_RECORDS = 5000;

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
    webhook: { enabled: false, url: "" },
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

/** Приводит настройки уведомлений к безопасному виду. */
function normalizeNotifications(
  value: unknown,
  fallback: NotificationSettings
): NotificationSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      ...fallback,
      webhook: fallback.webhook ? { ...fallback.webhook } : { enabled: false, url: "" },
    };
  }

  const raw = value as Partial<NotificationSettings> & { webhook?: unknown };
  const rawWebhook =
    raw.webhook && typeof raw.webhook === "object" && !Array.isArray(raw.webhook)
      ? (raw.webhook as Partial<WebhookNotificationSettings>)
      : undefined;
  const fallbackWebhook = fallback.webhook ?? { enabled: false, url: "" };

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
    },
  };
}

/** Читает настройки. Битый/отсутствующий файл — значения по умолчанию. */
export async function loadSettings(): Promise<SchedulerSettings> {
  const fallbackNotifications = defaultNotifications();
  const fallbackHistory = defaultHistorySettings();
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
    };
  } catch {
    return {
      maxConcurrent: DEFAULT_MAX_CONCURRENT,
      winterMode: DEFAULT_WINTER_MODE,
      notifications: fallbackNotifications,
      history: fallbackHistory,
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
  };
  await fs.mkdir(PLUGIN_DIR, { recursive: true });
  await fs.writeFile(SETTINGS_FILE, JSON.stringify(next, null, 2), "utf8");
  return next;
}
