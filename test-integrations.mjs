// Тесты Спринта 22: webhook-триггеры, JSONL-логи, Prometheus, OTLP-экспорт.
// Запуск: node test-integrations.mjs (после npm run build).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sched-integrations-test-"));
process.env.APPDATA = tempRoot;
process.env.OPENCODE_SCHEDULER_HOME = path.join(tempRoot, "opencode", "windows-scheduler");

const { initDb, closeDb } = await import("./dist/db/index.js");
const {
  startRun,
  finishRun,
  recordRun,
  getHistory,
} = await import("./dist/db/history-repo.js");
const {
  loadSettings,
  saveSettings,
  generateHookCredentials,
} = await import("./dist/settings.js");
const {
  appendStructuredLog,
  readStructuredLogs,
  clearStructuredLogs,
  STRUCTURED_LOG_FILE,
  STRUCTURED_LOG_ARCHIVE,
  STRUCTURED_LOG_MAX_BYTES,
} = await import("./dist/core/structured-log.js");
const {
  signHookPayload,
  verifyHookSignature,
  verifyHookToken,
  verifyHookTimestamp,
  extractHookSignature,
  extractHookToken,
  authenticateHookRequest,
  timingSafeStringEqual,
} = await import("./dist/integrations.js");
const { renderPrometheusMetrics } = await import("./dist/core/prometheus.js");
const { buildOtlpExport } = await import("./dist/core/otel.js");
const {
  startDashboardServer,
  closeDashboardServer,
  getDashboardPort,
} = await import("./dist/server.js");

let passed = 0;
let failed = 0;
function assert(cond, message) {
  if (cond) {
    passed += 1;
    console.log(`OK   ${message}`);
  } else {
    failed += 1;
    console.error(`FAIL ${message}`);
  }
}

// --- 1. Настройки и генерация credentials -------------------------------
const defaults = await loadSettings();
assert(defaults.integrations.hooks.enabled === false, "hooks по умолчанию выключены");
assert(defaults.integrations.hooks.token === "", "token по умолчанию пуст");
assert(defaults.integrations.hooks.secret === "", "secret по умолчанию пуст");
assert(defaults.integrations.hooks.requireSignature === true, "HMAC-подпись обязательна по умолчанию");
assert(defaults.integrations.hooks.maxBodyBytes === 256 * 1024, "лимит тела 256 КиБ по умолчанию");
assert(defaults.integrations.hooks.timestampToleranceSeconds === 300, "окно timestamp 300 с по умолчанию");

const generated = generateHookCredentials();
assert(/^[a-f0-9]{48}$/.test(generated.token), "generateHookCredentials: token 48 hex-символов");
assert(/^[a-f0-9]{64}$/.test(generated.secret), "generateHookCredentials: secret 64 hex-символа");

const enabledSettings = await saveSettings({ integrations: { hooks: { enabled: true } } });
const token = enabledSettings.integrations.hooks.token;
const secret = enabledSettings.integrations.hooks.secret;
assert(enabledSettings.integrations.hooks.enabled === true, "saveSettings включает hooks");
assert(/^[a-f0-9]{48}$/.test(token), "включение hooks авто-генерирует token");
assert(/^[a-f0-9]{64}$/.test(secret), "включение hooks авто-генерирует secret");
assert(enabledSettings.integrations.hooks.requireSignature === true, "normalize сохраняет requireSignature");

const clamped = await saveSettings({
  integrations: {
    hooks: {
      enabled: true,
      token,
      secret,
      maxBodyBytes: 10,
      timestampToleranceSeconds: 999999,
    },
  },
});
assert(clamped.integrations.hooks.maxBodyBytes === 1024, "maxBodyBytes клампится снизу до 1024");
assert(clamped.integrations.hooks.timestampToleranceSeconds === 86400, "timestampToleranceSeconds клампится до 86400");

