// Ручной тест исправлений Спринта 7.1:
//  - все /api/* и неизвестные пути отвечают строго JSON;
//  - ошибки API -> 500 { error }, а не HTML/картинка;
//  - фронтенд проверяет Content-Type;
//  - занятый чужим процессом порт не убивается, используется fallback;
//  - зомби node-процесс плагина снимается, порт переиспользуется.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

// Изолируем PLUGIN_DIR (history.json/metrics.json) ДО импорта сервера.
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sched-json-test-"));
process.env.APPDATA = tempRoot;

const {
  startDashboardServer,
  closeDashboardServer,
  getDashboardPort,
  isDashboardRunning,
} = await import("./dist/server.js");

const assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL: " + msg);
    process.exitCode = 1;
  } else {
    console.log("OK: " + msg);
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(url, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(700) });
      return res;
    } catch {
      await sleep(150);
    }
  }
  throw new Error("Не дождались ответа от " + url);
}

async function readJsonResponse(res) {
  return {
    status: res.status,
    contentType: (res.headers.get("content-type") || "").toLowerCase(),
    marker: res.headers.get("x-plugin-dashboard"),
    body: await res.json(),
  };
}

const normalDeps = {
  getTasks: async () => [
    {
      name: "json-task",
      schedule: "* * * * *",
      status: "success",
      nextRun: null,
      dependsOn: ["build"],
    },
  ],
  runTask: async () => ({}),
  deleteTask: async () => {},
};

// --- 1. Штатный сервер: JSON на всех маршрутах -------------------------
const started = await startDashboardServer(normalDeps, { preferred: 4340, fallback: 4341 });
assert(started && started.port === 4340, "сервер стартовал на тестовом порту 4340");
const base = "http://127.0.0.1:" + getDashboardPort();

const htmlRes = await fetch(base + "/");
const html = await htmlRes.text();
assert(htmlRes.headers.get("content-type").includes("text/html"), "GET / отдаёт HTML");
assert(html.includes("function readJson"), "фронтенд содержит readJson-проверку Content-Type");
assert(html.includes("Сервер вернул не JSON. Проверьте консоль."), "фронтенд показывает понятную ошибку вместо падения JSON.parse");
assert(html.includes("server-warn"), "на странице есть баннер с диагностикой ответа сервера");
assert(
  html.includes("Похоже, ваш антивирус блокирует соединение. ") &&
    html.includes("Добавьте localhost в исключения или смените порт."),
  "фронтенд показывает подсказку про антивирус"
);
assert(html.includes("res.status === 499") && html.includes("ct.indexOf('image/') === 0"), "подсказка срабатывает на статус 499 и Content-Type image/*");
assert(html.includes("http://localhost:3782"), "футер по умолчанию указывает на новый порт 3782");

// Клиентский JS должен быть синтаксически валиден (ловит незаэкранированные
// переводы строк внутри строковых литералов, ломающие весь скрипт).
const scripts = Array.from(html.matchAll(/<script>([\s\S]*?)<\/script>/g)).map((m) => m[1]);
assert(scripts.length >= 2, "страница содержит клиентские скрипты");
scripts.forEach((code, index) => {
  try {
    new Function(code);
    assert(true, "клиентский скрипт #" + (index + 1) + " синтаксически валиден");
  } catch (err) {
    assert(false, "клиентский скрипт #" + (index + 1) + " содержит синтаксическую ошибку: " + err.message);
  }
});

const health = await readJsonResponse(await fetch(base + "/api/health"));
assert(health.status === 200 && health.contentType.includes("application/json"), "GET /api/health -> 200 JSON");
assert(health.body.ok === true && health.body.app === "opencode-windows-scheduler", "health подтверждает, что это дашборд плагина");
assert(health.marker === "opencode-windows-scheduler", "ответ содержит маркер-заголовок x-plugin-dashboard");

const tasksApi = await readJsonResponse(await fetch(base + "/api/tasks"));
assert(tasksApi.status === 200 && Array.isArray(tasksApi.body.tasks), "GET /api/tasks -> JSON с tasks");
assert(tasksApi.contentType.includes("application/json"), "GET /api/tasks Content-Type = application/json");

const metricsApi = await readJsonResponse(await fetch(base + "/api/metrics"));
assert(metricsApi.body.tokens === 0 && metricsApi.body.costUsd === 0, "метрики из пустой истории -> tokens/costUsd = 0");

const nfApi = await readJsonResponse(await fetch(base + "/api/unknown"));
assert(nfApi.status === 404 && nfApi.contentType.includes("application/json"), "неизвестный /api/* -> 404 JSON");
assert(nfApi.body.error === "Not found", "неизвестный /api/* -> { error: 'Not found' }");

