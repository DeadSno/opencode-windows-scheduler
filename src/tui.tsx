/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { getJobsView, statusIcon, type JobView } from "./shared/jobs-view"

/**
 * TUI-часть плагина: панель "Планировщик Windows" в боковой панели терминала.
 * Рендеринг — @opentui/solid (JSX-примитивы <box> и <text>).
 * Слот боковой панели в OpenCode v2 называется "sidebar.content".
 *
 * Данные читаются из реального планировщика и истории; панель собирается
 * после загрузки, поэтому список не мигает пустым состоянием.
 */
export default Plugin.define({
  id: "opencode-windows-scheduler.tui",
  async setup(ctx) {
    // Не используем solid-js сигналы: TUI-рантайм и локальный node_modules
    // могут держать разные копии solid-js, и реактивность не свяжется.
    let jobs: JobView[] = []
    try {
      jobs = await getJobsView(ctx)
    } catch {
      jobs = []
    }

    ctx.ui.slot({
      append: "sidebar.content",
      render: () => (
        <box flexDirection="column">
          <text>Планировщик Windows</text>
          {jobs.length === 0 ? (
            <text>Задач пока нет</text>
          ) : (
            jobs.map((job) => (
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
  },
})
