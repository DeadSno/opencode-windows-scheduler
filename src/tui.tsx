/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { getSchedulerBackend } from "./core/scheduler/index"
import { getTaskLogs } from "./core/scheduler/logs"
import {
  formatJobLog,
  getJobsView,
  groupJobsForDisplay,
  nextJobSelection,
  statusIcon,
  type JobView,
} from "./shared/jobs-view"

type JobAction = "run" | "pause" | "resume" | "log"

/**
 * TUI-часть плагина: панель "Планировщик Windows" в боковой панели терминала.
 * Рендеринг — @opentui/solid (JSX-примитивы <box> и <text>).
 * Слот боковой панели в OpenCode v2 называется "sidebar.content".
 *
 * Данные читаются из реального планировщика и истории. Список хранится в
 * reactive store контекста и обновляется раз в 5 секунд, поэтому панель
 * не остаётся статическим снимком первого рендера.
 */
export default Plugin.define({
  id: "opencode-windows-scheduler.tui",
  async setup(ctx) {
    // Первый снимок загружаем до регистрации слота, чтобы не показывать
    // пустую панель при старте. Ошибки чтения не должны ломать TUI.
    let initialJobs: JobView[] = []
    try {
      initialJobs = await getJobsView(ctx)
    } catch {
      initialJobs = []
    }

    // Не используем solid-js сигналы: TUI-рантайм и локальный node_modules
    // могут держать разные копии solid-js, и реактивность не свяжется.
    // store из ctx.storage — штатный способ отдавать данные в render.
    const [state, setState] = ctx.storage.store("jobs", {
      initial: {
        jobs: initialJobs,
        selected: groupJobsForDisplay(initialJobs)[0]?.job.name ?? "",
      },
    })

    let disposed = false

    async function refresh(): Promise<void> {
      try {
        const jobs = await getJobsView(ctx)
        if (disposed) return
        await setState((draft) => {
          draft.jobs = jobs
          // Сохраняем выбор между обновлениями; если задача исчезла,
          // выделяем первую строку, чтобы клавиатурные команды оставались рабочими.
          const stillExists = jobs.some((job) => job.name === draft.selected)
          if (!stillExists) {
            draft.selected = groupJobsForDisplay(jobs)[0]?.job.name ?? ""
          }
        })
      } catch {
        // Планировщик может быть временно недоступен (например, нет прав
        // на schtasks). Оставляем последний успешный список на экране.
      }
    }

    async function showLog(job: JobView): Promise<void> {
      try {
        const result = await getTaskLogs(job.name, 200)
        await ctx.ui.dialog.alert({
          title: `Лог: ${job.name}`,
          message: formatJobLog(result.logs, result.error, 40),
        })
      } catch (err) {
        ctx.ui.toast.show({
          title: "Планировщик Windows",
          message: `Не удалось прочитать лог «${job.name}»: ${
            err instanceof Error ? err.message : String(err)
          }`,
          variant: "error",
        })
      }
    }

    /** Перемещает выделение по видимому списку задач. */
    async function moveSelection(delta: number): Promise<void> {
      const name = nextJobSelection(
        groupJobsForDisplay(state.jobs),
        state.selected,
        delta
      )
      if (!name || disposed) return
      await setState((draft) => {
        draft.selected = name
      })
    }

    async function openSelected(): Promise<void> {
      const job = state.jobs.find((item) => item.name === state.selected)
      if (job) await openActions(job)
    }

    async function runAction(job: JobView, action: JobAction): Promise<void> {
      try {
        if (action === "log") {
          await showLog(job)
          return
        }
        const backend = getSchedulerBackend()
        if (action === "run") {
          const result = await backend.runTask(job.name)
          ctx.ui.toast.show({
            title: "Планировщик Windows",
            message: result.alreadyRunning
              ? `«${job.name}» уже выполняется`
              : `Запущено: ${job.name}`,
            variant: result.alreadyRunning ? "warning" : "success",
          })
        } else {
          const shouldPause = action === "pause"
          if (shouldPause) await backend.pauseTask(job.name)
          else await backend.resumeTask(job.name)
          ctx.ui.toast.show({
            title: "Планировщик Windows",
            message: shouldPause
              ? `Пауза: ${job.name}`
              : `Возобновлено: ${job.name}`,
            variant: "success",
          })
        }
        await refresh()
      } catch (err) {
        ctx.ui.toast.show({
          title: "Планировщик Windows",
          message: `Не удалось выполнить действие для «${job.name}»: ${
            err instanceof Error ? err.message : String(err)
          }`,
          variant: "error",
        })
      }
    }

    async function openActions(job: JobView): Promise<void> {
      try {
        const options: Array<{
          title: string
          value: JobAction
          description?: string
          disabled?: boolean
        }> = []
        options.push({
          title: "▶ Запустить сейчас",
          value: "run",
          description: job.matrixParentId
            ? "Клон матрицы запускается через родительскую задачу"
            : job.status === "running"
            ? "Задача уже выполняется"
            : "Запустить задачу немедленно",
          disabled: Boolean(job.matrixParentId),
        })
        options.push({
          title: job.paused ? "▶ Возобновить" : "⏸ Поставить на паузу",
          value: job.paused ? "resume" : "pause",
          description: job.paused
            ? "Снять задачу с паузы в планировщике ОС"
            : "Приостановить запуски в планировщике ОС",
        })
        options.push({
          title: "📜 Показать лог",
          value: "log",
          description: "Последние 40 строк вывода задачи",
        })

        const action = await ctx.ui.dialog.select<JobAction>({
          title: `Задача: ${job.name}`,
          placeholder: "Выберите действие",
          options,
        })
        if (!action || disposed) return
        await runAction(job, action)
      } catch (err) {
        ctx.ui.toast.show({
          title: "Планировщик Windows",
          message: `Не удалось открыть действия: ${
            err instanceof Error ? err.message : String(err)
          }`,
          variant: "error",
        })
      }
    }

    async function chooseJob(): Promise<void> {
      try {
        if (state.jobs.length === 0) {
          ctx.ui.toast.show({
            title: "Планировщик Windows",
            message: "Задач пока нет",
            variant: "warning",
          })
          return
        }
        const name = await ctx.ui.dialog.select<string>({
          title: "Планировщик: выберите задачу",
          placeholder: "Имя задачи",
          options: groupJobsForDisplay(state.jobs).map(({ job, depth }) => ({
            title: `${"  ".repeat(depth)}${job.isMatrixParent ? "▣ " : depth > 0 ? "↳ " : ""}${job.name}`,
            value: job.name,
            description: `${statusIcon(job.status)}${
              job.paused ? " пауза" : ""
            }${job.nextRun ? ` · следующий запуск: ${job.nextRun}` : ""}`,
          })),
        })
        if (!name || disposed) return
        const job = state.jobs.find((item) => item.name === name)
        if (job) await openActions(job)
      } catch (err) {
        ctx.ui.toast.show({
          title: "Планировщик Windows",
          message: `Не удалось открыть список задач: ${
            err instanceof Error ? err.message : String(err)
          }`,
          variant: "error",
        })
      }
    }

    // Команда доступна из палитры команд; горячая клавиша — удобный shortcut.
    ctx.keymap.layer(() => ({
      commands: [
        {
          id: "opencode-windows-scheduler.actions",
          title: "Планировщик: действия с задачей",
          description: "Запустить, поставить на паузу или возобновить задачу",
          group: "Планировщик Windows",
          palette: true,
          bind: "ctrl+shift+j",
          run: () => {
            void chooseJob()
          },
        },
        {
          id: "opencode-windows-scheduler.refresh",
          title: "Планировщик: обновить список",
          group: "Планировщик Windows",
          palette: true,
          run: () => {
            void refresh()
          },
        },
        {
          id: "opencode-windows-scheduler.previous",
          title: "Планировщик: предыдущая задача",
          group: "Планировщик Windows",
          palette: true,
          bind: "ctrl+shift+up",
          run: () => {
            void moveSelection(-1)
          },
        },
        {
          id: "opencode-windows-scheduler.next",
          title: "Планировщик: следующая задача",
          group: "Планировщик Windows",
          palette: true,
          bind: "ctrl+shift+down",
          run: () => {
            void moveSelection(1)
          },
        },
        {
          id: "opencode-windows-scheduler.open-selected",
          title: "Планировщик: действия с выбранной задачей",
          group: "Планировщик Windows",
          palette: true,
          bind: "ctrl+shift+enter",
          run: () => {
            void openSelected()
          },
        },
      ],
    }))

    const timer = setInterval(() => {
      void refresh()
    }, 5000)
    // Не держим событийный цикл, если TUI закрывается между тиками.
    if (typeof timer === "object" && timer !== null && "unref" in timer) {
      ;(timer as { unref?: () => void }).unref?.()
    }

    ctx.ui.slot({
      append: "sidebar.content",
      render: () => (
        <box flexDirection="column">
          <text>Планировщик Windows</text>
          {state.jobs.length === 0 ? (
            <text>Задач пока нет</text>
          ) : (
            groupJobsForDisplay(state.jobs).map(({ job, depth }) => (
              <text onMouseDown={() => void openActions(job)}>
                {state.selected === job.name ? "› " : "  "}
                {"  ".repeat(depth)}
                {depth > 0 ? "↳ " : job.isMatrixParent ? "▣ " : ""}
                {statusIcon(job.status)} {job.name}
                {job.paused ? " (пауза)" : ""}
                {job.nextRun ? ` → ${job.nextRun}` : ""}
              </text>
            ))
          )}
          <text>Клик — действия · Ctrl+Shift+J — меню</text>
          <text>Ctrl+Shift+↑/↓ — выбор · Ctrl+Shift+Enter — открыть</text>
        </box>
      ),
    })

    return () => {
      disposed = true
      clearInterval(timer)
    }
  },
})
