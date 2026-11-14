# 🗺️ Roadmap — opencode-windows-scheduler

План развития плагина. Тактический спринт-план; стратегические приоритеты — в [ROADMAP-STRATEGY.md](./ROADMAP-STRATEGY.md).

> **Важно:** согласно стратегическому роадмапу (после аудита плагина) перед Спринтом 18 идут два внеплановых спринта:
> **17.5 — OSS-упаковка** (LICENSE, npm, CI, английский README) и **17.6 — Паритет агента** (полный доступ к функционалу через инструменты). Детали — в `ROADMAP-STRATEGY.md`.

## Сделано (Спринты 1–16)

| # | Тема | Артефакты |
|---|---|---|
| 1–8 | Ядро: cron → schtasks, lock-файлы, таймауты, повторы, Quality Gate, цепочки (DAG), файловые триггеры, dry-run | `src/core/*`, `src/schtasks.ts` |
| 9 | SQLite-хранилище задач и истории | `src/db/*` |
| 10 | Восстановление после краха, незавершённые записи → error | `src/db/recovery.ts` |
| 11 | Лёгкие уведомления: webhook (Discord/Slack-совместимый) + тосты GUI | `src/notifications.ts`, `src/settings.ts` |
| 12 | Workspace-ы: отдельные директории задач, роль-скоуп tools | `src/workspaces.ts` |
| 13 | Дашборд (HTTP): задачи, история, dry-run, фильтры | `src/server.ts` |
| 14 | Экспорт/импорт задач, шаблоны | `src/task-transfer.ts`, `src/templates.ts` |
| 15 | Matrix Builds (fan-out): клоны по workspace, parallel/sequential, failureMode, агрегация, DAG | `src/core/matrix.ts`, `SPRINT15` в истории |
| 16 | Lifecycle матриц: каскадное удаление, отмена, чистка сирот, guard на удаление клона | `src/core/matrix.ts`, `test-matrix-lifecycle.mjs` |
| 17 | Синхронизация матриц (`syncMatrixFamily`) + per-workspace overrides + concurrency | `src/core/matrix.ts`, `SPRINT17` (отчёт не писался) |
| 18 | Ретеншн истории (30 дней / 5000 записей), аналитика за 14 дней, CSV/JSON-экспорт, `/api/health` | `SPRINT18.md` |
| 19 | Планирование 2.0: timezone на задачу, окна запуска notBefore/notAfter, расширенный cron (@every/L/#), пауза до даты с автопродолжением, следующие срабатывания в dry-run | `SPRINT19.md` |
| 20 | Уведомления v2: ретраи/таймаут webhook, шаблоны, фильтры по задачам, уведомления матриц, детектор зависших клонов, дайджест (день/неделя) | `SPRINT20.md` |
| 21 | Мультипроектность: профили (`default`, `work`, …) с отдельными БД/настройками/портом дашборда, группировка задач по workspace в GUI/дашборде, переключение профиля, env-переменные на workspace (`.env` или пары) с маскировкой секретов, тесты `test-profiles.mjs`/`test-env.mjs` | `SPRINT21.md` |

## Спринт 17 — Синхронизация матриц + per-workspace настройки ✅ Готово

**Проблема:** после создания матрицы изменение `matrix.workspaceIds` (или промпта/хуков) в `update_task`/GUI не пересоздаёт клонов — семья рассинхронизируется, появляются устаревшие клоны. Плюс нельзя задать клону отличия от родителя (свой промпт, модель, QG).

**Объём:**
1. `syncMatrixFamily(parent)` в `src/core/matrix.ts`:
   - diff текущих клонов (по `matrixParentId`) и `expandMatrixTask(parent)`;
   - удалить лишних (ОС + БД, терпимо), создать недостающих, обновить изменившихся (промпт/модель/хуки/QG/tools);
   - обновить агрегатор (`ensureMatrixCompleteTask` / удалить, если `createAggregator` выключили);
   - защита: не трогать клонов со статусом `running` (вернуть предупреждение).
2. Вызвать `syncMatrixFamily` из `update_task` (RPC) и из `schedulerUpdateTask`, если определена матрица.
3. Per-workspace overrides: `matrix.overrides?: Record<workspaceId, { prompt?, model?, qualityGate?, beforeScript?, afterScript? }>` — применяются в `expandMatrixTask`; валидация в `task-transfer.ts` (workspaceId должен входить в `workspaceIds`); round-trip экспорт/импорт.
4. `matrix.concurrency?: number` — максимум одновременно работающих клонов матрицы (в дополнение к глобальному `maxConcurrent`): sequential = 1, parallel без значения = без лимита. Учёт в `runMatrix`/`advanceSequentialMatrix`.
5. GUI: редактор overrides на workspace в матричном блоке, поле «параллелизм», превью с учётом overrides; дашборд — бейдж лимита.

**Готово, когда:**
- изменение `workspaceIds` (добавление/удаление/замена) корректно синхронизирует клонов и агрегатор;
- `running`-клоны не удаляются, возвращается предупреждение;
- overrides и `concurrency` проходят export/import round-trip;
- тесты: `test-matrix-sync.mjs` (≥15 проверок) + весь `npm test` зелёный.

**Ограничения на потом:** история удалённых при синхронизации клонов остаётся (чистится ретеншном — Спринт 18).

## Спринт 18 — Ретеншн истории и аналитика ✅ Готово

Отчёт: `SPRINT18.md`. По факту:
1. Настройки `history.retentionDays` / `history.maxRecords` в settings.json (дефолт 30 дней / 5000 записей, 0 — выкл.), автоочистка раз в сутки при старте плагина + `PRAGMA incremental_vacuum`; ручная кнопка «🧹 Очистить сейчас» и RPC `cleanup_history`. GUI: сворачиваемая секция «🧹 История и ретеншн».
2. RPC: `cleanup_history` + отдельный `get_analytics` (`days` 1..365, `topLimit >= 1`): агрегаты по дням/задачам/моделям/матрицам, success rate, токены, стоимость. All-time RPC `get_metrics` оставлен как был — отдельное имя, см. SPRINT18.md (расхождение с этим пунктом).
3. Дашборд: блок «📊 Аналитика за период» (KPI, график по дням, топ задач по стоимости, матрицы), экспорт истории в CSV/JSON (`/api/history/export?format=csv|json`).
4. `/api/health`: `version` (из package.json), `scheduler`, `queueDepth` (незавершённые запуски), `db` (`getDbStatus()`). Статистику осиротевших задач health не отдаёт — сироты остаются в матричных инструментах (`matrix_control`).
5. Тесты: `test-retention.mjs` (19 проверок) + `test-metrics.mjs` (25 проверок), оба в цепочке `npm test`.

## Спринт 19 — Планирование 2.0 ✅ Готово

**По факту:** все пять пунктов реализованы (отчёт: `SPRINT19.md`).

1. `timezone` на задачу (IANA) — корректный пересчёт cron в этом поясе, DST-безопасный `nextRun`/`prevRun`, для зоны ≠ системной задача уходит в poll-режим (`MINUTE /mo 1` + gate в обёртке); следующий запуск тоже считается в dry-run (`scheduleDetails.nextRuns`).
2. Окна запуска `notBefore`/`notAfter` (HH:MM, можно через полночь) — запуск переносится на открытие окна, не пропускается (postpone в `schedule-gate` с dedup через defer-файл).
3. Расширенный cron: `@every 15m|2h|1d`, `L` (последний день месяца), `d#n` (N-й день недели, например `FRI#3`), имена месяцев/дней недели, диапазоны и списки со шагами.
4. Пауза до даты `pausedUntil` — `pause_task(name, until?)` сохраняет ISO-момент в определении задачи; плагин возобновляет задачи автоматически при старте и по таймеру каждые 5 мин, `resume_task` снимает паузу досрочно.
5. Тесты: `test-schedule-v2.mjs` (50 проверок: парсер, nextRun/prevRun, DST Берлин весна/осень, окна incl. через полночь, CLI-шлюз exit-коды) — в цепочке `npm test`.

## Спринт 20 — Уведомления v2 ✅ Готово

**По факту:** все пять пунктов реализованы (отчёт: `SPRINT20.md`).

1. Дайджест: ежедневный (`daily`) или еженедельный (`weekly`, с догоняющей отправкой после понедельника) — запуски, success rate, стоимость, токены и топ ошибок; планировщик проверяет раз в минуту, есть RPC `send_digest` и кнопка «📊 Отправить дайджест сейчас» (ручная отправка расписание не сдвигает).
2. Уведомления матриц: успех, `partial` и «все клоны упали» после агрегата; детектор зависших клонов (`matrix.stuckAfterMinutes`, дефолт 60, 0 — выкл.) уведомляет один раз на запуск.
3. Шаблоны `templates.success`/`templates.error` с плейсхолдерами `{task} {status} {duration} {error} {emoji}` и фильтры `filters.include`/`exclude` (маски `*`, исключения важнее включений).
4. Webhook: `timeoutMs` (дефолт 10 000), `retryCount` (дефолт 2) и `retryDelayMs` (дефолт 1000), ретраи на сеть/таймаут/5xx/429 с экспоненциальным backoff до 30 с, прочие 4xx без повторов.
5. **ntfy.sh не реализован** (исключён заданием), каналы: webhook + тосты. Тесты: `test-notifications-v2.mjs` (44 проверки) — в цепочке `npm test`.

## Спринт 21 — Мультипроектность ✅ Готово

1. Профили (`default`, `work`, …): отдельные БД/настройки/дашборд-порт.
2. Группировка задач по проекту в GUI/дашборде, переключение профиля.
3. Env-переменные на workspace (`.env`-файл или пары ключ-значение) с маскировкой секретов в логах.
4. Тесты: `test-profiles.mjs`, `test-env.mjs`.

## Спринт 22 — Интеграции и наблюдаемость ✅ Готово

**По факту:** все четыре пункта реализованы, включая опциональный OTLP-экспорт (отчёт: `SPRINT22.md`).

1. Входящий webhook-триггер: `POST /api/hooks/:task?token=…` с HMAC-SHA256 по сырому телу; заголовки `X-Scheduler-Signature`, `X-Hub-Signature-256` (GitHub), `X-Gitlab-Token`; опциональная проверка timestamp. Канал выключен по умолчанию, token/secret генерируются при включении.
2. Structured logs: JSONL `<PLUGIN_DIR>/logs/runs.jsonl` с событиями `run.started` / `run.finished` / `hook.received`, ротация 10 МБ и `GET /api/logs` с фильтрами `task`, `status`, `event`, `since`, `until`, `limit` (+ `format=jsonl`).
3. Prometheus: `GET /metrics` — запуски, ошибки, токены, стоимость, histogram длительности, глубина очереди и объём истории.
4. OpenTelemetry: `GET /api/history/export?format=otlp` — OTLP/JSON со стабильными traceId/spanId на каждый запуск.

Тесты: `test-integrations.mjs` (116 проверок) — в цепочке `npm test`.

## Спринт 23 — One-shot расписание ✅ Готово

**По факту:** разовые задачи реализованы (отчёт: `SPRINT23.md`).

1. `triggerType: "once"`: `runAt` (ISO-8601, локальная дата допускается) либо `delaySeconds`; `schedule` не нужен. Задаётся через `schedule_task`, `update_task`, RPC `create_task` / `update_task`, импорт задач и GUI/дашборд.
2. Нативная регистрация: Windows `/sc ONCE` с датой и временем, Linux `at -t`, macOS `StartCalendarInterval` + cleanup wrapper после запуска. Повторный запуск после рестарта плагина не создаётся.
3. Export/import: `runAt` сохраняется в JSON, старые пакеты без него импортируются как раньше; матрица с one-shot отклоняется.
4. Dry-run: для once `trigger: "once"`, `scheduleDetails.nextRuns = [runAt]`; GUI/дашборд показывают «Разово» и запланированное время.

Тесты: `test-one-shot.mjs` (41 проверка) — в цепочке `npm test`.

## Спринт 24 — Session continuity ✅ Готово

**По факту:** непрерывность сессий реализована (отчёт: `SPRINT24.md`).

1. `session`: `new` (по умолчанию — свежая сессия на каждый запуск), `reuse` (постоянная сессия задачи, `--session <sessionId>`), `last` (`--continue`). `sessionId` генерируется автоматически, пользователем не принимается и не экспортируется.
2. `sessionMaxRuns` (только для `reuse`): после N запусков сессия удаляется (`opencode session delete`), счётчик сбрасывается, следующая сессия — новая. `sessionRunCount` — внутреннее поле, не экспортируется.
3. Export/import: `session`, `sessionId` (reuse) и `sessionMaxRuns` сохраняются; старые пакеты без этих полей импортируются как `new`; `sessionRunCount` не экспортируется никогда.
4. GUI/дашборд: селектор режима и бейджи (⟳ сессия / ↪ продолжение); dry-run показывает режим и sessionId для reuse.

Тесты: `test-session-continuity.mjs` (50 проверок) — в цепочке `npm test`.

## Бэклог после 1.2.3 (запросы пользователей)

Приоритеты: **P1** — делаем первым, **P2** — следующий круг, **P3** — после стабилизации.
Статус указан честно: часть пунктов уже есть, дублировать их не нужно.

### 1. Уведомления: Telegram + нативные toast — P1

Сейчас есть только webhook (Slack/Discord/свой endpoint работают через него) и `send_notification` с `test`/`digest`.

- **Telegram Bot API**: `sendMessage` с `chat_id`, `parse_mode`, токеном бота; настройки в `manage_settings` (токен не хранить в `tasks.json` — см. п. 7), шаблон сообщения с именем задачи, статусом, длительностью, стоимостью и ссылкой на дашборд.
- **Нативные уведомления**: Windows Toast, macOS Notification Center, Linux `notify-send`. Предпочтительно без тяжёлой зависимости: `node-notifier` как optional dependency либо нативные команды ОС.
- Фильтры: уведомлять только об `error`/`partial`, по задачам и по matrix-агрегаторам; тихие часы (не будить ночью).
- Тест: `test-notifications-v3.mjs`.

### 2. Библиотека готовых шаблонов (recipes) — P2

Есть `manage_templates` (пользовательские шаблоны) и 7 рецептов в скилле (`skills/.../references/recipes.md`), но нет встроенной библиотеки и установки одной командой.

- Встроенные рецепты: `nightly-refactor`, `dependency-audit`, `doc-sync`, `test-coverage-report` (+ ещё 3–5 под матрицы и webhooks).
- `manage_templates action=install` / `list-builtin` с валидацией и dry-run перед установкой.
- Каждый рецепт — с Quality Gate и разумными таймаутами по умолчанию; рецепты покрываются тестом (`test-recipes.mjs`), чтобы не протухали.

### 3. Визуализация DAG в GUI — P2 (в основном готово)

Граф зависимостей уже есть в веб-дашборде: собственный SVG, слои «слева без зависимостей → справа ждущие», цветовая индикация `success` / `error` / `partial` / `running`, подсказка и клавиатурный скролл. `reactflow`/`cytoscape` не нужны — это ломает принцип «без новых зависимостей».

Осталось: клик по узлу → карточка задачи, zoom/pan, подсветка пути `dependsOn` / `nextTaskOnSuccess`, отдельная дорожка для matrix-клонов.

### 4. Условные триггеры — P2

- **Git-триггеры**: запуск только если в ветке появились новые коммиты (сравнение `HEAD` с последним запуском), фильтр по ветке и по путям (`git diff --name-only`).
- **File pattern triggers**: сейчас `watchPath` — конкретный файл/папка; добавить glob-маски (`**/*.test.ts`) и ignore-списки.
- **Time-range triggers**: окно выполнения («только 09:00–19:00 по будням») и поведение при попадании запуска вне окна (skip / перенести / выполнить).

### 5. Экспорт в CI/CD — P3

Экспорт задач в GitHub Actions (`.github/workflows/*.yml`) и GitLab CI (`.gitlab-ci.yml`): cron, шаги, Quality Gate, артефакты.

Важно: экспорт теряет агентную оркестрацию (DAG, матрицы, сессии, стоимость). Поэтому сначала — переносимый YAML-формат пайплайна (pipeline-as-code), а экспорт в CI — адаптер из него; обратный импорт из GH Actions — тоже полезен.

### 6. Расширенные метрики — P2

- **Token efficiency score**: успешные запуски / потраченные токены, отдельно успех vs ошибки, по задачам и моделям.
- **Cost forecasting**: прогноз затрат по истории (скользящее среднее, тренд, бюджет на день/неделю с алертом).
- **Grafana**: готовый dashboard JSON + инструкция; Prometheus `/metrics` уже есть, OTLP-экспорт тоже.

### 7. Безопасность и изоляция — P1 (до заявки «CI/CD»)

- **Secrets management**: Windows Credential Manager / macOS Keychain / Linux Secret Service (keytar) или Vault; подстановка в env задачи, маскирование в логах и экспорте.
- **Audit log**: кто создал/изменил/запустил/удалил задачу, когда и с какого интерфейса (агент, GUI, HTTP); поверх существующего structured-log, с ротацией.
- **Sandbox mode**: Docker-контейнер на задачу (образ, монтирование workspace, лимиты CPU/RAM, сеть on/off); Windows Sandbox — отдельным бэкендом. Опционально, по умолчанию выключено.

### 8. Мультиязычная документация — P3

- `README.zh.md` (китайский) и `README.es.md` (испанский) в `docs/`, синхронизированные с английским.
- Переводы быстро протухают: обновлять вместе с релизом или отдать сообществу через PR-шаблон.

### Направление 2.0 — из планировщика в CI/CD-оркестратор (обсуждается)

Чтобы выйти за пределы «Windows-планировщика», нужен не набор фич, а смена модели:

1. **Runner abstraction**: единый интерфейс исполнителя — локальный процесс (сейчас), Docker, SSH-хост, GitHub Actions. Задача описывает *что* делать, runner — *где*.
2. **Pipeline-as-code**: `opencode.pipeline.yaml` в репозитории (versioned, reviewable), CLI `opencode pipeline run`, импорт/экспорт.
3. **Git/PR интеграция**: триггеры на push/PR, создание ветки и PR по результату задачи, статус-чеки.
4. **Artifacts и approvals**: отчёты, coverage, diff; ручное подтверждение перед деплоем, окружения dev/staging/prod.
5. **Remote runners**: агент на удалённой машине, центральный дашборд; очередь задач и конкурентность на кластере.
6. **Имя и позиционирование**: `opencode-windows-scheduler` плохо продаёт кроссплатформенность. Вариант — оставить пакет для совместимости и выпустить алиас `opencode-pipeline` (или `@scope/opencode-pipeline`) на 2.0, с миграционной заметкой.

Порядок: сначала P1 (Telegram, secrets, audit), затем pipeline-as-code + git-триггеры, потом Docker-runner и approvals; remote runners и CI-адаптеры — после подтверждения спроса.

## Правила спринта (не меняются)

- Без новых зависимостей, Node 24, `npm run build` + `npm run build:gui` обязательны.
- Каждый спринт: новый `test-*.mjs` в цепочку `npm test`, отчёт `SPRINT<n>.md`.
- Обратная совместимость: старые `tasks.json`/экспорт читаются без миграции пользователем.
