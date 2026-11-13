# Спринт 22 — Интеграции и наблюдаемость

**Статус:** готово. Все пункты роадмапа реализованы, включая опциональный
экспорт истории в OpenTelemetry-совместимом формате.

## Что сделано

### 1. Входящие webhook-триггеры

`POST /api/hooks/:task?token=<token>` запускает задачу без ожидания cron.
Подходит для GitHub Actions, GitLab CI и любых внешних систем.

- Аутентификация: токен в query-параметре `token` **или** заголовке
  `X-Scheduler-Token` / `X-Gitlab-Token`.
- Подпись: HMAC-SHA256 по **сырому телу** запроса в заголовке
  `X-Scheduler-Signature: sha256=<hex>`. Для совместимости принимаются
  `X-Hub-Signature-256` и `X-Signature-256`, а также «голый» hex.
- Timestamp: необязательный `X-Scheduler-Timestamp` (секунды или миллисекунды).
  Проверка включается настройкой `timestampToleranceSeconds`; `0` — выключена.
- Имя задачи ищется без учёта регистра, в `runTask` передаётся каноническое имя.
- Ответы: `202` — запуск принят (в том числе «уже выполняется»), `400` — нет
  имени задачи или некорректная кодировка пути, `401` — неверный
  токен/подпись/timestamp, `403` — канал выключен или не настроены credentials,
  `404` — задача не найдена, `405` — не POST, `413` — тело больше лимита.

Настройки (в `settings.json`, через `manage_settings` action=`update` или RPC
`save_settings`):

```json
{
  "integrations": {
    "hooks": {
      "enabled": true,
      "token": "…",
      "secret": "…",
      "requireSignature": true,
      "maxBodyBytes": 262144,
      "timestampToleranceSeconds": 300
    }
  }
}
```

При первом включении `enabled: true` с пустыми `token`/`secret` плагин
генерирует их автоматически (24 и 32 случайных байта). Пустые credentials
никогда не логируются.

Пример GitHub Actions:

```yaml
- name: Trigger scheduler
  env:
    HOOK_TOKEN: ${{ secrets.SCHEDULER_HOOK_TOKEN }}
    HOOK_SECRET: ${{ secrets.SCHEDULER_HOOK_SECRET }}
  run: |
    body='{"ref":"'"$GITHUB_REF"'","sha":"'"$GITHUB_SHA"'"}'
    sig=$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$HOOK_SECRET" | sed 's/^.* //')
    curl -fsS -X POST \
      "http://127.0.0.1:3782/api/hooks/deploy?token=$HOOK_TOKEN" \
      -H "Content-Type: application/json" \
      -H "X-Scheduler-Signature: sha256=$sig" \
      --data "$body"
```

Безопасность: сервер слушает только `127.0.0.1`; для внешних CI нужен
туннель/self-hosted runner. Сравнение токена и подписи — timing-safe.
Тело ограничено `maxBodyBytes` (1 КиБ … 5 МиБ, по умолчанию 256 КиБ).

### 2. Structured logs (JSONL)

Все события запусков пишутся в `<PLUGIN_DIR>/logs/runs.jsonl` — по одному
JSON-объекту на строку. Пишутся из единой точки учёта (`db/history-repo.ts`),
поэтому охватывают обычные запуски, матрицы, цепочки и ретраи.

События:

- `run.started` — `runId`, `task`, `status: "running"`, `startedAt`, `workspaceId`;
- `run.finished` — `runId`, `task`, `status`, `startedAt`, `finishedAt`,
  `durationMs`, `error`, `nextTask`, `tokens`, `costUsd`, `model`,
  `preFlightStatus`, `postFlightStatus`;
- `hook.received` — `task`, `status: "accepted" | "rejected"`, `httpStatus`,
  `remote`, `payloadBytes`, `reason`. Токены, подписи и тело не логируются.

Ротация: при достижении 10 МиБ файл переименовывается в `runs.jsonl.1`
(предыдущий архив перезаписывается). Ошибки записи только предупреждают в
консоль и никогда не ломают запуск.

`GET /api/logs` — новые записи сверху:

| Параметр | Значение |
|---|---|
| `task` | имя задачи (без учёта регистра) |
| `status` | `running`, `success`, `error`, `timeout`, `partial`, `accepted`, `rejected` |
| `event` | `run.started`, `run.finished`, `hook.received` |
| `since`, `until` | ISO-дата/время |
| `limit` | 1…5000, по умолчанию 200 |
| `format=jsonl` | скачать отфильтрованные записи файлом |

