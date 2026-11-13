# Спринт 10 — CI/CD Lifecycle Hooks + Event-Driven через MCP

Плагин стал полноценным CI/CD-оркестратором: появились pre-flight/post-flight
хуки, событийные MCP-триггеры и What-If-анализ моделей в дашборде.
Изменения кроссплатформенные: хуки работают в PowerShell- и Bash-обёртках,
MCP-триггеры учитываются во всех бэкендах планировщика.

## 1. Lifecycle Hooks (pre-flight / post-flight)

### Модель данных

- `TaskDefinition.beforeScript?: string` — команда до запуска.
- `TaskDefinition.afterScript?: string` — команда после запуска.
- Поля сохраняются в `tasks.json`, экспортируются/импортируются и входят в шаблоны.

### PowerShell (`src/core/ps-wrapper.ts`)

- В `run-task.ps1` добавлены параметры `-BeforeScript` и `-AfterScript`.
- Pre-flight выполняется после `Set-Location $Workdir` (хук работает в рабочей
  директории задачи) и до `opencode run`.
- Ненулевой код pre-flight → задача не запускается, `exitCode = 1`,
  сообщение ровно `"Pre-flight script failed"`.
- Post-flight выполняется в `finally` — даже если основная задача упала.
- Ненулевой код post-flight при успешной основной задаче →
  `"Post-flight script failed"` и статус `error`.
- Вывод обеих команд построчно пишется в лог с префиксом `[hook]`.
- `.cmd`-обёртка передаёт `-BeforeScript "..."` / `-AfterScript "..."`.

### Bash (`src/core/wrappers/bash.ts`)

- Переменные `BEFORE_SCRIPT` и `AFTER_SCRIPT`.
- Pre-flight: `bash -lc "$BEFORE_SCRIPT"` в рабочей директории; при ошибке
  `SKIP_MAIN=1`, `EXIT_CODE=1`, `ERROR_MESSAGE="Pre-flight script failed"`.
- Основная задача обёрнута в `if [ "$SKIP_MAIN" -eq 0 ]; then ... fi`.
- Post-flight выполняется после основной задачи всегда, даже при её ошибке.
- Ошибка post-flight при успехе основной задачи даёт
  `"Post-flight script failed"` и `EXIT_CODE=1`.
- Вывод хуков перенаправляется в общий лог задачи.

### История

- `HistoryRecord.preFlightStatus?: "success" | "error" | "skipped"`.
- `HistoryRecord.postFlightStatus?: "success" | "error" | "skipped"`.
- `record-history.js` принимает статусы 9-м и 10-м аргументами:
  `node record-history.js <task> <status> <startedAt> <durationMs> <error> <tokens> <cost> <model> <pre> <post>`.
- Старые записи истории остаются совместимыми (поля опциональны).

### GUI

- Поля формы:
  - **«Команда перед запуском (Pre-flight)»**;
  - **«Команда после запуска (Post-flight)»**;
  - подсказки: «Например: git pull или npm run build. Выполняется в рабочей
    директории задачи» и пояснение про отмену/выполнение при ошибке.
- В карточке задачи — иконка **⚡**, если задан любой из хуков.
- В истории запусков — бейджи `⚡ pre: ✅/❌` и `⚡ post: ✅/❌`.

## 2. Event-Driven триггеры через MCP

### Модель данных

- `triggerType?: "cron" | "file" | "mcp-event"`.
- `mcpEvent?: { server: string; event: string; filter?: string }`.
- Импорт требует непустое `mcpEvent.event` для MCP-триггера; расписание не нужно.

### Шина событий

- RPC-метод **`emit_event({ eventName, payload })`**.
- Обработчик в `src/index.ts`:
  1. загружает `tasks.json`;
  2. выбирает задачи с `triggerType === "mcp-event"`;
  3. сравнивает `mcpEvent.event` с `eventName` без учёта регистра;
  4. применяет фильтр;
  5. сортирует совпадения по приоритету (по убыванию) и запускает через
     `scheduler.runTask`.
- Фильтр:
  - `key=value` — сравнение с верхнеуровневым полем `payload`;
  - иначе — regex по сериализованному payload (при невалидном regex —
    подстрока без учёта регистра);
  - пустой фильтр пропускает событие.

### Планировщики

- Windows: все не-cron триггеры регистрируются как `ONCE` на 31.12.2099
  (запуск только вручную/по событию).
