/**
 * Тесты Спринта 25: уведомления v3 — Telegram и нативные toast.
 * Запуск: node test-notifications-v3.mjs (после npm run build).
 * Реальные сообщения не отправляются: fetch и запуск процессов подменяются.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Временный конфиг-домен — до динамического импорта dist, чтобы PLUGIN_DIR
// вычислился уже с подменённым OPENCODE_SCHEDULER_HOME.
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ws-scheduler-notify3-"));
process.env.APPDATA = tempRoot;
process.env.OPENCODE_SCHEDULER_HOME = path.join(
  tempRoot,
  "opencode",
  "windows-scheduler"
);

const telegram = await import("./dist/core/telegram.js");
const nativeNotify = await import("./dist/core/native-notify.js");
const notifications = await import("./dist/notifications.js");
const settingsModule = await import("./dist/settings.js");

const {
  escapeTelegramText,
  formatTelegramText,
  maskTelegramToken,
  sendTelegramMessage,
  validateTelegramToken,
} = telegram;
const { buildNativeNotificationCommand, sendNativeNotification } = nativeNotify;
const { formatNotificationMessage, isQuietHours } = notifications;

const results = [];
function check(name, cond) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? "OK  " : "FAIL"} ${name}`);
}

// --- 1. Telegram: экранирование ------------------------------------------
check(
  "HTML: & < > экранируются",
  escapeTelegramText("A & B <tag>", "HTML") === "A &amp; B &lt;tag&gt;"
);
check(
  "MarkdownV2: резервные символы экранируются",
  escapeTelegramText("a_b*c[d](e).", "MarkdownV2") === "a\\_b\\*c\\[d\\]\\(e\\)\\."
);
check(
  "Markdown: подчёркивания и звёздочки экранируются",
  escapeTelegramText("a_b*c", "Markdown") === "a\\_b\\*c"
);
check("plain: текст без изменений", escapeTelegramText("a_b*c<d>", "") === "a_b*c<d>");

// --- 2. Telegram: ссылка на дашборд --------------------------------------
const dash = "http://localhost:3782/";
check(
  "HTML: ссылка на дашборд добавляется тегом <a>",
  formatTelegramText("Готово", "HTML", dash).includes(`<a href="${dash}">`)
);
check(
  "MarkdownV2: ссылка на дашборд в формате [текст](url)",
  formatTelegramText("Готово", "MarkdownV2", dash).includes(`[📊 Открыть дашборд](${dash})`)
);
check(
  "plain: ссылка добавляется текстом",
  formatTelegramText("Готово", "", dash).includes(`Открыть дашборд: ${dash}`)
);
check(
  "без URL ссылка не добавляется",
  formatTelegramText("Готово", "HTML", null) === "Готово"
);

// --- 3. Telegram: токен ---------------------------------------------------
const token = "123456:ABCdefGhIJKlmNopQRSTUVWX";
check("validateTelegramToken принимает формат BotFather", validateTelegramToken(token) === token);
let tokenError = null;
try {
  validateTelegramToken("not-a-token");
} catch (err) {
  tokenError = err;
}
check("validateTelegramToken отвергает мусор", tokenError !== null);
check(
  "maskTelegramToken скрывает секрет",
  maskTelegramToken(token) === "123456:***UVWX" &&
    !maskTelegramToken(token).includes("ABCdefGhIJKlmNopQRST")
);

// --- 4. Telegram: sendMessage через подменённый fetch ---------------------
let sentRequest = null;
const okFetch = async (url, init) => {
  sentRequest = { url, init };
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ ok: true, result: {} }),
  };
};
await sendTelegramMessage(token, "42", "Hello", {
  fetchImpl: okFetch,
  apiBase: "https://api.telegram.org",
  parseMode: "HTML",
  dashboardUrl: dash,
  disableNotification: true,
});
const body = JSON.parse(sentRequest.init.body);
check(
  "sendMessage: URL содержит токен и /sendMessage",
  sentRequest.url === `https://api.telegram.org/bot${token}/sendMessage`
);
check("sendMessage: chat_id в теле", body.chat_id === "42");
check("sendMessage: parse_mode в теле", body.parse_mode === "HTML");
check("sendMessage: disable_notification в теле", body.disable_notification === true);
check(
  "sendMessage: ссылка на дашборд в тексте",
  body.text.includes(`<a href="${dash}">`)
);

let apiError = null;
try {
  await sendTelegramMessage(token, "42", "Hello", {
    fetchImpl: async () => ({
      ok: false,
      status: 400,
      text: async () =>
        JSON.stringify({
          ok: false,
          description: `Bad Request: token ${token} is invalid`,
        }),
    }),
  });
} catch (err) {
  apiError = err;
}
check(
  "sendMessage: ошибка API не содержит токен",
  apiError instanceof Error &&
    !apiError.message.includes(token) &&
    apiError.message.includes("***")
);

// --- 5. Нативные команды --------------------------------------------------
const win = buildNativeNotificationCommand("win32", {
  title: "Scheduler",
  body: "Task failed",
  sound: true,
});
check(
  "win32: PowerShell и ToastGeneric",
  win.command === "powershell.exe" &&
    win.args.join(" ").includes("ToastGeneric") &&
    win.env?.OCS_NOTIFY_BODY === "Task failed"
);
const winSilent = buildNativeNotificationCommand("win32", {
  title: "Scheduler",
  body: "ok",
  sound: false,
});
check(
  "win32: sound=false передаётся в env",
  winSilent.env?.OCS_NOTIFY_SOUND === "0"
);

const mac = buildNativeNotificationCommand("darwin", {
  title: "Scheduler",
  body: "Task failed",
  sound: true,
});
check(
  "darwin: osascript display notification",
  mac.command === "osascript" &&
    mac.args.join(" ").includes("display notification") &&
    mac.args.join(" ").includes('sound name "Glass"') &&
    mac.env?.OCS_NOTIFY_BODY === "Task failed"
);

const linux = buildNativeNotificationCommand("linux", {
  title: "Scheduler",
  body: "Task failed",
});
check(
  "linux: notify-send с заголовком и телом",
  linux.command === "notify-send" &&
    linux.args.includes("Scheduler") &&
    linux.args.includes("Task failed")
);

let executed = null;
const okNative = await sendNativeNotification(
  { title: "Scheduler", body: "done" },
  {
    platform: "linux",
    exec: async (command, args, env) => {
      executed = { command, args, env };
    },
  }
);
check(
  "sendNativeNotification: успешный запуск",
  okNative.success === true && executed?.command === "notify-send"
);
const failedNative = await sendNativeNotification(
  { title: "Scheduler", body: "done" },
  {
    platform: "linux",
    exec: async () => {
      throw new Error("notify-send not found");
    },
  }
);
check(
  "sendNativeNotification: ошибка проглатывается",
  failedNative.success === false && failedNative.error?.includes("not found")
);

// --- 6. Тихие часы --------------------------------------------------------
const at = (hour, minute = 0) => new Date(2026, 0, 1, hour, minute, 0, 0);
const quiet = { enabled: true, from: "22:00", to: "08:00" };
check("quiet: 23:30 попадает", isQuietHours(at(23, 30), quiet) === true);
check("quiet: 07:59 попадает", isQuietHours(at(7, 59), quiet) === true);
check("quiet: 08:00 уже не попадает", isQuietHours(at(8, 0), quiet) === false);
check("quiet: 12:00 не попадает", isQuietHours(at(12, 0), quiet) === false);
check(
  "quiet: одинаковые границы = весь день",
  isQuietHours(at(12, 0), { enabled: true, from: "00:00", to: "00:00" }) === true
);
check(
  "quiet: некорректное время игнорируется",
  isQuietHours(at(23, 0), { enabled: true, from: "25:00", to: "08:00" }) === false
);
check(
  "quiet: выключенные тихие часы",
  isQuietHours(at(23, 0), { enabled: false, from: "22:00", to: "08:00" }) === false
);

// --- 7. Сообщение: стоимость и токены ------------------------------------
const withUsage = formatNotificationMessage({
  taskName: "deploy",
  status: "success",
  durationMs: 2300,
  tokens: 1500,
  costUsd: 0.006,
});
check(
  "formatNotificationMessage: токены и стоимость в тексте",
  withUsage.includes("1500 tok") && withUsage.includes("$0.0060")
);
const noUsage = formatNotificationMessage({
  taskName: "deploy",
  status: "success",
  durationMs: 2300,
});
check(
  "formatNotificationMessage: без данных текст не меняется",
  noUsage === '✅ Задача "deploy" выполнена (2.3s)'
);
check(
  "шаблон {cost} получает стоимость",
  formatNotificationMessage(
    { taskName: "deploy", status: "error", durationMs: 1000, costUsd: 0.01, error: "boom" },
    { success: "{task}", error: "{task}{error}{cost}" }
  ) === 'deploy: boom · $0.0100'
);

// --- 8. Настройки: дефолты и миграция ------------------------------------
const defaults = settingsModule.defaultNotifications();
check(
  "defaultNotifications: Telegram выключен и HTML по умолчанию",
  defaults.telegram?.enabled === false && defaults.telegram?.parseMode === "HTML"
);
check(
  "defaultNotifications: нативные уведомления выключены, звук включён",
  defaults.native?.enabled === false && defaults.native?.sound === true
);
check(
  "defaultNotifications: тихие часы 22:00–08:00 выключены",
  defaults.quietHours?.enabled === false &&
    defaults.quietHours?.from === "22:00" &&
    defaults.quietHours?.to === "08:00"
);

const settingsFile = path.join(process.env.OPENCODE_SCHEDULER_HOME, "settings.json");
fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
fs.writeFileSync(
  settingsFile,
  JSON.stringify({
    maxConcurrent: 1,
    winterMode: false,
    notifications: {
      enabled: true,
      onlyOnError: false,
      webhook: { enabled: true, url: "http://127.0.0.1:9/hook" },
    },
  }),
  "utf8"
);
const loaded = await settingsModule.loadSettings();
check(
  "loadSettings: старый settings.json получает Telegram/native/quiet",
  loaded.notifications.telegram?.enabled === false &&
    loaded.notifications.telegram?.apiBase === "https://api.telegram.org" &&
    loaded.notifications.native?.enabled === false &&
    loaded.notifications.quietHours?.from === "22:00"
);
check(
  "loadSettings: секреты не появляются в tasks.json (структура настроек отдельная)",
  !JSON.stringify(loaded).includes(token)
);

// Partial update: сохранение формы не должно терять секрет, если он не передан.
await settingsModule.saveSettings({
  notifications: {
    ...loaded.notifications,
    telegram: {
      ...loaded.notifications.telegram,
      enabled: true,
      botToken: token,
      chatId: "42",
    },
  },
});
const saved = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
check(
  "saveSettings: Telegram сохраняется в settings.json",
  saved.notifications.telegram?.botToken === token &&
    saved.notifications.telegram?.chatId === "42"
);
const updated = await settingsModule.saveSettings({
  notifications: {
    ...saved.notifications,
    quietHours: { enabled: true, from: "23:00", to: "07:00" },
  },
});
check(
  "saveSettings: частичное обновление сохраняет Telegram",
  updated.notifications.telegram?.botToken === token &&
    updated.notifications.quietHours?.enabled === true &&
    updated.notifications.quietHours?.from === "23:00"
);

// --- Итог ----------------------------------------------------------------
const failures = results.filter((item) => !item.ok);
console.log(`\nNotifications v3: ${results.length - failures.length}/${results.length} проверок пройдено.`);
if (failures.length > 0) {
  for (const item of failures) console.error(`FAIL: ${item.name}`);
  process.exit(1);
}
