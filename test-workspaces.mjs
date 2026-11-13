// Спринт 13: Multi-Repo Workspaces.
// CRUD workspace, привязка задач, cwd/workspace-контекст обёрток,
// DAG между репозиториями и удаление workspace без удаления задач.
//
// Запуск: node test-workspaces.mjs (после npm run build).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sched-workspace-test-"));
process.env.APPDATA = tempRoot;
process.env.OPENCODE_SCHEDULER_HOME = path.join(tempRoot, "opencode", "windows-scheduler");

const pluginDir = path.join(tempRoot, "opencode", "windows-scheduler");
fs.mkdirSync(pluginDir, { recursive: true });

const assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL: " + msg);
    process.exitCode = 1;
  } else {
    console.log("OK: " + msg);
  }
};

function git(cwd, args) {
  return spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout: 10000,
    windowsHide: true,
  });
}

function makeRepo(name, remote) {
  const dir = path.join(tempRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ["init"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Scheduler Test"]);
  fs.writeFileSync(path.join(dir, "README.md"), `# ${name}\n`);
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "init"]);
  if (remote) git(dir, ["remote", "add", "origin", remote]);
  return dir;
}

const backendPath = makeRepo("backend-repo", "https://example.com/acme/backend.git");
const frontendPath = makeRepo("frontend-repo", "https://example.com/acme/frontend.git");

const { initDb, closeDb } = await import("./dist/db/index.js");
const { saveTask, getTask, listTasks } = await import("./dist/db/tasks-repo.js");
const { recordRun, getHistory } = await import("./dist/db/history-repo.js");
const { selectDependentsToTrigger } = await import("./dist/core/record-history.js");
const { WRAPPER_SCRIPT } = await import("./dist/core/ps-wrapper.js");
const { buildBashWrapperScript } = await import("./dist/core/wrappers/bash.js");
const {
  addWorkspace,
  listWorkspaces,
  getWorkspace,
  updateWorkspace,
  deleteWorkspace,
  readGitRemote,
  readGitBranch,
} = await import("./dist/workspaces.js");

initDb();

// --- 1. CRUD ------------------------------------------------------------
const backend = addWorkspace({ name: "backend", path: backendPath });
const frontend = addWorkspace({ name: "frontend", path: frontendPath });

assert(Boolean(backend.id && backend.id.length > 10), "addWorkspace вернул id");
assert(backend.path === path.resolve(backendPath), "путь workspace нормализован в absolute");
assert(Boolean(backend.color), "workspace получил цветовой маркер");
assert(readGitRemote(backendPath) === "https://example.com/acme/backend.git", "git remote прочитан");
assert(Boolean(readGitBranch(backendPath)), "git branch прочитан для dry-run preview");

const all = listWorkspaces();
assert(all.length === 2, `listWorkspaces вернул 2 workspace (${all.length})`);
assert(getWorkspace(backend.id)?.name === "backend", "getWorkspace находит по id");

let duplicateError = "";
try {
  addWorkspace({ name: "backend-2", path: backendPath });
} catch (err) {
  duplicateError = err.message;
}
assert(duplicateError.includes("уже существует"), "дубликат пути workspace отклонён");

let missingError = "";
try {
  addWorkspace({ name: "missing", path: path.join(tempRoot, "no-such-repo") });
} catch (err) {
  missingError = err.message;
}
assert(
  missingError.includes("Workspace 'missing' недоступен по пути"),
  "несуществующий путь workspace отклонён с понятной ошибкой"
);

const renamed = updateWorkspace(frontend.id, { name: "web", path: frontendPath });
assert(renamed.name === "web", "updateWorkspace обновляет имя");
assert(getWorkspace(frontend.id)?.name === "web", "обновление сохранено в БД");

// --- 2. Привязка задач --------------------------------------------------
saveTask({
  name: "backend-build",
  schedule: "0 * * * *",
  prompt: "Собери backend",
  workspaceId: backend.id,
});
saveTask({
  name: "frontend-deploy",
  schedule: "0 * * * *",
  prompt: "Задеплой frontend",
  workspaceId: frontend.id,
  dependsOn: ["backend-build"],
});
saveTask({
  name: "shared-docs",
  schedule: "0 9 * * *",
  prompt: "Обнови документацию",
});

assert(getTask("backend-build")?.workspaceId === backend.id, "workspaceId сохранён в задаче");
assert(listTasks().length === 3, "задачи с workspace и без него читаются из БД");

// --- 3. History хранит workspace_id -------------------------------------
const startedAt = "2026-03-02T10:00:00.000Z";
const historyId = recordRun(
  "backend-build",
  "success",
  startedAt,
  1234,
  null,
  null,
  100,
  0.01,
  "test/model",
  "success",
  "skipped",
  "2026-03-02T10:00:01.234Z",
  backend.id
);
assert(historyId > 0, "recordRun записал запуск");
const historyRecord = getHistory("backend-build", 10)[0];
assert(historyRecord.workspaceId === backend.id, "history содержит workspace_id запуска");

// --- 4. DAG между workspace: только имена, без угадывания cwd ----------
const frontendDef = getTask("frontend-deploy");
assert(frontendDef?.workspaceId === frontend.id, "frontend-задача привязана к своему workspace");
const next = selectDependentsToTrigger("backend-build", listTasks(), getHistory(null, 200));
assert(next.includes("frontend-deploy"), "DAG запускает задачу из другого workspace по имени");

// --- 5. Обёртки передают cwd и git-контекст ----------------------------
assert(
  WRAPPER_SCRIPT.includes("$WorkspaceName") &&
    WRAPPER_SCRIPT.includes("[workspace]") &&
    WRAPPER_SCRIPT.includes("Set-Location $Workdir"),
  "PowerShell-обёртка: cwd=$Workdir и лог workspace"
);

const bashScript = buildBashWrapperScript({
  sanitizedName: "frontend-deploy",
  taskName: "frontend-deploy",
  promptFile: path.join(pluginDir, "prompt.txt"),
  timeoutSeconds: 60,
  lockFile: path.join(pluginDir, "lock"),
  workdir: frontend.path,
  logFile: path.join(pluginDir, "frontend.log"),
  recorderFile: path.resolve("dist/core/record-history.js"),
  workspaceName: "web",
});
assert(bashScript.includes("cd "), "bash-обёртка делает cd в cwd задачи");
assert(bashScript.includes(frontend.path), "bash-обёртка использует путь workspace как cwd");
assert(bashScript.includes("WORKSPACE_NAME") && bashScript.includes("[workspace]"), "bash-обёртка логирует workspace, branch и remote");
assert(
  bashScript.includes("--start") && bashScript.includes("--finish"),
  "bash-обёртка вызывает --start/--finish для crash recovery"
);

// --- 6. Удаление workspace не удаляет задачи ---------------------------
const deleted = deleteWorkspace(frontend.id);
assert(deleted, "deleteWorkspace вернул true");
assert(getWorkspace(frontend.id) === undefined, "workspace удалён из БД");
assert(Boolean(getTask("frontend-deploy")), "задача удалённого workspace сохранена");
assert(
  getTask("frontend-deploy")?.workspaceId === undefined,
  "у задачи очищен workspaceId после удаления workspace"
);
assert(
  getHistory("backend-build", 10)[0].workspaceId === backend.id,
  "история запусков не переписывается при удалении workspace"
);
assert(listWorkspaces().length === 1, "остался один workspace");

closeDb();
console.log("\nWorkspaces test completed.");
