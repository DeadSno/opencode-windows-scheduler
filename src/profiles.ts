import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Профили (Спринт 21): каждый профиль — отдельная директория со своей БД,
 * настройками, логами, обёртками и портом дашборда. Профиль `default`
 * использует базовую директорию плагина (как раньше — без миграции), остальные
 * живут в `<base>/profiles/<name>`.
 */

export const DEFAULT_PROFILE = "default";

/** Файл-маркер активного профиля (когда переменная окружения не задана). */
const ACTIVE_PROFILE_FILE = "active-profile";

/** Метаданные профиля: имя и порт дашборда. */
export interface ProfileMeta {
  name: string;
  port: number;
}

/** Описание профиля для RPC/GUI. */
export interface ProfileInfo {
  name: string;
  dir: string;
  port: number | null;
  isDefault: boolean;
  active: boolean;
}

/**
 * Базовая директория плагина (до профилей).
 *
 * Windows: %APPDATA%\opencode\windows-scheduler.
 * macOS/Linux: $XDG_CONFIG_HOME/opencode/windows-scheduler или
 *              ~/.config/opencode/windows-scheduler.
 * OPENCODE_SCHEDULER_HOME переопределяет всё (тесты, кастомные установки).
 */
export function getBasePluginDir(): string {
  const custom = process.env.OPENCODE_SCHEDULER_HOME?.trim();
  if (custom) return path.resolve(custom);

  if (process.platform === "win32") {
    const base = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(base, "opencode", "windows-scheduler");
  }

  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(configHome, "opencode", "windows-scheduler");
}

