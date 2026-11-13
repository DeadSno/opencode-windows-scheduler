import crypto from "node:crypto";
import type http from "node:http";
import type { HookSettings } from "./settings.js";

/**
 * Входящие webhook-триггеры (Спринт 22).
 *
 * Контракт:
 *   POST /api/hooks/<task>?token=<token>
 *   X-Scheduler-Signature: sha256=<hex hmac по сырому телу>
 *   X-Scheduler-Timestamp: <unix seconds|milliseconds>  (необязательно)
 *
 * Для совместимости с GitHub Actions принимается также `X-Hub-Signature-256`,
 * для GitLab — `X-Gitlab-Token` вместо query-параметра.
 *
 * HMAC считается по **сырому телу** запроса (без нормализации JSON), поэтому
 * отправитель должен подписывать ровно те байты, которые кладёт в body.
 */

/** Заголовки, в которых может прийти HMAC-подпись. */
const SIGNATURE_HEADERS = [
  "x-scheduler-signature",
  "x-hub-signature-256",
  "x-signature-256",
] as const;

/** Заголовки, в которых может прийти токен (альтернатива query-параметру). */
const TOKEN_HEADERS = ["x-scheduler-token", "x-gitlab-token"] as const;

type HeaderMap = Record<string, string | string[] | undefined>;

