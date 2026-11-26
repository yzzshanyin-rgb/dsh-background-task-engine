/**
 * task_schedule: manage the link between a task template and a native DSH
 * Schedule entry (PRD FR-002, 14.3).
 *
 * The plugin owns the reference, the host owns the rule. When `ctx.schedule` is
 * not mounted this tool returns TASK_SCHEDULE_UNAVAILABLE while manual runs keep
 * working (PRD FR-012).
 */

import { z } from 'zod'
import type { ContentBlock, ToolDefinitionLike } from '../host.js'
import type { TaskEngine } from '../services/engine.js'
import type { TimingInput } from '../services/schedule-adapter.js'
import { buildTool, out, renderGeneric, taskView, TASK_FIELDS, type JsonSchemaNode , isFailure } from './shared.js'
import { oneLine } from '../utils/text.js'

const TIMING_SCHEMA: JsonSchemaNode = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: {
      type: 'string',
      enum: ['at', 'every', 'rrule', 'cron', 'daily', 'weekly'],
      description: '定时类型：at 一次性时间点；every 固定间隔；rrule 重复规则；cron 5 段表达式；daily 每天；weekly 每周。',
    },
    at: { type: 'string', description: 'kind=at 时必填：RFC3339 时间，例如 2026-12-01T09:00:00+08:00。' },
    everySeconds: { type: 'integer', description: 'kind=every 时必填：间隔秒数（30–2592000）。' },
    rrule: { type: 'string', description: 'kind=rrule 时必填：DTSTART 行 + RRULE 行，用换行分隔。' },
    expression: { type: 'string', description: 'kind=cron 时必填：5 段 Cron，例如 "0 9 * * 1-5"。' },
    timeZone: { type: 'string', description: 'IANA 时区，默认 Asia/Shanghai。' },
    hour: { type: 'integer', description: 'kind=daily/weekly 时使用：0–23。' },
    minute: { type: 'integer', description: 'kind=daily/weekly 时使用：0–59。' },
    dayOfWeek: { type: 'integer', description: 'kind=weekly 时使用：0=周日 … 6=周六。' },
  },
  required: ['kind'],
}

const timingSchema = z.object({
  kind: z.enum(['at', 'every', 'rrule', 'cron', 'daily', 'weekly']),
  at: z.string().trim().max(64).optional(),
  everySeconds: z.number().int().min(30).max(2_592_000).optional(),
  rrule: z.string().max(1000).optional(),
  expression: z.string().trim().max(200).optional(),
  timeZone: z.string().trim().max(64).optional(),
  hour: z.number().int().min(0).max(23).optional(),
  minute: z.number().int().min(0).max(59).optional(),
  dayOfWeek: z.number().int().min(0).max(6).optional(),
})

function toTiming(input: Record<string, unknown>): TimingInput {
  const kind = String(input.kind)
  switch (kind) {
    case 'at':
      return { kind: 'at', at: String(input.at ?? '') }
    case 'every':
      return { kind: 'every', everySeconds: Number(input.everySeconds ?? 0) }
    case 'rrule':
      return { kind: 'rrule', rrule: String(input.rrule ?? '') }
    case 'cron':
      return {
        kind: 'cron',
        expression: String(input.expression ?? ''),
        ...(input.timeZone ? { timeZone: String(input.timeZone) } : {}),
      }
    case 'daily':
      return {
        kind: 'daily',
        hour: Number(input.hour ?? 0),
        minute: Number(input.minute ?? 0),
        ...(input.timeZone ? { timeZone: String(input.timeZone) } : {}),
      }
    case 'weekly':
      return {
        kind: 'weekly',
        dayOfWeek: Number(input.dayOfWeek ?? 0),
        hour: Number(input.hour ?? 0),
        minute: Number(input.minute ?? 0),
        ...(input.timeZone ? { timeZone: String(input.timeZone) } : {}),
      }
    default:
      throw new Error(`不支持的 timing.kind: ${kind}`)
  }
}

