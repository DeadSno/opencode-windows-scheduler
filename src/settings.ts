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
}

export const SETTINGS_FILE = path.join(PLUGIN_DIR, "settings.json");
export const DEFAULT_MAX_CONCURRENT = 1;
export const DEFAULT_WINTER_MODE = false;

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
    };
  } catch {
    return {
      maxConcurrent: DEFAULT_MAX_CONCURRENT,
      winterMode: DEFAULT_WINTER_MODE,
      notifications: fallbackNotifications,
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
  };
  await fs.mkdir(PLUGIN_DIR, { recursive: true });
  await fs.writeFile(SETTINGS_FILE, JSON.stringify(next, null, 2), "utf8");
  return next;
}
