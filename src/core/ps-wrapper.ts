import fs from "node:fs/promises";
import path from "node:path";
import { PLUGIN_DIR, LOG_DIR, WRAPPER_DIR } from "../types.js";
import type { ScheduleGateSpec } from "./schedule-v2.js";

/**
 * Путь к единому generic-обёртке PowerShell, которая реализует запуск opencode run
 * с таймаутом и lock-логикой.
 */
const WRAPPER_FILENAME = "run-task.ps1";

/**
 * Текст PowerShell-обёртки.
 *
 * Параметры:
 *   TaskName       — имя задачи (для логов)
 *   PromptFile     — путь к файлу с промптом (читается через Get-Content -Raw)
 *   TimeoutSeconds — таймаут в секундах
 *   Model          — LLM-модель для `opencode run --model` (опционально)
 *   Workdir        — рабочая директория (опционально)
 *   WorkspaceName  — имя multi-repo workspace для git-контекста в логе
 *   LockFile       — путь к lock-файлу (удаляется в finally)
 *   BeforeScript   — pre-flight команда (ненулевой код отменяет задачу)
 *   AfterScript    — post-flight команда (выполняется даже при ошибке)
 *
 * Логика:
 *   1. Выполняет pre-flight (если задан); при ошибке задача не запускается.
 *   2. Читает промпт из файла.
 *   3. Запускает opencode run <промпт> через Start-Process (без окна консоли).
 *   4. Ждёт завершения с таймаутом.
 *   5. При таймауте — убивает процесс и дочерние процессы.
 *   6. В finally выполняет post-flight и удаляет lock-файл.
 */
