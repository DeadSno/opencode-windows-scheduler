import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { getDb } from "./db/index.js";
import { clearWorkspaceAssignments } from "./db/tasks-repo.js";
import { hasSecretRef, resolveSecretRefs } from "./core/secrets.js";

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
  /** Env-переменные workspace (Спринт 21). Значения хранятся как есть. */
  env?: Record<string, string>;
  /** Путь к .env-файлу, переменные которого подмешиваются к env (Спринт 21). */
  envFile?: string;
  createdAt: string;
}

export interface AddWorkspaceInput {
  name?: string;
  path: string;
  color?: string;
  env?: Record<string, string> | null;
  envFile?: string | null;
}

export interface UpdateWorkspacePatch {
  name?: string;
  path?: string;
  color?: string;
  gitRemote?: string | null;
  env?: Record<string, string> | null;
  envFile?: string | null;
}

/** Максимум пар env на workspace — защита от раздувания строки JSON. */
export const MAX_WORKSPACE_ENV_PAIRS = 100;

/** Палитра цветных маркеров для GUI/дашборда. */
export const WORKSPACE_COLORS = [
  "#5b8def",
  "#2fb67c",
  "#e0a03a",
  "#d15c8a",
  "#8b6fe8",
  "#3aa8b8",
];

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Нормализует пары env: ключи — валидные имена переменных, значения — строки.
 * Бросает понятную ошибку при нарушении (её показывает GUI/RPC).
 */
export function normalizeWorkspaceEnv(
  value: unknown
): Record<string, string> | undefined {
  if (value == null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("env должен быть объектом «ключ → значение».");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_WORKSPACE_ENV_PAIRS) {
    throw new Error(
      `Слишком много env-переменных: ${entries.length} (максимум ${MAX_WORKSPACE_ENV_PAIRS}).`
    );
  }
  const result: Record<string, string> = {};
  for (const [rawKey, rawValue] of entries) {
    const key = String(rawKey).trim();
    if (!ENV_KEY_RE.test(key)) {
      throw new Error(
        `Недопустимое имя env-переменной '${rawKey}': нужны латиница, цифры и '_', не с цифры.`
      );
    }
    if (rawValue == null) {
      result[key] = "";
      continue;
    }
    if (typeof rawValue === "object") {
      throw new Error(`Значение env '${key}' должно быть строкой.`);
    }
    result[key] = String(rawValue);
  }
  return result;
}

/**
 * Разбирает содержимое .env: строки KEY=VALUE, комментарии `#`, пустые строки,
 * префикс `export `, кавычки вокруг значения снимаются.
 */
export function parseEnvFileContent(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of String(content).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const withoutExport = trimmed.startsWith("export ")
      ? trimmed.slice("export ".length).trim()
      : trimmed;
    const eq = withoutExport.indexOf("=");
    if (eq <= 0) continue;
    const key = withoutExport.slice(0, eq).trim();
    if (!ENV_KEY_RE.test(key)) continue;
    let value = withoutExport.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

/** Читает .env-файл workspace (если он задан и существует). */
export function readWorkspaceEnvFile(envFile?: string): Record<string, string> {
  if (!envFile) return {};
  try {
    return parseEnvFileContent(readFileSync(envFile, "utf8"));
  } catch {
    return {};
  }
}

/**
 * Итоговые env-переменные workspace: сначала .env-файл, затем явные пары
 * (пары важнее файла). Ссылки `${secret:NAME}` разворачиваются из
 * зашифрованного хранилища (Спринт 26); отсутствующий секрет даёт пустую
 * строку и предупреждение с именем — без значения. Никогда не бросает.
 */
export function resolveWorkspaceEnv(workspace: Workspace | undefined): Record<string, string> {
  if (!workspace) return {};
  const merged = {
    ...readWorkspaceEnvFile(workspace.envFile),
    ...(workspace.env ?? {}),
  };
  const resolved = resolveSecretRefs(merged);
  if (resolved.missing.length > 0) {
    console.warn(
      `[workspace] "${workspace.name}": не найдены секреты: ${resolved.missing.join(", ")}`
    );
  }
  return resolved.env;
}

/** Маскирует значение секрета для логов. */
export function maskSecretValue(): string {
  return "***";
}

const SECRET_KEY_RE = /(TOKEN|SECRET|PASS|PASSWORD|KEY|CREDENTIAL|AUTH)/i;

/**
 * Копия env для логов: значения «секретных» ключей заменены на ***.
 * Чистые ссылки `${secret:NAME}` сохраняются как есть — это не секрет,
 * а указатель, и он помогает диагностике (Спринт 26).
 */
export function maskEnvForLog(env: Record<string, string> | undefined): Record<string, string> {
  if (!env) return {};
  const masked: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (hasSecretRef(value)) {
      masked[key] = String(value);
    } else {
      masked[key] = SECRET_KEY_RE.test(key) ? maskSecretValue() : value;
    }
  }
  return masked;
}

