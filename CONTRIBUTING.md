# Contributing

Thanks for taking the time to contribute! This project is MIT-licensed and free forever; contributions of code, docs, bug reports and recipes are welcome.

## Ways to help

- **Bug reports** — open an issue with OS, Node version, plugin version, steps to reproduce and the relevant log excerpt.
- **Feature requests** — describe the workflow you want to automate, not only the feature. See [ROADMAP-STRATEGY.md](ROADMAP-STRATEGY.md) for the direction.
- **Docs and recipes** — English docs are primary; Russian docs live in `README.ru.md` and must stay in sync.
- **Code** — see below.

## Development setup

```bash
git clone https://github.com/DeadSno/opencode-windows-scheduler.git
cd opencode-windows-scheduler
npm install
npm run build        # tsc
npm run build:gui    # vite -> gui-experimental.cjs
npm test             # all test suites
```

Requirements: Node.js 20+ (CI uses 24), npm 10+.

## Project layout

| Path | Purpose |
|---|---|
| `src/index.ts` | plugin lifecycle, agent tools, RPC handlers |
| `src/rpc.ts` | RPC contract schemas |
| `src/gui.tsx` | OpenCode sidebar panel (SolidJS) |
| `src/server.ts` | local web dashboard |
| `src/core/scheduler/` | OS scheduler backends (Windows, Linux, macOS) |
| `src/core/matrix.ts` | matrix fan-out, aggregation, sync, cancel |
| `src/core/record-history.ts` | history, retries, chains, matrix continuation |
| `src/db/` | SQLite storage (tasks, history, metrics, settings, templates) |
| `src/task-transfer.ts` | export, import, validation |

## Tests

Every change should keep the full suite green:

```bash
npm test
```

Individual suites: `npm run test:sqlite`, `test:crash`, `test:workspaces`, `test:role`, `test:dry-run`, `test:matrix`, `test:matrix-lifecycle`, `test:matrix-sync`, `test:agent`, `test:skill`, `test:docs`.

Tests run against `dist/`, so build first. They point `OPENCODE_SCHEDULER_HOME` (and legacy `APPDATA`) at a temporary directory, so they never touch your real jobs on any platform.

New behavior needs a test. Matrix sync and DAG logic are the most sensitive areas — cover both the happy path and the "running clone must not be touched" path.

## Code style

- TypeScript strict mode; no `any` unless there is no alternative.
- Keep platform-specific code inside `src/core/scheduler/` — everything else must stay cross-platform.
- No new runtime dependencies without an issue and a rationale (the project values a small dependency tree).
- User-facing strings in Russian are currently used by the GUI; new agent-tool descriptions and docs must be English-first.
- Follow the existing naming and file structure instead of introducing parallel abstractions.

## Pull requests

1. Fork, create a topic branch (`feat/matrix-retry`, `fix/launchd-weekday`).
2. Make focused commits with clear messages (`feat: ...`, `fix: ...`, `docs: ...`, `test: ...`).
3. Run `npm run build && npm run build:gui && npm test`.
4. Describe the problem, the solution and how you verified it; include screenshots for UI changes.
5. Update `CHANGELOG.md` under `[Unreleased]` and keep English/Russian docs in sync.

CI runs build, GUI build and tests on Windows, Ubuntu and macOS for every pull request.

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