/** Нормализует имя профиля: нижний регистр, только [a-z0-9_-]. */
export function sanitizeProfileName(value: string | null | undefined): string {
  const normalized = (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return normalized || DEFAULT_PROFILE;
}

/** Валидация имени профиля (без «исправления»): пусто/кривые символы — ошибка. */
export function validateProfileName(value: string): string | null {
  const trimmed = (value ?? "").trim().toLowerCase();
  if (!trimmed) return "Имя профиля не может быть пустым.";
  if (!/^[a-z][a-z0-9_-]{0,39}$/.test(trimmed)) {
    return "Имя профиля: только латиница, цифры, «-» и «_», до 40 символов, не с цифры.";
  }
  return null;
}

/** Читает имя активного профиля из файла-маркера (если есть). */
function readActiveProfileMarker(base: string): string | null {
  try {
    const raw = fs.readFileSync(path.join(base, ACTIVE_PROFILE_FILE), "utf8").trim();
    return raw ? sanitizeProfileName(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Имя текущего профиля: OPENCODE_SCHEDULER_PROFILE > файл-маркер > default.
 */
export function getProfileName(): string {
  const fromEnv = process.env.OPENCODE_SCHEDULER_PROFILE?.trim();
  if (fromEnv) return sanitizeProfileName(fromEnv);
  return readActiveProfileMarker(getBasePluginDir()) ?? DEFAULT_PROFILE;
}

/** Директория профиля: default — базовая, остальные — <base>/profiles/<name>. */
export function getProfileDir(name: string = getProfileName()): string {
  const base = getBasePluginDir();
  const normalized = sanitizeProfileName(name);
  if (normalized === DEFAULT_PROFILE) return base;
  return path.join(base, "profiles", normalized);
}

/** Путь к метаданным профиля. */
function profileMetaFile(name: string): string {
  return path.join(getProfileDir(name), "profile.json");
}

/** Читает profile.json профиля (или null, если файла нет/он битый). */
export function readProfileMeta(name: string): ProfileMeta | null {
  try {
    const raw = fs.readFileSync(profileMetaFile(name), "utf8");
    const parsed = JSON.parse(raw) as Partial<ProfileMeta>;
    const profileName = sanitizeProfileName(parsed?.name ?? name);
    const port = Number(parsed?.port);
    return {
      name: profileName,
      port: Number.isFinite(port) && port >= 1 && port <= 65535 ? Math.floor(port) : 0,
    };
  } catch {
    return null;
  }
}

/** Порт дашборда профиля: env > profile.json > null (дефолтная логика сервера). */
export function getProfilePort(name: string = getProfileName()): number | null {
  const fromEnv = Number(process.env.OPENCODE_SCHEDULER_PORT);
  if (Number.isFinite(fromEnv) && fromEnv >= 1 && fromEnv <= 65535) {
    return Math.floor(fromEnv);
  }
  const meta = readProfileMeta(name);
  if (meta && meta.port > 0) return meta.port;
  return null;
}

/** Список существующих профилей (default всегда первый). */
export function listProfiles(): ProfileInfo[] {
  const base = getBasePluginDir();
  const active = getProfileName();
  const names = new Set<string>([DEFAULT_PROFILE]);

  const profilesRoot = path.join(base, "profiles");
  try {
    for (const entry of fs.readdirSync(profilesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = sanitizeProfileName(entry.name);
      if (candidate === DEFAULT_PROFILE) continue;
      names.add(candidate);
    }
  } catch {
    // profiles/ ещё нет — только default.
  }

  return Array.from(names)
    .sort((a, b) => (a === DEFAULT_PROFILE ? -1 : b === DEFAULT_PROFILE ? 1 : a.localeCompare(b)))
    .map((name) => {
      const meta = readProfileMeta(name);
      return {
        name,
        dir: getProfileDir(name),
        port: meta && meta.port > 0 ? meta.port : null,
        isDefault: name === DEFAULT_PROFILE,
        active: name === active,
      };
    });
}

/** Свободный порт для нового профиля: 3782+N, занятые profile.json пропускаются. */
function allocateProfilePort(): number {
  const used = new Set<number>();
  for (const profile of listProfiles()) {
    if (profile.port) used.add(profile.port);
  }
  for (let port = 3782; port < 3882; port += 1) {
    if (!used.has(port)) return port;
  }
  return 3782 + used.size;
}

/**
 * Создаёт профиль: директорию + profile.json. Для default просто гарантирует
 * базовую директорию. Возвращает метаданные профиля.
 */
export function createProfile(name: string, port?: number): ProfileMeta {
  const error = validateProfileName(name);
  if (error) throw new Error(error);
  const normalized = sanitizeProfileName(name);
  const dir = getProfileDir(normalized);
  fs.mkdirSync(dir, { recursive: true });

  const existing = readProfileMeta(normalized);
  const assigned =
    Number.isFinite(Number(port)) && Number(port) > 0
      ? Math.floor(Number(port))
      : existing && existing.port > 0
        ? existing.port
        : allocateProfilePort();

  const meta: ProfileMeta = { name: normalized, port: assigned };
  fs.writeFileSync(profileMetaFile(normalized), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  return meta;
}

/** Удаляет профиль (кроме default). Возвращает true, если директория удалена. */
export function deleteProfile(name: string): boolean {
  const normalized = sanitizeProfileName(name);
  if (normalized === DEFAULT_PROFILE) {
    throw new Error("Профиль default удалить нельзя.");
  }
  const dir = getProfileDir(normalized);
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });

  // Если удалили активный профиль — возвращаем маркер на default.
  const base = getBasePluginDir();
  if (readActiveProfileMarker(base) === normalized) {
    setActiveProfile(DEFAULT_PROFILE);
  }
  return true;
}

/**
 * Переключает активный профиль через файл-маркер. Изменение подхватится при
 * следующем запуске OpenCode (директории вычисляются при загрузке модуля).
 */
export function setActiveProfile(name: string): void {
  const normalized = sanitizeProfileName(name);
  if (normalized !== DEFAULT_PROFILE && !fs.existsSync(getProfileDir(normalized))) {
    throw new Error(`Профиль "${normalized}" не существует. Сначала создайте его.`);
  }
  const base = getBasePluginDir();
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(base, ACTIVE_PROFILE_FILE), `${normalized}\n`, "utf8");
}

/** true, если профиль переключается переменной окружения (маркер не поможет). */
export function isProfilePinnedByEnv(): boolean {
  return Boolean(process.env.OPENCODE_SCHEDULER_PROFILE?.trim());
}
