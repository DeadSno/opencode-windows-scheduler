import fs from "node:fs/promises";
import path from "node:path";
import { LOG_DIR, sanitizeName } from "../../types.js";

/**
 * Читает файл лога задачи и возвращает последние 50 строк.
 *
 * Лог пишут обёртки (PowerShell на Windows, bash на POSIX) в
 * ${LOG_DIR}/<sanitizedName>.log — тот же путь, что передаётся при создании.
 */
export async function getTaskLogs(
  name: string,
  limit = 50
): Promise<{ logs: string; error?: string }> {
  const logPath = path.join(LOG_DIR, `${sanitizeName(name)}.log`);
  try {
    // PowerShell 5.1 пишет UTF-8 с BOM — убираем его, чтобы GUI не показывал мусор.
    const content = (await fs.readFile(logPath, "utf8")).replace(/^\uFEFF/, "");
    const lines = content.split(/\r?\n/).filter((line) => line.trim());
    if (lines.length === 0) {
      return {
        logs: "",
        error: `Лог задачи "${name}" пуст. Задача ещё не писала вывод — запустите её и повторите.`,
      };
    }
    const last = lines.slice(-Math.max(1, Math.min(limit, 1000)));
    return { logs: last.join("\n") };
  } catch (err: any) {
    if (err.code === "ENOENT") {
      return {
        logs: "",
        error: `Лог задачи "${name}" не найден по пути ${logPath} (задача ещё не запускалась).`,
      };
    }
    return { logs: "", error: err instanceof Error ? err.message : String(err) };
  }
}
