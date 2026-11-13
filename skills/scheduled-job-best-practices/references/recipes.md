# Recipes

Complete, copy-ready examples. Values in `<angle brackets>` are placeholders.

## 1. Nightly dependency and test run

```json
{
  "name": "nightly-deps",
  "schedule": "0 2 * * *",
  "prompt": "In the repository root run `npm outdated` and `npm audit --omit=dev`. Do not upgrade majors. Apply only patch/minor security fixes, run `npm test` after each upgrade, and revert a package if tests fail. Write a summary to reports/nightly-deps.md: upgraded packages with versions, rejected upgrades and why, final test result.",
  "workingDirectory": "<absolute path to repository>",
  "timeoutSeconds": 2400,
  "qualityGate": "npm test",
  "retryCount": 1,
  "retryDelay": 300,
  "allowedTools": ["read", "write", "bash"],
  "deniedTools": ["webfetch"]
}
```

Why: bounded scope (no majors), machine-checkable gate, report for the morning.

## 2. Weekday morning digest

```json
{
  "name": "morning-digest",
  "schedule": "0 9 * * 1-5",
  "prompt": "Collect: commits to main since the last working day (`git log --since=yesterday`), open pull requests (`gh pr list --state open`), and failed CI runs (`gh run list --status failure --limit 10`). Write a Russian-language digest to reports/digest-<date>.md with sections Commits / PRs / CI failures. If a command is unavailable, record that instead of failing.",
  "workingDirectory": "<absolute path to repository>",
  "timeoutSeconds": 900,
  "allowedTools": ["read", "bash"]
}
```

Why: read-only, tolerant of missing CLIs, output is the product.

## 3. Regenerate a client when the API contract changes

```json
{
  "name": "regenerate-api-client",
  "prompt": "openapi.yaml changed. Run `npm run generate:client`, then `npm run typecheck` and `npm test -- --runInBand`. If generation fails because of a schema error, do not edit the schema: write the failing path and reason to reports/api-client-error.md and stop. On success write the list of regenerated files to reports/api-client.md.",
  "triggerType": "file",
  "watchPath": "<absolute path to openapi.yaml>",
  "workingDirectory": "<absolute path to client repository>",
  "timeoutSeconds": 1200,
  "qualityGate": "npm run typecheck",
  "allowedTools": ["read", "write", "bash"]
}
```

Why: event-driven instead of polling, explicit "do not touch the contract" constraint.

## 4. Multi-repository lint and test matrix

```json
{
  "name": "repo-health",
  "schedule": "0 6 * * 1",
  "prompt": "Run the project's lint and test commands. Write a short report to reports/weekly-health.md with the command output summary. Fix nothing; only report.",
  "timeoutSeconds": 1800,
  "matrix": {
    "workspaceIds": ["<frontend-id>", "<backend-id>", "<mobile-id>"],
    "strategy": "parallel",
    "failureMode": "continue",
    "concurrency": 2,
    "aggregation": "summary",
    "overrides": {
      "<mobile-id>": {
        "qualityGate": "flutter test",
        "prompt": "Run `flutter analyze` and `flutter test`. Write the summary to reports/weekly-health.md. Fix nothing."
      }
    }
  },
  "allowedTools": ["read", "bash"]
}
```

Why: one definition, per-repository deviation in `overrides`, capped parallelism, partial
results still actionable.

## 5. Deploy pipeline with gate and rollback

Tasks, in order:

1. `deploy` — `schedule: "0 3 * * *"`, prompt builds and deploys, `qualityGate: "npm run smoke"`,
   `timeoutSeconds: 1800`, `nextTaskOnSuccess: "notify-release"`,
   `nextTaskOnError: "rollback"`.
2. `notify-release` — posts a release message, `timeoutSeconds: 300`, read-only tools.
3. `rollback` — restores the previous release, `qualityGate: "npm run smoke"`,
   `triggerType: "file"` (started only by the chain), `timeoutSeconds: 1200`.

Verify the chain with `dry_run` for `deploy`: the output must show `deploy → notify-release`
and the error branch.

## 6. Weekly cleanup of stale branches

```json
{
  "name": "stale-branches",
  "schedule": "0 10 * * 5",
  "prompt": "List merged remote branches older than 30 days (`git branch -r --merged main`). Do not delete `main`, `develop`, `release/*` or branches whose last commit is younger than 30 days. Delete the rest with `git push origin --delete`. Write the deleted and kept branches to reports/stale-branches.md with reasons.",
  "workingDirectory": "<absolute path to repository>",
  "timeoutSeconds": 600,
  "qualityGate": "git diff --quiet",
  "allowedTools": ["read", "bash"],
  "deniedTools": ["write"]
}
```

Why: explicit protected list, dry-run first, auditable report. Ask the user to run
`run_task_now` and confirm the report before enabling the schedule.

## 7. Diagnosing a `partial` matrix

1. `matrix_control` with `action: "results"` and the parent name → counters and the failing clones.
2. `get_history` with `taskName: "<parent>-matrix-<workspace>"` and `status: "error"`.
3. `get_task_logs` for that clone, `lines: 120`.
4. Fix the cause (`update_task` on the parent for a definition bug, or the repository itself).
5. Re-run only the failed clone with `run_task_now`, then confirm the aggregate becomes
   `success`.
