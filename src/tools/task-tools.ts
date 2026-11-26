/**
 * Task template tools: task_create / task_list / task_get / task_update /
 * task_archive (PRD 4.1, 4.2, 5.2, FR-001).
 */

import { z } from 'zod'
import type { ContentBlock, ToolDefinitionLike } from '../host.js'
import type { TaskEngine } from '../services/engine.js'
import type { StepInput, TaskSummaryRow } from '../services/task-service.js'
import { buildTool, out, renderGeneric, taskView, TASK_FIELDS, STEPS_ARRAY_SCHEMA, type JsonSchemaNode , isFailure } from './shared.js'
import { TASK_STATUSES, type TaskRecord } from '../domain/records.js'
import { oneLine } from '../utils/text.js'
import { shortId } from '../utils/id.js'


/** Input shape accepted by step arrays (mirrors TaskService's StepInput). */
type TaskToolStepInput = StepInput

const stepInput = z.object({
  title: z.string().trim().min(1).max(120),
  instruction: z.string().trim().min(1).max(8000),
  completionCriteria: z.string().trim().max(2000).optional(),
  required: z.boolean().optional(),
})

const STEP_INPUT_SCHEMA: JsonSchemaNode = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string', description: '步骤名称，1–120 字符。' },
    instruction: { type: 'string', description: 'Agent 应完成的明确指令，1–8000 字符。' },
    completionCriteria: { type: 'string', description: '可检查的完成标准；报告 completed 前必须满足。' },
    required: { type: 'boolean', description: '是否必需步骤，默认 true；必需步骤未完成时整体不能成功。' },
  },
  required: ['title', 'instruction'],
}

/** Shared task-list renderer: one line per task, name + status + short id. */
function renderTaskList(items: TaskSummaryRow[], total?: number): ContentBlock[] {
  if (items.length === 0) return [{ type: 'text', text: '（没有符合条件的任务）' }]
  const lines = items.map((item) => {
    const schedule = item.schedule ? ` · 定时 ${item.schedule.state}/${item.schedule.timing}` : ''
    const last = item.lastRun ? ` · 最近 ${item.lastRun.status}` : ' · 尚未运行'
    return `${oneLine(item.title, 40)}  ${item.status}  ${shortId(item.taskId)}${schedule}${last}`
  })
  const header = total === undefined ? `${items.length} 个任务` : `${items.length} 个任务（共 ${total}）`
  return [{ type: 'text', text: `${header}\n${lines.join('\n')}` }]
}

