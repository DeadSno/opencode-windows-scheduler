import http from "node:http";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadHistory, loadMetrics } from "./history.js";
import { getSchedulerTitle } from "./core/scheduler/index.js";
import { checkpointDb, getDbFile, getDbStatus } from "./db/index.js";
import { listWorkspaces } from "./workspaces.js";
import { simulatePipeline } from "./core/dry-run.js";

/**
 * Локальный веб-дашборд (Спринт 5).
 * Встроенный модуль http из Node.js — без внешних зависимостей.
 * Слушает только 127.0.0.1 (localhost): 3782 → 4782 → 5782 → свободный порт ОС.
 * Порты 3000/3777 больше не используются: антивирусы часто перехватывают 3000
 * и возвращают вместо JSON свою HTML/PNG-заглушку.
 */

const execFileAsync = promisify(execFile);

/** Порт по умолчанию и запасной, если 3782 занят. */
const PREFERRED_PORT = 3782;
const FALLBACK_PORT = 4782;

/** Дополнительный порт, если и 3782, и 4782 заняты чужими процессами. */
const EXTRA_PORTS = [5782];

/** Имена процессов, которые считаем «зомби» от прошлых запусков плагина. */
const ZOMBIE_IMAGE_NAMES = new Set(["node.exe", "bun.exe"]);

/** Маркер-заголовок: по нему узнаём «свой» дашборд, уже слушающий порт. */
const DASHBOARD_HEADER = "x-plugin-dashboard";
const DASHBOARD_MARKER = "opencode-windows-scheduler";

/** Переопределение портов (используется в тестах; по умолчанию 3782/4782). */
export interface DashboardPorts {
  preferred?: number;
  fallback?: number;
}

/** Минимальный интерфейс зависимостей, которые плагин передаёт серверу. */
export interface DashboardDeps {
  /** Список задач плагина (тот же вид, что отдаёт get_tasks / list_tasks). */
  getTasks: () => Promise<
    Array<{
      name: string;
      schedule: string;
      status: string;
      nextRun: string | null;
      triggerType?: string;
      watchPath?: string | null;
      /** LLM-модель задачи (null/undefined — модель OpenCode по умолчанию). */
      model?: string | null;
      /** Приоритет задачи 0..10 (10 — наивысший). */
      priority?: number | null;
      /** DAG-зависимости задачи (из tasks.json). */
      dependsOn?: string[] | null;
      /** Multi-repo workspace (если задача привязана). */
      workspaceId?: string | null;
      workspaceName?: string | null;
      workspaceColor?: string | null;
      /** Matrix (Спринт 15): настройки родителя; null/undefined у обычных задач. */
      matrix?: {
        workspaceIds: string[];
        strategy?: string;
        failureMode?: string;
        aggregation?: string;
        /** Лимит одновременных клонов (Спринт 17). */
        concurrency?: number;
        /** Per-workspace переопределения (Спринт 17). */
        overrides?: Record<
          string,
          {
            prompt?: string;
            model?: string;
            qualityGate?: string;
            beforeScript?: string;
            afterScript?: string;
          }
        >;
      } | null;
      /** Для клона матрицы — имя родительской задачи. */
      matrixParentId?: string | null;
      /** true — задача является родителем матрицы (шаблоном). */
      isMatrixParent?: boolean;
      /** Агрегат по клонам матрицы (только у родителя). */
      matrixSummary?: {
        totalCount: number;
        successCount: number;
        errorCount: number;
        pendingCount: number;
        status: string;
        message: string;
      } | null;
    }>
  >;
  /** Немедленный запуск задачи (schtasks /run через обёртку плагина). */
  runTask: (name: string) => Promise<{ alreadyRunning?: boolean }>;
  /** Удаление задачи по имени (каскадно для матрицы-родителя). */
  deleteTask: (name: string) => Promise<void>;
  /** Отмена выполняющейся матрицы (Спринт 16). */
  cancelMatrix?: (name: string) => Promise<{
    cancelled: string[];
    running: string[];
    message: string;
    warnings: string[];
  }>;
  /** Очистка клонов/агрегаторов, чьи матрицы удалены (Спринт 16). */
  cleanupMatrixOrphans?: () => Promise<string[]>;
}

/** Метрики конкретной задачи, собранные из history.json. */
export interface TaskMetrics {
  total: number;
  success: number;
  error: number;
}

/** Агрегированная статистика по одной LLM-модели. */
export interface ModelAnalysis {
  model: string;
  totalRuns: number;
  totalTokens: number;
  totalCost: number;
  avgDuration: number;
  successRate: number;
}

/**
 * Приблизительные цены моделей в USD за 1M токенов.
 * Используются для What-If-анализа, когда в логе нет точной стоимости.
 */
const MODEL_PRICE_PER_MILLION: Record<string, number> = {
  "openai/gpt-4o": 10,
  "openai/gpt-4o-mini": 0.6,
  "deepseek/deepseek-coder": 0.28,
  "anthropic/claude-3-5-sonnet": 9,
  "anthropic/claude-3-5-haiku": 1.2,
  "google/gemini-2.5-pro": 3.5,
  "google/gemini-2.0-flash": 0.3,
};
const DEFAULT_PRICE_PER_MILLION = 3;

/** Цена модели за 1M токенов (fallback — средняя оценка). */
function modelPrice(model: string | undefined): number {
  const key = (model ?? "").trim().toLowerCase();
  return MODEL_PRICE_PER_MILLION[key] ?? DEFAULT_PRICE_PER_MILLION;
}

/** Оценка стоимости запуска по токенам (если точная цена неизвестна). */
function estimateCost(tokens: number, model: string | undefined): number {
  return (tokens * modelPrice(model)) / 1_000_000;
}

/**
 * Агрегирует историю по моделям и считает сценарии What-If.
 * Возвращает данные для GET /api/models-analysis и блока дашборда.
 */
function aggregateModels(
  history: Array<{
    status: string;
    durationMs: number;
    tokens?: number;
    costUsd?: number;
    model?: string;
  }>
) {
  const map = new Map<
    string,
    { runs: number; success: number; tokens: number; cost: number; duration: number }
  >();

  let totalTokens = 0;
  let totalCost = 0;
  let totalRuns = 0;

  for (const record of history) {
    const model = (record.model ?? "").trim() || "по умолчанию";
    const tokens = Number(record.tokens) || 0;
    const cost =
      typeof record.costUsd === "number" && record.costUsd > 0
        ? record.costUsd
        : estimateCost(tokens, model === "по умолчанию" ? undefined : model);
    const duration = Number(record.durationMs) || 0;

    const item = map.get(model) ?? { runs: 0, success: 0, tokens: 0, cost: 0, duration: 0 };
    item.runs += 1;
    if (record.status === "success") item.success += 1;
    item.tokens += tokens;
    item.cost += cost;
    item.duration += duration;
    map.set(model, item);

    totalRuns += 1;
    totalTokens += tokens;
    totalCost += cost;
  }

  const models: ModelAnalysis[] = [...map.entries()]
    .map(([model, item]) => ({
      model,
      totalRuns: item.runs,
      totalTokens: item.tokens,
      totalCost: Number(item.cost.toFixed(6)),
      avgDuration: item.runs > 0 ? Math.round(item.duration / item.runs) : 0,
      successRate: item.runs > 0 ? Math.round((item.success / item.runs) * 100) : 0,
    }))
    .sort((a, b) => b.totalRuns - a.totalRuns);

  const whatIfModels = ["openai/gpt-4o", "deepseek/deepseek-coder"];
  const whatIf = whatIfModels.map((model) => ({
    model,
    pricePerMillion: modelPrice(model),
    cost: Number(((totalTokens * modelPrice(model)) / 1_000_000).toFixed(4)),
  }));

  return { models, totals: { totalRuns, totalTokens, totalCost: Number(totalCost.toFixed(6)) }, whatIf };
}

/**
 * Оценка стоимости токенов, если OpenCode не напечатал цену в логе:
 * примерно $3 за 1M токенов (используется только для карточки «Примерная стоимость»).
 */
const ESTIMATED_COST_PER_1K_TOKENS_USD = 0.003;

/** Единственный активный экземпляр сервера (защита от двойного запуска). */
let running: { server: http.Server; port: number } | null = null;

/** Незавершённый запуск стартовой логики — повторные вызовы делят его между собой. */
let starting: Promise<{ port: number } | null> | null = null;

/** Запущен ли дашборд прямо сейчас. */
export function isDashboardRunning(): boolean {
  return running !== null;
}

