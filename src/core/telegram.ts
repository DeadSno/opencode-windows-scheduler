/**
 * Telegram Bot API: отправка уведомлений (Спринт 25).
 *
 * Модуль намеренно не зависит от настроек и сетевого слоя приложения:
 * всё, что нужно, передаётся аргументами. Это позволяет тестировать
 * экранирование и сборку запроса без реальных вызовов Telegram.
 */
export type TelegramParseMode = "" | "HTML" | "Markdown" | "MarkdownV2";

/** Таймаут запроса по умолчанию. */
const DEFAULT_TIMEOUT_MS = 10_000;

export interface TelegramSendOptions {
  /** База API; по умолчанию https://api.telegram.org. */
  apiBase?: string;
  /** Разметка; пусто — plain text. */
  parseMode?: TelegramParseMode;
  /** Отправить без звука. */
  disableNotification?: boolean;
  /** ID темы форума, если указан. */
  messageThreadId?: number | null;
  /** Добавить ссылку на дашборд. */
  includeDashboardLink?: boolean;
  /** URL дашборда; null/пусто — ссылка не добавляется. */
  dashboardUrl?: string | null;
  /** Таймаут запроса в мс. */
  timeoutMs?: number;
  /** Подмена fetch для тестов. */
  fetchImpl?: typeof fetch;
}

/** Экранирует текст под выбранный parse_mode. */
export function escapeTelegramText(
  text: string,
  parseMode: TelegramParseMode = ""
): string {
  const value = String(text ?? "");
  if (parseMode === "HTML") {
    return value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }
  if (parseMode === "MarkdownV2") {
    return value.replace(/([\\_*[\]()~`>#+\-=|{}.!])/g, "\\$1");
  }
  if (parseMode === "Markdown") {
    return value.replace(/([\\_*[\]`])/g, "\\$1");
  }
  return value;
}

/** Экранирует URL для HTML-атрибута. */
function escapeHtmlAttribute(url: string): string {
  return url
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Готовит текст сообщения: экранирует пользовательские данные и добавляет
 * ссылку на дашборд в разметке выбранного режима.
 */
export function formatTelegramText(
  text: string,
  parseMode: TelegramParseMode = "",
  dashboardUrl?: string | null
): string {
  const body = escapeTelegramText(text, parseMode);
  const url = (dashboardUrl ?? "").trim();
  if (!url) return body;

  if (parseMode === "HTML") {
    return `${body}\n\n<a href="${escapeHtmlAttribute(url)}">📊 Открыть дашборд</a>`;
  }
  if (parseMode === "MarkdownV2") {
    const escapedUrl = url.replace(/[)\\]/g, "\\$&");
    return `${body}\n\n[📊 Открыть дашборд](${escapedUrl})`;
  }
  if (parseMode === "Markdown") {
    const escapedUrl = url.replace(/[)]/g, "\\)");
    return `${body}\n\n[📊 Открыть дашборд](${escapedUrl})`;
  }
  return `${body}\n\n📊 Открыть дашборд: ${url}`;
}

/** Проверяет формат токена бота; возвращает trimmed-значение. */
export function validateTelegramToken(token: string): string {
  const value = (token ?? "").trim();
  if (!value) {
    throw new Error("Не задан токен Telegram-бота.");
  }
  // Формат BotFather: <digits>:<base64-ish>. Проверяем достаточно мягко,
  // чтобы не ломать тестовые токены, но отсекать явный мусор.
  if (!/^\d+:[A-Za-z0-9_-]{5,}$/.test(value)) {
    throw new Error("Некорректный токен Telegram-бота.");
  }
  return value;
}

/** Маскирует токен для сообщений об ошибках и логов. */
export function maskTelegramToken(token: string): string {
  const value = (token ?? "").trim();
  if (!value) return "***";
  const colon = value.indexOf(":");
  if (colon <= 0) return "***";
  const id = value.slice(0, colon);
  const secret = value.slice(colon + 1);
  const tail = secret.length >= 4 ? secret.slice(-4) : "";
  return `${id}:***${tail}`;
}

/** Убирает токен из произвольного текста ошибки. */
function sanitizeErrorText(text: string, token: string): string {
  if (!text) return text;
  return text.split(token).join(maskTelegramToken(token));
}

function resolveApiBase(apiBase?: string): string {
  const value = (apiBase ?? "https://api.telegram.org").trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Некорректный адрес Telegram API.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Telegram API поддерживает только http:// или https://.");
  }
  return value;
}

/**
 * Отправляет сообщение через Bot API `sendMessage`.
 *
 * Бросает Error с безопасным текстом (токен замаскирован). Вызывающий код
 * обязан перехватить ошибку, чтобы уведомление не ломало задачу.
 */
export async function sendTelegramMessage(
  token: string,
  chatId: string,
  text: string,
  options: TelegramSendOptions = {}
): Promise<void> {
  const safeToken = validateTelegramToken(token);
  const target = (chatId ?? "").trim();
  if (!target) {
    throw new Error("Не задан chat_id Telegram.");
  }

  const apiBase = resolveApiBase(options.apiBase);
  const parseMode = options.parseMode ?? "";
  const body: Record<string, unknown> = {
    chat_id: target,
    text: formatTelegramText(
      text,
      parseMode,
      options.includeDashboardLink === false ? null : options.dashboardUrl
    ),
  };
  if (parseMode) body.parse_mode = parseMode;
  if (options.disableNotification) body.disable_notification = true;
  if (
    typeof options.messageThreadId === "number" &&
    Number.isFinite(options.messageThreadId) &&
    options.messageThreadId > 0
  ) {
    body.message_thread_id = Math.floor(options.messageThreadId);
  }

  const timeoutMs = Math.max(
    1_000,
    Math.floor(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  );
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(
      `${apiBase}/bot${safeToken}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      }
    );

    const raw = await response.text().catch(() => "");
    let parsed: any = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      parsed = null;
    }

    if (!response.ok || parsed?.ok === false) {
      const description =
        (typeof parsed?.description === "string" && parsed.description) ||
        raw.slice(0, 200) ||
        `HTTP ${response.status}`;
      throw new Error(
        `Telegram API: ${sanitizeErrorText(description, safeToken)}`
      );
    }
  } catch (err: any) {
    if (err?.name === "AbortError") {
      throw new Error(`Таймаут Telegram API (${Math.floor(timeoutMs / 1000)} с).`);
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(sanitizeErrorText(message, safeToken));
  } finally {
    clearTimeout(timer);
  }
}
