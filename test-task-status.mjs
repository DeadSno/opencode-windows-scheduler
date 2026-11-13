// Тесты статусов задач: выбор самой свежей записи истории для карточки задачи.
// Запуск: node test-task-status.mjs (после npm run build).
const { latestHistoryByTask } = await import("./dist/history.js");

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

function record(taskName, status, startedAt) {
  return {
    taskName,
    status,
    startedAt,
    finishedAt: startedAt,
    durationMs: 0,
    error: null,
  };
}

// loadHistory() отдаёт записи от новых к старым — helper должен брать первую.
const records = [
  record("Deploy", "success", "2026-11-13T12:00:00.000Z"),
  record("Deploy", "error", "2026-11-13T11:00:00.000Z"),
  record("deploy", "partial", "2026-11-13T10:00:00.000Z"),
  record("Smoke", "error", "2026-11-13T09:00:00.000Z"),
  record("Smoke", "success", "2026-11-13T08:00:00.000Z"),
];

const latest = latestHistoryByTask(records);
check("по задаче остаётся одна запись", latest.size === 2);
check("ключ хранится в lower-case", latest.has("deploy") && latest.has("smoke"));
check(
  "берётся самая свежая запись, а не последняя в массиве",
  latest.get("deploy")?.status === "success"
);
check(
  "регистр имени не создаёт дубликат",
  latest.get("deploy")?.startedAt === "2026-11-13T12:00:00.000Z"
);
check("вторая задача тоже получает свежий статус", latest.get("smoke")?.status === "error");
check("пустая история даёт пустую карту", latestHistoryByTask([]).size === 0);

if (failed > 0) {
  console.error(`\nПровалено: ${failed}, пройдено: ${passed}`);
  process.exit(1);
}
console.log(`Task status: ${passed}/${passed} проверок пройдено.`);