// --- 2. HMAC, token и timestamp ------------------------------------------
const body = Buffer.from('{"ref":"refs/heads/main","after":"abc"}', "utf8");
const signature = signHookPayload(secret, body);
assert(/^sha256=[a-f0-9]{64}$/.test(signature), "signHookPayload отдаёт sha256=<hex>");
assert(verifyHookSignature(secret, body, signature), "верная подпись принимается");
assert(verifyHookSignature(secret, body, signature.replace("sha256=", "")), "подпись без префикса принимается");
assert(!verifyHookSignature(secret, Buffer.from("other"), signature), "подпись от другого тела отклоняется");
assert(!verifyHookSignature("wrong-secret", body, signature), "подпись с другим secret отклоняется");
assert(!verifyHookSignature(secret, body, `sha1=${signature.slice(7)}`), "алгоритм sha1 отклоняется");
assert(!verifyHookSignature(secret, body, null), "отсутствующая подпись отклоняется");
assert(verifyHookToken(token, token), "верный token принимается");
assert(!verifyHookToken(token, "bad-token"), "неверный token отклоняется");
assert(timingSafeStringEqual("abc", "abc") && !timingSafeStringEqual("abc", "abcd"), "timingSafeStringEqual сравнивает значения");

const nowSeconds = Math.floor(Date.now() / 1000);
assert(verifyHookTimestamp(String(nowSeconds), 300).ok, "свежий timestamp в секундах принимается");
assert(verifyHookTimestamp(String(nowSeconds * 1000), 300).ok, "timestamp в миллисекундах принимается");
assert(!verifyHookTimestamp(String(nowSeconds - 1000), 60).ok, "старый timestamp отклоняется");
assert(!verifyHookTimestamp("not-a-number", 300).ok, "нечисловой timestamp отклоняется");
assert(verifyHookTimestamp(null, 300).ok, "без timestamp проверка пропускается");
assert(verifyHookTimestamp(String(nowSeconds - 1000), 0).ok, "нулевой tolerance выключает проверку");

const headers = {
  "x-scheduler-signature": signature,
  "x-gitlab-token": token,
};
assert(extractHookSignature(headers) === signature, "extractHookSignature читает X-Scheduler-Signature");
assert(extractHookToken(headers) === token, "extractHookToken читает X-Gitlab-Token");
assert(
  extractHookSignature({ "x-hub-signature-256": signature }) === signature,
  "extractHookSignature понимает GitHub X-Hub-Signature-256"
);

const authBase = {
  settings: { ...enabledSettings.integrations.hooks, timestampToleranceSeconds: 0 },
  token,
  signature,
  timestamp: null,
  body,
};
assert(authenticateHookRequest(authBase).ok, "authenticateHookRequest принимает валидный запрос");
assert(
  authenticateHookRequest({ ...authBase, token: "bad" }).status === 401,
  "authenticateHookRequest: неверный token -> 401"
);
assert(
  authenticateHookRequest({ ...authBase, signature: null }).status === 401,
  "authenticateHookRequest: без подписи -> 401"
);
assert(
  authenticateHookRequest({
    ...authBase,
    settings: { ...authBase.settings, enabled: false },
  }).status === 403,
  "authenticateHookRequest: выключенный канал -> 403"
);
assert(
  authenticateHookRequest({
    ...authBase,
    settings: { ...authBase.settings, secret: "" },
  }).status === 403,
  "authenticateHookRequest: без secret -> 403"
);

// --- 3. JSONL-логи -------------------------------------------------------
clearStructuredLogs();
appendStructuredLog({ event: "run.started", task: "alpha", status: "running", ts: "2026-01-01T10:00:00.000Z" });
appendStructuredLog({ event: "run.finished", task: "alpha", status: "success", durationMs: 1200, ts: "2026-01-01T10:00:01.000Z" });
appendStructuredLog({ event: "run.finished", task: "beta", status: "error", error: "boom", ts: "2026-01-02T10:00:00.000Z" });
appendStructuredLog({ event: "hook.received", task: "alpha", status: "accepted", httpStatus: 202, ts: "2026-01-03T10:00:00.000Z" });

