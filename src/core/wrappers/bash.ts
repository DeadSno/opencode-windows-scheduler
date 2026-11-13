import fs from "node:fs/promises";
import path from "node:path";
import { WRAPPER_DIR } from "../../types.js";
import { shellQuote } from "../scheduler/posix.js";
import type { ScheduleGateSpec } from "../schedule-v2.js";

/** Параметры генерации bash-обёртки. */
export interface BashWrapperOptions {
  /** Безопасное имя для файла (латиница, цифры, -, _). */
  sanitizedName: string;
  /** Отображаемое имя задачи (может быть кириллицей). */
  taskName: string;
  /** Абсолютный путь к файлу с промптом. */
  promptFile: string;
  /** Таймаут в секундах (0 — без таймаута). */
  timeoutSeconds: number;
  /** Абсолютный путь к lock-файлу (рядом создаётся каталог <lock>.d). */
  lockFile: string;
  /** Рабочая директория задачи. */
  workdir?: string;
  /** Имя multi-repo workspace (для git-контекста в логе). */
  workspaceName?: string;
  /** Разрешённые инструменты (спринт 14, metadata-only). */
  allowedTools?: string[];
  /** Запрещённые инструменты (спринт 14, metadata-only). */
  deniedTools?: string[];
  /** Путь к файлу лога. */
  logFile?: string;
  /** Путь к скомпилированному record-history.js. */
  recorderFile?: string;
  /** Проверочная команда Quality Gate. */
  qualityGate?: string;
  /** LLM-модель для `opencode run --model` (если не задана — модель по умолчанию). */
  model?: string;
  /** Pre-flight команда: ненулевой код отменяет запуск задачи. */
  beforeScript?: string;
  /** Post-flight команда: выполняется даже при ошибке основной задачи. */
  afterScript?: string;
  /**
   * Команда самоочистки one-shot (например, выгрузка launchd-агента).
   * Запускается в фоне после записи истории и не влияет на код возврата.
   */
  oneShotCleanupCommand?: string;
  /**
   * Гейт расписания (спринт 19): проверка cron в таймзоне задачи и окна
   * запуска выполняется до lock и запуска opencode.
   */
  scheduleGate?: ScheduleGateSpec & {
    gateFile: string;
    deferFile?: string;
    forceFile?: string;
  };
  /**
   * Спринт 21: путь к env-файлу workspace (пары KEY=VALUE). Значения
   * подгружаются перед запуском opencode и никогда не пишутся в лог.
   */
  envFile?: string;
}

/**
 * Собирает текст bash-обёртки.
 *
 * Скрипт:
 *  1. выставляет PATH (важно для cron, где окружение минимальное);
 *  2. берёт атомарный lock через `mkdir` (аналог 'wx' в Node);
 *  3. переходит в рабочую директорию проекта;
 *  4. выполняет pre-flight (если задан) — при ошибке задача отменяется;
 *  5. запускает `opencode run <промпт>` с перенаправлением вывода в лог;
 *  6. по таймауту завершает процесс;
 *  7. выполняет Quality Gate (если задан);
 *  8. выполняет post-flight (если задан) — даже при ошибке задачи;
 *  9. пишет историю/метрики через `node record-history.js`.
 *
 * Если задана модель, вызов превращается в `opencode run --model "<model>" <промпт>`.
 */