export const WRAPPER_SCRIPT = `param(
    [string]$TaskName,
    [string]$PromptFile,
    [int]$TimeoutSeconds,
    [string]$Model,
    [string]$Workdir,
    [string]$WorkspaceName,
    [string]$AllowedTools,
    [string]$DeniedTools,
    [string]$LockFile,
    [string]$LogFile,
    [string]$RecorderFile,
    [string]$QualityGate,
    [string]$BeforeScript,
    [string]$AfterScript,
    [string]$EnvFile
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$ErrorActionPreference = "Continue"

function Write-Log {
    param([string]$Message)
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $line = "[$timestamp] $Message"
    if ($LogFile) {
        try {
            Add-Content -Path $LogFile -Value $line -Encoding utf8
        } catch {}
    }
    Write-Host $line
}

# Гарантируем существование папки для лога (на случай прямого вызова обёртки).
if ($LogFile) {
    try {
        $logDir = Split-Path -Parent $LogFile
        if ($logDir -and -not (Test-Path $logDir)) {
            New-Item -ItemType Directory -Force -Path $logDir | Out-Null
        }
    } catch {}
}

Write-Log "[windows-scheduler] Запуск задачи '$TaskName'..."

$startTime = Get-Date
$script:exitCode = 0
$script:errorMessage = ""
$script:preFlightStatus = "skipped"
$script:postFlightStatus = "skipped"
$script:skipMainTask = $false
$startedAtIso = $startTime.ToUniversalTime().ToString("o")
$script:runId = ""

# Crash recovery: фиксируем начало ДО pre-flight и основной задачи.
# Если процесс убьют (таймаут/KILL/перезагрузка), останется finished_at = NULL,
# и при следующем старте плагина recovery пометит запись как error.
if ($RecorderFile) {
    try {
        $startOutput = & node "$RecorderFile" --start "$TaskName" "$startedAtIso" 2>$null
        if ($LASTEXITCODE -eq 0) {
            $candidate = @($startOutput) | Select-Object -Last 1
            if ($candidate) { $script:runId = "$candidate".Trim() }
        }
    } catch {}
}

# Выполняет команду оболочки и построчно пишет её вывод в лог.
function Invoke-HookScript {
    param([string]$Command)
    $output = & cmd.exe /c $Command 2>&1
    $code = $LASTEXITCODE
    foreach ($line in @($output)) {
        Write-Log "[hook] $line"
    }
    return $code
}

# Фильтр технического шума и служебных блоков OpenCode.
# Строки ответа ИИ проходят без изменений.
#
# В TS-шаблоне обратные слэши удвоены, иначе JS съедает \s и regex ломается.
$esc = [char]27
$script:inServiceBlock = $false
$script:inComment = $false

$serviceOpen = '<\\s*(?:dcp-)?system[-_](?:reminder|update)\\b[^>]*>'
$serviceClose = '<\\s*/\\s*(?:dcp-)?system[-_](?:reminder|update)\\s*>'
$serviceTag = '<\\s*/?\\s*(?:dcp-)?system[-_](?:reminder|update)\\b[^>]*>'

function Format-LogLine {
    param($Line)
    $text = "$Line"

    # ANSI-последовательности (цвета, управление курсором), например ESC[0m.
    $text = $text -replace "$esc\\[[0-9;?]*[A-Za-z]", ""

    # Служебные блоки, целиком уместившиеся в одной строке.
    $text = [regex]::Replace($text, "$serviceOpen.*?$serviceClose", "", "IgnoreCase")
    $text = [regex]::Replace($text, '<!--.*?-->', "", "IgnoreCase")

    # Начало многострочного служебного блока OpenCode:
    # <dcp-system-reminder> ... </dcp-system-reminder> (и <system-reminder>).
    # Блоком считаем только тег в начале строки: одиночный тег внутри текста
    # (например, ИИ упомянул его в объяснении) не должен съедать следующие строки.
    if ($text -match "^\\s*$serviceOpen") { $script:inServiceBlock = $true }
    if ($text -match '^\\s*<!--') { $script:inComment = $true }

    if ($script:inServiceBlock -or $script:inComment) {
        $closed = $false
        if ($script:inServiceBlock -and $text -match $serviceClose) {
            $script:inServiceBlock = $false
            $closed = $true
        }
        if ($script:inComment -and $text -match '-->') {
            $script:inComment = $false
            $closed = $true
        }

        if ($closed) {
            # Блок закончился в этой строке — сохраняем только хвост после тега.
            $text = ($text -split '-->|<\\s*/\\s*(?:dcp-)?system[-_](?:reminder|update)\\s*>')[-1]
        } else {
            # Внутри служебного блока — строку не пишем.
            return
        }
    }

    # Одиночные теги, оставшиеся после вывода ИИ.
    $text = [regex]::Replace($text, $serviceTag, "", "IgnoreCase")
    $text = $text.TrimEnd()

    # Технический шум вложенного powershell.exe.
    if ($text -match "NativeCommandError|CategoryInfo|FullyQualifiedErrorId|RemoteException") { return }
    if ($text -match "^At [A-Za-z]:.*:") { return }
    if ($text -match "^\\s*\\+\\s*~+\\s*$") { return }
    if (-not $text.Trim()) { return }

    return $text
}

/**
 * Пытается вытащить из лога задачи информацию о расходе токенов и стоимости.
 * OpenCode может печатать строки вида "Tokens: 1234", "Usage: 1234 tokens",
 * "cost: $0.012" и т.п. Если данные не найдены — возвращает пустые строки,
 * чтобы recorder записал поля как отсутствующие.
 */
function Get-UsageFromLog {
    param([string]$File)

    $result = @{ Tokens = ""; Cost = "" }
    if (-not $File) { return $result }

    $tail = @()
    try {
        if (Test-Path $File) {
            $tail = Get-Content -Path $File -Tail 500 -Encoding UTF8 -ErrorAction SilentlyContinue
        }
    } catch { return $result }
    if (-not $tail) { return $result }

    $tokenPatterns = @(
        '(?i)tokens?\\s*[:=]\\s*([0-9]+(?:[.,][0-9]+)?)\\s*([kKmM])?',
        '(?i)(?:input|output|total)\\s+tokens?\\s*[:=]?\\s*([0-9]+(?:[.,][0-9]+)?)\\s*([kKmM])?',
        '(?i)usage[^\\r\\n]*?([0-9]+)\\s+tokens?'
    )
    $costPatterns = @(
        '(?i)(?:cost|price|стоимость)\\s*[:=]?\\s*\\$\\s*([0-9]+(?:[.,][0-9]+)?)',
        '(?i)(?:cost|price|стоимость)\\s*[:=]\\s*([0-9]+(?:[.,][0-9]+)?)\\s*(?:usd|\\$)'
    )

    foreach ($line in $tail) {
        $text = "$line"

        if (-not $result.Tokens) {
            foreach ($pattern in $tokenPatterns) {
                if ($text -match $pattern) {
                    $raw = $matches[1] -replace ',', '.'
                    $value = 0.0
                    if ([double]::TryParse($raw, [ref]$value)) {
                        $suffix = ""
                        if ($matches.Count -gt 2 -and $matches[2]) {
                            $suffix = $matches[2].ToString().ToLower()
                        }
                        if ($suffix -eq 'k') { $value = $value * 1000 }
                        elseif ($suffix -eq 'm') { $value = $value * 1000000 }
                        $result.Tokens = [string]([int64][Math]::Round($value))
                    }
                    break
                }
            }
        }

        if (-not $result.Cost) {
            foreach ($pattern in $costPatterns) {
                if ($text -match $pattern) {
                    $result.Cost = $matches[1] -replace ',', '.'
                    break
                }
            }
        }
    }

    return $result
}

try {
    # Рабочая директория нужна и хукам, и основной задаче.
    if ($Workdir) {
        Set-Location $Workdir
    }

    if ($WorkspaceName) {
        $gitBranch = "-"
        $gitRemote = "-"
        try {
            $branchOut = & git -C "$Workdir" rev-parse --abbrev-ref HEAD 2>$null
            if ($LASTEXITCODE -eq 0 -and $branchOut) { $gitBranch = "$branchOut".Trim() }
        } catch {}
        try {
            $remoteOut = & git -C "$Workdir" remote get-url origin 2>$null
            if ($LASTEXITCODE -eq 0 -and $remoteOut) { $gitRemote = "$remoteOut".Trim() }
        } catch {}
        Write-Log "[workspace] name=$WorkspaceName, cwd=$Workdir, branch=$gitBranch, remote=$gitRemote"
    }

    # Role-scoped tools: ограничения хранятся в определении задачи. Текущая
    # версия opencode run не поддерживает --allow-tool/--deny-tool, поэтому
    # это предупреждение + запись в историю, а не реальное блокирование.
    if ($AllowedTools -or $DeniedTools) {
        Write-Log "[role-scoped] allowed=[$AllowedTools], denied=[$DeniedTools]"
        $deniedList = @($DeniedTools -split ',' | ForEach-Object { $_.Trim().ToLower() } | Where-Object { $_ })
        $dangerous = @('write', 'edit', 'bash', 'apply_patch', 'remove')
        $hit = @($dangerous | Where-Object { $deniedList -contains $_ })
        if ($hit.Count -gt 0) {
            Write-Log "[role-scoped] ВНИМАНИЕ: deniedTools содержит опасные инструменты ($($hit -join ', ')), но opencode run их не ограничивает. Проверьте результаты задачи."
        }
    }

    # Pre-flight: выполняется ДО основной задачи. Ненулевой код отменяет запуск.
    if ($BeforeScript) {
        Write-Log "[windows-scheduler] Pre-flight: $BeforeScript"
        $preCode = Invoke-HookScript -Command $BeforeScript
        if ($preCode -ne 0) {
            Write-Log "[windows-scheduler] ОШИБКА: Pre-flight script failed (код $preCode)."
            $script:preFlightStatus = "error"
            $script:errorMessage = "Pre-flight script failed"
            $script:exitCode = 1
            $script:skipMainTask = $true
        } else {
            $script:preFlightStatus = "success"
            Write-Log "[windows-scheduler] Pre-flight успешно завершён."
        }
    }

    if (-not $script:skipMainTask) {
    $prompt = Get-Content -Path $PromptFile -Raw -Encoding UTF8

    # Спринт 21: env-переменные workspace. Файл пишет плагин, значения не логируются.
    if ($EnvFile -and (Test-Path -LiteralPath $EnvFile)) {
        try {
            Get-Content -Path $EnvFile -Encoding UTF8 | ForEach-Object {
                $line = $_.Trim()
                if ($line -and -not $line.StartsWith("#") -and $line -match "^([A-Za-z_][A-Za-z0-9_]*)=(.*)$") {
                    Set-Item -Path ("env:" + $matches[1]) -Value $matches[2]
                }
            }
            Write-Log "[windows-scheduler] Переменные окружения workspace загружены."
        } catch {
            Write-Log "[windows-scheduler] Не удалось загрузить env-файл workspace: $($_.Exception.Message)"
        }
    }

    # Получаем путь к скрипту opencode (.ps1 или .cmd)
    $opencodeCmd = Get-Command opencode | Select-Object -ExpandProperty Source

    # Формируем аргументы для opencode run
    $opencodeArgs = @("run")
    if ($Model) {
        $opencodeArgs += @("--model", $Model)
    }
    if ($prompt) {
        $opencodeArgs += $prompt
    }

    # Запускаем opencode и НАПРЯМУЮ направляем весь вывод (stdout + stderr) в лог.
    # Out-File -Append -Encoding utf8 пишет по мере поступления строк, поэтому
    # ответ ИИ появляется в GUI ещё до завершения задачи.
    if ($LogFile) {
        if ($opencodeCmd -like "*.ps1") {
            & powershell.exe -ExecutionPolicy Bypass -NoProfile -File $opencodeCmd @opencodeArgs *>&1 |
                ForEach-Object { Format-LogLine $_ } |
                Out-File -FilePath $LogFile -Append -Encoding utf8
        } else {
            & $opencodeCmd @opencodeArgs *>&1 |
                ForEach-Object { Format-LogLine $_ } |
                Out-File -FilePath $LogFile -Append -Encoding utf8
        }
    } else {
        if ($opencodeCmd -like "*.ps1") {
            & powershell.exe -ExecutionPolicy Bypass -NoProfile -File $opencodeCmd @opencodeArgs *>&1 |
                ForEach-Object { Format-LogLine $_ } |
                Out-Host
        } else {
            & $opencodeCmd @opencodeArgs *>&1 |
                ForEach-Object { Format-LogLine $_ } |
                Out-Host
        }
    }
    $script:exitCode = $LASTEXITCODE

    # Quality Gate: проверочная команда выполняется ТОЛЬКО после успешного
    # завершения opencode run. Если ИИ упал — шлюз не запускаем.
    if ($QualityGate -and $script:exitCode -eq 0) {
        Write-Log "[windows-scheduler] Запуск Quality Gate: $QualityGate"
        $gateOutput = & cmd.exe /c $QualityGate 2>&1
        $gateCode = $LASTEXITCODE

        if ($LogFile) {
            try {
                $gateOutput | ForEach-Object { Add-Content -Path $LogFile -Value "$_" -Encoding utf8 }
            } catch {}
        } else {
            $gateOutput | Out-Host
        }

        if ($gateCode -ne 0) {
            Write-Log "[windows-scheduler] ОШИБКА: Quality Gate провален. Код возврата: $gateCode"
            $script:errorMessage = "Quality Gate провален. Код возврата: $gateCode"
            $script:exitCode = 1
        } else {
            Write-Log "[windows-scheduler] Quality Gate пройден."
        }
    }

    if ($script:exitCode -ne 0) {
        Write-Log "[windows-scheduler] Задача '$TaskName' завершилась с кодом $script:exitCode."
    } else {
        Write-Log "[windows-scheduler] Задача '$TaskName' успешно завершена."
    }
    } # конец блока основной задачи
} catch {
    Write-Log "[windows-scheduler] Ошибка выполнения задачи '$TaskName': $_"
    $script:errorMessage = "Ошибка выполнения задачи: $_"
    $script:exitCode = 1
} finally {
    # Post-flight: выполняется ВСЕГДА, даже если основная задача упала.
    if ($AfterScript) {
        Write-Log "[windows-scheduler] Post-flight: $AfterScript"
        $postCode = Invoke-HookScript -Command $AfterScript
        if ($postCode -ne 0) {
            Write-Log "[windows-scheduler] ОШИБКА: Post-flight script failed (код $postCode)."
            $script:postFlightStatus = "error"
            if ($script:exitCode -eq 0) {
                $script:errorMessage = "Post-flight script failed"
                $script:exitCode = 1
            }
        } else {
            $script:postFlightStatus = "success"
            Write-Log "[windows-scheduler] Post-flight успешно завершён."
        }
    }

    # Фиксируем факт выполнения в историю и метрики (независимо от того, кто запустил: GUI или Windows)
    $endTime = Get-Date
    $durationMs = [int](($endTime - $startTime).TotalMilliseconds)
    $status = if ($script:exitCode -eq 0) { "success" } else { "error" }
    $usage = Get-UsageFromLog -File $LogFile
    $tokensArg = "-"
    if ($usage.Tokens) { $tokensArg = $usage.Tokens }
    $costArg = "-"
    if ($usage.Cost) { $costArg = $usage.Cost }
    $modelArg = "-"
    if ($Model) { $modelArg = $Model }
    if ($RecorderFile) {
        try {
            if ($script:runId) {
                & node "$RecorderFile" --finish "$script:runId" "$TaskName" "$status" $durationMs $script:errorMessage $tokensArg $costArg "$modelArg" "$script:preFlightStatus" "$script:postFlightStatus"
            } else {
                # Fallback: --start не удался (например, старая установка) —
                # пишем завершённую запись старым способом, без потери истории.
                & node "$RecorderFile" "$TaskName" "$status" "$startedAtIso" $durationMs $script:errorMessage $tokensArg $costArg "$modelArg" "$script:preFlightStatus" "$script:postFlightStatus"
            }
        } catch {}
    }

    if ($LockFile -and (Test-Path $LockFile)) {
        try {
            Remove-Item $LockFile -Force
        } catch {}
    }
}

exit $script:exitCode
`;

