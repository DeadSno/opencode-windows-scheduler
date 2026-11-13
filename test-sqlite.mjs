// Тесты Спринта 12: миграция JSON → SQLite, репозитории, транзакции,
// crash recovery и экспорт .db-файла.
//
// Запуск: node test-sqlite.mjs (после npm run build).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sched-sqlite-test-"));
process.env.APPDATA = tempRoot;
process.env.OPENCODE_SCHEDULER_HOME = path.join(tempRoot, "opencode", "windows-scheduler");

const pluginDir = path.join(tempRoot, "opencode", "windows-scheduler");
fs.mkdirSync(pluginDir, { recursive: true });

const tasksJson = [
  {
    name: "Daily Report",
    schedule: "0 9 * * *",
    prompt: "Сделай отчёт",
    createdAt: "2026-01-01T00:00:00.000Z",
    workdir: "C:\\projects\\report",
  },
  {
    name: "Nightly Build",
    schedule: "0 3 * * *",
    prompt: "Собери проект",
    createdAt: "2026-01-02T00:00:00.000Z",
  },
];
const historyJson = [
  {
    taskName: "Daily Report",
    status: "success",
    startedAt: "2026-02-01T09:00:00.000Z",
    finishedAt: "2026-02-01T09:01:00.000Z",
    durationMs: 60000,
    tokens: 100,
    costUsd: 0.01,
    model: "test/model",
    preFlightStatus: "success",
    postFlightStatus: "skipped",
  },
  {
    taskName: "Nightly Build",
    status: "error",
    startedAt: "2026-02-01T03:00:00.000Z",
    finishedAt: "2026-02-01T03:00:30.000Z",
    durationMs: 30000,
    error: "exit code 1",
    tokens: 50,
    costUsd: 0.005,
  },
  {
    taskName: "Daily Report",
    status: "timeout",
    startedAt: "2026-02-02T09:00:00.000Z",
    finishedAt: "2026-02-02T09:05:00.000Z",
    durationMs: 300000,
    error: "timeout",
    tokens: 10,
    costUsd: 0.001,
  },
];
const metricsJson = {
  total: 5,
  success: 2,
  error: 3,
  tokens: 1000,
  costUsd: 0.5,
};
const templatesJson = [
  { id: "tpl-1", name: "Отчёт", prompt: "Сделай отчёт", schedule: "0 9 * * *" },
];

fs.writeFileSync(path.join(pluginDir, "tasks.json"), JSON.stringify(tasksJson, null, 2));
fs.writeFileSync(path.join(pluginDir, "history.json"), JSON.stringify(historyJson, null, 2));
fs.writeFileSync(path.join(pluginDir, "metrics.json"), JSON.stringify(metricsJson, null, 2));
fs.writeFileSync(path.join(pluginDir, "templates.json"), JSON.stringify(templatesJson, null, 2));

const assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL: " + msg);
    process.exitCode = 1;
  } else {
    console.log("OK: " + msg);
  }
};

const { initDb, closeDb, getDb, getDbFile, isDatabaseEmpty, getDbStatus } =
  await import("./dist/db/index.js");
const { migrateJsonToDb } = await import("./dist/db/migrate.js");
const { recoverInterruptedRuns } = await import("./dist/db/recovery.js");
const tasksRepo = await import("./dist/db/tasks-repo.js");
const historyRepo = await import("./dist/db/history-repo.js");
const metricsRepo = await import("./dist/db/metrics-repo.js");
const templatesRepo = await import("./dist/db/templates-repo.js");

const dbPath = getDbFile();
initDb();

// --- 1. Миграция -------------------------------------------------------
assert(isDatabaseEmpty(), "до миграции БД пуста");
const migration = await migrateJsonToDb();
assert(migration.migrated, "миграция выполнена");
assert(migration.tasks === 2, "перенесено 2 задачи (получено " + migration.tasks + ")");
assert(migration.history === 3, "перенесено 3 записи истории (получено " + migration.history + ")");
assert(migration.templates === 1, "перенесён 1 шаблон (получено " + migration.templates + ")");
assert(
  fs.existsSync(path.join(pluginDir, "tasks.json.bak")) &&
    !fs.existsSync(path.join(pluginDir, "tasks.json")),
  "tasks.json переименован в tasks.json.bak"
);
assert(fs.existsSync(path.join(pluginDir, "history.json.bak")), "history.json переименован в .bak");
assert(fs.existsSync(path.join(pluginDir, "templates.json.bak")), "templates.json переименован в .bak");

