import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let cached: string | null = null;

/**
 * Версия плагина из package.json.
 *
 * Читается в рантайме из корня пакета рядом со скомпилированным модулем
 * (dist/version.js -> ../package.json). Если файл недоступен — «unknown».
 */
export function getPluginVersion(): string {
  if (cached) return cached;
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const raw = fs.readFileSync(path.join(here, "..", "package.json"), "utf8");
    const pkg = JSON.parse(raw) as { version?: unknown };
    cached =
      typeof pkg.version === "string" && pkg.version.trim()
        ? pkg.version.trim()
        : "unknown";
  } catch {
    cached = "unknown";
  }
  return cached;
}
