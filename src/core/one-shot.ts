/**
 * One-shot расписание (Спринт 23).
 *
 * Задача с triggerType "once" выполняется ровно один раз в момент runAt.
 * Абсолютное время хранится в ISO-8601 (UTC), а delaySeconds — удобный
 * способ задать его относительно момента создания.
 *
 * Модуль намеренно не зависит от планировщика ОС: здесь только нормализация
 * времени и преобразование в родные форматы Windows/Linux/macOS. Это
 * позволяет тестировать one-shot без создания реальных задач.
 */

/** Максимальная задержка — 5 лет. Защита от опечаток вроде 999999999. */
export const MAX_ONESHOT_DELAY_SECONDS = 5 * 365 * 24 * 60 * 60;

/** Минимальная задержка — 1 секунда. */
export const MIN_ONESHOT_DELAY_SECONDS = 1;

export interface OneShotInput {
  /** Абсолютное время запуска (ISO-8601). */
  runAt?: unknown;
  /** Задержка от текущего момента в секундах. */
  delaySeconds?: unknown;
}

export type OneShotNormalization =
  | {
      ok: true;
      /** Нормализованное абсолютное время в ISO-8601 (UTC). */
      runAt: string;
      /** Исходная задержка, если она была задана. */
      delaySeconds?: number;
    }
  | { ok: false; error: string };

function asDelaySeconds(value: unknown): number | undefined | "invalid" {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) return "invalid";
  const seconds = Math.floor(value);
  if (seconds < MIN_ONESHOT_DELAY_SECONDS || seconds > MAX_ONESHOT_DELAY_SECONDS) {
    return "invalid";
  }
  return seconds;
}

/**
 * Приводит runAt/delaySeconds к абсолютному ISO-времени.
 *
 * Если заданы оба поля, приоритет у runAt: delaySeconds сохраняется только
 * как исходная подсказка. Так импорт экспортированной задачи с обоими полями
 * не меняет момент запуска.
 */
export function normalizeOneShotRunAt(
  input: OneShotInput,
  nowMs: number = Date.now()
): OneShotNormalization {
  const rawRunAt =
    typeof input.runAt === "string" ? input.runAt.trim() : undefined;
  const delaySeconds = asDelaySeconds(input.delaySeconds);

  if (delaySeconds === "invalid") {
    return {
      ok: false,
      error:
        `delaySeconds должен быть целым числом от ${MIN_ONESHOT_DELAY_SECONDS} ` +
        `до ${MAX_ONESHOT_DELAY_SECONDS} секунд.`,
    };
  }

  if (rawRunAt) {
    const timestamp = Date.parse(rawRunAt);
    if (!Number.isFinite(timestamp)) {
      return {
        ok: false,
        error:
          `runAt должен быть датой в формате ISO-8601, например ` +
          `2026-12-01T09:00:00Z (получено «${rawRunAt}»).`,
      };
    }
    if (timestamp <= nowMs) {
      return {
        ok: false,
        error:
          `runAt должен быть в будущем (получено «${rawRunAt}»). ` +
          `Для запуска сразу используйте run_task_now.`,
      };
    }
    return {
      ok: true,
      runAt: new Date(timestamp).toISOString(),
      ...(delaySeconds !== undefined ? { delaySeconds } : {}),
    };
  }

  if (delaySeconds !== undefined) {
    return {
      ok: true,
      runAt: new Date(nowMs + delaySeconds * 1000).toISOString(),
      delaySeconds,
    };
  }

  return {
    ok: false,
    error:
      "Для однократного запуска укажите runAt (ISO-8601) или delaySeconds.",
  };
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * Формат даты/времени для schtasks /sd и /st.
 *
 * Windows Task Scheduler ожидает дату в формате текущей локали. Плагин уже
 * использует DD.MM.YYYY для ONCE-заглушки, поэтому сохраняем этот формат
 * для совместимости с русской локалью (основной сценарий проекта).
 */
export function buildWindowsOneShotFlags(
  runAt: string
): ["/sc", "ONCE", "/sd", string, "/st", string] {
  const date = new Date(runAt);
  return [
    "/sc",
    "ONCE",
    "/sd",
    `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}`,
    "/st",
    `${pad(date.getHours())}:${pad(date.getMinutes())}`,
  ];
}

/** Формат `at -t`: YYYYMMDDHHMM в локальном времени системы. */
export function buildAtTimestamp(runAt: string): string {
  const date = new Date(runAt);
  return (
    `${date.getFullYear()}` +
    `${pad(date.getMonth() + 1)}` +
    `${pad(date.getDate())}` +
    `${pad(date.getHours())}` +
    `${pad(date.getMinutes())}`
  );
}

/**
 * StartCalendarInterval для launchd. launchd не поддерживает год, поэтому
 * плагин дополнительно выгружает plist после первого запуска (см. обёртку).
 */
export function buildLaunchdCalendar(runAt: string): {
  Month: number;
  Day: number;
  Hour: number;
  Minute: number;
} {
  const date = new Date(runAt);
  return {
    Month: date.getMonth() + 1,
    Day: date.getDate(),
    Hour: date.getHours(),
    Minute: date.getMinutes(),
  };
}

/** Команда самоочистки launchd-агента после единственного запуска. */
export function buildLaunchdOneShotCleanup(sanitizedName: string): string {
  return (
    `launchctl bootout "gui/$(id -u)" ` +
    `"$HOME/Library/LaunchAgents/com.opencode.scheduler.${sanitizedName}.plist" ` +
    `>/dev/null 2>&1 || true`
  );
}
