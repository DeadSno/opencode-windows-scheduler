# Спринт 21 — Мультипроектность

Цель спринта: профили с изоляцией БД/настроек/порта дашборда, переключение
профиля, env-переменные на workspace (парами или через `.env`-файл) с
маскировкой секретов в логах, плюс тесты `test-profiles.mjs` и `test-env.mjs`.

## 1. Профили (`src/profiles.ts`)

Каждый профиль — своя директория со своей SQLite-БД, настройками, логами,
обёртками и блокировками.

- Профиль `default` использует базовую директорию плагина (как раньше — без
  миграции). Именованные профили живут в `<base>/profiles/<name>`.
- `getProfileName()` — `OPENCODE_SCHEDULER_PROFILE` > файл `active-profile` >
  `default`. Имя нормализуется: нижний регистр, только `[a-z0-9_-]`, до 40
  символов, пустое → `default`.
- `getProfileDir(name)` — базовая директория для `default`,
  `base/profiles/<name>` для остальных. `PLUGIN_DIR` (и由此 `LOCK_DIR`,
  `LOG_DIR`, `WRAPPER_DIR`, `scheduler.db`, `settings.json`) вычисляется через
  `getProfileDir(getProfileName())`, поэтому всё становится per-profile
  автоматически.
- `getProfilePort()` — `OPENCODE_SCHEDULER_PORT` > порт из `profile.json` >
  `null` (сервер берёт дефолт 3782 → 4782 → 5782).
- `listProfiles()` — `default` + найденные поддиректории `profiles/` с метаданными.
- `createProfile(name, port?)` — валидация имени, создание директории,
  `profile.json`. `deleteProfile(name)` — `default` удалить нельзя, при удалении
  активного профиля маркер сбрасывается на `default`.
- `setActiveProfile(name)` — пишет маркер `active-profile`; вступает в силу после
  перезапуска OpenCode. `isProfilePinnedByEnv()` — true, если задан env-var.

## 2. Порт дашборда (`src/server.ts`)

Предпочитаемый порт сервера: `ports?.preferred ?? getProfilePort(getProfileName()) ??
PREFERRED_PORT` (3782). Запасные — 4782, 5782, затем порт 0 (ОС). В заголовок
дашборда добавлена строка «профиль <name>»; `/api/health` возвращает
`profile: getProfileName()`.

## 3. Env-переменные workspace (`src/workspaces.ts`)

Workspace получил поля `env?: Record<string, string>` и `envFile?: string`,
хранящиеся в колонках `workspaces.env_json` / `workspaces.env_file` (добавлены
через guarded `ALTER TABLE`, обратная совместимость сохранена).

- `env` — пары `KEY=VALUE`, хранятся как JSON; `envFile` — путь к `.env`-файлу.
- `resolveWorkspaceEnv(workspace)` — сначала переменные из файла, затем явные
  пары (пары важнее файла). Файл парсит `parseEnvFileContent`: строки
  `KEY=value`, комментарии `#`, пустые строки, префикс `export `, значения в
  совпадающих кавычках освобождаются.
- `normalizeWorkspaceEnv` — ключи по `^[A-Za-z_][A-Za-z0-9_]*$`, значения
  строками, максимум 100 пар, понятные ошибки на русском.
- `maskEnvForLog(env)` — значения ключей, совпадающих с
  `/(TOKEN|SECRET|PASS|PASSWORD|KEY|CREDENTIAL|AUTH)/i`, заменяются на `***`
  в логах и ответах RPC.
- `writeWorkspaceEnvFile(workspace, pluginDir, sanitized)` — пишет
  `<pluginDir>/env/<sanitized>.env` настоящими значениями, `mkdir` рекурсивно,
  права `0o600` на POSIX, удаляет stale-файл, возвращает `undefined`, если env
  пуст.

Доставка в запуск: при создании/обновлении задачи с workspace и непустым env
плагин пишет env-файл и передаёт путь обёртке:
- Windows: `.cmd` добавляет `-EnvFile "<path>"`; `WRAPPER_SCRIPT` парсит файл
  в `env:` перед `opencode run` (значения не логируются).
- POSIX (bash): `ENV_FILE=`, блок
  `if [ -n "$ENV_FILE" ] && [ -f "$ENV_FILE" ]; then ... export ...; fi`
  перед запуском `opencode run`.

