import {
  listTemplates,
  saveTemplate as saveTemplateRow,
  deleteTemplate as deleteTemplateRow,
} from "./db/templates-repo.js";

/**
 * Пользовательский шаблон задачи.
 *
 * В отличие от встроенных шаблонов промптов, хранит не только текст промпта,
 * но и все настройки формы: расписание, ретраи, Quality Gate, цепочки задач
 * и файловый триггер. Это позволяет одной командой воспроизвести задачу.
 */
export interface TaskTemplate {
  /** Уникальный идентификатор (uuid). */
  id: string;
  /** Название шаблона, которое видит пользователь. */
  name: string;
  prompt: string;
  schedule?: string;
  timeoutSeconds?: number;
  /** LLM-модель задачи (если не задана — модель OpenCode по умолчанию). */
  model?: string;
  /** Приоритет задачи 0..10 (10 — наивысший). */
  priority?: number;
  retryCount?: number;
  retryDelay?: number;
  qualityGate?: string;
  /** Команда перед запуском (pre-flight). */
  beforeScript?: string;
  /** Команда после запуска (post-flight). */
  afterScript?: string;
  nextTaskOnSuccess?: string;
  nextTaskOnError?: string;
  /** DAG-зависимости: задачи, которые должны успешно завершиться раньше этой. */
  dependsOn?: string[];
  triggerType?: "cron" | "file" | "mcp-event";
  /** Параметры MCP-события (для triggerType === "mcp-event"). */
  mcpEvent?: { server: string; event: string; filter?: string };
  watchPath?: string;
  /** Рабочая директория задачи (если не задана — папка проекта). */
  workingDirectory?: string;
  /** Ограничения инструментов: белый список (пустой массив запрещён). */
  allowedTools?: string[];
  /** Ограничения инструментов: чёрный список (denied wins при конфликте). */
  deniedTools?: string[];
}

/** Читает шаблоны из БД (раньше — templates.json). */
export async function loadTemplates(): Promise<TaskTemplate[]> {
  return listTemplates();
}

/**
 * Добавляет или обновляет шаблон.
 * Если id не передан — генерируется новый. Возвращает сохранённый шаблон.
 */
export async function saveTemplate(
  template: Omit<TaskTemplate, "id"> & { id?: string }
): Promise<TaskTemplate> {
  return saveTemplateRow(template);
}

/** Удаляет шаблон по id. */
export async function deleteTemplate(id: string): Promise<void> {
  deleteTemplateRow(id);
}
