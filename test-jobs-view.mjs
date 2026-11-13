// Тесты группировки задач матрицы для TUI.
// Запуск: node test-jobs-view.mjs (после npm run build).
const { groupJobsForDisplay, buildJobsView, nextJobSelection, formatJobLog } =
  await import("./dist/shared/jobs-view.js");

let passed = 0;
let failed = 0;

function check(label, condition) {
  if (condition) {
    passed++;
    return;
  }
  failed++;
  console.error(`  ✗ ${label}`);
}

function job(name, extra = {}) {
  return { name, status: "idle", ...extra };
}

function record(taskName, status, startedAt) {
  return { taskName, status, startedAt, finishedAt: startedAt, durationMs: 0, error: null };
}

const rows = groupJobsForDisplay([
  job("deploy"),
  job("matrix-parent", { isMatrixParent: true }),
  job("matrix-parent [linux]", { matrixParentId: "matrix-parent" }),
  job("matrix-parent [windows]", { matrixParentId: "Matrix-Parent" }),
  job("alpha"),
]);

check(
  "корневые задачи отсортированы по имени",
  rows.filter((row) => row.depth === 0).map((row) => row.job.name).join(",") ===
    "alpha,deploy,matrix-parent"
);
check(
  "клоны идут сразу после родителя",
  rows[2]?.job.name === "matrix-parent" &&
    rows[3]?.job.name === "matrix-parent [linux]" &&
    rows[4]?.job.name === "matrix-parent [windows]"
);
check(
  "клоны имеют отступ depth=1",
  rows[3]?.depth === 1 && rows[4]?.depth === 1
);
check(
  "имя родителя сравнивается без учёта регистра",
  rows[4]?.job.matrixParentId === "Matrix-Parent"
);

const orphanRows = groupJobsForDisplay([
  job("solo-clone", { matrixParentId: "missing-parent" }),
]);
check(
  "клон без родителя остаётся видимым",
  orphanRows.length === 1 && orphanRows[0].job.name === "solo-clone"
);
check("клон без родителя показывается корневым", orphanRows[0].depth === 0);
check("пустой список даёт пустой результат", groupJobsForDisplay([]).length === 0);

// Сборка панельного представления из задач планировщика, истории и определений.
const built = buildJobsView(
  [
    {
      taskName: "Matrix",
      paused: true,
      nextRunTime: "2026-11-14T09:00:00.000Z",
      lastRunTime: "2026-11-13T09:00:00.000Z",
    },
    { taskName: "Matrix [linux]", paused: false },
    { taskName: "plain" },
  ],
  [
    record("matrix", "success", "2026-11-13T09:00:00.000Z"),
    record("matrix [linux]", "partial", "2026-11-13T09:01:00.000Z"),
    record("plain", "timeout", "2026-11-13T09:02:00.000Z"),
  ],
  [
    { name: "Matrix", matrix: {} },
    { name: "Matrix [linux]", matrixParentId: " Matrix " },
  ]
);
check("история матчится к задаче без учёта регистра", built[0]?.status === "success");
check("timeout показывается как error", built[2]?.status === "error");
check("пауза берётся из планировщика", built[0]?.paused === true);
check("следующий запуск прокидывается", built[0]?.nextRun === "2026-11-14T09:00:00.000Z");
check("родитель матрицы помечается", built[0]?.isMatrixParent === true);
check(
  "клон получает имя родителя без пробелов",
  built[1]?.matrixParentId === "Matrix"
);
check("ad-hoc задача без определения не считается матрицей", !built[2]?.isMatrixParent);
check(
  "история без записи даёт idle",
  buildJobsView([{ taskName: "fresh" }], [], [])[0]?.status === "idle"
);

// Клавиатурная навигация по строкам панели.
check(
  "выбор идёт к следующей задаче",
  nextJobSelection(rows, "alpha", 1) === "deploy"
);
check(
  "выбор идёт к предыдущей задаче",
  nextJobSelection(rows, "deploy", -1) === "alpha"
);
check(
  "выбор зацикливается в конце",
  nextJobSelection(rows, "matrix-parent [windows]", 1) === "alpha"
);
check(
  "выбор зацикливается в начале",
  nextJobSelection(rows, "alpha", -1) === "matrix-parent [windows]"
);
check(
  "неизвестное имя начинает с первой строки",
  nextJobSelection(rows, "missing", 1) === "alpha"
);
check("пустой список не даёт выбора", nextJobSelection([], "alpha", 1) === undefined);

// Превью лога для диалога TUI.
const manyLines = Array.from({ length: 60 }, (_, i) => `line-${i + 1}`).join("\n");
const preview = formatJobLog(manyLines, undefined, 5);
check("лог обрезается до последних строк", preview === "line-56\nline-57\nline-58\nline-59\nline-60");
check(
  "пустой лог использует текст ошибки",
  formatJobLog("", "Задача ещё не запускалась") === "Задача ещё не запускалась"
);
check("пустой лог без ошибки даёт пояснение", formatJobLog("", undefined) === "Лог пуст.");
check(
  "CRLF нормализуется",
  formatJobLog("первая\r\nвторая", undefined, 10) === "первая\nвторая"
);

if (failed > 0) {
  console.error(`\nПровалено: ${failed}, пройдено: ${passed}`);
  process.exit(1);
}
console.log(`Jobs view: ${passed}/${passed} проверок пройдено.`);