/** Порт, на котором слушает дашборд (или null, если не запущен). */
export function getDashboardPort(): number | null {
  return running?.port ?? null;
}

/**
 * Запускает сервер на первом свободном порту.
 * Если порт занят не нашим дашбордом, сначала пытается снять зомби-процесс
 * (node/bun, оставшийся от прошлого запуска), затем пробует следующий порт.
 * Повторный вызов не создаёт второй сервер — возвращается уже запущенный.
 */
export async function startDashboardServer(
  deps: DashboardDeps,
  ports?: DashboardPorts
): Promise<{ port: number } | null> {
  if (running) return { port: running.port };
  if (starting) return starting;

  const preferred = ports?.preferred ?? PREFERRED_PORT;
  const fallback = ports?.fallback ?? FALLBACK_PORT;
  // Последний кандидат — порт 0: ОС сама выдаст гарантированно свободный порт.
  const candidates = ports
    ? Array.from(new Set([preferred, fallback]))
    : Array.from(new Set([preferred, fallback, ...EXTRA_PORTS, 0]));

  starting = (async () => {
    for (const port of candidates) {
      try {
        const server = await listenOn(port, deps);
        const actualPort = resolveServerPort(server, port);
        running = { server, port: actualPort };
        console.log(`[windows-scheduler] Веб-дашборд запущен: http://localhost:${actualPort}`);
        return { port: actualPort };
      } catch (err: any) {
        if (err?.code !== "EADDRINUSE") {
          console.error(
            `[windows-scheduler] Не удалось запустить дашборд на порту ${port}: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
          return null;
        }

        // Порт занят: если это уже наш дашборд (другой экземпляр плагина
        // в том же процессе/сессии), переиспользуем его, а не вешаем второй порт.
        if (port !== 0 && (await isOwnDashboardOn(port))) {
          console.log(
            `[windows-scheduler] Дашборд уже запущен на http://localhost:${port} — переиспользуем его.`
          );
          return { port };
        }

        // Порт занят чужим или старым процессом: пробуем снять зомби
        // (только node/bun этого плагина) и один раз повторить bind.
        if (port !== 0 && (await tryFreeZombiePort(port))) {
          try {
            const server = await listenOn(port, deps);
            running = { server, port };
            console.log(`[windows-scheduler] Веб-дашборд запущен: http://localhost:${port}`);
            return { port };
          } catch {
            // Не вышло — идём к следующему порту.
          }
        }
        // Чужой сервис — пробуем запасной порт.
      }
    }
    console.error(
      `[windows-scheduler] Не удалось подобрать свободный порт — веб-дашборд не запущен.`
    );
    return null;
  })();

  const result = await starting;
  starting = null;
  return result;
}

/** Узнаёт фактический порт после bind (актуально для порта 0). */
function resolveServerPort(server: http.Server, requested: number): number {
  if (requested !== 0) return requested;
  const address = server.address();
  return typeof address === "object" && address ? address.port : requested;
}

/**
 * Пытается снять процесс, который держит порт и похож на зомби прошлого
 * запуска плагина. Чужие приложения (браузер, IDE, другой сервис) не трогаем.
 */
