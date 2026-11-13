import {
  loadSettings,
  saveSettings,
  type DigestFrequency,
  type DigestSettings,
  type NotificationFilters,
  type NotificationSettings,
  type NotificationTemplates,
} from "./settings.js";
import {
  buildAnalytics,
  type AnalyticsRecord,
  type ErrorAnalyticsRow,
} from "./core/analytics.js";
import { getHistory } from "./db/history-repo.js";

/** Статус завершения задачи, который приходит из record-history. */
export type NotificationStatus = "success" | "error" | "timeout" | string;

/** Содержимое уведомления. */
export interface NotificationPayload {
  taskName: string;
  status: NotificationStatus;
  durationMs: number;
  error?: string | null;
}

/** Таймаут HTTP-запроса по умолчанию: уведомление не должно подвешивать задачу. */
const REQUEST_TIMEOUT_MS = 10_000;

/** Максимальная задержка backoff между повторами. */
const MAX_RETRY_DELAY_MS = 30_000;

/** Человекочитаемая длительность: 2300 мс → «2.3s». */
export function formatDuration(durationMs: number): string {
  const seconds = Math.max(0, Number(durationMs) || 0) / 1000;
  return `${seconds.toFixed(1)}s`;
}

/** Экранирует regexp-спецсимволы. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Сопоставление имени задачи с шаблоном: `*` — любая последовательность,
 * регистр не важен. `regen-*` покрывает `regen-api`, `regen-ui`.
 */
export function wildcardMatch(pattern: string, value: string): boolean {
  const trimmed = (pattern ?? "").trim();
  if (!trimmed) return false;
  const source = trimmed
    .split("*")
    .map((part) => escapeRegExp(part))
    .join(".*");
  return new RegExp(`^${source}$`, "i").test(value.trim());
}

/** Проверяет, разрешена ли задача фильтрами include/exclude. */
export function isTaskAllowed(
  taskName: string,
  filters?: NotificationFilters
): boolean {
  if (!filters) return true;
  const name = (taskName ?? "").trim();
  if (!name) return false;
  const exclude = filters.exclude ?? [];
  if (exclude.some((pattern) => wildcardMatch(pattern, name))) return false;
  const include = filters.include ?? [];
  if (include.length === 0) return true;
  return include.some((pattern) => wildcardMatch(pattern, name));
}

/** Подставляет {key} в шаблон; неизвестные плейсхолдеры остаются как есть. */
export function renderTemplate(
  template: string,
  vars: Record<string, string>
): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : match
  );
}

/**
 * Формат сообщения по умолчанию:
 *  ✅ Задача "Тест" выполнена (2.3s)
 *  ❌ Задача "Тест" упала (2.3s): Quality Gate провален
 */
export function formatNotificationMessage(
  payload: NotificationPayload,
  templates?: NotificationTemplates
): string {
  const { taskName, status, durationMs, error } = payload;
  const duration = formatDuration(durationMs);
  const isSuccess = status === "success";
  const reason =
    typeof error === "string" && error.trim() ? `: ${error.trim()}` : "";

  if (templates && isSuccess && templates.success.trim()) {
    return renderTemplate(templates.success, {
      task: taskName,
      status,
      duration,
      error: "",
      emoji: "✅",
    });
  }
  if (templates && !isSuccess && templates.error.trim()) {
    return renderTemplate(templates.error, {
      task: taskName,
      status,
      duration,
      error: reason,
      emoji: "❌",
    });
  }

  if (isSuccess) {
    return `✅ Задача "${taskName}" выполнена (${duration})`;
  }
  return `❌ Задача "${taskName}" упала (${duration})${reason}`;
}

/** Информация о завершении матрицы для уведомления. */
export interface MatrixNotificationInfo {
  parentName: string;
  status: "success" | "error" | "partial";
  total: number;
  success: number;
  error: number;
  message?: string | null;
}