/**
 * Гарантирует existence директорий плагина и записывает generic-обёртку.
 * Возвращает путь к обёртке.
 */
export async function ensureWrapper(): Promise<string> {
  await fs.mkdir(WRAPPER_DIR, { recursive: true });
  const wrapperPath = path.join(WRAPPER_DIR, WRAPPER_FILENAME);
  // BOM обязателен: Windows PowerShell 5.1 читает .ps1 без BOM как ANSI,
  // из-за чего кириллица в сообщениях Write-Log превращается в мусор.
  await fs.writeFile(wrapperPath, "\uFEFF" + WRAPPER_SCRIPT, "utf8");
  return wrapperPath;
}

/**
 * Записывает промпт задачи во временный файл и возвращает его путь.
 */
export async function writePromptFile(taskName: string, prompt: string): Promise<string> {
  const promptDir = path.join(PLUGIN_DIR, "prompts");
  await fs.mkdir(promptDir, { recursive: true });
  const promptPath = path.join(promptDir, `${taskName}.txt`);
  // BOM помогает Windows PowerShell 5.1 правильно прочитать кириллицу.
  // На POSIX BOM попал бы в промпт как мусорный символ — не пишем его.
  const content = process.platform === "win32" ? "\uFEFF" + prompt : prompt;
  await fs.writeFile(promptPath, content, "utf8");
  return promptPath;
}

