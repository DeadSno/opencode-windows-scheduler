/**
 * Расширенный cron и окна запуска (Спринт 19).
 *
 * Два режима регистрации в ОС:
 *  - «родной» (флаги schtasks / строки crontab / plist launchd) — только для
 *    простых выражений и системной таймзоны;
 *  - «опрос раз в минуту» (MINUTE /mo 1 + node-gate в обёртке) — для всего
 *    остального (timezone != system, списки, L, #, комбинации). Обёртка
 *    вызывает dist/core/schedule-gate.js, который сам решает, пора ли запускать.
 *
 * Здесь живёт только чистая математика: парсинг, совпадение, ближайший запуск.
 * Никакого I/O и обращения к ОС.
 */
import { convertCronToSchTasks } from "./cron-to-schtasks.js";
import type { CronConversion } from "../types.js";

/** Ограничение на поиск ближайшего запуска. */
const MAX_SEARCH_DAYS = 5 * 366;

const MONTH_NAMES: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};
const DOW_NAMES: Record<string, number> = {
  SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6,
};

export interface ZonedParts {
  year: number; month: number; day: number;
  hour: number; minute: number; second: number; ms: number;
  weekday: number; // 0=Вс..6=Сб
}

/** Кэш форматтеров Intl по таймзоне (создание Intl.DateTimeFormat недёшево). */
const dtfCache = new Map<string, Intl.DateTimeFormat>();

function getDtf(timeZone: string): Intl.DateTimeFormat {
  const cached = dtfCache.get(timeZone);
  if (cached) return cached;
  // hourCycle h23: 00..23, без «24».
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric", month: "numeric", day: "numeric",
    hour: "numeric", minute: "numeric", second: "numeric",
    hourCycle: "h23",
  });
  dtfCache.set(timeZone, dtf);
  return dtf;
}

export function isValidIanaTimeZone(tz: string): boolean {
  const t = (tz || "").trim();
  if (!t) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: t });
    return true;
  } catch {
    return false;
  }
}

/** Системная таймзона (IANA) или "UTC", если её не удалось определить. */
export function systemTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Части даты в заданной инстанции (или в системной локали, если tz не задан). */
export function zonedParts(date: Date, timeZone?: string): ZonedParts {
  if (timeZone && timeZone !== Intl.DateTimeFormat().resolvedOptions().timeZone) {
    const parts = getDtf(timeZone).formatToParts(date);
    const bag: Record<string, number> = {};
    for (const p of parts) {
      if (p.type === "year" || p.type === "month" || p.type === "day"
          || p.type === "hour" || p.type === "minute" || p.type === "second") {
        bag[p.type] = Number(p.value);
      }
    }
    const asUtc = new Date(Date.UTC(bag.year, bag.month - 1, bag.day));
    return {
      year: bag.year, month: bag.month, day: bag.day,
      hour: bag.hour, minute: bag.minute, second: bag.second, ms: date.getUTCMilliseconds(),
      weekday: asUtc.getUTCDay(),
    };
  }
  return {
    year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate(),
    hour: date.getHours(), minute: date.getMinutes(), second: date.getSeconds(),
    ms: date.getMilliseconds(), weekday: date.getDay(),
  };
}

/** Стенные часы → UTC, итеративно учитывая смещение (DST-safe). null — несуществующее время. */
export function wallToUtc(y: number, m: number, d: number, h: number, mi: number, timeZone?: string): Date | null {
  const tz = timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const target = Date.UTC(y, m - 1, d, h, mi);
  const matches = (ms: number): boolean => {
    const p = zonedParts(new Date(ms), tz);
    return p.year === y && p.month === m && p.day === d && p.hour === h && p.minute === mi;
  };
  let guess = target;
  for (let i = 0; i < 4; i += 1) {
    const p = zonedParts(new Date(guess), tz);
    const actual = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    const delta = target - actual;
    if (delta === 0) break;
    guess += delta;
  }
  // При переходе на зимнее время настенное время существует дважды. Для
  // «следующего запуска» берём ПЕРВОЕ (более раннее) вхождение, а не то, к
  // которому сошлась итерация. Обычно совпадение одно, тогда результат тот же.
  const probes = [0, -30, 30, -60, 60, -90, 90, -120, 120].map(
    (minutes) => guess + minutes * 60_000
  );
  let best: number | null = null;
  for (const ms of probes) {
    if (!matches(ms)) continue;
    if (best === null || ms < best) best = ms;
  }
  return best === null ? null : new Date(best);
}

function lastDayOfMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function nthWeekdayOfMonth(y: number, m: number, weekday: number, n: number): number | null {
  const firstDow = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const first = 1 + ((weekday - firstDow + 7) % 7);
  const dom = first + 7 * (n - 1);
  return dom <= lastDayOfMonth(y, m) ? dom : null;
}

function expandField(token: string, min: number, max: number, names?: Record<string, number>): Set<number> {
  const result = new Set<number>();
  const items = token.split(",");
  for (const raw of items) {
    let item = raw.trim().toUpperCase();
    if (!item) throw new Error(`Пустой элемент в списке «${token}».`);
    if (names && names[item] !== undefined) item = String(names[item]);
    // шаг: a-b/n или */n
    const stepMatch = item.match(/^(.*)\/([0-9]+)$/);
    let step = 1;
    if (stepMatch) {
      item = (stepMatch[1] ?? "").trim();
      step = Number(stepMatch[2]);
      if (!Number.isInteger(step) || step < 1) {
        throw new Error(`Недопустимый шаг «/${stepMatch[2]}» в «${raw}».`);
      }
      if (item === "") throw new Error(`Некорректный шаг в «${raw}»: перед «/» ничего нет.`);
    }
    if (item === "*" || item === "") {
      for (let v = min; v <= max; v += step) result.add(v);
      continue;
    }
    const rangeMatch = item.match(/^([0-9A-Z]+)-([0-9A-Z]+)$/);
    if (rangeMatch) {
      let aToken = rangeMatch[1];
      let bToken = rangeMatch[2];
      if (names && names[aToken] !== undefined) aToken = String(names[aToken]);
      if (names && names[bToken] !== undefined) bToken = String(names[bToken]);
      const a = Number(aToken);
      const b = Number(bToken);
      if (!Number.isFinite(a) || !Number.isFinite(b)) {
        throw new Error(`Недопустимый диапазон «${item}».`);
      }
      if (a < min || b > max || a > b) {
        throw new Error(`Диапазон «${item}» вне границ ${min}..${max}.`);
      }
      for (let v = a; v <= b; v += step) result.add(v);
      continue;
    }
    const num = Number(item);
    if (!Number.isInteger(num) || num < min || num > max) {
      throw new Error(`Значение «${raw}» вне границ ${min}..${max}.`);
    }
    result.add(num);
  }
  return result;
}

export interface ParsedCron {
  /** Исходное выражение (после расширения @every). */
  raw: string;
  minute: Set<number>;
  hour: Set<number>;
  /** Дни месяца или null, если поле = «*» и не содержит L. */
  dayOfMonth: Set<number> | null;
  /** true — поле содержит «L» (последний день месяца). */
  lastDom: boolean;
  month: Set<number>;
  /** День недели 0(Вс)..6(Сб) или null, если поле = «*» и не содержит «#». */
  dayOfWeek: Set<number> | null;
  /** Пары {weekday, n} для «#». */
  nthWeekday: Array<{ weekday: number; n: number }>;
}

/** Разворачивает «@every 15m|2h|1d» в обычный cron. */
export function normalizeCron(expr: string): string {
  const trimmed = expr.trim();
  const match = trimmed.match(/^@every\s+(\d+)([mhd])$/i);
  if (!match) return trimmed;
  const n = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (unit === "m" && n >= 1 && n < 60) return `*/${n} * * * *`;
  if (unit === "h" && n >= 1 && n <= 23) return `0 */${n} * * *`;
  if (unit === "d" && n >= 1 && n <= 31) return `0 0 */${n} * *`;
  throw new Error(`Неподдерживаемый интервал «@every ${n}${unit}» (m: 1..59, h: 1..23, d: 1..31).`);
}

