/**
 * DSH Schedule adapter (PRD 4.5, 8.3, FR-002, FR-008; acceptance 14.3).
 *
 * The plugin never implements its own scheduler: occurrences, catch-up and
 * delivery are owned by `ctx.schedule`. This adapter only
 *  - translates the plugin's timing input into a documented host timing,
 *  - stores the returned scheduleId on the task (`scheduleRef`),
 *  - maps host failures onto TASK_SCHEDULE_* codes so a failed rule update is
 *    never reported as success.
 *
 * When `ctx.schedule` is not mounted every method throws
 * TASK_SCHEDULE_UNAVAILABLE and manual task execution keeps working
 * (PRD FR-012).
 */

import type { ScheduleRecordLike, ScheduleServiceLike } from '../host.js'
import { TaskEngineError, sanitizeMessage } from '../errors.js'
import { buildSchedulePrompt } from '../prompt/guidance.js'
import { isOlderThanMinutes } from '../utils/time.js'

export type TimingInput =
  | { kind: 'at'; at: string }
  | { kind: 'every'; everySeconds: number }
  | { kind: 'rrule'; rrule: string }
  | { kind: 'cron'; expression: string; timeZone?: string }
  | { kind: 'daily'; hour: number; minute: number; timeZone?: string }
  | { kind: 'weekly'; dayOfWeek: number; hour: number; minute: number; timeZone?: string }

const DEFAULT_TIME_ZONE = 'Asia/Shanghai'
const DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const

export interface HostTiming {
  kind: string
  [key: string]: unknown
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function assertIntegerInRange(value: unknown, min: number, max: number, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new TaskEngineError('TASK_INVALID_ARGUMENTS', `${field} 必须是 ${min}–${max} 的整数`)
  }
  return value
}

