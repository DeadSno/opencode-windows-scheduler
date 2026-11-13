---
name: Scheduled Job Best Practices
description: Use when the user wants recurring or event-driven automation (cron, file changes, MCP events), multi-repository fan-out, or agent pipelines. Covers safe defaults, prompt design, Quality Gates, matrix builds, DAG dependencies and post-incident diagnosis with the scheduler tools.
---

# Scheduled Job Best Practices

Use this skill whenever the user asks to automate something on a schedule, on a file change,
on an MCP event, or as a multi-step pipeline. The goal is automation that is safe, cheap,
idempotent and debuggable a month later.

Respond in the user's language. This document is in English for portability.

## 1. Start by looking at what already exists

Call `list_tasks` before creating anything. If a similar task exists, prefer `update_task`
(partial update, matrix clones are synchronized) over delete + create. Automation that
silently duplicates work is worse than no automation.

Check the returned fields: schedule, trigger, working directory, model, dependencies, matrix
summary, last run.

## 2. Choose the simplest shape that works

| User need | Shape | Why |
| --- | --- | --- |
| "Every morning / every hour / weekly" | `schedule_task` with cron | Durable OS-level schedule, survives restarts |
| "When this file changes" | `triggerType: "file"` + `watchPath` | No polling; the watcher debounces bursts |
| "When my MCP server reports an event" | `triggerType: "mcp-event"` + `mcpEvent` | Event-driven, no wasted runs |
| "Same work in N repositories" | `matrix.workspaceIds` | One definition, isolated clones, aggregated status |
| "A then B then C" | `dependsOn` + `nextTaskOnSuccess` / `nextTaskOnError` | Explicit DAG, failures stop the line |
| "Try again if it fails" | `retryCount` + `retryDelay` | Handles flaky networks and rate limits |

Do not use a 5-field cron for a one-off reminder. Do not build a pipeline with chained
prompts inside a single task when `dependsOn` exists: a failed step would be invisible.

## 3. Write prompts that survive without context

Every run starts from a clean slate: no chat history, no memory of the previous run, nobody
to answer questions. A good prompt states:

1. **Goal** — the outcome in one sentence.
2. **Scope** — exact paths, repositories or modules to touch.
3. **Constraints** — what must not change, tool limits, style rules.
4. **Verification** — the command that proves success (this is the Quality Gate).
5. **Output** — where to write the report and what to include (counts, links, failures).

Bad: `Check the repo and fix problems.`
Good: `In ./services/api run the test suite. If tests fail, fix only failures caused by
type errors, then re-run until green or 20 minutes elapse. Write a summary to
reports/nightly-api.md with the failing test names and the commit you started from.`

Never ask the agent to "ask the user" in a scheduled prompt — nobody is there. If a decision
is genuinely ambiguous, tell it to stop and write the question into the report.

## 4. Safety defaults

- **Least privilege**: set `allowedTools` / `deniedTools`. Read-only monitoring jobs should
  not be allowed to `write` or run destructive shell commands.
- **Timeout**: always set `timeoutSeconds` for jobs that call networks or models. Default
  timeouts are a safety net, not a plan.
- **Quality Gate**: pass `qualityGate` whenever a machine-checkable success criterion exists
  (`npm test`, `pytest -q`, `curl -f`, `git diff --quiet`). A run that "looks successful" is
  not evidence.
- **No secrets in prompts**: prompts are stored in plain text and appear in logs. Reference
  environment variables or files instead.
- **Idempotent by design**: a job may run twice (retry, catch-up after downtime, manual run).
  Prefer "ensure state" over "append" — e.g. rewrite a report file rather than appending.
- **Blast radius**: avoid `git push --force`, `rm -rf`, mass dependency upgrades or
  production deploys without a Quality Gate and a manual `run_task_now` smoke test first.

## 5. Matrix builds (multi-repository)

Use a matrix when the same prompt must run in several workspaces:

- `matrix.workspaceIds` — the repositories, referenced by workspace ID (call
  `manage_workspaces` with `action: "list"` to discover them).
