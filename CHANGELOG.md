# Changelog

All notable changes to this project are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.4.0] - 2026-11-14

### Added

- **Зашифрованное хранилище секретов (Спринт 26):** AES-256-GCM в `<PLUGIN_DIR>/secrets.json` с ключом `secrets.key` (32 байта, права 0600); API `setSecret/getSecret/deleteSecret/listSecrets/hasSecret`; имена `[A-Za-z0-9_.-]` до 64 символов; превью `••••` + последние 4 символа.
- **Ссылки на секреты в задачах:** `${secret:NAME}` подставляется из хранилища в `env` рабочей зоны при запуске; отсутствующие секреты дают пустую строку с предупреждением (только имя); ссылки маскируются в логах, истории и аудите.
- **Журнал аудита (Спринт 26):** таблица `audit_log` в SQLite (действие, цель, актор mcp/gui/http, источник, детали, удалённый адрес) с индексами по времени и действию; ротация 90 дней / 10 000 записей; аудит всех мутаций задач, настроек, шаблонов, профилей, рабочих зон, секретов, импорта и очистки истории.
- **Инструменты агента:** `manage_secrets` (list/set/delete) и `get_audit_log` (фильтры action/target/actor/since/until/limit); RPC `list_secrets`, `save_secret`, `delete_secret`, `get_audit`; `GET /api/audit`.
- **GUI:** панель «🔐 Секреты» (список имён + превью, создание, удаление) и панель «📜 Журнал аудита» (таблица с фильтрами), блок ретеншна аудита в настройках.

### Changed

- `manage_settings` принимает блок `audit` (`enabled`, `retentionDays`, `maxRecords`); по умолчанию аудит включён, ретеншн 90 дн., лимит 10 000 записей.
- `resolveWorkspaceEnv` раскрывает `${secret:NAME}` после слияния env-файла и пар; `maskEnvForLog` оставляет ссылки нетронутыми, маскируя только личные значения.
- `appendStructuredLog` редуцирует `payload.error` / `payload.reason` перед записью JSONL.

### Security

- Секреты никогда не хранятся в открытом виде; значения не логируются, не попадают в историю запусков и не раскрываются при экспорте задач.
- Токен Telegram и chat_id можно задать через env `OPENCODE_SCHEDULER_TELEGRAM_BOT_TOKEN` / `OPENCODE_SCHEDULER_TELEGRAM_CHAT_ID` вместо `settings.json`.

## [1.3.0] - 2026-11-14

### Added

- **Telegram-канал:** Bot API `sendMessage` с `chat_id`, `parse_mode` (HTML / MarkdownV2 / Markdown / plain), тихим режимом, темой форума и ссылкой на дашборд; настройка через GUI и `manage_settings`.
- **Нативные уведомления ОС:** Windows Toast, macOS Notification Center, Linux `notify-send`; без внешних зависимостей, `node-notifier` не требуется.
- **Тихие часы:** success и partial подавляются в заданном окне (в том числе через полночь), ошибки и таймауты отправляются всегда.
- **Стоимость и токены в сообщениях:** `tokens`/`costUsd` передаются из истории, в шаблонах доступны плейсхолдеры `{cost}` и `{tokens}`.
- `test-notifications-v3.mjs` (40 проверок): экранирование Telegram, подмена fetch, сборка нативных команд, тихие часы, миграция настроек.

### Changed

- `deliver()` отправляет сообщение во все включённые каналы (webhook + Telegram + native) и не прерывает остальные при ошибке одного из них.
- Тестовая кнопка и дайджест работают через любой включённый канал, а не только webhook.
- `send_notification` принимает `channel` (`all` / `webhook` / `telegram` / `native`).

### Security

- Токен Telegram маскируется в ошибках и логах; секреты не попадают в `tasks.json` и историю запусков. Токен и `chat_id` можно задать через `OPENCODE_SCHEDULER_TELEGRAM_BOT_TOKEN` и `OPENCODE_SCHEDULER_TELEGRAM_CHAT_ID` вместо `settings.json`.

## [1.2.3] - 2026-11-13

### Changed

- README переписан под OpenCode v2: установка через `plugins` и `opencode plugin add` (ключ `plugin` в конфиге устарел), добавлены FAQ, бейдж загрузок и ссылка на CROSS_PLATFORM.md, исправлено число тестовых сюит (26).
- Русский README перенесён в `docs/README.ru.md` и синхронизирован с английским: одноразовые запуски, непрерывность сессий, webhooks, Prometheus/OTLP, матричные сборки, FAQ.
- `package.json`: описание и ключевые слова расширены для поиска (OpenCode v2, планировщик, оркестрация, DAG, матрицы, Quality Gates, наблюдаемость).

### Fixed

