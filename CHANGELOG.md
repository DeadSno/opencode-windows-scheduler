# Changelog

All notable changes to this project are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Full agent parity:** `schedule_task` now accepts `qualityGate`, `dependsOn`, `retryCount`, `retryDelay`, `nextTaskOnSuccess`, `nextTaskOnError` and the complete matrix configuration (`concurrency`, `overrides`).
- **New agent tools:** `update_task` (partial update, `matrix: null` removes the matrix), `pause_task`, `resume_task`, `get_history`, `get_task_logs`, `dry_run`, `manage_workspaces` (list/add/update/delete) and `matrix_control` (results/cancel/cleanup). 12 tools total.
- Agent tool descriptions are in English; runtime messages stay localized.
- `get_task_logs` supports a `lines` limit (1–1000).
- `update_task` keeps every field that is not passed, so the agent can change one setting without resending the whole task.
- **Built-in agent skill** `scheduled-job-best-practices`, registered by the plugin itself: guidance on schedule design, prompt structure, safety defaults, matrix concurrency, DAG rules and failure diagnosis, plus `references/recipes.md` with seven complete examples. No manual `.opencode/skills` setup.
- **Documentation:** `docs/ARCHITECTURE.md` (process model, modules, backends, data model, security model), `docs/FEATURES.md` (full feature catalog with examples and limits) and `docs/MIGRATION.md` (from cron, systemd timers, launchd and Windows Task Scheduler), linked from both READMEs.
- `test-docs.mjs` — 30 checks that the guides exist, stay complete and ship in the npm package.

### Planned

- One-shot scheduling, session continuity, guards, worktree isolation, declarative job files.

## [1.0.0] — 2026-11-13

First public release.

### Added

- **Scheduling:** cron expressions registered with the native OS scheduler (Windows Task Scheduler, launchd, crontab), pause/resume, timeouts with hard kill, retries with delay, lock-file no-overlap protection.
- **Quality and lifecycle:** Quality Gate command, before/after scripts, allowed/denied tool lists, crash recovery for interrupted runs.
- **Orchestration:** `dependsOn` DAG, `nextTaskOnSuccess` / `nextTaskOnError` chains, file and MCP event triggers.
- **Matrix builds:** fan-out into `<parent>-matrix-<workspace>` clones, parallel/sequential strategies, `continue`/`stop` failure modes, per-matrix concurrency, per-workspace overrides, aggregator task, family sync on edit, cascade delete, cancel, orphan cleanup, `partial` status.
- **Workspaces:** multi-repo registry with path validation, per-task working directory and tool scoping.
- **Observability:** SQLite history and metrics, per-task logs, local web dashboard with pipeline view, matrix grouping and workspace summaries.
- **Operations:** dry-run preview, export/import JSON, templates, webhook notifications, settings.
- **Interfaces:** OpenCode sidebar GUI, web dashboard, agent tools `schedule_task`, `list_tasks`, `delete_task`, `run_task_now`.
- **Cross-platform:** scheduler abstraction with Windows, Linux and macOS backends.

### Known limitations

- Matrix parents are started by `runMatrix()` / DAG only; they are not cron-scheduled.
- Deleting a matrix parent deletes its family, but deleting a workspace does not touch existing matrix jobs.
- Agent tools cover a subset of the RPC surface (see roadmap item 0.4).

[Unreleased]: https://github.com/DeadSno/opencode-windows-scheduler/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/DeadSno/opencode-windows-scheduler/releases/tag/v1.0.0
