/**
 * Shared tool plumbing: uniform error envelope, argument validation, JSON Schema
 * shapes and rendering (PRD 6.3, FR-009, 12.3).
 *
 * Every task_* tool returns `{ success: true, ... }` or
 * `{ success: false, error: { code, message, retryable, relatedRunId? } }`.
 * Tools never throw: an Agent only has to branch on `success`.
 */

import type { ZodTypeAny } from 'zod'
import type { ContentBlock, ToolDefinitionLike, ToolRunContextLike } from '../host.js'
import { sessionIdOf } from '../host.js'
import type { TaskEngine } from '../services/engine.js'
import { TaskEngineError, TASK_ERROR_CODES, toErrorPayload } from '../errors.js'
import { RUN_STATUSES, type RunStepRecord, type StepDefinition } from '../domain/records.js'
import { elapsedLabel } from '../utils/time.js'

/**
 * The JSON Schema subset accepted by `assertSupportedJsonSchema`. Keys outside
 * this set (minLength, pattern, maximum, format) throw at registration, so all
 * range and length rules are enforced in code.
 */
export interface JsonSchemaNode {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null'
  oneOf?: JsonSchemaNode[]
  properties?: Record<string, JsonSchemaNode>
  required?: string[]
  additionalProperties?: boolean
  items?: JsonSchemaNode
  enum?: Array<string | number | boolean | null>
  const?: string | number | boolean | null
  description?: string
  title?: string
  default?: unknown
  examples?: unknown[]
}

export const ERROR_SCHEMA: JsonSchemaNode = {
  type: 'object',
  additionalProperties: true,
  properties: {
    code: { type: 'string', enum: [...TASK_ERROR_CODES] },
    message: { type: 'string' },
    retryable: { type: 'boolean' },
    relatedRunId: { type: 'string' },
  },
  required: ['code', 'message', 'retryable'],
}

/** Object-rooted output schema with the shared `success` / `error` pair. */
export function out(
  properties: Record<string, JsonSchemaNode>,
  required: string[] = [],
): JsonSchemaNode {
  return {
    type: 'object',
    additionalProperties: true,
    properties: {
      success: { type: 'boolean' },
      error: ERROR_SCHEMA,
      ...properties,
    },
    required: ['success', ...required],
  }
}

export const STEP_SCHEMA: JsonSchemaNode = {
  type: 'object',
  additionalProperties: true,
  properties: {
    stepId: { type: 'string' },
    title: { type: 'string' },
    instruction: { type: 'string' },
    completionCriteria: { type: 'string' },
    order: { type: 'integer' },
    required: { type: 'boolean' },
    status: { type: 'string', enum: ['pending', 'running', 'completed', 'failed', 'skipped'] },
    summary: { type: 'string' },
    errorSummary: { type: 'string' },
    startedAt: { type: 'string' },
    finishedAt: { type: 'string' },
  },
}

export const STEPS_ARRAY_SCHEMA: JsonSchemaNode = { type: 'array', items: STEP_SCHEMA }

export const TASK_FIELDS: Record<string, JsonSchemaNode> = {
  taskId: { type: 'string' },
  title: { type: 'string' },
  description: { type: 'string' },
  status: { type: 'string', enum: ['active', 'paused', 'archived'] },
  revision: { type: 'integer' },
  stepCount: { type: 'integer' },
  steps: STEPS_ARRAY_SCHEMA,
  schedule: {
    type: 'object',
    additionalProperties: true,
    properties: {
      scheduleId: { type: 'string' },
      state: { type: 'string', enum: ['active', 'paused', 'unlinked'] },
      kind: { type: 'string' },
      timing: { type: 'string' },
    },
  },
  createdAt: { type: 'string' },
  updatedAt: { type: 'string' },
}

export const RUN_FIELDS: Record<string, JsonSchemaNode> = {
  runId: { type: 'string' },
  taskId: { type: 'string' },
  taskRevision: { type: 'integer' },
  status: { type: 'string', enum: [...RUN_STATUSES] },
  triggerType: { type: 'string', enum: ['manual', 'schedule'] },
  sessionId: { type: 'string' },
  scheduleId: { type: 'string' },
  occurrenceKey: { type: 'string' },
  progress: { type: 'integer' },
  completedRequired: { type: 'integer' },
  totalRequired: { type: 'integer' },
  currentStepId: { type: 'string' },
  steps: STEPS_ARRAY_SCHEMA,
  summary: { type: 'string' },
  errorSummary: { type: 'string' },
  resumesRunId: { type: 'string' },
  executionToken: { type: 'string' },
  executionGeneration: { type: 'integer' },
  startedAt: { type: 'string' },
  finishedAt: { type: 'string' },
  duration: { type: 'string' },
}