/**
 * Возвращает путь к lock-файлу задачи.
 */
export function lockFilePath(taskName: string): string {
  return path.join(PLUGIN_DIR, "locks", `${taskName}.lock`);
}

/**
 * Генерирует per-task .cmd-обёртку, которую schtasks вызывает через /tr.
 * Внутри .cmd — жёстко заданный вызов run-task.ps1 с задачей, промптом,
 * таймаутом и lock-файлом. schtasks получает только один путь (в кавычках),
 * поэтому спецсимволы и кириллица в аргументах больше не ломают парсинг.
 *
 * @param sanitizedName  безопасное имя для файла (латиница, цифры, -, _)
 * @param taskName       отображаемое имя задачи в taskschd.msc (как есть, может быть кириллицей)
 * @param promptFile     абсолютный путь к файлу с промптом
 * @param timeoutSeconds таймаут в секундах
 * @param lockFile       абсолютный путь к lock-файлу
 * @param workdir        рабочая директория (опционально; по умолчанию — process.cwd())
 * @param logFile        путь к файлу лога
 * @param recorderFile   путь к record-history.js (история/метрики)
 * @param qualityGate    проверочная команда Quality Gate
 * @param model          LLM-модель для `opencode run --model` (опционально)
 * @param beforeScript   pre-flight команда (опционально)
 * @param afterScript    post-flight команда (опционально)
 * @param workspaceName  имя workspace для git-контекста в логе (опционально)
 * @param allowedTools   список разрешённых инструментов (спринт 14, опционально)
 * @param deniedTools    список запрещённых инструментов (спринт 14, опционально)
 * @param scheduleGate   гейт расписания (спринт 19): проверка cron в таймзоне
 *                       и окна запуска перед стартом PowerShell-обёртки.
 */