При обновлении workspace env-файлы перегенерируются для всех задач этого
workspace (`refreshWorkspaceEnvFiles`). Клоны матрицы наследуют env через свой
`workspaceId`.

## 4. RPC и индекс

Новые методы после `delete_workspace`:

- `get_profiles` → `{ current, pinnedByEnv, profiles: ProfileInfo[] }`
  (`name, dir, port, isDefault, active`).
- `set_profile { name }` → `setActiveProfile`, `{ success, message, current,
  restartRequired: true }` с подсказкой о перезапуске (особое сообщение, если
  профиль закреплён env-var).
- `create_profile { name, port? }` → `createProfile`.
- `delete_profile { name }` → `deleteProfile`.

`manage_workspaces` add/update принимают `env` (объект строк, nullable) и
`envFile` (строка|null). `get_workspaces`/`add_workspace`/`update_workspace`
маскируют env через `maskEnvForLog` в ответах.

## 5. GUI (`src/gui.tsx`)

- Заголовок панели: чип профиля `👤 <name>` (+ 🔒 если закреплён env).
- Панель профилей: список с портом, директорией, активной меткой, кнопки
  «Переключить» / «Удалить», «+ Создать», примечание о необходимости перезапуска.
- Строка workspace: чип счётчика env-переменных (`env: N перем.` / `.env-файл`),
  кнопка 🔑 открывает редактор env (textarea `KEY=VALUE` + путь к файлу),
  подсказка о маскировке секретов.
- `loadProfilesGui()` вызывается после `loadWorkspacesGui()`.

## 6. Тесты

`test-profiles.mjs` — 58 проверок:

- `OPENCODE_SCHEDULER_HOME` / `OPENCODE_SCHEDULER_PROFILE` задаются ДО
  динамического `await import("./dist/...")` (паттерн `test-notifications-v2.mjs`);
- default-директория = база, именованный профиль = `base/profiles/<name>`;
- `sanitizeProfileName` / `validateProfileName` (имя с буквы, латиница,
  цифры, `-`, `_`, до 40 символов);
- переключение маркера `active-profile`; порт `env` > `profile.json` > `null`;
- `createProfile` / `listProfiles` / `deleteProfile` (запрет на `default`);
- изоляция БД и `settings.json` профилей (подпроцессы с разными `HOME`/`PROFILE`);
- `isProfilePinnedByEnv`.

`test-env.mjs` — 53 проверки:

- `parseEnvFileContent`: комментарии, кавычки, `export `, игнорируемые ключи;
- `resolveWorkspaceEnv`: файл ثم explicit pairs (пары важнее);
- `normalizeWorkspaceEnv`: ошибки на не-объект, >100 пар, плохие ключи,
  нестроковые значения;
- `maskEnvForLog`: маскирует `TOKEN`/`SECRET`/`PASS`/`PASSWORD`/`KEY`/
  `CREDENTIAL`/`AUTH`, обычные ключи открыты;
- `writeWorkspaceEnvFile`: содержимое `KEY=value`, права `0o600` (POSIX),
  очистка старых файлов;
- DB round-trip: `addWorkspace`/`updateWorkspace`/`getWorkspace` с env +
  `envFile`.

Всего в цепочке `npm test`: 17 секций, 500+ проверок.

## 7. Сборка и проверки

- `npm run build` — без ошибок (tsc).
- `npm run build:gui` — без ошибок, `gui-experimental.cjs` ≈ 143.76 kB
  (gzip ≈ 31.77 kB).
- `npm test` — 17 секций, зелёный;
  `test-profiles.mjs` 58/58, `test-env.mjs` 53/53.
- `node test-docs.mjs` — зелёный.

## 8. Ограничения

- Профиль выбирается env-var или файлом-маркером и требует **перезапуска
  OpenCode**, так как директории плагина вычисляются при загрузке модуля.
- Env-файлы лежат в каталоге профиля в виде plaintext с настоящими значениями;
  секреты маскируются **только в логах и ответах RPC**, файл сам не зашифрован.
- Env не влияет на оценки dry-run (проверка без запуска).
- Порт профиля берётся из `profile.json` (или env-var); дефолтная цепочка
  3782 → 4782 → 5782 сохранена.
- `default` профиль удалить нельзя.
- gui.tsx исключён из tsc, собирается через `npm run build:gui`; изменения в
  GUI покрываются только визуально/при сборке vite.
- Нет новых зависимостей; Node 24, full-icu.
