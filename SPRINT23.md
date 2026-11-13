# Спринт 23 — One-shot расписание

**Статус:** готово. Разовые задачи реализованы через новый тип триггера
`triggerType: "once"`, время запуска задаётся `runAt` (ISO-8601 либо локальная
дата/время) или `delaySeconds` (задержка от текущего момента).

## Что сделано

### 1. Модель и API

- `schedule_task` принимает `runAt` и `delaySeconds`; для `triggerType: "once"`
  `schedule` не требуется. Для cron `schedule` остаётся обязательным.
- `update_task` умеет включить/изменить one-shot: передать `runAt` либо
  `delaySeconds`; при отсутствии обоих берётся прежний `runAt`.
- RPC: `create_task` и `update_task` получили `runAt` / `delaySeconds`,
  `CreateTaskInput.schedule` больше не обязателен; `schedule_task` и
  `update_task` возвращают `runAt` в модели задачи.
- One-shot нельзя совместить с matrix; `schedule_task`, RPC и `update_task`
  отклоняют такую комбинацию.

Примеры:

```json
{
  "name": "deploy-once",
  "triggerType": "once",
  "runAt": "2026-11-13T22:40:00+03:00",
  "prompt": "Deploy the current main branch."
}
```

```json
{
  "name": "remind-later",
  "triggerType": "once",
  "delaySeconds": 3600,
  "prompt": "..."
}
```

`runAt` имеет приоритет над `delaySeconds`. Время считается будущим;
прошедшие даты и `delaySeconds <= 0` отклоняются. Максимальная задержка —
5 лет.

### 2. Нативная регистрация

- **Windows**: `schtasks /sc ONCE /sd DD.MM.YYYY /st HH:MM`.
- **Linux**: одноразовая задача через `at -t YYYYMMDDHHMM`; id задания
  сохраняется в реестре (`scheduler-<backend>.json`, поля `runAt` / `atJobId`),
  отмена — через `atrm`.
- **macOS**: `StartCalendarInterval` с `Month/Day/Hour/Minute`; после запуска
  wrapper снимает LaunchAgent через `launchctl bootout` в фоне.
- Pause/resume: при паузе one-shot задание снимается из ОС/отменяется, при
  возобновлении — если `runAt` в будущем — регистрируется заново.
- После рестарта плагина задача не дублируется и не выполняется повторно:
  расписание хранится нативно в ОС, а не в цикле плагина.

### 3. Экспорт/импорт

- `TaskDefinition` получил `runAt`; `triggerType: "once"` экспортируется с
  пустым `schedule` и `runAt`.
- Импорт обратно совместим: старые пакеты без `once` читаются как раньше;
  one-shot без времени отклоняется с понятной ошибкой.
- `delaySeconds` при импорте нормализуется в абсолютный ISO `runAt`.

### 4. Предпросмотр и UI

- Dry-run: для once `trigger: "once"`, `scheduleDetails.nextRuns = [runAt]`.
- GUI: выбор «Разово», поля `runAt` / `delaySeconds`, валидация формы;
  дашборд и `collectTasksView` показывают «запланировано на …» вместо пустого
  cron-расписания.

## Изменённые файлы

| Файл | Изменение |
|---|---|
| `src/core/one-shot.ts` | **новый**: нормализация `runAt`/`delaySeconds`, форматы `at`/`schtasks`/launchd |
| `src/core/scheduler/types.ts` | `CreateTaskOptions.runAt`, `TriggerType` + `once` |
| `src/core/scheduler/registry.ts` | `RegistryEntry.runAt`, `atJobId` |
| `src/core/scheduler/windows.ts` | нативные `/sc ONCE` flags |
| `src/core/scheduler/linux.ts` | one-shot через `at` |
| `src/core/scheduler/mac.ts` | `StartCalendarInterval` для once |
| `src/core/scheduler/posix.ts` | проброс `runAt` в реестр |
| `src/core/wrappers/bash.ts` | фоновый cleanup для one-shot (launchd) |
| `src/task-transfer.ts` | `TaskDefinition.runAt`, экспорт/импорт `once` |
| `src/index.ts` | схемы, `schedulerCreateTask`, update, RPC, `collectTasksView` |
| `src/rpc.ts` | `runAt`/`delaySeconds` в inputs, `TaskItem.runAt` |
| `src/core/dry-run.ts` | `trigger: "once"`, `scheduleDetails` |
| `src/gui.tsx` | форма one-shot, валидация |
| `src/server.ts` | метка one-shot в дашборде |
| `test-one-shot.mjs` | **новый**: 41 проверка |
| `package.json` | тест в цепочке `npm test`, скрипт `test:one-shot` |
| `ROADMAP.md`, `README.md`, `docs/FEATURES.md` | документация спринта |

## Совместимость

- Старые cron/file/MCP-задачи и экспорт/импорт работают как прежде.
- `format=json|csv|otlp` экспорт истории не менялся.
- Новых зависимостей нет: используется `node:*` и существующий стек.

## Проверки

```bash
npm run build
npm run build:gui
npm test
node test-one-shot.mjs
```

`test-one-shot.mjs` покрывает нормализацию `runAt`/`delaySeconds`, форматы
Windows/Linux/macOS, экспорт/импорт round-trip и dry-run для one-shot.

## Ограничения

- One-shot нельзя совмещать с matrix; для этого остаются cron/file/manual.
- Linux требует установленный `at`; без него one-shot не регистрируется.
- Windows `schtasks` с одноразовым триггером выполняет задачу с точностью до
  минуты (ограничение ОС).
