import type { ScheduledTaskInfo } from "../../types.js";

/** Чем запускается задача. */
export type TriggerType = "cron" | "file" | "mcp-event";

/**
 * Параметры создания задачи. Бэкенд сам решает, как преобразовать cron
 * в родное расписание ОС и как зарегистрировать команду запуска.
 */
export interface CreateTaskOptions {
  /** Уникальное имя задачи (без папки планировщика). */
  name: string;
  /**
   * Абсолютный путь к исполняемой обёртке:
   *  - Windows: .cmd, вызывающий PowerShell-обёртку;
   *  - Linux/macOS: .sh с вызовом `opencode run`.
   */
  command: string;
  /** 5-полевое cron-выражение. Игнорируется при триггерах file/mcp-event. */
  schedule: string;
  /** Таймаут выполнения в секундах (используется обёрткой). */
  timeoutSeconds?: number;
  /** "cron" (по умолчанию), "file" или "mcp-event". */
  triggerType?: TriggerType;
  /** Рабочая директория задачи (для POSIX-бэкендов попадает в cron/plist). */
  workingDirectory?: string;
  /** Путь к файлу лога (для POSIX-бэкендов — перенаправление вывода). */
  logFile?: string;
  /** LLM-модель задачи (хранится в реестре; используется обёрткой). */
  model?: string;
  /** Приоритет задачи 0..10 (хранится в реестре для диагностики). */
  priority?: number;
}

/** Результат немедленного запуска. */
export interface RunTaskResult {
  /** true — задача уже выполняется, повторный запуск не потребовался. */
  alreadyRunning: boolean;
}

/**
 * Абстрактный бэкенд планировщика ОС.
 *
 * Реализации:
 *  - WindowsScheduler — schtasks;
 *  - LinuxScheduler   — crontab;
 *  - MacScheduler     — launchd.
 */
export interface SchedulerBackend {
  /** Платформа Node.js, для которой предназначен бэкенд. */
  readonly platform: NodeJS.Platform;
  /** Человекочитаемое название планировщика (для GUI и логов). */
  readonly title: string;

  /** Создаёт (или пересоздаёт) задачу. */
  createTask(options: CreateTaskOptions): Promise<void>;
  /** Удаляет задачу. Повторное удаление не считается ошибкой. */
  deleteTask(name: string): Promise<void>;
  /** Запускает задачу немедленно. */
  runTask(name: string): Promise<RunTaskResult>;
  /** Возвращает список задач плагина (короткие имена). */
  listTasks(): Promise<ScheduledTaskInfo[]>;
  /** Ставит задачу на паузу (disable). */
  pauseTask(name: string): Promise<void>;
  /** Снимает задачу с паузы (enable). */
  resumeTask(name: string): Promise<void>;
}
