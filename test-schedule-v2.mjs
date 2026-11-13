/**
 * Тесты Спринта 19: планирование 2.0.
 * Запуск: node test-schedule-v2.mjs (после npm run build).
 * Чистые функции + CLI-шлюз; БД и планировщик ОС не нужны.
 */
import { spawnSync } from "node:child_process";
import {
  buildScheduleGate,
  cronMatches,
  isInWindow,
  isNativeSchtasksExpr,
  isValidDailyTime,
  isValidIanaTimeZone,
  needsPollMode,
  nextRun,
  normalizeCron,
  parseCron,
  prevRun,
  systemTimeZone,
  validateLaunchWindow,
  windowDelayMs,
} from "./dist/core/schedule-v2.js";

const results = [];
function check(name, cond) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? "OK  " : "FAIL"} ${name}`);
}

function throws(fn) {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

const iso = (date) => (date ? date.toISOString() : null);

// --- 1. Парсер: базовые и расширенные формы -------------------------------
check("parseCron принимает '* * * * *'", !!parseCron("* * * * *"));
check("parseCron принимает '*/15 * * * *'", !!parseCron("*/15 * * * *"));
check("normalizeCron '@every 15m' → '*/15 * * * *'", normalizeCron("@every 15m") === "*/15 * * * *");
check("normalizeCron '@every 2h' → '0 */2 * * *'", normalizeCron("@every 2h") === "0 */2 * * *");
check("normalizeCron '@every 1d' → '0 0 */1 * *'", normalizeCron("@every 1d") === "0 0 */1 * *");
check("'@every 0m' отклоняется", throws(() => parseCron("@every 0m")));
check("минута 61 отклоняется", throws(() => parseCron("61 * * * *")));
check("имена дней 'MON-FRI' принимаются", parseCron("0 9 * * MON-FRI").dayOfWeek !== null);
check("'L' в дне месяца → lastDom", parseCron("0 0 L * *").lastDom === true);
check("'15,L' — список с L", parseCron("0 0 15,L * *").lastDom === true);
const thirdFri = parseCron("0 0 * * FRI#3");
check("'FRI#3' → третий день недели", thirdFri.nthWeekday.length === 1 && thirdFri.nthWeekday[0].weekday === 5 && thirdFri.nthWeekday[0].n === 3);
check("'0#1' — воскресенье", parseCron("0 0 * * 0#1").nthWeekday[0].weekday === 0);
check("'FRI#6' отклоняется", throws(() => parseCron("0 0 * * FRI#6")));

// --- 2. nextRun / prevRun -------------------------------------------------
const utc = "UTC";
check(
  "nextRun '0 9 * * *' UTC с 08:30 → 09:00",
  iso(nextRun("0 9 * * *", new Date("2026-06-15T08:30:00Z"), utc)) === "2026-06-15T09:00:00.000Z"
);
check(
  "nextRun строго после текущей минуты (с 09:00 → завтра)",
  iso(nextRun("0 9 * * *", new Date("2026-06-15T09:00:00Z"), utc)) === "2026-06-16T09:00:00.000Z"
);
check(
  "prevRun '0 9 * * *' с 09:00 → та же минута",
  iso(prevRun("0 9 * * *", new Date("2026-06-15T09:00:00Z"), utc)) === "2026-06-15T09:00:00.000Z"
);
check(
  "L: последний день февраля 2026",
  iso(nextRun("0 0 L * *", new Date("2026-02-01T00:00:00Z"), utc)) === "2026-02-28T00:00:00.000Z"
);
check(
  "L: после 28 февраля → 31 марта",
  iso(nextRun("0 0 L * *", new Date("2026-02-28T00:00:00Z"), utc)) === "2026-03-31T00:00:00.000Z"
);
check(
  "FRI#3: третий паток июня 2026 — 19-е",
  iso(nextRun("0 9 * * FRI#3", new Date("2026-06-01T00:00:00Z"), utc)) === "2026-06-19T09:00:00.000Z"
);
check(
  "@every 15m: с 10:07 → 10:15",
  iso(nextRun("@every 15m", new Date("2026-06-15T10:07:00Z"), utc)) === "2026-06-15T10:15:00.000Z"
);
check(
  "dom+dow: OR-семантика (1-е число или понедельник)",
  iso(nextRun("0 0 1 * MON", new Date("2026-06-02T00:00:00Z"), utc)) === "2026-06-08T00:00:00.000Z"
);

// --- 3. DST ---------------------------------------------------------------
check(
  "DST Berlin: несуществующее 29.03.2026 02:30 пропускается",
  iso(nextRun("30 2 * * *", new Date("2026-03-28T12:00:00Z"), "Europe/Berlin")) === "2026-03-30T00:30:00.000Z"
);
check(
  "DST Berlin: 25.10.2026 02:30 — первое вхождение (CEST)",
  iso(nextRun("30 2 * * *", new Date("2026-10-24T12:00:00Z"), "Europe/Berlin")) === "2026-10-25T00:30:00.000Z"
);
check(
  "Смена суток: 23:59 15.06 → 00:00 16.06 UTC",
  iso(nextRun("0 0 * * *", new Date("2026-06-15T23:59:00Z"), utc)) === "2026-06-16T00:00:00.000Z"
);
check(
  "cronMatches учитывает пояс (09:00 Москва = 06:00 UTC)",
  cronMatches(parseCron("0 9 * * *"), new Date("2026-06-15T06:00:00Z"), "Europe/Moscow") === true
);

// --- 4. Окна запуска ------------------------------------------------------
check("isValidDailyTime '22:00'", isValidDailyTime("22:00"));
check("isValidDailyTime '24:00' отклоняется", !isValidDailyTime("24:00"));
check("окно 22:00–06:00: 23:00 внутри", isInWindow(new Date("2026-06-15T23:00:00Z"), "22:00", "06:00", utc));
check("окно 22:00–06:00: 12:00 снаружи", !isInWindow(new Date("2026-06-15T12:00:00Z"), "22:00", "06:00", utc));
check("окно 22:00–06:00: 05:59 внутри", isInWindow(new Date("2026-06-15T05:59:00Z"), "22:00", "06:00", utc));
check(
  "windowDelayMs с 12:00 до 22:00 = 10 часов",
  windowDelayMs(new Date("2026-06-15T12:00:00Z"), "22:00", "06:00", utc) === 10 * 60 * 60 * 1000
);
check(
  "windowDelayMs внутри окна = 0",
  windowDelayMs(new Date("2026-06-15T23:00:00Z"), "22:00", "06:00", utc) === 0
);
check("validateLaunchWindow: пара валидна", validateLaunchWindow("22:00", "06:00") === null);
check("validateLaunchWindow: без пары — ошибка", typeof validateLaunchWindow("22:00", undefined) === "string");
check("validateLaunchWindow: равные границы — ошибка", typeof validateLaunchWindow("10:00", "10:00") === "string");

// --- 5. Часовые пояса и режим опроса --------------------------------------
check("isValidIanaTimeZone 'Europe/Moscow'", isValidIanaTimeZone("Europe/Moscow"));
check("isValidIanaTimeZone 'Mars/Base' отклоняется", !isValidIanaTimeZone("Mars/Base"));
check("isNativeSchtasksExpr '*/15 * * * *'", isNativeSchtasksExpr("*/15 * * * *"));
check("isNativeSchtasksExpr '0 0 L * *' — нет", !isNativeSchtasksExpr("0 0 L * *"));
check("needsPollMode для 'L'", needsPollMode("0 0 L * *"));
const systemZone = systemTimeZone();
check("needsPollMode для чужой IANA-зоны", needsPollMode("0 9 * * *", "Pacific/Kiritimati"));
check("buildScheduleGate: native без окна → undefined", buildScheduleGate("0 9 * * *") === undefined);
const windowGate = buildScheduleGate("0 9 * * *", undefined, "22:00", "06:00");
check("buildScheduleGate: окно → шлюз без cron", !!windowGate && !windowGate.cron && windowGate.notBefore === "22:00");
const pollGate = buildScheduleGate("0 0 L * *", "Europe/Berlin", undefined, undefined);
check("buildScheduleGate: poll-режим → шлюз с cron", !!pollGate && pollGate.cron === "0 0 L * *");
check("gate-шлюз содержит tz только при poll-режиме", !!pollGate && pollGate.tz === "Europe/Berlin");

// --- 6. CLI schedule-gate -------------------------------------------------
function runGate(args) {
  return spawnSync(process.execPath, ["dist/core/schedule-gate.js", ...args], {
    encoding: "utf8",
  });
}
check(
  "gate: cron не совпал → exit 3",
  runGate(["--cron", "0 9 * * *", "--tz", "UTC", "--now", "2026-06-15T10:00:00Z"]).status === 3
);
check(
  "gate: cron совпал → exit 0",
  runGate(["--cron", "0 9 * * *", "--tz", "UTC", "--now", "2026-06-15T09:00:00Z"]).status === 0
);
check(
  "gate: расширенный cron 'L' совпал → exit 0",
  runGate(["--cron", "0 0 L * *", "--tz", "UTC", "--now", "2026-02-28T00:00:00Z"]).status === 0
);
check(
  "gate: без --cron, внутри окна → exit 0",
  runGate(["--not-before", "22:00", "--not-after", "06:00", "--tz", "UTC", "--now", "2026-06-15T23:00:00Z"]).status === 0
);
check(
  "gate: некорректный --now → exit 1",
  runGate(["--now", "не-дата"]).status === 1
);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} OK`);
if (failed.length > 0) {
  console.error(`Провалено: ${failed.map((r) => r.name).join("; ")}`);
  process.exit(1);
}
