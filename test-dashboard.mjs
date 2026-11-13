// Ручной тест веб-дашборда (Спринт 5): запускает сервер со стабами и проверяет эндпоинты.
import { startDashboardServer, closeDashboardServer, isDashboardRunning, getDashboardPort } from "./dist/server.js";
import { startDashboardServer as start2 } from "./dist/server.js";
import { getSchedulerTitle } from "./dist/core/scheduler/index.js";

const deps = {
  getTasks: async () => [
    { name: "test-task", schedule: "* * * * *", status: "success", nextRun: "12.11.2026 10:00", triggerType: "cron", watchPath: null },
    { name: "test-task-2", schedule: "0 9 * * *", status: "error", nextRun: null, triggerType: "cron", watchPath: null },
  ],
  runTask: async (name) => {
    if (name === "boom") throw new Error("schtasks error: имитация сбоя запуска");
    return { alreadyRunning: name === "running-task" };
  },
  deleteTask: async (name) => {
    if (name === "boom") throw new Error("schtasks error: имитация сбоя удаления");
  },
};

const assert = (cond, msg) => {
  if (!cond) { console.error("FAIL: " + msg); process.exitCode = 1; }
  else console.log("OK: " + msg);
};

const started = await startDashboardServer(deps, { preferred: 4310, fallback: 4311 });
assert(started && started.port === 4310, "сервер стартовал на порту 4310 (тестовые порты)");
assert(isDashboardRunning(), "isDashboardRunning() = true");

// Двойной запуск: должен вернуть тот же порт, второй сервер не создаётся.
const again = await startDashboardServer(deps, { preferred: 4310, fallback: 4311 });
assert(again && again.port === 4310, "повторный startDashboardServer() вернул тот же порт (защита от дубля)");

// Запуск с другими зависимостями на занятый нами порт: переиспользование по маркер-заголовку.
const reuse = await startDashboardServer(
  { ...deps, getTasks: async () => [{ name: "other", schedule: "", status: "unknown", nextRun: null }] },
  { preferred: 4310, fallback: 4311 }
);
assert(reuse && reuse.port === 4310, "запуск на порт с уже слушающим нашим дашбордом -> переиспользование");

const base = "http://127.0.0.1:" + getDashboardPort();

// GET / — HTML. Заголовок платформозависимый (Windows / launchd / cron),
// поэтому сверяем его с фактическим значением для текущей ОС, а не с константой.
const html = await fetch(base + "/").then(r => r.text());
assert(html.includes("<!DOCTYPE html>") && html.includes(getSchedulerTitle()), "GET / отдаёт HTML-страницу");
assert(html.includes("/api/tasks"), "страница использует fetch к /api/tasks");

// GET /api/tasks — задачи + метрики из history.json.
const tasksRes = await fetch(base + "/api/tasks").then(r => r.json());
assert(Array.isArray(tasksRes.tasks) && tasksRes.tasks.length === 2, "GET /api/tasks вернул 2 задачи");
assert(tasksRes.tasks[0].metrics && typeof tasksRes.tasks[0].metrics.total === "number", "метрики по задаче присутствуют");

// GET /api/history.
const hist = await fetch(base + "/api/history").then(r => r.json());
assert(Array.isArray(hist.records), "GET /api/history вернул массив записей");

// GET /api/metrics.
const metrics = await fetch(base + "/api/metrics").then(r => r.json());
assert("total" in metrics && "success" in metrics && "error" in metrics, "GET /api/metrics вернул total/success/error");

// POST /api/run/:name.
const run = await fetch(base + "/api/run/" + encodeURIComponent("test-task"), { method: "POST" }).then(r => r.json());
assert(run.success === true, "POST /api/run успешен");
const runBusy = await fetch(base + "/api/run/" + encodeURIComponent("running-task"), { method: "POST" }).then(r => r.json());
assert(runBusy.success === true && runBusy.message.includes("уже выполняется"), "POST /api/run: alreadyRunning -> мягкое сообщение");
const runErr = await fetch(base + "/api/run/" + encodeURIComponent("boom"), { method: "POST" }).then(r => r.json());
assert(runErr.success === false && runErr.error.includes("сбоя"), "POST /api/run: ошибка задачи -> success:false + error");

// POST /api/delete/:name.
const del = await fetch(base + "/api/delete/" + encodeURIComponent("test-task"), { method: "POST" }).then(r => r.json());
assert(del.success === true, "POST /api/delete успешен");
const delErr = await fetch(base + "/api/delete/" + encodeURIComponent("boom"), { method: "POST" }).then(r => r.json());
assert(delErr.success === false, "POST /api/delete: ошибка -> success:false");

// 404 на неизвестный маршрут.
const nf = await fetch(base + "/api/nope");
assert(nf.status === 404, "неизвестный маршрут -> 404");

// Кириллица в имени задачи.
const cyr = await fetch(base + "/api/run/" + encodeURIComponent("задача-тест"), { method: "POST" }).then(r => r.json());
assert(cyr.success === true, "POST /api/run с кириллицей в имени работает");

// Закрытие сервера.
const closed = await closeDashboardServer();
assert(closed === true, "closeDashboardServer() закрыл сервер");
assert(isDashboardRunning() === false && getDashboardPort() === null, "после закрытия состояние сброшено");
const closedAgain = await closeDashboardServer();
assert(closedAgain === false, "повторное closeDashboardServer() -> false (нет активного сервера)");

// Перезапуск после закрытия работает.
const restarted = await startDashboardServer(deps, { preferred: 4310, fallback: 4311 });
assert(restarted && restarted.port === 4310, "перезапуск после закрытия работает");
await closeDashboardServer();

console.log(process.exitCode ? "\nЕсть падения теста." : "\nВсе проверки пройдены.");
