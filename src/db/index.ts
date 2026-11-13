import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { PLUGIN_DIR } from "../types.js";
import { applySchema } from "./schema.js";

/**
 * Подключение к SQLite через встроенный `node:sqlite` (Node 22.5+).
 *
 * Мы не импортируем модуль статически: в @types/node 20 типов для node:sqlite
 * ещё нет, а `createRequire` позволяет получить модуль без объявления
 * глобального ambient-модуля (и не конфликтовать с будущими версиями типов).
 */
export interface SqliteRunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

export interface SqliteStatement {
  run(...params: any[]): SqliteRunResult;
  get(...params: any[]): any;
  all(...params: any[]): any[];
  iterate(...params: any[]): IterableIterator<any>;
}

export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

type DatabaseSyncCtor = new (
  location: string,
  options?: Record<string, unknown>
) => SqliteDatabase;

const nodeRequire = createRequire(import.meta.url);

function loadSqlite(): DatabaseSyncCtor {
  try {
    const mod = nodeRequire("node:sqlite") as { DatabaseSync: DatabaseSyncCtor };
    return mod.DatabaseSync;
  } catch (err: any) {
    throw new Error(
      `node:sqlite недоступен (${err instanceof Error ? err.message : String(err)}). ` +
        "Планировщику требуется Node.js 22.5+ (рекомендуется Node 24)."
    );
  }
}

/** Путь к БД. Переменная окружения нужна только тестам. */
const DEFAULT_DB_FILE = process.env.OPENCODE_SCHEDULER_DB?.trim()
  ? path.resolve(process.env.OPENCODE_SCHEDULER_DB.trim())
  : path.join(PLUGIN_DIR, "scheduler.db");

let dbFile = DEFAULT_DB_FILE;
let db: SqliteDatabase | null = null;

/** Открывает (или переоткрывает) соединение и применяет схему. */
export function initDb(file: string = dbFile): SqliteDatabase {
  if (db && file === dbFile) return db;
  if (db) closeDb();

  dbFile = file;
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const DatabaseSync = loadSqlite();
  const instance = new DatabaseSync(file);

  // WAL — конкурентное чтение во время записи и устойчивость к сбоям.
  instance.exec("PRAGMA journal_mode = WAL;");
  instance.exec("PRAGMA foreign_keys = ON;");
  instance.exec("PRAGMA busy_timeout = 5000;");
  applySchema(instance);

  db = instance;
  return instance;
}

/** Singleton-соединение. Создаётся лениво при первом обращении. */
export function getDb(): SqliteDatabase {
  return db ?? initDb();
}

/** Закрывает соединение (вызывается при выгрузке плагина). */
export function closeDb(): void {
  if (!db) return;
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  } catch {
    // Чекпойнт не критичен при закрытии.
  }
  try {
    db.close();
  } catch {
    // Соединение могло быть уже закрыто.
  }
  db = null;
}

/** Текущий путь к файлу БД. */
export function getDbFile(): string {
  return dbFile;
}

/** Сбрасывает WAL в основной файл — нужно перед отдачей .db наружу. */
export function checkpointDb(): void {
  getDb().exec("PRAGMA wal_checkpoint(TRUNCATE);");
}

/** Информация о хранилище для /api/health и футера дашборда. */
export function getDbStatus(): {
  engine: "sqlite";
  file: string;
  journalMode: string;
  wal: boolean;
} {
  let journalMode = "unknown";
  try {
    const row = getDb().prepare("PRAGMA journal_mode;").get() as any;
    journalMode = String(row?.journal_mode ?? "unknown");
  } catch {
    // Если БД ещё не открыта — не роняем health-check.
  }
  return {
    engine: "sqlite",
    file: dbFile,
    journalMode,
    wal: journalMode.toLowerCase() === "wal",
  };
}

/**
 * Выполняет функцию в транзакции BEGIN IMMEDIATE.
 * При любой ошибке откатывает изменения и пробрасывает исключение дальше.
 */
export function withTransaction<T>(fn: () => T): T {
  const instance = getDb();
  instance.exec("BEGIN IMMEDIATE;");
  try {
    const result = fn();
    instance.exec("COMMIT;");
    return result;
  } catch (err) {
    try {
      instance.exec("ROLLBACK;");
    } catch {
      // Откат мог не понадобиться (например, SQLite уже откатил сам).
    }
    throw err;
  }
}

/** Пуста ли БД (не считая служебных настроек вроде retry_state). */
export function isDatabaseEmpty(): boolean {
  const row = getDb()
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM tasks) +
         (SELECT COUNT(*) FROM history) +
         (SELECT COUNT(*) FROM metrics) +
         (SELECT COUNT(*) FROM templates) AS count`
    )
    .get() as any;
  return Number(row?.count) === 0;
}