export function buildBashWrapperScript(options: BashWrapperOptions): string {
  const {
    taskName,
    promptFile,
    timeoutSeconds,
    lockFile,
    workdir,
    workspaceName,
    logFile,
    recorderFile,
    qualityGate,
    model,
    beforeScript,
    afterScript,
    oneShotCleanupCommand,
    allowedTools,
    deniedTools,
    scheduleGate,
    envFile,
  } = options;

  const lines: string[] = [
    "#!/usr/bin/env bash",
    "# Сгенерировано opencode-windows-scheduler. Не редактируйте вручную:",
    "# файл перезаписывается при каждом обновлении задачи.",
    "set -u",
    "",
    `TASK_NAME=${shellQuote(taskName)}`,
    `PROMPT_FILE=${shellQuote(promptFile)}`,
    `LOG_FILE=${shellQuote(logFile ?? path.join(WRAPPER_DIR, "task.log"))}`,
    `LOCK_FILE=${shellQuote(lockFile)}`,
    `WORKDIR=${shellQuote(workdir || process.cwd())}`,
    `WORKSPACE_NAME=${shellQuote(workspaceName ?? "")}`,
    `TIMEOUT_SECONDS=${Number.isFinite(timeoutSeconds) ? Math.max(0, Math.floor(timeoutSeconds)) : 3600}`,
    `RECORDER_FILE=${shellQuote(recorderFile ?? "")}`,
    `QUALITY_GATE=${shellQuote(qualityGate ?? "")}`,
    `MODEL=${shellQuote(model ?? "")}`,
    `BEFORE_SCRIPT=${shellQuote(beforeScript ?? "")}`,
    `AFTER_SCRIPT=${shellQuote(afterScript ?? "")}`,
    `ALLOWED_TOOLS=${shellQuote((allowedTools ?? []).join(","))}`,
    `DENIED_TOOLS=${shellQuote((deniedTools ?? []).join(","))}`,
    `SCHEDULE_GATE_FILE=${shellQuote(scheduleGate?.gateFile ?? "")}`,
    `SCHEDULE_CRON=${shellQuote(scheduleGate?.cron ?? "")}`,
    `SCHEDULE_TZ=${shellQuote(scheduleGate?.tz ?? "")}`,
    `SCHEDULE_NOT_BEFORE=${shellQuote(scheduleGate?.notBefore ?? "")}`,
    `SCHEDULE_NOT_AFTER=${shellQuote(scheduleGate?.notAfter ?? "")}`,
    `SCHEDULE_DEFER_FILE=${shellQuote(scheduleGate?.deferFile ?? "")}`,
    `SCHEDULE_FORCE_FILE=${shellQuote(scheduleGate?.forceFile ?? "")}`,
    `ENV_FILE=${shellQuote(envFile ?? "")}`,
    "",
    "# cron запускает задачи с минимальным PATH — добавляем типовые каталоги.",
    'export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$HOME/.bun/bin:$PATH"',
    "",
    'mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || true',
    "",
    "log() {",
    '  printf \'[%s] %s\\n\' "$(date \'+%Y-%m-%d %H:%M:%S\')" "$*" >> "$LOG_FILE" 2>/dev/null || true',
    "}",
    "",
    "# Спринт 19: гейт расписания — до lock, чтобы ожидание окна не держало блокировку.",
    'if [ -n "$SCHEDULE_GATE_FILE" ]; then',
    '  SCHED_GATE_ARGS=()',
    '  [ -n "$SCHEDULE_CRON" ] && SCHED_GATE_ARGS+=(--cron "$SCHEDULE_CRON")',
    '  [ -n "$SCHEDULE_TZ" ] && SCHED_GATE_ARGS+=(--tz "$SCHEDULE_TZ")',
    '  [ -n "$SCHEDULE_NOT_BEFORE" ] && SCHED_GATE_ARGS+=(--not-before "$SCHEDULE_NOT_BEFORE")',
    '  [ -n "$SCHEDULE_NOT_AFTER" ] && SCHED_GATE_ARGS+=(--not-after "$SCHEDULE_NOT_AFTER")',
    '  [ -n "$SCHEDULE_DEFER_FILE" ] && SCHED_GATE_ARGS+=(--defer-file "$SCHEDULE_DEFER_FILE")',
    '  [ -n "$SCHEDULE_FORCE_FILE" ] && SCHED_GATE_ARGS+=(--force-file "$SCHEDULE_FORCE_FILE")',
    '  if ! command -v node >/dev/null 2>&1; then',
    '    log "[scheduler] Гейт расписания пропущен: node не найден в PATH."',
    "  else",
    '    node "$SCHEDULE_GATE_FILE" "${SCHED_GATE_ARGS[@]}" >> "$LOG_FILE" 2>&1',
    "    SCHED_GATE_CODE=$?",
    '    if [ "$SCHED_GATE_CODE" -eq 3 ]; then',
    '      log "[scheduler] Гейт расписания: запуск не требуется (cron/окно). Перенос или пропуск тика."',
    "      exit 0",
    "    fi",
    "  fi",
    "fi",
    "",
    "# Атомарная блокировка: mkdir завершается ошибкой, если каталог уже есть.",
    'if ! mkdir "$LOCK_FILE.d" 2>/dev/null; then',
    '  log "[scheduler] Задача \'$TASK_NAME\' уже выполняется — пропуск запуска."',
    "  exit 0",
    "fi",
    'cleanup() { rmdir "$LOCK_FILE.d" 2>/dev/null || rm -rf "$LOCK_FILE.d" 2>/dev/null; }',
    "trap cleanup EXIT INT TERM",
    "",
    'if [ -n "$WORKDIR" ] && [ -d "$WORKDIR" ]; then',
    '  cd "$WORKDIR" || { log "[scheduler] Не удалось перейти в $WORKDIR"; exit 1; }',
    "fi",
    "",
    "# Спринт 21: env-переменные workspace. Файл пишет плагин, значения не логируются.",
    'if [ -n "$ENV_FILE" ] && [ -f "$ENV_FILE" ]; then',
    '  while IFS= read -r env_line || [ -n "$env_line" ]; do',
    "    env_line=\"${env_line%$'\\r'}\"",
    "    case \"$env_line\" in ''|'#'*) continue ;; esac",
    '    env_key="${env_line%%=*}"',
    '    env_value="${env_line#*=}"',
    '    case "$env_key" in *[!A-Za-z0-9_]*) continue ;; esac',
    '    case "$env_key" in [A-Za-z_]*) ;; *) continue ;; esac',
    '    export "$env_key=$env_value"',
    '  done < "$ENV_FILE"',
    '  log "[scheduler] Переменные окружения workspace загружены."',
    "fi",
    "",
    'if [ -n "$WORKSPACE_NAME" ]; then',
    '  GIT_BRANCH="$(git -C "$WORKDIR" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"',
    '  GIT_REMOTE="$(git -C "$WORKDIR" remote get-url origin 2>/dev/null || true)"',
    '  [ -n "$GIT_BRANCH" ] || GIT_BRANCH="-"',
    '  [ -n "$GIT_REMOTE" ] || GIT_REMOTE="-"',
    '  log "[workspace] name=$WORKSPACE_NAME, cwd=$WORKDIR, branch=$GIT_BRANCH, remote=$GIT_REMOTE"',
    "fi",
    "",
    "# Role-scoped tools: ограничения фиксируются в логе. Позиция metadata-only:",
    "# opencode 2.2.3 не поддерживает allow/deny флаги, поэтому запрет мы лишь",
    "# логируем и предупреждаем, но не блокируем.",
    'if [ -n "$ALLOWED_TOOLS" ] || [ -n "$DENIED_TOOLS" ]; then',
    '  log "[role-scoped] allowed=[$ALLOWED_TOOLS], denied=[$DENIED_TOOLS]"',
    '  case ",$DENIED_TOOLS," in',
    '  *",write,"*|*",edit,"*|*",bash,"*|*",apply_patch,"*|*",remove,"*)',
    '    log "[role-scoped] ВНИМАНИЕ: deniedTools содержит опасные инструменты ($DENIED_TOOLS). Запрет не может быть применён автоматически (metadata-only), проверьте промпт задачи."',
    "    ;;",
    "  esac",
    "fi",
    "",
    'if ! command -v opencode >/dev/null 2>&1; then',
    '  log "[scheduler] ОШИБКА: opencode не найден в PATH ($PATH)."',
    "  exit 127",
    "fi",
    "",
    'PROMPT="$(cat "$PROMPT_FILE" 2>/dev/null || true)"',
    'START_EPOCH="$(date +%s)"',
    'STARTED_AT="$(date -u \'+%Y-%m-%dT%H:%M:%SZ\')"',
    'EXIT_CODE=0',
    'ERROR_MESSAGE=""',
    'PRE_FLIGHT_STATUS="skipped"',
    'POST_FLIGHT_STATUS="skipped"',
    'SKIP_MAIN=0',
    "",
    `log "[scheduler] Запуск задачи '$TASK_NAME'..."`,
    "",
    "# Crash recovery: фиксируем начало до pre-flight. Если процесс убьют,",
    "# останется finished_at = NULL и recovery при следующем старте пометит error.",
    'RUN_ID=""',
    'if [ -n "$RECORDER_FILE" ] && command -v node >/dev/null 2>&1; then',
    '  RUN_ID="$(node "$RECORDER_FILE" --start "$TASK_NAME" "$STARTED_AT" 2>> "$LOG_FILE" | tail -n 1)"',
    "fi",
    "",
    "# Pre-flight: выполняется до основной задачи. Ненулевой код отменяет запуск.",
    'if [ -n "$BEFORE_SCRIPT" ]; then',
    '  log "[scheduler] Pre-flight: $BEFORE_SCRIPT"',
    '  bash -lc "$BEFORE_SCRIPT" >> "$LOG_FILE" 2>&1',
    "  PRE_CODE=$?",
    '  if [ "$PRE_CODE" -ne 0 ]; then',
    '    log "[scheduler] ОШИБКА: Pre-flight script failed (код $PRE_CODE)."',
    '    PRE_FLIGHT_STATUS="error"',
    '    ERROR_MESSAGE="Pre-flight script failed"',
    "    EXIT_CODE=1",
    "    SKIP_MAIN=1",
    "  else",
    '    PRE_FLIGHT_STATUS="success"',
    '    log "[scheduler] Pre-flight успешно завершён."',
    "  fi",
    "fi",
    "",
    'if [ "$SKIP_MAIN" -eq 0 ]; then',
    "",
    "# Модель указывается только если задана — иначе OpenCode берёт свою по умолчанию.",
    "run_opencode() {",
    '  if [ -n "$MODEL" ]; then',
    '    opencode run --model "$MODEL" "$PROMPT"',
    "  else",
    '    opencode run "$PROMPT"',
    "  fi",
    "}",
    "",
    'if [ "$TIMEOUT_SECONDS" -gt 0 ] 2>/dev/null; then',
    '  run_opencode >> "$LOG_FILE" 2>&1 &',
    "  CHILD=$!",
    '  ( sleep "$TIMEOUT_SECONDS"; kill -TERM "$CHILD" 2>/dev/null; sleep 5; kill -KILL "$CHILD" 2>/dev/null ) &',
    "  WATCHDOG=$!",
    '  wait "$CHILD"',
    "  EXIT_CODE=$?",
    '  kill "$WATCHDOG" 2>/dev/null || true',
    '  wait "$WATCHDOG" 2>/dev/null || true',
    "else",
    '  run_opencode >> "$LOG_FILE" 2>&1',
    "  EXIT_CODE=$?",
    "fi",
    "",
    'if [ "$EXIT_CODE" -ne 0 ]; then',
    '  log "[scheduler] Задача \'$TASK_NAME\' завершилась с кодом $EXIT_CODE."',
    '  ERROR_MESSAGE="Код возврата $EXIT_CODE"',
    "else",
    '  log "[scheduler] Задача \'$TASK_NAME\' успешно завершена."',
    "fi",
    "",
    'if [ -n "$QUALITY_GATE" ] && [ "$EXIT_CODE" -eq 0 ]; then',
    '  log "[scheduler] Запуск Quality Gate: $QUALITY_GATE"',
    '  bash -lc "$QUALITY_GATE" >> "$LOG_FILE" 2>&1',
    "  GATE_CODE=$?",
    '  if [ "$GATE_CODE" -ne 0 ]; then',
    '    log "[scheduler] ОШИБКА: Quality Gate провален. Код возврата: $GATE_CODE"',
    '    ERROR_MESSAGE="Quality Gate провален. Код возврата: $GATE_CODE"',
    "    EXIT_CODE=1",
    "  else",
    '    log "[scheduler] Quality Gate пройден."',
    "  fi",
    "fi",
    "",
    "fi # конец блока основной задачи",
    "",
    "# Post-flight: выполняется ВСЕГДА, даже если основная задача упала.",
    'if [ -n "$AFTER_SCRIPT" ]; then',
    '  log "[scheduler] Post-flight: $AFTER_SCRIPT"',
    '  bash -lc "$AFTER_SCRIPT" >> "$LOG_FILE" 2>&1',
    "  POST_CODE=$?",
    '  if [ "$POST_CODE" -ne 0 ]; then',
    '    log "[scheduler] ОШИБКА: Post-flight script failed (код $POST_CODE)."',
    '    POST_FLIGHT_STATUS="error"',
    '    if [ "$EXIT_CODE" -eq 0 ]; then',
    '      ERROR_MESSAGE="Post-flight script failed"',
    "      EXIT_CODE=1",
    "    fi",
    "  else",
    '    POST_FLIGHT_STATUS="success"',
    '    log "[scheduler] Post-flight успешно завершён."',
    "  fi",
    "fi",
    "",
    'END_EPOCH="$(date +%s)"',
    'DURATION_MS=$(( (END_EPOCH - START_EPOCH) * 1000 ))',
    'STATUS="error"',
    'if [ "$EXIT_CODE" -eq 0 ]; then STATUS="success"; fi',
    "",
    'if [ -n "$RECORDER_FILE" ] && command -v node >/dev/null 2>&1; then',
    '  if [ -n "$RUN_ID" ]; then',
    '    node "$RECORDER_FILE" --finish "$RUN_ID" "$TASK_NAME" "$STATUS" "$DURATION_MS" "$ERROR_MESSAGE" "-" "-" "$MODEL" "$PRE_FLIGHT_STATUS" "$POST_FLIGHT_STATUS" >> "$LOG_FILE" 2>&1 || true',
    "  else",
    '    node "$RECORDER_FILE" "$TASK_NAME" "$STATUS" "$STARTED_AT" "$DURATION_MS" "$ERROR_MESSAGE" "-" "-" "$MODEL" "$PRE_FLIGHT_STATUS" "$POST_FLIGHT_STATUS" >> "$LOG_FILE" 2>&1 || true',
    "  fi",
    "fi",
    "",
    // One-shot: снимаем задание с расписания после единственного запуска.
    // История уже записана, поэтому фоновая очистка не влияет на результат.
    ...(oneShotCleanupCommand
      ? [
          `(sleep 2; ${oneShotCleanupCommand}) >/dev/null 2>&1 &`,
          "",
        ]
      : []),
    'exit "$EXIT_CODE"',
    "",
  ];

  return lines.join("\n");
}

/**
 * Записывает per-task bash-обёртку и делает её исполняемой.
 * Возвращает абсолютный путь к .sh-файлу.
 */
export async function writeBashWrapper(
  options: BashWrapperOptions
): Promise<string> {
  await fs.mkdir(WRAPPER_DIR, { recursive: true });
  const scriptPath = path.join(
    WRAPPER_DIR,
    `run-${options.sanitizedName}.sh`
  );
  const script = buildBashWrapperScript(options);
  await fs.writeFile(scriptPath, script, "utf8");
  await fs.chmod(scriptPath, 0o755);
  return scriptPath;
}

/** Путь к bash-обёртке задачи (для диагностики/тестов). */
export function bashWrapperPath(sanitizedName: string): string {
  return path.join(WRAPPER_DIR, `run-${sanitizedName}.sh`);
}
