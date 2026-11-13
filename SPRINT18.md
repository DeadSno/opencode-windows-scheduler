# Спринт 18 — История и метрики

Цель спринта: ограничить рост сырой истории (ретеншн по возрасту и размеру,
автоочистка раз в сутки, `PRAGMA incremental_vacuum`), дать срез аналитики за
период (runs / success rate / токены / стоимость по дням, задачам, моделям и
матрицам) в дашборде и экспортом, и сообщить наружу состояние здоровья
плагина (`/api/health`).

## 1. Настройки ретеншна (`src/settings.ts`)

- Секция `history` в `SchedulerSettings` (`HistorySettings`):
  - `retentionDays` — удалять завершённые записи старше N дней (`0` — выкл.);
  - `maxRecords` — хранить не более N последних записей (`0` — без лимита);
  - `lastCleanupAt` / `lastCleanupDeleted` — следы последней автоочистки.
- Дефолты: 30 дней и 5000 записей. Нормализация: `Number → floor → >= 0`,
  битые значения откатываются к дефолту. Очистка правил только завершённые
  записи; `finished_at IS NULL` (запущенные) не трогается.
- `get_settings` / `save_settings` (RPC, GUI) отдают и принимают `history`.

## 2. Очистка истории (`src/db/history-repo.ts`, `src/core/retention.ts`)

- `pruneHistory({ retentionDays, maxRecords, now })`:
  - `DELETE ... finished_at IS NOT NULL AND finished_at < cutoff` (`deletedByAge`);
  - затем удаляет завершённые записи вне топ-N по `started_at DESC, id DESC`
    (`deletedByCount`);
  - возвращает `{ deletedByAge, deletedByCount, deleted, kept, cutoff }`.
- `vacuumHistory()` — `PRAGMA incremental_vacuum` после удаления.
- `countRunningRecords()` — число записей с `finished_at IS NULL` (для `/api/health`).
- `runHistoryRetention(overrides)` — читает настройки, чистит, вакуумирует при
  удалении, сохраняет `lastCleanupAt` / `lastCleanupDeleted` обратно в settings.json,
  возвращает отчёт; при обоих лимитах `0` — `skipped`.
- `maybeRunHistoryRetention(force)` — не чаще раза в сутки (по `lastCleanupAt`),
  вызывается при старте плагина, ошибки логируются и не роняют запуск.

## 3. Аналитика (`src/core/analytics.ts`)

Чистые функции без БД/HTTP (тестируются напрямую):

- `buildAnalytics(records, { days = 14, topLimit = 10, now, tasks })` →
  `AnalyticsReport`: `totals` (runs, success/error/partial, success rate,
  tokens, costUsd), `daily[]` по UTC-дням, `tasks[]` (per-task totals,
  success rate, avgDurationMs, isMatrixClone / matrixParentId),
  `topByCost[]`, `matrices[]` (агрегация по клонам), `byModel[]`.
  Записи со статусом `running` и вне окна исключаются.
- `historyToCsv(records)` — BOM + `;` + CRLF, экранирование по RFC 4180-стилю;
  `recordCost` — `costUsd` из записи, иначе оценка `tokens × 0.003 / 1000`;
  `recordDate`, `HISTORY_CSV_HEADER`, `csvCell`.

## 4. HTTP API и дашборд (`src/server.ts`)

- `GET /api/analytics?days=14&top=10` — JSON-отчёт (окно 1..365, top >= 1).
- `GET /api/history/export?format=csv|json` — файл через
  `Content-Disposition` (`sendAttachment`), заголовок `x-plugin-dashboard`.
- `GET /api/health` — `{ ok, app, port, version, scheduler, queueDepth, db }`:
  - `version` — из `package.json` (runtime-чтение рядом с dist, fallback `unknown`, `src/version.ts`);
  - `scheduler` — заголовок бэкенда (`getSchedulerTitle()`);
  - `queueDepth` — число незавершённых запусков (`countRunningRecords()`);
  - `db` — `getDbStatus()` (файл, размер, число записей, recovery).
- Дашборд: блок «📊 Аналитика за период» — KPI, бар-чарт по дням, топ задач по
  стоимости, матрицы, кнопки выгрузки CSV/JSON (рядом с метриками модели).

## 5. GUI (`src/gui.tsx`)

- Сворачиваемая секция «🧹 История и ретеншн» (рядом с «🔔 Уведомления»):
  - поля `retentionDays` / `maxRecords` (0 = выкл.), подсказка «0 = …»;
  - строка «Последняя очистка: <дата>, удалено: N»;
  - кнопка «🧹 Очистить сейчас» → `cleanup_history` (форма сначала
    сохраняется, затем RPC, тосты по результату).
- `save_settings({ history })` обновляет сигналы из ответа сервера.

## 6. RPC (`src/rpc.ts`, `src/index.ts`)

- `cleanup_history({ retentionDays?, maxRecords? })` →
  `{ success, message, deleted, deletedByAge, deletedByCount, kept,
     retentionDays, maxRecords, vacuumed }`.
- `get_analytics({ days?, topLimit? })` → `{ success, report }`;
  при ошибке — `{ success: false, report: null, error }`
  (схема GetAnalyticsOutput: `report: ["object","null"]` + поле `error`).
- `get_metrics` НЕ расширялся: это all-time агрегат (`loadMetrics()`),
  периодная аналитика — отдельным `get_analytics` (расхождение с роадмапом,
  см. «Ограничения»).

## 7. Тесты

- `test-retention.mjs` — 19/19: прун по возрасту/размеру, защита запущенных
  записей, идемпотентность, `vacuumHistory`, дневная дросселизация
  `maybeRunHistoryRetention`, отчёт `runHistoryRetention`.
- `test-metrics.mjs` — 25/25: `buildAnalytics` (окно, running-фильтр,
  UTC-сутки, success rate 66.7/50, матрицы, модели, topByCost, пустые входы),
  `historyToCsv`/`csvCell`.
- Оба добавлены в цепочку `npm test` (и в `test:retention` / `test:metrics`).

## 8. Проверка

- `npm run build` — OK.
- `npm run build:gui` — OK, `gui-experimental.cjs` ≈ 117.12 kB (gzip ≈ 25.86 kB).
- `node test-retention.mjs` — 19/19; `node test-metrics.mjs` — 25/25.
- Полный `npm test` — exit 0 (sqlite, crash-recovery, workspaces, role-scoped,
  dry-run, matrix, matrix-lifecycle, matrix-sync, retention, metrics,
  agent-tools, skill, docs).

## Ограничения / расхождения с роадмапом

- Роадмап просил `get_metrics` — имя уже занято all-time агрегатом
  `loadMetrics()`. Периодная аналитика вынесена в отдельный `get_analytics`
  (`days` 1..365, `topLimit >= 1`). `get_metrics` оставлен как есть.
- `/api/health` не отдаёт статистику «осиротевших задач», как хотел роадмап:
  сироты матриц и их очистка остаются в инструментах матриц
  (`matrix_control(cleanup)`), а в health видны БД и глубина очереди —
  то, что нужно для внешнего мониторинга без тяжёлой логики.
- `cleanup_history` без аргументов использует текущие настройки ретеншна;
  с аргументами — разовое переопределение (на диск не сохраняется).
- Ретеншн чистит только сырую историю; агрегаты «Всего запусков» в метриках
  живут в `metrics.json` и на удаление не влияют.
- Автоочистка — не чаще раза в сутки и только при старте плагина
  (плюс по кнопке «Очистить сейчас»); cron-джобы для неё не заводятся.
