/**
 * Проверка документации 0.6: ARCHITECTURE / FEATURES / MIGRATION.
 * Запуск: node test-docs.mjs.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const root = path.dirname(url.fileURLToPath(new URL(import.meta.url)));
const docs = path.join(root, "docs");

const results = [];
function check(name, cond) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? "OK  " : "FAIL"} ${name}`);
}

const files = ["ARCHITECTURE.md", "FEATURES.md", "MIGRATION.md"];

for (const file of files) {
  const p = path.join(docs, file);
  const text = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
  check(`docs/${file} существует`, text.length > 0);
  check(`docs/${file}: есть заголовок h1`, text.startsWith("# "));
  check(`docs/${file}: есть оглавление ссылками`, /\]\(#/.test(text));
}

const arch = fs.readFileSync(path.join(docs, "ARCHITECTURE.md"), "utf8");
check("ARCHITECTURE: описывает 4 типа процессов", arch.includes("| Plugin host |") && arch.includes("| Recorder |"));
check("ARCHITECTURE: Linux-бэкенд — crontab (не systemd)", arch.includes("| Linux | `crontab` |"));
check("ARCHITECTURE: модули index/gui/server/matrix/record-history", ["src/index.ts", "gui.tsx", "server.ts", "core/matrix.ts", "record-history.ts"].every((m) => arch.includes(m)));
check("ARCHITECTURE: пути плагина %APPDATA% и XDG", arch.includes("%APPDATA%") && arch.includes("XDG_CONFIG_HOME"));
check("ARCHITECTURE: security-модель (localhost, metadata, plaintext)", arch.includes("no authentication") && arch.includes("metadata") && arch.includes("plain text"));

const feat = fs.readFileSync(path.join(docs, "FEATURES.md"), "utf8");
check("FEATURES: все 12 инструментов агента", ["schedule_task", "update_task", "pause_task", "resume_task", "get_history", "get_task_logs", "dry_run", "manage_workspaces", "matrix_control", "list_tasks", "delete_task", "run_task_now"].every((t) => feat.includes(t)));
check("FEATURES: матрица со всеми полями конфига", ["strategy", "failureMode", "concurrency", "overrides", "createAggregator", "aggregation"].every((k) => feat.includes(k)));
check("FEATURES: статусы истории incl. partial", feat.includes("`partial`"));
check("FEATURES: ограничения (limits) честно перечислены", feat.includes("No one-shot") && feat.toLowerCase().includes("metadata, not a sandbox") && feat.toLowerCase().includes("session continuity"));

const mig = fs.readFileSync(path.join(docs, "MIGRATION.md"), "utf8");
for (const section of ["From cron / crontab", "From systemd timers", "From launchd", "From Windows Task Scheduler", "Bulk import and export", "Verification checklist", "Common pitfalls", "Rollback"]) {
  check(`MIGRATION: раздел «${section}»`, mig.includes(`## ${section}`));
}
check("MIGRATION: пример import-формата с version: 1", mig.includes('"version": 1') && mig.includes('"tasks":'));
check("MIGRATION: нет упоминаний конкурентов", !/different-ai|sig9|jdormit|geckom|pan17|Fraser/i.test(mig));

// Все три файла в npm-пакете.
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
check("package.json: files включает docs", Array.isArray(pkg.files) && pkg.files.includes("docs"));
check("package.json: test включает test-docs.mjs", typeof pkg.scripts.test === "string" && pkg.scripts.test.includes("test-docs.mjs"));

const failed = results.filter((r) => !r.ok);
console.log(`\nDocs: ${results.length - failed.length}/${results.length} проверок пройдено.`);
process.exit(failed.length > 0 ? 1 : 0);