/** Текст уведомления о завершении матрицы. */
export function formatMatrixMessage(info: MatrixNotificationInfo): string {
  const { parentName, status, total, success, error } = info;
  if (status === "success") {
    return `✅ Матрица "${parentName}" завершилась: ${success} из ${total} клонов успешно.`;
  }
  if (status === "partial") {
    return `⚠️ Матрица "${parentName}" завершилась частично: успешно ${success} из ${total}, ошибок ${error}.`;
  }
  if (total > 0 && error >= total) {
    return `❌ Матрица "${parentName}": все ${total} клонов упали.`;
  }
  return `❌ Матрица "${parentName}" завершилась с ошибками: успешно ${success}, ошибок ${error} из ${total}.`;
}

/** Ошибка отправки webhook с признаком, имеет ли смысл повторять запрос. */
class WebhookError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.retryable = retryable;
  }
}

export interface WebhookOptions {
  /** Таймаут одной попытки в мс (по умолчанию 10 с). */
  timeoutMs?: number;
  /** Сколько раз повторить после неудачи (по умолчанию 0). */
  retryCount?: number;
  /** Базовая задержка backoff в мс (по умолчанию 1000). */
  retryDelayMs?: number;
  /** Подмена sleep для тестов. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function validateWebhookUrl(url: string): URL {
  const trimmed = (url ?? "").trim();
  if (!trimmed) {
    throw new Error("URL вебхука не задан.");
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Некорректный URL вебхука.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Вебхук поддерживает только http:// или https://.");
  }
  return parsed;
}

/** Одна попытка POST. Бросает WebhookError с признаком retryable. */
async function postOnce(
  parsed: URL,
  message: string,
  timeoutMs: number
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(parsed, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: message, text: message }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const retryable = response.status >= 500 || response.status === 429;
      throw new WebhookError(
        `HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`,
        retryable
      );
    }
  } catch (err: any) {
    if (err?.name === "AbortError") {
      throw new WebhookError(`Таймаут запроса (${timeoutMs / 1000} с).`, true);
    }
    if (err instanceof WebhookError) throw err;
    // Сетевые ошибки fetch (DNS, соединение) имеет смысл повторять.
    throw new WebhookError(err instanceof Error ? err.message : String(err), true);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Отправляет POST на webhook с повторами и экспоненциальным backoff.
 *
 * Тело совместимо одновременно с Discord (`content`) и Slack (`text`).
 * Повторяются только сетевые ошибки, таймауты, 5xx и 429; прочие 4xx — сразу
 * ошибка (повтор не поможет). Бросает исключение только для диагностики —
 * вызывающий код обязан перехватить его, чтобы уведомление не ломало задачу.
 */
export async function sendWebhook(
  url: string,
  message: string,
  options: WebhookOptions = {}
): Promise<void> {
  const parsed = validateWebhookUrl(url);
  const timeoutMs = Math.max(1, Math.floor(options.timeoutMs ?? REQUEST_TIMEOUT_MS));
  const retryCount = Math.max(0, Math.floor(options.retryCount ?? 0));
  const retryDelayMs = Math.max(1, Math.floor(options.retryDelayMs ?? 1_000));
  const sleep = options.sleep ?? defaultSleep;

  const attempts = retryCount + 1;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await postOnce(parsed, message, timeoutMs);
      return;
    } catch (err) {
      lastError = err;
      const retryable = err instanceof WebhookError ? err.retryable : true;
      if (!retryable || attempt === attempts - 1) break;
      const delay = Math.min(
        MAX_RETRY_DELAY_MS,
        retryDelayMs * 2 ** attempt
      );
      await sleep(delay);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function webhookOptionsFrom(config: NotificationSettings): WebhookOptions {
  const webhook = config.webhook;
  return {
    timeoutMs: webhook?.timeoutMs,
    retryCount: webhook?.retryCount,
    retryDelayMs: webhook?.retryDelayMs,
  };
}

/** Отправляет текст во включённый webhook; ошибки только логируются. */
async function deliver(config: NotificationSettings, message: string): Promise<boolean> {
  const webhook = config.webhook;
  if (!webhook?.enabled || !webhook.url.trim()) return false;
  try {
    await sendWebhook(webhook.url, message, webhookOptionsFrom(config));
    console.log(`[windows-scheduler] Уведомление отправлено в webhook: ${message}`);
    return true;
  } catch (err: any) {
    console.error(
      `[windows-scheduler] Не удалось отправить webhook-уведомление: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return false;
  }
}

/**
 * Уведомляет о завершении задачи во все включённые каналы.
 *
 * Правила:
 *  - `notifications.enabled === false` — ничего не делает;
 *  - `onlyOnError === true` — успешные запуски пропускаются;
 *  - фильтры include/exclude отсекают задачи по имени;
 *  - ошибки отправки только логируются, наружу не выбрасываются.
 */
export async function notifyTaskCompletion(
  taskName: string,
  status: NotificationStatus,
  durationMs: number,
  error?: string | null
): Promise<void> {
  try {
    const settings = await loadSettings();
    const config = settings.notifications;
    if (!config?.enabled) return;
    if (config.onlyOnError && status === "success") return;
    if (!isTaskAllowed(taskName, config.filters)) return;

    const message = formatNotificationMessage(
      { taskName, status, durationMs, error },
      config.templates
    );
    await deliver(config, message);
  } catch (err: any) {
    // Уведомление не должно ломать запись истории и саму задачу.
    console.error(
      `[windows-scheduler] Ошибка подготовки уведомления: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}

/**
 * Уведомляет о завершении матрицы (Спринт 20).
 *
 * partial — только при `matrix.onPartial`; полный провал — при
 * `matrix.onAllFailed`; успех — только когда `onlyOnError === false`.
 */
export async function notifyMatrixCompletion(
  info: MatrixNotificationInfo
): Promise<void> {
  try {
    const settings = await loadSettings();
    const config = settings.notifications;
    if (!config?.enabled) return;
    const matrix = config.matrix;
    if (!matrix?.enabled) return;
    if (!isTaskAllowed(info.parentName, config.filters)) return;

    if (info.status === "partial" && !matrix.onPartial) return;
    if (info.status === "error" && !matrix.onAllFailed) return;
    if (info.status === "success" && config.onlyOnError) return;

    await deliver(config, formatMatrixMessage(info));
  } catch (err: any) {
    console.error(
      `[windows-scheduler] Ошибка уведомления о матрице: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}

/** Запись о незавершённом запуске (для детектора зависших матриц). */
export interface RunningTaskRecord {
  id: number;
  taskName: string;
  startedAt: string;
}

/** Найденный зависший клон матрицы. */
export interface StuckMatrixClone {
  id: number;
  cloneName: string;
  parentName: string;
  startedAt: string;
  minutes: number;
}

/**
 * Ищет клоны матриц, которые выполняются дольше порога.
 * `parentByClone` — соответствие «имя клона → имя родителя» (без регистра).
 */
export function findStuckMatrixClones(
  running: RunningTaskRecord[],
  parentByClone: Map<string, string>,
  now: Date,
  thresholdMinutes: number
): StuckMatrixClone[] {
  if (!Number.isFinite(thresholdMinutes) || thresholdMinutes <= 0) return [];
  const thresholdMs = thresholdMinutes * 60_000;
  const result: StuckMatrixClone[] = [];
  for (const record of running) {
    const parentName = parentByClone.get(record.taskName.toLowerCase());
    if (!parentName) continue;
    const started = new Date(record.startedAt).getTime();
    if (!Number.isFinite(started)) continue;
    const elapsed = now.getTime() - started;
    if (elapsed < thresholdMs) continue;
    result.push({
      id: record.id,
      cloneName: record.taskName,
      parentName,
      startedAt: record.startedAt,
      minutes: Math.floor(elapsed / 60_000),
    });
  }
  return result;
}

/** Текст уведомления о зависшем клоне матрицы. */
export function formatStuckMatrixMessage(stuck: StuckMatrixClone): string {
  return (
    `⏳ Матрица "${stuck.parentName}": клон "${stuck.cloneName}" выполняется ` +
    `дольше ${stuck.minutes} мин (запущен ${stuck.startedAt}).`
  );
}

/** Отправляет уведомление о зависшем клоне, если матрицы включены. */
export async function notifyStuckMatrix(stuck: StuckMatrixClone): Promise<boolean> {
  try {
    const settings = await loadSettings();
    const config = settings.notifications;
    if (!config?.enabled) return false;
    if (!config.matrix?.enabled) return false;
    if (!isTaskAllowed(stuck.parentName, config.filters)) return false;
    return await deliver(config, formatStuckMatrixMessage(stuck));
  } catch (err: any) {
    console.error(
      `[windows-scheduler] Ошибка уведомления о зависшей матрице: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return false;
  }
}

/** Сводка для дайджеста. */
export interface DigestSummary {
  period: "daily" | "weekly";
  windowDays: number;
  total: number;
  success: number;
  error: number;
  partial: number;
  successRate: number;
  tokens: number;
  costUsd: number;
  topErrors: ErrorAnalyticsRow[];
}

/** Форматирует деньги: $0.0412. */
function formatMoney(value: number): string {
  return `$${value.toFixed(4)}`;
}

/** Форматирует локальную дату DD.MM.YYYY. */
function formatLocalDate(date: Date): string {
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${day}.${month}.${date.getFullYear()}`;
}

/** Строит сводку дайджеста из записей истории. */
export function buildDigestSummary(
  records: AnalyticsRecord[],
  options: { frequency: DigestFrequency; now?: Date }
): DigestSummary {
  const now = options.now ?? new Date();
  const windowDays = options.frequency === "weekly" ? 7 : 1;
  const report = buildAnalytics(records, {
    days: windowDays,
    now,
    topLimit: 5,
  });
  return {
    period: options.frequency,
    windowDays,
    total: report.totals.total,
    success: report.totals.success,
    error: report.totals.error,
    partial: report.totals.partial,
    successRate: report.totals.successRate,
    tokens: report.totals.tokens,
    costUsd: report.totals.costUsd,
    topErrors: report.errors,
  };
}

/** Текст дайджеста. */
export function formatDigestMessage(
  summary: DigestSummary,
  now: Date = new Date()
): string {
  const periodLabel = summary.period === "weekly" ? "за неделю" : "за сутки";
  const lines = [
    `📊 Дайджест ${periodLabel} (${formatLocalDate(now)})`,
    `Запусков: ${summary.total} — ✅ ${summary.success}, ❌ ${summary.error}, ⚠️ ${summary.partial} (${summary.successRate}%)`,
    `Стоимость: ${formatMoney(summary.costUsd)} · токенов: ${summary.tokens}`,
  ];
  if (summary.topErrors.length > 0) {
    lines.push("Топ ошибок:");
    for (const row of summary.topErrors) {
      lines.push(`• ${row.message} — ${row.count}`);
    }
  } else if (summary.total > 0) {
    lines.push("Ошибок нет 🎉");
  }
  return lines.join("\n");
}

/**
 * Пора ли отправлять дайджест.
 *
 * daily — раз в сутки после `digest.time`; weekly — по понедельникам после
 * `digest.time`. `lastSentAt` защищает от повторной отправки после перезапуска.
 */
export function isDigestDue(digest: DigestSettings, now: Date): boolean {
  if (!digest.enabled) return false;
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec((digest.time ?? "").trim());
  if (!match) return false;
  const hour = Number(match[1]);
  const minute = Number(match[2]);

  const target = new Date(now.getTime());
  target.setHours(hour, minute, 0, 0);
  if (digest.frequency === "weekly") {
    // Понедельник текущей недели (getDay(): 0 = воскресенье).
    const offset = (target.getDay() + 6) % 7;
    target.setDate(target.getDate() - offset);
  }

  if (now.getTime() < target.getTime()) return false;
  if (!digest.lastSentAt) return true;
  const last = new Date(digest.lastSentAt).getTime();
  return !Number.isFinite(last) || last < target.getTime();
}

/**
 * Собирает и отправляет дайджест.
 *
 * `updateLastSentAt` включается только для плановой отправки: ручная кнопка
 * «Отправить сейчас» не должна сдвигать расписание.
 */
export async function sendDigestNow(
  options: { now?: Date; updateLastSentAt?: boolean } = {}
): Promise<{ success: boolean; message: string }> {
  const now = options.now ?? new Date();
  try {
    const settings = await loadSettings();
    const config = settings.notifications;
    if (!config?.enabled) {
      return { success: false, message: "Уведомления выключены." };
    }
    const webhook = config.webhook;
    if (!webhook?.enabled || !webhook.url.trim()) {
      return { success: false, message: "Webhook выключен. Включите канал и укажите URL." };
    }
    const digest = config.digest;
    if (!digest) {
      return { success: false, message: "Настройки дайджеста не найдены." };
    }

    const records = getHistory(null, 5000) as AnalyticsRecord[];
    const summary = buildDigestSummary(records, {
      frequency: digest.frequency,
      now,
    });
    const text = formatDigestMessage(summary, now);
    await sendWebhook(webhook.url, text, webhookOptionsFrom(config));

    if (options.updateLastSentAt) {
      await saveSettings({
        notifications: {
          ...config,
          digest: { ...digest, lastSentAt: now.toISOString() },
        },
      });
    }
    return { success: true, message: "Дайджест отправлен." };
  } catch (err: any) {
    return {
      success: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Плановая проверка дайджеста: отправляет, если пора. Возвращает true при отправке. */
export async function maybeSendDigest(now: Date = new Date()): Promise<boolean> {
  try {
    const settings = await loadSettings();
    const config = settings.notifications;
    if (!config?.enabled) return false;
    const digest = config.digest;
    if (!digest?.enabled) return false;
    if (!isDigestDue(digest, now)) return false;
    const result = await sendDigestNow({ now, updateLastSentAt: true });
    if (result.success) {
      console.log("[windows-scheduler] Дайджест уведомлений отправлен.");
      return true;
    }
    console.error(`[windows-scheduler] Дайджест не отправлен: ${result.message}`);
    return false;
  } catch (err: any) {
    console.error(
      `[windows-scheduler] Ошибка дайджеста: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return false;
  }
}

/**
 * Отправляет тестовое сообщение в webhook (кнопка «🧪 Тестовое уведомление»).
 *
 * В отличие от notifyTaskCompletion, результат возвращается пользователю:
 * при тесте важно увидеть причину ошибки.
 */
export async function sendTestNotification(): Promise<{
  success: boolean;
  message: string;
}> {
  try {
    const settings = await loadSettings();
    const webhook = settings.notifications?.webhook;

    if (!webhook?.enabled) {
      return {
        success: false,
        message: "Webhook выключен. Включите канал и укажите URL.",
      };
    }
    if (!webhook.url.trim()) {
      return { success: false, message: "Не задан URL вебхука." };
    }

    await sendWebhook(
      webhook.url,
      "🧪 Тестовое уведомление от OpenCode Scheduler — webhook настроен корректно.",
      {
        timeoutMs: webhook.timeoutMs,
        retryCount: webhook.retryCount,
        retryDelayMs: webhook.retryDelayMs,
      }
    );
    return { success: true, message: "Тестовое уведомление отправлено." };
  } catch (err: any) {
    return {
      success: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
