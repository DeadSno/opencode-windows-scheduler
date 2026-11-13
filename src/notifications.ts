import { loadSettings } from "./settings.js";

/** Статус завершения задачи, который приходит из record-history. */
export type NotificationStatus = "success" | "error" | "timeout" | string;

/** Содержимое уведомления. */
export interface NotificationPayload {
  taskName: string;
  status: NotificationStatus;
  durationMs: number;
  error?: string | null;
}

/** Таймаут HTTP-запроса: уведомление не должно подвешивать обёртку задачи. */
const REQUEST_TIMEOUT_MS = 10_000;

/** Человекочитаемая длительность: 2300 мс → «2.3s». */
export function formatDuration(durationMs: number): string {
  const seconds = Math.max(0, Number(durationMs) || 0) / 1000;
  return `${seconds.toFixed(1)}s`;
}

/**
 * Формат сообщения:
 *  ✅ Задача "Тест" выполнена (2.3s)
 *  ❌ Задача "Тест" упала (2.3s): Quality Gate провален
 */
export function formatNotificationMessage(payload: NotificationPayload): string {
  const { taskName, status, durationMs, error } = payload;
  const duration = formatDuration(durationMs);

  if (status === "success") {
    return `✅ Задача "${taskName}" выполнена (${duration})`;
  }

  const reason = typeof error === "string" && error.trim() ? `: ${error.trim()}` : "";
  return `❌ Задача "${taskName}" упала (${duration})${reason}`;
}

/**
 * Отправляет POST на webhook.
 *
 * Тело совместимо одновременно с Discord (`content`) и Slack (`text`).
 * Бросает исключение только для диагностики — вызывающий код обязан
 * перехватить его, чтобы уведомление не ломало задачу.
 */
export async function sendWebhook(url: string, message: string): Promise<void> {
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

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(parsed, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: message, text: message }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`
      );
    }
  } catch (err: any) {
    if (err?.name === "AbortError") {
      throw new Error(`Таймаут запроса (${REQUEST_TIMEOUT_MS / 1000} с).`);
    }
    throw err instanceof Error ? err : new Error(String(err));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Уведомляет о завершении задачи во все включённые каналы.
 *
 * Правила:
 *  - `notifications.enabled === false` — ничего не делает;
 *  - `onlyOnError === true` — успешные запуски пропускаются;
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

    const message = formatNotificationMessage({
      taskName,
      status,
      durationMs,
      error,
    });

    const webhook = config.webhook;
    if (webhook?.enabled && webhook.url.trim()) {
      try {
        await sendWebhook(webhook.url, message);
        console.log(`[windows-scheduler] Уведомление отправлено в webhook: ${message}`);
      } catch (err: any) {
        console.error(
          `[windows-scheduler] Не удалось отправить webhook-уведомление: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }
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
      "🧪 Тестовое уведомление от OpenCode Scheduler — webhook настроен корректно."
    );
    return { success: true, message: "Тестовое уведомление отправлено." };
  } catch (err: any) {
    return {
      success: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