async function tryFreeZombiePort(port: number): Promise<boolean> {
  const pids = await findListeningPids(port);
  let killed = false;

  for (const pid of pids) {
    if (pid === process.pid) continue;

    const info = await getProcessInfo(pid);
    if (!info) continue;

    if (!ZOMBIE_IMAGE_NAMES.has(info.name.toLowerCase())) {
      console.warn(
        `[windows-scheduler] Порт ${port} занят процессом ${info.name} (PID ${pid}) — не трогаем, пробуем другой порт.`
      );
      continue;
    }

    const cmd = (info.commandLine || "").toLowerCase();
    const looksLikeOurs =
      cmd.includes("opencode-windows-scheduler") ||
      cmd.includes("dist/server") ||
      cmd.includes("dist\\server");
    if (!looksLikeOurs) {
      console.warn(
        `[windows-scheduler] Порт ${port} занят node/bun (PID ${pid}), но это не процесс плагина — не трогаем.`
      );
      continue;
    }

    try {
      await execFileAsync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
      console.log(
        `[windows-scheduler] Снят зомби-процесс ${info.name} (PID ${pid}), державший порт ${port}.`
      );
      killed = true;
    } catch (err: any) {
      console.warn(
        `[windows-scheduler] Не удалось снять процесс PID ${pid}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  return killed;
}

/** Возвращает PID'ы процессов, слушающих указанный TCP-порт (netstat). */
async function findListeningPids(port: number): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync("netstat", ["-ano", "-p", "TCP"], {
      windowsHide: true,
    });
    const pids = new Set<number>();
    const needle = `:${port}`;
    for (const line of stdout.split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 5) continue;
      if (parts[0].toUpperCase() !== "TCP") continue;
      if (parts[3].toUpperCase() !== "LISTENING") continue;
      if (!parts[1].endsWith(needle)) continue;
      const pid = Number(parts[4]);
      if (Number.isInteger(pid) && pid > 0) pids.add(pid);
    }
    return Array.from(pids);
  } catch {
    return [];
  }
}

/** Имя процесса и командная строка через CIM (Windows PowerShell). */
async function getProcessInfo(pid: number): Promise<{ name: string; commandLine: string } | null> {
  try {
    const script =
      '$p = Get-CimInstance Win32_Process -Filter "ProcessId=' +
      pid +
      '"; if ($p) { $p.Name + "|" + $p.CommandLine }';
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true }
    );
    const line = stdout.trim();
    if (!line) return null;
    const idx = line.indexOf("|");
    if (idx < 0) return { name: line, commandLine: "" };
    return { name: line.slice(0, idx), commandLine: line.slice(idx + 1) };
  } catch {
    return null;
  }
}

/** Проверяет по маркер-заголовку, что на порту отвечает наш дашборд. */
async function isOwnDashboardOn(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      method: "GET",
      signal: AbortSignal.timeout(1500),
    });
    return res.headers.get(DASHBOARD_HEADER) === DASHBOARD_MARKER;
  } catch {
    return false;
  }
}

/**
 * Останавливает сервер (вызывается при выгрузке плагина).
 * Возвращает true, если сервер действительно работал и был закрыт.
 */
export async function closeDashboardServer(): Promise<boolean> {
  if (!running) return false;
  const { server } = running;
  running = null;
  return new Promise((resolve) => {
    server.close(() => resolve(true));
    // Закрываем и keep-alive соединения, чтобы порт освобождался сразу
    // и следующий запуск не получал ECONNRESET от «протухшего» сокета.
    server.closeAllConnections?.();
  });
}

/** Создаёт сервер и возвращает промис, который резолвится после bind на порт. */
function listenOn(port: number, deps: DashboardDeps): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    void handleRequest(req, res, deps);
  });
  return new Promise((resolve, reject) => {
    const onError = (err: Error & { code?: string }) => {
      server.close();
      reject(err);
    };
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", onError);
      resolve(server);
    });
  });
}

/** Обработчик входящего HTTP-запроса: маршрутизация и JSON/HTML-ответы. */
async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: DashboardDeps
): Promise<void> {
  try {
    let url: URL;
    try {
      url = new URL(req.url || "/", `http://127.0.0.1:${getDashboardPort() ?? PREFERRED_PORT}`);
    } catch {
      sendJson(res, 400, { error: "Некорректный URL запроса." });
      return;
    }

    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      sendJson(res, 400, { error: "Некорректная кодировка пути запроса." });
      return;
    }

    // Проверка метода для известных маршрутов: никаких HTML/картинок в ответе.
    const knownGet =
      pathname === "/api/tasks" ||
      pathname === "/api/history" ||
      pathname === "/api/metrics" ||
      pathname === "/api/models-analysis" ||
      pathname === "/api/export-db" ||
      pathname === "/api/workspaces" ||
      pathname === "/api/health" ||
      /^\/api\/dry-run\//.test(pathname) ||
      /^\/api\/matrix\//.test(pathname);
    if (knownGet && req.method !== "GET") {
      sendJson(res, 405, { error: "Method not allowed" });
      return;
    }
    const knownPost = /^\/api\/(run|delete)\//.test(pathname);
    if (knownPost && req.method !== "POST") {
      sendJson(res, 405, { error: "Method not allowed" });
      return;
    }

    // Статический HTML-файл — страница дашборда.
    if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      send(res, 200, "text/html; charset=utf-8", renderPage());
      return;
    }

    // JSON-API.
    if (req.method === "GET" && pathname === "/api/health") {
      sendJson(res, 200, {
        ok: true,
        app: DASHBOARD_MARKER,
        port: getDashboardPort(),
        db: getDbStatus(),
      });
      return;
    }

    if (req.method === "GET" && pathname === "/api/tasks") {
      const tasks = await collectTasksWithMetrics(deps);
      sendJson(res, 200, { tasks });
      return;
    }

    if (req.method === "GET" && pathname === "/api/workspaces") {
      sendJson(res, 200, { workspaces: listWorkspaces() });
      return;
    }

    // Matrix (Спринт 15): детальный отчёт по клонам матрицы.
    if (req.method === "GET" && pathname.startsWith("/api/matrix/")) {
      const parentId = pathname.slice("/api/matrix/".length).trim();
      if (!parentId) {
        sendJson(res, 400, { error: "Не указано имя матрицы." });
        return;
      }
      const tasks = await collectTasksWithMetrics(deps);
      const key = parentId.toLowerCase();
      const parent = tasks.find((t) => String(t.name).toLowerCase() === key);
      if (!parent) {
        sendJson(res, 404, { error: `Матрица "${parentId}" не найдена.` });
        return;
      }
      const clones = tasks
        .filter((t) => String(t.matrixParentId ?? "").toLowerCase() === key)
        .map((t) => ({
          name: t.name,
          workspaceId: t.workspaceId ?? null,
          workspaceName: t.workspaceName ?? null,
          status: t.status,
          metrics: t.metrics,
        }));
      const totalCount = clones.length;
      const successCount = clones.filter((c) => c.status === "success").length;
      const errorCount = clones.filter((c) => c.status === "error").length;
      const pendingCount = totalCount - successCount - errorCount;
      const failureMode = parent.matrix?.failureMode ?? "continue";
      let status: string;
      if (totalCount === 0) status = "empty";
      else if (pendingCount > 0) status = "running";
      else if (errorCount === 0) status = "success";
      else status = failureMode === "stop" ? "error" : "partial";
      sendJson(res, 200, {
        success: true,
        report: {
          parentId: parent.name,
          totalCount,
          successCount,
          errorCount,
          pendingCount,
          status,
          message: parent.matrixSummary?.message ?? "",
          clones,
        },
      });
      return;
    }

    // Dry-Run (Спринт 14): симуляция конвейера без реального запуска.
    if (req.method === "GET" && pathname.startsWith("/api/dry-run/")) {
      const taskName = decodeURIComponent(pathname.slice("/api/dry-run/".length)).trim();
      if (!taskName) {
        sendJson(res, 400, { error: "Не указано имя задачи." });
        return;
      }
      try {
        const report = await simulatePipeline(taskName);
        sendJson(res, 200, report);
      } catch (err: any) {
        sendJson(res, 404, {
          success: false,
          taskName,
          tasks: [],
          totals: { estimatedDurationSec: null, estimatedCostUsd: null, estimatedTokens: null },
          warnings: [],
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    if (req.method === "GET" && pathname === "/api/history") {
      const records = await loadHistory();
      sendJson(res, 200, { records });
      return;
    }

    if (req.method === "GET" && pathname === "/api/models-analysis") {
      const history = await loadHistory();
      sendJson(res, 200, aggregateModels(history));
      return;
    }

    if (req.method === "GET" && (pathname === "/api/metrics" || pathname === "/api/summary")) {
      const metrics = await loadMetrics();
      // Токены и стоимость суммируем по history.json (как требует спринт):
      // если в записи есть costUsd — берём его, иначе оцениваем по токенам.
      const history = await loadHistory();
      let tokens = 0;
      let costUsd = 0;
      for (const record of history) {
        const recordTokens =
          typeof record.tokens === "number" && record.tokens > 0 ? record.tokens : 0;
        tokens += recordTokens;
        if (typeof record.costUsd === "number" && record.costUsd > 0) {
          costUsd += record.costUsd;
        } else if (recordTokens > 0) {
          costUsd += (recordTokens / 1000) * ESTIMATED_COST_PER_1K_TOKENS_USD;
        }
      }
      sendJson(res, 200, { ...metrics, tokens, costUsd });
      return;
    }

    // Бэкап БД: перед чтением файла сбрасываем WAL в основной .db-файл,
    // чтобы скачанный файл содержал все зафиксированные транзакции.
    if (req.method === "GET" && pathname === "/api/export-db") {
      try {
        checkpointDb();
        const file = getDbFile();
        const data = await fs.readFile(file);
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        sendBuffer(
          res,
          200,
          "application/octet-stream",
          data,
          `scheduler-${stamp}.db`
        );
      } catch (err: any) {
        sendJson(res, 500, {
          error: `Не удалось экспортировать БД: ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
      }
      return;
    }

    // Запуск задачи: POST /api/run/:name (имя URL-кодируется на клиенте).
    const runMatch = req.method === "POST" && pathname.match(/^\/api\/run\/(.+)$/);
    if (runMatch) {
      const name = runMatch[1].replace(/\/+$/, "");
      if (!name) {
        sendJson(res, 400, { success: false, error: "Не передано имя задачи." });
        return;
      }
      try {
        const result = await deps.runTask(name);
        sendJson(res, 200, {
          success: true,
          message: result?.alreadyRunning
            ? `Задача "${name}" уже выполняется.`
            : `Задача "${name}" запущена.`,
        });
      } catch (err: any) {
        sendJson(res, 500, {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    // Lifecycle матриц (Спринт 16): отмена выполняющейся матрицы.
    const cancelMatrixMatch =
      req.method === "POST" && pathname.match(/^\/api\/cancel-matrix\/(.+)$/);
    if (cancelMatrixMatch) {
      const name = decodeURIComponent(cancelMatrixMatch[1]).replace(/\/+$/, "");
      if (!name) {
        sendJson(res, 400, { success: false, error: "Не передано имя задачи." });
        return;
      }
      if (!deps.cancelMatrix) {
        sendJson(res, 501, { success: false, error: "Отмена матриц не поддерживается." });
        return;
      }
      try {
        const result = await deps.cancelMatrix(name);
        sendJson(res, 200, {
          success: true,
          message: result.message,
          cancelled: result.cancelled,
        });
      } catch (err: any) {
        sendJson(res, 500, {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    // Lifecycle матриц (Спринт 16): чистка осиротевших клонов/агрегаторов.
    if (req.method === "POST" && pathname === "/api/matrix-cleanup") {
      if (!deps.cleanupMatrixOrphans) {
        sendJson(res, 501, { success: false, error: "Очистка не поддерживается." });
        return;
      }
      try {
        const removed = await deps.cleanupMatrixOrphans();
        sendJson(res, 200, {
          success: true,
          removed,
          message:
            removed.length > 0
              ? `Удалено осиротевших задач: ${removed.length}.`
              : "Осиротевших задач не найдено.",
        });
      } catch (err: any) {
        sendJson(res, 500, {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    // Удаление задачи: POST /api/delete/:name (кнопка «Удалить» в таблице).
    const deleteMatch = req.method === "POST" && pathname.match(/^\/api\/delete\/(.+)$/);
    if (deleteMatch) {
      const name = deleteMatch[1].replace(/\/+$/, "");
      if (!name) {
        sendJson(res, 400, { success: false, error: "Не передано имя задачи." });
        return;
      }
      try {
        await deps.deleteTask(name);
        sendJson(res, 200, { success: true, message: `Задача "${name}" удалена.` });
      } catch (err: any) {
        sendJson(res, 500, {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    // Любой неизвестный путь — строго JSON, чтобы клиент не пытался
    // разобрать HTML/картинку как JSON.
    sendJson(res, 404, { error: "Not found" });
  } catch (err: any) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[windows-scheduler] Ошибка обработки запроса ${req.url}: ${message}`);
    if (res.headersSent) {
      res.destroy();
      return;
    }
    sendJson(res, 500, { error: message });
  }
}

const JSON_TYPE = "application/json; charset=utf-8";

/** Отправляет JSON-ответ (гарантирует Content-Type и корректный статус). */
function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  send(res, status, JSON_TYPE, JSON.stringify(payload));
}

/** Отправляет ответ с телом и закрывает соединение. */
function send(res: http.ServerResponse, status: number, contentType: string, body: string): void {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    [DASHBOARD_HEADER]: DASHBOARD_MARKER,
  });
  res.end(body);
}

/** Отправляет бинарный файл (скачивание .db-бэкапа). */
function sendBuffer(
  res: http.ServerResponse,
  status: number,
  contentType: string,
  body: Buffer,
  filename: string
): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": String(body.byteLength),
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    [DASHBOARD_HEADER]: DASHBOARD_MARKER,
  });
  res.end(body);
}

