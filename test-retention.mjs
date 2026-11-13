/**
 * Тесты Спринта 18: ретеншн истории.
 * Запуск: node test-retention.mjs (после npm run build).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ws-scheduler-retention-"));
process.env.APPDATA = tempRoot;
process.env.OPENCODE_SCHEDULER_HOME = path.join(tempRoot, "opencode", "windows-scheduler");

const { initDb, closeDb } = await import("./dist/db/index.js");
const {
  recordRun,
  startRun,
  countHistory,
  pruneHistory,
  vacuumHistory,
  getHistory,
} = await import("./dist/db/history-repo.js");
const { getTotals } = await import("./dist/db/metrics-repo.js");
const { loadSettings, saveSettings, DEFAULT_MAX_RECORDS, DEFAULT_RETENTION_DAYS } =
  await import("./dist/settings.js");
const { runHistoryRetention, maybeRunHistoryRetention, CLEANUP_INTERVAL_MS } =
  await import("./dist/core/retention.js");

const results = [];
function check(name, cond) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? "OK  " : "FAIL"} ${name}`);
}

const DAY = 24 * 60 * 60 * 1000;
const now = new Date("2026-06-15T12:00:00.000Z");

/** Запись завершённого запуска с заданной давностью (в днях). */
function seedRun(task, daysAgo, status = "success", cost = 0.01) {
  const startedAt = new Date(now.getTime() - daysAgo * DAY).toISOString();
  recordRun(
    task,
    status,
    startedAt,
    1000,
    status === "success" ? null : "boom",
    undefined,
    100,
    cost,
    "test/model",
    "skipped",
    "skipped",
    startedAt
  );
}

initDb();

