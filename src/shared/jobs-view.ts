export type JobStatus = "running" | "success" | "error" | "unknown"

export interface JobView {
  name: string
  status: JobStatus
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
    default:
      return "?"
  }
}

/**
 * Возвращает список задач планировщика в едином формате для TUI и GUI.
 *
 * TODO (следующая итерация): подключить реальные данные через RPC / context.client
 * (вызов серверного list_jobs). Пока возвращается заглушка и в панели отображается
 * текст "Задач пока нет".
 */
export async function getJobsView(context: unknown): Promise<JobView[]> {
  // Прямой доступ к серверному list_jobs из TUI/GUI-рантайма на этом этапе
  // требует отдельной RPC-инфраструктуры, поэтому возвращаем пустой массив.
  return []
}
