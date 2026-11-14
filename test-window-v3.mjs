/**
 * Тесты Спринта 27: временные окна и дни недели (src/core/schedule-v2.ts + schedule-gate).
 * Запуск: node test-window-v3.mjs (после npm run build).
 */
import { spawnSync } from "node:child_process";
import {
  activeWindowState,
  nextWindowOpenDelayMs,
  normalizeActiveDays,
  isActiveDay,
  buildScheduleGate,
} from "./dist/core/schedule-v2.js";

const results = [];
function check(name, cond) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? "OK  " : "FAIL"} ${name}`);
}

const utc = "UTC";

// --- 1. normalizeActiveDays -------------------------------------------------
check("normalizeActiveDays undefined → undefined", normalizeActiveDays(undefined) === undefined);
check("normalizeActiveDays [] → undefined", normalizeActiveDays([]) === undefined);
check("normalizeActiveDays [0,1,2,3,4,5,6] → undefined (все дни)", normalizeActiveDays([0, 1, 2, 3, 4, 5, 6]) === undefined);
check("normalizeActiveDays [1,2,3,4,5] → [1,2,3,4,5]", JSON.stringify(normalizeActiveDays([1, 2, 3, 4, 5])) === "[1,2,3,4,5]");
check("normalizeActiveDays сортирует и убирает дубли", JSON.stringify(normalizeActiveDays([5, 3, 3, 1])) === "[1,3,5]");
check("normalizeActiveDays [-1, 7] отфильтрованы → [] → undefined", normalizeActiveDays([-1, 7]) === undefined);

// --- 2. isActiveDay ---------------------------------------------------------
// Вс 2026-11-15 (0), Пн 2026-11-16 (1), Пт 2026-11-20 (5), Сб 2026-11-21 (6).
const sun = new Date("2026-11-15T12:00:00Z");
const mon = new Date("2026-11-16T12:00:00Z");
const fri = new Date("2026-11-20T12:00:00Z");
const sat = new Date("2026-11-21T12:00:00Z");

check("isActiveDay без дней → true", isActiveDay(mon, undefined, utc));
check("isActiveDay [1,2,3,4,5], Пн → true", isActiveDay(mon, [1, 2, 3, 4, 5], utc));
check("isActiveDay [1,2,3,4,5], Вс → false", !isActiveDay(sun, [1, 2, 3, 4, 5], utc));
check("isActiveDay [1,2,3,4,5], Пт → true", isActiveDay(fri, [1, 2, 3, 4, 5], utc));
check("isActiveDay [1,2,3,4,5], Сб → false", !isActiveDay(sat, [1, 2, 3, 4, 5], utc));

// --- 3. activeWindowState ---------------------------------------------------
// Внутри окна 09:00–19:00, будние дни.
check("activeWindowState внутри окна, будний → active", activeWindowState(mon, { notBefore: "09:00", notAfter: "19:00", days: [1, 2, 3, 4, 5], timeZone: utc }).active === true);
check("activeWindowState до окна → !active, reason", activeWindowState(new Date("2026-11-16T08:00:00Z"), { notBefore: "09:00", notAfter: "19:00", days: [1, 2, 3, 4, 5], timeZone: utc }).active === false);
// Вне окна по времени (08:00 < 09:00).
const earlyMon = new Date("2026-11-16T08:00:00Z");
const s1 = activeWindowState(earlyMon, { notBefore: "09:00", notAfter: "19:00", days: [1, 2, 3, 4, 5], timeZone: utc });
check("activeWindowState 08:00 в будень → !active", s1.active === false);
check("activeWindowState reason не пуст", typeof s1.reason === "string" && s1.reason.length > 0);
check("activeWindowState nextOpenAt установлен", s1.nextOpenAt !== null);
// В выходной день (Сб) с днями [1..5].
const s2 = activeWindowState(sat, { notBefore: "09:00", notAfter: "19:00", days: [1, 2, 3, 4, 5], timeZone: utc });
check("activeWindowState Сб без разрешённых дней → !active", s2.active === false);
check("activeWindowState reason про день недели", s2.reason.includes("день недели") || s2.reason.includes("день"));
// Через полночь: окно 22:00–06:00, время 03:00 → внутри.
const night = new Date("2026-11-16T03:00:00Z");
check("activeWindowState 22:00–06:00, 03:00 → active", activeWindowState(night, { notBefore: "22:00", notAfter: "06:00", timeZone: utc }).active === true);
// Вне окна: 12:00 при 22:00–06:00.
const s3 = activeWindowState(mon, { notBefore: "22:00", notAfter: "06:00", timeZone: utc });
check("activeWindowState 22:00–06:00, 12:00 → !active", s3.active === false);

// --- 4. nextWindowOpenDelayMs -----------------------------------------------
check("nextWindowOpenDelayMs внутри окна = 0", nextWindowOpenDelayMs(mon, { notBefore: "09:00", notAfter: "19:00", days: [1, 2, 3, 4, 5], timeZone: utc }) === 0);
// До окна: 08:00 в Пн, окно 09:00–19:00 → 1 час.
const delay = nextWindowOpenDelayMs(earlyMon, { notBefore: "09:00", notAfter: "19:00", days: [1, 2, 3, 4, 5], timeZone: utc });
check("nextWindowOpenDelayMs 08:00 → 09:00 = 3600000", delay === 60 * 60 * 1000);
// Без окна и дней → 0.
check("nextWindowOpenDelayMs без ограничений = 0", nextWindowOpenDelayMs(mon, {}) === 0);

// --- 5. buildScheduleGate с днями и политикой -------------------------------
const gateDays = buildScheduleGate("0 9 * * *", utc, undefined, undefined, [1, 2, 3, 4, 5], undefined);
check("buildScheduleGate с днями → days в спеке", gateDays !== undefined && JSON.stringify(gateDays.days) === "[1,2,3,4,5]");
const gateSkip = buildScheduleGate("0 9 * * *", utc, "09:00", "19:00", [1, 2, 3, 4, 5], "skip");
check("buildScheduleGate windowPolicy=skip", gateSkip !== undefined && gateSkip.windowPolicy === "skip");
const gateRun = buildScheduleGate("0 9 * * *", utc, "09:00", "19:00", [1, 2, 3, 4, 5], "run");
check("buildScheduleGate windowPolicy=run", gateRun !== undefined && gateRun.windowPolicy === "run");
// postpone по умолчанию не сереализуется.
const gatePost = buildScheduleGate("0 9 * * *", utc, "09:00", "19:00", [1, 2, 3, 4, 5], "postpone");
check("buildScheduleGate windowPolicy=postpone → не сереализуется", gatePost !== undefined && gatePost.windowPolicy === undefined);
// без дней и окна → undefined (не poll-режим).
check("buildScheduleGate без дней/окна → undefined", buildScheduleGate("0 9 * * *") === undefined);

// --- 6. CLI schedule-gate: --days и --window-policy -------------------------
function runGate(args) {
  return spawnSync(process.execPath, ["dist/core/schedule-gate.js", ...args], { encoding: "utf8" });
}

// В будень (Пн) внутри окна → exit 0.
check("gate: будень внутри окна → exit 0", runGate(["--cron", "0 9 * * *", "--tz", "UTC", "--now", "2026-11-16T09:00:00Z", "--days", "1,2,3,4,5"]).status === 0);
// В выходной (Сб) с днями [1..5] → exit 3 (день не разрешён).
check("gate: выходной с --days [1..5] → exit 3", runGate(["--cron", "0 9 * * *", "--tz", "UTC", "--now", "2026-11-21T09:00:00Z", "--days", "1,2,3,4,5"]).status === 3);
// Вне окна, policy=skip → exit 3.
check("gate: вне окна, --window-policy skip → exit 3", runGate(["--cron", "0 9 * * *", "--tz", "UTC", "--now", "2026-11-16T08:00:00Z", "--days", "1,2,3,4,5", "--not-before", "09:00", "--not-after", "19:00", "--window-policy", "skip"]).status === 3);
// Вне окна, policy=run → exit 0 (выполнить всё равно).
check("gate: вне окна, --window-policy run → exit 0", runGate(["--cron", "0 8 * * *", "--tz", "UTC", "--now", "2026-11-16T08:00:00Z", "--days", "1,2,3,4,5", "--not-before", "09:00", "--not-after", "19:00", "--window-policy", "run"]).status === 0);
// cron не совпал → exit 3 независимо от дней.
check("gate: cron не совпал, дни совпадают → exit 3", runGate(["--cron", "0 9 * * *", "--tz", "UTC", "--now", "2026-11-16T10:00:00Z", "--days", "1,2,3,4,5"]).status === 3);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} OK`);
if (failed.length > 0) {
  console.error(`Провалено: ${failed.map((r) => r.name).join("; ")}`);
  process.exit(1);
}
