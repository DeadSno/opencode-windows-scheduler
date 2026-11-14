import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PLUGIN_DIR } from "../types.js";

/**
 * Зашифрованное хранилище секретов (Спринт 26).
 *
 * Зависимостей нет: ключ 32 байта лежит в `secrets.key` (права 0600), сами
 * значения — в `secrets.json`, зашифрованные AES-256-GCM. Имя секрета
 * используется как AAD, поэтому перестановка записей между именами ломает
 * расшифровку. В открытом виде секреты не попадают ни в settings.json, ни в
 * tasks.json, ни в историю, ни в логи — для этого есть resolveSecretRefs()
 * и redactSecretsInText().
 *
 * Ссылка на секрет в env выглядит как `${secret:NAME}`. Ссылка может быть
 * частью значения: `Authorization=Bearer ${secret:GITHUB_TOKEN}`.
 */

export const SECRETS_FILE = path.join(PLUGIN_DIR, "secrets.json");
export const SECRETS_KEY_FILE = path.join(PLUGIN_DIR, "secrets.key");
export const SECRET_REF_RE = /\$\{secret:([A-Za-z0-9_.-]{1,64})\}/g;
const SECRET_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const KEY_BYTES = 32;

interface StoredSecret {
  /** IV в base64 (12 байт). */
  iv: string;
  /** Auth tag в base64 (16 байт). */
  tag: string;
  /** Шифротекст в base64. */
  data: string;
  updatedAt: string;
}

interface SecretsFile {
  version: 1;
  secrets: Record<string, StoredSecret>;
}

export interface SecretListItem {
  name: string;
  /** Маска вида `••••ABCD` — само значение никогда не возвращается. */
  preview: string;
  updatedAt: string;
}

interface CacheEntry {
  stamp: string;
  file: SecretsFile;
}

let cache: CacheEntry | null = null;
let keyCache: { stamp: string; key: Buffer } | null = null;

function warn(message: string, err: unknown): void {
  try {
    console.warn(
      `[secrets] ${message}: ${err instanceof Error ? err.message : String(err)}`
    );
  } catch {
    // console может быть недоступен — молча игнорируем.
  }
}

/** Проверяет имя секрета; возвращает trimmed-значение. */
export function validateSecretName(name: string): string {
  const value = String(name ?? "").trim();
  if (!SECRET_NAME_RE.test(value)) {
    throw new Error(
      "Имя секрета: латиница, цифры, '_', '.', '-', от 1 до 64 символов."
    );
  }
  return value;
}

/** true, если значение содержит хотя бы одну ссылку `${secret:...}`. */
export function hasSecretRef(value: unknown): boolean {
  if (typeof value !== "string") return false;
  SECRET_REF_RE.lastIndex = 0;
  return SECRET_REF_RE.test(value);
}

function ensureDir(): void {
  fs.mkdirSync(PLUGIN_DIR, { recursive: true });
}

function chmodPrivate(file: string): void {
  if (process.platform === "win32") return;
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // ACL на некоторых ФС не поддерживают chmod — не критично.
  }
}

/** Читает или создаёт ключ шифрования. */
function loadKey(): Buffer {
  ensureDir();
  try {
    const stat = fs.statSync(SECRETS_KEY_FILE);
    const stamp = `${stat.mtimeMs}:${stat.size}`;
    if (keyCache && keyCache.stamp === stamp) return keyCache.key;
    const raw = fs.readFileSync(SECRETS_KEY_FILE);
    if (raw.length !== KEY_BYTES) {
      throw new Error("повреждён файл ключа секретов");
    }
    keyCache = { stamp, key: raw };
    return raw;
  } catch (err: any) {
    if (err?.code !== "ENOENT") throw err;
    const key = crypto.randomBytes(KEY_BYTES);
    fs.writeFileSync(SECRETS_KEY_FILE, key, { mode: 0o600 });
    chmodPrivate(SECRETS_KEY_FILE);
    keyCache = { stamp: `${fs.statSync(SECRETS_KEY_FILE).mtimeMs}:${KEY_BYTES}`, key };
    return key;
  }
}

