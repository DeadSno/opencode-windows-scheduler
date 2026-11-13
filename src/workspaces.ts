import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { getDb } from "./db/index.js";
import { clearWorkspaceAssignments } from "./db/tasks-repo.js";

/**
 * Multi-repo workspaces.
 *
 * Одна задача = один workspace = один cwd. Workspace — это просто
 * зарегистрированный путь к репозиторию; плагин никогда не «угадывает»,
 * куда мержить и не выполняет cross-repo операции самостоятельно.
 */
export interface Workspace {
  id: string;
  name: string;
  path: string;
  gitRemote?: string;
  color?: string;
  createdAt: string;
}

export interface AddWorkspaceInput {
  name?: string;
  path: string;
  color?: string;
}

export interface UpdateWorkspacePatch {
  name?: string;
  path?: string;
  color?: string;
  gitRemote?: string | null;
}

/** Палитра цветных маркеров для GUI/дашборда. */
export const WORKSPACE_COLORS = [
  "#5b8def",
  "#2fb67c",
  "#e0a03a",
  "#d15c8a",
  "#8b6fe8",
  "#3aa8b8",
];

function rowToWorkspace(row: any): Workspace {
  return {
    id: String(row.id),
    name: String(row.name),
    path: String(row.path),
    gitRemote: row.git_remote == null ? undefined : String(row.git_remote),
    color: row.color == null ? undefined : String(row.color),
    createdAt: String(row.created_at),
  };
}

function normalizePath(value: string): string {
  return resolve(value.trim());
}

/** Проверяет, что путь существует и является директорией. */
export function validateWorkspacePath(workspacePath: string): void {
  try {
    const stat = statSync(workspacePath);
    if (!stat.isDirectory()) throw new Error("not a directory");
  } catch {
    throw new Error(`Путь workspace недоступен: ${workspacePath}`);
  }
}

/**
 * Читает git remote origin. Если путь не git-репозиторий или remote не
 * настроен — возвращает undefined (это не ошибка).
 */
export function readGitRemote(workspacePath: string): string | undefined {
  try {
    const result = spawnSync("git", ["-C", workspacePath, "remote", "get-url", "origin"], {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    });
    if (result.status !== 0) return undefined;
    const remote = String(result.stdout || "").trim();
    return remote || undefined;
  } catch {
    return undefined;
  }
}

/** Текущая git-ветка (для dry-run preview); undefined вне git-репозитория. */
export function readGitBranch(workspacePath: string): string | undefined {
  try {
    const result = spawnSync(
      "git",
      ["-C", workspacePath, "rev-parse", "--abbrev-ref", "HEAD"],
      { encoding: "utf8", timeout: 5000, windowsHide: true }
    );
    if (result.status !== 0) return undefined;
    const branch = String(result.stdout || "").trim();
    return branch || undefined;
  } catch {
    return undefined;
  }
}

/** Все workspace (по имени). */
export function listWorkspaces(): Workspace[] {
  const rows = getDb()
    .prepare("SELECT * FROM workspaces ORDER BY name COLLATE NOCASE ASC")
    .all() as any[];
  return rows.map(rowToWorkspace);
}

/** Workspace по id. */
export function getWorkspace(id: string): Workspace | undefined {
  if (!id) return undefined;
  const row = getDb().prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as any;
  return row ? rowToWorkspace(row) : undefined;
}

/** Workspace по пути (без учёта регистра, как в Windows). */
export function getWorkspaceByPath(workspacePath: string): Workspace | undefined {
  const normalized = normalizePath(workspacePath);
  const row = getDb()
    .prepare("SELECT * FROM workspaces WHERE lower(path) = lower(?) LIMIT 1")
    .get(normalized) as any;
  return row ? rowToWorkspace(row) : undefined;
}

/** Регистрирует новый workspace. Путь должен существовать. */
export function addWorkspace(input: AddWorkspaceInput): Workspace {
  const workspacePath = normalizePath(input.path || "");
  if (!workspacePath) {
    throw new Error("Путь workspace не может быть пустым.");
  }
  const name = (input.name || basename(workspacePath) || workspacePath).trim();
  try {
    validateWorkspacePath(workspacePath);
  } catch {
    throw new Error(`Workspace '${name}' недоступен по пути '${workspacePath}'`);
  }

  const existing = getWorkspaceByPath(workspacePath);
  if (existing) {
    throw new Error(`Workspace с путём '${workspacePath}' уже существует.`);
  }

  const id = randomUUID();
  const color =
    input.color?.trim() ||
    WORKSPACE_COLORS[listWorkspaces().length % WORKSPACE_COLORS.length];
  const createdAt = new Date().toISOString();
  const gitRemote = readGitRemote(workspacePath);

  getDb()
    .prepare(
      `INSERT INTO workspaces (id, name, path, git_remote, color, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(id, name, workspacePath, gitRemote ?? null, color, createdAt);

  return { id, name, path: workspacePath, gitRemote, color, createdAt };
}

/** Обновляет имя/путь/цвет workspace. */
export function updateWorkspace(id: string, patch: UpdateWorkspacePatch): Workspace {
  const existing = getWorkspace(id);
  if (!existing) throw new Error(`Workspace '${id}' не найден.`);

  const nextName = patch.name?.trim() || existing.name;
  const nextPath = patch.path?.trim() ? normalizePath(patch.path) : existing.path;
  if (nextPath !== existing.path) {
    try {
      validateWorkspacePath(nextPath);
    } catch {
      throw new Error(`Workspace '${nextName}' недоступен по пути '${nextPath}'`);
    }
    const duplicate = getWorkspaceByPath(nextPath);
    if (duplicate && duplicate.id !== id) {
      throw new Error(`Workspace с путём '${nextPath}' уже существует.`);
    }
  }

  const nextColor = patch.color?.trim() || existing.color;
  const nextRemote =
    patch.gitRemote === null
      ? undefined
      : patch.gitRemote !== undefined
        ? patch.gitRemote.trim() || undefined
        : nextPath !== existing.path
          ? readGitRemote(nextPath)
          : existing.gitRemote;

  getDb()
    .prepare(
      "UPDATE workspaces SET name = ?, path = ?, git_remote = ?, color = ? WHERE id = ?"
    )
    .run(nextName, nextPath, nextRemote ?? null, nextColor ?? null, id);

  return {
    id,
    name: nextName,
    path: nextPath,
    gitRemote: nextRemote,
    color: nextColor,
    createdAt: existing.createdAt,
  };
}

/**
 * Удаляет workspace. Задачи не удаляются — у них просто очищается
 * workspaceId (с предупреждением в логе).
 */
export function deleteWorkspace(id: string): boolean {
  const workspace = getWorkspace(id);
  if (!workspace) return false;

  const affected = clearWorkspaceAssignments(id);
  if (affected.length > 0) {
    console.warn(
      `[workspace] Удалён workspace '${workspace.name}'. ` +
        `Отвязано задач: ${affected.length} (${affected.join(", ")}). ` +
        `Задачи не удалены, workspaceId очищен.`
    );
  }

  const result = getDb().prepare("DELETE FROM workspaces WHERE id = ?").run(id);
  return Number(result.changes) > 0;
}

/** Количество workspace (для сводок и тестов). */
export function countWorkspaces(): number {
  const row = getDb().prepare("SELECT COUNT(*) AS count FROM workspaces").get() as any;
  return Number(row?.count) || 0;
}
