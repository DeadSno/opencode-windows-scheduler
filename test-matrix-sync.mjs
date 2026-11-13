/**
 * Тесты Спринта 17: Синхронизация матриц + per-workspace настройки.
 * Запуск: node test-matrix-sync.mjs (после npm run build).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ws-matrix-sync-"));
process.env.APPDATA = tempRoot;
process.env.OPENCODE_SCHEDULER_HOME = path.join(tempRoot, "opencode", "windows-scheduler");

const { initDb, closeDb } = await import("./dist/db/index.js");
const { saveTask, getTask, listTasks } = await import("./dist/db/tasks-repo.js");
const { recordRun } = await import("./dist/db/history-repo.js");
const { addWorkspace } = await import("./dist/workspaces.js");
const { removeTaskDefinition } = await import("./dist/task-transfer.js");
const {
  matrixCloneName,
  matrixCompleteName,
  expandMatrixTask,
  planMatrixSync,
  syncMatrixFamily,
  resolveMatrixConcurrency,
  runMatrix,
  advanceMatrixAfterClone,
  finalizeMatrixIfComplete,
  cancelPendingMatrixClones,
  findOrphanedMatrixTasks,
  aggregateMatrixResults,
} = await import("./dist/core/matrix.js");
const { buildExportJson, parseImportJson } = await import("./dist/task-transfer.js");

const results = [];
function check(name, cond) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? "OK  " : "FAIL"} ${name}`);
}

initDb();

try {
  /** Свежая запись running в истории (имитация выполняющегося клона). */
  function markRunning(cloneName) {
    const startedAt = new Date().toISOString();
    recordRun(cloneName, "running", startedAt, 0, null, undefined, 0, 0, undefined, "skipped", "skipped", undefined);
  }
  for (const dir of ["frontend", "backend", "mobile"]) {
    fs.mkdirSync(path.join(tempRoot, dir), { recursive: true });
  }
  const frontend = addWorkspace({ path: path.join(tempRoot, "frontend"), name: "Frontend" });
  const backend = addWorkspace({ path: path.join(tempRoot, "backend"), name: "Backend" });
  const mobile = addWorkspace({ path: path.join(tempRoot, "mobile"), name: "Mobile App" });

  // 1. Per-workspace переопределения применяются в expandMatrixTask.
  const parentDef = {
    name: "Build",
    schedule: "*/5 * * * *",
    prompt: "Общий промпт",
    model: "base/model",
    qualityGate: "npm test",
    beforeScript: "git pull",
    afterScript: "git push",
    matrix: {
      workspaceIds: [frontend.id, backend.id, mobile.id],
      strategy: "parallel",
      failureMode: "continue",
      aggregation: "summary",
      concurrency: 2,
      overrides: {
        [frontend.id]: {
          prompt: "Собери фронтенд",
          model: "front/model",
          qualityGate: "npm run lint",
        },
        [backend.id]: { beforeScript: "npm ci" },
      },
    },
  };
  const clones = expandMatrixTask(parentDef);
  const frontClone = clones.find((c) => c.name === matrixCloneName("Build", "Frontend"));
  const backendClone = clones.find((c) => c.name === matrixCloneName("Build", "Backend"));
  const mobileClone = clones.find((c) => c.name === matrixCloneName("Build", "Mobile App"));

  check(
    "expandMatrixTask применяет overrides (промпт/модель/QG, остальное от родителя)",
    frontClone.prompt === "Собери фронтенд" &&
      frontClone.model === "front/model" &&
      frontClone.qualityGate === "npm run lint" &&
      frontClone.beforeScript === "git pull" &&
      frontClone.afterScript === "git push" &&
      frontClone.matrix === undefined &&
      frontClone.matrixParentId === "Build"
  );
  check(
    "overrides применяются частично (только beforeScript у Backend)",
    backendClone.prompt === "Общий промпт" &&
      backendClone.model === "base/model" &&
      backendClone.beforeScript === "npm ci" &&
      backendClone.afterScript === "git push"
  );
  check(
    "workspace без override наследует всё от родителя",
    mobileClone.prompt === "Общий промпт" &&
      mobileClone.model === "base/model" &&
      mobileClone.qualityGate === "npm test" &&
      mobileClone.beforeScript === "git pull"
  );

  // 2. resolveMatrixConcurrency.
  check(
    "resolveMatrixConcurrency: sequential всегда 1",
    resolveMatrixConcurrency({ ...parentDef.matrix, strategy: "sequential" }, 3) === 1
  );
  check(
    "resolveMatrixConcurrency: parallel с лимитом 2 из 3 клонов",
    resolveMatrixConcurrency(parentDef.matrix, 3) === 2
  );
  check(
    "resolveMatrixConcurrency: без лимита — все клоны",
    resolveMatrixConcurrency(
      { ...parentDef.matrix, concurrency: undefined, overrides: undefined },
      3
    ) === 3
  );

  // 3. Экспорт/импорт: overrides и concurrency переживают round-trip.
  saveTask({ ...parentDef, isMatrixParent: true });
  for (const clone of clones) saveTask(clone);
  const { data: exportJson } = await buildExportJson(
    listTasks().map((d) => ({ taskName: d.name }))
  );
  const roundParsed = parseImportJson(exportJson);
  const roundParent = roundParsed.tasks.find((t) => t.name === "Build");
  check(
    "export/import round-trip сохраняет overrides и concurrency",
    roundParent &&
      roundParent.matrix &&
      roundParent.matrix.concurrency === 2 &&
      roundParent.matrix.overrides &&
      roundParent.matrix.overrides[frontend.id] &&
      roundParent.matrix.overrides[frontend.id].prompt === "Собери фронтенд" &&
      roundParent.matrix.overrides[frontend.id].model === "front/model" &&
      roundParent.matrix.overrides[backend.id] &&
      roundParent.matrix.overrides[backend.id].beforeScript === "npm ci"
  );

  // 4. Валидация импорта: override по неизвестному workspace — ошибка.
  const badOverride = parseImportJson(
    JSON.stringify({
      version: 1,
      tasks: [
        {
          name: "BadOverride",
          schedule: "* * * * *",
          prompt: "x",
          matrix: {
            workspaceIds: [frontend.id],
            overrides: { ["no-such-ws"]: { prompt: "p" } },
          },
        },
      ],
    })
  );
  check(
    "overrides по workspace вне workspaceIds — ошибка валидации",
    badOverride.errors.some((e) => e.includes("нет в workspaceIds"))
  );

  // 5. Валидация импорта: некорректный concurrency — ошибка.
  const badConcurrency = parseImportJson(
    JSON.stringify({
      version: 1,
      tasks: [
        {
          name: "BadConc",
          schedule: "* * * * *",
          prompt: "x",
          matrix: { workspaceIds: [frontend.id], concurrency: 0 },
        },
      ],
    })
  );
  check(
    "matrix.concurrency < 1 — ошибка валидации",
    badConcurrency.errors.some((e) => e.includes("не меньше 1"))
  );

  // 6. planMatrixSync: создаёт новый клон, если workspace добавили.
  const parentBefore = getTask("Build");
  const syncPlan = planMatrixSync(parentBefore);
  check(
    "planMatrixSync при полной матрице: ничего не нужно создавать/обновлять",
    syncPlan.create.length === 0 &&
      syncPlan.update.length === 0 &&
      syncPlan.remove.length === 0 &&
      syncPlan.running.length === 0
  );

  // Убираем Mobile из workspaceIds — клон мобильного должен быть в remove.
  const parentRemoved = {
    ...parentDef,
    matrix: { ...parentDef.matrix, workspaceIds: [frontend.id, backend.id] },
  };
  saveTask(parentRemoved);
  const planRemoved = planMatrixSync(parentRemoved);
  const mobileCloneName = matrixCloneName("Build", "Mobile App");
  check(
    "planMatrixSync: удалённый workspace -> клон в remove",
    planRemoved.remove.includes(mobileCloneName)
  );
  check(
    "planMatrixSync: оставшиеся workspace не в remove",
    !planRemoved.remove.includes(frontClone.name) && !planRemoved.remove.includes(backendClone.name)
  );

  // Убираем клон мобильного из БД, а потом возвращаем workspace — чтобы
  // проверить, что добавленный workspace создаёт новый клон.
  await removeTaskDefinition(mobileCloneName);
  const parentAdded = {
    ...parentRemoved,
    matrix: { ...parentRemoved.matrix, workspaceIds: [frontend.id, backend.id, mobile.id] },
  };
  saveTask(parentAdded);
  const planAdded = planMatrixSync(parentAdded);
  check(
    "planMatrixSync: добавленный workspace -> клон в create",
    planAdded.create.some((c) => c.name === mobileCloneName)
  );

  // syncMatrixFamily через хуки: создаёт клон, вызывает агрегатор.
  const syncHookCalls = [];
  const syncResult = await syncMatrixFamily(parentAdded, {
    removeChild: async (name) => {
      syncHookCalls.push({ action: "remove", name });
      await removeTaskDefinition(name);
    },
    createChild: async (definition) => {
      syncHookCalls.push({ action: "create", name: definition.name });
      saveTask(definition);
    },
    updateChild: async (definition) => {
      syncHookCalls.push({ action: "update", name: definition.name });
      saveTask(definition);
    },
    syncAggregator: async (parent) => {
      syncHookCalls.push({ action: "aggregator", parent: parent.name });
      return matrixCompleteName(parent.name);
    },
  });
  check(
    "syncMatrixFamily: создал отсутствующий клон и вызвал aggregator",
    syncHookCalls.some((c) => c.action === "create" && c.name === mobileCloneName) &&
      syncHookCalls.some((c) => c.action === "aggregator") &&
      syncResult.created.includes(mobileCloneName)
  );

  // 8. planMatrixSync: выполняющийся клон не в update/remove (защита running).
  markRunning(frontClone.name);
  const planRunning = planMatrixSync(parentAdded);
  const runningCloneName = frontClone.name;
  check(
    "planMatrixSync: выполняющийся клон не в update, а в running",
    !planRunning.update.some((c) => c.name === runningCloneName) &&
      planRunning.running.includes(runningCloneName)
  );

  // 9. cancelPendingMatrixClones очищает очередь concurrency.
  // Установим queue на родителе вручную.
  await saveTask({ ...parentAdded, matrixQueue: [backendClone.name] });
  const cancelResult = await cancelPendingMatrixClones("Build");
  const parentAfterCancel = getTask("Build");
  check(
    "cancelPendingMatrixClones очищает matrixQueue",
    parentAfterCancel.matrixQueue === undefined ||
      parentAfterCancel.matrixQueue.length === 0
  );

  // 10. aggregateMatrixResults: пустая матрица -> empty.
  const emptyParent = {
    name: "EmptyMatrix",
    schedule: "* * * * *",
    prompt: "p",
    matrix: { workspaceIds: [frontend.id] },
  };
  saveTask({ ...emptyParent, isMatrixParent: true });
  const emptyAggregate = aggregateMatrixResults("EmptyMatrix");
  check(
    "aggregateMatrixResults: пустая матрица -> статус empty",
    emptyAggregate.status === "empty" && emptyAggregate.totalCount === 0
  );

  // 11. findOrphanedMatrixTasks: клон без родителя — сирота.
  const orphanParent = {
    name: "OrphanParent",
    schedule: "* * * * *",
    prompt: "o",
    matrix: { workspaceIds: [frontend.id] },
  };
  saveTask({ ...orphanParent, isMatrixParent: true });
  const orphanClones = expandMatrixTask(orphanParent);
  for (const clone of orphanClones) saveTask(clone);
  const orphansBefore = findOrphanedMatrixTasks();
  await removeTaskDefinition("OrphanParent");
  const orphansAfter = findOrphanedMatrixTasks();
  check(
    "findOrphanedMatrixTasks: после удаления родителя клон — сирота",
    !orphansBefore.includes(orphanClones[0].name) && orphansAfter.includes(orphanClones[0].name)
  );

  // 12. Обычная задача не в сиротах.
  const ordinary = { name: "Ordinary", schedule: "* * * * *", prompt: "обычная" };
  saveTask(ordinary);
  const finalOrphans = findOrphanedMatrixTasks();
  check(
    "findOrphanedMatrixTasks: обычная задача не считается сиротой",
    !finalOrphans.includes("Ordinary")
  );

} finally {
  closeDb();
}

const failed = results.filter((r) => !r.ok);
console.log(`\nMatrix sync: ${results.length - failed.length}/${results.length} проверок пройдено.`);
process.exit(failed.length > 0 ? 1 : 0);
