import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { getTask, saveTask } from "../db/tasks-repo.js";
import { appendStructuredLog } from "./structured-log.js";

export const SESSION_MODES = ["new", "reuse", "last"] as const;
export type SessionMode = (typeof SESSION_MODES)[number];

const SESSION_ID_PATTERN = /^ses_[A-Za-z0-9]{10,64}$/;

/** Генерация id сессии в формате `ses_<26+ base36>`. */
export function generateSessionId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.randomBytes(13);
  let suffix = "";
  for (const byte of bytes) {
    suffix += alphabet[byte % 36];
  }
  // 13 байт → 20 символов base36; добавляем 6 случайных, чтобы было ≥26.
  const extra = crypto.randomBytes(3).toString("hex");
  return `ses_${suffix}${extra}`;
}

/** Проверка формата id сессии. */
export function isValidSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID_PATTERN.test(value);
}

/**
 * Нормализация режима сессии. undefined → "new".
 * Возвращает undefined для мусора, чтобы вызывающий мог решить, падать или нет.
 */
export function normalizeSessionMode(value: unknown): SessionMode | undefined {
  if (value === undefined || value === null) return "new";
  if (value === "new" || value === "reuse" || value === "last") return value;
  return undefined;
}

/** Аргументы для `opencode run` в зависимости от режима. */
export function buildSessionArgs(mode: SessionMode, sessionId?: string): string[] {
  switch (mode) {
    case "reuse":
      return sessionId && isValidSessionId(sessionId) ? ["--session", sessionId] : [];
    case "last":
      return ["--continue"];
    default:
      return [];
  }
}

/** Признак того, что сессию пора ротировать после N запусков. */
export function shouldRotateSession(runCount: number, maxRuns: number): boolean {
  return maxRuns > 0 && runCount >= maxRuns;
}

/**
 * Счётчик запусков сессии при сохранении определения задачи.
 *
 * Редактирование не должно обнулять прогресс к sessionMaxRuns, если сессия
 * осталась прежней. При смене режима или id сессии счётчик начинается заново.
 */
export function preservedSessionRunCount(
  previous:
    | { session?: SessionMode; sessionId?: string; sessionRunCount?: number }
    | undefined,
  session: SessionMode,
  sessionId: string | undefined
): number {
  if (!previous) return 0;
  if (previous.session !== session || previous.sessionId !== sessionId) return 0;
  return previous.sessionRunCount ?? 0;
}

/**
 * Best-effort ротация переиспользуемой сессии после завершения запуска.
 * Удаляет сессию через opencode CLI, очищает sessionId в определении задачи
 * и пишет событие в structured log. Никогда не бросает — сбой ротации
 * не должен ломать историю запуска.
 */
export async function rotateSessionIfNeeded(taskName: string): Promise<void> {
  try {
    const def = await getTask(taskName);
    if (!def || def.session !== "reuse") return;

    const maxRuns = def.sessionMaxRuns ?? 0;
    const count = (def.sessionRunCount ?? 0) + 1;

    if (shouldRotateSession(count, maxRuns)) {
      const sessionId = def.sessionId;
      if (sessionId && isValidSessionId(sessionId)) {
        try {
          await new Promise<void>((resolve) => {
            execFile("opencode", ["session", "delete", sessionId], () => resolve());
          });
        } catch {
          // Удаление не должно мешать: просто фиксируем в логе ниже.
        }
      }
      await saveTask({
        ...def,
        sessionId: undefined,
        sessionRunCount: 0,
      });
      appendStructuredLog({
        event: "session.rotated",
        task: taskName,
        reason: `maxRuns=${maxRuns} достигнут; сессия удалена и счётчик сброшен`,
      });
    } else {
      await saveTask({ ...def, sessionRunCount: count });
    }
  } catch (error) {
    console.warn(`[session] Ротация сессии задачи "${taskName}" не выполнена:`, error);
  }
}
