/**
 * Тесты Спринта 16: Lifecycle матриц.
 * Запуск: node test-matrix-lifecycle.mjs (после npm run build).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ws-scheduler-matrix-lc-"));
process.env.APPDATA = tempRoot;
process.env.OPENCODE_SCHEDULER_HOME = path.join(tempRoot, "opencode", "windows-scheduler");

const { initDb, closeDb } = await import("./dist/db/index.js");
const { saveTask, getTask, deleteTask, listMatrixClones, listTasks } = await import(
  "./dist/db/tasks-repo.js"
);
const { recordRun, insertHistory, getHistory } = await import("./dist/db/history-repo.js");
const { addWorkspace } = await import("./dist/workspaces.js");
const {
  aggregateMatrixResults,
  cancelPendingMatrixClones,
  expandMatrixTask,
  findOrphanedMatrixTasks,
  getMatrixDeletionGuard,
  matrixCompleteName,
  matrixParentOfCompleteTask,
  planMatrixFamilyDelete,
  removeMatrixChildren,
} = await import("./dist/core/matrix.js");

const results = [];
function check(name, cond) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? "OK  " : "FAIL"} ${name}`);
}

function recordStatus(taskName, status, error = null) {
  const startedAt = new Date(Date.now() - 5000).toISOString();
  recordRun(taskName, status, startedAt, 1000, error, undefined, 10, 0.00003, "test/model", "skipped", "skipped");
}

initDb();

try {
  // Workspace-ы.
  for (const dir of ["frontend", "backend", "mobile"]) {
    fs.mkdirSync(path.join(tempRoot, dir), { recursive: true });
  }
  const frontend = addWorkspace({ path: path.join(tempRoot, "frontend"), name: "Frontend" });
  const backend = addWorkspace({ path: path.join(tempRoot, "backend"), name: "Backend" });
  const mobile = addWorkspace({ path: path.join(tempRoot, "mobile"), name: "Mobile App" });

  const parent = {
    name: "Deploy",
    schedule: "*/5 * * * *",
    prompt: "Собери и задеплой",
    matrix: {
      workspaceIds: [frontend.id, backend.id, mobile.id],
      strategy: "parallel",
      failureMode: "continue",
      aggregation: "summary",
      createAggregator: true,
    },
  };
  saveTask(parent);
  const clones = expandMatrixTask(parent);
  for (const clone of clones) saveTask(clone);

  // Агрегатор (для проверки каскада и сирот).
  saveTask({
    name: matrixCompleteName("Deploy"),
    schedule: "*/5 * * * *",
    prompt: "Агрегируй",
    triggerType: "file",
    dependsOn: clones.map((c) => c.name),
  });
  // Обычная задача.
  saveTask({ name: "Ordinary", schedule: "* * * * *", prompt: "x" });

  // 1. Защита от ручного удаления клона.
  const cloneGuard = getMatrixDeletionGuard(clones[0].name);
  check(
    "getMatrixDeletionGuard запрещает удаление клона",
    typeof cloneGuard === "string" && cloneGuard.includes("клон матрицы") && cloneGuard.includes("Deploy")
  );
  check(
    "getMatrixDeletionGuard разрешает удаление родителя и обычной задачи",
    getMatrixDeletionGuard("Deploy") === undefined &&
      getMatrixDeletionGuard("Ordinary") === undefined
  );

  // 2. План каскадного удаления.
  const plan = planMatrixFamilyDelete("Deploy");
  check(
    "planMatrixFamilyDelete включает клоны и агрегатор",
    plan &&
      plan.parent === "Deploy" &&
      plan.children.length === 4 &&
      plan.children.includes(clones[0].name) &&
      plan.children.includes(clones[1].name) &&
      plan.children.includes(clones[2].name) &&
      plan.children.includes(matrixCompleteName("Deploy"))
  );
  check(
    "planMatrixFamilyDelete не срабатывает для обычной задачи и клона",
    planMatrixFamilyDelete("Ordinary") === undefined &&
      planMatrixFamilyDelete(clones[0].name) === undefined
  );

  // 3. Пока семья здорова — сирот нет.
  check("findOrphanedMatrixTasks на здоровой матрице пуст", findOrphanedMatrixTasks().length === 0);

  // 4. matrixParentOfCompleteTask разбирает имя агрегатора.
  check(
    "matrixParentOfCompleteTask возвращает имя родителя",
    matrixParentOfCompleteTask("Deploy-matrix-complete") === "Deploy" &&
      matrixParentOfCompleteTask("Ordinary") === undefined
  );

  // 5. Отмена: клон 0 успешен, клон 1 выполняется, клон 2 ещё не стартовал.
  recordStatus(clones[0].name, "success");
  insertHistory({
    taskName: clones[1].name,
    status: "running",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    durationMs: null,
  });

  const cancelResult = await cancelPendingMatrixClones("Deploy");
  check(
    "cancelPendingMatrixClones отменяет только незавершённые клоны",
    cancelResult.cancelled.length === 2 &&
      cancelResult.cancelled.includes(clones[1].name) &&
      cancelResult.cancelled.includes(clones[2].name) &&
      cancelResult.alreadyFinished.length === 1 &&
      cancelResult.alreadyFinished[0] === clones[0].name
  );
  check(
    "cancelPendingMatrixClones помечает выполнявшийся клон как running",
    cancelResult.running.length === 1 && cancelResult.running[0] === clones[1].name
  );
  check(
    "отмена клона пишет error-запись с причиной",
    getHistory(clones[2].name, 1)[0]?.status === "error" &&
      /Отменено пользователем/.test(getHistory(clones[2].name, 1)[0]?.error ?? "")
  );
  check(
    "после отмены агрегат матрицы становится partial",
    cancelResult.aggregate.status === "partial" &&
      cancelResult.aggregate.successCount === 1 &&
      cancelResult.aggregate.errorCount === 2 &&
      cancelResult.aggregate.pendingCount === 0
  );

  const parentRecordAfterCancel = getHistory("Deploy", 1)[0];
  check(
    "отмена финализирует родителя записью partial",
    parentRecordAfterCancel?.status === "partial" && Boolean(parentRecordAfterCancel?.error)
  );

  // 6. Отмена не удаляет определения клонов — матрица остаётся запускаемой.
  check(
    "после отмены клоны остаются в БД (матрица запускаема повторно)",
    listMatrixClones("Deploy").length === 3 && Boolean(getTask(clones[2].name))
  );

  // 7. Повторная отмена — уже нечего отменять.
  const secondCancel = await cancelPendingMatrixClones("Deploy");
  check(
    "повторная отмена ничего не меняет",
    secondCancel.cancelled.length === 0 && secondCancel.alreadyFinished.length === 3
  );

  // 8. Отмена не-матрицы — ошибка.
  let notMatrixError = null;
  try {
    await cancelPendingMatrixClones("Ordinary");
  } catch (err) {
    notMatrixError = err;
  }
  check(
    "cancelPendingMatrixClones отклоняет не-матрицу",
    notMatrixError && String(notMatrixError.message).includes("не является матрицей")
  );

  // 9. failureMode stop → агрегат error после отмены.
  const stopParent = {
    name: "DeployStop",
    schedule: "*/5 * * * *",
    prompt: "p",
    matrix: {
      workspaceIds: [frontend.id, backend.id],
      strategy: "parallel",
      failureMode: "stop",
    },
  };
  saveTask(stopParent);
  const stopClones = expandMatrixTask(stopParent);
  for (const clone of stopClones) saveTask(clone);
  const stopCancel = await cancelPendingMatrixClones("DeployStop");
  check(
    "отмена матрицы со failureMode=stop даёт статус error",
    stopCancel.aggregate.status === "error" && getHistory("DeployStop", 1)[0]?.status === "error"
  );

  // 10. Сироты: удаляем родителя, клоны и агрегатор остаются.
  check(
    "removeMatrixChildren перечисляет клоны и агрегатор",
    removeMatrixChildren("Deploy").length === 4
  );
  deleteTask("Deploy");
  const orphans = findOrphanedMatrixTasks();
  check(
    "findOrphanedMatrixTasks находит клоны и агрегатор без родителя",
    orphans.length === 4 &&
      orphans.includes(clones[0].name) &&
      orphans.includes(matrixCompleteName("Deploy"))
  );
  check(
    "findOrphanedMatrixTasks не трогает чужие задачи",
    !orphans.includes("Ordinary") && !orphans.includes(clones[0].name.replace("Deploy", "DeployStop"))
  );

  // 11. Чистка сирот имитирует поведение cleanupOrphanedMatrixTasks (index.ts).
  for (const orphan of orphans) deleteTask(orphan);
  check(
    "после чистки сирот не остаётся",
    findOrphanedMatrixTasks().length === 0 &&
      listMatrixClones("Deploy").length === 0 &&
      !getTask(matrixCompleteName("Deploy"))
  );
  check(
    "чистка сирот не затрагивает другие семейства",
    listMatrixClones("DeployStop").length === 2 && Boolean(getTask("Ordinary"))
  );
  check(
    "всего задач после чистки корректно",
    listTasks().length === 4 // DeployStop + 2 клона + Ordinary
  );

  // 12. Агрегат удалённой матрицы — empty.
  check(
    "агрегат удалённой матрицы пуст",
    aggregateMatrixResults("Deploy").status === "empty"
  );
} finally {
  closeDb();
}

const failed = results.filter((r) => !r.ok);
console.log(`\nMatrix lifecycle: ${results.length - failed.length}/${results.length} проверок пройдено.`);
process.exit(failed.length > 0 ? 1 : 0);
