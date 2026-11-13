/**
 * Тесты паритета агента (Спринт 17.6 / роадмап 0.3–0.4):
 * расширенная схема schedule_task, схемы новых инструментов и чтение логов.
 * Запуск: node test-agent-tools.mjs (после npm run build).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ws-scheduler-agent-"));
process.env.APPDATA = tempRoot;

const {
  scheduleTaskSchema,
  updateTaskSchema,
  matrixControlSchema,
  matrixSchema,
} = await import("./dist/index.js");
const { getTaskLogs } = await import("./dist/core/scheduler/logs.js");
const { LOG_DIR, sanitizeName } = await import("./dist/types.js");

const results = [];
function check(name, cond) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? "OK  " : "FAIL"} ${name}`);
}

/** Возвращает true, если схема отвергла входные данные. */
function rejects(schema, value) {
  return schema.safeParse(value).success === false;
}

// 1. Минимальная задача по-прежнему валидна.
const minimal = scheduleTaskSchema.safeParse({
  name: "nightly",
  schedule: "0 3 * * *",
  prompt: "Собери отчёт",
});
check("schedule_task: минимальные поля валидны", minimal.success);

// 2. Новые поля 0.3 принимаются и сохраняются.
const full = scheduleTaskSchema.safeParse({
  name: "deploy",
  schedule: "*/15 * * * *",
  prompt: "Задеплой",
  timeoutSeconds: 900,
  model: "test/model",
  priority: 9,
  beforeScript: "git pull",
  afterScript: "git push",
  qualityGate: "npm test",
  dependsOn: ["build"],
  retryCount: 2,
  retryDelay: 30,
  nextTaskOnSuccess: "smoke",
  nextTaskOnError: "rollback",
  triggerType: "cron",
  workspaceId: "ws-1",
  allowedTools: ["read", "bash"],
  deniedTools: ["write"],
});
check(
  "schedule_task: qualityGate/dependsOn/retry/nextTask* принимаются",
  full.success &&
    full.data.qualityGate === "npm test" &&
    full.data.dependsOn?.[0] === "build" &&
    full.data.retryCount === 2 &&
    full.data.retryDelay === 30 &&
    full.data.nextTaskOnSuccess === "smoke" &&
    full.data.nextTaskOnError === "rollback"
);

// 3. Matrix 0.3: concurrency и overrides.
const matrix = scheduleTaskSchema.safeParse({
  name: "fanout",
  schedule: "* * * * *",
  prompt: "Прогони тесты",
  matrix: {
    workspaceIds: ["ws-1", "ws-2"],
    strategy: "parallel",
    failureMode: "continue",
    aggregation: "summary",
    createAggregator: true,
    concurrency: 2,
    overrides: {
      "ws-2": {
        prompt: "Только e2e",
        model: "test/fast",
        qualityGate: "npm run e2e",
        beforeScript: "git pull",
        afterScript: "git push",
      },
    },
  },
});
check(
  "schedule_task: matrix.concurrency и matrix.overrides принимаются",
  matrix.success &&
    matrix.data.matrix?.concurrency === 2 &&
    matrix.data.matrix?.overrides?.["ws-2"]?.qualityGate === "npm run e2e"
);

// 4. Невалидная стратегия отвергается.
check(
  "schedule_task: неизвестная strategy отвергается",
  rejects(scheduleTaskSchema, {
    name: "x",
    schedule: "* * * * *",
    prompt: "p",
    matrix: { workspaceIds: ["ws-1"], strategy: "chaos" },
  })
);

// 5. Без промпта задача не создаётся.
check(
  "schedule_task: отсутствие prompt отвергается",
  rejects(scheduleTaskSchema, { name: "x", schedule: "* * * * *" })
);

// 6. Обновление: достаточно одного name (частичное обновление).
const partial = updateTaskSchema.safeParse({ name: "deploy", qualityGate: "npm test" });
check(
  "update_task: частичное обновление валидно",
  partial.success && partial.data.qualityGate === "npm test" && partial.data.schedule === undefined
);

// 7. Обновление: matrix: null отключает матрицу.
check(
  "update_task: matrix: null принимается",
  updateTaskSchema.safeParse({ name: "deploy", matrix: null }).success
);

// 8. Обновление: пустая строка очищает поле.
check(
  "update_task: пустая строка допустима (очистка поля)",
  updateTaskSchema.safeParse({ name: "deploy", model: "" }).success
);

// 9. matrix_control: cleanup без name.
check(
  "matrix_control: cleanup без имени валиден",
  matrixControlSchema.safeParse({ action: "cleanup" }).success
);

// 10. matrix_control: неизвестное действие отвергается.
check(
  "matrix_control: неизвестное действие отвергается",
  rejects(matrixControlSchema, { action: "reboot" })
);

// 11. matrixSchema напрямую: пустой workspaceIds допустим схемой (проверяется
//     отдельно на уровне валидации задачи), но элементы — строки.
check(
  "matrixSchema: workspaceIds — массив строк",
  matrixSchema.safeParse({ workspaceIds: ["a"] }).success &&
    rejects(matrixSchema, { workspaceIds: [1] })
);

// 12. Все 12 инструментов агента экспортируются в dist.
const dist = fs.readFileSync(new URL("./dist/index.js", import.meta.url), "utf8");
const toolNames = [
  "schedule_task",
  "list_tasks",
  "update_task",
  "delete_task",
  "run_task_now",
  "pause_task",
  "resume_task",
  "get_history",
  "get_task_logs",
  "dry_run",
  "manage_workspaces",
  "matrix_control",
];
check(
  "все 12 инструментов агента присутствуют в сборке",
  toolNames.every((name) => dist.includes(`name: "${name}"`))
);

// 13. Описания инструментов переведены на английский.
check(
  "описания инструментов на английском",
  dist.includes("Partially updates an existing task") &&
    dist.includes("Returns recent run history") &&
    dist.includes("Matrix lifecycle")
);

// 14. getTaskLogs: параметр lines возвращает последние N строк.
const logName = "agent-log-test";
const logPath = path.join(LOG_DIR, `${sanitizeName(logName)}.log`);
fs.mkdirSync(LOG_DIR, { recursive: true });
fs.writeFileSync(
  logPath,
  Array.from({ length: 10 }, (_, index) => `line-${index + 1}`).join("\r\n"),
  "utf8"
);
const tail = await getTaskLogs(logName, 3);
check(
  "get_task_logs: lines=3 возвращает последние 3 строки",
  tail.error === undefined && tail.logs.split("\n").length === 3 && tail.logs.endsWith("line-10")
);

// 15. getTaskLogs: по умолчанию читает последние 50 строк.
const defaultTail = await getTaskLogs(logName);
check(
  "get_task_logs: по умолчанию не больше 50 строк",
  defaultTail.error === undefined && defaultTail.logs.split("\n").length === 10
);

// 16. getTaskLogs: отсутствующий лог даёт понятную ошибку.
const missing = await getTaskLogs("no-such-task-log");
check(
  "get_task_logs: отсутствующий лог даёт ошибку",
  Boolean(missing.error) && missing.logs === ""
);

const failed = results.filter((r) => !r.ok);
console.log(`\nAgent tools: ${results.length - failed.length}/${results.length} проверок пройдено.`);
process.exit(failed.length > 0 ? 1 : 0);
