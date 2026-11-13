// Тесты Спринта 23: one-shot расписание (runAt/delaySeconds, triggerType "once").
// Запуск: node test-one-shot.mjs (после npm run build).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sched-one-shot-test-"));
process.env.APPDATA = tempRoot;
process.env.OPENCODE_SCHEDULER_HOME = path.join(tempRoot, "opencode", "windows-scheduler");

const {
  MAX_ONESHOT_DELAY_SECONDS,
  normalizeOneShotRunAt,
  buildWindowsOneShotFlags,
  buildAtTimestamp,
  buildLaunchdCalendar,
  buildLaunchdOneShotCleanup,
} = await import("./dist/core/one-shot.js");
const { initDb, closeDb } = await import("./dist/db/index.js");
const {
  saveTaskDefinition,
  buildExportJson,
  parseImportJson,
} = await import("./dist/task-transfer.js");
const { simulatePipeline } = await import("./dist/core/dry-run.js");

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

const pad = (value) => String(value).padStart(2, "0");

function expectedWindows(runAt) {
  const date = new Date(runAt);
  return [
    "/sc",
    "ONCE",
    "/sd",
    `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}`,
    "/st",
    `${pad(date.getHours())}:${pad(date.getMinutes())}`,
  ];
}

function expectedAt(runAt) {
  const date = new Date(runAt);
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}`;
}

try {
  initDb();

  section("Нормализация runAt/delaySeconds");
  {
    const futureIso = new Date(Date.now() + 3_600_000).toISOString();
    const fromRunAt = normalizeOneShotRunAt({ runAt: futureIso });
    check("runAt в будущем принимается", fromRunAt.ok === true);
    check("runAt нормализуется в ISO", fromRunAt.ok && fromRunAt.runAt === new Date(Date.parse(futureIso)).toISOString());

    const fromDelay = normalizeOneShotRunAt({ delaySeconds: 90 }, Date.now());
    check("delaySeconds задаёт абсолютное время", fromDelay.ok === true);
    check("delaySeconds сохраняется в результате", fromDelay.ok && fromDelay.delaySeconds === 90);

    const both = normalizeOneShotRunAt({ runAt: futureIso, delaySeconds: 30 });
    check("runAt имеет приоритет над delaySeconds", both.ok === true && both.runAt === new Date(Date.parse(futureIso)).toISOString() && both.delaySeconds === 30);

    check("пустой ввод отклоняется", normalizeOneShotRunAt({}).ok === false);
    check("прошедшая дата отклоняется", normalizeOneShotRunAt({ runAt: new Date(Date.now() - 60_000).toISOString() }).ok === false);
    check("невалидная дата отклоняется", normalizeOneShotRunAt({ runAt: "завтра утром" }).ok === false);
    check("нулевая задержка отклоняется", normalizeOneShotRunAt({ delaySeconds: 0 }).ok === false);
    check("дробная задержка округляется вниз", normalizeOneShotRunAt({ delaySeconds: 12.9 }).ok === true);
    check("слишком большая задержка отклоняется", normalizeOneShotRunAt({ delaySeconds: MAX_ONESHOT_DELAY_SECONDS + 1 }).ok === false);
    check("задержка ровно на максимуме принимается", normalizeOneShotRunAt({ delaySeconds: MAX_ONESHOT_DELAY_SECONDS }).ok === true);
    check("строковая задержка отклоняется", normalizeOneShotRunAt({ delaySeconds: "60" }).ok === false);
  }

  section("Форматы планировщиков ОС");
  {
    const sample = new Date(Date.now() + 7 * 24 * 3_600_000).toISOString();
    const windows = buildWindowsOneShotFlags(sample);
    const expected = expectedWindows(sample);
    check("Windows ONCE использует /sc ONCE", JSON.stringify(windows) === JSON.stringify(expected));
    check("Windows ONCE дата DD.MM.YYYY", /^\d{2}\.\d{2}\.\d{4}$/.test(windows[3]));
    check("Windows ONCE время HH:MM", /^\d{2}:\d{2}$/.test(windows[5]));

    const at = buildAtTimestamp(sample);
    check("Linux at -t использует 12 цифр", /^\d{12}$/.test(at));
    check("Linux at -t совпадает с локальной датой", at === expectedAt(sample));

    const calendar = buildLaunchdCalendar(sample);
    const date = new Date(sample);
    check("launchd Month соответствует локальному месяцу", calendar.Month === date.getMonth() + 1);
    check("launchd Day соответствует локальному дню", calendar.Day === date.getDate());
    check("launchd Hour соответствует локальному часу", calendar.Hour === date.getHours());
    check("launchd Minute соответствует локальной минуте", calendar.Minute === date.getMinutes());

    const cleanup = buildLaunchdOneShotCleanup("My-Task_1");
    check("cleanup вызывает bootout", cleanup.includes("bootout"));
    check("cleanup содержит имя санитизированной задачи", cleanup.includes("com.opencode.scheduler.My-Task_1.plist"));
    check("cleanup не прерывает обёртку при отсутствии агента", cleanup.includes("|| true"));
  }

  section("Export/import round-trip для one-shot");
  const futureRunAt = new Date(Date.now() + 2 * 3_600_000).toISOString();
  const definition = {
    name: "One Shot Roundtrip",
    schedule: "",
    prompt: "выполнить один раз",
    triggerType: "once",
    runAt: futureRunAt,
    timeoutSeconds: 600,
    priority: 7,
    retryCount: 2,
    dependsOn: ["Earlier Task"],
    workingDirectory: tempRoot,
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
  check("экспорт содержит ровно одну задачу", exported.count === 1 && exportedJson.tasks.length === 1);
  check("экспорт сохраняет triggerType once", exportedTask?.triggerType === "once");
  check("экспорт сохраняет runAt", exportedTask?.runAt === futureRunAt);
  check("экспорт разрешает пустое расписание для once", exportedTask?.schedule === "");
  check("экспорт сохраняет остальные поля", exportedTask?.timeoutSeconds === 600 && exportedTask?.priority === 7 && exportedTask?.retryCount === 2);

  const imported = parseImportJson(exported.data);
  check("round-trip не даёт ошибок", imported.errors.length === 0 && imported.tasks.length === 1);
  const importedTask = imported.tasks[0];
  check("round-trip сохраняет triggerType once", importedTask?.triggerType === "once");
  check("round-trip сохраняет runAt", importedTask?.runAt === futureRunAt);
  check("round-trip сохраняет prompt", importedTask?.prompt === definition.prompt);

  const delayedImport = parseImportJson(JSON.stringify({
    version: 1,
    tasks: [{
      name: "Delayed One Shot",
      prompt: "выполнить позже",
      triggerType: "once",
      delaySeconds: 120,
    }],
  }));
  check("импорт с delaySeconds работает", delayedImport.errors.length === 0 && delayedImport.tasks.length === 1);
  check("импорт с delaySeconds создаёт будущий runAt", Date.parse(delayedImport.tasks[0]?.runAt ?? "") > Date.now());

  const missingTiming = parseImportJson(JSON.stringify({
    version: 1,
    tasks: [{ name: "No Timing", prompt: "не хватает времени", triggerType: "once" }],
  }));
  check("once без runAt/delaySeconds отклоняется", missingTiming.errors.length === 1 && missingTiming.tasks.length === 0);

  const pastImport = parseImportJson(JSON.stringify({
    version: 1,
    tasks: [{
      name: "Past One Shot",
      prompt: "прошлое время",
      triggerType: "once",
      runAt: new Date(Date.now() - 3_600_000).toISOString(),
    }],
  }));
  check("once с прошедшим runAt отклоняется", pastImport.errors.length === 1 && pastImport.tasks.length === 0);

  section("Dry-run для one-shot");
  const dryRun = await simulatePipeline(definition.name);
  const dryRunTask = dryRun.tasks.find((task) => task.name === definition.name);
  check("dry-run успешен для one-shot", dryRun.success === true);
  check("dry-run помечает задачу как once", dryRunTask?.trigger === "once");
  check("dry-run возвращает runAt как next run", dryRunTask?.scheduleDetails?.nextRuns?.[0] === futureRunAt);

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
