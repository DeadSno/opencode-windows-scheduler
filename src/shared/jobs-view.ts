import { getSchedulerBackend } from "../core/scheduler/index.js"
import { latestHistoryByTask, loadHistory, type HistoryRecord } from "../history.js"
import {
  loadTaskDefinitions,
  type TaskDefinition,
} from "../task-transfer.js"
import type { ScheduledTaskInfo } from "../types.js"

export type JobStatus = "running" | "success" | "error" | "partial" | "idle" | "unknown"

export interface JobView {
  name: string
  status: JobStatus
  /** Задача поставлена на паузу в планировщике ОС. */
  paused?: boolean
  nextRun?: string
  lastRun?: string
  /** Для клона матрицы — имя родительской задачи. */
  matrixParentId?: string
  /** true — задача является родителем матрицы (шаблоном fan-out). */
  isMatrixParent?: boolean
}

/** Строка панели: задача и её отступ в дереве матрицы. */
export interface JobDisplayRow {
  job: JobView
  /** 0 — корневая задача, 1 — клон матрицы. */
  depth: number
}

/**
 * Упорядочивает задачи для TUI: родитель матрицы идёт первым, сразу за ним —
 * его клоны с отступом. Клоны без родителя (осиротевшие) остаются корневыми,
 * чтобы задача не исчезла из панели.
 */
export function groupJobsForDisplay(jobs: readonly JobView[]): JobDisplayRow[] {
  const byName = new Map<string, JobView[]>()
  for (const job of jobs) {
    const key = job.name.toLowerCase()
    const list = byName.get(key) ?? []
    list.push(job)
    byName.set(key, list)
  }

  const children = new Map<string, JobView[]>()
  const roots: JobView[] = []
  for (const job of jobs) {
    const parent = job.matrixParentId?.trim().toLowerCase()
    if (parent && byName.has(parent) && parent !== job.name.toLowerCase()) {
      const list = children.get(parent) ?? []
      list.push(job)
      children.set(parent, list)
    } else {
      roots.push(job)
    }
  }

  const byNameAsc = (a: JobView, b: JobView) => a.name.localeCompare(b.name)
  roots.sort(byNameAsc)
  for (const list of children.values()) list.sort(byNameAsc)

  const rows: JobDisplayRow[] = []
  for (const root of roots) {
    rows.push({ job: root, depth: 0 })
    for (const child of children.get(root.name.toLowerCase()) ?? []) {
      rows.push({ job: child, depth: 1 })
    }
  }
  return rows
}

/**
 * Перемещает выбор по строкам панели с зацикливанием.
 * Возвращает имя задачи, которое нужно выделить, либо undefined для пустого списка.
 */
export function nextJobSelection(
  rows: readonly JobDisplayRow[],
  currentName: string | undefined,
  delta: number
): string | undefined {
  if (rows.length === 0) return undefined
  const current = currentName?.trim().toLowerCase()
  let index = rows.findIndex((row) => row.job.name.toLowerCase() === current)
  if (index === -1) index = delta > 0 ? -1 : 0
  const step = delta === 0 ? 1 : delta
  index = ((index + step) % rows.length + rows.length) % rows.length
  return rows[index]?.job.name
}

/**
 * Готовит текст лога для диалога TUI: оставляет последние строки и
 * подставляет пояснение, если лога ещё нет.
 */
export function formatJobLog(
  logs: string | undefined,
  error: string | undefined,
  maxLines = 40
): string {
  const source = logs?.trim() ? logs : error?.trim()
  if (!source) return "Лог пуст."
  const limit = Math.max(1, Math.min(Math.floor(maxLines), 200))
  const lines = source.replace(/\r\n/g, "\n").split("\n")
  return lines.slice(-limit).join("\n")
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
 * Собирает панельное представление из уже прочитанных данных.
 * Вынесено отдельно, чтобы логику статусов и матричных связей можно было
 * проверить без реального планировщика.
 */
export function buildJobsView(
  tasks: readonly ScheduledTaskInfo[],
  history: readonly HistoryRecord[],
  definitions: readonly TaskDefinition[]
): JobView[] {
  const latest = latestHistoryByTask(history)
  const defs = new Map(
    definitions.map((definition) => [definition.name.toLowerCase(), definition])
  )
  return tasks.map((task) => {
    const name = task.taskName
    const record = latest.get(name.toLowerCase())
    const definition = defs.get(name.toLowerCase())
    const matrixParentId = definition?.matrixParentId?.trim()
    return {
      name,
      status: historyStatus(record),
      paused: Boolean(task.paused),
      nextRun: task.nextRunTime,
      lastRun: task.lastRunTime,
      ...(matrixParentId ? { matrixParentId } : {}),
      ...(definition?.matrix || definition?.isMatrixParent
        ? { isMatrixParent: true }
        : {}),
    }
  })
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
    const [tasks, history, definitions] = await Promise.all([
      backend.listTasks(),
      loadHistory(),
      loadTaskDefinitions(),
    ])
    return buildJobsView(tasks, history, definitions)
  } catch {
    return []
  }
}
