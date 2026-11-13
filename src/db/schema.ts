/**
 * Схема БД планировщика (Спринт 12 + workspaces из Спринта 13).
 *
 * Все таблицы создаются идемпотентно (IF NOT EXISTS), поэтому schema.ts можно
 * безопасно выполнять при каждом открытии соединения — это же служит
 * механизмом «мини-миграций» при обновлении плагина.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS tasks (
  name TEXT PRIMARY KEY,
  definition_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  matrix_parent_id TEXT,
  is_matrix_parent INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_name TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  duration_ms INTEGER,
  error TEXT,
  tokens INTEGER,
  cost_usd REAL,
  model TEXT,
  pre_flight_status TEXT,
  post_flight_status TEXT,
  next_task TEXT,
  workspace_id TEXT,
  allowed_tools TEXT,
  denied_tools TEXT
);

CREATE INDEX IF NOT EXISTS idx_history_task ON history(task_name, started_at DESC);

CREATE TABLE IF NOT EXISTS metrics (
  task_name TEXT PRIMARY KEY,
  total INTEGER DEFAULT 0,
  success INTEGER DEFAULT 0,
  error INTEGER DEFAULT 0,
  total_tokens INTEGER DEFAULT 0,
  total_cost REAL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  definition_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  git_remote TEXT,
  color TEXT,
  env_json TEXT,
  env_file TEXT,
  created_at TEXT NOT NULL
);
`;

interface SchemaDb {
  exec(sql: string): void;
  prepare(sql: string): { all(): unknown[] };
}

/**
 * Применяет схему к открытому соединению.
 *
 * CREATE TABLE IF NOT EXISTS не добавляет новые колонки в уже существующие
 * таблицы, поэтому history.workspace_id добавляется отдельным ALTER TABLE
 * после проверки PRAGMA table_info. Это безопасно и для старых БД Спринта 12.
 */
export function applySchema(db: SchemaDb): void {
  db.exec(SCHEMA_SQL);

  const columns = db.prepare("PRAGMA table_info(history)").all() as Array<{
    name?: string;
  }>;
  const columnNames = columns.map((c) => c.name).filter(Boolean);
  if (!columnNames.includes("workspace_id")) {
    db.exec("ALTER TABLE history ADD COLUMN workspace_id TEXT");
  }
  if (!columnNames.includes("allowed_tools")) {
    db.exec("ALTER TABLE history ADD COLUMN allowed_tools TEXT");
  }
  if (!columnNames.includes("denied_tools")) {
    db.exec("ALTER TABLE history ADD COLUMN denied_tools TEXT");
  }

  // Спринт 15: флаги matrix на tasks (клоны и родитель-шаблон).
  const taskColumns = db.prepare("PRAGMA table_info(tasks)").all() as Array<{
    name?: string;
  }>;
  const taskColumnNames = taskColumns.map((c) => c.name).filter(Boolean);
  if (!taskColumnNames.includes("matrix_parent_id")) {
    db.exec("ALTER TABLE tasks ADD COLUMN matrix_parent_id TEXT");
  }
  if (!taskColumnNames.includes("is_matrix_parent")) {
    db.exec("ALTER TABLE tasks ADD COLUMN is_matrix_parent INTEGER DEFAULT 0");
  }

  // Спринт 21: env-переменные на workspace (пары ключ-значение и .env-файл).
  const workspaceColumns = db.prepare("PRAGMA table_info(workspaces)").all() as Array<{
    name?: string;
  }>;
  const workspaceColumnNames = workspaceColumns.map((c) => c.name).filter(Boolean);
  if (!workspaceColumnNames.includes("env_json")) {
    db.exec("ALTER TABLE workspaces ADD COLUMN env_json TEXT");
  }
  if (!workspaceColumnNames.includes("env_file")) {
    db.exec("ALTER TABLE workspaces ADD COLUMN env_file TEXT");
  }
}
