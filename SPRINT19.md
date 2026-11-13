# Спринт 19 — Планирование 2.0

Цель спринта: сделать расписание задач гибким — часовой пояс на задачу, окна запуска
с переносом (не пропуском), расширенный cron (@every, L, #) и паузу до даты с
автопродолжением. Без новых зависимостей — свой парсер cron и шлюз в обёртке.

## 1. Расширенный cron и математика с часовым поясом (`src/core/schedule-v2.ts`)

Новый чистый модуль без ввода-вывода:

- Полная 5-полевая грамматика cron: `*`, списки `a,b`, диапазоны `a-b`, шаги
  `*/n` и `a-b/n`, имена месяцев `JAN-DEC`, имена дней `SUN-SAT` (регистро-
  независимо, `0` и `7` — воскресенье).
- Сахар `@every 15m`, `@every 2h`, `@every 1d` (нормализуются в `*/n`).
- `L` — последний день месяца (в одиночку и в списках `15,L`).
- `d#n` — n-й день недели месяца (например `FRI#3`, `0#1`); `n` от 1 до 5.
- Vixie OR-семантика: если и день месяца, и день недели ограничены — достаточно
  совпадения одного из них.
- Экспорты: `parseCron(expr)` → `ParsedCron`, `cronMatches(spec, date, tz?)`,
  `nextRun(expr, from, tz?)`, `prevRun(expr, from, tz?)`, `normalizeCron`,
  `isValidIanaTimeZone(tz)` (через `Intl.DateTimeFormat`, RangeError = неверная
  зона), `systemTimeZone()`, `isNativeSchtasksExpr(expr)`,
  `convertForSchtasks(expr)` (делегирует `convertCronToSchTasks`).
- Часовой пояс через кэшированные `Intl.DateTimeFormat` + итеративный
  wall→UTC (`wallToUtc` с подбором самого раннего вхождения при ambiguous-time
  осеннего перехода; несуществующее весеннее время пропускается).
- `MAX_SEARCH_DAYS = 5 * 366` — защита от зацикливания.

```ts
parseCron("0 0 L * *")          // последний день месяца
parseCron("0 9 * * FRI#3")      // третий пятницу месяца
normalizeCron("@every 15m")     // "*/15 * * * *"
nextRun("0 9 * * *", now, "Europe/Moscow") // в зоне задачи
```

## 2. Окна запуска (`src/core/schedule-v2.ts` + `src/core/schedule-gate.ts`)

Новые опциональные поля определения задачи: `notBefore` / `notAfter` (`HH:MM`,
могут пересекать полночь, например `22:00`–`06:00`).

- `validateLaunchWindow(nb, na)` — пара обязательна оба, `HH:MM` 24ч, не равны.
- `isInWindow(now, nb, na, tz?)` — поддерживает обёртывание через полночь.
- `windowDelayMs(...)` — ms до открытия окна.
- Окно реализуется как **перенос, а не пропуск**: если cron совпал, но сейчас
  вне окна — обёртка ждёт открытия окна ( шагами по 60 с, перепроверяя), затем
  запускает агента.

## 3. Часовой пояс задачи (`timezone`)

Поле `timezone` (IANA, например `Europe/Moscow`) в `TaskDefinition`.

- Задано — cron считается в этом поясе (`nextRun`, `prevRun`, `cronMatches`,
  dry-run次の запуска, gate).
- Не задано — системный пояс.
- Задано ≠ системное → задача регистрируется в **poll-режиме**: ОС будит её
  каждую минуту (`MINUTE /mo 1`), а расширенный cron и зона проверяются внутри
  обёртки через `schedule-gate`. Не требует карты IANA→Windows и не ломает
  ручные запуски / catch-up (родной триггер уже сработал по cron).
- `needsPollMode(expr, timezone)` и `buildScheduleGate(...)` принимают решение
  о poll-режиме.

## 4. Шлюз запуска (`src/core/schedule-gate.ts`)

CLI, вызываемый обёрткой перед агентом:

```
node dist/core/schedule-gate.js --cron "0 9 * * *" [--tz "Europe/Moscow"]
                                [--not-before 22:00 --not-after 06:00]
                                [--defer-file "...\name.lock.defer"]
                                [--now 2026-11-13T12:00:00.000Z] (тесты)
```

Коды выхода:
- `0` — можно запускать (обёртка выполняет агента);
- `3` — не время (cron не совпал, уже есть отложенный запуск, не в окне) —
  обёртка завершается тихо;
- `1` — некорректные аргументы (логируется, запуск разрешён, чтобы не ломать
  задачу из-за опечатки).

Невалидная зона/окно логируются и пропускаются (задачу не ломают). Если задан
окно и сейчас вне него — приобретается defer-файл (`fs.openSync(..., "wx")`,
старее 25 ч считается протухшим), обёртка спит до открытия окна, освобождает
файл и выходит с кодом 0. dedup дедублицирует параллельные отложенные тики.

## 5. Интеграция с обёртками (`src/core/ps-wrapper.ts`, `src/core/wrappers/bash.ts`)

`writeWrapperCmd` и `writeBashWrapper` получили опциональный `scheduleGate`:
`{cron?, tz?, notBefore?, notAfter?, gateFile, deferFile?}`.

- Windows `.cmd`: после `cd /d …` и **до** `powershell.exe …` вставляется
  вызов `node "<gateFile>" --cron … --tz … --not-before … --not-after …
  --defer-file … >> "<log>" 2>&1`, затем `if "%errorlevel%"=="3" exit /b 0`.
- Bash: блок gate вставляется **до** атомарной блокировки (`mkdir "$LOCK_FILE.d"`),
  чтобы ожидание окна не удерживал замок; при коде 3 — `exit 0`.

## 6. Создание и обновление задач (`src/index.ts`, `src/task-transfer.ts`)

`schedulerCreateTask` получил три trailing-параметра: `timezone?`, `notBefore?`,
`notAfter?` (после `matrixMode`). Валидация при `triggerType === "cron"`:
`parseCron(schedule)`, `isValidIanaTimeZone`, `validateLaunchWindow`. Вычисляется
`gate = buildScheduleGate(...)` и передаётся в обёртки; в `scheduler.createTask`
и в объект `taskDefinition` попадают все четыре новых поля
(`timezone`, `notBefore`, `notAfter`, `pausedUntil`).

`TaskDefinition` (`src/task-transfer.ts`) gained `timezone?`, `notBefore?`,
`notAfter?`, `pausedUntil?` — с импортом/экспортом (round-trip) и валидацией
(`isValidIanaTimeZone`, `validateLaunchWindow`, `Date.parse` ISO для
`pausedUntil`). БД — JSON-блоб, миграция не требуется.

Все вызовы сайтов (`scheduleTaskExecute`, RPC `schedule_task`, `updateTaskFromInput`,
`import_tasks`, клоны матрицы) прокидывают новые поля.

## 7. Пауза до даты (`pausedUntil`)

Поле `pausedUntil` (ISO) в `TaskDefinition`.

- `pause_or_resume` (`pauseOrResumeTask`) получил `until?: string` —
  валидирует ISO-момент в будущем, при паузе сохраняет `pausedUntil` в definición
  через `saveTask`, при resumed — очищает. Сообщение gains суффикс «до …».
- `resumeExpiredPauses()` — при старте плагина (рядом с
  `maybeRunHistoryRetention`) и по `setInterval(5 мин)`: определения с
  `pausedUntil <= now` возобновляются (`scheduler.resumeTask` + очистка поля);
  клоны матрицы пропускаются (родитель ведёт за всех).
- Таймер очищается в `dispose`.
- Catch-up пропускает задачи с `pausedUntil`.

## 8. TaskItem / TaskJob / GUI (`src/rpc.ts`, `src/index.ts`, `src/gui.tsx`)

- `TaskItem` (RPC) gained `timezone`, `notBefore`, `notAfter`, `pausedUntil`
  (type `["string","null"]`); collectTasks в `get_tasks` прокидывает их после
  `watchPath`.
- `Job` (GUI) gained те же поля; форма создания/редактирования ganhou inputs:
  текстовое поле часового пояса с `<datalist id="iana-timezones">`
  (Moscow/London/Berlin/New_York/Los_Angeles/Almaty/Tokyo/UTC) и couple
  `<input type="time">` для окна запуска; task row ganhou три чипа:
  🌍 часовой пояс, 🪟 окно запуска, ⏸ пауза до даты.
- `reset`-кнопки формы очищают новые поля.

## 9. Dry-run (`src/core/dry-run.ts`)

`DryRunTaskItem` gained опциональный `scheduleDetails`:
`{cron, timezone, notBefore, notAfter, pausedUntil, nextRuns: string[]}` — для
cron-задач вычисляются три ближайших срабатывания через `nextRun` в зоне задачи.

## 10. Сборка и проверки

- `npm run build` — без ошибок (tsc,包括新 модулей).
- `npm run build:gui` — без ошибок.
- `npm test` — 14 секций, зелёный, включая новую `test-schedule-v2.mjs` (50
  проверок: парсер, `nextRun`/`prevRun`, DST Берлин весна/осень, окна
  incl. через полночь, CLI-шлюз exit-коды).

## 11. Ограничения

- **Временная зона ≠ системная → poll-режим (`MINUTE /mo 1`)**: точность срабатывания
  ограничена минутой ОС, а не секундами cron; альтернатива — schtasks XML с
  `<TimeZoneId>`, не реализована.
- **macOS launchd:** expanded/`L`/`#`/чужой timezone → `StartInterval 60` + gate
  (родной `StartCalendarInterval` не выражает такие выражения).
- **Перенос окна без ограничения по времени:** если окна не было в течение
  суток (например `22:00–06:00` и задача проснулась в 09:00, окно уже закрыто),
  gate будет ждать до следующего открытия — это по 설계 (перенос, не пропуск).
- **Ручное запуск и catch-up не перепроверяют cron** (для poll-режима cron
  в gate не передаётся, только зона и окно) — не ломает ручной запуск.
- **`pause_task` с `until` — только на родителя матрицы:** клоны управляются
  родителем; авто-возобновление пропускает клоны с `matrixParentId`.
- **БД без миграции:** новые поля живут в JSON-блобе `tasks`, старые экспорты
  читаются без изменений (поля отсутствуют = дефолт).
