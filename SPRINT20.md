# Спринт 20 — Уведомления v2

Цель спринта: уведомления становятся управляемыми — шаблоны, фильтры по задачам,
надёжная доставка с повторами, события матриц, детектор зависших клонов и
ежедневный/еженедельный дайджест. По заданию **ntfy.sh не реализуется**:
сетевой канал остаётся один — webhook (Discord/Slack-совместимый), плюс тосты GUI.

## 1. Настройки (`src/settings.ts`)

`NotificationSettings` расширены (все поля опциональны для обратной совместимости):

```ts
interface WebhookNotificationSettings {
  enabled: boolean;
  url: string;
  timeoutMs: number;      // 1000..120000, дефолт 10000
  retryCount: number;     // 0..5, дефолт 2
  retryDelayMs: number;   // 100..60000, дефолт 1000
}

interface NotificationTemplates { success: string; error: string }
interface NotificationFilters { include: string[]; exclude: string[] }

interface MatrixNotificationSettings {
  enabled: boolean;
  onPartial: boolean;
  onAllFailed: boolean;
  stuckAfterMinutes: number; // 0 — выключить
}

interface DigestSettings {
  enabled: boolean;
  frequency: "daily" | "weekly";
  time: string;            // HH:MM
  lastSentAt: string | null;
}
```

`normalizeNotifications` переписан: хелперы `normalizeIntInRange`,
`normalizeDailyTime` (HH:MM), `normalizeNameList`, `asRecord`; значения
зажимаются в диапазоны, битые — заменяются дефолтами. Старый `settings.json`
без новых полей читается без миграции.

## 2. Доставка webhook (`src/notifications.ts`)

- `postOnce` — один POST с `AbortController` и `timeoutMs`; ретраибельные ошибки:
  сеть, таймаут, HTTP 5xx, 429.
- `sendWebhook(url, message, { timeoutMs, retryCount, retryDelayMs, sleep })` —
  `retryCount + 1` попыток, экспоненциальный backoff
  `min(30s, retryDelayMs * 2^attempt)`; прочие 4xx не повторяются.
- `deliver(config, message)` — общая точка отправки, ошибки только логируются.

## 3. Шаблоны и фильтры

- `wildcardMatch(pattern, value)` — регистронезависимая маска `*`.
- `isTaskAllowed(taskName, filters)` — исключения важнее включений; пустой
  `include` = все задачи.
- `renderTemplate(template, vars)` — подстановка `{task}`, `{status}`,
  `{duration}`, `{error}`, `{emoji}`; неизвестные плейсхолдеры остаются как есть.
- `formatNotificationMessage(payload, templates?)` — дефолтные тексты прежние:
  `✅ Задача "X" выполнена (2.3s)` и
  `❌ Задача "X" упала (2.3s): Quality Gate провален`.

## 4. Матрицы и зависшие клоны

- `notifyMatrixCompletion({ parentName, status, total, success, error, message })`
  — успех, `partial` (при `onPartial`) и «все упали» (при `onAllFailed`);
  учитывает `onlyOnError` и фильтры по имени родителя.
- `finalizeMatrixIfComplete` (`src/core/matrix.ts`) вызывает уведомление после
  записи агрегата в историю.
- `findStuckMatrixClones(running, parentByClone, now, thresholdMinutes)` —
  клоны со `started_at` старше порога; `formatStuckMatrixMessage` даёт текст
  `⏳ Матрица "X": клон "Y" выполняется дольше N мин (запущен ISO).`
- В `src/index.ts` детектор `checkStuckMatrices()` работает при старте и раз в
  минуту (`NOTIFICATION_CHECK_MS = 60_000`), дедуплицирует по id записи
  истории (`notifiedStuckRecords`), чистит отметки завершившихся запусков.

## 5. Дайджест

- `buildDigestSummary(records, { frequency, now })` — окно 1 или 7 дней через
  `buildAnalytics`, `topLimit: 5`; поля: `total/success/error/partial`,
  `successRate`, `tokens`, `costUsd`, `topErrors`.
- `formatDigestMessage(summary, now)`:

```
📊 Дайджест за сутки (13.11.2026)
Запусков: 3 — ✅ 1, ❌ 2, ⚠️ 0 (33.3%)
Стоимость: $0.0200 · токенов: 2000
Топ ошибок:
• Quality Gate провален — 2
```