let logs = readStructuredLogs();
assert(logs.total === 4 && logs.records.length === 4, "readStructuredLogs читает все записи");
assert(logs.records[0].event === "hook.received", "логи отсортированы новые сверху");
assert(readStructuredLogs({ task: "ALPHA" }).total === 3, "фильтр task регистронезависим");
assert(readStructuredLogs({ status: "error" }).total === 1, "фильтр status работает");
assert(readStructuredLogs({ event: "run.finished" }).total === 2, "фильтр event работает");
assert(
  readStructuredLogs({ since: "2026-01-02T00:00:00.000Z" }).total === 2,
  "фильтр since работает"
);
assert(
  readStructuredLogs({ until: "2026-01-01T23:59:59.000Z" }).total === 2,
  "фильтр until работает"
);
assert(readStructuredLogs({ limit: 2 }).records.length === 2, "limit ограничивает выдачу");
assert(readStructuredLogs({ limit: 2 }).total === 4, "total считается до limit");
assert(readStructuredLogs({ task: "missing" }).total === 0, "неизвестная задача -> пустой результат");

fs.appendFileSync(STRUCTURED_LOG_FILE, "not-json\n", "utf8");
logs = readStructuredLogs();
assert(logs.malformed === 1 && logs.total === 4, "битая JSONL-строка считается в malformed и не ломает чтение");

// Ротация: файл больше лимита переименовывается в .1, новая запись идёт в чистый файл.
fs.writeFileSync(STRUCTURED_LOG_FILE, "", "utf8");
fs.truncateSync(STRUCTURED_LOG_FILE, STRUCTURED_LOG_MAX_BYTES + 1);
appendStructuredLog({ event: "rotation.test", ts: "2026-01-04T00:00:00.000Z" });
assert(fs.existsSync(STRUCTURED_LOG_ARCHIVE), "переполненный лог ротируется в runs.jsonl.1");
assert(
  fs.readFileSync(STRUCTURED_LOG_FILE, "utf8").includes("rotation.test"),
  "после ротации новая запись пишется в runs.jsonl"
);
clearStructuredLogs();

// --- 4. Логирование из history-repo -------------------------------------
initDb();
const startedAt = "2026-02-01T09:00:00.000Z";
const runId = startRun("db-task", startedAt, "workspace-a", ["read"], ["bash"]);
let records = readStructuredLogs({ task: "db-task" }).records;
assert(records.length === 1 && records[0].event === "run.started", "startRun пишет run.started");
assert(records[0].runId === runId && records[0].status === "running", "run.started содержит runId и status");
assert(records[0].workspaceId === "workspace-a", "run.started содержит workspaceId");

const finished = finishRun(runId, "success", 1500, null, "next-task", 1234, 0.05, "gpt-test", "success", "skipped");
assert(finished === true, "finishRun завершает запуск");
records = readStructuredLogs({ task: "db-task" }).records;
const finishLog = records.find((record) => record.event === "run.finished");
assert(!!finishLog, "finishRun пишет run.finished");
assert(finishLog.status === "success" && finishLog.durationMs === 1500, "run.finished содержит статус и длительность");
assert(finishLog.tokens === 1234 && finishLog.costUsd === 0.05, "run.finished содержит токены и стоимость");
assert(finishLog.nextTask === "next-task" && finishLog.model === "gpt-test", "run.finished содержит nextTask и model");
assert(finishRun(runId, "error", 1) === false, "повторный finishRun не логируется и возвращает false");

