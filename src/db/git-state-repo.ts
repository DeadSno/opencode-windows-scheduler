import { getDb } from "./index.js";

/**
 * Состояние git-триггера (Спринт 27): последний обработанный коммит задачи.
 * Хранится в SQLite, чтобы после перезапуска плагина не запускать задачу
 * повторно на тех же коммитах.
 */
export interface GitState {
  taskName: string;
  commitSha: string;
  branch: string | null;
  updatedAt: string;
}

interface GitStateRow {
  task_name: string;
  commit_sha: string;
  branch: string | null;
  updated_at: string;
}

export function getGitState(taskName: string): GitState | undefined {
  const row = getDb()
    .prepare("SELECT task_name, commit_sha, branch, updated_at FROM git_state WHERE task_name = ?")
    .get(taskName) as GitStateRow | undefined;
  if (!row) return undefined;
  return {
    taskName: String(row.task_name),
    commitSha: String(row.commit_sha),
    branch: row.branch == null ? null : String(row.branch),
    updatedAt: String(row.updated_at),
  };
}

export function setGitState(taskName: string, commitSha: string, branch?: string | null): void {
  getDb()
    .prepare(
      `INSERT INTO git_state (task_name, commit_sha, branch, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(task_name) DO UPDATE SET
         commit_sha = excluded.commit_sha,
         branch = excluded.branch,
         updated_at = excluded.updated_at`
    )
    .run(taskName, commitSha, branch ?? null, new Date().toISOString());
}

export function deleteGitState(taskName: string): void {
  getDb().prepare("DELETE FROM git_state WHERE task_name = ?").run(taskName);
}

export function listGitStates(): GitState[] {
  const rows = getDb()
    .prepare("SELECT task_name, commit_sha, branch, updated_at FROM git_state ORDER BY task_name")
    .all() as GitStateRow[];
  return rows.map((row) => ({
    taskName: String(row.task_name),
    commitSha: String(row.commit_sha),
    branch: row.branch == null ? null : String(row.branch),
    updatedAt: String(row.updated_at),
  }));
}
