/**
 * schedule-gate: вызывается враппером (.cmd / bash) сразу после срабатывания
 * планировщика, ДО запуска агента.
 *
 * Проверяет расширенное cron-выражение и окно запуска (notBefore/notAfter):
 *   node dist/core/schedule-gate.js --cron "0 9 * * *" [--tz "Europe/Moscow"]
 *                                   [--not-before 22:00 --not-after 06:00]
 *                                   [--defer-file "C:\...\name.lock.defer"]
 *                                   [--force-file "C:\...\name.lock.force"]
 *                                   [--now 2026-11-13T12:00:00.000Z]  (для тестов)
 *
 * --force-file — маркер ручного запуска (run_task_now, файловый триггер,
 * catch-up). Если файл существует и моложе FORCE_TTL_MS, проверка cron/окна
 * пропускается, а маркер удаляется. Протухший маркер не действует — иначе
 * забытый файл однажды обошёл бы расписание.
 *
 * Коды выхода:
 *   0 — можно запускать (wrapper выполняет агента);
 *   3 — не время (cron не совпал, уже есть отложенный запуск или не в окне),
 *       wrapper тихо завершается;
 *   1 — некорректные аргументы (ошибка логируется; запуск разрешён, чтобы не
 *       ломать задачу из-за опечатки в конфигурации).
 *
 * Окно запуска реализовано как ПЕРЕНОС, а не пропуск: если cron совпал, но
 * сейчас вне окна, gate ждёт открытия окна. Дубликаты отложенных запусков
 * отсекаются по defer-файлу (атомарное создание); файл запись удаляет сам gate
 * после пробуждения; если файл протух (> 25 часов) — считается stale и
 * перезаписывается.
 */
import fs from "node:fs";
import {
  activeWindowState,
  cronMatches,
  isValidIanaTimeZone,
  normalizeActiveDays,
  parseCron,
  validateLaunchWindow,
} from "./schedule-v2.js";

const STALE_DEFER_MS = 25 * 60 * 60 * 1000;

/** Сколько живёт маркер ручного запуска. */
const FORCE_TTL_MS = 2 * 60 * 1000;

/** Дольше 12 часов перенос не ждём — тик просто пропускается. */
const MAX_POSTPONE_MS = 12 * 60 * 60 * 1000;