const recordedId = recordRun("legacy-task", "error", "2026-02-02T09:00:00.000Z", 2500, "boom", null, 10, 0.01, "m1");
assert(recordedId > 0, "recordRun создаёт запись истории");
records = readStructuredLogs({ task: "legacy-task" }).records;
assert(records.length === 1 && records[0].status === "error", "recordRun пишет run.finished со статусом error");
assert(records[0].error === "boom", "recordRun сохраняет текст ошибки");

const partialId = recordRun(
  "partial-task",
  "partial",
  "2026-02-03T09:00:00.000Z",
  1000,
  "частичный результат",
  null,
  20,
  0.02,
  "m2"
);
assert(partialId > 0, "recordRun сохраняет частичный запуск");

// --- 5. Prometheus ------------------------------------------------------
const prom = renderPrometheusMetrics();
assert(prom.includes("# TYPE opencode_scheduler_runs_total counter"), "Prometheus: runs_total объявлен counter");
assert(prom.includes("opencode_scheduler_info{"), "Prometheus: info содержит labels");
assert(prom.includes('profile="'), "Prometheus: info содержит профиль");
assert(prom.includes("opencode_scheduler_up 1"), "Prometheus: up = 1");
assert(prom.includes("opencode_scheduler_queue_depth 0"), "Prometheus: queue_depth = 0");
assert(prom.includes('opencode_scheduler_runs_total{task="db-task",status="success"} 1'), "Prometheus: успешный запуск посчитан");
assert(prom.includes('opencode_scheduler_errors_total{task="legacy-task"} 1'), "Prometheus: ошибка посчитана");
assert(
  prom.includes('opencode_scheduler_runs_total{task="partial-task",status="partial"} 1'),
  "Prometheus: частичный запуск посчитан отдельно"
);
assert(
  prom.includes('opencode_scheduler_errors_total{task="partial-task"} 0'),
  "Prometheus: partial не увеличивает errors_total"
);
assert(prom.includes('opencode_scheduler_tokens_total{task="db-task"} 1234'), "Prometheus: токены посчитаны");
assert(prom.includes("opencode_scheduler_run_duration_seconds_bucket"), "Prometheus: histogram длительности присутствует");
assert(prom.includes('le="+Inf"'), "Prometheus: histogram содержит +Inf");
assert(prom.endsWith("\n"), "Prometheus: ответ заканчивается переводом строки");

// --- 6. OTLP-экспорт ----------------------------------------------------
const history = getHistory(null, 100);
const otlp = buildOtlpExport(history);
const resourceSpans = otlp.resourceSpans;
assert(Array.isArray(resourceSpans) && resourceSpans.length === 1, "OTLP: есть resourceSpans");
const scopeSpans = resourceSpans[0].scopeSpans;
assert(Array.isArray(scopeSpans) && scopeSpans.length === 1, "OTLP: есть scopeSpans");
const spans = scopeSpans[0].spans;
assert(spans.length === history.length && spans.length >= 2, "OTLP: один span на запись истории");
assert(/^[a-f0-9]{32}$/.test(spans[0].traceId), "OTLP: traceId — 32 hex-символа");
assert(/^[a-f0-9]{16}$/.test(spans[0].spanId), "OTLP: spanId — 16 hex-символов");
assert(spans[0].startTimeUnixNano === "1770022800000000000" || spans[0].startTimeUnixNano.endsWith("000000"), "OTLP: startTimeUnixNano в наносекундах");
assert(spans[0].status.code === 1 || spans[0].status.code === 2, "OTLP: статус span — OK/ERROR");
const otlpAgain = buildOtlpExport(history);
assert(otlpAgain.resourceSpans[0].scopeSpans[0].spans[0].traceId === spans[0].traceId, "OTLP: traceId детерминирован");
assert(
  spans.some((span) => span.attributes.some((attr) => attr.key === "run.status")),
  "OTLP: span содержит атрибут run.status"
);
const runningSpan = buildOtlpExport([
  {
    id: 99,
    taskName: "running-task",
    status: "running",
    startedAt: "2026-02-03T09:00:00.000Z",
    finishedAt: null,
  },
]).resourceSpans[0].scopeSpans[0].spans[0];
assert(runningSpan.status.code === 0, "OTLP: незавершённый запуск получает status.code 0");
const completedSpan = buildOtlpExport([
  {
    id: 99,
    taskName: "running-task",
    status: "success",
    startedAt: "2026-02-03T09:00:00.000Z",
    finishedAt: "2026-02-03T09:00:05.000Z",
  },
]).resourceSpans[0].scopeSpans[0].spans[0];
assert(
  completedSpan.traceId === runningSpan.traceId && completedSpan.spanId === runningSpan.spanId,
  "OTLP: traceId/spanId не меняются после завершения запуска"
);

