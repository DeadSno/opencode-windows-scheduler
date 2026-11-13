/**
 * Dry-Run (Спринт 14): симуляция конвейера задачи без реального запуска.
 *
 * Строит топологический порядок зависимостей, показывает фактические команды,
 * cwd, роли (ограничения инструментов) и оценки по последним запускам.
 * Никогда не исполняет команды — только анализ определений.
 */
import fs from "node:fs";
import { loadTaskDefinitions } from "../task-transfer.js";
import { getHistory } from "../db/history-repo.js";
import { getWorkspace } from "../workspaces.js";
import { expandMatrixTask } from "./matrix.js";
import { nextRun } from "./schedule-v2.js";
import type { TaskDefinition } from "../task-transfer.js";

export interface DryRunRoleScoped {
  allowed?: string[];
  denied?: string[];
}

export interface DryRunTaskItem {
  name: string;
  order: number;
  trigger: "manual" | "cron" | "dag" | "once";
  cwd: string;
  command: string;
  workspace?: { name: string; path: string };
  preFlight?: string | null;
  postFlight?: string | null;
  qualityGate?: string | null;
  roleScoped?: DryRunRoleScoped | null;
  estimatedDurationSec?: number | null;
  estimatedCostUsd?: number | null;
  estimatedTokens?: number | null;
  /** Для клона матрицы — имя родителя-шаблона (Спринт 15). */
  matrixParent?: string;
  /**
   * Эффективное расписание cron-задачи (Спринт 19): пояс, окно запуска и
   * ближайшие срабатывания с учётом часового пояса. Позволяет проверить
   * пересчёт cron до регистрации в ОС.
   */
  scheduleDetails?: {
    cron: string;
    timezone: string | null;
    notBefore: string | null;
    notAfter: string | null;
    pausedUntil: string | null;
    nextRuns: string[];
  };
}

export interface DryRunTotals {
  estimatedDurationSec?: number | null;
  estimatedCostUsd?: number | null;
  estimatedTokens?: number | null;
}

export interface DryRunReport {
  success: boolean;
  taskName: string;
  tasks: DryRunTaskItem[];
  totals: DryRunTotals;
  warnings: string[];
}

/** Сколько последних успешных/любых запусков усредняем для оценки. */
const ESTIMATE_SAMPLE = 10;

/** Средняя цена за 1K токенов (должна совпадать с dashboards/server.ts). */
export const ESTIMATED_COST_PER_1K_TOKENS_USD = 0.003;

/** Опасные паттерны, о которых обязательно предупреждаем. */
const DANGEROUS_PATTERNS: Array<{ test: RegExp; message: string }> = [
  { test: /rm\s+-rf\s+\/(?:\s|$)/, message: "возможна рекурсивная очистка корня файловой системы (`rm -rf /`)" },
  { test: /git\s+push\s+.*--force(?:\s|$)/, message: "принудительный push в git (`git push --force`)" },
];

/**
 * Симулирует конвейер задачи: сама задача + все зависимости (dependsOn)
 * в топологическом порядке. Возвращает отчёт без реального запуска.
 */