const again = await migrateJsonToDb();
assert(!again.migrated && again.tasks === 0, "повторная миграция не выполняется (БД не пуста)");

// --- 2. Задачи: чтение/запись/удаление ---------------------------------
const tasks = tasksRepo.listTasks();
assert(tasks.length === 2, "listTasks вернул 2 задачи");
const report = tasksRepo.getTask("daily report");
assert(Boolean(report), "getTask ищет без учёта регистра");
assert(report.workingDirectory === "C:\\projects\\report", "workdir мигрирован в workingDirectory");
assert(!("workdir" in report), "старое поле workdir удалено");
assert(report.createdAt === "2026-01-01T00:00:00.000Z", "createdAt сохранён при миграции");

const beforeCreatedAt = report.createdAt;
tasksRepo.saveTask({ ...report, prompt: "Обновлённый промпт" });
const updated = tasksRepo.getTask("DAILY REPORT");
assert(updated.prompt === "Обновлённый промпт", "saveTask обновляет существующую задачу");
assert(updated.createdAt === beforeCreatedAt, "createdAt не перезаписывается при обновлении");

tasksRepo.saveTask({ name: "One-off", schedule: "0 0 * * *", prompt: "Разово" });
assert(tasksRepo.countTasks() === 3, "saveTask добавляет новую задачу");
assert(tasksRepo.deleteTask("one-off"), "deleteTask находит имя без учёта регистра");
assert(tasksRepo.countTasks() === 2, "deleteTask удаляет задачу");

// --- 3. История + метрики в транзакции ---------------------------------
historyRepo.recordRun(
  "Daily Report",
  "success",
  "2026-03-01T09:00:00.000Z",
  1200,
  null,
  "Nightly Build",
  200,
  0.02,
  "test/model",
  "success",
  "success"
);
const runHistory = historyRepo.getHistory("daily report", 10);
assert(runHistory.length === 3, "recordRun добавил запись в историю");
assert(runHistory[0].nextTask === "Nightly Build", "nextTask сохраняется");
assert(runHistory[0].tokens === 200 && runHistory[0].costUsd === 0.02, "токены и стоимость сохраняются");

const reportMetrics = metricsRepo.getMetrics("Daily Report");
assert(reportMetrics.total === 3, "метрики: 3 запуска Daily Report");
assert(reportMetrics.success === 2 && reportMetrics.error === 1, "метрики: success/error учтены");
assert(reportMetrics.tokens === 310, "метрики: токены суммируются (100+10+200)");

const totals = metricsRepo.getTotals();
assert(totals.total === 6, "общие метрики: 5 из metrics.json + 1 новый запуск");
assert(totals.success === 3 && totals.error === 3, "хвост metrics.json добран служебной строкой");
assert(totals.tokens === 1200, "токены: 1000 legacy + 200");
assert(Math.abs(totals.costUsd - 0.52) < 1e-9, "стоимость: 0.5 legacy + 0.02");

// Частичный запуск учитывается отдельно и не попадает в error.
historyRepo.recordRun(
  "Partial Task",
  "partial",
  "2026-03-02T09:00:00.000Z",
  500,
  null
);
const partialMetrics = metricsRepo.getMetrics("Partial Task");
assert(
  partialMetrics.total === 1 && partialMetrics.partial === 1 && partialMetrics.error === 0,
  "метрики: partial хранится отдельно от error"
);
const totalsWithPartial = metricsRepo.getTotals();
assert(
  totalsWithPartial.total === 7 && totalsWithPartial.partial === 1 && totalsWithPartial.error === 3,
  "общие метрики: partial увеличивает total, но не error"
);

// --- 4. Crash recovery --------------------------------------------------
const unfinishedId = historyRepo.startRun("Nightly Build", new Date(Date.now() - 5000).toISOString());
assert(
  historyRepo.getHistory("Nightly Build", 10).some((r) => r.id === unfinishedId && r.finishedAt === null),
  "startRun создаёт незавершённую запись (finished_at IS NULL)"
);
assert(recoverInterruptedRuns() === 1, "recovery нашёл 1 незавершённую запись");
const recovered = historyRepo.getHistory("Nightly Build", 10).find((r) => r.id === unfinishedId);
assert(recovered.status === "error", "незавершённая запись помечена как error");
assert(
  recovered.error === "Прервано (сбой/перезагрузка)",
  "запись содержит причину «Прервано (сбой/перезагрузка)»"
);
assert(typeof recovered.durationMs === "number" && recovered.durationMs >= 0, "duration_ms рассчитан");
assert(recoverInterruptedRuns() === 0, "повторный recovery ничего не меняет");

