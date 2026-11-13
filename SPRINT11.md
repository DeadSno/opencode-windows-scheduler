# Спринт 11 — Лёгкие уведомления (webhook + тосты OpenCode)

Цель спринта: пользователь узнаёт о завершении задачи, не открывая OpenCode.
По указанию из задания **ntfy.sh не реализован** — остался один сетевой канал
(webhook, совместимый с Discord/Slack) и встроенные тосты GUI.

## 1. Настройки (`src/settings.ts`)

Добавлены типы:

```ts
interface WebhookNotificationSettings {
  enabled: boolean;
  url: string;
}

interface NotificationSettings {
  enabled: boolean;       // главный выключатель
  onlyOnError: boolean;   // true — уведомлять только при ошибке
  webhook?: WebhookNotificationSettings;
}
```

`SchedulerSettings` теперь содержит `notifications: NotificationSettings`.

Дефолты (`defaultNotifications()`):

- `enabled: false` — уведомления выключены;
- `onlyOnError: true` — только ошибки;
- `webhook: { enabled: false, url: "" }`.

`loadSettings()` устойчив к битому `settings.json` и возвращает дефолты.
`saveSettings()` мержит частичный патч, включая вложенный `notifications`,
и нормализует booleans/URL (URL обрезается по краям).

## 2. Модуль отправки (`src/notifications.ts`)

- `formatDuration(ms)` → `2.3s`.
- `formatNotificationMessage({ taskName, status, durationMs, error })`:
  - `✅ Задача "Тест" выполнена (2.3s)`;
  - `❌ Задача "Тест" упала (2.3s): Quality Gate провален`.
- `sendWebhook(url, message)`:
  - POST с `Content-Type: application/json`;
  - тело `{ content: message, text: message }` — работает и с Discord, и со Slack;
  - проверка `http://` / `https://`;
  - таймаут 10 секунд через `AbortController`;
  - не-2xx ответ → исключение с кодом и началом тела ответа.
- `notifyTaskCompletion(taskName, status, durationMs, error?)`:
  - читает настройки;
  - выходит, если `enabled === false`;
  - при `onlyOnError === true` пропускает `success`;
  - отправляет во все включённые каналы (сейчас — webhook);
  - **любые ошибки только логируются в консоль и не выбрасываются** —
  уведомление не ломает задачу.
- `sendTestNotification()` — используется кнопкой «🧪 Тестовое уведомление»,
  возвращает `{ success, message }` с причиной ошибки (для теста это важно).

## 3. Интеграция с обёртками (`src/core/record-history.ts`)

Обёртки не вызывают сеть напрямую. После записи истории в `main()` добавлен
вызов:

```ts
await notifyTaskCompletion(taskName, st, durationMs, error);
```

`record-history.js` уже запускается в `finally` и читает `settings.json`
из того же `APPDATA`, поэтому уведомления работают и для задач, запущенных
Планировщиком Windows / cron / launchd, без изменения PowerShell- и
Bash-обёрток.

Порядок: история и метрики записываются **до** отправки уведомления, поэтому
сбой сети не влияет на `history.json`.

## 4. Тосты OpenCode

**Отклонение от буквы задания:** в серверном контексте плагина
(`@opencode/plugin` `Context`) метода `ctx.toast` нет — тосты доступны только
в GUI-контексте (`@opencode/plugin/gui`). RPC-обработчики получают контекст
без `toast`.

Поэтому тост реализован на стороне GUI:

- после успешного `run_task` запускается `watchManualRun(jobName)`;
- watcher опрашивает `get_history({ limit: 50 })` раз в 2 секунды (до 30 минут);
- находит свежую запись этой задачи (`startedAt >=` момента запуска);
- показывает `ctx.toast.show`:
  - `variant: "success"` — «Задача "X" выполнена», описание `2.3s`;
  - `variant: "error"` — «Задача "X" упала», описание `2.3s: <ошибка>`;
- после показа обновляет список задач.

Если задача уже выполняется, watcher не запускается (показывается мягкий тост
«уже выполняется»). Таймеры очищаются в `onCleanup`.

## 5. GUI — секция «🔔 Уведомления» (`src/gui.tsx`)

Сворачиваемая панель под настройками, чтобы не загромождать форму:

- заголовок показывает состояние: `выключены` / `только ошибки` / `все запуски`;
- чекбокс «Включить уведомления»;
- чекбокс «Только при ошибке» (неактивен, когда уведомления выключены);
- webhook: чекбокс включения + поле «URL (Discord/Slack)»;
- подсказка: POST с JSON `{ content, text }`, совместимо с Discord и Slack;
- кнопка «🧪 Тестовое уведомление» (сохраняет настройки и отправляет тест);
- примечание: «ntfy.sh не используется — только webhook».

Все изменения сохраняются автоматически через `save_settings`.

## 6. RPC (`src/rpc.ts`, `src/index.ts`)

- `get_settings` / `save_settings` теперь возвращают и принимают
  `notifications` (вложенная схема `webhook { enabled, url }`).
- Новый метод `test_notification({})` → `{ success, message }`.
- `save_settings` мержит `notifications` через `saveSettings`.

## 7. Сборка и проверки

- `npm run build` — без ошибок.
- `npm run build:gui` — без ошибок, `gui-experimental.cjs` ≈ 65.49 kB
  (gzip ≈ 15.45 kB).
- В собранном GUI присутствуют строки «🔔 Уведомления», «Включить уведомления»,
  «Только при ошибке», «Тестовое уведомление», «ntfy.sh не используется».
- В RPC-схеме есть `test_notification`, `notifications`, `webhook`,
  `onlyOnError`; упоминаний `ntfy` нет.
- Runtime-проверка с временным `APPDATA` и локальным HTTP-сервером:
  - дефолты: выключено / `onlyOnError: true` / webhook выключен;
  - при `onlyOnError: true` успешный запуск не отправляется;
  - ошибка отправляется с точным текстом
    `❌ Задача "Test" упала (2.3s): Quality Gate провален`;
  - при `onlyOnError: false` успех отправляется
    `✅ Задача "Test" выполнена (2.3s)`;
  - главный выключатель блокирует отправку;
  - тестовое уведомление доставляется;
  - недоступный URL не выбрасывает исключение наружу;
  - `record-history.js` записывает историю **и** отправляет webhook
    (сообщение совпадает с форматом).
- Итог проверки: `failures=0`, 4 HTTP-запроса на локальный сервер.

## 8. Ограничения

- **ntfy.sh не реализован** по указанию. Если канал понадобится позже:
  у ntfy.sh лимит **250 сообщений в день на IP**, поэтому для задач с частым
  запуском (каждую минуту) обязателен режим «Только при ошибке».
- Webhook — единственный сетевой канал; при недоступности сети уведомление
  теряется (в историю это не пишется, задача не страдает).
- Уведомления из обёрток отправляются только после записи истории; при
  аварийном завершении процесса до вызова `record-history.js` уведомления не
  будет.
- Тосты работают только при открытом OpenCode и только для ручного запуска
  из GUI; фоновые запуски планировщика видны через webhook.
- Ретраи и цепочки задач не создают отдельных уведомлений — уведомление
  соответствует каждой записи `record-history` (то есть каждому фактическому
  запуску обёртки).
