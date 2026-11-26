/**
 * Configuration schema (PRD 4.4 / FR-012).
 *
 * Exported as `Config` so the DSH loader validates profile config before the
 * plugin is applied. `resolveConfig` re-validates and fills defaults so the
 * engine never runs with out-of-range numbers even when it is constructed
 * directly (tests, embedded use).
 */

import Schema from '@deepseek-ai/schemastery'

export interface EngineConfig {
  maxTasksPerOwner: number
  maxStepsPerTask: number
  maxActiveRunsPerOwner: number
  maxParallelRunsPerTask: number
  defaultTimeoutMinutes: number
  staleRunAfterMinutes: number
  historyRetentionDays: number
  maxSummaryChars: number
}

export const CONFIG_LIMITS = {
  maxTasksPerOwner: { min: 1, max: 1000, default: 100 },
  maxStepsPerTask: { min: 1, max: 10, default: 10 },
  maxActiveRunsPerOwner: { min: 1, max: 20, default: 3 },
  maxParallelRunsPerTask: { min: 1, max: 1, default: 1 },
  defaultTimeoutMinutes: { min: 1, max: 1440, default: 60 },
  staleRunAfterMinutes: { min: 1, max: 1440, default: 30 },
  historyRetentionDays: { min: 1, max: 3650, default: 90 },
  maxSummaryChars: { min: 100, max: 10000, default: 2000 },
} as const

export const Config = Schema.object({
  maxTasksPerOwner: Schema.number()
    .min(1)
    .max(1000)
    .default(100)
    .description('每个 Session 允许保留的未归档任务上限（1–1000）。'),
  maxStepsPerTask: Schema.number()
    .min(1)
    .max(10)
    .default(10)
    .description('单个任务的步骤上限，V1.0 固定为线性 1–10 步。'),
  maxActiveRunsPerOwner: Schema.number()
    .min(1)
    .max(20)
    .default(3)
    .description('每个 Session 同时处于 queued/running 的 TaskRun 上限（1–20）。'),
  maxParallelRunsPerTask: Schema.number()
    .min(1)
    .max(1)
    .default(1)
    .description('同一任务允许的并行运行数，V1.0 固定为 1。'),
  defaultTimeoutMinutes: Schema.number()
    .min(1)
    .max(1440)
    .default(60)
    .description('运行默认超时（分钟）；超时只标记待核验，不自动重启。'),
  staleRunAfterMinutes: Schema.number()
    .min(1)
    .max(1440)
    .default(30)
    .description('启动扫描时，多久没有心跳的 queued/running 运行判定为 interrupted（分钟）。'),
  historyRetentionDays: Schema.number()
    .min(1)
    .max(3650)
    .default(90)
    .description('终态运行记录保留天数（默认 90）。清理永不删除活动运行与任务模板。'),
  maxSummaryChars: Schema.number()
    .min(100)
    .max(10000)
    .default(2000)
    .description('运行/步骤摘要最大字符数（默认 2000），超长截断。'),
}).description('dsh-background-task-engine 配置（所有数值均有下界/上界校验）。')

export const DEFAULT_CONFIG: EngineConfig = {
  maxTasksPerOwner: CONFIG_LIMITS.maxTasksPerOwner.default,
  maxStepsPerTask: CONFIG_LIMITS.maxStepsPerTask.default,
  maxActiveRunsPerOwner: CONFIG_LIMITS.maxActiveRunsPerOwner.default,
  maxParallelRunsPerTask: CONFIG_LIMITS.maxParallelRunsPerTask.default,
  defaultTimeoutMinutes: CONFIG_LIMITS.defaultTimeoutMinutes.default,
  staleRunAfterMinutes: CONFIG_LIMITS.staleRunAfterMinutes.default,
  historyRetentionDays: CONFIG_LIMITS.historyRetentionDays.default,
  maxSummaryChars: CONFIG_LIMITS.maxSummaryChars.default,
}

function readNumber(source: Record<string, unknown>, key: keyof EngineConfig): number {
  const limits = CONFIG_LIMITS[key]
  const raw = source[key]
  if (raw === undefined || raw === null) return limits.default
  const value = typeof raw === 'string' ? Number(raw) : raw
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`配置项 ${key} 必须是整数，收到 ${JSON.stringify(raw)}`)
  }
  if (value < limits.min || value > limits.max) {
    throw new Error(`配置项 ${key} 超出允许范围 ${limits.min}–${limits.max}，收到 ${value}`)
  }
  return value
}

/**
 * Validate a raw config object. Throws (with a message naming the key and the
 * allowed range) instead of clamping, so a misconfigured profile fails loudly.
 */
export function resolveConfig(raw?: unknown): EngineConfig {
  if (raw === undefined || raw === null) return { ...DEFAULT_CONFIG }
  if (typeof raw !== 'object') throw new Error('配置必须是对象')
  const source = raw as Record<string, unknown>
  return {
    maxTasksPerOwner: readNumber(source, 'maxTasksPerOwner'),
    maxStepsPerTask: readNumber(source, 'maxStepsPerTask'),
    maxActiveRunsPerOwner: readNumber(source, 'maxActiveRunsPerOwner'),
    maxParallelRunsPerTask: readNumber(source, 'maxParallelRunsPerTask'),
    defaultTimeoutMinutes: readNumber(source, 'defaultTimeoutMinutes'),
    staleRunAfterMinutes: readNumber(source, 'staleRunAfterMinutes'),
    historyRetentionDays: readNumber(source, 'historyRetentionDays'),
    maxSummaryChars: readNumber(source, 'maxSummaryChars'),
  }
}
