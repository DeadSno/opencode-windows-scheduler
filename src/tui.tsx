/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { getJobsView, statusIcon, type JobView } from "./shared/jobs-view"

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
      initial: { jobs: initialJobs },
    })

    let disposed = false

    async function refresh(): Promise<void> {
      try {
        const jobs = await getJobsView(ctx)
        if (disposed) return
        await setState((draft) => {
          draft.jobs = jobs
        })
      } catch {
        // Планировщик может быть временно недоступен (например, нет прав
        // на schtasks). Оставляем последний успешный список на экране.
      }
    }

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
            state.jobs.map((job) => (
              <text>
                {statusIcon(job.status)} {job.name}
                {job.paused ? " (пауза)" : ""}
                {job.nextRun ? ` → ${job.nextRun}` : ""}
              </text>
            ))
          )}
        </box>
      ),
    })

    return () => {
      disposed = true
      clearInterval(timer)
    }
  },
})