function argValue(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** true, если defer-файл сейчас занят другим отложенным запуском. */
function deferFileBusy(path: string, nowMs: number): boolean {
  try {
    const raw = fs.readFileSync(path, "utf8").trim();
    const ts = Date.parse(raw);
    if (Number.isFinite(ts) && nowMs - ts < STALE_DEFER_MS) return true;
    // Протухший файл — удаляем и занимаем сами.
    fs.unlinkSync(path);
    return false;
  } catch {
    return false;
  }
}

/** Атомарно занимает defer-слот; true, если занят успешно. */
function acquireDefer(path: string, nowMs: number): boolean {
  try {
    const fd = fs.openSync(path, "wx");
    fs.writeSync(fd, new Date(nowMs).toISOString());
    fs.closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

function releaseDefer(path: string): void {
  try {
    fs.unlinkSync(path);
  } catch {
    /* удалён раньше — не страшно */
  }
}

/**
 * Проверяет и поглощает маркер ручного запуска.
 *
 * Возвращает true, если маркер свежий (значит, запуск инициирован вручную:
 * инструментом, файловым триггером, MCP-событием или catch-up) — тогда гейт
 * расписания не должен блокировать запуск. Маркер удаляется в любом случае.
 *
 * Возраст считается по реальным часам, а не по --now, иначе тестовый --now
 * ломал бы проверку. Протухший маркер (например, задача не стартовала)
 * просто удаляется и не влияет на расписание.
 */
function consumeForceMarker(path: string): boolean {
  try {
    const stat = fs.statSync(path);
    fs.unlinkSync(path);
    return Date.now() - stat.mtimeMs <= FORCE_TTL_MS;
  } catch {
    return false;
  }
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const cronExpr = argValue(args, "--cron");
  const tz = argValue(args, "--tz");
  const notBefore = argValue(args, "--not-before");
  const notAfter = argValue(args, "--not-after");
  const daysArg = argValue(args, "--days");
  const policyArg = argValue(args, "--window-policy");
  const deferFile = argValue(args, "--defer-file");
  const forceFile = argValue(args, "--force-file");
  const nowArg = argValue(args, "--now");

  const days = daysArg
    ? normalizeActiveDays(
        daysArg
          .split(",")
          .map((value) => Number(value.trim()))
          .filter((value) => Number.isFinite(value))
      )
    : undefined;
  const policy: "skip" | "postpone" | "run" =
    policyArg === "skip" || policyArg === "run" ? policyArg : "postpone";

  const now = nowArg ? new Date(nowArg) : new Date();
  if (Number.isNaN(now.getTime())) {
    console.error(`[schedule-gate] Некорректное значение --now: ${nowArg}`);
    return 1;
  }

  // Ручной запуск (run_task_now, файловый триггер, MCP-событие, catch-up):
  // маркер свежий — расписание и окно не проверяем.
  if (forceFile && consumeForceMarker(forceFile)) {
    console.error("[schedule-gate] Ручной запуск — проверка расписания пропущена.");
    return 0;
  }

  // Невалидный timezone/окно — не блокируем задачу, логируем и продолжаем.
  const zone = tz && isValidIanaTimeZone(tz) ? tz : undefined;
  if (tz && !zone) {
    console.error(`[schedule-gate] Неизвестный timezone «${tz}» — игнорируем его.`);
  }
  const windowError = validateLaunchWindow(notBefore, notAfter);
  if (windowError) {
    console.error(`[schedule-gate] Окно запуска игнорируется: ${windowError}`);
  }

  let spec = null;
  if (cronExpr) {
    try {
      spec = parseCron(cronExpr);
    } catch (err: any) {
      console.error(
        `[schedule-gate] Невалидный cron «${cronExpr}»: ${
          err instanceof Error ? err.message : String(err)
        } — пропускаем проверку cron.`
      );
    }
  }

  if (spec && !cronMatches(spec, now, zone)) {
    // По расширенному cron сейчас не время.
    return 3;
  }

  // Дни недели и окно запуска (Спринт 27). Политика вне окна:
  //   postpone (по умолчанию) — ждём открытия окна;
  //   skip — тихо пропускаем тик;
  //   run — выполняем, несмотря на окно.
  const windowOptions = { notBefore, notAfter, days, timeZone: zone };
  if (policy !== "run") {
    const state = activeWindowState(now, windowOptions);
    if (!state.active) {
      if (policy === "skip") {
        console.error(`[schedule-gate] Пропуск: ${state.reason ?? "вне окна"}.`);
        return 3;
      }

      const wait = state.nextOpenAt
        ? Math.max(0, state.nextOpenAt.getTime() - now.getTime())
        : 0;
      if (wait <= 0) return 0;
      if (wait > MAX_POSTPONE_MS) {
        console.error(
          `[schedule-gate] ${state.reason ?? "вне окна"} — до открытия больше 12 часов, тик пропущен.`
        );
        return 3;
      }

      // ПЕРЕНОС: ждём открытия окна. Откладываем один запуск, остальные тики
      // отсекаются по defer-файлу.
      if (deferFile) {
        if (deferFileBusy(deferFile, now.getTime())) {
          console.error("[schedule-gate] Отложенный запуск уже ожидает открытия окна.");
          return 3;
        }
        if (!acquireDefer(deferFile, now.getTime())) {
          console.error("[schedule-gate] Не удалось захватить defer-файл — пропускаем.");
          return 3;
        }
      }

      console.error(
        `[schedule-gate] ${state.reason ?? "Вне окна"} — запуск перенесён на ~${Math.round(
          wait / 60000
        )} мин.`
      );
      let remaining = wait;
      while (remaining > 0) {
        const chunk = Math.min(remaining, 60_000);
        await sleepMs(chunk);
        remaining -= chunk;
      }

      const woke = new Date();
      if (deferFile) releaseDefer(deferFile);

      if (!activeWindowState(woke, windowOptions).active) {
        console.error("[schedule-gate] Окно не открылось за отведённое время — не запускаем.");
        return 3;
      }
    }
  }

  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(
      `[schedule-gate] Непредвиденная ошибка: ${err instanceof Error ? err.message : String(err)} — запускаем.`
    );
    process.exit(1);
  }
);