- Страница пакета на npm показывала устаревший русский README: npm выбирал `README.ru.md` вместо `README.md`. Теперь в корне только английский README, npm отдаёт актуальный текст.

## [1.2.2] - 2026-11-13

### Fixed

- Тест дашборда больше не требует Windows-название планировщика в HTML (платформа macOS/Linux показывает «OpenCode Scheduler»), проверка переведена на `getSchedulerTitle()`.
- Зомби-процесс плагина, удерживающий порт веб-дашборда, теперь снимается и на macOS/Linux: PID слушающих сокетов ищутся через `lsof` (Linux дополнительно — `ss`), имя процесса читается из `ps` (для Node берём basename argv[0], т.к. comm главного потока — `MainThread`), убиваем через SIGKILL.
- Дашборд перед повторным bind порта ждёт его освобождения (до 3 с через опрос `lsof`/`ss`): SIGKILL на POSIX асинхронный, и сокет может держаться ещё какое-то время после снятия процесса — без этого дашборд уходил на запасной порт вместо освобождённого.

## [1.2.1] - 2026-11-13

### Added

- **One-shot scheduling:** `triggerType: "once"` with `runAt` (ISO-8601 or local date) or `delaySeconds`; native registration (`schtasks /sc ONCE`, Linux `at`, macOS launchd + cleanup wrapper), no repeat after plugin restart, export/import and dry-run support, GUI and dashboard display.
- **Session continuity:** `session: "new" | "reuse" | "last"` and `sessionMaxRuns` for `reuse`; `sessionId` is generated by the plugin, never accepted from input and never exported; old packages import as `new`.
- `test-one-shot.mjs` (41 проверка) и `test-session-continuity.mjs` (50 проверок) — в цепочке `npm test`.

### Fixed

- TUI-панель теперь обновляется каждые 5 секунд через reactive store контекста и показывает паузу, а не статический снимок первого рендера.
- TUI: клоны матриц сгруппированы под родителем с отступом; добавлены run/pause/resume (клик по задаче или `Ctrl+Shift+J`, а также палитра команд), результат показывается тостом, список обновляется сразу.
- TUI: добавлен просмотр последних 40 строк лога задачи и клавиатурная навигация по списку (`Ctrl+Shift+↑/↓`, открытие выбранной задачи — `Ctrl+Shift+Enter`); выбранная строка помечается `›`.
- Дашборд: зависимости задач рисуются настоящим слоистым SVG-графом с прокруткой вместо текстовых цепочек; добавлена светлая тема через `prefers-color-scheme` и видимый фокус для клавиатуры.
- Дашборд: история не обрезается молча, фильтры `/api/history` (`taskName`, `status`, `limit`) работают и покрыты тестом; статусы `partial`/`running`/`idle`/`paused`/`orphaned` отображаются корректно.
- Дашборд: `/favicon.ico` отвечает 204 вместо 404, а метрики по умолчанию читаются из `/api/summary` (при его недоступности — из `/api/metrics`), чтобы антивирус не блокировал запрос каждые 5 секунд.
- Метрики: `partial` хранится и показывается отдельно от `error` (карточка «Частичных», колонка и график), `error` теперь означает только ошибки и таймауты; старые БД получают колонку автоматически.
- Добавлены `scope="col"`, `aria-pressed`, `aria-expanded` и подписи для иконочных кнопок дашборда.
- Удалены устаревшие ad-hoc скрипты `test-create.cjs`/`test-run.cjs` и логи сборки из корня репозитория.

## [1.2.0] - 2026-11-13

### Added

- **Планирование 2.0:** `timezone` (IANA) на задачу — cron/DST считается в этом поясе, при зоне ≠ системной задача уходит в poll-режим (`MINUTE /mo 1` + `schedule-gate` в обёртке); следующие срабатывания считаются в dry-run.
- Окна запуска `notBefore`/`notAfter` (HH:MM, можно через полночь) — запуск переносится на открытие окна, не пропускается (postpone с dedup через defer-файл).
- Расширенный cron: `@every 15m|2h|1d`, `L` (последний день месяца), `d#n` (N-й день недели, напр. `FRI#3`), имена месяцев/дней, диапазоны и списки со шагами.
- Пауза до даты `pausedUntil` — `pause_task(name, until?)` сохраняет ISO-момент; авто-возобновление при старте плагина и по таймеру каждые 5 мин, `resume_task` снимает паузу досрочно.
- `test-schedule-v2.mjs` (50 проверок: парсер, nextRun/prevRun, DST, окна, CLI-шлюз) — добавлен в `npm test`.
- **Уведомления v2:** ретраи webhook (`timeoutMs`, `retryCount`, `retryDelayMs`, backoff до 30 с на сеть/таймаут/5xx/429), шаблоны сообщений с плейсхолдерами и фильтры задач (`include`/`exclude`, маски `*`).
- Уведомления матриц (успех, `partial`, «все упали») и детектор зависших клонов (`matrix.stuckAfterMinutes`, одно уведомление на запуск).
- Дайджест (ежедневный/еженедельный): запуски, success rate, стоимость, токены, топ ошибок; RPC `send_digest`, кнопка «📊 Отправить дайджест сейчас», GUI-настройки таймаута/шаблонов/фильтров/матриц/дайджеста. ntfy.sh не реализован (исключён заданием).
- `test-notifications-v2.mjs` (44 проверки) — добавлен в `npm test`.
- **Полный паритет агента (10 новых инструментов):** `get_metrics`, `get_analytics`, `manage_settings`, `manage_templates`, `manage_profiles`, `transfer_tasks`, `send_notification`, `get_dashboard_info`, `cleanup_history`, `emit_event`; `matrix_control` получил действие `preview`. Все операции, ранее доступные только в GUI/RPC, теперь доступны агенту (итого 22 инструмента).

