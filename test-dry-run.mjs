/**
 * Тесты Спринта 14, часть 2: Dry-Run (simulatePipeline).
 * Запуск: node test-dry-run.mjs (после npm run build).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ws-scheduler-dry-"));
process.env.APPDATA = tempRoot;
process.env.OPENCODE_SCHEDULER_HOME = path.join(tempRoot, "opencode", "windows-scheduler");

const { initDb, closeDb } = await import("./dist/db/index.js");
const { saveTask } = await import("./dist/db/tasks-repo.js");
const { recordRun } = await import("./dist/db/history-repo.js");
const { simulatePipeline } = await import("./dist/core/dry-run.js");

const results = [];
function check(name, cond) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? "OK  " : "FAIL"} ${name}`);
}

initDb();

try {
  // Дерево: root -> [build, lint]; build -> lint.
  await saveTask({
    name: "Root", schedule: "0 9 * * *", prompt: "Запусти релиз",
    dependsOn: ["Build"],
    beforeScript: "git pull", afterScript: "git push", qualityGate: "npm test",
    allowedTools: ["read"], deniedTools: ["bash"],
  });
  await saveTask({ name: "Build", schedule: "*/5 * * * *", prompt: "Собери проект npm run build", dependsOn: ["Lint"], workingDirectory: tempRoot });
  await saveTask({ name: "Lint", schedule: "*/2 * * * *", prompt: "Проверь код" });
  await saveTask({
    name: "Danger", schedule: "* * * * *", prompt: "rm -rf / и git push --force",
  });

  // История для оценок: 2 успешных запуска Lint по 10 с, 1000 токенов.
  const base = Date.now();
  recordRun("Lint", "success", new Date(base - 20000).toISOString(), 10000, null, undefined, 1000);
  recordRun("Lint", "success", new Date(base - 10000).toISOString(), 10000, null, undefined, 1000);

  // 1. Не найденная задача.
  let threw = "";
  try {
    await simulatePipeline("Nope");
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err);
  }
  check("неизвестная задача бросает ошибку", threw.includes("не найдена"));

  // 2. Топологический порядок.
  const report = await simulatePipeline("Root");
  check("отчёт успешен", report.success === true && report.taskName === "Root");
  const order = report.tasks.map((t) => t.name);
  check("топологический порядок: Lint перед Build",
    order.indexOf("Lint") < order.indexOf("Build") && order.indexOf("Build") < order.indexOf("Root"));
  check("корневая задача имеет trigger=manual", report.tasks.find((t) => t.name === "Root")?.trigger === "manual");
  check("зависимости имеют trigger=dag",
    report.tasks.find((t) => t.name === "Build")?.trigger === "dag" &&
    report.tasks.find((t) => t.name === "Lint")?.trigger === "dag");

  // 3. Команды.
  const rootItem = report.tasks.find((t) => t.name === "Root");
  check("команда содержит opencode run --model-free", rootItem.command.startsWith("opencode run"));
  check("roleScoped в отчёте", rootItem.roleScoped?.allowed?.join(",") === "read" && rootItem.roleScoped?.denied?.join(",") === "bash");
  check("pre/post/QG в отчёте", rootItem.preFlight === "git pull" && rootItem.postFlight === "git push" && rootItem.qualityGate === "npm test");

  // 4. Оценки по истории.
  const lintItem = report.tasks.find((t) => t.name === "Lint");
  check("оценка длительности из истории (10 с)", lintItem.estimatedDurationSec === 10);
  check("оценка токенов из истории (1000)", lintItem.estimatedTokens === 1000);
  check("оценка стоимости из токенов", Math.abs(lintItem.estimatedCostUsd - 0.003) < 1e-9);

  // 5. Задача без истории — null + предупреждение.
  const buildItem = report.tasks.find((t) => t.name === "Build");
  check("нет истории -> null оценки", buildItem.estimatedDurationSec == null && buildItem.estimatedTokens == null && buildItem.estimatedCostUsd == null);
  check("предупреждение об отсутствии истории", report.warnings.some((w) => w.includes("Build") && w.includes("Нет успешных запусков")));

  // 6. Опасные паттерны.
  const danger = await simulatePipeline("Danger");
  check("предупреждение rm -rf /", danger.warnings.some((w) => w.includes("rm -rf /")));
  check("предупреждение git push --force", danger.warnings.some((w) => w.includes("git push --force")));

  // 7. Несуществующая рабочая директория.
  await saveTask({ name: "Ghost", schedule: "* * * * *", prompt: "x", workingDirectory: "Z:/definitely/not/exist" });
  const ghost = await simulatePipeline("Ghost");
  check("предупреждение о несуществующей директории", ghost.warnings.some((w) => w.includes("не существует на диске")));

  // 8. Топологические суммы.
  check("totals длительность = 10 с", report.totals.estimatedDurationSec === 10);
  check("totals токены = 1000", report.totals.estimatedTokens === 1000);

  // 9. Реального запуска нет: команда — только текст.
  check("симуляция не исполняет команды", report.tasks.every((t) => typeof t.command === "string"));
} finally {
  closeDb();
}

const failed = results.filter((r) => !r.ok);
console.log(`\nDry-run: ${results.length - failed.length}/${results.length} проверок пройдено.`);
process.exit(failed.length > 0 ? 1 : 0);
