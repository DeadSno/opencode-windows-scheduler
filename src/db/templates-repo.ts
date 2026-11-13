import { randomUUID } from "node:crypto";
import { getDb } from "./index.js";
import type { TaskTemplate } from "../templates.js";

/** Репозиторий пользовательских шаблонов задач. */

function rowToTemplate(row: any): TaskTemplate {
  return JSON.parse(String(row.definition_json)) as TaskTemplate;
}

/** Все шаблоны (по имени). */
export function listTemplates(): TaskTemplate[] {
  const rows = getDb()
    .prepare(
      "SELECT id, name, definition_json FROM templates ORDER BY name COLLATE NOCASE ASC"
    )
    .all() as any[];
  return rows
    .map(rowToTemplate)
    .filter(
      (item) =>
        item &&
        typeof item.id === "string" &&
        typeof item.name === "string" &&
        typeof item.prompt === "string"
    );
}

/** Шаблон по id. */
export function getTemplate(id: string): TaskTemplate | undefined {
  const row = getDb()
    .prepare("SELECT definition_json FROM templates WHERE id = ? LIMIT 1")
    .get(id) as any;
  return row ? rowToTemplate(row) : undefined;
}

/**
 * Добавляет или обновляет шаблон. Если id не передан — генерируется uuid.
 * Пустое название — ошибка (как в старом saveTemplate).
 */
export function saveTemplate(
  template: Omit<TaskTemplate, "id"> & { id?: string }
): TaskTemplate {
  const normalized: TaskTemplate = {
    ...template,
    id: template.id?.trim() || randomUUID(),
    name: template.name.trim(),
    prompt: template.prompt,
  };

  if (!normalized.name) {
    throw new Error("Название шаблона не может быть пустым.");
  }

  getDb()
    .prepare(
      `INSERT INTO templates (id, name, definition_json)
       VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         definition_json = excluded.definition_json`
    )
    .run(normalized.id, normalized.name, JSON.stringify(normalized));

  return normalized;
}

/** Удаляет шаблон по id. */
export function deleteTemplate(id: string): void {
  getDb().prepare("DELETE FROM templates WHERE id = ?").run(id);
}

/** Количество шаблонов (для миграции и тестов). */
export function countTemplates(): number {
  const row = getDb().prepare("SELECT COUNT(*) AS count FROM templates").get() as any;
  return Number(row?.count) || 0;
}