// --- 7. HTTP-сервер: hooks, logs, metrics, export ------------------------
await saveSettings({
  integrations: {
    hooks: {
      enabled: true,
      token,
      secret,
      requireSignature: true,
      maxBodyBytes: 1024,
      timestampToleranceSeconds: 300,
    },
  },
});

let runCalls = 0;
let lastRun = null;
const deps = {
  getTasks: async () => [
    { name: "hook-task", schedule: "* * * * *", status: "success", nextRun: null },
    { name: "other-task", schedule: "0 * * * *", status: "error", nextRun: null },
  ],
  runTask: async (name) => {
    runCalls += 1;
    lastRun = name;
    return {};
  },
  deleteTask: async () => {},
};

const startedServer = await startDashboardServer(deps, { preferred: 4370, fallback: 4371 });
assert(!!startedServer && getDashboardPort() === 4370, "дашборд стартовал на тестовом порту 4370");
const base = `http://127.0.0.1:${getDashboardPort()}`;
const hookUrl = `${base}/api/hooks/HOOK-TASK?token=${encodeURIComponent(token)}`;
const hookBody = JSON.stringify({ event: "push", ref: "refs/heads/main" });
const hookSignature = signHookPayload(secret, hookBody);

const getHook = await fetch(`${base}/api/hooks/hook-task`);
assert(getHook.status === 405, "GET на /api/hooks/:task -> 405");

const noToken = await fetch(`${base}/api/hooks/hook-task`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-scheduler-signature": hookSignature },
  body: hookBody,
});
assert(noToken.status === 401, "hook без token -> 401");

const noSignature = await fetch(hookUrl, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: hookBody,
});
assert(noSignature.status === 401, "hook без HMAC-подписи -> 401");

const badSignature = await fetch(hookUrl, {
  method: "POST",
  headers: { "content-type": "application/json", "x-scheduler-signature": "sha256=" + "0".repeat(64) },
  body: hookBody,
});
assert(badSignature.status === 401, "hook с неверной подписью -> 401");

const stale = await fetch(hookUrl, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-scheduler-signature": hookSignature,
    "x-scheduler-timestamp": String(Math.floor(Date.now() / 1000) - 1000),
  },
  body: hookBody,
});
assert(stale.status === 401, "hook со старым timestamp -> 401");

const accepted = await fetch(hookUrl, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-scheduler-signature": hookSignature,
    "x-scheduler-timestamp": String(Math.floor(Date.now() / 1000)),
  },
  body: hookBody,
});
const acceptedBody = await accepted.json();
assert(accepted.status === 202, "валидный hook -> 202");
assert(acceptedBody.success === true && acceptedBody.task === "hook-task", "hook возвращает каноническое имя задачи");
assert(runCalls === 1 && lastRun === "hook-task", "hook запускает задачу через runTask");

const gitlab = await fetch(`${base}/api/hooks/hook-task`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-gitlab-token": token,
    "x-hub-signature-256": hookSignature,
  },
  body: hookBody,
});
assert(gitlab.status === 202, "GitLab/GitHub-заголовки без query token -> 202");
assert(runCalls === 2, "повторный hook снова запускает задачу");