export async function simulatePipeline(taskName: string): Promise<DryRunReport> {
  const warnings: string[] = [];

  const allDefs = await loadTaskDefinitions();
  const rootLower = taskName.trim().toLowerCase();
  const root = allDefs.find((d) => d.name.toLowerCase() === rootLower);
  if (!root) {
    throw new Error(`Задача "${taskName}" не найдена.`);
  }

  // Собираем подграф зависимостей рекурсивно, обнаруживая циклы.
  const byLower = new Map<string, TaskDefinition>(allDefs.map((d) => [d.name.toLowerCase(), d]));
  const visited = new Map<string, TaskDefinition>(); // lower -> def
  const visiting = new Set<string>();
  const warningsPerTask = new Map<string, string[]>();

  const collect = (lowerName: string): TaskDefinition | undefined => {
    if (visiting.has(lowerName)) {
      const list = warningsPerTask.get(lowerName) ?? [];
      list.push(`Обнаружена циклическая зависимость вокруг задачи "${lowerName}" — конвейер разорван на этом узле.`);
      warningsPerTask.set(lowerName, list);
      return undefined;
    }
    const cached = visited.get(lowerName);
    if (cached) return cached;
    const def = byLower.get(lowerName);
    if (!def) {
      const list = warningsPerTask.get(lowerName) ?? [];
      list.push(`Зависимость "${lowerName}" не найдена среди задач — узел пропущен.`);
      warningsPerTask.set(lowerName, list);
      return undefined;
    }
    visiting.add(lowerName);
    for (const dep of def.dependsOn ?? []) {
      const depLower = (dep ?? "").trim().toLowerCase();
      if (depLower) collect(depLower);
    }
    visiting.delete(lowerName);
    visited.set(lowerName, def);
    return def;
  };

  collect(root.name.toLowerCase());

  // Топологический порядок: сначала зависимости (Kahn поверх собранного подграфа).
  const ordered: TaskDefinition[] = [];
  {
    const pending = [...visited.values()];
    const emitted = new Set<string>();
    let progress = true;
    while (pending.length > 0 && progress) {
      progress = false;
      for (let i = 0; i < pending.length; i++) {
        const def = pending[i];
        const deps = (def.dependsOn ?? []).map((d) => (d ?? "").trim().toLowerCase()).filter(Boolean);
        const unmet = deps.filter((d) => visited.has(d) && !emitted.has(d));
        if (unmet.length === 0) {
          ordered.push(def);
          emitted.add(def.name.toLowerCase());
          pending.splice(i, 1);
          i--;
          progress = true;
        }
      }
    }
    // Если остались (цикл), добавляем как есть — предупреждение уже записано.
    for (const leftover of pending) ordered.push(leftover);
  }

  const history = getHistory(null, 1000);
  const historyByTask = new Map<string, typeof history>();
  for (const record of history) {
    const list = historyByTask.get(record.taskName.toLowerCase()) ?? [];
    list.push(record);
    historyByTask.set(record.taskName.toLowerCase(), list);
  }

  const tasks: DryRunTaskItem[] = [];
  let totalDuration: number | null = 0;
  let totalCost: number | null = 0;
  let totalTokens: number | null = 0;

  // Matrix (Спринт 15): родитель сам не выполняется — вместо него в отчёте
  // показываем клоны, по одному на workspace, с их cwd и оценками.
  const units: Array<{ def: TaskDefinition; matrixParent?: string }> = [];
  for (const def of ordered) {
    if (def.matrix) {
      try {
        const clones = expandMatrixTask(def);
        warnings.push(
          `[${def.name}] Родитель матрицы не выполняется сам — показаны ${clones.length} клон(а/ов) по workspace.`
        );
        for (const clone of clones) units.push({ def: clone, matrixParent: def.name });
      } catch (err: any) {
        const list = warningsPerTask.get(def.name.toLowerCase()) ?? [];
        list.push(
          `Матрица не может быть развёрнута: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
        warningsPerTask.set(def.name.toLowerCase(), list);
        warnings.push(`[${def.name}] ${list[list.length - 1]}`);
      }
      continue;
    }
    units.push({ def });
  }

  // Родители матриц с параллельной стратегией: их клоны считаются max, не sum.
  const parallelMatrixParents = new Set(
    allDefs
      .filter((d) => d.matrix && (d.matrix.strategy ?? "parallel") !== "sequential")
      .map((d) => d.name.toLowerCase())
  );
  const parallelGroups = new Map<string, { maxDuration: number }>();

  for (let index = 0; index < units.length; index++) {
    const { def, matrixParent } = units[index];
    const lower = def.name.toLowerCase();
    const taskWarnings = warningsPerTask.get(lower) ?? [];

    // cwd: workspace имеет приоритет над workingDirectory (как в schedulerCreateTask).
    const workspace = def.workspaceId ? getWorkspace(def.workspaceId) : undefined;
    const cwd = workspace?.path || def.workingDirectory || def.workdir || "";
    if (!cwd) {
      taskWarnings.push("Рабочая директория не задана явно — будет использована папка текущего проекта.");
    } else {
      try {
        const stat = fs.statSync(cwd);
        if (!stat.isDirectory()) {
          taskWarnings.push(`Путь "${cwd}" существует, но не является директорией.`);
        }
      } catch {
        taskWarnings.push(`Рабочая директория "${cwd}" не существует на диске.`);
      }
    }

    // Триггер: корневая задача (или клон корневой матрицы) — manual,
    // остальные попали в конвейер через dependsOn — dag.
    const triggerType = def.triggerType ?? "cron";
    const trigger: DryRunTaskItem["trigger"] =
      triggerType === "once"
        ? "once"
        : lower === rootLower || (matrixParent && matrixParent.toLowerCase() === rootLower)
          ? "manual"
          : "dag";

    // Команда, которую выполнит обёртка.
    const modelArg = def.model ? ` --model ${def.model}` : "";
    const promptPreview = (def.prompt ?? "").replace(/\s+/g, " ").trim();
    const command = `opencode run${modelArg} "${promptPreview}"`;

    // Оценки: среднее по последним ESTIMATE_SAMPLE записям истории.
    const records = (historyByTask.get(lower) ?? []).filter((r) => r.status === "success");
    let estimatedDurationSec: number | null = null;
    let estimatedCostUsd: number | null = null;
    let estimatedTokens: number | null = null;
    if (records.length === 0) {
      taskWarnings.push("Нет успешных запусков в истории — оценка длительности/токенов/стоимости недоступна.");
    } else {
      const sample = records.slice(0, ESTIMATE_SAMPLE);
      const avg = (pick: (r: (typeof sample)[number]) => number | null | undefined) => {
        const values = sample.map(pick).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
        return values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : null;
      };
      const avgMs = avg((r) => r.durationMs);
      if (avgMs != null) estimatedDurationSec = Math.round(avgMs / 100) / 10;
      estimatedTokens = avg((r) => r.tokens) ?? null;
      if (estimatedTokens != null) {
        estimatedCostUsd = (estimatedTokens / 1000) * ESTIMATED_COST_PER_1K_TOKENS_USD;
      }
    }

    // Проверяем опасные паттерны в промпте и хуках.
    const scanned = [def.prompt, def.beforeScript, def.afterScript, def.qualityGate]
      .filter((s): s is string => typeof s === "string")
      .join("\n")
      .toLowerCase();
    for (const { test, message } of DANGEROUS_PATTERNS) {
      if (test.test(scanned)) {
        taskWarnings.push(`Опасный паттерн: ${message}.`);
      }
    }

    const roleScoped: DryRunRoleScoped | null =
      Array.isArray(def.allowedTools) && def.allowedTools.length > 0
        ? { allowed: def.allowedTools, denied: def.deniedTools }
        : Array.isArray(def.deniedTools) && def.deniedTools.length > 0
          ? { allowed: undefined, denied: def.deniedTools }
          : null;

    // Эффективное расписание cron-задачи (Спринт 19): ближайшие срабатывания
    // считаем в часовом поясе задачи, чтобы dry-run показывал то же время, что
    // увидит планировщик после регистрации.
    let scheduleDetails: DryRunTaskItem["scheduleDetails"];
    if (triggerType === "once" && def.runAt) {
      // Для разовой задачи dry-run показывает единственное запланированное время.
      scheduleDetails = {
        cron: "once",
        timezone: def.timezone ?? null,
        notBefore: def.notBefore ?? null,
        notAfter: def.notAfter ?? null,
        pausedUntil: def.pausedUntil ?? null,
        nextRuns: [def.runAt],
      };
    } else if (triggerType === "cron" && def.schedule) {
      const runs: string[] = [];
      try {
        let cursor = new Date();
        for (let i = 0; i < 3; i++) {
          const next = nextRun(def.schedule, cursor, def.timezone);
          if (!next) break;
          runs.push(next.toISOString());
          cursor = next;
        }
      } catch {
        taskWarnings.push(`Не удалось разобрать cron "${def.schedule}" для расчёта ближайших запусков.`);
      }
      scheduleDetails = {
        cron: def.schedule,
        timezone: def.timezone ?? null,
        notBefore: def.notBefore ?? null,
        notAfter: def.notAfter ?? null,
        pausedUntil: def.pausedUntil ?? null,
        nextRuns: runs,
      };
    }

    tasks.push({
      name: def.name,
      order: index,
      trigger,
      cwd,
      command,
      workspace: workspace ? { name: workspace.name, path: workspace.path } : undefined,
      preFlight: def.beforeScript ?? null,
      postFlight: def.afterScript ?? null,
      qualityGate: def.qualityGate ?? null,
      roleScoped,
      estimatedDurationSec,
      estimatedCostUsd: estimatedCostUsd != null ? Math.round(estimatedCostUsd * 10000) / 10000 : null,
      estimatedTokens: estimatedTokens != null ? Math.round(estimatedTokens) : null,
      ...(matrixParent ? { matrixParent } : {}),
      ...(scheduleDetails ? { scheduleDetails } : {}),
    });

    if (taskWarnings.length > 0) {
      for (const warning of taskWarnings) {
        warnings.push(`[${def.name}] ${warning}`);
      }
    }

    // Суммируем оценки (null не ломает сумму). Для параллельных матриц
    // длительность берём максимумом по группе, а не суммой клонов.
    if (matrixParent && parallelMatrixParents.has(matrixParent.toLowerCase())) {
      const key = matrixParent.toLowerCase();
      const current = parallelGroups.get(key) ?? { maxDuration: 0 };
      current.maxDuration = Math.max(current.maxDuration, estimatedDurationSec ?? 0);
      parallelGroups.set(key, current);
    } else if (totalDuration != null) {
      totalDuration = totalDuration + (estimatedDurationSec ?? 0);
    }
    if (totalTokens != null) totalTokens = totalTokens + (estimatedTokens ?? 0);
    if (totalCost != null) totalCost = totalCost + (estimatedCostUsd ?? 0);
  }

  for (const group of parallelGroups.values()) {
    if (totalDuration != null) totalDuration = totalDuration + group.maxDuration;
  }

  const hasAnyEstimate = tasks.some(
    (t) => t.estimatedDurationSec != null || t.estimatedCostUsd != null || t.estimatedTokens != null
  );
  const totals: DryRunTotals = hasAnyEstimate
    ? {
        estimatedDurationSec: totalDuration != null ? Math.round(totalDuration * 10) / 10 : null,
        estimatedCostUsd: totalCost != null ? Math.round(totalCost * 10000) / 10000 : null,
        estimatedTokens: totalTokens != null ? Math.round(totalTokens) : null,
      }
    : { estimatedDurationSec: null, estimatedCostUsd: null, estimatedTokens: null };

  return {
    success: true,
    taskName: root.name,
    tasks,
    totals,
    warnings,
  };
}
