/**
 * Tests for the built-in agent skill `scheduled-job-best-practices`.
 * Run after `npm run build`: node test-skill.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const results = [];
function check(name, condition) {
  results.push({ name, ok: Boolean(condition) });
  console.log(`${condition ? "OK  " : "FAIL"} ${name}`);
}

const { SCHEDULER_SKILL_ID, SCHEDULER_SKILL_NAME, loadSchedulerSkill } = await import(
  "./dist/skill.js"
);

const skill = loadSchedulerSkill();

check("skill id constant is kebab-case", /^[a-z0-9]+(-[a-z0-9]+)*$/.test(SCHEDULER_SKILL_ID));
check("skill id is scheduled-job-best-practices", SCHEDULER_SKILL_ID === "scheduled-job-best-practices");
check("skill name constant is set", SCHEDULER_SKILL_NAME === "Scheduled Job Best Practices");
check("loadSchedulerSkill returns a skill", Boolean(skill));

if (skill) {
  check("skill id matches constant", skill.id === SCHEDULER_SKILL_ID);
  check("skill has a display name", skill.name === SCHEDULER_SKILL_NAME);
  check(
    "skill description mentions discovery triggers",
    typeof skill.description === "string" &&
      skill.description.length > 80 &&
      /cron/i.test(skill.description) &&
      /matrix/i.test(skill.description)
  );
  check("skill path points to an existing file", fs.existsSync(skill.path));
  check(
    "skill path is skills/<id>/SKILL.md",
    skill.path.replace(/\\/g, "/").endsWith(`/skills/${SCHEDULER_SKILL_ID}/SKILL.md`)
  );
  check("skill content is body without frontmatter", !skill.content.startsWith("---"));
  check("skill content is substantial", skill.content.length > 3000);
  check("skill content references the creation tool", skill.content.includes("schedule_task"));
  check("skill content references dry_run", skill.content.includes("dry_run"));
  check("skill content references qualityGate", skill.content.includes("qualityGate"));
  check("skill content references matrix", skill.content.includes("matrix"));
  check("skill content references dependsOn", skill.content.includes("dependsOn"));
  check("skill content references diagnostics tools", skill.content.includes("get_task_logs"));
  check(
    "skill content links the recipes reference",
    skill.content.includes("references/recipes.md")
  );

  const recipes = path.join(path.dirname(skill.path), "references", "recipes.md");
  check("reference recipes.md exists", fs.existsSync(recipes));
  if (fs.existsSync(recipes)) {
    const text = fs.readFileSync(recipes, "utf8");
    check("recipes contain concrete JSON examples", (text.match(/```json/g) || []).length >= 4);
    check("recipes cover matrix overrides", text.includes("overrides"));
  }

  const requiredFields = ["id", "name", "description", "path", "content"];
  check(
    "registration payload has every Skill.Info field",
    requiredFields.every((field) => skill[field] !== undefined)
  );
}

const pkg = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")
);
check("package ships the skills directory", (pkg.files ?? []).includes("skills"));
check("package exposes a test:skill script", Boolean(pkg.scripts?.["test:skill"]));
check(
  "npm test includes the skill suite",
  String(pkg.scripts?.test ?? "").includes("test-skill.mjs")
);

const failed = results.filter((r) => !r.ok);
console.log(`\nSkill: ${results.length - failed.length}/${results.length} checks passed.`);
process.exit(failed.length > 0 ? 1 : 0);
