/**
 * Тесты Спринта 21: env-переменные workspace.
 * Запуск: node test-env.mjs (после npm run build).
 * Проверяются чистые функции разбора/маскирования, env-файлы и round-trip в SQLite.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Временный конфиг-домен — до динамического импорта dist (PLUGIN_DIR/БД).
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ws-scheduler-env-"));
const pluginDir = path.join(tempRoot, "opencode", "windows-scheduler");
process.env.APPDATA = tempRoot;
process.env.OPENCODE_SCHEDULER_HOME = pluginDir;
delete process.env.OPENCODE_SCHEDULER_PROFILE;

const workspaces = await import("./dist/workspaces.js");
const db = await import("./dist/db/index.js");

const {
  MAX_WORKSPACE_ENV_PAIRS,
  addWorkspace,
  deleteWorkspace,
  getWorkspace,
  listWorkspaces,
  maskEnvForLog,
  maskSecretValue,
  normalizeWorkspaceEnv,
  parseEnvFileContent,
  readWorkspaceEnvFile,
  resolveWorkspaceEnv,
  updateWorkspace,
  workspaceEnvDir,
  writeWorkspaceEnvFile,
} = workspaces;

const results = [];
function check(name, cond) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? "OK  " : "FAIL"} ${name}`);
}

function throws(fn) {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

// --- 1. Разбор .env ------------------------------------------------------
const parsed = parseEnvFileContent(
  [
    "# комментарий",
    "",
    "API_URL=https://example.test",
    "export TOKEN=abc123",
    'QUOTED="значение в кавычках"',
    "SINGLE='single value'",
    "WITH_EQUALS=a=b=c",
    "1BAD=ignored",
    "NO_VALUE=",
    "  SPACED  =  trimmed  ",
  ].join("\r\n")
);
check("parseEnvFileContent: комментарии и пустые строки пропускаются", parsed["#"] === undefined && parsed.API_URL === "https://example.test");
check("parseEnvFileContent: префикс export снимается", parsed.TOKEN === "abc123");
check("parseEnvFileContent: двойные кавычки снимаются", parsed.QUOTED === "значение в кавычках");
check("parseEnvFileContent: одинарные кавычки снимаются", parsed.SINGLE === "single value");
check("parseEnvFileContent: '=' внутри значения сохраняется", parsed.WITH_EQUALS === "a=b=c");
check("parseEnvFileContent: невалидный ключ игнорируется", parsed["1BAD"] === undefined);
check("parseEnvFileContent: пустое значение допустимо", parsed.NO_VALUE === "");
check("parseEnvFileContent: пробелы вокруг ключа/значения обрезаются", parsed.SPACED === "trimmed");

// --- 2. Валидация пар env ------------------------------------------------
const normalized = normalizeWorkspaceEnv({ NODE_ENV: "production", PORT: 3000, EMPTY: null });
check("normalizeWorkspaceEnv: строки сохраняются", normalized?.NODE_ENV === "production");
check("normalizeWorkspaceEnv: числа приводятся к строке", normalized?.PORT === "3000");
check("normalizeWorkspaceEnv: null → пустая строка", normalized?.EMPTY === "");
check("normalizeWorkspaceEnv: null-вход → undefined", normalizeWorkspaceEnv(null) === undefined);
check("normalizeWorkspaceEnv: массив — ошибка", throws(() => normalizeWorkspaceEnv(["A=1"])));
check("normalizeWorkspaceEnv: ключ с цифры — ошибка", throws(() => normalizeWorkspaceEnv({ "1BAD": "x" })));
check("normalizeWorkspaceEnv: ключ с дефисом — ошибка", throws(() => normalizeWorkspaceEnv({ "BAD-KEY": "x" })));
check("normalizeWorkspaceEnv: объект как значение — ошибка", throws(() => normalizeWorkspaceEnv({ KEY: { nested: true } })));
const manyPairs = {};
for (let i = 0; i < MAX_WORKSPACE_ENV_PAIRS + 1; i += 1) manyPairs[`VAR_${i}`] = "x";
check("normalizeWorkspaceEnv: больше лимита пар — ошибка", throws(() => normalizeWorkspaceEnv(manyPairs)));

// --- 3. Маскирование секретов -------------------------------------------
const env = {
  API_URL: "https://example.test",
  GITHUB_TOKEN: "ghp_secret",
  DB_PASSWORD: "hunter2",
  CLIENT_SECRET: "shh",
  PRIVATE_KEY: "-----BEGIN-----",
  AUTH_HEADER: "Bearer x",
  CREDENTIALS: "user:pass",
  PLAIN: "visible",
};
const masked = maskEnvForLog(env);
check("maskEnvForLog: TOKEN маскируется", masked.GITHUB_TOKEN === "***");
check("maskEnvForLog: PASSWORD маскируется", masked.DB_PASSWORD === "***");
check("maskEnvForLog: SECRET маскируется", masked.CLIENT_SECRET === "***");
check("maskEnvForLog: KEY маскируется", masked.PRIVATE_KEY === "***");
check("maskEnvForLog: AUTH маскируется", masked.AUTH_HEADER === "***");
check("maskEnvForLog: CREDENTIAL маскируется", masked.CREDENTIALS === "***");
check("maskEnvForLog: обычные значения видны", masked.API_URL === "https://example.test" && masked.PLAIN === "visible");
check("maskEnvForLog: undefined → пустой объект", Object.keys(maskEnvForLog(undefined)).length === 0);
check("maskSecretValue: всегда '***'", maskSecretValue() === "***");

// --- 4. .env-файл workspace и приоритеты ---------------------------------
const envFilePath = path.join(tempRoot, "workspace.env");
fs.writeFileSync(
  envFilePath,
  ["FROM_FILE=file-value", "SHARED=from-file", "TOKEN_FILE=file-token"].join("\n"),
  "utf8"
);
const envFileVars = readWorkspaceEnvFile(envFilePath);
check("readWorkspaceEnvFile: читает значения", envFileVars.FROM_FILE === "file-value");
check("readWorkspaceEnvFile: отсутствующий файл → {}", Object.keys(readWorkspaceEnvFile(path.join(tempRoot, "nope.env"))).length === 0);
check("readWorkspaceEnvFile: пустой путь → {}", Object.keys(readWorkspaceEnvFile(undefined)).length === 0);

const fakeWorkspace = {
  id: "fake",
  name: "fake",
  path: tempRoot,
  createdAt: new Date().toISOString(),
  env: { SHARED: "from-pairs", EXTRA: "pair" },
  envFile: envFilePath,
};
const resolved = resolveWorkspaceEnv(fakeWorkspace);
check("resolveWorkspaceEnv: значения из файла попадают", resolved.FROM_FILE === "file-value");
check("resolveWorkspaceEnv: явные пары важнее файла", resolved.SHARED === "from-pairs");
check("resolveWorkspaceEnv: пары и файл объединяются", resolved.EXTRA === "pair" && resolved.TOKEN_FILE === "file-token");
check("resolveWorkspaceEnv: без workspace → {}", Object.keys(resolveWorkspaceEnv(undefined)).length === 0);

// --- 5. Генерация env-файла для задачи -----------------------------------
const generated = writeWorkspaceEnvFile(fakeWorkspace, pluginDir, "task-one");
check("writeWorkspaceEnvFile: возвращает путь", typeof generated === "string");
check("writeWorkspaceEnvFile: файл лежит в <plugin>/env", generated === path.join(workspaceEnvDir(pluginDir), "task-one.env"));
check("writeWorkspaceEnvFile: файл создан", Boolean(generated && fs.existsSync(generated)));
const generatedBody = generated ? fs.readFileSync(generated, "utf8") : "";
check("writeWorkspaceEnvFile: формат KEY=VALUE", generatedBody.includes("SHARED=from-pairs"));
check("writeWorkspaceEnvFile: значения из .env-файла тоже записаны", generatedBody.includes("FROM_FILE=file-value"));
check("writeWorkspaceEnvFile: реальные значения (не маска)", generatedBody.includes("file-token"));
if (process.platform !== "win32" && generated) {
  const mode = fs.statSync(generated).mode & 0o777;
  check("writeWorkspaceEnvFile: права 0600 на POSIX", mode === 0o600);
}

const noEnvGenerated = writeWorkspaceEnvFile(
  { ...fakeWorkspace, env: undefined, envFile: undefined },
  pluginDir,
  "task-one"
);
check("writeWorkspaceEnvFile: пустой env → undefined", noEnvGenerated === undefined);
check("writeWorkspaceEnvFile: старый файл удалён", !fs.existsSync(path.join(workspaceEnvDir(pluginDir), "task-one.env")));

// --- 6. Round-trip в SQLite ----------------------------------------------
const repoDir = path.join(tempRoot, "repo-one");
fs.mkdirSync(repoDir, { recursive: true });

const added = addWorkspace({
  path: repoDir,
  name: "repo-one",
  env: { API_URL: "https://example.test", GITHUB_TOKEN: "ghp_secret" },
  envFile: envFilePath,
});
check("addWorkspace: env сохранён", added.env?.API_URL === "https://example.test");
check("addWorkspace: envFile сохранён", added.envFile === envFilePath);

const loaded = getWorkspace(added.id);
check("getWorkspace: env читается из БД", loaded?.env?.GITHUB_TOKEN === "ghp_secret");
check("getWorkspace: envFile читается из БД", loaded?.envFile === envFilePath);
check("listWorkspaces: env приходит вместе с workspace", listWorkspaces()[0]?.env?.API_URL === "https://example.test");

const updated = updateWorkspace(added.id, { env: { ONLY_ONE: "1" }, envFile: null });
check("updateWorkspace: env заменяется", updated.env?.ONLY_ONE === "1" && updated.env?.API_URL === undefined);
check("updateWorkspace: envFile очищается через null", updated.envFile === undefined);
check("getWorkspace: изменения видны после update", getWorkspace(added.id)?.env?.ONLY_ONE === "1");

const cleared = updateWorkspace(added.id, { env: null });
check("updateWorkspace: env очищается через null", cleared.env === undefined);

check("updateWorkspace: невалидный env — ошибка", throws(() => updateWorkspace(added.id, { env: { "BAD KEY": "x" } })));

// --- 7. Удаление ---------------------------------------------------------
check("deleteWorkspace: удаляет workspace", deleteWorkspace(added.id) === true);
check("deleteWorkspace: env исчез вместе с записью", getWorkspace(added.id) === undefined);

db.closeDb();

// --- Итог ----------------------------------------------------------------
const failures = results.filter((item) => !item.ok);
console.log(`\nWorkspace env: ${results.length - failures.length}/${results.length} проверок успешно.`);
if (failures.length > 0) {
  for (const item of failures) console.error(`FAIL: ${item.name}`);
  process.exit(1);
}
