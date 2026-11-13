/**
 * Скилл плагина: `scheduled-job-best-practices`.
 *
 * Скилл — это markdown-инструкция, которую OpenCode показывает агенту и подгружает
 * по требованию через инструмент `skill`. Мы не полагаемся на ручную установку в
 * `.opencode/skills`: плагин сам регистрирует скилл в контексте сессии, поэтому он
 * доступен сразу после `opencode plugin add opencode-windows-scheduler`.
 *
 * Источник правды — каталог `skills/scheduled-job-best-practices` в пакете:
 *   - `SKILL.md` — тело инструкции;
 *   - `references/recipes.md` — готовые примеры, которые агент читает по ссылке.
 * Это даёт агенту базовую директорию с вспомогательными файлами.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SCHEDULER_SKILL_ID = "scheduled-job-best-practices";
export const SCHEDULER_SKILL_NAME = "Scheduled Job Best Practices";

const FALLBACK_DESCRIPTION =
  "Use when the user wants recurring or event-driven automation (cron, file changes, MCP events), multi-repository fan-out, or agent pipelines. Covers safe defaults, prompt design, Quality Gates, matrix builds, DAG dependencies and post-incident diagnosis with the scheduler tools.";

const FALLBACK_CONTENT = [
  "# Scheduled Job Best Practices",
  "",
  "Use `list_tasks` before creating anything and prefer `update_task` over delete + create.",
  "Write self-contained prompts (goal, scope, constraints, verification, output).",
  "Always set `timeoutSeconds`, set `qualityGate` when success is machine-checkable, and",
  "limit tools with `allowedTools`/`deniedTools`. Validate with `dry_run`, then `run_task_now`,",
  "then inspect `get_history` and `get_task_logs`. For multi-repository work use `matrix` with",
  "a small `concurrency`; a matrix parent never runs itself and dependencies wait for all clones.",
].join("\n");

export interface SchedulerSkill {
  id: string;
  name: string;
  description: string;
  path: string;
  content: string;
}

/** Корень пакета: `dist/skill.js` → `..`, `src/skill.ts` → `..`. */
function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

/**
 * Разбирает YAML-frontmatter простого вида (`key: value`).
 * Полноценный YAML не нужен: поддерживаем ровно те поля, которые пишем сами.
 */
function parseFrontmatter(raw: string): {
  meta: Record<string, string>;
  body: string;
} {
  const normalized = raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { meta: {}, body: normalized };
  }
  const end = normalized.indexOf("\n---", 4);
  if (end === -1) return { meta: {}, body: normalized };

  const header = normalized.slice(4, end);
  const body = normalized.slice(end + 4).replace(/^\n+/, "");
  const meta: Record<string, string> = {};

  for (const line of header.split("\n")) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
    if (!match) continue;
    const value = match[2].trim().replace(/^["']|["']$/g, "");
    if (value) meta[match[1]] = value;
  }

  return { meta, body };
}

/**
 * Загружает скилл из пакета. Возвращает `undefined`, если файл недоступен —
 * плагин в этом случае просто не регистрирует скилл и продолжает работать.
 */
export function loadSchedulerSkill(): SchedulerSkill | undefined {
  const skillPath = path.join(packageRoot(), "skills", SCHEDULER_SKILL_ID, "SKILL.md");

  let raw: string;
  try {
    raw = fs.readFileSync(skillPath, "utf8");
  } catch {
    if (process.env.OPENCODE_SCHEDULER_DEBUG_SKILL) {
      console.error(`[windows-scheduler] Скилл не найден: ${skillPath}`);
    }
    return undefined;
  }

  const { meta, body } = parseFrontmatter(raw);
  const content = body.trim();
  if (!content) {
    return {
      id: SCHEDULER_SKILL_ID,
      name: meta.name || SCHEDULER_SKILL_NAME,
      description: meta.description || FALLBACK_DESCRIPTION,
      path: skillPath,
      content: FALLBACK_CONTENT,
    };
  }

  return {
    id: SCHEDULER_SKILL_ID,
    name: meta.name || SCHEDULER_SKILL_NAME,
    description: meta.description || FALLBACK_DESCRIPTION,
    path: skillPath,
    content,
  };
}