export async function writeWrapperCmd(
  sanitizedName: string,
  taskName: string,
  promptFile: string,
  timeoutSeconds: number,
  lockFile: string,
  workdir?: string,
  logFile?: string,
  recorderFile?: string,
  qualityGate?: string,
  model?: string,
  beforeScript?: string,
  afterScript?: string,
  workspaceName?: string,
  allowedTools?: string[],
  deniedTools?: string[],
  scheduleGate?: ScheduleGateSpec & { gateFile: string; deferFile?: string },
  envFile?: string
): Promise<string> {
  await fs.mkdir(WRAPPER_DIR, { recursive: true });
  const cmdPath = path.join(WRAPPER_DIR, `run-${sanitizedName}.cmd`);
  const ps1Path = path.join(WRAPPER_DIR, WRAPPER_FILENAME);

  // ВАЖНО: команда powershell.exe должна быть ОДНОЙ строкой.
  // Раньше -LogFile и -RecorderFile добавлялись отдельными строками .cmd,
  // из-за чего PowerShell их не получал, а cmd пытался выполнить их как
  // самостоятельные команды: логи оставались пустыми, история не писалась.
  const psArgs: string[] = [
    `powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -NoProfile -File "${ps1Path}"`,
    `-TaskName "${taskName}"`,
    `-PromptFile "${promptFile}"`,
    `-TimeoutSeconds ${timeoutSeconds}`,
    `-LockFile "${lockFile}"`,
  ];

  if (logFile) {
    psArgs.push(`-LogFile "${logFile}"`);
  }

  if (recorderFile) {
    psArgs.push(`-RecorderFile "${recorderFile}"`);
  }

  if (qualityGate) {
    // Кавычки в .cmd-строке ломают передачу аргумента, переводы строк — тоже.
    const safeGate = qualityGate.replace(/[\r\n]+/g, " ").replace(/"/g, "'").trim();
    if (safeGate) {
      psArgs.push(`-QualityGate "${safeGate}"`);
    }
  }

  if (model?.trim()) {
    const safeModel = model.replace(/[\r\n"]+/g, "").trim();
    if (safeModel) {
      psArgs.push(`-Model "${safeModel}"`);
    }
  }

  if (workspaceName?.trim()) {
    const safeWorkspace = workspaceName.replace(/[\r\n"]+/g, "'").trim();
    if (safeWorkspace) {
      psArgs.push(`-WorkspaceName "${safeWorkspace}"`);
    }
  }

  // Role-scoped tools (спринт 14): передаём списки одной строкой через запятую.
  for (const [flag, list] of [
    ["-AllowedTools", allowedTools],
    ["-DeniedTools", deniedTools],
  ] as const) {
    const joined = (Array.isArray(list) ? list : [])
      .map((item) => String(item).trim())
      .filter(Boolean)
      .join(",");
    if (joined) {
      const safe = joined.replace(/[\r\n"]+/g, "'");
      psArgs.push(`${flag} "${safe}"`);
    }
  }

  // Хуки передаются одной строкой: кавычки заменяем на апострофы, как у Quality Gate.
  for (const [flag, script] of [
    ["-BeforeScript", beforeScript],
    ["-AfterScript", afterScript],
  ] as const) {
    const safe = script?.replace(/[\r\n]+/g, " ").replace(/"/g, "'").trim();
    if (safe) {
      psArgs.push(`${flag} "${safe}"`);
    }
  }

  // Спринт 21: env-файл workspace (пары KEY=VALUE). Значения не логируются.
  if (envFile?.trim()) {
    const safeEnvFile = envFile.replace(/[\r\n"]+/g, "").trim();
    if (safeEnvFile) {
      psArgs.push(`-EnvFile "${safeEnvFile}"`);
    }
  }

  const lines: string[] = ["@echo off", "chcp 65001 >nul"];

  // Рабочая директория: всегда переходим в неё ДО запуска PowerShell.
  // По умолчанию — текущая папка проекта (process.cwd()). Это критично для
  // MCP: opencode run подхватывает opencode.json из рабочей директории.
  const effectiveWorkdir = workdir?.trim() || process.cwd();
  lines.push(`cd /d "${effectiveWorkdir}"`);

  // Спринт 19: гейт расписания ДО PowerShell. Проверяет, что cron реально
  // сработал сейчас (для poll-режима и чужих таймзон), и при необходимости
  // переносит запуск до открытия окна notBefore..notAfter.
  // Exit 3 — «не сейчас», выходим тихо, не считая это запуском задачи.
  if (scheduleGate?.gateFile) {
    const gateArgs = [`node "${scheduleGate.gateFile}"`];
    if (scheduleGate.cron?.trim()) {
      gateArgs.push(`--cron "${scheduleGate.cron.replace(/[\r\n"]+/g, " ").trim()}"`);
    }
    if (scheduleGate.tz?.trim()) {
      gateArgs.push(`--tz "${scheduleGate.tz.trim()}"`);
    }
    if (scheduleGate.notBefore?.trim()) {
      gateArgs.push(`--not-before ${scheduleGate.notBefore.trim()}`);
    }
    if (scheduleGate.notAfter?.trim()) {
      gateArgs.push(`--not-after ${scheduleGate.notAfter.trim()}`);
    }
    if (scheduleGate.deferFile?.trim()) {
      gateArgs.push(`--defer-file "${scheduleGate.deferFile.trim()}"`);
    }
    // append к логу задачи, чтобы перенос/пропуск был виден в истории запусков
    if (logFile?.trim()) {
      gateArgs.push(`>> "${logFile.trim()}" 2>&1`);
    }
    lines.push(gateArgs.join(" "));
    lines.push(`if "%errorlevel%"=="3" exit /b 0`);
  }

  lines.push(psArgs.join(" "));

  await fs.writeFile(cmdPath, lines.join("\r\n"), "utf8");
  return cmdPath;
}