/** Парсит cron-выражение; бросает Error с понятным сообщением. */
export function parseCron(expr: string): ParsedCron {
  const raw = normalizeCron(expr);
  const fields = raw.split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`Ожидается 5 полей cron, получено ${fields.length}: «${raw}».`);
  }
  const [minF, hourF, domF, monthF, dowF] = fields;

  const minute = expandField(minF, 0, 59);
  const hour = expandField(hourF, 0, 23);
  const month = expandField(monthF, 1, 12, MONTH_NAMES);

  // dom: «*» + опциональный «L» в списке (например «15,L»).
  let dayOfMonth: Set<number> | null = null;
  let lastDom = false;
  {
    const tokens = domF.trim().toUpperCase().split(",").map((s) => s.trim());
    const kept: string[] = [];
    for (const token of tokens) {
      if (token === "L") { lastDom = true; continue; }
      kept.push(token);
    }
    if (domF.trim() !== "*") {
      dayOfMonth = kept.length > 0 ? expandField(kept.join(","), 1, 31) : new Set();
    }
  }

  // dow: «*» + имена + «d#n».
  let dayOfWeek: Set<number> | null = null;
  const nthWeekday: Array<{ weekday: number; n: number }> = [];
  {
    const tokens = dowF.trim().toUpperCase().split(",").map((s) => s.trim());
    const kept: string[] = [];
    for (const token of tokens) {
      const hash = token.match(/^([0-9A-Z]+)#([1-5])$/);
      if (hash) {
        let dToken = hash[1];
        if (DOW_NAMES[dToken] !== undefined) dToken = String(DOW_NAMES[dToken]);
        const weekday = Number(dToken);
        if (!Number.isInteger(weekday) || weekday < 0 || weekday > 7) {
          throw new Error(`День недели «${hash[1]}» вне границ 0..7 в «${dowF}».`);
        }
        nthWeekday.push({ weekday: weekday % 7, n: Number(hash[2]) });
        continue;
      }
      if (token === "L") {
        throw new Error("«L» поддерживается только в поле дня месяца.");
      }
      kept.push(token);
    }
    if (dowF.trim() !== "*") {
      dayOfWeek = kept.length > 0 ? expandField(kept.join(","), 0, 7, DOW_NAMES) : new Set();
      // 0 и 7 — оба воскресенье.
      const mapped = new Set<number>();
      for (const d of dayOfWeek) mapped.add(d % 7);
      dayOfWeek = mapped;
    }
  }

  return { raw, minute, hour, dayOfMonth, lastDom, month, dayOfWeek, nthWeekday };
}

function domMatches(p: { year: number; month: number; day: number }, spec: ParsedCron): boolean {
  const last = lastDayOfMonth(p.year, p.month);
  if (spec.dayOfMonth && spec.dayOfMonth.has(p.day)) return true;
  if (spec.lastDom && p.day === last) return true;
  return false;
}

function dowMatches(p: { year: number; month: number; day: number; weekday: number }, spec: ParsedCron): boolean {
  if (spec.dayOfWeek && spec.dayOfWeek.has(p.weekday)) return true;
  for (const { weekday, n } of spec.nthWeekday) {
    const dom = nthWeekdayOfMonth(p.year, p.month, weekday, n);
    if (dom === p.day) return true;
  }
  return false;
}

/** true, если cron срабатывает в указанную минуту (в системной или заданной tz). */
export function cronMatches(spec: ParsedCron, date: Date, timeZone?: string): boolean {
  const p = zonedParts(date, timeZone);
  if (!spec.minute.has(p.minute)) return false;
  if (!spec.hour.has(p.hour)) return false;
  if (!spec.month.has(p.month)) return false;
  const domAny = spec.dayOfMonth === null && !spec.lastDom;
  const dowAny = spec.dayOfWeek === null && spec.nthWeekday.length === 0;
  const dm = domMatches(p, spec);
  const dw = dowMatches(p, spec);
  // Vixie OR-семантика: обе группы ограничены — достаточно совпадения одной.
  if (domAny && dowAny) return true;
  if (domAny) return dw;
  if (dowAny) return dm;
  return dm || dw;
}

function iterateDay(p: { year: number; month: number; day: number }, delta: 1 | -1): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + delta));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function candidatesOnDay(
  spec: ParsedCron,
  y: number,
  m: number,
  d: number,
  notBefore: { hour: number; minute: number } | null,
  notAfter: { hour: number; minute: number } | null,
): Array<{ hour: number; minute: number }> {
  const hours = [...spec.hour].sort((a, b) => a - b);
  const minutes = [...spec.minute].sort((a, b) => a - b);
  const result: Array<{ hour: number; minute: number }> = [];
  for (const hour of hours) {
    for (const minute of minutes) {
      if (notBefore && notAfter) {
        if (hour < notBefore.hour || (hour === notBefore.hour && minute < notBefore.minute)) continue;
      }
      if (notAfter) {
        if (hour > notAfter.hour || (hour === notAfter.hour && minute > notAfter.minute)) continue;
      }
      result.push({ hour, minute });
    }
  }
  return result;
}

