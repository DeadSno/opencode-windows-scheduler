/**
 * Demo dashboard: seeds a temporary database with a realistic job set
 * (cron jobs, a DAG chain, a matrix with clones, a file trigger) and
 * starts the local web dashboard.
 *
 * Usage: node scripts/demo-dashboard.mjs [--port 3782]
 *
 * The demo uses a temporary APPDATA directory, so it never touches your
 * real jobs, history or settings.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const portArgIndex = process.argv.indexOf("--port");
const preferredPort =
  portArgIndex >= 0 && process.argv[portArgIndex + 1]
    ? Number(process.argv[portArgIndex + 1])
    : 3782;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ws-scheduler-demo-"));
process.env.APPDATA = tempRoot;

for (const dir of ["frontend", "backend", "mobile", "docs", "infra"]) {
  fs.mkdirSync(path.join(tempRoot, "repos", dir), { recursive: true });
}

const { initDb, closeDb } = await import("../dist/db/index.js");
const { saveTask, listTasks } = await import("../dist/db/tasks-repo.js");
const { recordRun, getHistory } = await import("../dist/db/history-repo.js");
const { addWorkspace } = await import("../dist/workspaces.js");
const { aggregateMatrixResults } = await import("../dist/core/matrix.js");
const { startDashboardServer } = await import("../dist/server.js");

initDb();

const frontend = addWorkspace({ path: path.join(tempRoot, "repos", "frontend"), name: "Frontend" });
const backend = addWorkspace({ path: path.join(tempRoot, "repos", "backend"), name: "Backend" });
const mobile = addWorkspace({ path: path.join(tempRoot, "repos", "mobile"), name: "Mobile" });
const docs = addWorkspace({ path: path.join(tempRoot, "repos", "docs"), name: "Docs" });
const infra = addWorkspace({ path: path.join(tempRoot, "repos", "infra"), name: "Infra" });

const tasks = [
  {
    name: "nightly-deps",
    schedule: "0 3 * * *",
    prompt: "Обнови зависимости, прогони тесты и приложи отчёт.",
    model: "anthropic/claude-sonnet-4",
    priority: 7,
    qualityGate: "npm test",
    workspaceId: backend.id,
  },
  {
    name: "deploy",
    schedule: "0 4 * * *",
    prompt: "Собери, протестируй и задеплой сервис.",
    model: "anthropic/claude-sonnet-4",
    priority: 9,
    matrix: {
      workspaceIds: [frontend.id, backend.id, mobile.id],
      strategy: "parallel",
      failureMode: "continue",
      aggregation: "summary",
      concurrency: 2,
      createAggregator: true,
      overrides: { [mobile.id]: { qualityGate: "npm run test:mobile" } },
    },
    isMatrixParent: true,
  },
  {
    name: "deploy-matrix-Frontend",
    schedule: "0 4 * * *",
    prompt: "Собери, протестируй и задеплой сервис.",
    workspaceId: frontend.id,
    matrixParentId: "deploy",
    triggerType: "file",
    qualityGate: "npm test",
  },
  {
    name: "deploy-matrix-Backend",
    schedule: "0 4 * * *",
    prompt: "Собери, протестируй и задеплой сервис.",
    workspaceId: backend.id,
    matrixParentId: "deploy",
    triggerType: "file",
    qualityGate: "npm test",
  },
  {
    name: "deploy-matrix-Mobile",
    schedule: "0 4 * * *",
    prompt: "Собери, протестируй и задеплой сервис.",
    workspaceId: mobile.id,
    matrixParentId: "deploy",
    triggerType: "file",
    qualityGate: "npm run test:mobile",
  },
  {
    name: "smoke-tests",
    schedule: "30 4 * * *",
    prompt: "Прогони smoke-тесты после деплоя и напиши в чат при падении.",
    dependsOn: ["deploy"],
    priority: 10,
    workspaceId: infra.id,
  },
  {
    name: "docs-sync",
    schedule: "",
    prompt: "Перегенерируй документацию по OpenAPI-схеме.",
    triggerType: "file",
    watchPath: "C:\\projects\\docs\\openapi.yaml",
    workspaceId: docs.id,
  },
  {
    name: "weekly-report",
    schedule: "0 9 * * 1",
    prompt: "Собери недельный отчёт: PR, инциденты, стоимость токенов.",
    model: "openai/gpt-5.1",
    priority: 4,
  },
];

for (const task of tasks) saveTask(task);

function run(name, status, ageMinutes, durationMs, error = null, extra = {}) {
  const startedAt = new Date(Date.now() - ageMinutes * 60_000).toISOString();
  recordRun(
    name,
    status,
    startedAt,
    durationMs,
    error,
    undefined,
    extra.tokens ?? 4200,
    extra.costUsd ?? 0.012,
    extra.model ?? "anthropic/claude-sonnet-4",
    extra.preFlight ?? "skipped",
    extra.postFlight ?? "skipped"
  );
}

run("deploy-matrix-Frontend", "success", 95, 74_000, null, { tokens: 18_400 });
run("deploy-matrix-Backend", "success", 94, 128_000, null, { tokens: 26_800 });
run("deploy-matrix-Mobile", "error", 93, 46_000, "Gradle build failed: SDK 35 not installed", { tokens: 9_200 });
run("deploy", "partial", 92, 0, "1 из 3 клонов завершился с ошибкой");
run("smoke-tests", "success", 88, 31_000, null, { preFlight: "success", postFlight: "success" });
run("nightly-deps", "success", 60, 212_000, null, { tokens: 44_200, costUsd: 0.09 });
run("nightly-deps", "error", 24 * 60 + 60, 96_000, "Quality Gate failed: npm test exit code 1", { preFlight: "success" });
run("weekly-report", "success", 2 * 24 * 60, 155_000, null, { tokens: 61_300, costUsd: 0.14, model: "openai/gpt-5.1" });
run("docs-sync", "success", 300, 22_000, null, { tokens: 7_400 });

const history = getHistory(null, 500);
const latestStatus = (name) => {
  const record = getHistory(name, 1)[0];
  return record ? record.status : "pending";
};

function taskView(definition) {
  const aggregate = definition.isMatrixParent ? aggregateMatrixResults(definition.name) : null;
  const status = aggregate ? aggregate.status : latestStatus(definition.name);
  return {
    ...definition,
    status,
    nextRun: definition.triggerType === "file" ? null : "сегодня, 03:00",
    matrixSummary: aggregate
      ? {
          status: aggregate.status,
          message: aggregate.message,
          successCount: aggregate.successCount,
          errorCount: aggregate.errorCount,
          pendingCount: aggregate.pendingCount,
          totalCount: aggregate.totalCount,
        }
      : undefined,
    metrics: {
      total: history.filter((h) => h.taskName === definition.name).length,
      success: history.filter((h) => h.taskName === definition.name && h.status === "success").length,
      error: history.filter((h) => h.taskName === definition.name && h.status === "error").length,
    },
  };
}

const deps = {
  getTasks: async () => listTasks().map(taskView),
  // Демо-режим ничего не меняет в системе: действия честно отвечают ошибкой,
  // вместо того чтобы имитировать успех (раньше кнопки «молча работали»).
  runTask: async () => {
    throw new Error("Демо-режим: запуск задач отключён. Запустите плагин в OpenCode.");
  },
  deleteTask: async () => {
    throw new Error("Демо-режим: удаление задач отключено. Запустите плагин в OpenCode.");
  },
  cancelMatrix: async () => {
    throw new Error("Демо-режим: отмена матрицы недоступна. Запустите плагин в OpenCode.");
  },
  cleanupMatrixOrphans: async () => [],
};

const started = await startDashboardServer(deps, { preferred: preferredPort, fallback: preferredPort + 1000 });
console.log(`Demo dashboard: http://127.0.0.1:${started.port}`);
console.log("Press Ctrl+C to stop.");

const shutdown = () => {
  try {
    closeDb();
  } catch {}
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
