import fs from "node:fs/promises";
import path from "node:path";
import { LOCK_DIR, STALE_LOCK_MAX_AGE_MS } from "../types.js";

/**
 * Менеджер файловых блокировок для предотвращения наложения запусков одной задачи.
 *
 * Блокировка реализуется через атомарное создание файла с флагом 'wx' (exclusive create).
 * Если файл уже существует — блокировка удерживается другим запуском.
 * После завершения задачи файл удаляется.
 * Зависшие блокировки (старше STALE_LOCK_MAX_AGE_MS) удаляются при инициализации.
 */
export class LockManager {
  private readonly lockDir: string;

  constructor(lockDir: string = LOCK_DIR) {
    this.lockDir = lockDir;
  }

  /** Имя lock-файла для задачи. */
  private lockFileName(taskName: string): string {
    return `${taskName}.lock`;
  }

  /** Полный путь к lock-файлу задачи. */
  private lockFilePath(taskName: string): string {
    return path.join(this.lockDir, this.lockFileName(taskName));
  }

  /**
   * Инициализация директории блокировок и очистка зависших (старых) файлов.
   * Вызывается при старте плагина.
   */
  async initialize(): Promise<void> {
    await fs.mkdir(this.lockDir, { recursive: true });

    const files = await fs.readdir(this.lockDir).catch(() => []);
    const now = Date.now();

    for (const file of files) {
      if (!file.endsWith(".lock")) continue;
      const fullPath = path.join(this.lockDir, file);
      try {
        const stat = await fs.stat(fullPath);
        const age = now - stat.mtimeMs;
        if (age > STALE_LOCK_MAX_AGE_MS) {
          await fs.unlink(fullPath).catch(() => {});
          // eslint-disable-next-line no-console
          console.log(
            `[windows-scheduler] Удалён зависший lock-файл: ${file} (возраст ${Math.round(
              age / 1000
            )} с)`
          );
        }
      } catch {
        // Игнорируем ошибки чтения отдельных файлов при очистке.
      }
    }
  }

  /**
   * Пытается захватить блокировку для задачи.
   * Возвращает true, если блокировка захвачена (файл создан).
   * Возвращает false, если блокировка уже удерживается другим запуском.
   */
  async acquire(taskName: string): Promise<boolean> {
    await fs.mkdir(this.lockDir, { recursive: true });
    const lockPath = this.lockFilePath(taskName);

    try {
      // 'wx' — exclusive create: ошибка если файл уже существует.
      await fs.writeFile(lockPath, String(Date.now()), { flag: "wx" });
      return true;
    } catch (err: any) {
      if (err.code === "EEXIST") {
        return false;
      }
      throw err;
    }
  }

  /**
   * Освобождает блокировку задачи (удаляет lock-файл).
   * Не выбрасывает ошибку, если файл уже удалён.
   */
  async release(taskName: string): Promise<void> {
    const lockPath = this.lockFilePath(taskName);
    try {
      await fs.unlink(lockPath);
    } catch (err: any) {
      if (err.code !== "ENOENT") throw err;
    }
  }

  /**
   * Проверяет, удерживается ли блокировка задачей в данный момент.
   */
  async isLocked(taskName: string): Promise<boolean> {
    const lockPath = this.lockFilePath(taskName);
    try {
      await fs.stat(lockPath);
      return true;
    } catch (err: any) {
      if (err.code === "ENOENT") return false;
      throw err;
    }
  }
}

/**
 * Выполняет функцию с захватом файловых блокировок.
 * Если блокировка уже удерживается — пропускает выполнение и возвращает null.
 * Гарантирует освобождение блокировки в finally (включая при ошибках).
 */
export async function withLock<T>(
  lockManager: LockManager,
  taskName: string,
  fn: () => Promise<T>
): Promise<T | null> {
  const acquired = await lockManager.acquire(taskName);
  if (!acquired) {
    // eslint-disable-next-line no-console
    console.log(
      `[windows-scheduler] Запуск задачи "${taskName}" пропущен: удерживается активная блокировка.`
    );
    return null;
  }

  try {
    return await fn();
  } finally {
    await lockManager.release(taskName);
  }
}