// ------------------------------------------------------------------ views

export interface TaskLike {
  taskId: string
  title: string
  description?: string
  status: string
  revision: number
  steps: StepDefinition[]
  scheduleRef?: {
    scheduleId: string
    state: string
    timingKind: string
    timing: Record<string, unknown>
  }
  createdAt: string
  updatedAt: string
}

export interface RunLike {
  runId: string
  templateSnapshot?: { revision: number; title: string; steps: StepDefinition[] }
  taskId: string
  taskRevision: number
  status: string
  triggerType: string
  sessionId: string
  scheduleId?: string
  occurrenceKey?: string
  progress: number
  requiredCompleted: number
  requiredTotal: number
  currentStepId?: string
  startedAt: string
  finishedAt?: string
  summary?: string
  error?: { code: string; message: string }
  resumesRunId?: string
  executionToken?: string
  executionGeneration?: number
}

function defectView(step: StepDefinition): Record<string, unknown> {
  const view: Record<string, unknown> = {
    stepId: step.stepId,
    title: step.title,
    instruction: step.instruction,
    order: step.order,
    required: step.required,
  }
  if (step.completionCriteria) view.completionCriteria = step.completionCriteria
  return view
}

function stepRecordView(step: RunStepRecord): Record<string, unknown> {
  const view: Record<string, unknown> = {
    stepId: step.stepId,
    title: step.title,
    order: step.order,
    required: step.required,
    status: step.status,
  }
  if (step.summary) view.summary = step.summary
  if (step.error) view.errorSummary = `${step.error.code}: ${step.error.message}`
  if (step.startedAt) view.startedAt = step.startedAt
  if (step.finishedAt) view.finishedAt = step.finishedAt
  return view
}

export function taskView(task: TaskLike): Record<string, unknown> {
  const view: Record<string, unknown> = {
    taskId: task.taskId,
    title: task.title,
    status: task.status,
    revision: task.revision,
    stepCount: task.steps.length,
    steps: task.steps.map(defectView),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  }
  if (task.description) view.description = task.description
  if (task.scheduleRef) {
    view.schedule = {
      scheduleId: task.scheduleRef.scheduleId,
      state: task.scheduleRef.state,
      kind: task.scheduleRef.timingKind,
      timing: String(task.scheduleRef.timing?.kind ?? task.scheduleRef.timingKind),
    }
  }
  return view
}

export function runView(run: RunLike, steps: RunStepRecord[]): Record<string, unknown> {
  // The run's own snapshot is the only source of instructions for this
  // execution: later task edits must not change what the agent was asked to do.
  const definitions = new Map<string, StepDefinition>(
    (run.templateSnapshot?.steps ?? []).map((step) => [step.stepId, step]),
  )
  const view: Record<string, unknown> = {
    runId: run.runId,
    taskId: run.taskId,
    taskRevision: run.taskRevision,
    // The token is the run's execution credential: the agent must pass it back
    // on heartbeat / step report / finish so a resumed run cannot be driven by
    // a stale caller. It is a handle, not a secret.
    executionToken: run.executionToken,
    executionGeneration: run.executionGeneration,
    status: run.status,
    triggerType: run.triggerType,
    sessionId: run.sessionId,
    progress: run.progress,
    completedRequired: run.requiredCompleted,
    totalRequired: run.requiredTotal,
    steps: steps
      .sort((a, b) => a.order - b.order)
      .map((step) => {
        const definition = definitions.get(step.stepId)
        const rendered = stepRecordView(step)
        if (definition) {
          rendered.instruction = definition.instruction
          if (definition.completionCriteria) rendered.completionCriteria = definition.completionCriteria
        }
        return rendered
      }),
    startedAt: run.startedAt,
    duration: elapsedLabel(run.startedAt, run.finishedAt),
  }
  if (run.scheduleId) view.scheduleId = run.scheduleId
  if (run.occurrenceKey) view.occurrenceKey = run.occurrenceKey
  if (run.currentStepId) view.currentStepId = run.currentStepId
  if (run.summary) view.summary = run.summary
  if (run.error) view.errorSummary = `${run.error.code}: ${run.error.message}`
  if (run.resumesRunId) view.resumesRunId = run.resumesRunId
  if (run.finishedAt) view.finishedAt = run.finishedAt
  return view
}

