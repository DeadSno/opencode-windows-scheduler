/**
 * Тесты Спринта 14, часть 1: Role-Scoped Tools (allowedTools/deniedTools).
 * Запуск: node test-role-scoped.mjs (после npm run build).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ws-scheduler-role-"));
process.env.APPDATA = tempRoot;
process.env.OPENCODE_SCHEDULER_HOME = path.join(tempRoot, "opencode", "windows-scheduler");

const { initDb, closeDb } = await import("./dist/db/index.js");
const { saveTask, listTasks, getTask } = await import("./dist/db/tasks-repo.js");
const { loadTaskDefinitions, buildExportJson, parseImportJson } = await import("./dist/task-transfer.js");
const { recordRun } = await import("./dist/db/history-repo.js");
const { ensureWrapper, writeWrapperCmd, writePromptFile } = await import("./dist/core/ps-wrapper.js");
const { writeBashWrapper } = await import("./dist/core/wrappers/bash.js");

const results = [];
function check(name, cond) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? "OK  " : "FAIL"} ${name}`);
}

initDb();

try {
  // 1. Сохранение задачи с ограничениями.
  await saveTask({
    name: "Scraper",
    schedule: "*/5 * * * *",
    prompt: "Собери отчёт",
    allowedTools: ["read", "grep", "WebFetch"],
    deniedTools: ["write", "bash"],
  });
  const stored = await getTask("scraper");
  check("saveTask сохраняет allowedTools", Array.isArray(stored?.allowedTools) && stored.allowedTools.join(",") === "read,grep,WebFetch");
  check("saveTask сохраняет deniedTools", Array.isArray(stored?.deniedTools) && stored.deniedTools.join(",") === "write,bash");

  // 2. Экспорт/импорт round-trip.
  const defs = await loadTaskDefinitions();
  const { data: exportJson } = await buildExportJson(defs.map((d) => ({ taskName: d.name })));
  const parsed = parseImportJson(exportJson);
  check("export/import round-trip сохраняет allowedTools",
    Array.isArray(parsed.tasks[0]?.allowedTools) && parsed.tasks[0].allowedTools.join(",") === "read,grep,WebFetch");
  check("export/import round-trip сохраняет deniedTools",
    Array.isArray(parsed.tasks[0]?.deniedTools) && parsed.tasks[0].deniedTools.join(",") === "write,bash");

  // 3. Пустой allowedTools отклоняется при импорте.
  const badJson = JSON.stringify({
    version: 1,
    tasks: [{ name: "BadTask", schedule: "* * * * *", prompt: "x", allowedTools: [] }],
  });
  const badParsed = parseImportJson(badJson);
  check("пустой allowedTools отклоняется при импорте",
    badParsed.errors.some((e) => e.includes("пустой allowedTools запрещён")) &&
      badParsed.tasks.every((t) => !("allowedTools" in t)));

  // 4. Обёртки содержат лог [role-scoped] и аргументы -AllowedTools/-DeniedTools.
  const promptFile = await writePromptFile("Scraper", "Собери отчёт");
  await ensureWrapper();
  const cmdFile = await writeWrapperCmd(
    "Scraper", "Scraper", promptFile, 3600,
    path.join(tempRoot, "lock"), tempRoot, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, ["read", "grep"], ["write", "bash"]
  );
  const cmdText = fs.readFileSync(cmdFile, "utf8");
  const psScriptPath = path.join(tempRoot, "opencode", "windows-scheduler", "wrappers", "run-task.ps1");
  const psText = fs.readFileSync(psScriptPath, "utf8");
  check("PowerShell-обёртка получает -AllowedTools", cmdText.includes("-AllowedTools"));
  check("PowerShell-обёртка получает -DeniedTools", cmdText.includes("-DeniedTools"));
  check("PowerShell-скрипт пишет [role-scoped] в лог", psText.includes("[role-scoped] allowed="));
  check("PowerShell-скрипт предупреждает об опасных denied", psText.includes("ВНИМАНИЕ: deniedTools содержит опасные инструменты"));

  const shFile = await writeBashWrapper({
    sanitizedName: "Scraper", taskName: "Scraper", promptFile, timeoutSeconds: 3600,
    lockFile: path.join(tempRoot, "lock"), workdir: tempRoot,
    allowedTools: ["read"], deniedTools: ["bash"],
  });
  const shText = fs.readFileSync(shFile, "utf8");
  check("bash-обёртка пишет [role-scoped] в лог", shText.includes("[role-scoped] allowed="));
  check("bash-обёртка определяет ALLOWED_TOOLS", shText.includes("ALLOWED_TOOLS=") && shText.includes("DENIED_TOOLS="));

  // 5. recordRun сохраняет ограничения в историю.
  const startedAt = new Date(Date.now() - 5000).toISOString();
  recordRun("Scraper", "success", startedAt, 500, null, undefined, 100, 0.0003, "test/model", "skipped", "skipped", undefined, undefined, ["read", "grep"], ["write", "bash"]);
  const { getHistory } = await import("./dist/db/history-repo.js");
  const records = getHistory("Scraper", 10);
  const last = records[0];
  check("recordRun хранит allowedTools в истории", Array.isArray(last?.allowedTools) && last.allowedTools.join(",") === "read,grep");
  check("recordRun хранит deniedTools в истории", Array.isArray(last?.deniedTools) && last.deniedTools.join(",") === "write,bash");

  // 6. Без ограничений — null в истории и отсутствие аргументов в обёртке.
  await saveTask({ name: "Plain", schedule: "* * * * *", prompt: "p" });
  const plainCmd = await writeWrapperCmd(
    "Plain", "Plain", promptFile, 3600, path.join(tempRoot, "lock2"), tempRoot,
    undefined, undefined, undefined, undefined, undefined, undefined
  );
  const plainText = fs.readFileSync(plainCmd, "utf8");
  check("обёртка без ограничений не получает -AllowedTools", !plainText.includes("-AllowedTools"));
  const plainRecord = getHistory("Plain", 1);
  check("история без ограничений — null", plainRecord.length === 0 || plainRecord[0].allowedTools == null);
} finally {
  closeDb();
}

const failed = results.filter((r) => !r.ok);
console.log(`\nRole-scoped: ${results.length - failed.length}/${results.length} проверок пройдено.`);
process.exit(failed.length > 0 ? 1 : 0);
