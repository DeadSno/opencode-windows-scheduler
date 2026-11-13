# Migration guide

How to move existing automation into `opencode-windows-scheduler` from cron, systemd
timers, launchd, Windows Task Scheduler, or another scheduler plugin.

- [Before you start](#before-you-start)
- [From cron / crontab](#from-cron--crontab)
- [From systemd timers](#from-systemd-timers)
- [From launchd](#from-launchd)
- [From Windows Task Scheduler](#from-windows-task-scheduler)
- [From another scheduler plugin](#from-another-scheduler-plugin)
- [Bulk import and export](#bulk-import-and-export)
- [Verification checklist](#verification-checklist)
- [Common pitfalls](#common-pitfalls)
- [Rollback](#rollback)

## Before you start

1. **Install and build.**

   ```bash
   npm install -g opencode-windows-scheduler
   ```

   Add the plugin to `opencode.json` and restart OpenCode. If OpenCode's built-in
   schedules are enabled, disable them so two schedulers do not run the same work.

2. **Check Node.** `node --version` must be 20 or newer (22.5+ for the built-in SQLite
   driver; Node 24 recommended).

3. **Inventory the old jobs.** For each job write down: name, schedule, command,
   working directory, environment variables, timeout, and what "success" means. The
   last one becomes your Quality Gate.

4. **Do not delete the old jobs yet.** Run both schedulers side by side for a few days,
   then remove the old entries.

## From cron / crontab

Cron expressions are compatible (five fields). The differences are in the command.

**Before (crontab)**

```cron
0 2 * * * cd /srv/api && /usr/bin/git pull && /usr/bin/npm test >> /var/log/api.log 2>&1
```

**After (agent tool or GUI)**

```json
{
  "name": "api-nightly",
  "schedule": "0 2 * * *",
  "workingDirectory": "/srv/api",
  "beforeScript": "git pull --ff-only",
  "prompt": "Inspect the repository, apply safe dependency updates, and explain every change you made.",
  "qualityGate": "npm test",
  "timeoutSeconds": 1800
}
```

Mapping table:

| Cron concept | Scheduler equivalent |
| --- | --- |
| `cd /path && command` | `workingDirectory` or `workspaceId` |
| `>> file 2>&1` | log file is written automatically (`logs/<task>.log`) |
| `&&` chains | `beforeScript`, `prompt`, `qualityGate`, `afterScript` |
| exit code check | Quality Gate |
| `MAILTO` | webhook notifications |
| `%` escapes | not needed; write the prompt as normal text |
| `@reboot` | not supported; use a file/MCP trigger or a frequent cron |

Notes:

- `@daily`, `@hourly` and similar macros are not supported — write `0 0 * * *`,
  `0 * * * *`, and so on.
- `@reboot` and `@yearly` have no direct equivalent.
- Cron environments are minimal. The wrapper inherits the user environment of the OS
  scheduler entry, not your interactive shell. Absolute paths are safer than relying on
  `PATH` from `.bashrc`.

## From systemd timers

The plugin schedules through the user crontab on Linux, so systemd calendar syntax is
translated to a cron expression when you migrate.

**Before**

```ini
# api-nightly.timer
[Timer]
OnCalendar=*-*-* 02:00:00
Persistent=true
```

```ini
# api-nightly.service
[Service]
WorkingDirectory=/srv/api
ExecStart=/usr/bin/npm run nightly
```

**After**

```json
{
  "name": "api-nightly",
  "schedule": "0 2 * * *",
  "workingDirectory": "/srv/api",
  "prompt": "Run the nightly routine described in package.json and summarize the result.",
  "qualityGate": "npm test"
}
```

| systemd | Scheduler |
| --- | --- |
| `OnCalendar=*-*-* 02:00` | `0 2 * * *` |
| `OnUnitActiveSec=15min` | `*/15 * * * *` |
| `WorkingDirectory` | `workingDirectory` / `workspaceId` |
| `Environment=` | set it in the hook or in the user environment |
| `TimeoutStartSec` | `timeoutSeconds` |
| `Persistent=true` | catch-up is not implemented; a missed window is skipped |
| `Requires=` / `After=` | `dependsOn` |

Disable the old units (`systemctl --user disable --now api-nightly.timer`) only after
the new task has run successfully at least once.

## From launchd

**Before**

```xml
<key>StartCalendarInterval</key>
<dict><key>Hour</key><integer>2</integer></dict>
```

**After**

```json
{
  "name": "mac-nightly",
  "schedule": "0 2 * * *",
  "workingDirectory": "/Users/me/projects/api",
  "prompt": "Run the nightly maintenance and report anything unusual."
}
```

| launchd | Scheduler |
| --- | --- |
| `StartCalendarInterval` | cron expression |
| `StartInterval` (seconds) | `*/N * * * *` (minute granularity) |
| `WorkingDirectory` | `workingDirectory` |
| `StandardOutPath` / `StandardErrorPath` | automatic log file |
| `RunAtLoad` | not supported; use a manual run or a file trigger |

## From Windows Task Scheduler

Existing tasks usually point to a `.bat`/`.ps1` file or a command line.

**After**

```json
{
  "name": "win-nightly",
  "schedule": "0 2 * * *",
  "workingDirectory": "C:\\projects\\api",
  "prompt": "Run the nightly maintenance for this repository.",
  "qualityGate": "npm test"
}
```

| Task Scheduler | Scheduler |
| --- | --- |
| Trigger "Daily" | `0 2 * * *` |
| Trigger "At log on" | not supported; use a file trigger or a start-up hook |
| "Run whether user is logged on" | the plugin registers tasks in the current user context |
| "Stop task if it runs longer than" | `timeoutSeconds` |
| "If the task is already running" | lock file, the second run is `skipped` |
| Action "Start a program" | you describe the goal in a prompt instead of a command |
| Multiple actions | `beforeScript` + `prompt` + `qualityGate` + `afterScript` |

Delete the old task only after verifying the new one:
`schtasks /delete /tn "<old task>" /f`.

## From another scheduler plugin

There is no universal importer, because definition formats differ. The workflow is:

1. List the old jobs and copy their schedules, prompts and working directories.
2. Recreate them with `schedule_task` or the GUI.
3. If the old plugin exports JSON, transform it into the import format below and use
   `import_tasks` — validation reports per-record errors.
4. Disable the old plugin before the first overlapping run.

## Bulk import and export

**Export format**

```json
{
  "version": 1,
  "exportedAt": "2026-01-01T00:00:00.000Z",
  "tasks": [
    {
      "name": "api-nightly",
      "schedule": "0 2 * * *",
      "prompt": "Nightly maintenance.",
      "qualityGate": "npm test",
      "workspaceId": "ws-api"
    }
  ]
}
```

**Import**

Use `import_tasks` from the GUI or the RPC layer. Rules:

- `name` and `prompt` are required.
- `cron` tasks need a schedule; `file` tasks need `watchPath`; `mcp-event` tasks need
  `mcpEvent.event`.
- Matrix tasks cannot also set `workspaceId`, and `matrix.workspaceIds` must not be
  empty.
- Workspace ids must exist in the target installation, or the record is rejected.
- Errors are reported per record; valid records are imported.

Workspaces are not exported as directories — recreate them with
`manage_workspaces` first, then map old paths by hand.

## Verification checklist

For every migrated job:

1. `dry_run` with the task name — check order, dependencies and estimated time.
2. `run_task_now` — confirm the log shows the expected work.
3. Check the Quality Gate result in `get_history`.
4. Confirm the next scheduled run appears with a correct "next run" timestamp.
5. For matrix jobs, expand the parent in the dashboard and verify every clone has the
   right workspace path.
6. Wait for at least one natural scheduled run before deleting the old definition.

## Common pitfalls

| Symptom | Cause | Fix |
| --- | --- | --- |
| `skipped` in history | previous run still holds the lock | wait, or lower `timeoutSeconds` |
| `timeout` every run | the agent needs more time | raise `timeoutSeconds` |
| Quality Gate fails but the work looks fine | gate runs in the task directory, not a subdirectory | prefix the command with `cd subdir && ...` |
| Agent cannot find the project | no `workingDirectory`/`workspaceId`, so it ran in the plugin directory | set the working directory |
| "Workspace path does not exist" on import | workspace ids belong to another machine | recreate workspaces and remap ids |
| Two runs at once after migration | old scheduler is still enabled | disable the old job |
| Cron rejected | expression not expressible by `schtasks` | use a supported pattern (`*/N`, fixed minute/hour, weekdays) |
| Prompts behave differently at night | interactive shell environment vs scheduler environment | use absolute paths, avoid alias-dependent commands |

## Rollback

If something goes wrong:

1. Re-enable the old jobs (they were never deleted).
2. `pause_task` the migrated ones, or delete them.
3. Export the plugin definitions before major changes: `export_tasks` gives a single
   JSON file you can re-import on any machine.

Definitions live in `scheduler.db`; deleting the plugin directory removes all state.
Export first if you might want it back.
