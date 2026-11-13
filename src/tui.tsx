/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { getJobsView, statusIcon, type JobView } from "./shared/jobs-view"

/**
 * TUI-часть плагина: панель "Планировщик Windows" в боковой панели терминала.
 * Рендеринг — @opentui/solid (JSX-примитивы <box> и <text>).
 * Слот боковой панели в OpenCode v2 называется "sidebar.content".
 *
 * Данные на этой итерации — заглушка из общего модуля getJobsView ([]).
 * TODO: подключить реальный list_jobs через RPC/context.client.
 */
export default Plugin.define({
  id: "opencode-windows-scheduler.tui",
  setup(ctx) {
    // Не используем solid-js сигналы: TUI-рантайм и локальный node_modules
    // могут держать разные копии solid-js, и реактивность не свяжется.
    let jobs: JobView[] = []
    void getJobsView(ctx)
      .then((value) => {
        jobs = value
      })
      .catch(() => {
        jobs = []
      })

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
                {job.nextRun ? ` → ${job.nextRun}` : ""}
              </text>
            ))
          )}
        </box>
      ),
    })
  },
})