/** Compact progress block used by list/get/history renderers. */
export function progressLine(run: RunLike): string {
  const marks = ['pending', 'running', 'completed', 'failed', 'skipped']
  void marks
  return `${run.status} ${run.progress}% (${run.requiredCompleted}/${run.requiredTotal})`
}

// ----------------------------------------------------------------- render

function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return ''
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map((item) => formatValue(item)).filter(Boolean).join('；')
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/**
 * Render helper for custom presenters: a failed call always renders through the
 * generic error line, so one broken custom renderer cannot hide an error.
 */
export function isFailure(value: unknown): value is { success: false; error: Record<string, unknown> } {
  return typeof value === 'object' && value !== null && (value as { success?: unknown }).success === false
}

export function renderGeneric(_args: unknown, value: unknown): ContentBlock[] {
  const record = (value ?? {}) as Record<string, unknown>
  if (record.success === false) {
    const error = (record.error ?? {}) as Record<string, unknown>
    return [{ type: 'text', text: `❌ ${String(error.code ?? 'ERROR')}: ${String(error.message ?? '')}` }]
  }
  const lines = Object.entries(record)
    .filter(([key]) => key !== 'success' && key !== 'error')
    .map(([key, item]) => `${key}: ${formatValue(item)}`)
    .filter((line) => !line.endsWith(': '))
  return [{ type: 'text', text: lines.length > 0 ? `✅ ${lines.join('\n')}` : '✅ 完成' }]
}

// ------------------------------------------------------------- tool builder

export interface ToolBuilderInput {
  name: string
  description: string
  /** Property schemas; buildTool wraps them in an object root. */
  parameters: Record<string, JsonSchemaNode>
  /** Names that must be present (standard JSON Schema `required`). */
  requiredParams?: string[]
  /** Zod schema for server-side validation, coercion and defaults. */
  args: ZodTypeAny
  output: JsonSchemaNode
  render?: (args: unknown, value: unknown) => ContentBlock[]
  execute: (
    args: Record<string, unknown>,
    engine: TaskEngine,
  ) => Promise<Record<string, unknown>> | Record<string, unknown>
}

export function buildTool(input: ToolBuilderInput, engine: TaskEngine | null | (() => TaskEngine)): ToolDefinitionLike {
  const resolveEngine = (): TaskEngine => {
    if (typeof engine === 'function') return engine()
    if (engine) return engine
    throw new TaskEngineError('TASK_STORAGE_ERROR', '任务引擎尚未初始化')
  }

  return {
    name: input.name,
    description: input.description,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: input.parameters,
      ...(input.requiredParams && input.requiredParams.length > 0 ? { required: input.requiredParams } : {}),
    },
    output: {
      schema: input.output,
      render: (args: unknown, value: unknown): ContentBlock[] =>
        typeof input.render === 'function' ? input.render(args, value) : renderGeneric(args, value),
    },
    execute: async (rawArgs: unknown, exec: ToolRunContextLike): Promise<unknown> => {
      try {
        const sessionId = sessionIdOf(exec)
        if (!sessionId) {
          throw new TaskEngineError('TASK_PERMISSION_DENIED', '无法确定调用方会话，已拒绝执行')
        }
        const parsed = input.args.safeParse(rawArgs ?? {})
        if (!parsed.success) {
          const issue = parsed.error.issues[0]
          const path = issue?.path?.join('.') || '参数'
          throw new TaskEngineError('TASK_INVALID_ARGUMENTS', `${path} ${issue?.message ?? '不合法'}`.trim())
        }
        const active = resolveEngine()
        await active.waitReady()
        const value = await input.execute({ ...(parsed.data as Record<string, unknown>), sessionId }, active)
        return { success: true, ...value }
      } catch (error) {
        return { success: false, error: toErrorPayload(error) }
      }
    },
  }
}