/** Первое значение заголовка (Node может вернуть массив). */
function firstHeader(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value.length > 0 ? String(value[0]) : null;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Сравнение строк без утечки длины через раннее завершение. */
export function timingSafeStringEqual(expected: string, provided: string): boolean {
  if (typeof expected !== "string" || typeof provided !== "string") return false;
  if (!expected || !provided) return false;
  const expectedHash = crypto.createHash("sha256").update(expected, "utf8").digest();
  const providedHash = crypto.createHash("sha256").update(provided, "utf8").digest();
  const equal = crypto.timingSafeEqual(expectedHash, providedHash);
  return equal && expected.length === provided.length;
}

/** Проверяет токен из query-параметра или заголовка. */
export function verifyHookToken(expected: string, provided: string | null): boolean {
  return typeof provided === "string" && timingSafeStringEqual(expected, provided);
}

/** Считает HMAC-SHA256 по сырому телу и возвращает значение в формате `sha256=<hex>`. */
export function signHookPayload(secret: string, body: Buffer | string): string {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
  const digest = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return `sha256=${digest}`;
}

/** Достаёт подпись из поддерживаемых заголовков. */
export function extractHookSignature(headers: HeaderMap): string | null {
  for (const name of SIGNATURE_HEADERS) {
    const value = firstHeader(headers[name]);
    if (value) return value;
  }
  return null;
}

/** Достаёт токен из поддерживаемых заголовков (если нет query-параметра). */
export function extractHookToken(headers: HeaderMap): string | null {
  for (const name of TOKEN_HEADERS) {
    const value = firstHeader(headers[name]);
    if (value) return value;
  }
  return null;
}

/**
 * Проверяет HMAC-подпись. Принимает `sha256=<hex>` и «голый» hex;
 * алгоритмы кроме SHA-256 намеренно не поддерживаются.
 */
export function verifyHookSignature(
  secret: string,
  body: Buffer | string,
  signature: string | null
): boolean {
  if (!secret || !signature) return false;
  const normalized = signature.trim();
  if (!/^sha256=/i.test(normalized) && !/^[a-f0-9]{64}$/i.test(normalized)) {
    return false;
  }
  const provided = normalized.replace(/^sha256=/i, "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(provided)) return false;
  const expected = signHookPayload(secret, body).replace(/^sha256=/, "");
  return timingSafeStringEqual(expected, provided);
}

/**
 * Проверяет необязательный timestamp против текущего времени.
 * 0 в настройках — проверка выключена. Без заголовка запрос разрешён.
 */
export function verifyHookTimestamp(
  value: string | null,
  toleranceSeconds: number,
  nowMs = Date.now()
): { ok: boolean; reason?: string } {
  if (!value || toleranceSeconds <= 0) return { ok: true };
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    return { ok: false, reason: "Некорректный X-Scheduler-Timestamp." };
  }
  const numeric = Number(trimmed);
  if (!Number.isFinite(numeric)) {
    return { ok: false, reason: "Некорректный X-Scheduler-Timestamp." };
  }
  // Значения больше 1e12 трактуем как миллисекунды, иначе — как секунды.
  const timestampMs = numeric > 1e12 ? numeric : numeric * 1000;
  const skewMs = Math.abs(nowMs - timestampMs);
  if (skewMs > toleranceSeconds * 1000) {
    return {
      ok: false,
      reason: `Timestamp вне допустимого окна (±${toleranceSeconds} с).`,
    };
  }
  return { ok: true };
}

export interface HookAuthInput {
  settings: HookSettings;
  token: string | null;
  signature: string | null;
  timestamp: string | null;
  /** Сырое тело запроса — ровно те байты, по которым считался HMAC. */
  body: Buffer;
  /** Текущее время (для тестов). */
  nowMs?: number;
}

export interface HookAuthResult {
  ok: boolean;
  /** HTTP-статус для отказа (200 при успехе). */
  status: number;
  error?: string;
}

/**
 * Полная проверка входящего хука: включён ли канал, токен, HMAC, timestamp.
 * Возвращает понятную ошибку на русском для ответа и логов.
 */
export function authenticateHookRequest(input: HookAuthInput): HookAuthResult {
  const { settings } = input;
  if (!settings.enabled) {
    return { ok: false, status: 403, error: "Входящие webhook-триггеры отключены." };
  }
  if (!settings.token) {
    return {
      ok: false,
      status: 403,
      error: "В настройках не задан token для входящих хуков.",
    };
  }
  if (!verifyHookToken(settings.token, input.token)) {
    return { ok: false, status: 401, error: "Неверный token." };
  }
  if (settings.requireSignature) {
    if (!settings.secret) {
      return {
        ok: false,
        status: 403,
        error: "В настройках не задан secret для HMAC-подписи.",
      };
    }
    if (!input.signature) {
      return {
        ok: false,
        status: 401,
        error: "Не передана HMAC-подпись (X-Scheduler-Signature).",
      };
    }
    if (!verifyHookSignature(settings.secret, input.body, input.signature)) {
      return { ok: false, status: 401, error: "Неверная HMAC-подпись." };
    }
  }
  const timestamp = verifyHookTimestamp(
    input.timestamp,
    settings.timestampToleranceSeconds,
    input.nowMs
  );
  if (!timestamp.ok) {
    return { ok: false, status: 401, error: timestamp.reason };
  }
  return { ok: true, status: 200 };
}

export type BodyReadResult =
  | { ok: true; body: Buffer }
  | { ok: false; status: number; error: string };

/**
 * Читает тело запроса с ограничением размера.
 *
 * Лишние байты не накапливаются в памяти: после превышения лимита поток
 * дочитывается и отбрасывается, чтобы клиент получил внятный 413, а не reset.
 */
export function readRequestBody(
  req: http.IncomingMessage,
  maxBytes: number
): Promise<BodyReadResult> {
  return new Promise((resolve) => {
    const limit = Math.max(1, Math.floor(maxBytes) || 1);
    let size = 0;
    let tooLarge = false;
    let settled = false;
    const chunks: Buffer[] = [];

    const finish = (result: BodyReadResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (tooLarge) return;
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) {
        finish({
          ok: false,
          status: 413,
          error: `Тело запроса больше ${limit} байт.`,
        });
        return;
      }
      finish({ ok: true, body: Buffer.concat(chunks) });
    });
    req.on("error", (err) => {
      finish({
        ok: false,
        status: 400,
        error: `Не удалось прочитать тело запроса: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    });
  });
}