- `matrix.strategy` — `parallel` (default) or `sequential`.
- `matrix.failureMode` — `continue` (default, aggregated as `partial`) or `stop`.
- `matrix.concurrency` — cap simultaneous clones; respect machine and API limits. Keep it
  small (2–4) unless the work is purely local.
- `matrix.overrides` — per-workspace prompt/model/qualityGate/hooks when one repository
  differs (different package manager, stricter gate).
- `matrix.createAggregator` — creates a follow-up task that runs once after all clones.

Rules of thumb:

- The matrix parent never runs itself; only its clones do. Do not set `workspaceId` on the
  parent — it is a validation error to combine it with `matrix`.
- A dependency on a matrix parent waits for **all** clones to succeed.
- If clones are inherently independent (linting, docs), `failureMode: "continue"` gives a
  useful aggregate. If one failure makes the rest pointless (deploy), use `"stop"`.
- After editing a matrix parent with `update_task`, clones are diffed and synchronized;
  running clones are left alone.

## 6. DAG rules

- `dependsOn` lists task names that must have succeeded (their latest run) before this task
  starts.
- `nextTaskOnSuccess` / `nextTaskOnError` chain a single follow-up run; use them for
  notifications and rollbacks.
- Keep chains short and named by intent (`deploy` → `smoke-tests` → `notify-release`).
- Cycles and self-dependencies are rejected; if a chain grows past 4–5 nodes, consider one
  task with an explicit internal checklist instead.

## 7. Validate before you commit

1. `dry_run` with the task name (or without a name for the whole pipeline): shows order,
   dependencies, matrix fan-out, estimated duration and cost. Nothing is executed.
2. Create the task with `schedule_task`.
3. `run_task_now` once and inspect `get_history` / `get_task_logs`. A schedule that has never
   run successfully is a liability.
4. Only then tell the user it is ready, and state the cron expression in plain language
   ("every weekday at 09:00 local time").

## 8. Diagnosing failures later

- `get_history` filtered by `taskName` and `status` — statuses: `running`, `success`, `error`,
  `timeout`, `partial`.
- `get_task_logs` with `lines` — tail of the wrapper log; use it to distinguish model failure,
  Quality Gate failure, timeout and lock-skip.
- Matrix problems: `matrix_control` with `action: "results"` for counters, `action: "cancel"`
  to stop pending clones, `action: "cleanup"` to remove clones whose parent is gone.
- A timeout usually means the prompt is too broad. Split it or raise `timeoutSeconds`
  deliberately.
- A skipped run (`already running`) means the previous run overran its interval; shorten the
  prompt, raise the interval, or set a smaller timeout.

## 9. Anti-patterns

| Anti-pattern | Consequence | Fix |
| --- | --- | --- |
| `* * * * *` with a heavy prompt | Runs overlap, lock-skips, cost spikes | Realistic interval + timeout |
| Prompt depending on chat context | Nonsense output at 03:00 | Self-contained prompt with paths |
| No Quality Gate on a "fixer" job | Broken code reported as success | `qualityGate: "npm test"` |
| Matrix with 20 workspaces, no concurrency cap | Machine and API saturation | `matrix.concurrency: 2–4` |
| Secrets inside the prompt | Leak into DB, logs and dashboard | Env vars or files |
| Deleting a matrix parent's clone by hand | Orphaned history, broken aggregate | `update_task` on the parent |
| Creating a duplicate instead of updating | Double runs, conflicting writes | `update_task` |

## 10. Final checklist

Before saying the job is done, confirm:

- [ ] `list_tasks` checked; no duplicate exists.
- [ ] Trigger type matches the need (cron / file / MCP event).
- [ ] Prompt states goal, scope, constraints, verification and output.
- [ ] `timeoutSeconds` set; `qualityGate` set when checkable.
- [ ] `allowedTools` / `deniedTools` follow least privilege.
- [ ] Matrix: workspaces correct, concurrency capped, failure mode justified.
- [ ] `dry_run` reviewed.
- [ ] One successful `run_task_now` with clean `get_history`.
- [ ] Cron expressed in words for the user.

See `references/recipes.md` for complete examples.
