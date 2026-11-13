# Features

A complete catalog of what the scheduler can do, with examples and the caveats that
matter in practice.

- [Scheduling](#scheduling)
- [Execution policy](#execution-policy)
- [Orchestration](#orchestration)
- [Multi-repository workspaces](#multi-repository-workspaces)
- [Profiles (multi-project)](#profiles-multi-project)
- [Workspace environment variables](#workspace-environment-variables)
- [Observability](#observability)
- [Management](#management)
- [Agent interface](#agent-interface)
- [Platform support](#platform-support)
- [Limits and non-goals](#limits-and-non-goals)

## Scheduling

### Cron schedules

Five-field cron: `minute hour day-of-month month day-of-week`. Supports lists,
ranges and steps in every field (`0 8-10,18 * * 1-5/2`), month and weekday names
(`0 9 * * MON-FRI`), `@every` sugar (`@every 15m`, `@every 2h`, `@every 1d`),
`L` as the last day of the month and the `d#n` n-th weekday form (`0 9 * * FRI#3`).

| Pattern | Example | Meaning |
| --- | --- | --- |
| Every N minutes | `*/15 * * * *` | Every 15 minutes |
| Fixed time | `0 9 * * *` | Daily at 09:00 |
| Weekdays | `30 8 * * 1-5` | 08:30 Monday to Friday |
| Monthly | `0 3 1 * *` | 03:00 on the 1st |
| Last day | `0 3 L * *` | 03:00 on the last day of the month |
| N-th weekday | `0 9 * * FRI#3` | 09:00 on the third Friday |
| Sugar | `@every 15m` | Every 15 minutes |

The Windows backend translates simple cron expressions to native Task Scheduler
triggers. Expressions `schtasks` cannot express (`L`, `#`, complex lists) or tasks
with a timezone other than the system one are registered in poll mode: the OS task
wakes the wrapper every minute and `schedule-gate` decides whether the agent runs.

### One-shot runs

`triggerType: "once"` runs a task exactly once at a specific moment. Use either
`runAt` (ISO-8601, or a local date string such as `2026-11-13 22:40`) or
`delaySeconds` (delay from now):

```json
{
  "name": "deploy-once",
  "triggerType": "once",
  "runAt": "2026-11-13T22:40:00+03:00",
  "prompt": "Deploy the current main branch."
}
```

```json
{ "name": "remind-later", "triggerType": "once", "delaySeconds": 3600, "prompt": "..." }
```

`runAt` wins when both are present. `schedule` is ignored. One-shot tasks are
registered natively (`schtasks /sc ONCE`, Linux `at`, macOS launchd cleanup
agent), are not repeated after a plugin restart, and cannot be combined with a
matrix.

### Session continuity

Each scheduled run can either start a fresh OpenCode session (`new`, default),
reuse a persistent session stored on the task, or continue the latest session
(`last`, mapped to `opencode --continue`). Set `session` on the task; for
`reuse` a `sessionId` is auto-generated and stored with the task definition —
it is never accepted from user input or exported as plain text.

```json
{
  "name": "nightly-analyst",
  "schedule": "0 3 * * *",
  "session": "reuse",
  "sessionMaxRuns": 10,
  "prompt": "Refresh the analysis."
}
```

- `session`: `new` (default), `reuse` (pass `--session <id>`), `last` (pass `--continue`).
- `sessionMaxRuns` (only for `reuse`): how many runs the reused session
  survives before it is deleted (`opencode session delete`) and a fresh session
  is started. Unset/0 means no limit.
- `sessionId` is per machine/profile. The internal run counter
  (`sessionRunCount`) is never exported.
- Old export/import files without session fields import as `new`.

### Timezones and launch windows

- `timezone` — IANA zone per task (e.g. `Europe/Moscow`). `nextRun`/`prevRun`,
  dry-run next-run estimates and the gate evaluate cron in this zone; DST
  transitions are handled (nonexistent spring-forward times are skipped).
- `notBefore` / `notAfter` — daily launch window in `HH:MM` (may cross midnight,
  e.g. `22:00`–`06:00`). A run that fires outside the window is **postponed**
  until the window opens (once, via a defer-file), not skipped.
- `pausedUntil` — pause a task until an ISO moment. `pause_task` accepts
  `until`; the plugin re-enables the task automatically at startup and on a
  5-minute timer, and `resume_task` resumes early.

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

## Profiles (multi-project, Спринт 21)

Profiles let you run several independent scheduler installations inside one plugin,
each with its own SQLite database, settings, logs, wrappers and dashboard port.
This is useful for separating projects, clients or environments (e.g. `default` and
`work`) without them seeing each other's data.

- Profile `default` uses the plugin's base directory (no migration, behaves exactly
  as before Sprint 21). Named profiles live in `<base>/profiles/<name>`.
- Profile selection order: `OPENCODE_SCHEDULER_PROFILE` env var → file `active-profile`
  in the base directory → `default`. Switching profiles writes the marker and requires
  an OpenCode restart because plugin directories are resolved at module load time.
- Dashboard port per profile: `OPENCODE_SCHEDULER_PORT` env var → port from
  `profile.json` → server default (3782, then 4782/5782 fallback).
- RPC: `get_profiles` lists profiles with dirs, ports and the active flag;
  `set_profile` switches the active profile (restart hint); `create_profile` /
  `delete_profile` manage named profiles (`default` cannot be deleted).

### Workspace environment variables (Спринт 21)

Each workspace can carry env variables that are injected into every task run in that
workspace:

- `env` — explicit `KEY=VALUE` pairs stored in SQLite as JSON;
- `envFile` — optional path to a `.env` file whose variables are loaded first, then
  explicit pairs override them;
- File format: `KEY=value` lines, `#` comments, blank lines, leading `export `,
  values in matching quotes are unquoted;
- Key validation: `^[A-Za-z_][A-Za-z0-9_]*$`, max 100 pairs per workspace;
- Delivery: at task create/update the plugin writes `<PLUGIN_DIR>/env/<sanitized>.env`
  with real values (mode `0600` on POSIX) and passes it to the wrapper
  (Windows: `-EnvFile "<path>"`; POSIX: `set -a; . "$ENV_FILE"; set +a` before the
  `opencode run` invocation);
- Secret masking: keys matching `/(TOKEN|SECRET|PASS|PASSWORD|KEY|CREDENTIAL|AUTH)/i`
  are shown as `***` in logs and masked API responses — values never leak into logs.

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
CSV/JSON (`GET /api/history/export`), or as OTLP/JSON for OpenTelemetry
(`GET /api/history/export?format=otlp`).

### Prometheus

`GET /metrics` exposes the Prometheus text format (0.0.4): `opencode_scheduler_info`,
`up`, `queue_depth`, `history_records`, `runs_total{task,status}`,
`errors_total{task}`, `tokens_total{task}`, `cost_usd_total{task}` and the
`run_duration_seconds` histogram (1 s … 3600 s + `+Inf`). Values are read from
SQLite at scrape time, so no extra agent or exporter process is required.

### Structured logs

Every run start/finish and every webhook decision is appended to
`<PLUGIN_DIR>/logs/runs.jsonl` (one JSON object per line, 10 MiB rotation to
`runs.jsonl.1`). `GET /api/logs` returns newest-first records and supports `task`,
`status`, `event`, `since`, `until`, `limit` and `format=jsonl`. The database
`history` table remains the source of truth for aggregates; JSONL is for log
shipping and debugging and never blocks a run if writing fails.

### Incoming webhooks

`POST /api/hooks/:task?token=…` starts a task from GitHub Actions, GitLab CI or any
external system. The request must carry an HMAC-SHA256 of the raw body in
`X-Scheduler-Signature: sha256=<hex>` (GitHub's `X-Hub-Signature-256` and a bare
hex digest are also accepted). The token may instead come from `X-Scheduler-Token`
or `X-Gitlab-Token`. An optional `X-Scheduler-Timestamp` is checked against
`timestampToleranceSeconds`. Hooks are disabled by default; enabling them with empty
credentials generates a token and secret automatically. Errors: 401 (bad
token/signature/timestamp), 403 (channel disabled or credentials missing), 404
(unknown task), 413 (body over `maxBodyBytes`). The dashboard still binds to
localhost only, so external CI needs a tunnel or self-hosted runner.

### OpenTelemetry

History can be exported as OTLP/JSON: one span per run, deterministic 32-hex
`traceId` and 16-hex `spanId`, nanosecond timestamps, task/status/duration/tokens/
cost/model/error attributes and OK/ERROR status. The output can be posted to an
OpenTelemetry Collector or inspected directly.

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

- **Delivery:** per-task completion (success/error/timeout) through a Discord/Slack
  compatible webhook (`{ content, text }`). `webhook.timeoutMs` (default 10 000),
  `webhook.retryCount` (default 2) and `webhook.retryDelayMs` (default 1000) control
  the request; network errors, timeouts, HTTP 5xx and 429 are retried with exponential
  backoff (capped at 30 s), other 4xx are not.
- **Templates:** `templates.success` and `templates.error` accept placeholders
  `{task}`, `{status}`, `{duration}`, `{error}`, `{emoji}`.
- **Filters:** `filters.include` / `filters.exclude` are task-name patterns with `*`
  wildcards; an empty include list means all tasks, exclude wins.
- **Matrix notifications:** on family completion — success, `partial` (`onPartial`)
  and all clones failed (`onAllFailed`). A stuck detector reports clones running
  longer than `matrix.stuckAfterMinutes` (default 60, `0` disables) once per run.
- **Digest:** `digest.enabled` sends a daily (`frequency: "daily"`, at `digest.time`)
  or weekly (Mondays, catch-up afterwards) summary: runs, success rate, cost, tokens
  and top errors. Also available as the `send_digest` RPC and the GUI's
  «📊 Отправить дайджест сейчас» button (manual sends do not move the schedule).
- **ntfy.sh is intentionally not implemented** (excluded by the assignment); the
  network channel is the webhook, plus GUI toasts for manual runs.

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

Twenty-two tools: `schedule_task`, `list_tasks`, `update_task`, `delete_task`,
`run_task_now`, `pause_task`, `resume_task`, `get_history`, `get_task_logs`, `dry_run`,
`manage_workspaces`, `matrix_control` (results/cancel/cleanup/preview), `get_metrics`,
`get_analytics`, `manage_settings`, `manage_templates`, `manage_profiles`,
`transfer_tasks`, `send_notification`, `get_dashboard_info`, `cleanup_history`,
`emit_event`.

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

- **No one-shot scheduling without `triggerType: "once"`.** One-shot runs exist
  via `runAt`/`delaySeconds`; use `run_task_now` for immediate runs.
- **No session continuity beyond the built-in `session` modes.** `new`, `reuse`
  and `last` cover the common cases; per-message session forking/branching is
  not supported.
- **No sandbox.** Hooks, Quality Gates and prompts run with your user privileges.
- **No authentication on the dashboard.** Localhost only by design.
- **Secrets are not encrypted.** Use environment variables or an external secret
  manager.
- **`allowedTools` / `deniedTools` are advisory.** They document intent and are
  recorded in history; enforcement is not implemented.
- **Matrix clones are separate tasks.** They appear in the task list (grouped under the
  parent) and consume global concurrency slots like any other run.