const unknown = await fetch(`${base}/api/hooks/no-such-task?token=${encodeURIComponent(token)}`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-scheduler-signature": hookSignature },
  body: hookBody,
});
assert(unknown.status === 404, "hook для неизвестной задачи -> 404");

const oversized = await fetch(hookUrl, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-scheduler-signature": signHookPayload(secret, "x".repeat(2000)),
  },
  body: "x".repeat(2000),
});
assert(oversized.status === 413, "тело больше maxBodyBytes -> 413");

const logsRes = await fetch(`${base}/api/logs?task=hook-task&limit=10`);
const logsBody = await logsRes.json();
assert(logsRes.status === 200 && Array.isArray(logsBody.records), "GET /api/logs -> 200 JSON");
assert(logsBody.records.some((record) => record.event === "hook.received" && record.status === "accepted"), "в логах есть принятый hook");
assert(logsBody.records.some((record) => record.status === "rejected"), "в логах есть отклонённый hook");
assert(logsBody.total >= logsBody.records.length, "/api/logs возвращает total");

const logsJsonl = await fetch(`${base}/api/logs?format=jsonl&limit=5`);
assert(
  (logsJsonl.headers.get("content-type") || "").includes("application/x-ndjson"),
  "/api/logs?format=jsonl отдаёт ndjson"
);
assert((logsJsonl.headers.get("content-disposition") || "").includes("attachment"), "JSONL-логи скачиваются вложением");

const badLogs = await fetch(`${base}/api/logs?since=not-a-date`);
assert(badLogs.status === 400, "/api/logs с невалидной датой -> 400");

const metricsRes = await fetch(`${base}/metrics`);
const metricsText = await metricsRes.text();
assert(metricsRes.status === 200, "GET /metrics -> 200");
assert((metricsRes.headers.get("content-type") || "").startsWith("text/plain"), "/metrics отдаёт text/plain");
assert(metricsText.includes("opencode_scheduler_up 1"), "/metrics содержит up");
assert(metricsText.includes("opencode_scheduler_runs_total"), "/metrics содержит runs_total");
assert(metricsText.includes("opencode_scheduler_run_duration_seconds_bucket"), "/metrics содержит histogram");

const exportOtlp = await fetch(`${base}/api/history/export?format=otlp`);
const exportOtlpBody = await exportOtlp.json();
assert(exportOtlp.status === 200 && Array.isArray(exportOtlpBody.resourceSpans), "OTLP-экспорт по HTTP -> 200 JSON");
assert(
  (exportOtlp.headers.get("content-disposition") || "").includes(".otlp.json"),
  "OTLP-экспорт скачивается как *.otlp.json"
);

const badFormat = await fetch(`${base}/api/history/export?format=xml`);
assert(badFormat.status === 400, "неизвестный формат экспорта -> 400");

const health = await fetch(`${base}/api/health`).then((res) => res.json());
assert(health.ok === true, "/api/health продолжает работать");

await closeDashboardServer();

// --- 8. Выключенный канал ----------------------------------------------
await saveSettings({ integrations: { hooks: { enabled: false } } });
const startedDisabled = await startDashboardServer(deps, { preferred: 4370, fallback: 4371 });
assert(!!startedDisabled, "сервер стартовал с выключенными hooks");
const disabledBase = `http://127.0.0.1:${getDashboardPort()}`;
const disabled = await fetch(`${disabledBase}/api/hooks/hook-task?token=${encodeURIComponent(token)}`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-scheduler-signature": hookSignature },
  body: hookBody,
});
assert(disabled.status === 403, "выключенные hooks -> 403");
await closeDashboardServer();

closeDb();
try {
  fs.rmSync(tempRoot, { recursive: true, force: true });
} catch {}

console.log(`\nПройдено: ${passed}, провалено: ${failed}`);
if (failed > 0) process.exitCode = 1;