function buildRruleFromWallClock(timeZone: string, hour: number, minute: number, weeklyDay?: number): string {
  const now = new Date()
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(hour)}${pad(minute)}00`
  const rule = weeklyDay === undefined ? 'FREQ=DAILY' : `FREQ=WEEKLY;BYDAY=${DAY_CODES[weeklyDay]}`
  return `DTSTART;TZID=${timeZone}:${stamp}\nRRULE:${rule}`
}

/**
 * Translate validated timing input into the host's documented timing shapes.
 * Only `at`, `every`, `rrule` and `cron` are passed through; daily/weekly are
 * expressed as an equivalent RRULE so the plugin depends on one less host shape.
 */
export function toHostTiming(input: TimingInput): HostTiming {
  switch (input.kind) {
    case 'at': {
      const millis = Date.parse(input.at)
      if (!Number.isFinite(millis)) {
        throw new TaskEngineError('TASK_INVALID_ARGUMENTS', 'at 必须是可解析的 RFC3339 时间，例如 2026-12-01T09:00:00+08:00')
      }
      if (millis < Date.now() - 60_000) {
        throw new TaskEngineError('TASK_INVALID_ARGUMENTS', 'at 必须晚于当前时间')
      }
      return { kind: 'at', at: new Date(millis).toISOString() }
    }
    case 'every': {
      const seconds = assertIntegerInRange(input.everySeconds, 30, 30 * 24 * 3600, 'everySeconds')
      return { kind: 'every', every_seconds: seconds }
    }
    case 'rrule': {
      const rule = String(input.rrule ?? '').trim()
      if (!/RRULE:/i.test(rule)) {
        throw new TaskEngineError('TASK_INVALID_ARGUMENTS', 'rrule 必须包含 RRULE: 行')
      }
      if (rule.length > 1000) {
        throw new TaskEngineError('TASK_INVALID_ARGUMENTS', 'rrule 过长（最多 1000 字符）')
      }
      return { kind: 'rrule', rrule: rule }
    }
    case 'cron': {
      const expression = String(input.expression ?? '').trim()
      if (expression.split(/\s+/).length !== 5) {
        throw new TaskEngineError('TASK_INVALID_ARGUMENTS', 'cron 表达式必须是 5 段（分 时 日 月 周）')
      }
      const timeZone = input.timeZone ?? DEFAULT_TIME_ZONE
      return { kind: 'cron', cron: { expression, time_zone: timeZone } }
    }
    case 'daily': {
      const hour = assertIntegerInRange(input.hour, 0, 23, 'hour')
      const minute = assertIntegerInRange(input.minute, 0, 59, 'minute')
      const timeZone = input.timeZone ?? DEFAULT_TIME_ZONE
      return { kind: 'rrule', rrule: buildRruleFromWallClock(timeZone, hour, minute) }
    }
    case 'weekly': {
      const dayOfWeek = assertIntegerInRange(input.dayOfWeek, 0, 6, 'dayOfWeek')
      const hour = assertIntegerInRange(input.hour, 0, 23, 'hour')
      const minute = assertIntegerInRange(input.minute, 0, 59, 'minute')
      const timeZone = input.timeZone ?? DEFAULT_TIME_ZONE
      return { kind: 'rrule', rrule: buildRruleFromWallClock(timeZone, hour, minute, dayOfWeek) }
    }
    default:
      throw new TaskEngineError('TASK_INVALID_ARGUMENTS', '不支持的 timing.kind')
  }
}

export function describeTiming(timing: TimingInput | HostTiming): string {
  const value = timing as Record<string, unknown>
  switch (value.kind) {
    case 'at':
      return `一次性 · ${String(value.at ?? '')}`
    case 'every':
      return `间隔 · 每 ${String(value.everySeconds ?? value.every_seconds ?? '?')} 秒`
    case 'rrule':
      return `重复规则 · ${String(value.rrule ?? '').replace(/\n/g, ' ')}`
    case 'cron':
      return `Cron · ${String((value.cron as Record<string, unknown> | undefined)?.expression ?? value.expression ?? '')}`
    case 'daily':
      return `每天 · ${pad(Number(value.hour ?? 0))}:${pad(Number(value.minute ?? 0))} (${String(value.timeZone ?? DEFAULT_TIME_ZONE)})`
    case 'weekly':
      return `每周 ${DAY_CODES[Number(value.dayOfWeek ?? 0)] ?? '?'} · ${pad(Number(value.hour ?? 0))}:${pad(Number(value.minute ?? 0))}`
    default:
      return String(value.kind ?? 'unknown')
  }
}

export interface CreateScheduleResult {
  scheduleId: string
  entry: ScheduleRecordLike
}

export class ScheduleAdapter {
  constructor(
    private readonly schedule: ScheduleServiceLike | undefined,
    private readonly log?: { warn(...args: unknown[]): void },
  ) {}

  get available(): boolean {
    return typeof this.schedule?.create === 'function' && typeof this.schedule?.edit === 'function'
  }

  private require(): ScheduleServiceLike {
    if (!this.available || !this.schedule) {
      throw new TaskEngineError(
        'TASK_SCHEDULE_UNAVAILABLE',
        '当前宿主未挂载 Schedule 能力，定时任务不可用；手动任务仍可正常执行',
      )
    }
    return this.schedule
  }

  async create(input: {
    taskId: string
    taskTitle: string
    timing: TimingInput
    sessionId: string
  }): Promise<CreateScheduleResult> {
    const schedule = this.require()
    const hostTiming = toHostTiming(input.timing)
    const title = `后台任务 · ${input.taskTitle}`.slice(0, 120)
    const prompt = buildSchedulePrompt({ taskId: input.taskId, taskTitle: input.taskTitle })
    try {
      const entry = await schedule.create(
        {
          title,
          prompt,
          timing: hostTiming,
          target: { kind: 'session', sessionId: input.sessionId },
        },
        input.sessionId,
      )
      if (!entry || typeof entry.id !== 'string' || entry.id.length === 0) {
        throw new TaskEngineError('TASK_SCHEDULE_FAILED', 'Schedule 创建未返回有效 scheduleId')
      }
      return { scheduleId: entry.id, entry }
    } catch (error) {
      throw this.wrap('创建定时规则', error)
    }
  }

  async update(input: {
    scheduleId: string
    patch: { timing?: TimingInput; title?: string; prompt?: string; active?: boolean }
    sessionId: string
  }): Promise<ScheduleRecordLike> {
    const schedule = this.require()
    const patch: Record<string, unknown> = {}
    if (input.patch.timing) patch.timing = toHostTiming(input.patch.timing)
    if (input.patch.title) patch.title = input.patch.title.slice(0, 120)
    if (input.patch.prompt) patch.prompt = input.patch.prompt
    if (input.patch.active !== undefined) patch.active = input.patch.active
    try {
      const result = await schedule.edit(
        { id: input.scheduleId, action: 'update', patch },
        input.sessionId,
      )
      if ((result as { code?: string }).code) {
        throw new TaskEngineError(
          'TASK_SCHEDULE_FAILED',
          `Schedule 更新失败：${String((result as { code?: string }).code)}`,
        )
      }
      return result as ScheduleRecordLike
    } catch (error) {
      throw this.wrap('更新定时规则', error)
    }
  }

  async remove(scheduleId: string, sessionId: string): Promise<{ deleted: boolean; alreadyGone: boolean }> {
    const schedule = this.require()
    try {
      const result = await schedule.edit({ id: scheduleId, action: 'delete' }, sessionId)
      if (result.deleted) return { deleted: true, alreadyGone: false }
      const code = (result as { code?: string }).code
      if (code === 'schedule_not_found') return { deleted: false, alreadyGone: true }
      throw new TaskEngineError('TASK_SCHEDULE_FAILED', `Schedule 删除失败：${code ?? 'unknown'}`)
    } catch (error) {
      throw this.wrap('删除定时规则', error)
    }
  }

  async view(scheduleId: string): Promise<ScheduleRecordLike | undefined> {
    const schedule = this.require()
    const result = (await schedule.view({ id: scheduleId })) as
      | ScheduleRecordLike
      | { id: string; code: string }
    if ((result as { code?: string }).code === 'schedule_not_found') return undefined
    return result as ScheduleRecordLike
  }

  async runNow(scheduleId: string): Promise<{ pending: boolean; entry?: ScheduleRecordLike }> {
    const schedule = this.require()
    try {
      const result = await schedule.run({ id: scheduleId })
      if ((result as { code?: string }).code === 'schedule_execution_pending') {
        return { pending: true }
      }
      return { pending: false, entry: result as ScheduleRecordLike }
    } catch (error) {
      throw this.wrap('立即运行定时规则', error)
    }
  }

  private wrap(action: string, error: unknown): TaskEngineError {
    if (error instanceof TaskEngineError) return error
    const message = error instanceof Error ? error.message : String(error)
    if (/schedule\/input-invalid|input-invalid/.test(message)) {
      return new TaskEngineError('TASK_SCHEDULE_FAILED', `${action}失败：Schedule 认为参数非法（${sanitizeMessage(message, 200)}）`)
    }
    if (/schedule\/target-archived|target-archived/.test(message)) {
      return new TaskEngineError(
        'TASK_SCHEDULE_FAILED',
        `${action}失败：目标 Session 已归档，请在本会话重新创建定时规则`,
      )
    }
    return new TaskEngineError('TASK_SCHEDULE_FAILED', `${action}失败：${sanitizeMessage(message, 300)}`)
  }
}

/** Loose staleness helper used by diagnostics (kept here to avoid cycles). */
export function scheduleLooksStale(scheduledAt: string | undefined, minutes: number): boolean {
  return isOlderThanMinutes(scheduledAt, minutes)
}