// --- 5. Миграция старой схемы metrics без partial ----------------------
// Проверяем, что applySchema() добавляет колонку в уже существующую БД,
// а накопленные счётчики при этом не теряются.
const legacyDbPath = path.join(tempRoot, "legacy-metrics.db");
const { DatabaseSync } = await import("node:sqlite");
const legacyDb = new DatabaseSync(legacyDbPath);
legacyDb.exec(`
  CREATE TABLE metrics (
    task_name TEXT PRIMARY KEY,
    total INTEGER DEFAULT 0,
    success INTEGER DEFAULT 0,
    error INTEGER DEFAULT 0,
    total_tokens INTEGER DEFAULT 0,
    total_cost REAL DEFAULT 0
  );
`);
legacyDb
  .prepare("INSERT INTO metrics (task_name, total, success, error, total_tokens, total_cost) VALUES (?, ?, ?, ?, ?, ?)")
  .run("Legacy Task", 5, 3, 2, 0, 0);
legacyDb.close();

initDb(legacyDbPath);
const legacyColumns = getDb()
  .prepare("PRAGMA table_info(metrics)")
  .all()
  .map((column) => String(column.name));
assert(legacyColumns.includes("partial"), "старая БД получает колонку metrics.partial");
const legacyMetrics = metricsRepo.getMetrics("Legacy Task");
assert(
  legacyMetrics.total === 5 &&
    legacyMetrics.success === 3 &&
    legacyMetrics.error === 2 &&
    legacyMetrics.partial === 0,
  "миграция старой БД не теряет накопленные метрики"
);
closeDb();
initDb(dbPath);

// --- 6. Откат миграции при битом JSON ----------------------------------
const badDir = path.join(tempRoot, "bad-plugin");
fs.mkdirSync(badDir, { recursive: true });
fs.writeFileSync(path.join(badDir, "tasks.json"), "{ это не json");
const badDb = path.join(tempRoot, "bad.db");
initDb(badDb);
let migrationFailed = false;
try {
  await migrateJsonToDb(badDir);
} catch {
  migrationFailed = true;
}
assert(migrationFailed, "битый JSON приводит к ошибке миграции");
assert(tasksRepo.countTasks() === 0, "после ошибки БД осталась пустой (ROLLBACK)");
assert(fs.existsSync(path.join(badDir, "tasks.json")), "после ошибки JSON-файл не переименован");
assert(!fs.existsSync(path.join(badDir, "tasks.json.bak")), "после ошибки .bak не создан");

// Возвращаемся к основной БД для проверки дашборда.
initDb(dbPath);
closeDb();
initDb(dbPath);

// --- 7. Экспорт БД и индикатор в дашборде ------------------------------
const { startDashboardServer, closeDashboardServer, getDashboardPort } = await import(
  "./dist/server.js"
);
const started = await startDashboardServer(
  {
    getTasks: async () => [],
    runTask: async () => ({}),
    deleteTask: async () => {},
  },
  { preferred: 0, fallback: 0 }
);
assert(Boolean(started), "дашборд запущен на свободном порту");
const base = "http://127.0.0.1:" + getDashboardPort();

const page = await (await fetch(base + "/")).text();
assert(page.includes("💾 Скачать БД"), "в дашборде есть кнопка «Скачать БД»");
assert(page.includes("БД: ✅ SQLite (WAL)"), "в футере индикатор SQLite (WAL)");

const health = await (await fetch(base + "/api/health")).json();
assert(health.db && health.db.engine === "sqlite", "/api/health сообщает о SQLite");
assert(health.db.journalMode.toLowerCase() === "wal", "journal_mode = WAL");

const exportRes = await fetch(base + "/api/export-db");
assert(exportRes.status === 200, "GET /api/export-db отвечает 200");
assert(
  (exportRes.headers.get("content-disposition") || "").includes(".db"),
  "ответ содержит Content-Disposition с .db"
);
const dbBytes = Buffer.from(await exportRes.arrayBuffer());
assert(
  dbBytes.subarray(0, 16).toString("utf8") === "SQLite format 3\u0000",
  "скачанный файл — настоящая SQLite БД"
);
assert(dbBytes.byteLength > 0, "размер экспортированной БД больше нуля");

await closeDashboardServer();
closeDb();

// Убираем временную директорию.
fs.rmSync(tempRoot, { recursive: true, force: true });

console.log(
  process.exitCode ? "\nЕсть ошибки — см. FAIL выше." : "\nВсе тесты Спринта 12 прошли."
);
