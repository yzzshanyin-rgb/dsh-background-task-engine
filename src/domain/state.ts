/**
 * Task/Run/Step state machines (PRD 4.7, 7.3).
 *
 * Every transition goes through `assertRunTransition` / `assertStepTransition`
 * so an illegal change (e.g. failed -> running, or re-finishing a finished run)
 * is rejected no matter which tool triggered it.
 */

import { TaskEngineError } from '../errors.js'
import type { RunStatus, StepStatus, TaskStatus } from './records.js'
import { RUN_STATUSES, STEP_STATUSES, TASK_STATUSES } from './records.js'

/** Runs that still occupy a concurrency slot. */
export const ACTIVE_RUN_STATUSES: readonly RunStatus[] = ['queued', 'running']

/** Runs that can no longer receive progress reports. */
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = [
  'succeeded',
  'failed',
  'interrupted',
  'skipped',
]

/** Runs a resume may start from. `blocked` is recoverable, not finished. */
export const RESUMABLE_RUN_STATUSES: readonly RunStatus[] = ['failed', 'interrupted', 'blocked']

export function isRunStatus(value: unknown): value is RunStatus {
  return typeof value === 'string' && (RUN_STATUSES as readonly string[]).includes(value)
}

export function isStepStatus(value: unknown): value is StepStatus {
  return typeof value === 'string' && (STEP_STATUSES as readonly string[]).includes(value)
}

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && (TASK_STATUSES as readonly string[]).includes(value)
}

export function isTerminalRun(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status)
}

export function isActiveRun(status: RunStatus): boolean {
  return ACTIVE_RUN_STATUSES.includes(status)
}

/**
 * Allowed TaskRun transitions.
 *
 * - queued  -> running | interrupted | skipped
 * - running -> succeeded | failed | blocked | interrupted
 * - blocked -> failed | interrupted   (never back to running: PRD 4.7 forbids
 *   it, a resume must create a new TaskRun with resumesRunId)
 * - terminal states are final.
 */
const RUN_TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  queued: ['running', 'interrupted', 'skipped', 'failed'],
  running: ['succeeded', 'failed', 'blocked', 'interrupted'],
  blocked: ['failed', 'interrupted'],
  succeeded: [],
  failed: [],
  interrupted: [],
  skipped: [],
}

const STEP_TRANSITIONS: Record<StepStatus, readonly StepStatus[]> = {
  pending: ['running', 'skipped', 'failed'],
  running: ['completed', 'failed', 'skipped'],
  completed: [],
  failed: [],
  skipped: [],
}

export function canTransitionRun(from: RunStatus, to: RunStatus): boolean {
  if (from === to) return false
  return RUN_TRANSITIONS[from].includes(to)
}

export function assertRunTransition(from: RunStatus, to: RunStatus, context: string): void {
  // Terminal wins over every other rule: a finished run can never move again,
  // not even to the state it already holds.
  if (isTerminalRun(from)) {
    throw new TaskEngineError(
      'TASK_RUN_ALREADY_FINISHED',
      `运行已结束（${from}），不能再变更为 ${to}；如需继续请使用 task_resume 创建新的运行`,
    )
  }
  if (from === to) {
    throw new TaskEngineError('TASK_ALREADY_RUNNING', `运行已处于 ${from} 状态（${context}）`)
  }
  if (!canTransitionRun(from, to)) {
    throw new TaskEngineError(
      'TASK_STEP_ORDER_INVALID',
      `非法状态转换 ${from} → ${to}（${context}）`,
    )
  }
}

export function assertStepTransition(from: StepStatus, to: StepStatus, stepId: string): void {
  if (from === to) {
    throw new TaskEngineError(
      'TASK_STEP_ORDER_INVALID',
      `步骤 ${stepId} 已处于 ${from} 状态，不能重复报告 ${to}`,
    )
  }
  if (!STEP_TRANSITIONS[from].includes(to)) {
    throw new TaskEngineError(
      'TASK_STEP_ORDER_INVALID',
      `步骤 ${stepId} 不能从 ${from} 变更为 ${to}`,
    )
  }
}

/**
 * Progress is derived from persisted step records only (PRD 11.4), counting
 * required steps that are completed. Skipped/failed required steps never
 * contribute, so a run cannot look "nearly done" while blocking.
 */
export function computeProgress(
  steps: ReadonlyArray<{ required: boolean; status: StepStatus }>,
): { progress: number; requiredTotal: number; requiredCompleted: number } {
  const required = steps.filter((step) => step.required)
  const completed = required.filter((step) => step.status === 'completed').length
  const total = required.length
  const progress = total === 0 ? 0 : Math.min(100, Math.floor((completed / total) * 100))
  return { progress, requiredTotal: total, requiredCompleted: completed }
}

/** First step, in order, that still needs work. */
export function firstPendingStep(
  steps: ReadonlyArray<{ stepId: string; order: number; status: StepStatus }>,
): string | undefined {
  const sorted = [...steps].sort((a, b) => a.order - b.order)
  return sorted.find((step) => step.status === 'pending' || step.status === 'running')?.stepId
}

/** All required steps completed => the run may be reported as succeeded. */
export function requiredStepsSettled(
  steps: ReadonlyArray<{ required: boolean; status: StepStatus; stepId: string; order: number }>,
): { ok: boolean; blockers: string[] } {
  const blockers = steps
    .filter((step) => step.required && step.status !== 'completed')
    .sort((a, b) => a.order - b.order)
    .map((step) => `${step.order}. ${step.stepId} (${step.status})`)
  return { ok: blockers.length === 0, blockers }
}

/**
 * Linear execution guard (PRD 9.1 step 3): a step may only start when every
 * earlier required step is completed or skipped.
 */
export function assertLinearStart(
  steps: ReadonlyArray<{ stepId: string; order: number; required: boolean; status: StepStatus }>,
  stepId: string,
): void {
  const target = steps.find((step) => step.stepId === stepId)
  if (!target) {
    throw new TaskEngineError('TASK_STEP_ORDER_INVALID', `步骤 ${stepId} 不属于本次运行`)
  }
  const earlierBlocking = steps
    .filter((step) => step.order < target.order && step.status !== 'completed' && step.status !== 'skipped')
    .sort((a, b) => a.order - b.order)
  if (earlierBlocking.length > 0) {
    const names = earlierBlocking.map((step) => `${step.order}.${step.stepId}(${step.status})`).join(', ')
    throw new TaskEngineError(
      'TASK_STEP_ORDER_INVALID',
      `必须按 order 顺序执行：步骤 ${target.order} 之前的 ${names} 尚未结束`,
    )
  }
}
