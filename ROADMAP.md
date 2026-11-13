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

## Спринт 19 — Планирование 2.0 ⬅️ СЛЕДУЮЩИЙ

1. `timezone` на задачу (IANA), корректный пересчёт cron → schtasks и в dry-run.
2. Окна запуска: `notBefore` / `notAfter` (например, деплой только 22:00–06:00) — перенос запуска, а не пропуск.
3. Расширенный cron: `@every 15m`, `L` (последний день месяца), `#` (N-й день недели).
4. Пауза до даты (`pausedUntil`) с автопродолжением.
5. Тесты: `test-schedule-v2.mjs` (включая DST и переходы суток).

## Спринт 20 — Уведомления v2

1. Дайджест (ежедневный/еженедельный): сколько запусков, success rate, стоимость, топ ошибок.
2. Уведомления о матрицах: `partial`, «матрица зависла» (клоны running дольше N минут), «все клоны упали».
3. Настраиваемые шаблоны сообщений + отдельные фильтры по задачам.
4. Повтор отправки при сетевой ошибке (backoff), таймаут webhook.
5. **ntfy.sh не реализуем** (исключён заданием), каналы: webhook + тосты.

## Спринт 21 — Мультипроектность

1. Профили (`default`, `work`, …): отдельные БД/настройки/дашборд-порт.
2. Группировка задач по проекту в GUI/дашборде, переключение профиля.
3. Env-переменные на workspace (`.env`-файл или пары ключ-значение) с маскировкой секретов в логах.
4. Тесты: `test-profiles.mjs`, `test-env.mjs`.

## Спринт 22 — Интеграции и наблюдаемость

1. Входящий webhook-триггер: `POST /api/hooks/:task?token=…` (HMAC-подпись) — запуск из GitHub Actions/GitLab CI.
2. Structured logs (JSONL) + `/api/logs` с фильтрами.
3. Метрики в формате Prometheus (`/metrics`): запуски, длительность, ошибки, очередь.
4. Экспорт истории в OpenTelemetry-совместимом виде (опционально).

## Правила спринта (не меняются)

- Без новых зависимостей, Node 24, `npm run build` + `npm run build:gui` обязательны.
- Каждый спринт: новый `test-*.mjs` в цепочку `npm test`, отчёт `SPRINT<n>.md`.
- Обратная совместимость: старые `tasks.json`/экспорт читаются без миграции пользователем.