function emptyFile(): SecretsFile {
  return { version: 1, secrets: {} };
}

/** Читает secrets.json с кэшем по mtime/size. Битый файл — пустое хранилище. */
function readFileSafe(): SecretsFile {
  try {
    const stat = fs.statSync(SECRETS_FILE);
    const stamp = `${stat.mtimeMs}:${stat.size}`;
    if (cache && cache.stamp === stamp) return cache.file;
    const parsed = JSON.parse(fs.readFileSync(SECRETS_FILE, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("некорректный формат secrets.json");
    }
    const rawSecrets = (parsed as any).secrets;
    const secrets: Record<string, StoredSecret> = {};
    if (rawSecrets && typeof rawSecrets === "object" && !Array.isArray(rawSecrets)) {
      for (const [name, entry] of Object.entries(rawSecrets)) {
        const record = entry as Partial<StoredSecret>;
        if (
          SECRET_NAME_RE.test(name) &&
          typeof record?.iv === "string" &&
          typeof record?.tag === "string" &&
          typeof record?.data === "string"
        ) {
          secrets[name] = {
            iv: record.iv,
            tag: record.tag,
            data: record.data,
            updatedAt:
              typeof record.updatedAt === "string"
                ? record.updatedAt
                : new Date(0).toISOString(),
          };
        }
      }
    }
    const file: SecretsFile = { version: 1, secrets };
    cache = { stamp, file };
    return file;
  } catch (err: any) {
    if (err?.code !== "ENOENT") warn("не удалось прочитать secrets.json", err);
    return emptyFile();
  }
}

/** Атомарная запись: temp + rename, права 0600. */
function writeFileSafe(file: SecretsFile): void {
  ensureDir();
  const tmp = `${SECRETS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(file, null, 2), { encoding: "utf8", mode: 0o600 });
  try {
    fs.rmSync(SECRETS_FILE, { force: true });
  } catch {
    // файла нет — не ошибка
  }
  fs.renameSync(tmp, SECRETS_FILE);
  chmodPrivate(SECRETS_FILE);
  try {
    const stat = fs.statSync(SECRETS_FILE);
    cache = { stamp: `${stat.mtimeMs}:${stat.size}`, file };
  } catch {
    cache = null;
  }
}

function encryptValue(name: string, value: string, key: Buffer): StoredSecret {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(name, "utf8"));
  const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
    updatedAt: new Date().toISOString(),
  };
}

function decryptValue(name: string, entry: StoredSecret, key: Buffer): string {
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(entry.iv, "base64")
  );
  decipher.setAAD(Buffer.from(name, "utf8"));
  decipher.setAuthTag(Buffer.from(entry.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(entry.data, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

/** Сохраняет (или перезаписывает) секрет. Значение не логируется. */
export function setSecret(name: string, value: string): SecretListItem {
  const secretName = validateSecretName(name);
  const text = String(value ?? "");
  const key = loadKey();
  const file = readFileSafe();
  file.secrets[secretName] = encryptValue(secretName, text, key);
  writeFileSafe(file);
  return {
    name: secretName,
    preview: previewOf(text),
    updatedAt: file.secrets[secretName].updatedAt,
  };
}

/** Читает секрет; undefined, если его нет или он не расшифровывается. */
export function getSecret(name: string): string | undefined {
  try {
    const secretName = validateSecretName(name);
    const file = readFileSafe();
    const entry = file.secrets[secretName];
    if (!entry) return undefined;
    return decryptValue(secretName, entry, loadKey());
  } catch (err) {
    warn("не удалось расшифровать секрет", err);
    return undefined;
  }
}

/** true, если секрет существует и расшифровывается. */
export function hasSecret(name: string): boolean {
  return getSecret(name) !== undefined;
}

/** Удаляет секрет; true — запись была. */
export function deleteSecret(name: string): boolean {
  const secretName = validateSecretName(name);
  const file = readFileSafe();
  if (!(secretName in file.secrets)) return false;
  delete file.secrets[secretName];
  writeFileSafe(file);
  return true;
}

function previewOf(value: string): string {
  const text = String(value ?? "");
  if (!text) return "••••";
  const tail = text.length >= 4 ? text.slice(-4) : "";
  return tail ? `••••${tail}` : "••••";
}

/** Список секретов без значений (только имена, маски и время обновления). */
export function listSecrets(): SecretListItem[] {
  const file = readFileSafe();
  return Object.keys(file.secrets)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => {
      let preview = "••••";
      try {
        const value = decryptValue(name, file.secrets[name], loadKey());
        preview = previewOf(value);
      } catch {
        preview = "••••";
      }
      return { name, preview, updatedAt: file.secrets[name].updatedAt };
    });
}

/** Подставляет все ссылки `${secret:NAME}` в строку. */
export function expandSecretRefs(value: string): {
  value: string;
  missing: string[];
} {
  const missing = new Set<string>();
  const result = String(value ?? "").replace(SECRET_REF_RE, (_match, name: string) => {
    const secret = getSecret(name);
    if (secret === undefined) {
      missing.add(name);
      return "";
    }
    return secret;
  });
  return { value: result, missing: [...missing] };
}

/**
 * Разворачивает ссылки во всех значениях env. Отсутствующие секреты дают
 * пустую строку и попадают в `missing` (только имена — без значений).
 */
export function resolveSecretRefs(env: Record<string, string>): {
  env: Record<string, string>;
  missing: string[];
} {
  const resolved: Record<string, string> = {};
  const missing = new Set<string>();
  for (const [key, value] of Object.entries(env ?? {})) {
    const result = expandSecretRefs(String(value ?? ""));
    resolved[key] = result.value;
    for (const name of result.missing) missing.add(name);
  }
  return { env: resolved, missing: [...missing] };
}

/** Все расшифрованные значения (для редактирования текста). Кэш на 5 секунд. */
let valuesCache: { at: number; values: string[] } | null = null;

function knownSecretValues(): string[] {
  const now = Date.now();
  if (valuesCache && now - valuesCache.at < 5_000) return valuesCache.values;
  const file = readFileSafe();
  const values: string[] = [];
  let key: Buffer;
  try {
    key = loadKey();
  } catch {
    return [];
  }
  for (const [name, entry] of Object.entries(file.secrets)) {
    try {
      const value = decryptValue(name, entry, key);
      if (value.length >= 4) values.push(value);
    } catch {
      // повреждённая запись пропускается
    }
  }
  // Длинные значения первыми, чтобы не оставить хвост после короткой замены.
  values.sort((a, b) => b.length - a.length);
  valuesCache = { at: now, values };
  return values;
}

/**
 * Вырезает из произвольного текста известные значения секретов и типовые
 * присваивания вида `TOKEN=...` / `password: ...`.
 */
export function redactSecretsInText(text: unknown): string {
  const source = typeof text === "string" ? text : String(text ?? "");
  if (!source) return source;
  let result = source;

  // Защищаем ссылки ${secret:NAME} от общих правил маскировки: слово "secret"
  // попадает под чувствительные ключи и ломало бы ссылки.
  const protectedRefs: string[] = [];
  result = result.replace(SECRET_REF_RE, (_match: string, name: string) => {
    const placeholder = `\u0000SECRET_REF_${protectedRefs.length}\u0000`;
    protectedRefs.push(`\${secret:${name}}`);
    return placeholder;
  });

  for (const value of knownSecretValues()) {
    if (!value) continue;
    result = result.split(value).join("***");
  }

  result = result.replace(
    /\b([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|CREDENTIAL|AUTH)[A-Za-z0-9_]*)\b(\s*[=:]\s*)(["']?)([^\s"',;]+)\3/gi,
    (_match: string, key: string, sep: string, quote: string) => `${key}${sep}${quote}***${quote}`
  );

  // Восстанавливаем защищённые ссылки.
  for (let i = 0; i < protectedRefs.length; i++) {
    result = result.split(`\u0000SECRET_REF_${i}\u0000`).join(protectedRefs[i]);
  }

  return result;
}

/** Сбрасывает кэши (для тестов и после ручного изменения файлов). */
export function resetSecretsCache(): void {
  cache = null;
  keyCache = null;
  valuesCache = null;
}