const nfPage = await readJsonResponse(await fetch(base + "/no-such-page"));
assert(nfPage.status === 404 && nfPage.body.error === "Not found", "неизвестная страница -> JSON 404, а не HTML/PNG");

const wrongMethod = await readJsonResponse(await fetch(base + "/api/tasks", { method: "POST" }));
assert(wrongMethod.status === 405 && wrongMethod.body.error === "Method not allowed", "POST на GET-маршрут -> 405 JSON");

const wrongRunMethod = await readJsonResponse(await fetch(base + "/api/run/json-task"));
assert(wrongRunMethod.status === 405 && wrongRunMethod.contentType.includes("application/json"), "GET на POST-маршрут -> 405 JSON");

await closeDashboardServer();
await sleep(150);

// --- 2. Ошибка внутри API -> 500 JSON ----------------------------------
const brokenDeps = {
  ...normalDeps,
  getTasks: async () => {
    throw new Error("history.json: boom");
  },
};
const broken = await startDashboardServer(brokenDeps, { preferred: 4340, fallback: 4341 });
assert(broken && broken.port === 4340, "сервер с падающим getTasks стартовал");
const brokenBase = "http://127.0.0.1:" + broken.port;
const brokenApi = await readJsonResponse(await fetch(brokenBase + "/api/tasks"));
assert(brokenApi.status === 500, "ошибка API -> статус 500");
assert(brokenApi.contentType.includes("application/json"), "ошибка API -> Content-Type JSON");
assert(String(brokenApi.body.error).includes("boom"), "ошибка API -> { error: <текст ошибки> }");
await closeDashboardServer();

// --- 3. Чужой процесс на порту: не убиваем, уходим на fallback ----------
const foreignDir = fs.mkdtempSync(path.join(os.tmpdir(), "foreign-server-"));
const foreignScript = path.join(foreignDir, "server.mjs");
fs.writeFileSync(
  foreignScript,
  [
    "import http from 'node:http';",
    "const port = Number(process.argv[2]);",
    "http.createServer((req, res) => { res.writeHead(200, {'Content-Type': 'text/plain'}); res.end('foreign'); })",
    "  .listen(port, '127.0.0.1', () => console.log('READY'));",
  ].join("\n"),
  "utf8"
);
const foreign = spawn(process.execPath, [foreignScript, "4350"], {
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
await waitFor("http://127.0.0.1:4350/");
const fallback = await startDashboardServer(normalDeps, { preferred: 4350, fallback: 4351 });
assert(fallback && fallback.port === 4351, "порт занят чужим node-процессом -> дашборд ушёл на fallback 4351");
const foreignAlive = await fetch("http://127.0.0.1:4350/")
  .then((r) => r.text())
  .catch(() => "");
assert(foreignAlive === "foreign", "чужой процесс НЕ убит и продолжает отвечать");
await closeDashboardServer();
foreign.kill();

// --- 4. Зомби процесса плагина: снимаем и занимаем порт -----------------
// Имя временной папки содержит "opencode-windows-scheduler" — по этому
// признаку killZombiePort отличает зомби плагина от чужого node-процесса.
const zombieDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-windows-scheduler-zombie-"));
const zombieScript = path.join(zombieDir, "zombie.mjs");
fs.writeFileSync(
  zombieScript,
  [
    "import http from 'node:http';",
    "const port = Number(process.argv[2]);",
    "http.createServer((req, res) => { res.writeHead(200, {'Content-Type': 'text/plain'}); res.end('zombie'); })",
    "  .listen(port, '127.0.0.1', () => console.log('READY'));",
  ].join("\n"),
  "utf8"
);
const zombie = spawn(process.execPath, [zombieScript, "4360"], {
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
await waitFor("http://127.0.0.1:4360/");

const afterZombie = await startDashboardServer(normalDeps, { preferred: 4360, fallback: 4361 });
assert(afterZombie && afterZombie.port === 4360, "зомби-процесс плагина снят, дашборд занял порт 4360");
const zombieGone = await fetch("http://127.0.0.1:4360/api/health")
  .then((r) => r.json())
  .catch(() => null);
assert(zombieGone && zombieGone.ok === true, "на освобождённом порту отвечает именно дашборд");
await closeDashboardServer();
if (!zombie.killed) zombie.kill();

assert(isDashboardRunning() === false && getDashboardPort() === null, "после тестов сервер закрыт");

// Уборка временных файлов.
try {
  fs.rmSync(tempRoot, { recursive: true, force: true });
  fs.rmSync(foreignDir, { recursive: true, force: true });
  fs.rmSync(zombieDir, { recursive: true, force: true });
} catch {}

console.log(process.exitCode ? "\nЕсть падения теста." : "\nВсе проверки пройдены.");
