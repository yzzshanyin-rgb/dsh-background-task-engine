/**
 * Execution tools: task_run / task_run_begin / task_step_report /
 * task_run_finish / task_run_history / task_resume (PRD 5.3–5.6, 6.3, FR-005..FR-008).
 */

import { z } from 'zod'
import type { ContentBlock, ToolDefinitionLike } from '../host.js'
import { isFailure } from './shared.js'
import type { JsonSchemaNode } from './shared.js'
import type { TaskEngine } from '../services/engine.js'
import { EXECUTION_PROTOCOL } from '../prompt/guidance.js'
import { elapsedLabel } from '../utils/time.js'
import { shortId } from '../utils/id.js'
import { RUN_STATUSES, type RunStatus } from '../domain/records.js'
import {
  buildTool,
  out,
  progressLine,
  renderGeneric,
  runView,
  RUN_FIELDS,
} from './shared.js'

const ERROR_INPUT: JsonSchemaNode = {
  type: 'object',
  additionalProperties: false,
  properties: {
    code: { type: 'string', description: '简短错误码，例如 GIT_UNREACHABLE。' },
    message: { type: 'string', description: '真实错误摘要（不要包含密钥或凭据）。' },
  },
  required: ['message'],
}

const errorInput = z.object({
  code: z.string().trim().max(64).optional(),
  message: z.string().trim().min(1).max(2000),
})

function renderRun(args: unknown, value: unknown): ContentBlock[] {
  const record = value as Record<string, unknown>
  if (isFailure(value)) return renderGeneric(args, value)
  const steps = (record.steps ?? []) as Array<Record<string, unknown>>
  const mark = (status: string): string =>
    status === 'completed' ? '✓' : status === 'running' ? '●' : status === 'failed' ? '✗' : status === 'skipped' ? '–' : '○'
  const lines = [
    `运行 ${String(record.runId ?? '')} · ${String(record.status ?? '')} · 进度 ${String(record.progress ?? 0)}%`,
    `任务 ${String(record.title ?? record.taskId ?? '')}（revision ${String(record.taskRevision ?? '')}）`,
  ]
  if (record.deduplicated === true) lines.push('该幂等键已存在运行，未重复创建（返回已有记录）')
  for (const step of steps) {
    const suffix = step.errorSummary ? ` — ${String(step.errorSummary)}` : ''
    lines.push(`${mark(String(step.status ?? 'pending'))} ${String(step.order ?? '')}. ${String(step.title ?? '')}${suffix}`)
  }
  if (record.summary) lines.push(`摘要：${String(record.summary)}`)
  if (record.errorSummary) lines.push(`错误：${String(record.errorSummary)}`)
  return [{ type: 'text', text: lines.join('\n') }]
}

