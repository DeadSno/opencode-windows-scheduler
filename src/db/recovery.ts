import fs from "node:fs";
import path from "node:path";
import { PLUGIN_DIR } from "../types.js";
import { isDatabaseEmpty } from "./index.js";
import { recoverInterrupted } from "./history-repo.js";

/** Файлы, которые миграция переименовывает в .json.bak. */
const JSON_FILES = ["tasks.json", "history.json", "metrics.json", "templates.json"];

/**
 * Crash recovery: помечает незавершённые записи истории как error.
 * Вызывается при setup() до запуска catch-up и файловых триггеров.
 */
export function recoverInterruptedRuns(): number {
  const count = recoverInterrupted();
  if (count > 0) {
    console.log(
      `[recovery] Восстановлено ${count} незавершённых записей истории — помечены как error.`
    );
  }
  return count;
}

/**
 * Если БД пуста, а .json.bak остались (миграция не удалась или БД удалили),
 * подсказываем пользователю, что делать. Возвращает true, если бэкапы найдены.
 */
export function checkJsonBackups(): boolean {
  const backups = JSON_FILES.map((name) => path.join(PLUGIN_DIR, `${name}.bak`)).filter(
    (file) => {
      try {
        return fs.existsSync(file);
      } catch {
        return false;
      }
    }
  );

  if (backups.length === 0) return false;
  if (!isDatabaseEmpty()) return false;

  console.warn(
    "[recovery] Обнаружены бэкапы JSON, БД пуста. Запустите миграцию заново."
  );
  return true;
}