export function createScheduleTool(engine: () => TaskEngine): ToolDefinitionLike {
  return buildTool(
    {
      name: 'task_schedule',
      description:
        '管理任务模板与 DSH 原生定时规则的关联：create 创建并关联、update 修改规则、pause / resume 暂停恢复、delete 解除关联、run_now 立即运行一次、status 查看宿主真实状态。'
        + '插件只保存 scheduleId 引用，不复制 Cron 状态；Schedule 不可用时返回 TASK_SCHEDULE_UNAVAILABLE，手动 task_run 仍可正常使用。',
      parameters: {
        taskId: { type: 'string', description: '任务 ID。' },
        action: {
          type: 'string',
          enum: ['create', 'update', 'pause', 'resume', 'delete', 'run_now', 'status'],
          description: '要执行的操作。',
        },
        timing: TIMING_SCHEMA,
        scheduleRule: {
          type: 'string',
          description: '可选：直接给出重复规则的简写，等价于 timing.kind=rrule 的 rrule 字段。',
        },
      },
      args: z.object({
        taskId: z.string().trim().min(4).max(64),
        action: z.enum(['create', 'update', 'pause', 'resume', 'delete', 'run_now', 'status']),
        timing: timingSchema.optional(),
        scheduleRule: z.string().trim().max(1000).optional(),
      }),
      output: out(
        {
          ...TASK_FIELDS,
          action: { type: 'string' },
          scheduleId: { type: 'string' },
          scheduleAvailable: { type: 'boolean' },
          liveStatus: { type: 'string' },
          nextOccurrence: { type: 'string' },
          note: { type: 'string' },
        },
        ['action'],
      ),
      render: (args, value) => {
        const record = value as Record<string, unknown>
        if (isFailure(value)) return renderGeneric(args, value)
        const lines: string[] = [`操作：${String(record.action ?? '')}`]
        if (record.taskId) lines.push(`任务：${oneLine(String(record.title ?? ''), 40)}（${String(record.taskId)}）`)
        if (record.scheduleId) lines.push(`scheduleId：${String(record.scheduleId)}`)
        if (record.liveStatus) lines.push(`宿主状态：${String(record.liveStatus)}`)
        if (record.nextOccurrence) lines.push(`下次触发：${String(record.nextOccurrence)}`)
        if (record.note) lines.push(String(record.note))
        if (record.scheduleAvailable === false) lines.push('当前宿主未挂载 Schedule，定时功能不可用（手动执行不受影响）。')
        return [{ type: 'text', text: lines.join('\n') } as ContentBlock]
      },
      async execute(args, active) {
        const sessionId = String(args.sessionId)
        const taskId = String(args.taskId)
        const action = String(args.action) as
          | 'create'
          | 'update'
          | 'pause'
          | 'resume'
          | 'delete'
          | 'run_now'
          | 'status'
        const timing = args.timing as Record<string, unknown> | undefined

        if (action !== 'status' && !active.scheduleAdapter.available) {
          return {
            action,
            scheduleAvailable: false,
            note: '当前宿主未挂载 ctx.schedule，定时功能不可用；请用 task_run 手动执行任务，或在启用 Schedule 后重试。',
            ...(await safeTask(active, sessionId, taskId)),
          }
        }

        switch (action) {
          case 'create': {
            const created = await active.taskService.scheduleCreate({
              sessionId,
              taskId,
              timing: scheduleRuleOf(timing, args.scheduleRule as string | undefined),
            })
            return {
              ...taskView(created),
              action,
              scheduleAvailable: true,
              scheduleId: created.scheduleId,
              note: '定时规则已创建并关联；到期投递只表示已触发，TaskRun 状态仍需由 task_run_begin / task_run_finish 更新。',
            }
          }
          case 'update': {
            const updated = await active.taskService.scheduleUpdate({
              sessionId,
              taskId,
              timing: scheduleRuleOf(timing, args.scheduleRule as string | undefined),
            })
            return { ...taskView(updated), action, scheduleAvailable: true }
          }
          case 'pause': {
            const result = await active.taskService.scheduleSetActive({ sessionId, taskId, active: false })
            return {
              ...taskView(result.task),
              action,
              scheduleAvailable: true,
              note: result.changed ? '定时规则已暂停' : '定时规则此前已处于暂停状态',
            }
          }
          case 'resume': {
            const result = await active.taskService.scheduleSetActive({ sessionId, taskId, active: true })
            return {
              ...taskView(result.task),
              action,
              scheduleAvailable: true,
              note: result.changed ? '定时规则已恢复，按下一个未来时间点触发' : '定时规则此前已在运行',
            }
          }
          case 'delete': {
            const result = await active.taskService.scheduleDelete({ sessionId, taskId })
            return {
              ...taskView(result.task),
              action,
              scheduleAvailable: true,
              note: result.alreadyGone ? '宿主中已无该定时规则，仅解除本地关联' : '定时规则已删除，本地关联已解除',
            }
          }
          case 'run_now': {
            const result = await active.taskService.scheduleRunNow({ sessionId, taskId })
            return {
              ...taskView(await taskOf(active, sessionId, taskId)),
              action,
              scheduleAvailable: true,
              note: result.pending
                ? '该定时规则已有一次执行占用投递位，本次未重复投递'
                : '已请求宿主立即投递一次；投递成功不等于任务完成，仍需走 task_run_begin',
            }
          }
          case 'status':
          default: {
            const status = await active.taskService.scheduleStatus({ sessionId, taskId })
            const task = await taskOf(active, sessionId, taskId)
            return {
              ...taskView(task),
              action: 'status',
              scheduleAvailable: status.available,
              ...(status.ref ? { scheduleId: status.ref.scheduleId, liveStatus: String(status.live?.status ?? status.ref.state) } : {}),
              ...(status.live?.scheduledAt ? { nextOccurrence: status.live.scheduledAt } : {}),
              ...(status.ref ? {} : { note: '该任务尚未关联定时规则' }),
            }
          }
        }
      },
    },
    engine,
  )
}

function scheduleRuleOf(timing: Record<string, unknown> | undefined, scheduleRule: string | undefined): TimingInput {
  if (timing && timing.kind) return toTiming(timing)
  if (scheduleRule) return { kind: 'rrule', rrule: scheduleRule }
  throw new Error('需要提供 timing 或 scheduleRule')
}

async function taskOf(active: TaskEngine, sessionId: string, taskId: string) {
  return active.taskService.get(sessionId, taskId, { includeRuns: false }).task
}

async function safeTask(active: TaskEngine, sessionId: string, taskId: string): Promise<Record<string, unknown>> {
  try {
    const task = await taskOf(active, sessionId, taskId)
    return { taskId: task.taskId, title: task.title, status: task.status }
  } catch {
    return {}
  }
}