- `isDigestDue(digest, now)` — ежедневно после `digest.time`; еженедельно —
  после времени в понедельник текущей недели (догоняющая отправка в любой
  день недели, если ещё не отправляли). `lastSentAt` хранится в settings.
- `maybeSendDigest()` — плановая отправка (обновляет `lastSentAt`), вызывается
  тем же минутным таймером. `sendDigestNow({ updateLastSentAt: false })` —
  ручная отправка, расписание не сдвигает.

## 6. Ошибки в аналитике (`src/core/analytics.ts`)

`AnalyticsReport` получил `errors: ErrorAnalyticsRow[]` (`{message, count, lastAt}`):
ошибки (статусы кроме `success`/`partial`) агрегируются по тексту (обрезается до
160 символов, пустой — `(без текста)`), сортируются по частоте, затем по тексту,
и обрезаются по `topLimit`. Дайджест использует этот список для «Топ ошибок».

## 7. RPC и GUI

- `get_settings`/`save_settings` принимают и возвращают полную схему уведомлений
  (webhook с таймаутом/повторами, templates, filters, matrix, digest).
- Новый метод `send_digest` → `{ success, message }`.
- GUI, секция «🔔 Уведомления»: поля таймаута/повторов/паузы, фильтры
  include/exclude, шаблоны success/error с подсказкой плейсхолдеров, блок
  «Матрицы» (partial, все упали, порог зависания), блок «Дайджест»
  (вкл/частота/время/последняя отправка) и кнопка «📊 Отправить дайджест сейчас».
  Все контролы гаснут при выключенных уведомлениях.

## 8. Интеграция

- `src/core/record-history.ts` по-прежнему вызывает `notifyTaskCompletion` после
  записи истории — теперь с фильтрами и шаблонами.
- `src/core/matrix.ts` уведомляет о завершении семьи после агрегата.
- `src/index.ts` держит минутный таймер (`notificationTimer`, `unref`,
  очищается в `dispose`) для дайджеста и детектора зависаний; сбой детектора
  логируется и не ломает плагин.

## 9. Тесты

`test-notifications-v2.mjs` — 44 проверки, в цепочке `npm test`:

- маски и фильтры (`wildcardMatch`, `isTaskAllowed`);
- шаблоны и дефолтные тексты, `formatMatrixMessage`, `formatStuckMatrixMessage`;
- `findStuckMatrixClones` (порог 60, порог 0);
- `buildDigestSummary`/`formatDigestMessage` (сутки/неделя, топ ошибок, «Ошибок нет»);
- `isDigestDue` (выкл., битое время, до/после, `lastSentAt`, недельный catch-up);
- дефолты и обратная совместимость `settings.json`;
- `sendWebhook` против локального HTTP-сервера: 500/500/200 → 3 попытки,
  400 → одна попытка и ошибка;
- агрегация `errors` в `buildAnalytics`.

## 10. Сборка и проверки

- `npm run build` — без ошибок.
- `npm run build:gui` — без ошибок, `gui-experimental.cjs` ≈ 133.88 kB
  (gzip ≈ 29.50 kB).
- `npm test` — 15 секций, зелёный; `test-notifications-v2.mjs` 44/44.
- `node test-docs.mjs` — 30/30.

## 11. Ограничения

- **ntfy.sh не реализован** по заданию. Сетевой канал один — webhook; при
  недоступности сети уведомление теряется (в историю не пишется).
- **Дайджест требует включённого webhook**: без `webhook.enabled` и URL
  `send_digest`/`maybeSendDigest` возвращают ошибку/`false`.
- **Еженедельный дайджест — догоняющий**: если плагин не работал в понедельник,
  отправка произойдёт в первый подходящий день после целевого времени.
- **Детектор зависших клонов только для матриц**: обычные задачи не проверяются;
  порог `stuckAfterMinutes = 0` выключает детектор.
- **Дедупликация зависаний — в памяти**: после перезапуска плагина уведомление
  о всё ещё висящем клоне придёт повторно.
- **Ретраи ограничены** `retryCount` (0..5) и backoff до 30 с; очень долгие
  сетевые сбои не переживаются — уведомление теряется.
- **Тосты — только для ручных запусков из GUI**; фоновые запуски видны через
  webhook и дашборд.