### Integrations and observability (Спринт 22)

- Входящий webhook-триггер `POST /api/hooks/:task` с HMAC-SHA256 по сырому телу: заголовки `X-Scheduler-Signature`, `X-Hub-Signature-256` (GitHub) и `X-Gitlab-Token`, опциональная проверка timestamp; канал выключен по умолчанию.
- Structured logs: JSONL `<PLUGIN_DIR>/logs/runs.jsonl` с событиями `run.started` / `run.finished` / `hook.received`, ротация 10 МБ и `GET /api/logs` с фильтрами по задаче, статусу, событию и периоду.
- Prometheus `GET /metrics`: запуски, ошибки, токены, стоимость, histogram длительности, глубина очереди и объём истории.
- OpenTelemetry: `GET /api/history/export?format=otlp` — OTLP/JSON со стабильными traceId/spanId на каждый запуск.
- `test-integrations.mjs` (116 проверок) — в цепочке `npm test`.

### Profiles (Спринт 21)

- Профили (`default`, `work`, …): каждый профиль — отдельная директория со своей БД (`scheduler.db`), настройками (`settings.json`), логами, обёртками и портом дашборда. `default` использует базовую директорию плагина (как раньше — без миграции), остальные живут в `<base>/profiles/<name>`.
- `OPENCODE_SCHEDULER_PROFILE` > файл-маркер `active-profile` > `default`; переключение требует перезапуска OpenCode. Порт дашборда профиля — из `env OPENCODE_SCHEDULER_PORT` > `profile.json` > дефолт (3782/4782/5782).
- `src/profiles.ts` — `getProfileName()`, `getProfileDir()`, `listProfiles()`, `createProfile()`, `deleteProfile()`, `setActiveProfile()`, `isProfilePinnedByEnv()`; `resolvePluginDir()` в `src/types.ts` теперь delegates to `getProfileDir(getProfileName())`, так что все каталоги/БД/настройки стали per-profile автоматически.
- RPC: `get_profiles`, `set_profile`, `create_profile`, `delete_profile`; дашборд показывает имя профиля в заголовке и в `/api/health`.

### Workspace env (Спринт 21)

- Env-переменные на workspace: `.env`-файл (`envFile`) или пары ключ-значение (`env`); пары переопределяют файл. Валидация имён ключей (`^[A-Za-z_][A-Za-z0-9_]*$`), максимум 100 пар.
- Файл `<PLUGIN_DIR>/env/<sanitized>.env` (права 0600) передаётся обёрткам: Windows — `-EnvFile "<путь>"`, POSIX — `ENV_FILE=` + `set -a; . "$ENV_FILE"; set +a` перед запуском `opencode run`. Значения не попадают в логи: секретные ключи (Token/Secret/Pass/Password/Key/Credential/Auth) маскируются как `***`.
- `manage_workspaces` (add/update) принимает `env` и `envFile`; `get_workspaces`/`get_workspace` возвращают env в замаскированном виде.

### Tests

- `test-profiles.mjs` (58 проверок) — профили: default vs named dir, sanitize/validate, create/list/delete, маркер, порт env > profile.json > null, изоляция БД/настроек через subprocess с разными `OPENCODE_SCHEDULER_HOME`/`OPENCODE_SCHEDULER_PROFILE`.
- `test-env.mjs` (53 проверок) — парсер `.env` (комментарии, кавычки, `export `), приоритет пар над файлом, валидация ключей и >100 пар, `maskEnvForLog` (секреты → `***`), `writeWorkspaceEnvFile` (содержимое, права 0600, очистка устаревших), круговая запись workspace с env/envFile в БД.
- Оба теста добавлены в цепочку `npm test` (итого 17 секций, 500+ проверок).

### Fixed

