/**
 * Нативные уведомления ОС (Спринт 25).
 *
 * Windows — Toast через PowerShell/WinRT, macOS — Notification Center через
 * osascript, Linux — notify-send (libnotify). Внешних зависимостей нет:
 * node-notifier не требуется. Все ошибки проглатываются намеренно —
 * уведомление не должно ломать задачу.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Таймаут запуска процесса уведомления. */
const DEFAULT_TIMEOUT_MS = 15_000;

export interface NativeNotificationMessage {
  /** Заголовок; по умолчанию «OpenCode Scheduler». */
  title?: string;
  /** Текст уведомления. */
  body: string;
  /** Со звуком, если платформа поддерживает. */
  sound?: boolean;
}

/** Готовая команда запуска — удобно проверять в тестах. */
export interface NativeCommand {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** Скрипт Windows Toast: текст передаётся через env, чтобы не экранировать кавычки. */
const WINDOWS_TOAST_SCRIPT = `
$ErrorActionPreference = 'Stop'
$title = [System.Security.SecurityElement]::Escape($env:OCS_NOTIFY_TITLE)
$body = [System.Security.SecurityElement]::Escape($env:OCS_NOTIFY_BODY)
$silent = if ($env:OCS_NOTIFY_SOUND -eq '1') { '' } else { '<audio silent="true"/>' }
$xml = '<toast><visual><binding template="ToastGeneric"><text>' + $title + '</text><text>' + $body + '</text></binding></visual>' + $silent + '</toast>'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] > $null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType=WindowsRuntime] > $null
$doc = [Windows.Data.Xml.Dom.XmlDocument]::new()
$doc.LoadXml($xml)
$toast = [Windows.UI.Notifications.ToastNotification]::new($doc)
$appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
`.trim();

/**
 * Собирает команду нативного уведомления для платформы.
 * Чистая функция: ничего не запускает.
 */
export function buildNativeNotificationCommand(
  platform: NodeJS.Platform,
  message: NativeNotificationMessage
): NativeCommand {
  const title = (message.title ?? "OpenCode Scheduler").trim() || "OpenCode Scheduler";
  const body = String(message.body ?? "");
  const sound = message.sound !== false;

  if (platform === "win32") {
    return {
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        WINDOWS_TOAST_SCRIPT,
      ],
      env: {
        OCS_NOTIFY_TITLE: title,
        OCS_NOTIFY_BODY: body,
        OCS_NOTIFY_SOUND: sound ? "1" : "0",
      },
    };
  }

  if (platform === "darwin") {
    const script =
      'display notification (system attribute "OCS_NOTIFY_BODY") ' +
      'with title (system attribute "OCS_NOTIFY_TITLE")' +
      (sound ? ' sound name "Glass"' : "");
    return {
      command: "osascript",
      args: ["-e", script],
      env: {
        OCS_NOTIFY_TITLE: title,
        OCS_NOTIFY_BODY: body,
      },
    };
  }

  return {
    command: "notify-send",
    args: [
      "-a",
      "OpenCode Scheduler",
      "-u",
      "normal",
      "-i",
      "dialog-information",
      title,
      body,
    ],
  };
}

export interface SendNativeOptions {
  /** Подмена платформы для тестов. */
  platform?: NodeJS.Platform;
  /** Подмена запуска процесса для тестов. */
  exec?: (command: string, args: string[], env: NodeJS.ProcessEnv) => Promise<void>;
  /** Таймаут процесса в мс. */
  timeoutMs?: number;
}

export interface NativeSendResult {
  success: boolean;
  error?: string;
}

/**
 * Показывает нативное уведомление. Никогда не бросает исключение.
 */
export async function sendNativeNotification(
  message: NativeNotificationMessage,
  options: SendNativeOptions = {}
): Promise<NativeSendResult> {
  const platform = options.platform ?? process.platform;
  const command = buildNativeNotificationCommand(platform, message);
  const env = { ...process.env, ...(command.env ?? {}) };
  const timeoutMs = Math.max(1_000, Math.floor(options.timeoutMs ?? DEFAULT_TIMEOUT_MS));

  try {
    if (options.exec) {
      await options.exec(command.command, command.args, env);
    } else {
      await execFileAsync(command.command, command.args, {
        env,
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      });
    }
    return { success: true };
  } catch (err: any) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