- Linux: для `file` и `mcp-event` crontab-строка не создаётся — задача живёт
  в реестре плагина.
- macOS: для `file` и `mcp-event` используется 10-летний `StartInterval`
  (фактически «никогда»).
- Catch-up пропущенных запусков теперь затрагивает только `cron`-задачи.

### GUI

- Третий вариант триггера **«MCP Event»**.
- При выборе показываются поля:
  - **MCP-сервер / источник** (например, `github`);
  - **Имя события** (например, `github.pr.opened`);
  - **Фильтр** (опционально, `repo="my-project"` или regex).
- В карточке задачи — иконка **📡** с подсказкой события и фильтра.
- MCP-поля и хуки сохраняются в пользовательских шаблонах.

## 3. What-If: анализ моделей (дашборд)

- Новый эндпоинт **`GET /api/models-analysis`**:
  - `models`: `{ model, totalRuns, totalTokens, totalCost, avgDuration, successRate }`;
  - `totals`: общие запуски/токены/стоимость;
  - `whatIf`: расчёт стоимости для `openai/gpt-4o` и `deepseek/deepseek-coder`.
- Стоимость берётся из `costUsd`, если она есть; иначе оценивается по токенам
  и статической таблице цен (USD за 1M токенов):
  `gpt-4o — 10`, `gpt-4o-mini — 0.6`, `deepseek-coder — 0.28`,
  `claude-3-5-sonnet — 9`, `gemini-2.5-pro — 3.5`, fallback — 3.
- В дашборде добавлен блок **«📊 What-If: Анализ моделей»**:
  - таблица: модель, всего запусков, токены, стоимость, средняя длительность,
    % успешных;
  - текст: «Если бы все запуски выполнялись через **openai/gpt-4o**, это
    стоило бы ~**$X**. Если через **deepseek/deepseek-coder** — **$Y**.»;
  - итоговые запуски/токены/фактическая стоимость.
- История выполнений показывает pre/post-flight статусы (⚡ ✅/❌).
- В таблице задач MCP-задачи отображаются как `📡 <event>`.

## 4. RPC и шаблоны

- `TaskItem`, `CreateTaskInput`, `UpdateTaskInput`, `TemplateItem`,
  `SaveTemplateInput`, `HistoryRecord` расширены полями хуков, `mcpEvent`,
  `preFlightStatus`, `postFlightStatus`.
- Добавлен метод `emit_event` (вход `eventName`, `payload`).
- `TaskTemplate` хранит `beforeScript`, `afterScript`, `mcpEvent`, `model`,
  `priority`.
- Экспорт/импорт сохраняет хуки, MCP-триггер, модель и приоритет.

## 5. Проверки

- `npm run build` — без ошибок.
- `npm run build:gui` — без ошибок, `gui-experimental.cjs` ~59.5 kB.
- Сгенерированная Bash-обёртка содержит `BEFORE_SCRIPT`, `AFTER_SCRIPT`,
  `PRE_FLIGHT_STATUS`, `POST_FLIGHT_STATUS`, блок `SKIP_MAIN`, оба сообщения
  об ошибках хуков и передаёт статусы в recorder.
- Сгенерированный `.cmd` содержит `-BeforeScript "git pull"` и
  `-AfterScript "git push"`.
- `record-history.js` с 9-м и 10-м аргументами записывает
  `preFlightStatus`/`postFlightStatus` в `history.json`.
- Импорт/экспорт MCP-задачи с хуками и фильтром сохраняет все поля.
- Живой дашборд: страница содержит блок «What-If: Анализ моделей» и стили
  статусов хуков; `/api/models-analysis` агрегирует модели и считает What-If
  (проверено на временной истории: gpt-4o и deepseek-coder).

## 6. Ограничения

- Фактическое выполнение хуков и `opencode run` проверено по сгенерированным
  скриптам; на реальных Linux/macOS нужен прогон с установленным OpenCode.
- Стоимость в What-If приблизительная: статическая таблица цен, а не тарифы
  провайдера на текущий момент.
- `emit_event` — RPC-метод плагина; внешний вебхук должен вызвать его через
  клиент OpenCode/RPC-мост.
- Для MCP-задач расписание не используется, но планировщик ОС всё равно
  создаёт «пустую» запись (ONCE/10-летний интервал) для единообразия запуска.
