import type { CronConversion } from "../types.js";

/**
 * Сообщение об ошибке, возвращаемое при встрече неподдерживаемого cron-выражения.
 * Содержит описание поддерживаемого подмножества.
 * Собрано конкатенацией, чтобы избежать последовательности закрывающего комментария внутри строк.
 */
const UNSUPPORTED_ERROR =
  "Неподдерживаемое cron-выражение.\n" +
  "\n" +
  "Поддерживаемое подмножество cron (5 полей: минута час день_месяца месяц день_недели):\n" +
  "  * * * * *              -> MINUTE, каждую минуту (/mo 1)\n" +
  "  */N * * * *            -> MINUTE, каждые N минут (/mo N)\n" +
  "  M H * * *              -> DAILY, ежедневно в HH:MM (/st HH:MM)\n" +
  "  M H * * D              -> WEEKLY, по неделям в день D в HH:MM (/d D /st HH:MM)\n" +
  "\n" +
  "Не поддерживаются: диапазоны (1-5), списки (1,2,3), комбинации месяца и дня недели,\n" +
  "*/N на месяце или дне недели, а также любые другие сложные выражения.\n" +
  "Пожалуйста, упростите расписание, используя одно из поддерживаемых выше выражений.";

/** Дни недели для schtasks /d (0 и 7 = воскресенье). */
const DAY_OF_WEEK_MAP: Record<string, string> = {
  "0": "SUN",
  "1": "MON",
  "2": "TUE",
  "3": "WED",
  "4": "THU",
  "5": "FRI",
  "6": "SAT",
  "7": "SUN",
};

/**
 * Проверяет, является ли строка звездочкой "*".
 */
function isStar(value: string): boolean {
  return value === "*";
}

/**
 * Проверяет, является ли строка шаблоном звездочка-слэш-N (N — положительное целое).
 * Возвращает N или undefined.
 */
function parseStep(value: string): number | undefined {
  const match = value.match(/^\*\/(\d+)$/);
  if (!match) return undefined;
  const n = parseInt(match[1], 10);
  return n > 0 ? n : undefined;
}

/**
 * Проверяет, является ли строка одиночным целым числом в диапазоне [min, max].
 * Возвращает число или undefined.
 */
function parseIntInRange(value: string, min: number, max: number): number | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  const n = parseInt(value, 10);
  return n >= min && n <= max ? n : undefined;
}

/**
 * Валидирует и преобразует 5-полевое cron-выражение во флаги schtasks.
 * Возвращает CronConversion или выбрасывает Error с понятным сообщением.
 */