- **`run_task_now` больше не зависит от расписания.** Одноразовый маркер `--force-file` (срок жизни 2 минуты) снимает проверку cron в `schedule-gate`; маркер ставят все немедленные запуски: инструмент, RPC, файловые триггеры, MCP-события и catch-up.
- **Файловые триггеры работают без перезапуска OpenCode.** `schedule_task` принимает `watchPath`, а набор watcher-ов пересобирается после создания, обновления и удаления задачи.
- **`list_tasks` показывает определения, оставшиеся только в БД.** Такие задачи помечаются `orphaned: true` вместо того, чтобы молча исчезать из списка.
- **`delete_task` честно сообщает об отсутствии задачи.** Вместо ложного `success` возвращается ошибка «не найдена — удалять нечего».
- **Карточки задач показывают свою статистику.** Раньше каждая карточка выводила общие метрики (одинаковые 201/130/71 у всех); теперь `get_tasks` отдаёт `runsTotal`/`runsSuccess`/`runsError` по задаче, общие итоги вынесены в шапку панели. Окно истории фильтруется по задаче (`get_history` принимает `taskName`).
- **«+ Создать» в профилях работает.** `window.prompt` не поддерживается в Electron — все семь вызовов заменены на собственный модальный `askText()` (Enter/ОК, Escape/отмена; для env — textarea с Ctrl+Enter).

### Planned

- Guards, worktree isolation and declarative job files — перенесены в [ROADMAP.md](./ROADMAP.md).

## [1.1.0] - 2026-11-13

### Added

- **Full agent parity:** `schedule_task` now accepts `qualityGate`, `dependsOn`, `retryCount`, `retryDelay`, `nextTaskOnSuccess`, `nextTaskOnError` and the complete matrix configuration (`concurrency`, `overrides`).
- **New agent tools:** `update_task` (partial update, `matrix: null` removes the matrix), `pause_task`, `resume_task`, `get_history`, `get_task_logs`, `dry_run`, `manage_workspaces` (list/add/update/delete) and `matrix_control` (results/cancel/cleanup). 12 tools total.
- Agent tool descriptions are in English; runtime messages stay localized.
- `get_task_logs` supports a `lines` limit (1–1000).
- `update_task` keeps every field that is not passed, so the agent can change one setting without resending the whole task.
- **Built-in agent skill** `scheduled-job-best-practices`, registered by the plugin itself: guidance on schedule design, prompt structure, safety defaults, matrix concurrency, DAG rules and failure diagnosis, plus `references/recipes.md` with seven complete examples. No manual `.opencode/skills` setup.
- **Documentation:** `docs/ARCHITECTURE.md` (process model, modules, backends, data model, security model), `docs/FEATURES.md` (full feature catalog with examples and limits) and `docs/MIGRATION.md` (from cron, systemd timers, launchd and Windows Task Scheduler), linked from both READMEs.
- `test-docs.mjs` - 30 checks that the guides exist, stay complete and ship in the npm package.
- **History retention:** `history.retentionDays` (default 30) and `history.maxRecords` (default 5000) in settings (`0` disables either limit); daily auto-cleanup on plugin start plus `PRAGMA incremental_vacuum`; `cleanup_history` RPC and a «🧹 История и ретеншн» panel in the GUI with last-cleanup stats and an «Очистить сейчас» button.
- **14-day analytics:** `get_analytics` RPC and `GET /api/analytics` (runs, success rate, tokens, cost per day/task/model/matrix); dashboard «📊 Аналитика за период» block (KPIs, daily bar chart, top tasks by cost, matrices); history export to CSV/JSON (`GET /api/history/export?format=csv|json`) — `recordCost` falls back to a token-based estimate when `costUsd` is missing.
- **`/api/health`** now reports `version` (from package.json), `scheduler` (backend title), `queueDepth` (unfinished runs) and `db` status.
- `test-retention.mjs` - 19 checks; `test-metrics.mjs` - 25 checks; both wired into `npm test`.

## [1.0.0] - 2026-11-13

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

[Unreleased]: https://github.com/DeadSno/opencode-windows-scheduler/compare/v1.4.0...HEAD
[1.4.0]: https://github.com/DeadSno/opencode-windows-scheduler/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/DeadSno/opencode-windows-scheduler/compare/v1.2.3...v1.3.0
[1.2.3]: https://github.com/DeadSno/opencode-windows-scheduler/compare/v1.2.2...v1.2.3
[1.2.2]: https://github.com/DeadSno/opencode-windows-scheduler/compare/v1.2.1...v1.2.2
[1.2.1]: https://github.com/DeadSno/opencode-windows-scheduler/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/DeadSno/opencode-windows-scheduler/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/DeadSno/opencode-windows-scheduler/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/DeadSno/opencode-windows-scheduler/releases/tag/v1.0.0