try {
  // Пустая БД: очищать нечего, ничего не падает.
  const emptyPrune = pruneHistory({ retentionDays: 7 });
  check(
    "pruneHistory на пустой истории ничего не удаляет",
    emptyPrune.deleted === 0 && emptyPrune.kept === 0
  );

  // 5 свежих и 5 старых записей.
  for (let i = 0; i < 5; i += 1) seedRun("fresh", i, "success");
  for (let i = 0; i < 5; i += 1) seedRun("old", 40 + i, "success");
  const before = countHistory();
  check("подготовлено 10 записей", before === 10);

  const byAge = pruneHistory({ retentionDays: 30, now });
  check(
    "pruneHistory по возрасту удаляет только старые записи",
    byAge.deletedByAge === 5 && byAge.kept === 5 && byAge.deleted === 5
  );
  check(
    "после очистки по возрасту остались только свежие задачи",
    getHistory(null, 100).every((r) => r.taskName === "fresh")
  );
  check(
    "cutoff посчитан от переданного момента",
    typeof byAge.cutoff === "string" &&
      Math.abs(new Date(byAge.cutoff).getTime() - (now.getTime() - 30 * DAY)) < 5000
  );

  // Незавершённый запуск не удаляется ни по возрасту, ни по количеству.
  const runningId = startRun(
    "stuck",
    new Date(now.getTime() - 90 * DAY).toISOString()
  );
  const runningPrune = pruneHistory({ retentionDays: 1, maxRecords: 1, now });
  check(
    "незавершённый запуск не удаляется очисткой",
    getHistory("stuck", 10).some((r) => r.id === runningId) && runningPrune.kept >= 1
  );

  // Метрики — агрегаты: очистка истории их не сбрасывает.
  const totalsBefore = getTotals();
  pruneHistory({ maxRecords: 2 });
  const totalsAfter = getTotals();
  check(
    "очистка истории не меняет агрегированные метрики",
    totalsAfter.total === totalsBefore.total &&
      Math.abs(totalsAfter.costUsd - totalsBefore.costUsd) < 1e-9
  );

  // Ограничение по количеству: остаются самые новые (running не считается).
  for (let i = 0; i < 6; i += 1) seedRun(`count-${i}`, i * 0.01);
  const byCount = pruneHistory({ maxRecords: 3 });
  const remaining = getHistory(null, 100);
  check(
    "pruneHistory по maxRecords оставляет ровно N записей",
    remaining.filter((r) => r.status !== "running").length === 3 && byCount.kept >= 3
  );
  check(
    "maxRecords сохраняет самые новые записи",
    remaining.some((r) => r.taskName === "count-0")
  );

  // Оба лимита одновременно.
  for (let i = 0; i < 4; i += 1) seedRun("combined-old", 100 + i);
  for (let i = 0; i < 4; i += 1) seedRun("combined-new", i * 0.1);
  const combined = pruneHistory({ retentionDays: 10, maxRecords: 2, now });
  const finishedLeft = getHistory(null, 100).filter((r) => r.status !== "running").length;
  check(
    "оба лимита применяются вместе",
    combined.deletedByAge === 4 && finishedLeft === 2 && combined.deleted >= 4
  );

  check("vacuumHistory не бросает исключение", vacuumHistory() === true);

  // runHistoryRetention: настройки по умолчанию (30 дней / 5000 записей).
  const defaults = await loadSettings();
  check(
    "настройки по умолчанию содержат ретеншн 30 дней / 5000 записей",
    defaults.history.retentionDays === DEFAULT_RETENTION_DAYS &&
      defaults.history.maxRecords === DEFAULT_MAX_RECORDS &&
      defaults.history.lastCleanupAt === null
  );

  // Переопределения cleanup_history сохраняются в settings.json.
  for (let i = 0; i < 3; i += 1) seedRun("cfg", 50 + i);
  const report = await runHistoryRetention({ retentionDays: 7, maxRecords: 1000 });
  const saved = await loadSettings();
  check(
    "runHistoryRetention удаляет по переданным лимитам",
    report.deleted >= 3 && report.retentionDays === 7 && report.maxRecords === 1000
  );
  check(
    "runHistoryRetention сохраняет лимиты и отметку времени в settings.json",
    saved.history.retentionDays === 7 &&
      saved.history.maxRecords === 1000 &&
      Boolean(saved.history.lastCleanupAt) &&
      saved.history.lastCleanupDeleted === report.deleted
  );
  check("runHistoryRetention возвращает kept = countHistory()", report.kept === countHistory());

  // Ретеншн выключен: оба лимита 0 -> skipped, ничего не удаляется.
  await saveSettings({ history: { retentionDays: 0, maxRecords: 0, lastCleanupAt: null, lastCleanupDeleted: 0 } });
  const skippedReport = await runHistoryRetention();
  check(
    "при нулевых лимитах очистка пропускается с объяснением",
    Boolean(skippedReport.skipped) && skippedReport.deleted === 0
  );

  // Автоочистка: не чаще раза в сутки.
  await saveSettings({ history: { retentionDays: 1, maxRecords: 0, lastCleanupAt: new Date().toISOString(), lastCleanupDeleted: 0 } });
  const throttled = await maybeRunHistoryRetention();
  check("maybeRunHistoryRetention уважает суточный интервал", throttled === undefined);

  const stale = new Date(Date.now() - CLEANUP_INTERVAL_MS - 60000).toISOString();
  await saveSettings({ history: { retentionDays: 1, maxRecords: 0, lastCleanupAt: stale, lastCleanupDeleted: 0 } });
  const rerun = await maybeRunHistoryRetention();
  check(
    "maybeRunHistoryRetention запускается, если прошло больше суток",
    rerun !== undefined && rerun.ranAt != null
  );

  const forced = await maybeRunHistoryRetention(true);
  check("maybeRunHistoryRetention(force) игнорирует интервал", forced !== undefined);
} finally {
  closeDb();
}

const failed = results.filter((r) => !r.ok);
console.log(`\nRetention: ${results.length - failed.length}/${results.length} проверок пройдено.`);
process.exit(failed.length > 0 ? 1 : 0);
