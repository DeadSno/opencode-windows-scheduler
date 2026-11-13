// Тесты Спринта 24: Session continuity (session new/reuse/last, sessionMaxRuns).
// Запуск: node test-session-continuity.mjs (после npm run build).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sched-session-test-"));
process.env.APPDATA = tempRoot;
process.env.OPENCODE_SCHEDULER_HOME = path.join(tempRoot, "opencode", "windows-scheduler");

const {
  SESSION_MODES,
  generateSessionId,
  isValidSessionId,
  normalizeSessionMode,
  buildSessionArgs,
  shouldRotateSession,
  rotateSessionIfNeeded,
} = await import("./dist/core/session.js");
const { buildBashWrapperScript } = await import("./dist/core/wrappers/bash.js");
const { initDb, closeDb } = await import("./dist/db/index.js");
const {
  saveTaskDefinition,
  buildExportJson,
  parseImportJson,
} = await import("./dist/task-transfer.js");
const { simulatePipeline } = await import("./dist/core/dry-run.js");
const { saveTask, getTask } = await import("./dist/db/tasks-repo.js");

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

function section(title) {
  console.log(`\n${title}`);
}

try {
  initDb();

  section("Генерация и проверка sessionId");
  {
    const id = generateSessionId();
    check("sessionId начинается с ses_", id.startsWith("ses_"));
    check("sessionId валиден по формату", isValidSessionId(id));
    check("два sessionId различаются", generateSessionId() !== generateSessionId());
    check("пустая строка не валидна", isValidSessionId("") === false);
    check("id без префикса ses_ не валиден", isValidSessionId("abc1234567890") === false);
    check("не-строка не валидна", isValidSessionId(123) === false);
    check("SESSION_MODES = new/reuse/last", JSON.stringify(SESSION_MODES) === JSON.stringify(["new", "reuse", "last"]));
  }

  section("normalizeSessionMode");
  {
    check("undefined → new", normalizeSessionMode(undefined) === "new");
    check("null → new", normalizeSessionMode(null) === "new");
    check("new проходит как есть", normalizeSessionMode("new") === "new");
    check("reuse проходит как есть", normalizeSessionMode("reuse") === "reuse");
    check("last проходит как есть", normalizeSessionMode("last") === "last");
    check("неизвестный режим → undefined", normalizeSessionMode("bogus") === undefined);
    check("число → undefined", normalizeSessionMode(1) === undefined);
  }

  section("buildSessionArgs");
  {
    const id = generateSessionId();
    check("new → без аргументов", buildSessionArgs("new").length === 0);
    check("reuse с валидным id → --session <id>",
      JSON.stringify(buildSessionArgs("reuse", id)) === JSON.stringify(["--session", id]));
    check("reuse без id → без аргументов", buildSessionArgs("reuse").length === 0);
    check("reuse с битым id → без аргументов", buildSessionArgs("reuse", "bogus").length === 0);
    check("last → --continue",
      JSON.stringify(buildSessionArgs("last")) === JSON.stringify(["--continue"]));
  }

  section("shouldRotateSession");
  {
    check("maxRuns=0 — без ограничения", shouldRotateSession(100, 0) === false);
    check("runCount ниже лимита — без ротации", shouldRotateSession(2, 5) === false);
    check("runCount на лимите — ротация", shouldRotateSession(5, 5) === true);
    check("runCount выше лимита — ротация", shouldRotateSession(9, 5) === true);
  }

  section("Баш-обёртка передаёт флаги сессии");
  {
    const base = {
      sanitizedName: "SessionTask",
      taskName: "Session Task",
      promptFile: path.join(tempRoot, "prompt.txt"),
      timeoutSeconds: 300,
      lockFile: path.join(tempRoot, "lock"),
    };
    fs.writeFileSync(base.promptFile, "тест");
    const id = generateSessionId();
    const reuseScript = buildBashWrapperScript({ ...base, sessionMode: "reuse", sessionId: id });
    check("reuse: скрипт содержит --session", reuseScript.includes("--session"));
    check("reuse: скрипт содержит сам sessionId", reuseScript.includes(id));
    check("reuse: скрипт экспортирует SESSION_MODE", reuseScript.includes("SESSION_MODE="));
    const lastScript = buildBashWrapperScript({ ...base, sessionMode: "last" });
    check("last: скрипт содержит --continue", lastScript.includes("--continue"));
    const newScript = buildBashWrapperScript({ ...base, sessionMode: "new" });
    check(
      "new: флаг --session не навязывается в вызове opencode",
      newScript.includes("SESSION_MODE='new'") && !newScript.includes("opencode run --session")
    );
  }

  section("Export/import round-trip для сессий");
  const definition = {
    name: "Session Roundtrip",
    schedule: "0 * * * *",
    prompt: "проверить сессию",
    session: "reuse",
    sessionId: generateSessionId(),
    sessionMaxRuns: 3,
    timeoutSeconds: 600,
    priority: 5,
  };
  await saveTaskDefinition(definition);

  const exported = await buildExportJson([
    {
      taskName: `\\OpenCode\\windows-scheduler\\${definition.name}`,
      nextRunTime: null,
      status: "ready",
    },
  ]);
  const exportedJson = JSON.parse(exported.data);
  const exportedTask = exportedJson.tasks.find((task) => task.name === definition.name);
  check("экспорт сохраняет session reuse", exportedTask?.session === "reuse");
  check("экспорт сохраняет sessionMaxRuns", exportedTask?.sessionMaxRuns === 3);
  check("экспорт содержит sessionId для reuse", typeof exportedTask?.sessionId === "string" && isValidSessionId(exportedTask.sessionId));
  check("sessionRunCount не экспортируется", exportedTask && !("sessionRunCount" in exportedTask));

  const imported = parseImportJson(exported.data);
  check("round-trip не даёт ошибок", imported.errors.length === 0 && imported.tasks.length === 1);
  const importedTask = imported.tasks[0];
  check("round-trip сохраняет session reuse", importedTask?.session === "reuse");
  check("round-trip сохраняет sessionMaxRuns", importedTask?.sessionMaxRuns === 3);
  check("round-trip сохраняет sessionId", importedTask?.sessionId === exportedTask?.sessionId);

  const legacyImport = parseImportJson(JSON.stringify({
    version: 1,
    tasks: [{ name: "Legacy Sessionless", prompt: "старый экспорт", schedule: "0 0 * * *" }],
  }));
  check("импорт без session-полей не падает", legacyImport.errors.length === 0 && legacyImport.tasks.length === 1);
  check("импорт без session-полей → new", legacyImport.tasks[0]?.session === undefined || legacyImport.tasks[0]?.session === "new");

  const bogusMode = parseImportJson(JSON.stringify({
    version: 1,
    tasks: [{ name: "Bogus Mode", prompt: "плохой режим", schedule: "0 0 * * *", session: "teleport" }],
  }));
  check("неизвестный session отклоняется", bogusMode.errors.length === 1 && bogusMode.tasks.length === 0);

  const bogusId = parseImportJson(JSON.stringify({
    version: 1,
    tasks: [{ name: "Bogus Id", prompt: "плохой id", schedule: "0 0 * * *", session: "reuse", sessionId: "not-a-session" }],
  }));
  check("некорректный sessionId отклоняется", bogusId.errors.length === 1 && bogusId.tasks.length === 0);

  const bogusMax = parseImportJson(JSON.stringify({
    version: 1,
    tasks: [{ name: "Bogus Max", prompt: "нулевой лимит", schedule: "0 0 * * *", session: "reuse", sessionMaxRuns: 0 }],
  }));
  check("sessionMaxRuns < 1 отклоняется", bogusMax.errors.length === 1 && bogusMax.tasks.length === 0);

  section("Ротация reuse-сессии после лимита запусков");
  {
    const rotateDef = {
      name: "Rotation Task",
      schedule: "0 * * * *",
      prompt: "ротация сессии",
      session: "reuse",
      sessionId: generateSessionId(),
      sessionMaxRuns: 2,
      sessionRunCount: 1,
    };
    await saveTask(rotateDef);
    await rotateSessionIfNeeded(rotateDef.name);
    const afterFirst = await getTask(rotateDef.name);
    check("после 2-го запуска счётчик сброшен", (afterFirst?.sessionRunCount ?? -1) === 0);
    check("после 2-го запуска sessionId очищен", afterFirst?.sessionId === undefined);

    const countDef = {
      ...rotateDef,
      name: "Rotation Counter",
      sessionId: generateSessionId(),
      sessionRunCount: 0,
    };
    await saveTask(countDef);
    await rotateSessionIfNeeded(countDef.name);
    const afterCount = await getTask(countDef.name);
    check("до лимита счётчик инкрементируется", afterCount?.sessionRunCount === 1);
    check("до лимита sessionId сохраняется", typeof afterCount?.sessionId === "string");

    const lastModeDef = {
      name: "Last Mode Task",
      schedule: "0 * * * *",
      prompt: "режим last",
      session: "last",
      sessionRunCount: 41,
    };
    await saveTask(lastModeDef);
    await rotateSessionIfNeeded(lastModeDef.name);
    const lastAfter = await getTask(lastModeDef.name);
    check("режим last не трогает счётчик", lastAfter?.sessionRunCount === 41);

    // Не должна бросать даже для несуществующей задачи.
    let threw = false;
    try {
      await rotateSessionIfNeeded("No Such Task Anywhere");
    } catch {
      threw = true;
    }
    check("rotateSessionIfNeeded не падает на отсутствующей задаче", threw === false);
  }

  section("Dry-run для сессий");
  const dryRun = await simulatePipeline(definition.name);
  const dryRunTask = dryRun.tasks.find((task) => task.name === definition.name);
  check("dry-run успешен для reuse-задачи", dryRun.success === true);
  check("dry-run возвращает режим сессии", dryRunTask?.session === "reuse");
  check("dry-run возвращает sessionId для reuse", typeof dryRunTask?.sessionId === "string");

  console.log(`\nИтого: ${passed} пройдено, ${failed} не пройдено.`);
  process.exitCode = failed === 0 ? 0 : 1;
} catch (error) {
  console.error("\nТест завершился с ошибкой:", error);
  process.exitCode = 1;
} finally {
  try {
    closeDb();
  } catch {
    // temp dir can be removed best-effort
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
