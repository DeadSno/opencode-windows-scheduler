/**
 * Тесты Спринта 18: аналитика и экспорт истории.
 * Запуск: node test-metrics.mjs (после npm run build).
 * Чистые функции — БД и сервер не нужны.
 */
import { buildAnalytics, csvCell, historyToCsv, recordCost, recordDate, ESTIMATED_COST_PER_1K_TOKENS_USD } from "./dist/core/analytics.js";

const results = [];
function check(name, cond) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? "OK  " : "FAIL"} ${name}`);
}

const now = new Date("2026-06-15T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const at = (daysAgo) => new Date(now.getTime() - daysAgo * DAY).toISOString();

const records = [
  { taskName: "build", status: "success", startedAt: at(0), durationMs: 1000, tokens: 1000, model: "m1" },
  { taskName: "build", status: "success", startedAt: at(1), durationMs: 3000, tokens: 2000, model: "m1" },
  { taskName: "build", status: "error", startedAt: at(2), durationMs: 2000, tokens: 500, model: "m2", error: "boom" },
  { taskName: "Deploy-matrix-Frontend", status: "success", startedAt: at(1), durationMs: 4000, costUsd: 0.5, model: "m2" },
  { taskName: "Deploy-matrix-Backend", status: "error", startedAt: at(3), durationMs: 8000, costUsd: 0.25, model: "m2" },
  { taskName: "Deploy", status: "partial", startedAt: at(3), durationMs: 0, costUsd: 0, model: "m2" },
  // Вне окна (20 дней назад при окне 14) — не должна попасть в отчёт.
  { taskName: "ancient", status: "success", startedAt: at(20), durationMs: 999, costUsd: 5 },
  // Незавершённый запуск — тоже не участвует.
  { taskName: "build", status: "running", startedAt: at(0), durationMs: 0 },
];

const tasks = [
  { name: "Deploy", matrixParentId: null },
  { name: "Deploy-matrix-Frontend", matrixParentId: "Deploy" },
  { name: "Deploy-matrix-Backend", matrixParentId: "Deploy" },
];

const report = buildAnalytics(records, { days: 14, now, topLimit: 2, tasks });

check(
  "totals считает только записи окна (без ancient и running)",
  report.totals.total === 6
);
check(
  "totals различает success/error/partial",
  report.totals.success === 3 && report.totals.error === 2 && report.totals.partial === 1
);
check(
  "successRate округляется до одного знака (3/6 = 50%)",
  report.totals.successRate === 50
);
check(
  "daily содержит полное окно дней, включая пустые",
  report.daily.length === 14 && report.daily.every((day) => /^\d{4}-\d{2}-\d{2}$/.test(day.date))
);
check("daily заканчивается сегодняшним днём (UTC)", report.daily[13].date === "2026-06-15");
check(
  "daily считает запуски по дням (running не учитывается)",
  report.daily[13].total === 1 && report.daily[13].success === 1 && report.daily[13].error === 0
);
check(
  "daily суммирует токены и стоимость",
  report.daily[13].tokens === 1000 && report.daily[13].costUsd > 0
);
check(
  "avgDurationMs по дню — среднее по запускам с длительностью",
  report.daily[13].avgDurationMs === 1000
);

check(
  "tasks агрегирует по имени задачи",
  report.tasks.find((t) => t.taskName === "build").total === 3
);
check(
  "tasks помечает клонов матрицы (isMatrixClone + matrixParentId)",
  report.tasks.find((t) => t.taskName === "Deploy-matrix-Frontend").isMatrixClone === true &&
    report.tasks.find((t) => t.taskName === "Deploy-matrix-Frontend").matrixParentId === "Deploy"
);
check(
  "tasks считает successRate по задаче",
  report.tasks.find((t) => t.taskName === "build").successRate === 66.7
);
check(
  "avgDurationMs по задаче усредняется только по ненулевым значениям",
  report.tasks.find((t) => t.taskName === "Deploy").avgDurationMs === 0
);

check("topByCost отсортирован по убыванию стоимости",
  report.topByCost[0].taskName === "Deploy-matrix-Frontend" && report.topByCost[0].costUsd === 0.5);
check("topByCost ограничен topLimit", report.topByCost.length === 2);

check(
  "matrices группирует клонов под родителем",
  report.matrices.length === 1 &&
    report.matrices[0].parentId === "Deploy" &&
    report.matrices[0].clones === 2 &&
    report.matrices[0].total === 2 &&
    report.matrices[0].success === 1 &&
    report.matrices[0].error === 1
);
check(
  "matrices считает successRate и стоимость",
  report.matrices[0].successRate === 50 && report.matrices[0].costUsd === 0.75
);

check(
  "byModel группирует по модели и суммирует стоимость",
  report.byModel.some((row) => row.model === "m1" && row.total === 2) &&
    report.byModel.some((row) => row.model === "m2" && row.total === 4)
);

check(
  "стоимость без costUsd оценивается по токенам",
  Math.abs(recordCost({ taskName: "x", status: "success", startedAt: at(0), tokens: 1000 }) -
    ESTIMATED_COST_PER_1K_TOKENS_USD) < 1e-9
);
check(
  "явный costUsd приоритетнее оценки по токенам",
  recordCost({ taskName: "x", status: "success", startedAt: at(0), tokens: 100000, costUsd: 0.1 }) === 0.1
);
check("recordDate не падает на битой дате", recordDate({ taskName: "x", status: "success", startedAt: "nope" }) === "");

const empty = buildAnalytics([], { days: 3, now });
check(
  "пустая история даёт нулевые итоги без падения",
  empty.totals.total === 0 && empty.totals.successRate === 0 && empty.daily.length === 3
);

check("csvCell экранирует кавычки и разделители",
  csvCell('a;b"c\nd') === '"a;b""c\nd"' && csvCell(null) === "" && csvCell(42) === "42");

const csv = historyToCsv(records.slice(0, 2));
check("CSV начинается с BOM и содержит заголовок",
  csv.startsWith("\uFEFFstartedAt;finishedAt;taskName;status"));
check("CSV использует CRLF и по строке на запись",
  csv.split("\r\n").length === 3);
check("CSV экранирует пустые значения",
  csv.includes(";build;success;"));

const failed = results.filter((r) => !r.ok);
console.log(`\nAnalytics: ${results.length - failed.length}/${results.length} проверок пройдено.`);
process.exit(failed.length > 0 ? 1 : 0);
