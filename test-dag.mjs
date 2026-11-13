import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

// record-history.js безопасен для импорта: CLI-режим запускается только при
// прямом вызове файла (guard через import.meta.url).
const { selectDependentsToTrigger } = await import("./dist/core/record-history.js");

const record = (taskName, status, startedAt, finishedAt) => ({
  taskName,
  status,
  startedAt,
  finishedAt,
  durationMs: 1000,
});

const definitions = [
  { name: "Тесты" },
  { name: "Линтер" },
  { name: "Деплой", dependsOn: ["Тесты", "Линтер"] },
  { name: "Публикация", dependsOn: ["Деплой"] },
];

let passed = 0;
function ok(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`✅ ${name}`);
  } catch (err) {
    console.error(`❌ ${name}`);
    throw err;
  }
}

// 1. Обе зависимости успешны → Деплой запускается после последней из них.
ok("DAG: последняя зависимость завершилась, все успешны → запуск", () => {
  const history = [
    record("Линтер", "success", "2026-01-01T00:01:00Z", "2026-01-01T00:01:10Z"),
    record("Тесты", "success", "2026-01-01T00:00:00Z", "2026-01-01T00:00:30Z"),
  ];
  assert.deepEqual(selectDependentsToTrigger("Линтер", definitions, history), ["Деплой"]);
});

// 2. Одна зависимость упала → Деплой не запускается.
ok("DAG: одна из зависимостей с ошибкой → нет запуска", () => {
  const history = [
    record("Линтер", "success", "2026-01-01T00:01:00Z", "2026-01-01T00:01:10Z"),
    record("Тесты", "error", "2026-01-01T00:00:00Z", "2026-01-01T00:00:30Z"),
  ];
  assert.deepEqual(selectDependentsToTrigger("Линтер", definitions, history), []);
});

// 3. Зависимая задача уже стартовала после успеха зависимостей → не дублируем.
ok("DAG: Деплой уже запускался после зависимостей → пропуск", () => {
  const history = [
    record("Деплой", "success", "2026-01-01T00:02:00Z", "2026-01-01T00:02:20Z"),
    record("Линтер", "success", "2026-01-01T00:01:00Z", "2026-01-01T00:01:10Z"),
    record("Тесты", "success", "2026-01-01T00:00:00Z", "2026-01-01T00:00:30Z"),
  ];
  assert.deepEqual(selectDependentsToTrigger("Линтер", definitions, history), []);
});

// 4. Завершилась задача, не входящая в dependsOn → ничего не запускаем.
ok("DAG: задача не входит в зависимости → нет запуска", () => {
  const history = [
    record("Посторонняя", "success", "2026-01-01T00:03:00Z", "2026-01-01T00:03:10Z"),
    record("Линтер", "success", "2026-01-01T00:01:00Z", "2026-01-01T00:01:10Z"),
    record("Тесты", "success", "2026-01-01T00:00:00Z", "2026-01-01T00:00:30Z"),
  ];
  assert.deepEqual(selectDependentsToTrigger("Посторонняя", definitions, history), []);
});

// 5. Цепочка DAG: после Деплоя запускается Публикация (уровень 2).
ok("DAG: зависимость второго уровня", () => {
  const history = [
    record("Деплой", "success", "2026-01-01T00:02:00Z", "2026-01-01T00:02:20Z"),
    record("Линтер", "success", "2026-01-01T00:01:00Z", "2026-01-01T00:01:10Z"),
    record("Тесты", "success", "2026-01-01T00:00:00Z", "2026-01-01T00:00:30Z"),
  ];
  assert.deepEqual(selectDependentsToTrigger("Деплой", definitions, history), ["Публикация"]);
});

// 6. Сравнение имён без учёта регистра.
ok("DAG: имена сравниваются без учёта регистра", () => {
  const history = [
    record("линтер", "success", "2026-01-01T00:01:00Z", "2026-01-01T00:01:10Z"),
    record("ТЕСТЫ", "success", "2026-01-01T00:00:00Z", "2026-01-01T00:00:30Z"),
  ];
  assert.deepEqual(selectDependentsToTrigger("ЛИНТЕР", definitions, history), ["Деплой"]);
});

// 7. Запись токенов и стоимости в history.json / metrics.json.
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "scheduler-dag-"));
const appData = path.join(tempRoot, "AppData");
const pluginDir = path.join(appData, "opencode", "windows-scheduler");
process.env.OPENCODE_SCHEDULER_HOME = pluginDir;
await fs.mkdir(pluginDir, { recursive: true });

const recorder = path.resolve("dist/core/record-history.js");
function runRecorder(args) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [recorder, ...args],
      { env: { ...process.env, APPDATA: appData }, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) reject(new Error(stderr || err.message));
        else resolve(stdout);
      }
    );
  });
}

await runRecorder([
  "Задача-с-токенами",
  "error",
  "2026-01-01T00:00:00.000Z",
  "1500",
  "boom",
  "1234",
  "0.005",
]);

// Спринт 12: record-history пишет в SQLite, а не в history.json/metrics.json.
const dbFile = path.join(pluginDir, "scheduler.db");
const db = new DatabaseSync(dbFile);

const history = db
  .prepare("SELECT * FROM history ORDER BY started_at DESC")
  .all();
ok("История: tokens записан в SQLite", () => {
  assert.equal(history[0].tokens, 1234);
});
ok("История: costUsd записан в SQLite", () => {
  assert.equal(history[0].cost_usd, 0.005);
});
ok("История: JSON-файлы больше не создаются", () => {
  assert.equal(existsSync(path.join(pluginDir, "history.json")), false);
  assert.equal(existsSync(path.join(pluginDir, "metrics.json")), false);
});

const metrics = db
  .prepare("SELECT * FROM metrics WHERE lower(task_name) = lower(?)")
  .get("Задача-с-токенами");
ok("Метрики: токены накапливаются в SQLite", () => {
  assert.equal(metrics.total_tokens, 1234);
});
ok("Метрики: стоимость накапливается в SQLite", () => {
  assert.equal(metrics.total_cost, 0.005);
});

// 8. Sentinel "-" означает «данных нет»: поля не должны появляться.
await runRecorder([
  "Без-токенов",
  "error",
  "2026-01-01T00:05:00.000Z",
  "500",
  "",
  "-",
  "-",
]);
const noTokens = db
  .prepare("SELECT * FROM history WHERE task_name = ?")
  .get("Без-токенов");
ok("История: при отсутствии данных поля tokens/costUsd не пишутся", () => {
  assert.ok(noTokens);
  assert.equal(noTokens.tokens, null);
  assert.equal(noTokens.cost_usd, null);
});

db.close();
await fs.rm(tempRoot, { recursive: true, force: true });

console.log(`\n${passed}/${passed} тестов DAG и учёта токенов прошли.`);