/**
 * Ближайший запуск после `from` (или null, если найти не удалось за 5 лет).
 * `timeZone` — IANA; по умолчанию системная.
 */
export function nextRun(expr: string, from: Date, timeZone?: string): Date | null {
  const spec = parseCron(expr);
  const base = from.getTime();
  const origin = zonedParts(from, timeZone);
  let cursor = { year: origin.year, month: origin.month, day: origin.day };
  // Не считать время дня на первом дне: только строго после from.
  let firstDay = true;
  for (let i = 0; i < MAX_SEARCH_DAYS; i += 1) {
    if (dayMatches(cursor.year, cursor.month, cursor.day, spec)) {
      const nb = firstDay
        ? { hour: origin.hour, minute: origin.minute + 1 } // строго позже минуты from
        : null;
      const candidates = candidatesOnDay(spec, cursor.year, cursor.month, cursor.day, nb, null);
      for (const cand of candidates) {
        const at = wallToUtc(cursor.year, cursor.month, cursor.day, cand.hour, cand.minute, timeZone);
        if (at && at.getTime() > base) return at;
      }
    }
    firstDay = false;
    cursor = iterateDay(cursor, 1);
  }
  return null;
}

/** Последний запуск не позже `from` (или null). */
export function prevRun(expr: string, from: Date, timeZone?: string): Date | null {
  const spec = parseCron(expr);
  const base = from.getTime();
  const origin = zonedParts(from, timeZone);
  let cursor = { year: origin.year, month: origin.month, day: origin.day };
  let firstDay = true;
  for (let i = 0; i < MAX_SEARCH_DAYS; i += 1) {
    if (dayMatches(cursor.year, cursor.month, cursor.day, spec)) {
      const na = firstDay
        ? { hour: origin.hour, minute: origin.minute } // включая текущую минуту
        : null;
      const candidates = candidatesOnDay(spec, cursor.year, cursor.month, cursor.day, null, na);
      for (let i2 = candidates.length - 1; i2 >= 0; i2 -= 1) {
        const cand = candidates[i2];
        const at = wallToUtc(cursor.year, cursor.month, cursor.day, cand.hour, cand.minute, timeZone);
        if (at && at.getTime() <= base) return at;
      }
    }
    firstDay = false;
    cursor = iterateDay(cursor, -1);
  }
  return null;
}

function dayMatches(y: number, m: number, d: number, spec: ParsedCron): boolean {
  if (!spec.month.has(m)) return false;
  const domAny = spec.dayOfMonth === null && !spec.lastDom;
  const date = new Date(Date.UTC(y, m - 1, d));
  const weekday = date.getUTCDay();
  const p = { year: y, month: m, day: d, weekday };
  if (domAny && spec.dayOfWeek === null && spec.nthWeekday.length === 0) return true;
  const dm = domMatches({ year: y, month: m, day: d }, spec);
  const dw = dowMatches(p, spec);
  const dowAny = spec.dayOfWeek === null && spec.nthWeekday.length === 0;
  if (domAny) return dw;
  if (dowAny) return dm;
  return dm || dw;
}

function dayStartUtc(y: number, m: number, d: number, timeZone?: string): Date {
  const d0 = wallToUtc(y, m, d, 0, 0, timeZone);
  return d0 ?? new Date(Date.UTC(y, m - 1, d, 0, 0));
}


// ---------------------------------------------------------------------------
// Окна запуска (notBefore/notAfter, «дд:мм» 24ч, можно через полночь).

const DAILY_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isValidDailyTime(value: string): boolean {
  return DAILY_TIME_RE.test((value || "").trim());
}

function dailyTimeToMinutes(value: string): number {
  const [h, m] = value.trim().split(":").map(Number);
  return h * 60 + m;
}

/** Проверяет пару окна; возвращает текст ошибки или null. */
export function validateLaunchWindow(notBefore?: string | null, notAfter?: string | null): string | null {
  if (notBefore === undefined && notAfter === undefined) return null;
  const nb = notBefore?.trim() ?? "";
  const na = notAfter?.trim() ?? "";
  if (!nb && !na) return null;
  if (nb && !isValidDailyTime(nb)) return `notBefore должен быть в формате HH:MM, не "${nb}".`;
  if (na && !isValidDailyTime(na)) return `notAfter должен быть в формате HH:MM, не "${na}".`;
  if (!nb || !na) return "notBefore и notAfter задаются вместе.";
  if (nb === na) return "notBefore и notAfter не могут совпадать (пустое окно).";
  return null;
}