export function convertCronToSchTasks(cron: string): CronConversion {
  const fields = cron.trim().split(/\s+/);

  if (fields.length !== 5) {
    throw new Error(
      "Ожидалось 5 полей cron-выражения (минута час день_месяца месяц день_недели), получено " +
        fields.length +
        ".\n\n" +
        UNSUPPORTED_ERROR
    );
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;

  // --- ПАТТЕРН 1: * * * * * -> MINUTE /mo 1 ---
  if (
    isStar(minute) &&
    isStar(hour) &&
    isStar(dayOfMonth) &&
    isStar(month) &&
    isStar(dayOfWeek)
  ) {
    return {
      sc: "MINUTE",
      extraFlags: ["/mo", "1"],
    };
  }

  // --- ПАТТЕРН 2: */N * * * * -> MINUTE /mo N ---
  const stepN = parseStep(minute);
  if (
    stepN !== undefined &&
    isStar(hour) &&
    isStar(dayOfMonth) &&
    isStar(month) &&
    isStar(dayOfWeek)
  ) {
    if (stepN > 1439) {
      throw new Error(
        "Интервал /mo " +
          stepN +
          " минут превышает максимально допустимый для schtasks (1439 минут).\n\n" +
          UNSUPPORTED_ERROR
      );
    }
    return {
      sc: "MINUTE",
      extraFlags: ["/mo", String(stepN)],
    };
  }

  // --- ПАТТЕРН 3: M * * * * -> HOURLY /mo 1 /st 00:MM (каждый час в минуту M) ---
  const mHourly = parseIntInRange(minute, 0, 59);
  if (
    mHourly !== undefined &&
    isStar(hour) &&
    isStar(dayOfMonth) &&
    isStar(month) &&
    isStar(dayOfWeek)
  ) {
    return {
      sc: "HOURLY",
      extraFlags: ["/mo", "1"],
      startTime: "00:" + String(mHourly).padStart(2, "0"),
    };
  }

  // --- ПАТТЕРН 4: M H * * * -> DAILY /st HH:MM ---
  const m = parseIntInRange(minute, 0, 59);
  const h = parseIntInRange(hour, 0, 23);
  if (
    m !== undefined &&
    h !== undefined &&
    isStar(dayOfMonth) &&
    isStar(month) &&
    isStar(dayOfWeek)
  ) {
    const startTime = String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
    return {
      sc: "DAILY",
      extraFlags: [],
      startTime,
    };
  }

  // --- ПАТТЕРН 4: M H * * D -> WEEKLY /d D /st HH:MM ---
  const d = parseIntInRange(dayOfWeek, 0, 7);
  if (
    m !== undefined &&
    h !== undefined &&
    isStar(dayOfMonth) &&
    isStar(month) &&
    d !== undefined
  ) {
    const startTime = String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
    const dayName = DAY_OF_WEEK_MAP[String(d)];
    return {
      sc: "WEEKLY",
      extraFlags: ["/d", dayName],
      startTime,
      days: dayName,
    };
  }

  // Ни один поддерживаемый паттерн не совпал.
  throw new Error(UNSUPPORTED_ERROR);
}

/**
 * Вычисляет ближайшее прошедшее (<= now) время срабатывания для поддерживаемых
 * cron-выражений. Нужно для восстановления пропущенных запусков (catch-up):
 * сравнивая это время с историей, можно понять, выполнялась ли задача.
 *
 * Возвращает null, если выражение не поддерживается или не распознано.
 */
export function previousRunTime(cron: string, now: Date = new Date()): Date | null {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return null;

  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  const star = (value: string) => value === "*";
  const intIn = (value: string, min: number, max: number): number | undefined => {
    if (!/^\d+$/.test(value)) return undefined;
    const n = parseInt(value, 10);
    return n >= min && n <= max ? n : undefined;
  };
  const nowMs = now.getTime();

  // * * * * * — каждую минуту: последняя граница минуты.
  if (star(minute) && star(hour) && star(dayOfMonth) && star(month) && star(dayOfWeek)) {
    return new Date(Math.floor(nowMs / 60000) * 60000);
  }

  // */N * * * * — каждые N минут (выравнивание по эпохе, как /mo N в schtasks).
  const step = /^\*\/(\d+)$/.exec(minute);
  if (step && star(hour) && star(dayOfMonth) && star(month) && star(dayOfWeek)) {
    const n = parseInt(step[1], 10);
    if (n > 0) {
      const minutes = Math.floor(nowMs / 60000);
      return new Date((minutes - (minutes % n)) * 60000);
    }
    return null;
  }

  // M * * * * — каждый час в минуту M.
  const hourlyMinute = intIn(minute, 0, 59);
  if (
    hourlyMinute !== undefined &&
    star(hour) &&
    star(dayOfMonth) &&
    star(month) &&
    star(dayOfWeek)
  ) {
    const result = new Date(now);
    result.setSeconds(0, 0);
    result.setMinutes(hourlyMinute);
    if (result.getTime() > nowMs) result.setHours(result.getHours() - 1);
    return result;
  }

  const m = intIn(minute, 0, 59);
  const h = intIn(hour, 0, 23);
  if (m === undefined || h === undefined || !star(dayOfMonth) || !star(month)) {
    return null;
  }

  // M H * * * — ежедневно в HH:MM.
  if (star(dayOfWeek)) {
    const result = new Date(now);
    result.setSeconds(0, 0);
    result.setHours(h, m, 0, 0);
    if (result.getTime() > nowMs) result.setDate(result.getDate() - 1);
    return result;
  }

  // M H * * D — еженедельно в день D (0 и 7 — воскресенье) в HH:MM.
  const dow = intIn(dayOfWeek, 0, 7);
  if (dow === undefined) return null;
  const targetDow = dow === 7 ? 0 : dow;
  const result = new Date(now);
  result.setSeconds(0, 0);
  result.setHours(h, m, 0, 0);
  // Не больше 8 итераций: одна неделя гарантированно содержит нужный день.
  for (let i = 0; i <= 8; i += 1) {
    if (result.getTime() <= nowMs && result.getDay() === targetDow) return result;
    result.setDate(result.getDate() - 1);
  }
  return null;
}

/**
 * Формирует массив флагов расписания для schtasks на основе CronConversion.
 * Включает /sc, /st (если есть), и дополнительные флаги (/mo, /d).
 */
export function buildScheduleFlags(conversion: CronConversion): string[] {
  const flags: string[] = ["/sc", conversion.sc];

  if (conversion.startTime) {
    flags.push("/st", conversion.startTime);
  }

  flags.push(...conversion.extraFlags);

  return flags;
}
