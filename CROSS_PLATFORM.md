# Кроссплатформенность: Windows → macOS → Linux

Плагин больше не привязан к `schtasks`. Планировщик вынесен в абстрактный слой с тремя реализациями,
а обёртки запуска генерируются под целевую ОС.

## Архитектура

```
src/
  index.ts                     # инструменты, RPC, жизненный цикл плагина
  gui.tsx                      # панель GUI (заголовок берётся из RPC)
  server.ts                    # веб-дашборд (заголовок динамический)
  core/
    scheduler/
      types.ts                 # SchedulerBackend, CreateTaskOptions, RunTaskResult
      index.ts                 # фабрика createSchedulerBackend() + getSchedulerTitle()
      windows.ts               # WindowsScheduler  (schtasks)
      linux.ts                 # LinuxScheduler    (crontab)
      mac.ts                   # MacScheduler      (launchd / LaunchAgents)
      posix.ts                 # общая база для Linux/macOS (реестр задач)
      registry.ts              # персистентный реестр задач POSIX-бэкендов
      logs.ts                  # чтение логов задач (кроссплатформенно)
    wrappers/
      bash.ts                  # генератор .sh-обёрток для Linux/macOS
    ps-wrapper.ts              # .ps1/.cmd-обёртки для Windows (как раньше)
    record-history.ts          # метрики/история + retry/цепочки (через бэкенд)
    cron-to-schtasks.ts        # cron → schtasks (только Windows)
```

### Интерфейс

```ts
interface SchedulerBackend {
  readonly platform: NodeJS.Platform;
  readonly title: string;              // «Планировщик Windows» / «OpenCode Scheduler»
  createTask(options: CreateTaskOptions): Promise<void>;
  deleteTask(name: string): Promise<void>;
  runTask(name: string): Promise<RunTaskResult>;
  listTasks(): Promise<ScheduledTaskInfo[]>;
  pauseTask(name: string): Promise<void>;
  resumeTask(name: string): Promise<void>;
}
```

Фабрика выбирает реализацию по `process.platform`:
`win32 → WindowsScheduler`, `darwin → MacScheduler`, остальные → `LinuxScheduler`.

## Как работает каждая ОС

### Windows (поведение не изменилось)
- Задачи регистрируются в Планировщике Windows через `schtasks` в папке `\OpenCode\windows-scheduler\`.
- Обёртка: `run-task.ps1` + персональный `run-<name>.cmd` в `%APPDATA%\opencode\windows-scheduler\wrapper`.
- Логи: `%APPDATA%\opencode\windows-scheduler\logs\<name>.log`.
- cron конвертируется в schtasks (`convertCronToSchTasks`) — поддерживается тот же набор шаблонов.

### Linux
- Задачи живут в управляемом блоке `crontab`:
  ```
  # >>> opencode-scheduler >>>
  # task: my-task
  */5 * * * * /bin/bash '/…/wrapper/run-my-task.sh' >> '/…/logs/my-task.log' 2>&1
  # <<< opencode-scheduler <<<
  ```
- Пауза = строка с префиксом `# PAUSED: ` (блок пересобирается из реестра).
- Задачи с триггером `file` в crontab не попадают — их запускает FileWatchManager плагина.
- Обёртка: `~/.config/opencode/windows-scheduler/wrapper/run-<name>.sh` (chmod 0755).
- Полный cron-синтаксис (в отличие от Windows), т.к. crontab понимает его нативно.
- Удаление/пересборка — только своего блока, остальные строки `crontab` не трогаются.

### macOS
- Задачи — LaunchAgent-плисты `~/Library/LaunchAgents/com.opencode.scheduler.<name>.plist`.
- Расписание: `StartInterval` для `* * * * *` и `*/N`, `StartCalendarInterval` для `M * * * *`,
  `M H * * *`, `M H * * D`.
- Пауза = `launchctl unload -w`, возобновление = `launchctl load -w`.
- Обёртка — тот же `.sh`, что и на Linux; пути конфигов:
  `~/.config/opencode/windows-scheduler/` (или `$XDG_CONFIG_HOME`).

### Общая POSIX-обёртка (`.sh`)
- `cd` в рабочую директорию, `opencode run` с промптом из файла.
- Логи пишутся в файл через `>>` и дублируются метками времени.
- Блокировка через атомарный `mkdir` — защита от параллельных запусков.
- Таймаут: дочерний процесс + watchdog (`TERM`, затем `KILL`).
- Quality Gate: `bash -lc "<команда>"` (аналог `cmd.exe /c` на Windows).
- Метрики: `node "<record-history.js>" <task> <status> <started> <duration> <error> "-" "-"` —
  тот же контракт, что и в PowerShell-обёртке, поэтому история/метрики/retry/цепочки работают везде.
- `PATH` дополняется `/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`, `~/.bun/bin`.

## GUI и дашборд
- Заголовок динамический: на Windows — «Планировщик Windows», на macOS/Linux — «OpenCode Scheduler».
- Источник заголовка — новый RPC-метод `get_platform` → `{ platform, title }`.
- Заголовок используется и в панели GUI, и в fallback-панели ошибки, и в `<title>/<h1>` веб-дашборда.
- Кнопки, статусы, таблица, DAG и метрики не зависят от ОС.
- Описания инструментов (`schedule_task` и др.) подставляют актуальное название планировщика.

## Сборка и проверки
- `npm run build` — OK, ошибок нет.
- `npm run build:gui` — OK (`gui-experimental.cjs`, ~47.7 kB).
- Проверено в runtime:
  - заголовки для win32/darwin/linux;
  - `cronToLaunchdSchedule` на нескольких выражениях;
  - живой `listTasks()` на Windows — задачи возвращаются короткими именами (без префикса);
  - экранирование `shellQuote` (кавычки, пробелы, кириллица);
  - импорт `dist/index.js` проходит, `dist` не тянет `schtasks.js` напрямую.

## Ограничения и что проверить на реальных машинах
1. `.sh`-обёртки и crontab/launchd **не исполнялись** — на текущей Windows-машине нет `bash`/WSL.
   Синтаксис и экранирование проверены вручную; нужен прогон на Linux и macOS.
2. cron → launchd поддерживает тот же ограниченный набор шаблонов, что и Windows
   (`* * * * *`, `*/N * * * *`, `M * * * *`, `M H * * *`, `M H * * D`).
   На Linux доступен полный cron.
3. Префикс задач Windows (`\OpenCode\windows-scheduler\`) и id плагина сохранены для обратной совместимости.
4. `src/schtasks.ts` оставлен как тонкий shim для старых скриптов (`test-create.cjs`, `test-run.cjs`),
   вся логика теперь в `core/scheduler/windows.ts`.