function wallMinutes(date: Date, timeZone?: string): { minutes: number; seconds: number; ms: number } {
  const p = zonedParts(date, timeZone);
  return { minutes: p.hour * 60 + p.minute, seconds: p.second, ms: p.ms };
}

/** Мы внутри окна запуска? */
export function isInWindow(now: Date, notBefore?: string | null, notAfter?: string | null, timeZone?: string): boolean {
  if (validateLaunchWindow(notBefore, notAfter) !== null) return true; // невалидное окно не должно блокировать
  if (!notBefore?.trim() && !notAfter?.trim()) return true;
  const start = dailyTimeToMinutes(notBefore as string);
  const end = dailyTimeToMinutes(notAfter as string);
  const { minutes } = wallMinutes(now, timeZone);
  if (start < end) return minutes >= start && minutes < end;
  return minutes >= start || minutes < end; // через полночь
}

/** Сколько мс ждать до открытия окна (0 — уже открыто / окно не задано). */
export function windowDelayMs(now: Date, notBefore?: string | null, notAfter?: string | null, timeZone?: string): number {
  if (validateLaunchWindow(notBefore, notAfter) !== null) return 0;
  if (!notBefore?.trim() && !notAfter?.trim()) return 0;
  if (isInWindow(now, notBefore, notAfter, timeZone)) return 0;
  const start = dailyTimeToMinutes(notBefore as string);
  const { minutes, seconds, ms } = wallMinutes(now, timeZone);
  const deltaMin = (start - minutes + 1440) % 1440;
  const deltaSec = deltaMin * 60 - seconds;
  return Math.max(0, deltaSec * 1000 - ms);
}

// ---------------------------------------------------------------------------
// Дни недели и политика вне окна (Спринт 27).

/** 0=Вс..6=Сб. Пустой/полный список трактуется как «все дни» (undefined). */
export function normalizeActiveDays(days?: number[] | null): number[] | undefined {
  if (!Array.isArray(days)) return undefined;
  const unique = [
    ...new Set(
      days
        .map((value) => Math.floor(Number(value)))
        .filter((value) => Number.isInteger(value) && value >= 0 && value <= 6)
    ),
  ].sort((a, b) => a - b);
  if (unique.length === 0 || unique.length === 7) return undefined;
  return unique;
}

/** Разрешён ли день недели (в поясе задачи). */
export function isActiveDay(now: Date, days?: number[] | null, timeZone?: string): boolean {
  const normalized = normalizeActiveDays(days);
  if (!normalized) return true;
  return normalized.includes(zonedParts(now, timeZone).weekday);
}

export interface ActiveWindowOptions {
  notBefore?: string | null;
  notAfter?: string | null;
  days?: number[] | null;
  timeZone?: string;
}

export interface ActiveWindowState {
  /** Можно запускать сейчас. */
  active: boolean;
  /** Почему нельзя (человекочитаемо, для dry-run и логов). */
  reason?: string;
  /** Ближайшее открытие окна; null — не требуется или не найдено. */
  nextOpenAt: Date | null;
}

const WINDOW_SCAN_MINUTES = 8 * 24 * 60;

/** Ближайшая минута, когда и день, и окно разрешают запуск. */
export function nextWindowOpenAt(now: Date, options: ActiveWindowOptions): Date | null {
  const { notBefore, notAfter, timeZone } = options;
  const normalizedDays = normalizeActiveDays(options.days);
  const hasWindow = Boolean((notBefore || "").trim() || (notAfter || "").trim());
  if (!hasWindow && !normalizedDays) return null;
  const invalidWindow = validateLaunchWindow(notBefore, notAfter) !== null;
  for (let i = 1; i <= WINDOW_SCAN_MINUTES; i++) {
    const candidate = new Date(now.getTime() + i * 60_000);
    const dayOk =
      !normalizedDays || normalizedDays.includes(zonedParts(candidate, timeZone).weekday);
    const windowOk = invalidWindow || isInWindow(candidate, notBefore, notAfter, timeZone);
    if (dayOk && windowOk) return candidate;
  }
  return null;
}