export function createTaskTools(engine: () => TaskEngine): ToolDefinitionLike[] {
  const create = buildTool(
    {
      name: 'task_create',
      description:
        '创建一个可复用的后台任务模板（1–10 个线性步骤）。任务归属于调用方会话，其他会话不可见。'
        + '创建后可用 task_run 手动执行，或用 task_schedule 关联 DSH 原生定时规则。',
      parameters: {
        title: { type: 'string', description: '任务标题，2–80 字符，必填。' },
        description: { type: 'string', description: '任务用途说明（最多 2000 字符）。' },
        steps: {
          type: 'array',
          description: '有序步骤列表，1–10 个；按数组顺序即为执行顺序。',
          items: STEP_INPUT_SCHEMA,
        },
        copyFromTaskId: {
          type: 'string',
          description: '可选：复制一个已有任务的步骤作为模板，省略 steps 时生效。',
        },
      },
      args: z.object({
        title: z.string().trim().min(2).max(80),
        description: z.string().trim().max(2000).optional(),
        steps: z.array(stepInput).optional(),
        copyFromTaskId: z.string().trim().min(4).max(64).optional(),
      }),
      output: out(TASK_FIELDS, ['taskId', 'status', 'revision']),
      render: (args, value) => {
        const record = value as Record<string, unknown>
        if (isFailure(value)) return renderGeneric(args, value)
        const steps = (record.steps ?? []) as Array<Record<string, unknown>>
        const lines = steps.map((step, index) => `${index + 1}. ${String(step.title ?? '')}`)
        return [
          {
            type: 'text',
            text: `已创建任务「${String(record.title ?? '')}」\n`
              + `taskId: ${String(record.taskId ?? '')}\n`
              + `revision: ${String(record.revision ?? 1)} · 步骤 ${String(record.stepCount ?? steps.length)} 个\n`
              + lines.join('\n'),
          },
        ]
      },
      async execute(args, active) {
        const task = await active.taskService.create({
          sessionId: String(args.sessionId),
          title: args.title as string,
          description: args.description as string | undefined,
          steps: args.steps as StepInput[] | undefined,
          copyFromTaskId: args.copyFromTaskId as string | undefined,
        })
        return taskView(task)
      },
    },
    engine,
  )

  const list = buildTool(
    {
      name: 'task_list',
      description:
        '列出当前会话的后台任务模板（默认按更新时间倒序，每页 20 条，最多 100 条）。'
        + '可按状态筛选或按关键词匹配标题/描述。',
      parameters: {
        status: { type: 'string', enum: [...TASK_STATUSES], description: '按模板状态筛选。' },
        query: { type: 'string', description: '关键词，匹配标题或描述（也接受完整 taskId）。' },
        limit: { type: 'integer', description: '每页条数，1–100，默认 20。' },
        cursor: { type: 'string', description: '上一页返回的 nextCursor；省略表示第一页。' },
      },
      args: z.object({
        status: z.enum(TASK_STATUSES).optional(),
        query: z.string().trim().max(200).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        cursor: z.string().max(200).optional(),
      }),
      output: out({
        items: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: true,
            properties: {
              taskId: { type: 'string' },
              title: { type: 'string' },
              status: { type: 'string' },
              revision: { type: 'integer' },
              stepCount: { type: 'integer' },
              updatedAt: { type: 'string' },
              lastRunStatus: { type: 'string' },
              lastRunId: { type: 'string' },
              scheduleState: { type: 'string' },
            },
          },
        },
        nextCursor: { type: 'string' },
        total: { type: 'integer' },
      }, ['items']),
      render: (_args, value) => {
        const record = value as Record<string, unknown>
        if (record.success === false) return renderGeneric(_args, value)
        const items = (record.items ?? []) as TaskSummaryRow[]
        const rendered = renderTaskList(items)
        if (record.nextCursor) {
          rendered.push({ type: 'text', text: `下一页：cursor=${String(record.nextCursor)}` })
        }
        return rendered
      },
      execute(args, active) {
        const page = active.taskService.list({
          sessionId: String(args.sessionId),
          status: args.status as (typeof TASK_STATUSES)[number] | undefined,
          query: args.query as string | undefined,
          limit: args.limit as number | undefined,
          cursor: args.cursor as string | undefined,
        })
        return {
          items: page.items.map((item) => ({
            taskId: item.taskId,
            title: item.title,
            status: item.status,
            revision: item.revision,
            stepCount: item.stepCount,
            updatedAt: item.updatedAt,
            ...(item.lastRun ? { lastRunStatus: item.lastRun.status, lastRunId: item.lastRun.runId } : {}),
            ...(item.schedule ? { scheduleState: item.schedule.state } : {}),
          })),
          ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        }
      },
    },
    engine,
  )

  const get = buildTool(
    {
      name: 'task_get',
      description: '查看一个任务的完整定义（含步骤、定时关联）与最近的运行记录。',
      parameters: {
        taskId: { type: 'string', description: '任务 ID。' },
        includeRuns: { type: 'boolean', description: '是否附带最近 5 次运行摘要，默认 true。' },
      },
      args: z.object({
        taskId: z.string().trim().min(4).max(64),
        includeRuns: z.boolean().optional(),
      }),
      output: out({
        ...TASK_FIELDS,
        recentRuns: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: true,
            properties: {
              runId: { type: 'string' },
              status: { type: 'string' },
              progress: { type: 'integer' },
              startedAt: { type: 'string' },
              finishedAt: { type: 'string' },
            },
          },
        },
      }, ['taskId']),
      render: (args, value) => {
        const record = value as Record<string, unknown>
        if (isFailure(value)) return renderGeneric(args, value)
        const steps = (record.steps ?? []) as Array<Record<string, unknown>>
        const runs = (record.recentRuns ?? []) as Array<Record<string, unknown>>
        const lines = [
          `任务：${String(record.title ?? '')}`,
          `状态：${String(record.status ?? '')} · revision ${String(record.revision ?? '')} · ${steps.length} 步`,
          `taskId：${String(record.taskId ?? '')}`,
        ]
        if (record.schedule) {
          const schedule = record.schedule as Record<string, unknown>
          lines.push(`定时：${String(schedule.state)}（${String(schedule.scheduleId)}）`)
        }
        for (const step of steps) {
          lines.push(`${String(step.order)}. ${String(step.title)}${step.required === false ? '（可选）' : ''}`)
        }
        if (runs.length > 0) {
          lines.push('最近运行：')
          for (const run of runs) {
            lines.push(`· ${String(run.runId)} ${String(run.status)} ${String(run.progress ?? 0)}%`)
          }
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
      execute(args, active) {
        const { task, recentRuns } = active.taskService.get(String(args.sessionId), String(args.taskId), {
          includeRuns: args.includeRuns !== false,
        })
        return {
          ...taskView(task),
          recentRuns: recentRuns.map((run) => ({
            runId: run.runId,
            status: run.status,
            progress: run.progress,
            startedAt: run.startedAt,
            ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
          })),
        }
      },
    },
    engine,
  )

  const update = buildTool(
    {
      name: 'task_update',
      description:
        '修改任务模板（标题、描述、步骤或状态）。必须携带 expectedRevision 做乐观锁；revision 不匹配会返回 TASK_REVISION_CONFLICT。'
        + '把 status 改为 paused 会同步暂停关联的原生定时规则，改为 active 会恢复。',
      parameters: {
        taskId: { type: 'string', description: '任务 ID。' },
        expectedRevision: { type: 'integer', description: '从 task_get 读到的 revision；用于防止覆盖他人的新版本。' },
        title: { type: 'string', description: '新的任务标题（2–80 字符）。' },
        description: { type: 'string', description: '新的任务说明。' },
        steps: {
          type: 'array',
          description: '替换全部步骤（1–10 个，顺序即执行顺序）。',
          items: STEP_INPUT_SCHEMA,
        },
        status: { type: 'string', enum: ['active', 'paused'], description: '启用或暂停任务（归档请用 task_archive）。' },
      },
      args: z.object({
        taskId: z.string().trim().min(4).max(64),
        expectedRevision: z.number().int().min(1),
        title: z.string().trim().min(2).max(80).optional(),
        description: z.string().trim().max(2000).optional(),
        steps: z.array(stepInput).optional(),
        status: z.enum(['active', 'paused']).optional(),
      }),
      output: out(TASK_FIELDS, ['taskId', 'revision']),
      render: (args, value) => {
        const record = value as Record<string, unknown>
        if (isFailure(value)) return renderGeneric(args, value)
        return [
          {
            type: 'text',
            text: `已更新任务「${String(record.title ?? '')}」\n`
              + `taskId: ${String(record.taskId ?? '')} · revision ${String(record.revision ?? '')} · 状态 ${String(record.status ?? '')}`,
          },
        ]
      },
      async execute(args, active) {
        const task = await active.taskService.update({
          sessionId: String(args.sessionId),
          taskId: String(args.taskId),
          expectedRevision: Number(args.expectedRevision),
          title: args.title as string | undefined,
          description: args.description as string | undefined,
          steps: args.steps as StepInput[] | undefined,
          status: args.status as 'active' | 'paused' | undefined,
        })
        return taskView(task)
      },
    },
    engine,
  )

  const archive = buildTool(
    {
      name: 'task_archive',
      description:
        '归档任务（软删除）：任务变为只读，关联的原生定时规则会被删除，但历史运行与步骤记录全部保留。'
        + '存在活动运行时会被拒绝，请先结束或恢复该运行。',
      parameters: {
        taskId: { type: 'string', description: '任务 ID。' },
        expectedRevision: { type: 'integer', description: '从 task_get 读到的 revision。' },
      },
      args: z.object({
        taskId: z.string().trim().min(4).max(64),
        expectedRevision: z.number().int().min(1),
      }),
      output: out({ ...TASK_FIELDS, previousStatus: { type: 'string' } }, ['taskId', 'status']),
      render: (args, value) => {
        const record = value as Record<string, unknown>
        if (isFailure(value)) return renderGeneric(args, value)
        return [
          {
            type: 'text',
            text: `已归档「${String(record.title ?? '')}」（${String(record.taskId ?? '')}）\n`
              + '历史运行记录保留，任务不能再执行或修改。',
          },
        ]
      },
      async execute(args, active) {
        const before = active.taskService.get(String(args.sessionId), String(args.taskId), { includeRuns: false }).task
        const task: TaskRecord = await active.taskService.archive({
          sessionId: String(args.sessionId),
          taskId: String(args.taskId),
          expectedRevision: Number(args.expectedRevision),
        })
        return { ...taskView(task), previousStatus: before.status }
      },
    },
    engine,
  )

  // Exposed so the schedule tool can render step arrays consistently.
  void STEPS_ARRAY_SCHEMA
  return [create, list, get, update, archive]
}
