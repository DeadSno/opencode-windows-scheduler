/**
 * Тесты Спринта 27: git-триггер (src/core/git-trigger.ts).
 * Запуск: node test-git-trigger.mjs (после npm run build).
 * Создаёт временный git-репозиторий, делает коммиты и проверяет checkGitTrigger.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkGitTrigger } from "./dist/core/git-trigger.js";
import { getDb } from "./dist/db/index.js";

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

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "git-trigger-test-"));
const repoDir = path.join(tmpRoot, "repo");
fs.mkdirSync(repoDir, { recursive: true });

// Очищаем git_state от остатков предыдущих запусков тестов.
getDb().prepare("DELETE FROM git_state").run();

// Настраиваем git пользователя для коммитов.
execFileSync("git", ["-C", repoDir, "init"], { stdio: "pipe" });
execFileSync("git", ["-C", repoDir, "config", "user.email", "test@test.test"], { stdio: "pipe" });
execFileSync("git", ["-C", repoDir, "config", "user.name", "Test"], { stdio: "pipe" });

// Начальный коммит (baseline).
fs.writeFileSync(path.join(repoDir, "a.txt"), "v1\n");
execFileSync("git", ["-C", repoDir, "add", "a.txt"], { stdio: "pipe" });
execFileSync("git", ["-C", repoDir, "commit", "-m", "initial"], { stdio: "pipe" });

const head1 = execFileSync("git", ["-C", repoDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const defaultBranch = execFileSync("git", ["-C", repoDir, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();

// --- 1. Первый опрос = baseline (HEAD запоминается, задача не запускается) ---
{
  const r = await checkGitTrigger(
    { name: "git-baseline", cwd: repoDir, branch: undefined, paths: undefined, ignore: undefined },
    { persist: false }
  );
  check("baseline: статус 'baseline'", r.status === "baseline");
  check("baseline: head совпадает с текущим", r.head === head1);
  check("baseline: файлов нет", r.files.length === 0);
  check("baseline: message русскоязычный", typeof r.message === "string" && r.message.length > 0);
}

// --- 2. Нет изменений после baseline (два вызова с persist: true, одно имя) ---
{
  const first = await checkGitTrigger(
    { name: "git-no-changes", cwd: repoDir, branch: undefined, paths: undefined, ignore: undefined },
    { persist: true }
  );
  check("no-changes: первый вызов baseline", first.status === "baseline");
  const second = await checkGitTrigger(
    { name: "git-no-changes", cwd: repoDir, branch: undefined, paths: undefined, ignore: undefined },
    { persist: true }
  );
  check("no-changes: второй вызов без коммитов → 'no-changes'", second.status === "no-changes");
  check("no-changes: head совпадает", second.head === head1);
}

// --- 3. Новый коммит → changed (то же имя задачи, state сохраняется) ---
{
  // Первый вызов: baseline, сохраняет текущий HEAD как state.
  const r0 = await checkGitTrigger(
    { name: "git-changed", cwd: repoDir, branch: undefined, paths: undefined, ignore: undefined },
    { persist: true }
  );
  check("changed: первый вызов baseline", r0.status === "baseline");
  check("changed: head сохранён как baseline", r0.head === head1);

  // Делаем новый коммит.
  fs.writeFileSync(path.join(repoDir, "b.txt"), "v2\n");
  execFileSync("git", ["-C", repoDir, "add", "b.txt"], { stdio: "pipe" });
  execFileSync("git", ["-C", repoDir, "commit", "-m", "add b.txt"], { stdio: "pipe" });
  const head2 = execFileSync("git", ["-C", repoDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

  // Второй вызов: head2 != head1 → changed.
  const r2 = await checkGitTrigger(
    { name: "git-changed", cwd: repoDir, branch: undefined, paths: undefined, ignore: undefined },
    { persist: true }
  );
  check("changed: второй вызов после коммита → 'changed'", r2.status === "changed");
  check("changed: новый head", r2.head === head2);
  check("changed: from = старый head (head1)", r2.from === head1);
  check("changed: файлы включают b.txt", r2.files.includes("b.txt"));
  check("changed: matched = файлы (без фильтров)", r2.matched.length === r2.files.length);
  check("changed: message содержит shortened head", r2.message.includes(head2.slice(0, 7)));
}

// --- 4. Фильтр по ветке (gitBranch) ---

// task на ветку feature → changed.
{
  // Создаём ветку feature.
  execFileSync("git", ["-C", repoDir, "checkout", "-b", "feature"], { stdio: "pipe" });

  // Устанавливаем baseline на текущем HEAD.
  const rBase = await checkGitTrigger(
    { name: "git-branch-ok", cwd: repoDir, branch: "feature", paths: undefined, ignore: undefined },
    { persist: true }
  );
  check("branch filter: baseline established", rBase.status === "baseline");

  // Делаем новый коммит на feature.
  fs.writeFileSync(path.join(repoDir, "c.txt"), "v3\n");
  execFileSync("git", ["-C", repoDir, "add", "c.txt"], { stdio: "pipe" });
  execFileSync("git", ["-C", repoDir, "commit", "-m", "add c.txt on feature"], { stdio: "pipe" });
  const headFeature = execFileSync("git", ["-C", repoDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

  // task на ветку feature → changed.
  const rOk = await checkGitTrigger(
    { name: "git-branch-ok", cwd: repoDir, branch: "feature", paths: undefined, ignore: undefined },
    { persist: true }
  );
  check("branch filter: подходящая ветка → 'changed'", rOk.status === "changed");
  check("branch filter: head = feature-HEAD", rOk.head === headFeature);
}

// task на ветку defaultBranch (не feature) → branch-mismatch.
{
  // Устанавливаем baseline (текущая ветка feature, фильтр defaultBranch).
  await checkGitTrigger(
    { name: "git-branch-bad", cwd: repoDir, branch: defaultBranch, paths: undefined, ignore: undefined },
    { persist: true }
  );

  // Находимся на ветке feature, фильтр говорит defaultBranch → branch-mismatch.
  const rBad = await checkGitTrigger(
    { name: "git-branch-bad", cwd: repoDir, branch: defaultBranch, paths: undefined, ignore: undefined },
    { persist: false }
  );
  check("branch filter: неподходящая ветка → 'branch-mismatch'", rBad.status === "branch-mismatch");
  check("branch filter: message о ветке", rBad.message.includes(defaultBranch));
}

// task без фильтра ветки → changed.
{
  // Устанавливаем baseline.
  await checkGitTrigger(
    { name: "git-branch-any", cwd: repoDir, branch: undefined, paths: undefined, ignore: undefined },
    { persist: true }
  );

  // Делаем коммит.
  fs.writeFileSync(path.join(repoDir, "d.txt"), "v4\n");
  execFileSync("git", ["-C", repoDir, "add", "d.txt"], { stdio: "pipe" });
  execFileSync("git", ["-C", repoDir, "commit", "-m", "add d.txt"], { stdio: "pipe" });

  const rAny = await checkGitTrigger(
    { name: "git-branch-any", cwd: repoDir, branch: undefined, paths: undefined, ignore: undefined },
    { persist: true }
  );
  check("branch filter: без фильтра → 'changed' при новом HEAD", rAny.status === "changed");
}

// --- 5. Фильтр по путям (gitPaths) ---

// Устанавливаем baseline для обеих задач.
await checkGitTrigger(
  { name: "git-paths-ok", cwd: repoDir, branch: undefined, paths: ["src/**"], ignore: undefined },
  { persist: true }
);
await checkGitTrigger(
  { name: "git-paths-ign", cwd: repoDir, branch: undefined, paths: ["*.log"], ignore: undefined },
  { persist: true }
);

// Коммитим файл в подпапку src/ и файл в корне.
fs.mkdirSync(path.join(repoDir, "src"), { recursive: true });
fs.writeFileSync(path.join(repoDir, "src", "deep.ts"), "deep\n");
fs.writeFileSync(path.join(repoDir, "root.txt"), "root\n");
execFileSync("git", ["-C", repoDir, "add", "src/deep.ts", "root.txt"], { stdio: "pipe" });
execFileSync("git", ["-C", repoDir, "commit", "-m", "add deep.ts and root.txt"], { stdio: "pipe" });

// gitPaths только src/** → только deep.ts подходит.
const r = await checkGitTrigger(
  { name: "git-paths-ok", cwd: repoDir, branch: undefined, paths: ["src/**"], ignore: undefined },
  { persist: true }
);
check("path filter: src/** ловит src/deep.ts", r.status === "changed");
check("path filter: matched включает src/deep.ts", r.matched.includes("src/deep.ts"));
check("path filter: matched не включает root.txt", !r.matched.includes("root.txt"));

// gitPaths только *.log → ничего не подходит (ignored).
const rIgn = await checkGitTrigger(
  { name: "git-paths-ign", cwd: repoDir, branch: undefined, paths: ["*.log"], ignore: undefined },
  { persist: false }
);
check("path filter: несовпадающие пути → 'ignored'", rIgn.status === "ignored");
check("path filter: matched пуст", rIgn.matched.length === 0);

// --- 6. Игнорируемые пути (gitIgnore) ---

// Устанавливаем baseline.
await checkGitTrigger(
  { name: "git-ignore-ok", cwd: repoDir, branch: undefined, paths: undefined, ignore: ["*.log", "noise*"] },
  { persist: true }
);

fs.writeFileSync(path.join(repoDir, "noise.log"), "noise\n");
fs.writeFileSync(path.join(repoDir, "important.md"), "important\n");
execFileSync("git", ["-C", repoDir, "add", "noise.log", "important.md"], { stdio: "pipe" });
execFileSync("git", ["-C", repoDir, "commit", "-m", "add noise.log and important.md"], { stdio: "pipe" });

const r6 = await checkGitTrigger(
  {
    name: "git-ignore-ok",
    cwd: repoDir,
    branch: undefined,
    paths: undefined,
    ignore: ["*.log", "noise*"],
  },
  { persist: true }
);
check("ignore filter: игнорируемые файлы исключены", r6.status === "changed");
check("ignore filter: important.md в matched", r6.matched.includes("important.md"));
check("ignore filter: noise.log не в matched", !r6.matched.includes("noise.log"));

// --- 7. Не git-репозиторий ---
{
  const notRepo = path.join(tmpRoot, "not-a-repo");
  fs.mkdirSync(notRepo, { recursive: true });
  const r = await checkGitTrigger(
    { name: "git-no-repo", cwd: notRepo, branch: undefined, paths: undefined, ignore: undefined },
    { persist: false }
  );
  check("no-repo: статус 'no-repo'", r.status === "no-repo");
  check("no-repo: message о репозитории", r.message.includes("git-репозиторий"));
}

// Накрываем временную директорию.
try {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
} catch {}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} OK`);
if (failed.length > 0) {
  console.error(`Провалено: ${failed.map((r) => r.name).join("; ")}`);
  process.exit(1);
}
