import { getSchedulerBackend } from "../core/scheduler/index.js"
import { latestHistoryByTask, loadHistory, type HistoryRecord } from "../history.js"

export type JobStatus = "running" | "success" | "error" | "partial" | "idle" | "unknown"

export interface JobView {
  name: string
  status: JobStatus
  /** Задача поставлена на паузу в планировщике ОС. */
  paused?: boolean
  nextRun?: string
  lastRun?: string
}

/**
 * Возвращает символ статуса задачи для отображения в панелях TUI и GUI.
 * Общая логика для обоих рантаймов.
 */
export function statusIcon(status: JobStatus): string {
  switch (status) {
    case "running":
      return "●"
    case "error":
      return "✗"
    case "success":
      return "✓"
    case "partial":
      return "◐"
    case "idle":
      // Задача создана, но ещё ни разу не запускалась.
      return "○"
    default:
      return "?"
  }
}

/** Переводит запись истории в статус панели (timeout считаем ошибкой). */
function historyStatus(record: HistoryRecord | undefined): JobStatus {
  if (!record) return "idle"
  if (record.status === "timeout") return "error"
  return record.status
}

/**
 * Возвращает список задач планировщика в едином формате для TUI и GUI.
 *
 * Читает реальные задачи из бэкенда планировщика и последнюю запись истории
 * по каждой задаче. Если бэкенд недоступен (например, нет прав на schtasks),
 * возвращает пустой список — панель покажет честное «нет данных», а не
 * выдуманные задачи.
 */
export async function getJobsView(_context: unknown): Promise<JobView[]> {
  try {
    const backend = getSchedulerBackend()
    const [tasks, history] = await Promise.all([backend.listTasks(), loadHistory()])
    const latest = latestHistoryByTask(history)
    return tasks.map((task) => {
      const name = task.taskName
      const record = latest.get(name.toLowerCase())
      return {
        name,
        status: historyStatus(record),
        paused: Boolean(task.paused),
        nextRun: task.nextRunTime,
        lastRun: task.lastRunTime,
      }
    })
  } catch {
    return []
  }
}
