/**
 * Тесты Спринта 26: журнал аудита.
 * Запуск: node test-audit.mjs (после npm run build).
 * Конфиг-домен подменяется temp-ди렉торией.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ws-scheduler-audit-"));
process.env.APPDATA = tempRoot;
process.env.OPENCODE_SCHEDULER_HOME = path.join(tempRoot, "opencode", "windows-scheduler");

const audit = await import("./dist/core/audit.js");
const dbModule = await import("./dist/db/index.js");

const { recordAudit, readAuditLog, cleanupAuditLog, clearAuditLog, resetAuditCleanupThrottle } = audit;

const results = [];
function check(name, cond) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? "OK  " : "FAIL"} ${name}`);
}

// Инициализируем БД (создаёт таблицы включая audit_log).
const db = dbModule.getDb();

// --- 1. Схема audit_log существует ------------------------------------------
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='audit_log'").all();
check("таблица audit_log создана", tables.length === 1);

const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='audit_log'").all();
check("индекс idx_audit_ts существует", indexes.some((i) => i.name === "idx_audit_ts"));
check("индекс idx_audit_action существует", indexes.some((i) => i.name === "idx_audit_action"));

// --- 2. Запись и чтение -------------------------------------------------------
resetAuditCleanupThrottle();
clearAuditLog();

const id1 = recordAudit({ action: "task.create", targetType: "task", target: "deploy", actor: "mcp", source: "schedule_task", details: { cron: "0 9 * * *" }, remote: null });
const id2 = recordAudit({ action: "task.update", targetType: "task", target: "deploy", actor: "gui", source: "update_task", details: { field: "timeout" }, remote: "127.0.0.1" });
const id3 = recordAudit({ action: "secret.set", targetType: "secret", target: "bot_token", actor: "mcp", source: "manage_secrets", details: { name: "bot_token" }, remote: null });

check("recordAudit возвращает id", typeof id1 === "number" && id1 > 0);
check("id растут", id2 > id1 && id3 > id2);

const all = readAuditLog({});
check("readAuditLog возвращает все записи", all.records.length === 3);
check("readAuditLog total", all.total === 3);
check("записи отсортированы по убыванию id", all.records[0].id === id3 && all.records[1].id === id2 && all.records[2].id === id1);

// --- 3. Фильтры ---------------------------------------------------------------
const byAction = readAuditLog({ action: "task.create" });
check("фильтр по action", byAction.records.length === 1 && byAction.records[0].action === "task.create");

const byActor = readAuditLog({ actor: "gui" });
check("фильтр по actor", byActor.records.length === 1 && byActor.records[0].actor === "gui");

const byTarget = readAuditLog({ target: "deploy" });
check("фильтр по target", byTarget.records.length === 2);

const limited = readAuditLog({ limit: 1 });
check("лимит записей", limited.records.length === 1 && limited.total === 3);

// --- 4. Редакция деталей -------------------------------------------------------
resetAuditCleanupThrottle();
clearAuditLog();

const secretId = recordAudit({
  action: "task.run",
  targetType: "task",
  target: "backup",
  actor: "http",
  source: "POST /api/run/:name",
  details: { token: "sk-1234567890abcdef", password: "hunter2", safe: "visible" },
  remote: "10.0.0.1",
});

const secretRec = readAuditLog({}).records.find((r) => r.id === secretId);
check("редакция токена в деталях", typeof secretRec.details.token === "string" && secretRec.details.token === "***");
check("редакция пароля в деталях", typeof secretRec.details.password === "string" && secretRec.details.password === "***");
check("несекретное поле не маскируется", secretRec.details.safe === "visible");

// ${secret:NAME} в деталях не маскируется как значение.
resetAuditCleanupThrottle();
clearAuditLog();
const refId = recordAudit({
  action: "task.create",
  targetType: "task",
  target: "deploy",
  actor: "mcp",
  source: "schedule_task",
  details: { env: { DB_URL: "${secret:db_pass}" } },
  remote: null,
});
const refRec = readAuditLog({}).records.find((r) => r.id === refId);
check("${secret:NAME} в деталях не маскируется", refRec.details.env.DB_URL === "${secret:db_pass}");

// --- 5. Ретеншн и очистка -----------------------------------------------------
resetAuditCleanupThrottle();
clearAuditLog();

const now = new Date();
const oldDate = new Date(now.getTime() - 45 * 24 * 60 * 60 * 1000).toISOString();
const recentDate = now.toISOString();

recordAudit({ action: "task.create", targetType: "task", target: "old", actor: "mcp", source: "t", details: {}, remote: null, ts: oldDate });
recordAudit({ action: "task.create", targetType: "task", target: "recent", actor: "mcp", source: "t", details: {}, remote: null, ts: recentDate });
const before = readAuditLog({}).records.length;
check("2 записи перед очисткой", before === 2);

const deleted = cleanupAuditLog({ retentionDays: 30, maxRecords: 10000 });
check("cleanupAuditLog удалила старую запись", deleted === 1);
const after = readAuditLog({}).records.length;
check("осталась 1 недавняя запись", after === 1);
check("оставшаяся запись — недавняя", readAuditLog({}).records[0].target === "recent");

// --- 6. clearAuditLog ---------------------------------------------------------
resetAuditCleanupThrottle();
clearAuditLog();
check("clearAuditLog удаляет все", readAuditLog({}).records.length === 0);

// --- 7. Итог ------------------------------------------------------------------
const failures = results.filter((item) => !item.ok);
console.log(`\nAudit: ${results.length - failures.length}/${results.length} проверок пройдено.`);
if (failures.length > 0) {
  for (const item of failures) console.error(`FAIL: ${item.name}`);
  process.exit(1);
}