export function createRunTools(engine: () => TaskEngine): ToolDefinitionLike[] {
  const run = buildTool(
    {
      name: 'task_run',
      description:
        '手动启动一次任务执行，创建独立的 TaskRun 并返回步骤指令。这是 FR-005 的入口：返回后由当前 Agent 在当前授权上下文中逐步执行。'
        + '同一任务已有活动运行时返回 TASK_ALREADY_RUNNING 并附上现有 runId。\n\n' + EXECUTION_PROTOCOL,
      parameters: {
        taskId: { type: 'string', description: '要执行的任务 ID。' },
        manualRunId: {
          type: 'string',
          description: '可选幂等键：同一个 manualRunId 重复提交不会产生第二个运行。',
        },
        defer: {
          type: 'boolean',
          description: 'true 时创建为 queued，需再调用 task_run_begin 认领；默认直接进入 running。',
        },
        triggerType: { type: 'string', enum: ['manual', 'schedule'], description: '触发来源，手动执行默认 manual。' },
      },
      args: z.object({
        taskId: z.string().trim().min(4).max(64),
        manualRunId: z.string().trim().min(1).max(200).optional(),
        defer: z.boolean().optional(),
        triggerType: z.enum(['manual', 'schedule']).optional(),
      }),
      output: out({ ...RUN_FIELDS, title: { type: 'string' }, deduplicated: { type: 'boolean' } }, ['runId', 'status']),
      render: renderRun,
      async execute(args, active) {
        const result = await active.runService.start({
          sessionId: String(args.sessionId),
          taskId: String(args.taskId),
          manualRunId: args.manualRunId as string | undefined,
          defer: args.defer === true,
          triggerType: (args.triggerType as 'manual' | 'schedule' | undefined) ?? 'manual',
          source: 'task_run',
        })
        return { ...runView(result.run, result.steps), deduplicated: result.deduplicated }
      },
    },
    engine,
  )

  const begin = buildTool(
    {
      name: 'task_run_begin',
      description:
        '认领/开始一次运行：可用 taskId 新开一次执行，也可用 runId 把 queued 运行切换为 running。'
        + '收到 Schedule 投递消息时，把消息原文放进 triggerPayload，插件会自动识别 taskId、scheduleId 与 occurrenceKey，并用 scheduleId+occurrenceKey 去重。'
        + '返回 runId、模板快照与步骤列表。\n\n' + EXECUTION_PROTOCOL,
      parameters: {
        taskId: { type: 'string', description: '任务 ID；省略时必须能从 triggerPayload 识别。' },
        runId: { type: 'string', description: '已有 queued 运行的 ID；提供时只做 queued → running。' },
        triggerPayload: {
          type: 'string',
          description: '触发消息原文（含 task_id_json / schedule_id_json / occurrence_at），用于定时触发识别。',
        },
        triggerType: { type: 'string', enum: ['manual', 'schedule'], description: '触发来源；省略时按是否识别到定时载荷推断。' },
        scheduleId: { type: 'string', description: '显式指定 Schedule ID（通常无需手填）。' },
        occurrenceKey: { type: 'string', description: '显式指定本次投递的唯一键（通常取自 occurrence_at）。' },
        idempotencyKey: { type: 'string', description: '自定义幂等键；相同键不会重复创建运行。' },
      },
      args: z.object({
        taskId: z.string().trim().min(4).max(64).optional(),
        runId: z.string().trim().min(4).max(64).optional(),
        triggerPayload: z.string().max(20000).optional(),
        triggerType: z.enum(['manual', 'schedule']).optional(),
        scheduleId: z.string().trim().max(128).optional(),
        occurrenceKey: z.string().trim().max(256).optional(),
        idempotencyKey: z.string().trim().max(280).optional(),
      }).refine((value) => Boolean(value.taskId || value.runId || value.triggerPayload), {
        message: '需要提供 taskId、runId 或 triggerPayload 之一',
      }),
      output: out({ ...RUN_FIELDS, title: { type: 'string' }, deduplicated: { type: 'boolean' } }, ['runId', 'status']),
      render: (args, value) => {
        const rendered = renderRun(args, value)
        const record = value as Record<string, unknown>
        if (!isFailure(value)) {
          rendered.push({
            type: 'text',
            text: '下一步：按 order 顺序对每个步骤调用 task_step_report(action="started" / "completed")，'
              + '全部必需步骤完成后调用 task_run_finish(status="succeeded")。',
          })
        }
        return rendered
      },
      async execute(args, active) {
        const sessionId = String(args.sessionId)
        if (args.runId) {
          const result = await active.runService.begin({
            sessionId,
            runId: String(args.runId),
            source: 'task_run_begin',
          })
          return { ...runView(result.run, result.steps), deduplicated: result.deduplicated }
        }
        const result = await active.runService.start({
          sessionId,
          taskId: args.taskId as string | undefined,
          triggerPayload: args.triggerPayload as string | undefined,
          triggerType: args.triggerType as 'manual' | 'schedule' | undefined,
          scheduleId: args.scheduleId as string | undefined,
          occurrenceKey: args.occurrenceKey as string | undefined,
          idempotencyKey: args.idempotencyKey as string | undefined,
          source: 'task_run_begin',
        })
        return { ...runView(result.run, result.steps), deduplicated: result.deduplicated }
      },
    },
    engine,
  )

  const stepReport = buildTool(
    {
      name: 'task_step_report',
      description:
        '上报某一步骤的状态：started / completed / failed / skipped。步骤必须按 order 顺序推进，且只能报告快照内存在的 stepId。'
        + '所有进度都由持久化记录计算（completed 必需步骤数 / 必需步骤总数），不依赖调用方自报。',
      parameters: {
        runId: { type: 'string', description: '运行 ID。' },
        stepId: { type: 'string', description: '步骤 ID（来自 task_run_begin 返回的步骤列表）。' },
        action: {
          type: 'string',
          enum: ['started', 'completed', 'failed', 'skipped'],
          description: 'started 开始；completed 满足 completionCriteria 后才可报告；failed 必须给出 error；skipped 表示本次不执行。',
        },
        summary: { type: 'string', description: '基于实际结果的简短摘要（最多 2000 字符，超长自动截断）。' },
        error: ERROR_INPUT,
      },
      args: z.object({
        runId: z.string().trim().min(4).max(64),
        stepId: z.string().trim().min(4).max(64),
        action: z.enum(['started', 'completed', 'failed', 'skipped']),
        summary: z.string().trim().max(2000).optional(),
        error: errorInput.optional(),
      }),
      output: out(
        {
          ...RUN_FIELDS,
          stepId: { type: 'string' },
          stepStatus: { type: 'string' },
          progress: { type: 'integer' },
          nextStepId: { type: 'string' },
        },
        ['runId', 'stepId', 'stepStatus', 'progress'],
      ),
      render: (args, value) => {
        const record = value as Record<string, unknown>
        if (isFailure(value)) return renderGeneric(args, value)
        const steps = (record.steps ?? []) as Array<Record<string, unknown>>
        const mark = (status: string): string =>
          status === 'completed' ? '✓' : status === 'running' ? '●' : status === 'failed' ? '✗' : status === 'skipped' ? '–' : '○'
        const lines = [
          `步骤 ${String(record.stepId ?? '')} → ${String(record.stepStatus ?? '')}`,
          `进度 ${String(record.progress ?? 0)}%`,
        ]
        for (const step of steps) lines.push(`${mark(String(step.status ?? ''))} ${String(step.order ?? '')}. ${String(step.title ?? '')}`)
        if (record.nextStepId) lines.push(`下一步：${String(record.nextStepId)}`)
        else lines.push('所有步骤已结束，请调用 task_run_finish 提交运行结果。')
        return [{ type: 'text', text: lines.join('\n') }]
      },
      async execute(args, active) {
        const result = await active.runService.reportStep({
          sessionId: String(args.sessionId),
          runId: String(args.runId),
          stepId: String(args.stepId),
          action: args.action as 'started' | 'completed' | 'failed' | 'skipped',
          summary: args.summary as string | undefined,
          error: args.error as { code?: string; message: string } | undefined,
        })
        const nextStepId = result.run.currentStepId
        return {
          ...runView(result.run, active.runService.stepsOf(result.run.runId)),
          stepId: result.step.stepId,
          stepStatus: result.step.status,
          progress: result.run.progress,
          ...(nextStepId ? { nextStepId } : {}),
        }
      },
    },
    engine,
  )

  const finish = buildTool(
    {
      name: 'task_run_finish',
      description:
        '提交运行结果，把 TaskRun 置为 succeeded / failed / blocked / interrupted / skipped。'
        + 'succeeded 要求全部必需步骤都已 completed；failed 要求先有失败步骤或给出 error；blocked 必须在 summary 中写明等待事项。'
        + '阻断类状态（blocked）不是终态，可用 task_resume 创建新运行继续。',
      parameters: {
        runId: { type: 'string', description: '运行 ID。' },
        status: {
          type: 'string',
          enum: ['succeeded', 'failed', 'blocked', 'interrupted', 'skipped'],
          description: '终态结果；blocked 表示等待用户处理。',
        },
        summary: { type: 'string', description: '结果摘要（最多 2000 字符）。' },
        error: ERROR_INPUT,
      },
      args: z.object({
        runId: z.string().trim().min(4).max(64),
        status: z.enum(['succeeded', 'failed', 'blocked', 'interrupted', 'skipped']),
        summary: z.string().trim().max(2000).optional(),
        error: errorInput.optional(),
      }),
      output: out(RUN_FIELDS, ['runId', 'status']),
      render: (args, value) => {
        const record = value as Record<string, unknown>
        if (isFailure(value)) return renderGeneric(args, value)
        const icon =
          record.status === 'succeeded' ? '✅' : record.status === 'blocked' ? '⏸' : record.status === 'failed' ? '❌' : '⚠️'
        const lines = [
          `${icon} 运行 ${String(record.runId ?? '')} → ${String(record.status ?? '')}`,
          `进度 ${String(record.progress ?? 0)}%（${String(record.completedRequired ?? 0)}/${String(record.totalRequired ?? 0)} 必需步骤）`,
          `耗时 ${String(record.duration ?? elapsedLabel(String(record.startedAt ?? ''), String(record.finishedAt ?? '')))}`,
        ]
        if (record.summary) lines.push(`摘要：${String(record.summary)}`)
        if (record.errorSummary) lines.push(`错误：${String(record.errorSummary)}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
      async execute(args, active) {
        const updated = await active.runService.finish({
          sessionId: String(args.sessionId),
          runId: String(args.runId),
          status: args.status as 'succeeded' | 'failed' | 'blocked' | 'interrupted' | 'skipped',
          summary: args.summary as string | undefined,
          error: args.error as { code?: string; message: string } | undefined,
        })
        return runView(updated, active.runService.stepsOf(updated.runId))
      },
    },
    engine,
  )

  const history = buildTool(
    {
      name: 'task_run_history',
      description:
        '查询某个任务的运行历史（默认每页 20 条，最多 100 条），包含状态、进度、耗时、摘要与步骤状态。'
        + '只返回保留期内的记录（默认 90 天）。',
      parameters: {
        taskId: { type: 'string', description: '任务 ID。' },
        status: { type: 'string', enum: [...RUN_STATUSES], description: '按运行状态筛选。' },
        limit: { type: 'integer', description: '每页条数，1–100，默认 20。' },
        cursor: { type: 'string', description: '上一页返回的 nextCursor。' },
      },
      args: z.object({
        taskId: z.string().trim().min(4).max(64),
        status: z.enum(RUN_STATUSES).optional(),
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
              runId: { type: 'string' },
              status: { type: 'string' },
              triggerType: { type: 'string' },
              progress: { type: 'integer' },
              startedAt: { type: 'string' },
              finishedAt: { type: 'string' },
              summary: { type: 'string' },
              errorSummary: { type: 'string' },
              resumesRunId: { type: 'string' },
              steps: { type: 'array', items: { type: 'object', additionalProperties: true } },
            },
          },
        },
        nextCursor: { type: 'string' },
      }, ['items']),
      render: (args, value) => {
        const record = value as Record<string, unknown>
        if (isFailure(value)) return renderGeneric(args, value)
        const items = (record.items ?? []) as Array<Record<string, unknown>>
        if (items.length === 0) return [{ type: 'text', text: '（没有运行记录）' }]
        const lines = items.map(
          (item) =>
            `${shortId(String(item.runId ?? ''))}  ${String(item.status ?? '')}  ${String(item.progress ?? 0)}%  `
            + `${String(item.triggerType ?? '')}  ${String(item.startedAt ?? '').slice(0, 19).replace('T', ' ')}`
            + (item.summary ? `  ${String(item.summary).slice(0, 40)}` : ''),
        )
        if (record.nextCursor) lines.push(`下一页：cursor=${String(record.nextCursor)}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
      execute(args, active) {
        const page = active.runService.history({
          sessionId: String(args.sessionId),
          taskId: String(args.taskId),
          status: args.status as RunStatus | undefined,
          limit: args.limit as number | undefined,
          cursor: args.cursor as string | undefined,
        })
        return {
          items: page.items.map((item) => ({
            runId: item.runId,
            status: item.status,
            triggerType: item.triggerType,
            taskRevision: item.taskRevision,
            progress: item.progress,
            startedAt: item.startedAt,
            ...(item.finishedAt ? { finishedAt: item.finishedAt } : {}),
            ...(item.summary ? { summary: item.summary } : {}),
            ...(item.error ? { errorSummary: `${item.error.code}: ${item.error.message}` } : {}),
            ...(item.resumesRunId ? { resumesRunId: item.resumesRunId } : {}),
            steps: item.steps,
          })),
          ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        }
      },
    },
    engine,
  )

  const resume = buildTool(
    {
      name: 'task_resume',
      description:
        '人工恢复一次 failed / interrupted / blocked 的运行。恢复总是创建新的 TaskRun 并 write resumesRunId，'
        + '已完成步骤不会重复执行，从第一个未完成步骤继续。若原运行有失败步骤（可能已产生外部副作用），必须提供 confirmation 才允许恢复，插件绝不自动重放。',
      parameters: {
        runId: { type: 'string', description: '要恢复的原运行 ID。' },
        confirmation: {
          type: 'string',
          description: '用户对"旧执行已终止、重复执行副作用可接受"的确认原文；有失败步骤时必填。',
        },
      },
      args: z.object({
        runId: z.string().trim().min(4).max(64),
        confirmation: z.string().trim().max(2000).optional(),
      }),
      output: out({ ...RUN_FIELDS, deduplicated: { type: 'boolean' } }, ['runId', 'status']),
      render: (args, value) => {
        const record = value as Record<string, unknown>
        if (isFailure(value)) return renderGeneric(args, value)
        const steps = (record.steps ?? []) as Array<Record<string, unknown>>
        const lines = [
          `已创建恢复运行 ${String(record.runId ?? '')}（来自 ${String(record.resumesRunId ?? '')}）`,
          `进度 ${String(record.progress ?? 0)}%（${String(record.completedRequired ?? 0)}/${String(record.totalRequired ?? 0)}）`,
        ]
        const pending = steps.filter((step) => step.status === 'pending')
        if (pending.length > 0) {
          lines.push('待执行步骤：')
          for (const step of pending) lines.push(`· ${String(step.order ?? '')}. ${String(step.title ?? '')} (${String(step.stepId ?? '')})`)
        } else {
          lines.push('没有待执行步骤（全部已完成），可直接 task_run_finish(succeeded)。')
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
      async execute(args, active) {
        const result = await active.runService.resume({
          sessionId: String(args.sessionId),
          runId: String(args.runId),
          confirmation: args.confirmation as string | undefined,
        })
        return { ...runView(result.run, result.steps), deduplicated: result.deduplicated }
      },
    },
    engine,
  )

  return [run, begin, stepReport, finish, history, resume]
}

/** Progress text helper exported for the diagnostics tool. */
export function describeRunProgress(run: { status: string; progress: number; requiredCompleted: number; requiredTotal: number }): string {
  return progressLine({
    runId: '',
    taskId: '',
    taskRevision: 1,
    status: run.status,
    triggerType: 'manual',
    sessionId: '',
    progress: run.progress,
    requiredCompleted: run.requiredCompleted,
    requiredTotal: run.requiredTotal,
    startedAt: '',
  })
}
