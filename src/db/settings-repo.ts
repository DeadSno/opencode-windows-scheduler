import { getDb } from "./index.js";

/**
 * Key-value настройки в SQLite (таблица settings).
 * Используются для состояния повторов (retry_state) и будущих настроек.
 */

export function getSetting<T>(key: string, fallback: T): T {
  const row = getDb()
    .prepare("SELECT value_json FROM settings WHERE key = ? LIMIT 1")
    .get(key) as any;
  if (!row) return fallback;
  try {
    return JSON.parse(String(row.value_json)) as T;
  } catch {
    return fallback;
  }
}

export function setSetting(key: string, value: unknown): void {
  getDb()
    .prepare(
      `INSERT INTO settings (key, value_json) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`
    )
    .run(key, JSON.stringify(value));
}

export function deleteSetting(key: string): void {
  getDb().prepare("DELETE FROM settings WHERE key = ?").run(key);
}
