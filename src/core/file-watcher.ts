import { watch, type FSWatcher } from "chokidar";
import { loadTaskDefinitions } from "../task-transfer.js";

/**
 * Задержка между последним изменением файла и запуском задачи.
 * Нужна потому, что редакторы часто пишут файл несколькими порциями
 * (truncate + write + rename) — без дебаунса задача стартовала бы 3-5 раз.
 */
export const FILE_TRIGGER_DEBOUNCE_MS = 2000;

export type FileTriggerHandler = (
  taskName: string,
  changedPath: string
) => void | Promise<void>;

interface WatchedTask {
  /** Имя задачи так, как оно записано в tasks.json. */
  name: string;
  /** Нормализованный путь, который отслеживаем. */
  path: string;
  watcher: FSWatcher;
  /** Таймер дебаунса (одна задача = один отложенный запуск). */
  timer: NodeJS.Timeout | null;
}

/**
 * Менеджер файловых триггеров: держит по одному chokidar- watcher'у на задачу
 * с triggerType === "file" и пересобирает их при изменении tasks.json.
 */
export class FileWatchManager {
  private entries = new Map<string, WatchedTask>();
  private stopped = false;

  constructor(
    private readonly handler: FileTriggerHandler,
    private readonly debounceMs: number = FILE_TRIGGER_DEBOUNCE_MS
  ) {}

  /** Сколько задач сейчас отслеживается. */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Перечитывает tasks.json и приводит набор watcher'ов в соответствие:
   * новые задачи добавляются, удалённые/изменённые — закрываются.
   * Возвращает количество активных файловых триггеров.
   */
  async refresh(): Promise<number> {
    if (this.stopped) return 0;

    const definitions = await loadTaskDefinitions();
    const wanted = definitions
      .filter(
        (d) =>
          d.triggerType === "file" &&
          typeof d.watchPath === "string" &&
          d.watchPath.trim().length > 0
      )
      .map((d) => ({ name: d.name.trim(), path: d.watchPath!.trim() }))
      .filter((d) => d.name.length > 0);

    const wantedKeys = new Set(wanted.map((d) => d.name.toLowerCase()));

    // Убираем watcher'ы для задач, которых больше нет или у которых сменился путь.
    for (const [key, entry] of Array.from(this.entries.entries())) {
      const target = wanted.find((d) => d.name.toLowerCase() === key);
      if (!target || target.path !== entry.path) {
        await this.remove(key);
      }
    }

    // Добавляем новые.
    for (const item of wanted) {
      const key = item.name.toLowerCase();
      if (this.entries.has(key) || !wantedKeys.has(key)) continue;
      this.add(item.name, item.path);
    }

    return this.entries.size;
  }

  /** Закрывает все watcher'ы (вызывается при выгрузке плагина). */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const key of Array.from(this.entries.keys())) {
      await this.remove(key);
    }
  }

  private add(name: string, watchPath: string): void {
    let watcher: FSWatcher;
    try {
      watcher = watch(watchPath, {
        // Не считаем уже существующий файл «изменением» при старте.
        ignoreInitial: true,
        // Следим за одним файлом/папкой, без рекурсии в глубину.
        depth: 0,
        // Файлы могут быть большими: дождёмся, пока запись успокоится.
        awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
        ignorePermissionErrors: true,
      });
    } catch (err: any) {
      console.error(
        `[windows-scheduler] Не удалось начать отслеживание "${watchPath}" для задачи "${name}": ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      return;
    }

    const entry: WatchedTask = { name, path: watchPath, watcher, timer: null };

    watcher.on("change", (changedPath: string) => {
      if (this.stopped) return;
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = setTimeout(() => {
        entry.timer = null;
        if (this.stopped) return;
        try {
          const result = this.handler(name, changedPath);
          if (result && typeof (result as Promise<void>).catch === "function") {
            (result as Promise<void>).catch((err: any) => {
              console.error(
                `[windows-scheduler] Ошибка запуска задачи "${name}" по изменению файла: ${
                  err instanceof Error ? err.message : String(err)
                }`
              );
            });
          }
        } catch (err: any) {
          console.error(
            `[windows-scheduler] Ошибка запуска задачи "${name}" по изменению файла: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      }, this.debounceMs);
      // Таймер не должен удерживать процесс, если хост завершается.
      if (typeof entry.timer.unref === "function") entry.timer.unref();
    });

    watcher.on("error", (err) => {
      console.error(
        `[windows-scheduler] Ошибка наблюдения за "${watchPath}" (задача "${name}"): ${
          (err as any)?.message ?? String(err)
        }`
      );
    });

    this.entries.set(name.toLowerCase(), entry);
    console.log(
      `[windows-scheduler] Слежу за "${watchPath}" — задача "${name}" запускается при изменении файла.`
    );
  }

  private async remove(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    try {
      await entry.watcher.close();
    } catch {
      // watcher уже мог быть закрыт — не критично.
    }
  }
}
