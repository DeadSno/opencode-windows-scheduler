# Features

A complete catalog of what the scheduler can do, with examples and the caveats that
matter in practice.

- [Scheduling](#scheduling)
- [Execution policy](#execution-policy)
- [Orchestration](#orchestration)
- [Multi-repository workspaces](#multi-repository-workspaces)
- [Observability](#observability)
- [Management](#management)
- [Agent interface](#agent-interface)
- [Platform support](#platform-support)
- [Limits and non-goals](#limits-and-non-goals)

## Scheduling

### Cron schedules

Five-field cron: `minute hour day-of-month month day-of-week`.

| Pattern | Example | Meaning |
| --- | --- | --- |
| Every N minutes | `*/15 * * * *` | Every 15 minutes |
| Fixed time | `0 9 * * *` | Daily at 09:00 |
| Weekdays | `30 8 * * 1-5` | 08:30 Monday to Friday |
| Monthly | `0 3 1 * *` | 03:00 on the 1st |

The Windows backend translates cron to native Task Scheduler triggers. Expressions
that `schtasks` cannot express are rejected at creation time with an explicit error
instead of being silently approximated.

### File triggers

```json
{
  "name": "regen-api-client",
  "triggerType": "file",
  "watchPath": "C:\\projects\\api\\openapi.yaml",
  "prompt": "Regenerate the API client from openapi.yaml and run contract tests."
}
```

The file is watched with chokidar in the plugin host, changes are debounced. File
triggers ignore `schedule`.

### MCP event triggers

```json
{
  "name": "on-pr-opened",
  "triggerType": "mcp-event",
  "mcpEvent": { "server": "github", "event": "pull_request.opened", "filter": "repo=acme/api" },
  "prompt": "Review the newly opened pull request."
}
```

Events are emitted through the `emit_event` RPC method.

### Manual runs and pause

- `run_task_now` starts a task immediately, through the same wrapper (timeout, lock,
  hooks, Quality Gate).
- `pause_task` / `resume_task` disable and re-enable the OS entry. For a matrix parent
  every clone is paused.

## Execution policy

### Timeout and no-overlap

Every run has `timeoutSeconds` (default 3600). On expiry the process tree is stopped
and the run is recorded as `timeout`. A lock file prevents two runs of the same task
from overlapping; the second start exits immediately and is recorded as `skipped`.

### Pre-flight, Quality Gate, post-flight

```json
{
  "name": "nightly-deps",
  "schedule": "0 2 * * *",
  "beforeScript": "git pull --ff-only",
  "prompt": "Update dependencies, fix breaking changes, keep the diff minimal.",
  "qualityGate": "npm test",
  "afterScript": "git push",
  "timeoutSeconds": 2400
}
```

| Hook | When | Effect of non-zero exit |
| --- | --- | --- |
| `beforeScript` | before the agent starts | run is cancelled, pre-flight marked failed |
| `qualityGate` | after a successful response | run is marked as a Quality Gate failure (error) |
| `afterScript` | after the run, even on failure | reported in history, does not rewrite a success |

### Retries

`retryCount` and `retryDelay` (seconds) retry a failed run. Retry state is persisted,
so a crash cannot produce an infinite retry loop. Retries happen before chains and
dependents.

### Model and priority

`model` selects an OpenCode model (for example `anthropic/claude-3-5-sonnet`);
omitting it uses the OpenCode default. `priority` is `0..10` and is passed through to
the scheduler entry.

### Tool restrictions

`allowedTools` and `deniedTools` declare the intended role of the job. They are
recorded in history for audit. They are **metadata, not a sandbox**: they do not
restrict `opencode` at runtime today.

## Orchestration

### Chains

```json
{ "name": "build", "nextTaskOnSuccess": "deploy", "nextTaskOnError": "notify-failure" }
```

Exactly one follow-up task is started after a run.

### DAG dependencies

```json
{ "name": "smoke-tests", "dependsOn": ["deploy"], "schedule": "0 * * * *" }
```

A dependent starts only when every dependency's latest run is successful. If a
dependency is a matrix, **all clones** must be successful — a `partial` matrix blocks
dependents.

### Matrix builds (fan-out)

One definition, one clone per workspace:

```json
{
  "name": "deploy",
  "schedule": "0 3 * * *",
  "prompt": "Build, test and deploy this repository. Report what changed.",
  "matrix": {
    "workspaceIds": ["ws-frontend", "ws-backend", "ws-mobile"],
    "strategy": "parallel",
    "failureMode": "continue",
    "concurrency": 2,
    "overrides": {
      "ws-mobile": { "qualityGate": "flutter test", "prompt": "Use the Flutter toolchain." }
    }
  }
}
```

| Field | Default | Meaning |
| --- | --- | --- |
| `strategy` | `parallel` | `sequential` starts the next clone only after the previous one finishes |
| `failureMode` | `continue` | `stop` aborts the remaining clones after the first failure |
| `concurrency` | unlimited | Maximum clones running at once (ignored for `sequential`) |
| `aggregation` | `summary` | `summary` writes one aggregate record for the parent |
| `createAggregator` | `false` | Also create `<parent>-matrix-complete` depending on every clone |
| `overrides` | none | Per-workspace prompt/model/Quality Gate/hooks |

Behavior worth knowing:

- Clones are named `<parent>-matrix-<workspace>`, inherit the parent definition and get
  their own working directory.
- The parent never runs itself; its status is the aggregate: `success`, `error`,
  `partial` (some clones failed under `continue`), or `running`.
- Editing the parent (workspaces, prompt, overrides, concurrency) **syncs** the clone
  set: missing clones are created, changed ones updated, removed ones deleted. Clones
  with a running job are never touched.
- Cancelling a matrix (`matrix_control` with `action: "cancel"`) marks pending clones
  as cancelled and stops running ones. Deleting a parent deletes its whole family.
- `matrix_control` with `action: "cleanup"` removes orphaned clones whose parent is
  gone; the same cleanup also runs at plugin startup.

## Multi-repository workspaces

A workspace is a named directory: id, name, path, optional git remote and color.

```json
{ "id": "ws-api", "name": "API", "path": "C:\\projects\\api", "color": "#3b82f6" }
```

Use `workspaceId` instead of `workingDirectory` to run a task in a workspace. Paths are
validated on add/update/import, and the dashboard groups tasks and runs by workspace.
Workspaces are the unit that matrix builds fan out to.

## Observability

### History

Every run becomes a row: status, start/finish, duration, error, tokens, cost, model,
pre/post-flight results, next chained task, workspace and tool restrictions. Statuses:

| Status | Meaning |
| --- | --- |
| `running` | started, not finished |
| `success` | finished, no Quality Gate failure |
| `error` | agent error, hook failure or Quality Gate failure |
| `timeout` | killed by the timeout |
| `partial` | matrix aggregate with both successes and failures |

### Metrics

Per-task counters and totals: runs, successes, errors, tokens, cost. Available through
`get_history`, the RPC layer and the dashboard header. A 14-day analytics slice —
per-day buckets (UTC), success rate, token-based cost estimate, top tasks by cost,
matrix and model breakdowns — is available through `get_analytics` /
`GET /api/analytics` and the dashboard's «📊 Аналитика за период» block. History is
pruned automatically (age and size limits, see Settings) and can be exported as
CSV/JSON (`GET /api/history/export`).

### Logs

Each run appends to `logs/<task>.log` — pre/post hooks, Quality Gate output and the
agent's stdout/stderr. `get_task_logs` returns the tail (1–1000 lines).

### Dry run

`dry_run` simulates one task or every task: execution order, DAG prerequisites, matrix
fan-out and estimated time. Nothing is executed and nothing is created.

### Dashboard

A local web dashboard shows tasks, matrix tabs, per-workspace summaries, DAG markers,
metrics, a 14-day analytics block (KPIs, daily bar chart, top tasks by cost, matrices),
recent runs and CSV/JSON history export. It binds to localhost and has no authentication
— do not expose it. `GET /api/health` reports plugin version, scheduler backend, queue
depth and database status for external monitoring.

## Management

### Templates

Save a definition as a reusable template, then create tasks from it with one click or
one tool call.

### Export and import

`export_tasks` produces a versioned JSON document with definitions, including matrix
configuration and `matrixParentId`. `import_tasks` validates every record and reports
per-record errors instead of failing the whole batch. Unknown workspaces and invalid
matrix combinations are rejected explicitly.

### Notifications

Webhook notifications on run completion, configurable in settings and testable with
`test_notification`.

### Crash recovery

Runs left in `running` after a crash are marked `error` on the next plugin start, so
the timeline never lies. Orphaned matrix clones are cleaned up at startup as well.

### Settings

Global defaults (timeout, concurrency, notifications, history retention) live in
`settings.json` and are editable from the GUI/RPC layer. History retention keeps the
raw run log bounded: `history.retentionDays` (default 30) and `history.maxRecords`
(default 5000); `0` disables the respective limit. Cleanup runs at most once a day on
plugin start, records `lastCleanupAt` / `lastCleanupDeleted`, and is also available as
the `cleanup_history` RPC and the GUI's «Очистить сейчас» button. Aggregates in
`metrics.json` are not affected by retention.

## Agent interface

Twelve tools: `schedule_task`, `list_tasks`, `update_task`, `delete_task`,
`run_task_now`, `pause_task`, `resume_task`, `get_history`, `get_task_logs`, `dry_run`,
`manage_workspaces`, `matrix_control`.

A bundled skill, `scheduled-job-best-practices`, teaches the agent safe defaults:
least privilege, Quality Gates, timeout, matrix concurrency, DAG rules and a
create → dry-run → run-now → inspect loop. It is registered automatically by the
plugin, no installation step required.

## Platform support

| Capability | Windows | Linux | macOS |
| --- | --- | --- | --- |
| Cron scheduling | Task Scheduler | crontab | launchd |
| Fallback | — | — | crontab |
| Timeout and lock | PowerShell wrapper | bash wrapper | bash wrapper |
| File triggers | chokidar | chokidar | chokidar |
| History, metrics, dashboard | yes | yes | yes |
| Agent tools and skill | yes | yes | yes |

## Limits and non-goals

- **No one-shot scheduling yet.** Only cron, file and MCP-event triggers exist; use
  `run_task_now` for immediate runs. A one-shot trigger is on the roadmap.
- **No session continuity.** Every run starts a fresh `opencode run` session.
- **No sandbox.** Hooks, Quality Gates and prompts run with your user privileges.
- **No authentication on the dashboard.** Localhost only by design.
- **Secrets are not encrypted.** Use environment variables or an external secret
  manager.
- **`allowedTools` / `deniedTools` are advisory.** They document intent and are
  recorded in history; enforcement is not implemented.
- **Matrix clones are separate tasks.** They appear in the task list (grouped under the
  parent) and consume global concurrency slots like any other run.
