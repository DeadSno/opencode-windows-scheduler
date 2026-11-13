# Спринт 24 — Session continuity

**Статус:** готово. Реалиованы три режима сессии OpenCode для задач:
`session: "new"` (по умолчанию), `"reuse"` (переиспользование сохранённой
сессии через `--session <id>`) и `"last"` (продолжение последней сессии через
`--continue`), плюс политика `sessionMaxRuns` — автоматическая ротация
reuse-сессии.

## Что сделано

### 1. Модель и API

- `TaskDefinition` получил поля `session` (`new` | `reuse` | `last`),
  `sessionId`, `sessionMaxRuns` и внутренний `sessionRunCount`.
- `schedule_task` и `update_task` принимают `session` и `sessionMaxRuns`;
  `sessionId` из пользовательского ввода **никогда не принимается** — он
  генерируется автоматически (`generateSessionId()`) при режиме `reuse`.
- RPC: `create_task` и `update_task` получили `session` / `sessionMaxRuns`,
  `TaskItem` возвращает `session`, `sessionId` и `sessionMaxRuns`.
- `schedulerCreateTask` трактует режимы сессии атомарно: переключение в
  `new`/`last` очищает `sessionId`, переход в `reuse` без id создаёт новый.

Примеры:

```json
{
  "name": "deploy-reuse",
  "session": "reuse",
  "sessionMaxRuns": 20,
  "prompt": "Deploy the current main branch."
}
```

```json
{
  "name": "continue-last",
  "session": "last",
  "prompt": "Continue where you left off."
}
```

### 2. Враперы и запуск

- **Bash-обёртка** (`src/core/wrappers/bash.ts`): `run_opencode()` собирает
  `SESSION_ARGS` по `case "$SESSION_MODE" in`: `reuse` → `--session "$SESSION_ID"`,
  `last` → `--continue`, `new` → никаких флагов. Режим и id передаются через
  переменные окружения `SESSION_MODE` / `SESSION_ID`.
- **PowerShell-обёртка** (`src/core/ps-wrapper.ts`): те же аргументы
  (`-SessionMode` / `-SessionId` в вызове `run-task.ps1`), только для
  нер-`new` режимов; `sessionId` санитизируется.
- **record-history**: `handleCompletion` вызывает `rotateSessionIfNeeded()`
  после каждого завершённого запуска (best-effort, не влияет на историю).

### 3. Политика ротации

- `sessionMaxRuns` (целое ≥ 1) задаёт, сколько запусков выдерживает
  reuse-сессия; при достижении лимита плагин вызывает
  `opencode session delete <id>`, обнуляет `sessionId` и счётчик — следующий
  запуск стартует чистую сессию. `0`/unset — без ограничения.
- `sessionRunCount` — внутренний счётчик; **никогда не экспортируется** и не
  показывается в UI/RPC как данные задачи.

### 4. Экспорт/импорт

- `TaskDefinition` экспортирует `session`, `sessionMaxRuns` и `sessionId`
  только для `reuse`. Счётчик `sessionRunCount` не экспортируется.
- Импорт обратно совместим: старые пакеты без полей сессии читаются как
  `session: "new"`. Некорректные значения (неизвестный `session`,
  невалидный `sessionId`, `sessionMaxRuns < 1`) отклоняются с понятной
  ошибкой — запись пропускается целиком.

### 5. Предпросмотр и UI

- Dry-run: для reuse-задач возвращается `session: "reuse"` и `sessionId`.
- GUI: радио-группа «Сессия OpenCode» (Новая / Переиспользовать / Последняя),
  поле `sessionMaxRuns` только для reuse; бейджи в карточке (`⟳ сессия` / `↪ продолжение`).
- Дашборд (`src/server.ts`): та же метка в cron/расписание-колонке.
- `collectTasksView` отдаёт `session`, `sessionId`, `sessionMaxRuns`, `sessionRunCount`.

## Изменённые файлы

| Файл | Изменение |
|---|---|
| `src/core/session.ts` | **новый**: `generateSessionId`, `isValidSessionId`, `normalizeSessionMode`, `buildSessionArgs`, `shouldRotateSession`, `rotateSessionIfNeeded` |
| `src/core/wrappers/bash.ts` | аргументы сессии в `run_opencode()`, `SESSION_MODE`/`SESSION_ID` env |
| `src/core/ps-wrapper.ts` | `-SessionMode`/`-SessionId`, санитизация id |
| `src/core/record-history.ts` | вызов ротации после `handleCompletion` |
| `src/task-transfer.ts` | поля сессии в `TaskDefinition`, экспорт/импорт + валидация |
| `src/index.ts` | zod-поля, `schedulerCreateTask`, update/RPC/`collectTasksView` |
| `src/rpc.ts` | `session`/`sessionMaxRuns` в inputs, поля в `TaskItem` |
| `src/core/dry-run.ts` | `session`/`sessionId` в выводе |
| `src/gui.tsx` | радио-группа, поле `sessionMaxRuns`, бейджи |
| `src/server.ts` | метка сессии в дашборде |
| `test-session-continuity.mjs` | **новый**: 50 проверок |
| `package.json` | тест в цепочке `npm test`, скрипт `test:session-continuity` |
| `ROADMAP.md`, `README.md`, `docs/FEATURES.md` | документация спринта |

## Совместимость

- Старые cron/file/MCP-event/once-задачи и экспорт/импорт работают как
  прежде; отсутствие полей сессии = `new`.
- `format=json|csv|otlp` экспорт истории не менялся.
- Новых зависимостей нет: `node:*` и существующий стек.

## Проверки

```bash
npm run build
npm run build:gui
npm test
node test-session-continuity.mjs
```

`test-session-continuity.mjs` покрывает генерацию и валидацию `sessionId`,
нормализацию режима, построение аргументов, ротацию по `sessionMaxRuns`,
экспорт/импорт round-trip и dry-run.

## Ограничения

- **Нет `opencode session compact` CLI.** Ротация выполняется через
  `opencode session delete <id>` после `sessionMaxRuns` запусков; «мягкой»
  компакции контекста средствами OpenCode из плагина нет.
- **Агент и модель из сессии не наследуются.** Нет способа прочитать их из
  CLI; при желании задайте `model` в самой задаче.
- **`sessionId` привязан к машине и профилю** (`PLUGIN_DIR`); экспорт
  переносит id, который на другой машине/профиле может не существовать —
  OpenCode создаст сессию с этим id при первом запуске.
- **`sessionRunCount` недолговечен**: счётчик хранится в определении задачи
  и обнуляется при ротации; он не предназначен для аудита.