/** Состояние окна с учётом дней недели. */
export function activeWindowState(now: Date, options: ActiveWindowOptions = {}): ActiveWindowState {
  const normalizedDays = normalizeActiveDays(options.days);
  const dayOk =
    !normalizedDays ||
    normalizedDays.includes(zonedParts(now, options.timeZone).weekday);
  const windowOk = isInWindow(now, options.notBefore, options.notAfter, options.timeZone);
  if (dayOk && windowOk) return { active: true, nextOpenAt: null };

  const reasons: string[] = [];
  if (!dayOk) {
    const names = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
    reasons.push(`день недели не разрешён (${(normalizedDays ?? []).map((d) => names[d]).join(", ")})`);
  }
  if (!windowOk) {
    reasons.push(`время вне окна ${options.notBefore}–${options.notAfter}`);
  }
  return {
    active: false,
    reason: reasons.join("; "),
    nextOpenAt: nextWindowOpenAt(now, options),
  };
}

/** Сколько мс до следующего разрешённого окна (0 — можно запускать). */
export function nextWindowOpenDelayMs(now: Date, options: ActiveWindowOptions = {}): number {
  const state = activeWindowState(now, options);
  if (state.active) return 0;
  return state.nextOpenAt ? Math.max(0, state.nextOpenAt.getTime() - now.getTime()) : 0;
}

// ---------------------------------------------------------------------------
// Проверка совместимости с schtasks (родной режим).

/**
 * true, если выражение умеет оформить Windows Task Scheduler «родными»
 * флагами (MINUTE/HOURLY/DAILY/WEEKLY) и парсится строгим конвертером.
 * Используется для выбора между флагами и минутным опросом.
 */
export function isNativeSchtasksExpr(expr: string): boolean {
  try {
    convertCronToSchTasks(normalizeCron(expr));
    return true;
  } catch {
    return false;
  }
}

/** Конвертер для родного режима; бросает Error для неподдерживаемых. */
export function convertForSchtasks(expr: string): CronConversion {
  return convertCronToSchTasks(normalizeCron(expr));
}

// ---------------------------------------------------------------------------
// Политика планирования одной задачи (общий код для Windows-бека и index.ts).

/** Аргументы schedule-gate, которые запекаются во враппер (cron/tz/окно/пернос). */
export interface ScheduleGateSpec {
  /**
   * Cron-выражение для повторной проверки внутри обёртки. Задаётся только в
   * poll-режиме: при родном триггере ОС уже сработала точно по cron, и повторная
   * проверка ломала бы ручной запуск и catch-up.
   */
  cron?: string;
  tz?: string;
  notBefore?: string;
  notAfter?: string;
  /** Разрешённые дни недели (0=Вс..6=Сб); пусто — все дни. */
  days?: number[];
  /** Поведение вне окна: skip — пропустить, run — выполнить всё равно. */
  windowPolicy?: "skip" | "run";
}

/**
 * true, если ОС-триггер не выражает расписание (чужой IANA-таймзона или
 * не конвертируемо в флаги schtasks) — нужен минутный опрос + gate.
 */
export function needsPollMode(expr: string, timezone?: string | null): boolean {
  const tz = (timezone || "").trim();
  if (tz && tz !== systemTimeZone()) return true;
  return !isNativeSchtasksExpr(expr);
}

/**
 * Аргументы schedule-gate для враппера, либо undefined — если врапперу гейт
 * не нужен (нативный cron + системный таймзона + окно не задано).
 * Окно запуска всегда требует gate (перенос реализует враппер).
 */
export function buildScheduleGate(
  expr: string,
  timezone?: string | null,
  notBefore?: string,
  notAfter?: string,
  days?: number[] | null,
  windowPolicy?: string | null
): ScheduleGateSpec | undefined {
  const tz = (timezone || "").trim() || undefined;
  const poll = needsPollMode(expr, tz);
  const normalizedDays = normalizeActiveDays(days);
  const policy = windowPolicy === "skip" || windowPolicy === "run" ? windowPolicy : undefined;
  if (!poll && !(notBefore && notAfter) && !normalizedDays) return undefined;
  // cron проверяем только в poll-режиме (см. комментарий у ScheduleGateSpec).
  return {
    ...(poll ? { cron: expr } : {}),
    tz,
    notBefore,
    notAfter,
    ...(normalizedDays ? { days: normalizedDays } : {}),
    ...(policy ? { windowPolicy: policy } : {}),
  };
}