Ответ: `{ records, total, malformed, limit, filters }`, где `total` считается
до применения `limit`.

### 3. Prometheus

`GET /metrics` отдаёт exposition format 0.0.4 (`text/plain`):

- `opencode_scheduler_info{version,profile,scheduler}`;
- `opencode_scheduler_up`;
- `opencode_scheduler_queue_depth` — незавершённые запуски;
- `opencode_scheduler_history_records`;
- `opencode_scheduler_runs_total{task,status="success|error"}`;
- `opencode_scheduler_errors_total{task}`;
- `opencode_scheduler_tokens_total{task}`;
- `opencode_scheduler_cost_usd_total{task}`;
- `opencode_scheduler_run_duration_seconds` — histogram с бакетами
  1, 5, 15, 30, 60, 120, 300, 600, 1800, 3600 с и `+Inf`, плюс `_sum`/`_count`.

Значения label экранируются по правилам Prometheus. Метрики собираются из
SQLite на каждый scrape; отдельный процесс/агент не нужен.

Пример scrape-конфига:

```yaml
scrape_configs:
  - job_name: opencode-scheduler
    static_configs:
      - targets: ["127.0.0.1:3782"]
```

### 4. OpenTelemetry-экспорт

`GET /api/history/export?format=otlp` возвращает OTLP/JSON:

- `resourceSpans[].resource.attributes` — `service.name`,
  `service.version`, `scheduler.profile`, `scheduler.backend`;
- `scopeSpans[].scope` — `opencode-windows-scheduler`;
- один span на запись истории: имя `<task> run`, `traceId` (32 hex),
  `spanId` (16 hex), `startTimeUnixNano` / `endTimeUnixNano` строками;
- атрибуты `task.name`, `run.id`, `run.status`, `run.duration_ms`,
  `run.tokens`, `run.cost_usd`, `llm.model`, `error.message`, `next.task`,
  `workspace.id`, `pre_flight.status`, `post_flight.status`;
- `status.code`: `1` (OK) для успеха, `2` (ERROR) для неуспешных,
  `0` (UNSET) у незавершённых запусков.

`traceId`/`spanId` детерминированы (sha256 от задачи, времени старта и id),
поэтому повторный экспорт идемпотентен, в том числе после завершения запуска.

## Изменённые файлы

| Файл | Изменение |
|---|---|
| `src/settings.ts` | `integrations.hooks`, нормализация, авто-генерация credentials |
| `src/integrations.ts` | **новый**: HMAC, token, timestamp, чтение тела с лимитом |
| `src/core/structured-log.ts` | **новый**: JSONL append/read/rotation |
| `src/core/prometheus.ts` | **новый**: сборка и рендер метрик |
| `src/core/otel.ts` | **новый**: OTLP/JSON-экспорт |
| `src/db/history-repo.ts` | запись `run.started` / `run.finished` после commit |
| `src/server.ts` | `/api/hooks/:task`, `/api/logs`, `/metrics`, `format=otlp` |
| `src/index.ts` | `integrations` в `manage_settings` и RPC `save_settings` |
| `test-integrations.mjs` | **новый**: 116 проверок |
| `package.json` | тест в цепочке `npm test`, скрипт `test:integrations` |

## Совместимость

- Новые настройки необязательны: старый `settings.json` читается без миграции,
  hooks выключены по умолчанию.
- Экспорт/импорт задач не менялся. `format=json` и `format=csv` работают как
  раньше; `otlp` добавлен отдельным значением.
- Существующие таблицы SQLite не менялись — новые данные живут в JSONL.
- Новых зависимостей нет: только `node:crypto`, `node:fs`, `node:http`.

## Проверки

```bash
npm run build
npm run build:gui
npm test
node test-integrations.mjs
```

`test-integrations.mjs` покрывает настройки и нормализацию, HMAC/token/timestamp,
JSONL-фильтры/битые строки/ротацию, логирование из `startRun`/`finishRun`/
`recordRun`, Prometheus, OTLP, а также реальный HTTP-сервер: 405/401/403/404/413/
202, GitHub/GitLab-заголовки, `/api/logs`, `/metrics`, OTLP-экспорт и health.

## Ограничения

- Webhook — единственный сетевой вход, он не заменяет аутентификацию дашборда
  (дашборд по-прежнему без пароля и слушает только localhost).
- JSONL-лог ротируется по размеру, но не по возрасту; глубокая ретеншн-политика
  остаётся за SQLite-историей.
- OTLP-экспорт отдаёт снимок по запросу, без push-отправки в Collector.