/**
 * Каталог env-файлов задач внутри каталога плагина (по одному файлу на задачу).
 * Файлы содержат реальные значения и не попадают в git/логи.
 */
export function workspaceEnvDir(pluginDir: string): string {
  return join(pluginDir, "env");
}

/**
 * Пишет env-файл задачи в формате KEY=VALUE (Спринт 21).
 *
 * Возвращает путь к файлу или undefined, если у workspace нет переменных.
 * Пустой env удаляет ранее созданный файл. На POSIX права 0600.
 */
export function writeWorkspaceEnvFile(
  workspace: Workspace | undefined,
  pluginDir: string,
  sanitizedName: string
): string | undefined {
  const file = join(workspaceEnvDir(pluginDir), `${sanitizedName}.env`);
  const env = resolveWorkspaceEnv(workspace);
  const keys = Object.keys(env);
  if (!keys.length) {
    try {
      rmSync(file, { force: true });
    } catch {
      // нечего удалять — не ошибка
    }
    return undefined;
  }
  const body =
    keys
      .map((key) => `${key}=${String(env[key]).replace(/\r?\n/g, " ")}`)
      .join("\n") + "\n";
  mkdirSync(workspaceEnvDir(pluginDir), { recursive: true });
  writeFileSync(file, body, { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") {
    try {
      chmodSync(file, 0o600);
    } catch {
      // права не критичны для работы задачи
    }
  }
  return file;
}

function rowToWorkspace(row: any): Workspace {
  let env: Record<string, string> | undefined;
  if (row.env_json) {
    try {
      env = normalizeWorkspaceEnv(JSON.parse(String(row.env_json)));
    } catch {
      env = undefined;
    }
  }
  return {
    id: String(row.id),
    name: String(row.name),
    path: String(row.path),
    gitRemote: row.git_remote == null ? undefined : String(row.git_remote),
    color: row.color == null ? undefined : String(row.color),
    env,
    envFile: row.env_file == null ? undefined : String(row.env_file),
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
  const env = normalizeWorkspaceEnv(input.env);
  const envFile = input.envFile?.trim() || undefined;

  getDb()
    .prepare(
      `INSERT INTO workspaces (id, name, path, git_remote, color, env_json, env_file, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      name,
      workspacePath,
      gitRemote ?? null,
      color,
      env ? JSON.stringify(env) : null,
      envFile ?? null,
      createdAt
    );

  return { id, name, path: workspacePath, gitRemote, color, env, envFile, createdAt };
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
  const nextEnv =
    patch.env === null
      ? undefined
      : patch.env !== undefined
        ? normalizeWorkspaceEnv(patch.env)
        : existing.env;
  const nextEnvFile =
    patch.envFile === null
      ? undefined
      : patch.envFile !== undefined
        ? patch.envFile.trim() || undefined
        : existing.envFile;

  getDb()
    .prepare(
      "UPDATE workspaces SET name = ?, path = ?, git_remote = ?, color = ?, env_json = ?, env_file = ? WHERE id = ?"
    )
    .run(
      nextName,
      nextPath,
      nextRemote ?? null,
      nextColor ?? null,
      nextEnv ? JSON.stringify(nextEnv) : null,
      nextEnvFile ?? null,
      id
    );

  return {
    id,
    name: nextName,
    path: nextPath,
    gitRemote: nextRemote,
    color: nextColor,
    env: nextEnv,
    envFile: nextEnvFile,
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