/**
 * Список задач + метрики по каждой задаче, посчитанные из history.json
 * (колонка «Метрики» в таблице дашборда).
 */
async function collectTasksWithMetrics(deps: DashboardDeps) {
  const [history, tasks] = await Promise.all([loadHistory(), deps.getTasks()]);

  const byTask = new Map<string, TaskMetrics>();
  for (const r of history) {
    const key = String(r.taskName || "").toLowerCase();
    if (!key) continue;
    const m = byTask.get(key) ?? { total: 0, success: 0, error: 0 };
    m.total += 1;
    if (r.status === "success") m.success += 1;
    else m.error += 1;
    byTask.set(key, m);
  }

  return tasks.map((t) => ({
    ...t,
    metrics: byTask.get(String(t.name).toLowerCase()) ?? { total: 0, success: 0, error: 0 },
  }));
}

/**
 * HTML-страница дашборда: тёмная тема + зимнее оформление (снежинки ❄).
 * Данные тянутся fetch'ем с JSON-API и перерисовываются каждые 5 секунд.
 * Внутри строковой константы не используются бэктики и ${}, чтобы не экранировать.
 */
function renderPage(): string {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${getSchedulerTitle()} — Веб-дашборд</title>
<style>
  :root {
    --bg1: #0f172a; --bg2: #000000; --panel: #141c2b; --panel2: #1b2436;
    --border: #24314a; --text: #e6ecf5; --muted: #8fa0b8;
    --accent: #7ec8fa; --ok: #34c759; --err: #ff5a5f; --run: #f5a623;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, Roboto, sans-serif;
    color: var(--text);
    background: linear-gradient(180deg, var(--bg1) 0%, var(--bg2) 100%);
    min-height: 100vh;
    overflow-x: hidden;
  }
  .snow { position: fixed; top: -40px; color: #cfe8ff; opacity: .55; pointer-events: none; z-index: 0;
    animation: fall linear infinite; user-select: none; }
  @keyframes fall {
    0% { transform: translateY(-40px) rotate(0deg); }
    100% { transform: translateY(110vh) rotate(360deg); }
  }
  .wrap { position: relative; z-index: 1; max-width: 1740px; margin: 0 auto; padding: 28px 20px 60px; }
  .table-scroll { overflow-x: auto; }
  header { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 22px; }
  h1 { margin: 0; font-size: 24px; font-weight: 800; letter-spacing: .2px; }
  .sub { margin-top: 5px; font-size: 11px; font-weight: 600; letter-spacing: 1.2px; text-transform: uppercase; color: var(--muted); }
  .cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 22px; }
  @media (min-width: 900px) { .cards { grid-template-columns: repeat(6, 1fr); } }
  @media (max-width: 520px) { .cards { grid-template-columns: repeat(2, 1fr); } }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; min-width: 0; }
  .card .num { font-size: 26px; font-weight: 800; }
  .card .lbl { margin-top: 2px; font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 1px; }
  .ok { color: var(--ok); } .err { color: var(--err); } .neu { color: var(--accent); }
  table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
  th, td { padding: 9px 9px; text-align: left; font-size: 13px; border-bottom: 1px solid var(--border); vertical-align: middle; }
  th { background: var(--panel2); color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .8px; }
  tr:last-child td { border-bottom: none; }
  tbody tr { transition: background .15s ease; }
  tbody tr:hover { background: rgba(126, 200, 250, 0.06); }
  .name { font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 200px; }
  .cron { font-family: Consolas, Menlo, monospace; color: var(--accent); white-space: nowrap; }
  .badge { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border-radius: 999px; font-size: 11px; font-weight: 700; white-space: nowrap; }
  .badge.run { background: rgba(245, 166, 35, .14); color: var(--run); }
  .badge.okb { background: rgba(52, 199, 89, .14); color: var(--ok); }
  .badge.errb { background: rgba(255, 90, 95, .14); color: var(--err); }
  .badge.unk { background: rgba(143, 160, 184, .14); color: var(--muted); }
  .badge.part { background: rgba(255, 159, 10, .14); color: #ff9f0a; }
  .matrix-toggle { background: transparent; border: none; color: var(--muted); cursor: pointer; padding: 0 2px; font-size: 12px; }
  .matrix-toggle:hover { color: var(--accent); }
  .matrix-badge { font-size: 11px; color: #ff9f0a; white-space: nowrap; }
  .clone-badge { font-size: 11px; color: var(--muted); white-space: nowrap; }
  tr.clone-row td { background: rgba(126, 200, 250, 0.03); }
  tr.clone-row .name { padding-left: 26px; font-weight: 500; color: #cfd7e3; }
  .metrics { font-size: 12px; color: var(--muted); white-space: nowrap; }
  .metrics b { color: var(--text); }
  .deps { font-size: 12px; color: var(--accent); white-space: nowrap; }
  .model { font-size: 12px; color: #c084fc; white-space: nowrap; max-width: 165px; overflow: hidden; text-overflow: ellipsis; display: inline-block; vertical-align: bottom; }
  .prio { font-size: 12px; color: #f5a623; white-space: nowrap; }
  .hist { margin-top: 18px; background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 14px 18px; }
  .hist h2 { margin: 0 0 10px; font-size: 14px; font-weight: 600; }
  .hist-row { display: flex; flex-wrap: wrap; align-items: baseline; gap: 10px; padding: 5px 0; border-bottom: 1px solid var(--border); font-size: 12px; }
  .hist-row:last-child { border-bottom: none; }
  .hist-time { color: var(--muted); white-space: nowrap; }
  .hist-task { color: var(--text); font-weight: 600; }
  .hist-model { color: #c084fc; }
  .hist-hook { white-space: nowrap; }
  .hist-hook.okh { color: #34c759; }
  .hist-hook.errh { color: #ff3b30; }
  .whatif-text { margin-top: 10px; font-size: 12px; color: var(--muted); line-height: 1.5; }
  .whatif-text b { color: var(--text); }
  .wi-table { width: 100%; border-collapse: collapse; font-size: 12px; }
  .wi-table th { text-align: left; color: var(--muted); font-weight: 600; padding: 4px 8px; border-bottom: 1px solid var(--border); }
  .wi-table td { padding: 4px 8px; border-bottom: 1px solid var(--border); color: var(--text); }
  .wi-table tr:last-child td { border-bottom: none; }
  .wi-table .wi-model { color: #c084fc; }
  .graph { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 12px 16px; margin-bottom: 16px; }
  .graph-title { font-size: 11px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase; color: var(--muted); margin-bottom: 6px; }
  .chain-line { font-size: 13px; padding: 3px 0; }
  .chain-line .dep { color: var(--accent); }
  .chain-line .arrow { color: var(--muted); margin: 0 6px; }
  .chain-line .target { color: var(--text); font-weight: 700; }
  .btn { border: none; border-radius: 6px; padding: 6px 12px; font-size: 12px; font-weight: 600; cursor: pointer; transition: opacity .15s ease, background .15s ease; }
  /* Действия держим в одну строку: иначе колонка сжимается и строки раздуваются. */
  td.actions { white-space: nowrap; }
  td.actions .btn { margin-right: 4px; padding: 6px 9px; }
  td.actions .btn:last-child { margin-right: 0; }
  .btn:disabled { opacity: .5; cursor: not-allowed; }
  .btn-run { background: #1f6f43; color: #d6ffe4; }
  .btn-run:hover { background: #278a53; }
  .btn-del { background: #5a1d21; color: #ffd4d6; }
  .btn-dry { background: #1d3a5a; color: #d4e6ff; }
  .btn-cancel { background: #5a3a1d; color: #ffe8cc; }
  .btn-cancel:hover { background: #734c26; }
  .btn-del:hover { background: #73262b; }
  .btn-db { display: inline-block; text-decoration: none; background: #1d3a5f; color: #cfe6ff; }
  .btn-db:hover { background: #264b78; }
  .db-badge { color: #8fe3a8; white-space: nowrap; }
  .ws-badge { display: inline-block; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--border); font-size: 11px; font-weight: 700; white-space: nowrap; }
  .ws-summary { margin-bottom: 12px; font-size: 12px; color: var(--muted); }
  .ws-tabs { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 10px; }
  .ws-tab { border: 1px solid var(--border); background: var(--panel2); color: var(--text); border-radius: 999px; padding: 4px 10px; font-size: 11px; cursor: pointer; }
  .ws-tab.active { border-color: var(--accent); color: var(--accent); }
  .empty { padding: 40px 16px; text-align: center; color: var(--muted); font-size: 13px; }
  .warn { margin-bottom: 16px; padding: 10px 14px; border: 1px solid rgba(255,90,95,.55); border-radius: 8px; background: rgba(255,90,95,.12); color: #ffd4d6; font-size: 12px; line-height: 1.45; }
  footer { margin-top: 18px; font-size: 11px; color: var(--muted); text-align: center; }
  #toast { position: fixed; right: 18px; bottom: 18px; z-index: 10; display: flex; flex-direction: column; gap: 8px; }
  .toast { background: var(--panel2); border: 1px solid var(--border); border-radius: 8px; padding: 10px 14px; font-size: 12px; box-shadow: 0 6px 18px rgba(0,0,0,.4); }
  .toast.ok2 { border-color: rgba(52,199,89,.5); }
  .toast.err2 { border-color: rgba(255,90,95,.5); }
</style>
</head>
<body>
  <div class="wrap">
    <header>
      <div>
        <h1>❄️ ${getSchedulerTitle()} ❄️</h1>
        <div class="sub">Локальный веб-дашборд · Local AI CI/CD Orchestrator</div>
      </div>
      <div style="text-align:right">
        <a class="btn btn-db" href="/api/export-db" download>💾 Скачать БД</a>
        <button class="btn" data-act="cleanup-orphans" title="Удалить клоны и агрегаторы матриц, чьи родители уже удалены">🧹 Осиротевшие клоны</button>
        <div class="sub" id="updated" style="margin-top:8px"></div>
      </div>
    </header>

    <div class="warn" id="server-warn" style="display:none"></div>

    <div class="cards">
      <div class="card"><div class="num neu" id="m-total">—</div><div class="lbl">Всего запусков</div></div>
      <div class="card"><div class="num ok" id="m-success">—</div><div class="lbl">Успешных</div></div>
      <div class="card"><div class="num err" id="m-error">—</div><div class="lbl">С ошибками</div></div>
      <div class="card"><div class="num" id="m-tasks">—</div><div class="lbl">Задач в системе</div></div>
      <div class="card"><div class="num neu" id="m-tokens">—</div><div class="lbl">Всего токенов</div></div>
      <div class="card"><div class="num" id="m-cost">—</div><div class="lbl">Примерная стоимость</div></div>
    </div>

    <div class="graph" id="graph" style="display:none">
      <div class="graph-title">🔗 Граф зависимостей (DAG)</div>
      <div id="graph-lines"></div>
    </div>

    <div class="ws-summary" id="ws-summary">📦 0 workspace · 0 задач</div>
    <div class="ws-tabs" id="ws-tabs"></div>

    <div class="table-scroll">
    <table>
      <thead>
        <tr>
          <th>Имя</th><th>Статус</th><th>Cron</th><th>📦 Workspace</th><th>Модель</th><th>Приоритет</th><th>Зависимости</th><th>Метрики</th><th>Действия</th>
        </tr>
      </thead>
      <tbody id="rows"><tr><td colspan="9" class="empty">Загрузка…</td></tr></tbody>
    </table>
    </div>

    <div class="hist">
      <h2>📜 История выполнений</h2>
      <div id="history"><div class="empty">Загрузка…</div></div>
    </div>

    <div class="hist">
      <h2>📊 What-If: Анализ моделей</h2>
      <div id="whatif-table"><div class="empty">Загрузка…</div></div>
      <div class="whatif-text" id="whatif-text"></div>
    </div>

    <footer>Данные обновляются автоматически каждые 5 секунд · <span id="server-url">http://localhost:3782</span> · <span class="db-badge">БД: ✅ SQLite (WAL)</span></footer>
  </div>
  <div id="toast"></div>

<script>
(function () {
  'use strict';

  var rows = document.getElementById('rows');
  var updated = document.getElementById('updated');
  var allTasks = [];
  var allWorkspaces = [];
  var activeWorkspace = 'all';
  /** Раскрытые родители матриц (имя → true). */
  var expandedMatrixParents = {};

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  function toast(msg, kind) {
    var box = document.getElementById('toast');
    var el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(function () { el.remove(); }, 3500);
  }

  function showServerWarn(msg) {
    var el = document.getElementById('server-warn');
    if (!el) return;
    if (!msg) {
      el.style.display = 'none';
      el.textContent = '';
      return;
    }
    el.style.display = 'block';
    el.textContent = msg;
  }

  // Читает ответ как JSON и никогда не пытается парсить HTML/PNG.
  // Всегда читает тело как текст, чтобы при ошибке показать его в консоли.
  function readJson(res) {
    var ct = (res.headers.get('content-type') || '').toLowerCase();
    var marker = res.headers.get('x-plugin-dashboard');
    return res.text().then(function (text) {
      // Антивирусные прокси часто отвечают статусом 499 или картинкой вместо JSON.
      var avBlocked = res.status === 499 || ct.indexOf('image/') === 0;
      if (avBlocked) {
        console.error(
          'Похоже, соединение перехвачено антивирусом. URL: ' + res.url +
          ' | статус: ' + res.status +
          ' | Content-Type: ' + (ct || '(пусто)') +
          '\\nПервые 2000 символов ответа:\\n' + text.slice(0, 2000)
        );
        throw new Error(
          'Похоже, ваш антивирус блокирует соединение. ' +
          'Добавьте localhost в исключения или смените порт.'
        );
      }
      if (ct.indexOf('application/json') === -1) {
        console.error(
          'Сервер вернул не JSON. URL: ' + res.url +
          ' | статус: ' + res.status +
          ' | Content-Type: ' + (ct || '(пусто)') +
          '\\nПервые 2000 символов ответа:\\n' + text.slice(0, 2000)
        );
        if (marker !== 'opencode-windows-scheduler') {
          console.error(
            'Ответ пришёл не от дашборда плагина: нет заголовка x-plugin-dashboard. ' +
            'Похоже, на этом порту работает другой сервис.'
          );
        }
        throw new Error('Сервер вернул не JSON. Проверьте консоль.');
      }
      var data;
      try {
        data = text ? JSON.parse(text) : null;
      } catch (parseErr) {
        console.error(
          'Сервер прислал невалидный JSON. URL: ' + res.url +
          ' | статус: ' + res.status +
          '\\nПервые 2000 символов ответа:\\n' + text.slice(0, 2000)
        );
        throw new Error('Сервер вернул не JSON. Проверьте консоль.');
      }
      if (marker !== 'opencode-windows-scheduler') {
        console.warn(
          'В ответе нет заголовка x-plugin-dashboard — возможно, это не дашборд плагина.'
        );
      }
      if (!res.ok) {
        var message = data && data.error ? data.error : 'HTTP ' + res.status;
        throw new Error(message);
      }
      return data;
    });
  }

  function badge(status) {
    if (status === 'running') return '<span class="badge run">🟡 Выполняется</span>';
    if (status === 'success') return '<span class="badge okb">🟢 Готова</span>';
    if (status === 'error') return '<span class="badge errb">🔴 Ошибка</span>';
    if (status === 'partial') return '<span class="badge part">🟠 Частично</span>';
    return '<span class="badge unk">⚪ Неизвестно</span>';
  }

  /** Агрегат матрицы для родителя (Спринт 15). */
  function matrixSummaryHtml(t) {
    var s = t.matrixSummary;
    if (!t.isMatrixParent || !s) return '';
    var color = s.status === 'success' ? 'var(--ok)'
      : s.status === 'error' ? 'var(--err)'
      : s.status === 'partial' ? '#ff9f0a'
      : 'var(--run)';
    return '<div class="matrix-badge" style="color:' + color + '" title="' + esc(s.message) + '">' +
      '📦 Matrix: ' + s.successCount + '/' + s.totalCount + ' успешных' +
      (s.errorCount ? ' · ❌ ' + s.errorCount : '') +
      (s.pendingCount ? ' · ⏳ ' + s.pendingCount : '') +
      '</div>';
  }

  function metricsHtml(m) {
    var mm = m || { total: 0, success: 0, error: 0 };
    return 'Всего: <b>' + mm.total + '</b> · ✅ <b>' + mm.success + '</b> · ❌ <b>' + mm.error + '</b>';
  }

  function depsHtml(t) {
    var deps = Array.isArray(t.dependsOn) ? t.dependsOn : [];
    if (deps.length === 0) return '<span class="metrics">—</span>';
    var parts = [];
    for (var i = 0; i < deps.length; i++) parts.push('[' + esc(deps[i]) + ']');
    return '<span class="deps" title="Зависит от: ' + esc(deps.join(', ')) + '">🔗 ' + parts.join(' + ') + '</span>';
  }

  function modelHtml(t) {
    if (!t.model) return '<span class="metrics">—</span>';
    return '<span class="model" title="Модель: ' + esc(t.model) + '">🧠 ' + esc(t.model) + '</span>';
  }

  function priorityLabel(value) {
    if (value >= 10) return 'Критический';
    if (value >= 8) return 'Высокий';
    if (value <= 3) return 'Низкий';
    return 'Обычный';
  }

  function priorityHtml(t) {
    var p = typeof t.priority === 'number' ? t.priority : 5;
    if (p === 5) return '<span class="metrics">—</span>';
    return '<span class="prio" title="Приоритет: ' + p + ' из 10">🚀 ' + priorityLabel(p) + '</span>';
  }

  function renderHistory(records) {
    var box = document.getElementById('history');
    if (!box) return;
    if (!records || records.length === 0) {
      box.innerHTML = '<div class="empty" style="padding:16px">Запусков пока нет.</div>';
      return;
    }
    var html = '';
    var limit = Math.min(records.length, 10);
    for (var i = 0; i < limit; i++) {
      var r = records[i];
      var ok = r.status === 'success';
      html += '<div class="hist-row">' +
        '<span class="hist-time">' + esc(new Date(r.startedAt).toLocaleString('ru-RU')) + '</span>' +
        '<span class="hist-task">' + esc(r.taskName) + '</span>' +
        '<span class="badge ' + (ok ? 'okb' : 'errb') + '">' + (ok ? '✅ Успех' : '❌ Ошибка') + '</span>' +
        '<span class="metrics">' + (r.durationMs != null ? r.durationMs + ' мс' : '—') + '</span>' +
        (r.model ? '<span class="hist-model" title="Модель">🧠 ' + esc(r.model) + '</span>' : '') +
        (r.preFlightStatus && r.preFlightStatus !== 'skipped'
          ? '<span class="hist-hook ' + (r.preFlightStatus === 'success' ? 'okh' : 'errh') + '" title="Pre-flight: ' + esc(r.preFlightStatus) + '">⚡ pre: ' + (r.preFlightStatus === 'success' ? '✅' : '❌') + '</span>'
          : '') +
        (r.postFlightStatus && r.postFlightStatus !== 'skipped'
          ? '<span class="hist-hook ' + (r.postFlightStatus === 'success' ? 'okh' : 'errh') + '" title="Post-flight: ' + esc(r.postFlightStatus) + '">⚡ post: ' + (r.postFlightStatus === 'success' ? '✅' : '❌') + '</span>'
          : '') +
        (r.allowedTools && r.allowedTools.length ? '<span class="hist-hook" title="allowedTools: ' + esc(r.allowedTools.join(', ')) + '">🔒 allowed=' + esc(r.allowedTools.join(',')) + '</span>' : '') +
        (r.deniedTools && r.deniedTools.length ? '<span class="hist-hook" title="deniedTools: ' + esc(r.deniedTools.join(', ')) + '">🔒 denied=' + esc(r.deniedTools.join(',')) + '</span>' : '') +
        (r.error ? '<span class="metrics" title="' + esc(r.error) + '">⚠ ' + esc(String(r.error).slice(0, 80)) + '</span>' : '') +
        '</div>';
    }
    box.innerHTML = html;
  }

  function renderModelsAnalysis(data) {
    var box = document.getElementById('whatif-table');
    var text = document.getElementById('whatif-text');
    if (!box || !text) return;
    var models = (data && data.models) || [];
    var totals = (data && data.totals) || { totalRuns: 0, totalTokens: 0, totalCost: 0 };
    var whatIf = (data && data.whatIf) || [];

    if (models.length === 0) {
      box.innerHTML = '<div class="empty" style="padding:16px">Пока нет запусков с данными о модели.</div>';
      text.innerHTML = '';
      return;
    }

    var html = '<table class="wi-table"><thead><tr>' +
      '<th>Модель</th><th>Запусков</th><th>Токенов</th><th>Стоимость</th><th>Средняя длительность</th><th>Успешных</th>' +
      '</tr></thead><tbody>';
    for (var i = 0; i < models.length; i++) {
      var m = models[i];
      html += '<tr>' +
        '<td class="wi-model">🧠 ' + esc(m.model) + '</td>' +
        '<td>' + m.totalRuns + '</td>' +
        '<td>' + Number(m.totalTokens || 0).toLocaleString('ru-RU') + '</td>' +
        '<td>$' + Number(m.totalCost || 0).toFixed(4) + '</td>' +
        '<td>' + (m.avgDuration != null ? m.avgDuration + ' мс' : '—') + '</td>' +
        '<td>' + (m.successRate != null ? m.successRate + '%' : '—') + '</td>' +
        '</tr>';
    }
    html += '</tbody></table>';
    box.innerHTML = html;

    var gpt = null;
    var deepseek = null;
    for (var j = 0; j < whatIf.length; j++) {
      if (whatIf[j].model === 'openai/gpt-4o') gpt = whatIf[j];
      if (whatIf[j].model === 'deepseek/deepseek-coder') deepseek = whatIf[j];
    }
    var parts = [];
    if (gpt) {
      parts.push('Если бы все запуски выполнялись через <b>openai/gpt-4o</b>, это стоило бы ~<b>$' + Number(gpt.cost).toFixed(4) + '</b> (' + gpt.pricePerMillion + ' $/1M токенов).');
    }
    if (deepseek) {
      parts.push('Если через <b>deepseek/deepseek-coder</b> — <b>$' + Number(deepseek.cost).toFixed(4) + '</b> (' + deepseek.pricePerMillion + ' $/1M токенов).');
    }
    parts.push('Всего запусков: <b>' + totals.totalRuns + '</b>, токенов: <b>' + Number(totals.totalTokens || 0).toLocaleString('ru-RU') + '</b>, фактическая стоимость: <b>$' + Number(totals.totalCost || 0).toFixed(4) + '</b>.');
    text.innerHTML = parts.join(' ');
  }

  function renderGraph(tasks) {
    var graph = document.getElementById('graph');
    var box = document.getElementById('graph-lines');
    if (!graph || !box) return;
    if (!tasks || tasks.length === 0) { graph.style.display = 'none'; return; }
    var html = '';
    for (var i = 0; i < tasks.length; i++) {
      var t = tasks[i];
      var deps = Array.isArray(t.dependsOn) ? t.dependsOn : [];
      if (deps.length === 0) continue;
      var parts = [];
      for (var j = 0; j < deps.length; j++) {
        parts.push('<span class="dep">[' + esc(deps[j]) + ']</span>');
      }
      html += '<div class="chain-line">' + parts.join(' <span class="arrow">+</span> ') +
              '<span class="arrow">➔</span><span class="target">[' + esc(t.name) + ']</span></div>';
    }
    if (!html) { graph.style.display = 'none'; return; }
    box.innerHTML = html;
    graph.style.display = 'block';
  }

  function actionButtons(t) {
    var isClone = !!t.matrixParentId;
    var cancel = t.isMatrixParent
      ? '<button class="btn btn-cancel" data-act="cancel" data-name="' + esc(t.name) + '" title="Отменить выполняющиеся клоны матрицы">⛔ Отменить</button> '
      : '';
    var remove = isClone
      ? '<button class="btn btn-del" disabled title="Клон удаляется только вместе с матрицей">🗑 Удалить</button>'
      : '<button class="btn btn-del" data-act="del" data-name="' + esc(t.name) + '"' +
        (t.isMatrixParent ? ' title="Удалить матрицу вместе со всеми клонами"' : '') + '>🗑 Удалить</button>';
    return '<button class="btn btn-run" data-act="run" data-name="' + esc(t.name) + '">▶ Запустить</button> ' +
           '<button class="btn btn-dry" data-act="simulate" data-name="' + esc(t.name) + '" title="Dry-Run: симуляция конвейера без запуска">🧪 Симуляция</button> ' +
           cancel + remove;
  }

  function workspaceHtml(t) {
    if (!t.workspaceName) return '<span class="metrics">—</span>';
    var color = t.workspaceColor || '#8b949e';
    return '<span class="ws-badge" style="color:' + esc(color) + ';border-color:' + esc(color) + '" title="Workspace: ' + esc(t.workspaceName) + '">📦 ' + esc(t.workspaceName) + '</span>';
  }

  function renderWorkspaceTabs(workspaces, tasks) {
    var box = document.getElementById('ws-tabs');
    var summary = document.getElementById('ws-summary');
    if (summary) {
      var matrixCount = 0;
      for (var m = 0; m < (tasks || []).length; m++) {
        if (tasks[m].isMatrixParent) matrixCount++;
      }
      summary.textContent = '📦 ' + workspaces.length + ' workspace · ' + tasks.length + ' задач' +
        (matrixCount ? ' · 📦 матриц: ' + matrixCount : '');
    }
    if (!box) return;
    var html = '<button class="ws-tab' + (activeWorkspace === 'all' ? ' active' : '') + '" data-ws="all">Все</button>';
    for (var i = 0; i < workspaces.length; i++) {
      var w = workspaces[i];
      var color = w.color || '#8b949e';
      html += '<button class="ws-tab' + (activeWorkspace === w.id ? ' active' : '') + '" data-ws="' + esc(w.id) + '" style="color:' + esc(color) + '">📦 ' + esc(w.name) + '</button>';
    }
    html += '<button class="ws-tab' + (activeWorkspace === 'matrix' ? ' active' : '') + '" data-ws="matrix" title="Только родители матриц и их клоны">📦 Матрицы</button>';
    html += '<button class="ws-tab' + (activeWorkspace === 'none' ? ' active' : '') + '" data-ws="none">Без workspace</button>';
    box.innerHTML = html;
  }

  function renderTasks(tasks) {
    var all = tasks || [];
    var clonesByParent = {};
    for (var c = 0; c < all.length; c++) {
      var parentKey = all[c].matrixParentId ? String(all[c].matrixParentId).toLowerCase() : '';
      if (!parentKey) continue;
      if (!clonesByParent[parentKey]) clonesByParent[parentKey] = [];
      clonesByParent[parentKey].push(all[c]);
    }

    var visible = [];
    for (var k = 0; k < all.length; k++) {
      var candidate = all[k];
      var isMatrix = !!(candidate.isMatrixParent || candidate.matrixParentId);
      if (activeWorkspace === 'matrix' ? isMatrix :
          activeWorkspace === 'all' ||
          (activeWorkspace === 'none' && !candidate.workspaceId) ||
          candidate.workspaceId === activeWorkspace) {
        visible.push(candidate);
      }
    }

    // Если родитель виден, его клоны рисуются внутри сворачиваемого блока.
    var visibleParents = {};
    for (var p = 0; p < visible.length; p++) {
      if (visible[p].isMatrixParent) visibleParents[String(visible[p].name).toLowerCase()] = true;
    }

    if (visible.length === 0) {
      rows.innerHTML = '<tr><td colspan="9" class="empty">🎄 Задач пока нет. Самое время украсить ёлку!</td></tr>';
      return;
    }
    var html = '';
    var shown = 0;
    for (var i = 0; i < visible.length; i++) {
      var t = visible[i];
      if (t.matrixParentId && visibleParents[String(t.matrixParentId).toLowerCase()]) continue;
      var key = String(t.name).toLowerCase();
      var clones = clonesByParent[key] || [];
      var expanded = !!expandedMatrixParents[key];
      html += taskRow(t, false, clones.length, expanded);
      shown++;
      if (clones.length > 0 && expanded) {
        for (var j = 0; j < clones.length; j++) {
          html += taskRow(clones[j], true, 0, false);
          shown++;
        }
      }
    }
    if (shown === 0) {
      rows.innerHTML = '<tr><td colspan="9" class="empty">🎄 Задач пока нет. Самое время украсить ёлку!</td></tr>';
      return;
    }
    rows.innerHTML = html;
  }

  /** Строка таблицы задач; клоны матрицы помечаются ↳ matrix <parent>. */
  function taskRow(t, isClone, cloneCount, expanded) {
    var cron = t.triggerType === 'file'
      ? '👁️ файл: ' + (t.watchPath || '')
      : t.triggerType === 'mcp-event'
      ? '📡 ' + ((t.mcpEvent && t.mcpEvent.event) || 'MCP Event')
      : (t.schedule || '—');
    var nameHtml = esc(t.name);
    var matrixLimit = t.matrix && t.matrix.concurrency
      ? ' ⚙' + esc(String(t.matrix.concurrency))
      : '';
    var matrixOverridden = t.matrix && t.matrix.overrides
      ? Object.keys(t.matrix.overrides).length
      : 0;
    var matrixTitle = t.matrix
      ? ' Matrix fan-out: ' + (t.matrix.workspaceIds ? t.matrix.workspaceIds.length : 0) +
        ' клонов, стратегия: ' + (t.matrix.strategy || 'parallel') +
        (t.matrix.concurrency ? ', одновременно: ' + t.matrix.concurrency : '') +
        (matrixOverridden ? ', переопределено workspace: ' + matrixOverridden : '')
      : '';
    if (isClone) {
      nameHtml = '<span class="clone-badge">↳ matrix ' + esc(t.matrixParentId || '') + '</span><br>' + esc(t.name);
    } else if (cloneCount > 0) {
      nameHtml = '<button class="matrix-toggle" data-matrix="' + esc(t.name) + '" title="Показать/скрыть клоны">' +
        (expanded ? '▾' : '▸') + '</button> ' + esc(t.name) +
        '<div class="matrix-badge" title="' + esc(matrixTitle) + '">📦 Matrix (' + cloneCount + ')' + matrixLimit + '</div>';
    }
    return '<tr' + (isClone ? ' class="clone-row"' : '') + '>' +
      '<td class="name" title="' + esc(t.name) + '">' + nameHtml + '</td>' +
      '<td>' + badge(t.status) + matrixSummaryHtml(t) + '</td>' +
      '<td class="cron">' + esc(cron) + '</td>' +
      '<td>' + workspaceHtml(t) + '</td>' +
      '<td>' + modelHtml(t) + '</td>' +
      '<td>' + priorityHtml(t) + '</td>' +
      '<td>' + depsHtml(t) + '</td>' +
      '<td class="metrics">' + metricsHtml(t.metrics) + '</td>' +
      '<td class="actions">' + actionButtons(t) + '</td>' +
      '</tr>';
  }

  // Устойчивая загрузка: антивирусы иногда блокируют отдельные URL
  // (например, /api/metrics) статусом 499 и картинкой вместо JSON.
  // Один сбой не должен ломать весь дашборд.
  function safeJson(url, fallback) {
    return fetch(url, { cache: 'no-store' })
      .then(readJson)
      .catch(function (err) {
        console.error('Дашборд: не удалось загрузить ' + url, err);
        return fallback;
      });
  }

  // /api/metrics может быть перехвачен антивирусом; /api/summary — тот же
  // обработчик на случай, если блокировка привязана к имени URL.
  function loadMetricsJson() {
    return fetch('/api/metrics', { cache: 'no-store' })
      .then(readJson)
      .catch(function () {
        return fetch('/api/summary', { cache: 'no-store' })
          .then(readJson)
          .catch(function (err) {
            console.error('Дашборд: метрики недоступны', err);
            return {};
          });
      });
  }

  async function loadAll() {
    try {
      var results = await Promise.all([
        safeJson('/api/tasks', null),
        loadMetricsJson(),
        safeJson('/api/history', { records: [] }),
        safeJson('/api/models-analysis', { models: [], totals: {}, whatIf: [] }),
        safeJson('/api/workspaces', { workspaces: [] })
      ]);
      var tasks = (results[0] && results[0].tasks) || [];
      var m = results[1] || {};
      var history = (results[2] && results[2].records) || [];
      var modelsAnalysis = results[3] || { models: [], totals: {}, whatIf: [] };
      allTasks = tasks;
      allWorkspaces = (results[4] && results[4].workspaces) || [];
      renderWorkspaceTabs(allWorkspaces, allTasks);
      document.getElementById('m-total').textContent = m.total != null ? m.total : '—';
      document.getElementById('m-success').textContent = m.success != null ? m.success : '—';
      document.getElementById('m-error').textContent = m.error != null ? m.error : '—';
      document.getElementById('m-tasks').textContent = String(tasks.length);
      document.getElementById('m-tokens').textContent = m.tokens != null ? Number(m.tokens).toLocaleString('ru-RU') : '—';
      document.getElementById('m-cost').textContent = m.costUsd != null ? '$' + Number(m.costUsd).toFixed(2) : '—';
      renderTasks(tasks);
      renderGraph(tasks);
      renderHistory(history);
      renderModelsAnalysis(modelsAnalysis);
      showServerWarn(results[0] ? null : 'Не удалось загрузить список задач — остальные блоки обновлены. Подробности в консоли (F12).');
      updated.textContent = 'Обновлено: ' + new Date().toLocaleTimeString();
    } catch (err) {
      var msg = err && err.message ? err.message : String(err);
      showServerWarn('Не удалось получить данные дашборда: ' + msg + ' Откройте консоль браузера (F12) — там тело ответа сервера.');
      rows.innerHTML = '<tr><td colspan="9" class="empty">❌ Ошибка загрузки данных: ' + esc(msg) + '</td></tr>';
    }
  }

  document.addEventListener('click', function (e) {
    var matrixBtn = e.target && e.target.closest ? e.target.closest('button[data-matrix]') : null;
    if (!matrixBtn) return;
    var matrixName = matrixBtn.getAttribute('data-matrix') || '';
    var matrixKey = matrixName.toLowerCase();
    if (expandedMatrixParents[matrixKey]) delete expandedMatrixParents[matrixKey];
    else expandedMatrixParents[matrixKey] = true;
    renderTasks(allTasks);
  });

  document.addEventListener('click', function (e) {
    var tab = e.target && e.target.closest ? e.target.closest('button[data-ws]') : null;
    if (!tab) return;
    activeWorkspace = tab.getAttribute('data-ws') || 'all';
    renderWorkspaceTabs(allWorkspaces, allTasks);
    renderTasks(allTasks);
  });

  document.addEventListener('click', async function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('button[data-act]') : null;
    if (!btn) return;
    var act = btn.getAttribute('data-act');
    var name = btn.getAttribute('data-name');

    // Спринт 16: чистка осиротевших клонов (кнопка в шапке, без имени задачи).
    if (act === 'cleanup-orphans') {
      btn.disabled = true;
      try {
        var cleanRes = await fetch('/api/matrix-cleanup', { method: 'POST', cache: 'no-store' });
        var cleanData = await readJson(cleanRes);
        toast(cleanData.success ? (cleanData.message || 'Готово') : (cleanData.error || 'Ошибка очистки'), cleanData.success ? 'ok2' : 'err2');
      } catch (err) {
        toast('Ошибка: ' + (err.message || err), 'err2');
      }
      btn.disabled = false;
      await loadAll();
      return;
    }

    if (!name) return;
    if (act === 'simulate') {
      await showDryRun(name);
      return;
    }

    var task = null;
    for (var ti = 0; ti < (allTasks || []).length; ti++) {
      if (allTasks[ti].name === name) { task = allTasks[ti]; break; }
    }

    btn.disabled = true;
    try {
      var url = act === 'run' ? '/api/run/' + encodeURIComponent(name)
        : act === 'cancel' ? '/api/cancel-matrix/' + encodeURIComponent(name)
        : '/api/delete/' + encodeURIComponent(name);
      if (act === 'del') {
        var msg = task && task.isMatrixParent
          ? 'Удалить матрицу "' + name + '" вместе со всеми клонами и агрегатором?'
          : 'Удалить задачу "' + name + '"?';
        if (!window.confirm(msg)) {
          btn.disabled = false;
          return;
        }
      }
      if (act === 'cancel' && !window.confirm('Отменить выполняющиеся клоны матрицы "' + name + '"?')) {
        btn.disabled = false;
        return;
      }
      var res = await fetch(url, { method: 'POST', cache: 'no-store' });
      var data = await readJson(res);
      if (data.success) {
        toast(data.message || 'Готово', 'ok2');
      } else {
        toast(data.error || 'Не удалось выполнить действие', 'err2');
      }
    } catch (err) {
      toast('Ошибка: ' + (err.message || err), 'err2');
    }
    btn.disabled = false;
    await loadAll();
  });

  // ===== Dry-Run модалка (Спринт 14) =====
  function ensureDryModal() {
    var existing = document.getElementById('dry-modal');
    if (existing) return existing;
    var overlay = document.createElement('div');
    overlay.id = 'dry-modal';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:1000;padding:24px;';
    overlay.innerHTML = '<div class="card" style="max-width:820px;width:100%;max-height:85vh;overflow:auto;position:relative">' +
      '<button id="dry-close" style="position:absolute;top:8px;right:8px">✕</button>' +
      '<h3 style="margin-top:4px">🧪 Dry-Run: <span id="dry-title"></span></h3>' +
      '<div id="dry-body"></div>' +
      '</div>';
    document.body.appendChild(overlay);
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay || (e.target && e.target.id === 'dry-close')) overlay.remove();
    });
    return overlay;
  }

  async function showDryRun(name) {
    var overlay = ensureDryModal();
    var body = document.getElementById('dry-body');
    var title = document.getElementById('dry-title');
    if (title) title.textContent = name;
    if (body) body.innerHTML = '<div class="empty">Симуляция…</div>';
    try {
      var res = await fetch('/api/dry-run/' + encodeURIComponent(name), { cache: 'no-store' });
      var report = await readJson(res);
      if (!report.success) {
        if (body) body.innerHTML = '<div class="warn">❌ ' + esc(report.error || 'Симуляция не удалась') + '</div>';
        return;
      }
      var html = '';
      if (report.warnings && report.warnings.length) {
        html += '<div class="warn" style="margin-bottom:8px">⚠ Предупреждения:<br>' + report.warnings.map(function (w) { return '· ' + esc(w); }).join('<br>') + '</div>';
      }
      html += '<table class="wi-table"><thead><tr><th>#</th><th>Задача</th><th>Триггер</th><th>Workspace</th><th>cwd</th><th>Команда</th><th>Оценка</th></tr></thead><tbody>';
      for (var i = 0; i < report.tasks.length; i++) {
        var t = report.tasks[i];
        var est = '—';
        if (t.estimatedDurationSec != null || t.estimatedTokens != null) {
          est = (t.estimatedDurationSec != null ? t.estimatedDurationSec + ' с' : '') +
            (t.estimatedTokens != null ? ' · ' + t.estimatedTokens + ' ток.' : '') +
            (t.estimatedCostUsd != null ? ' · $' + Number(t.estimatedCostUsd).toFixed(4) : '');
        }
        var ws = t.workspace ? '📦 ' + esc(t.workspace.name) : '—';
        var matrixParent = t.matrixParent ? '<div class="matrix-badge">↳ matrix ' + esc(t.matrixParent) + '</div>' : '';
        var lock = t.roleScoped ? '<span class="hist-hook" title="allowed=' + esc((t.roleScoped.allowed || []).join(',')) + '; denied=' + esc((t.roleScoped.denied || []).join(',')) + '">🔒</span>' : '';
        html += '<tr><td>' + (i + 1) + '</td>' +
          '<td><b>' + esc(t.name) + '</b> ' + lock + matrixParent + '</td>' +
          '<td>' + esc(t.trigger) + '</td>' +
          '<td>' + ws + '</td>' +
          '<td class="metrics">' + esc(t.cwd || '(папка проекта)') + '</td>' +
          '<td class="metrics" style="max-width:260px;overflow-wrap:anywhere">' + esc(t.command) + '</td>' +
          '<td class="metrics">' + est + '</td></tr>';
      }
      html += '</tbody></table>';
      var totals = report.totals || {};
      if (totals.estimatedDurationSec != null || totals.estimatedTokens != null) {
        html += '<div class="metrics" style="margin-top:8px">Σ Оценка конвейера: ' +
          (totals.estimatedDurationSec != null ? totals.estimatedDurationSec + ' с · ' : '') +
          (totals.estimatedTokens != null ? totals.estimatedTokens + ' токенов · ' : '') +
          (totals.estimatedCostUsd != null ? '~$' + Number(totals.estimatedCostUsd).toFixed(4) : '') + '</div>';
      }
      if (body) body.innerHTML = html;
    } catch (err) {
      if (body) body.innerHTML = '<div class="warn">Ошибка: ' + esc(err.message || err) + '</div>';
    }
  }

  var serverUrl = document.getElementById('server-url');
  if (serverUrl) serverUrl.textContent = location.origin;

  loadAll();
  setInterval(loadAll, 5000);
})();
</script>

<script>
(function () {
  var flakes = ['❄', '❅', '❆'];
  for (var i = 0; i < 18; i++) {
    var s = document.createElement('span');
    s.className = 'snow';
    s.textContent = flakes[i % flakes.length];
    s.style.left = (Math.random() * 100) + 'vw';
    s.style.fontSize = (10 + Math.random() * 16) + 'px';
    s.style.animationDuration = (7 + Math.random() * 9) + 's';
    s.style.animationDelay = (-Math.random() * 12) + 's';
    document.body.appendChild(s);
  }
})();
</script>
</body>
</html>`;
}
