/**
 * Glob-маски без внешних зависимостей (Спринт 27).
 *
 * Поддерживается подмножество, достаточное для фильтров файловых и git-триггеров:
 *   *        — любые символы, кроме "/"
 *   **       — любые символы, включая "/" (в т.ч. ноль сегментов: `src/**\/x.ts`)
 *   ?        — один символ, кроме "/"
 *   [abc]    — класс символов, [a-z] — диапазон, [!abc] / [^abc] — отрицание
 *   {a,b}    — альтернативы (в т.ч. вложенные)
 *   !pattern — отрицание маски (для ignore-списков, обрабатывается matchesAnyGlob)
 *
 * Пути нормализуются к POSIX-виду ("\" → "/"), ведущий "./" отбрасывается.
 * На Windows сравнение регистронезависимое, на остальных платформах — точное.
 */

const WINDOWS = process.platform === "win32";

/** Нормализует путь или маску: "/" как разделитель, без ведущего "./". */
export function normalizePath(value: unknown): string {
  let text = String(value ?? "").trim().replace(/\\/g, "/");
  if (!text) return "";
  while (text.startsWith("./")) text = text.slice(2);
  // Схлопываем повторные слэши, но не трогаем начало (UNC уже приведён к "/").
  text = text.replace(/\/{2,}/g, "/");
  return text;
}

/** Экранирует символ регулярного выражения. */
function escapeRe(ch: string): string {
  return /[.+^$()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

/**
 * Преобразует glob-маску в регулярное выражение.
 * Маска предполагается полной (от начала до конца строки).
 */
export function globToRegExp(pattern: unknown): RegExp {
  const source = normalizePath(pattern);
  let out = "^";

  const compile = (text: string): string => {
    let result = "";
    let j = 0;
    while (j < text.length) {
      const ch = text[j];
      if (ch === "*") {
        if (text[j + 1] === "*") {
          const isSegment = (j === 0 || text[j - 1] === "/") && text[j + 2] === "/";
          if (isSegment) {
            // "**/" — ноль или более сегментов пути.
            result += "(?:[^/]+/)*";
            j += 3;
            continue;
          }
          if (j > 0 && text[j - 1] === "/") {
            result += "(?:[^/]+/)*[^/]*";
          } else {
            result += ".*";
          }
          j += 2;
          continue;
        }
        result += "[^/]*";
        j += 1;
        continue;
      }
      if (ch === "?") {
        result += "[^/]";
        j += 1;
        continue;
      }
      if (ch === "[") {
        const close = text.indexOf("]", j + 1);
        if (close === -1) {
          result += "\\[";
          j += 1;
          continue;
        }
        let body = text.slice(j + 1, close);
        if (body.startsWith("!")) body = `^${body.slice(1)}`;
        else if (body.startsWith("^")) body = `\\${body}`;
        result += `[${body}]`;
        j = close + 1;
        continue;
      }
      if (ch === "{") {
        // Находим парную закрывающую скобку.
        let depth = 0;
        let end = -1;
        for (let k = j; k < text.length; k++) {
          if (text[k] === "{") depth++;
          else if (text[k] === "}") {
            depth--;
            if (depth === 0) {
              end = k;
              break;
            }
          }
        }
        if (end === -1) {
          result += "\\{";
          j += 1;
          continue;
        }
        const body = text.slice(j + 1, end);
        const parts = splitAlternatives(body);
        result += `(?:${parts.map((part) => compile(part)).join("|")})`;
        j = end + 1;
        continue;
      }
      if (ch === "}") {
        result += "\\}";
        j += 1;
        continue;
      }
      result += escapeRe(ch);
      j += 1;
    }
    return result;
  };

  out += compile(source);
  out += "$";
  return new RegExp(out, WINDOWS ? "i" : "");
}

/** Разбивает "{a,b,c}" по запятым верхнего уровня. */
function splitAlternatives(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of body) {
    if (ch === "{") depth++;
    if (ch === "}") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

/** true, если путь матчится хотя бы одной маске. */
export function matchesGlob(path: unknown, pattern: unknown): boolean {
  const candidate = normalizePath(path);
  if (!candidate) return false;
  const re = globToRegExp(pattern);
  if (re.test(candidate)) return true;
  // Маска каталога "src/**" должна матчить и сам "src".
  const raw = normalizePath(pattern).replace(/\/$/, "");
  if (raw.endsWith("/**")) {
    return globToRegExp(raw.slice(0, -3)).test(candidate);
  }
  return false;
}

/**
 * Проверяет путь по списку масок с поддержкой отрицаний.
 * `!pattern` исключает совпадение; порядок важен (последнее правило побеждает).
 */
export function matchesAnyGlob(path: unknown, patterns: unknown): boolean {
  if (!Array.isArray(patterns)) return false;
  let matched = false;
  for (const pattern of patterns) {
    const text = String(pattern ?? "").trim();
    if (!text) continue;
    if (text.startsWith("!")) {
      if (matchesGlob(path, text.slice(1))) matched = false;
    } else if (matchesGlob(path, text)) {
      matched = true;
    }
  }
  return matched;
}

/** true, если путь не попал ни в одну маску из ignore-списка (или список пуст). */
export function isIgnored(path: unknown, ignore: unknown): boolean {
  if (!Array.isArray(ignore) || ignore.length === 0) return false;
  const candidate = normalizePath(path);
  for (const pattern of ignore) {
    const text = String(pattern ?? "").trim();
    if (!text) continue;
    if (text.startsWith("!")) continue;
    if (matchesGlob(candidate, text)) return true;
  }
  return false;
}

/**
 * Отбирает файлы по include-маскам с учётом ignore-списка.
 * Пустой include-список означает «любой файл».
 */
export function filterPaths(
  files: string[],
  include?: string[] | null,
  ignore?: string[] | null
): string[] {
  const list = Array.isArray(files) ? files : [];
  const includes = Array.isArray(include) ? include.filter(Boolean) : [];
  return list.filter((file) => {
    const path = normalizePath(file);
    if (!path) return false;
    if (isIgnored(path, ignore)) return false;
    if (includes.length === 0) return true;
    return matchesAnyGlob(path, includes);
  });
}

/** Относительный путь файла от каталога; null, если файл вне каталога. */
export function relativeTo(base: unknown, file: unknown): string | null {
  const root = normalizePath(base).replace(/\/$/, "");
  const target = normalizePath(file);
  if (!root) return target;
  if (target === root) return "";
  const prefix = root.endsWith("/") ? root : `${root}/`;
  if (WINDOWS) {
    if (target.toLowerCase().startsWith(prefix.toLowerCase())) {
      return target.slice(prefix.length);
    }
    return null;
  }
  return target.startsWith(prefix) ? target.slice(prefix.length) : null;
}
