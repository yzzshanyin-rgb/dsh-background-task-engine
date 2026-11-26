/**
 * Run service: manual/schedule execution lifecycle (PRD 5.2, 5.3, FR-005..FR-008,
 * chapter 9.1, acceptance 14.2 / 14.4).
 *
 * Invariants enforced here:
 *  - a TaskRun is created only after ownership, task status, concurrency and
 *    idempotency checks pass;
 *  - the step template is snapshotted into the run, so later task edits cannot
 *    change an in-flight run;
 *  - steps advance strictly by `order`; a step cannot be reported before its
 *    predecessors settled;
 *  - `succeeded` requires every required step to be completed;
 *  - a failed step is never replayed silently: recovery needs a confirmation.
 */

import { TaskEngineError } from '../errors.js'
import type { EngineConfig } from '../config.js'
import {
  SCHEMA_VERSION,
  type RunRecord,
  type RunStatus,
  type RunStepRecord,
  type StepDefinition,
  type TaskRecord,
  type TriggerType,
} from '../domain/records.js'
import {
  ACTIVE_RUN_STATUSES,
  RESUMABLE_RUN_STATUSES,
  assertLinearStart,
  assertRunTransition,
  assertStepTransition,
  computeProgress,
  firstPendingStep,
  isActiveRun,
  isTerminalRun,
  requiredStepsSettled,
} from '../domain/state.js'
import { newRunId } from '../utils/id.js'
import { daysAgoIso, isOlderThanMinutes, nowIso } from '../utils/time.js'
import { truncateText } from '../utils/text.js'
import { compareDesc, paginate, type CursorPayload } from '../utils/page.js'
import { parseTriggerMessage } from '../prompt/guidance.js'
import type { Repository } from '../storage/repository.js'
import type { AuditTrail } from './audit.js'

export type StepReportAction = 'started' | 'completed' | 'failed' | 'skipped'
export type FinishStatus = 'succeeded' | 'failed' | 'interrupted' | 'skipped' | 'blocked'

export interface StartRunInput {
  sessionId: string
  taskId?: string
  triggerPayload?: string
  triggerType?: TriggerType
  scheduleId?: string
  occurrenceKey?: string
  idempotencyKey?: string
  manualRunId?: string
  /** Create the run as `queued` instead of `running` (explicit two-phase start). */
  defer?: boolean
  source: string
}

export interface StartRunResult {
  run: RunRecord
  steps: RunStepRecord[]
  deduplicated: boolean
}

export interface StepReportInput {
  sessionId: string
  runId: string
  stepId: string
  action: StepReportAction
  summary?: string
  error?: { code?: string; message: string } | string
}

export interface FinishRunInput {
  sessionId: string
  runId: string
  status: FinishStatus
  summary?: string
  error?: { code?: string; message: string } | string
}

export interface ResumeRunInput {
  sessionId: string
  runId: string
  confirmation?: string
}

export interface HistoryInput {
  sessionId: string
  taskId: string
  status?: RunStatus
  limit?: number
  cursor?: string
}

export interface RunHistoryRow {
  runId: string
  status: RunStatus
  triggerType: TriggerType
  taskRevision: number
  progress: number
  requiredCompleted: number
  requiredTotal: number
  startedAt: string
  finishedAt?: string
  currentStepId?: string
  resumesRunId?: string
  summary?: string
  error?: { code: string; message: string }
  steps: Array<{ stepId: string; order: number; title: string; status: string }>
}

function normaliseError(
  input: { code?: string; message: string } | string | undefined,
  fallbackCode: string,
  maxChars: number,
): { code: string; message: string } | undefined {
  if (input === undefined || input === null) return undefined
  if (typeof input === 'string') {
    const message = truncateText(input.trim(), maxChars) ?? ''
    if (!message) return undefined
    return { code: fallbackCode, message }
  }
  const message = truncateText(String(input.message ?? '').trim(), maxChars) ?? ''
  if (!message) return undefined
  return { code: (input.code ?? fallbackCode).slice(0, 64), message }
}

export class RunService {
  constructor(
    private readonly repo: Repository,
    private readonly config: EngineConfig,
    private readonly audit: AuditTrail,
    private readonly now: () => string = nowIso,
  ) {}

  // -------------------------------------------------------------- start run

  async start(input: StartRunInput): Promise<StartRunResult> {
    const trigger = parseTriggerMessage(input.triggerPayload)
    const taskId = input.taskId ?? trigger.taskId
    if (!taskId) {
      throw new TaskEngineError(
        'TASK_INVALID_ARGUMENTS',
        '未提供 taskId，也无法从 triggerPayload 中识别任务标识（缺少 task_id_json）',
      )
    }
    const task = this.repo.requireOwnedTask(taskId, input.sessionId)

    const scheduleId = input.scheduleId ?? trigger.scheduleId
    const occurrenceKey = input.occurrenceKey ?? trigger.occurrenceKey
    const idempotencyKey =
      input.idempotencyKey ??
      (scheduleId && occurrenceKey
        ? `schedule:${scheduleId}:${occurrenceKey}`
        : input.manualRunId
          ? `manual:${input.manualRunId}`
          : undefined)

    // Idempotent replay: the same key always maps to the same TaskRun, so a
    // duplicated schedule delivery can never start a second execution.
    if (idempotencyKey) {
      const existing = this.repo.findRunByIdempotencyKey(task.taskId, idempotencyKey)
      if (existing) {
        return {
          run: existing,
          steps: this.repo.listSteps(existing.runId),
          deduplicated: true,
        }
      }
    }

    if (task.status === 'archived') {
      throw new TaskEngineError('TASK_PERMISSION_DENIED', '任务已归档，不能执行；请创建新的任务')
    }
    if (task.status === 'paused') {
      throw new TaskEngineError(
        'TASK_PERMISSION_DENIED',
        '任务处于暂停状态，不会执行；请先用 task_update 将 status 设为 active',
      )
    }

    const activeForTask = this.repo.listActiveRunsByTask(task.taskId)
    if (activeForTask.length >= this.config.maxParallelRunsPerTask) {
      throw new TaskEngineError(
        'TASK_ALREADY_RUNNING',
        `任务 ${task.taskId} 已有运行 ${activeForTask[0]!.runId} 处于 ${activeForTask[0]!.status}，暂不能启动新的运行`,
        { relatedRunId: activeForTask[0]!.runId },
      )
    }
    const activeForOwner = this.repo.listActiveRunsByOwner(task.ownerSessionId)
    if (activeForOwner.length >= this.config.maxActiveRunsPerOwner) {
      throw new TaskEngineError(
        'TASK_MAX_CONCURRENCY',
        `当前会话活动运行数已达上限 ${this.config.maxActiveRunsPerOwner}，请等待已有运行结束`,
      )
    }

    const stamp = this.now()
    const runId = newRunId()
    const snapshot = {
      revision: task.revision,
      title: task.title,
      steps: task.steps.map((step) => ({ ...step })),
    }
    const status: RunStatus = input.defer ? 'queued' : 'running'
    const run: RunRecord = {
      runId,
      taskId: task.taskId,
      taskRevision: task.revision,
      taskOwnerSessionId: task.ownerSessionId,
      sessionId: input.sessionId,
      status,
      triggerType: input.triggerType ?? (trigger.taskId ? 'schedule' : 'manual'),
      progress: 0,
      requiredTotal: snapshot.steps.filter((step) => step.required).length,
      requiredCompleted: 0,
      totalSteps: snapshot.steps.length,
      startedAt: stamp,
      updatedAt: stamp,
      templateSnapshot: snapshot,
      schemaVersion: SCHEMA_VERSION,
    }
    if (scheduleId) run.scheduleId = scheduleId
    if (occurrenceKey) run.occurrenceKey = occurrenceKey
    if (idempotencyKey) run.idempotencyKey = idempotencyKey
    const first = firstPendingStep(snapshot.steps.map((step) => ({ ...step, status: 'pending' as const })))
    if (first) run.currentStepId = first

    const steps = this.buildFreshSteps(run, snapshot.steps, stamp)
    // Steps first, then the run: a crash in between leaves no run pointing at
    // half-written progress.
    await this.repo.putSteps(steps)
    const stored = await this.repo.insertRun(run)

    this.audit.record({
      name: 'task.run.started',
      taskId: stored.taskId,
      runId: stored.runId,
      to: stored.status,
      sessionId: input.sessionId,
      source: input.source,
      detail: `trigger=${stored.triggerType}`,
    })
    return { run: stored, steps, deduplicated: false }
  }

  /** Two-phase start: transition an existing `queued` run to `running`. */
  async begin(input: { sessionId: string; runId: string; source: string }): Promise<StartRunResult> {
    const run = this.repo.requireOwnedRun(input.runId, input.sessionId)
    const steps = this.repo.listSteps(run.runId)
    if (run.status === 'running') {
      return { run, steps, deduplicated: true }
    }
    if (isTerminalRun(run.status)) {
      throw new TaskEngineError(
        'TASK_RUN_ALREADY_FINISHED',
        `运行 ${run.runId} 已结束（${run.status}），不能再开始；如需继续请 task_resume`,
      )
    }
    assertRunTransition(run.status, 'running', 'task_run_begin')
    const updated = await this.repo.mutateRun(run.runId, (current) => ({
      ...current,
      status: 'running',
      currentStepId: current.currentStepId ?? firstPendingStep(steps),
    }))
    this.audit.record({
      name: 'task.run.started',
      taskId: updated.taskId,
      runId: updated.runId,
      from: run.status,
      to: 'running',
      sessionId: input.sessionId,
      source: input.source,
    })
    return { run: updated, steps, deduplicated: false }
  }

  private buildFreshSteps(run: RunRecord, definitions: StepDefinition[], stamp: string): RunStepRecord[] {
    return definitions.map((definition) => ({
      runId: run.runId,
      stepId: definition.stepId,
      taskId: run.taskId,
      order: definition.order,
      title: definition.title,
      required: definition.required,
      status: 'pending' as const,
      attempt: 0,
      updatedAt: stamp,
    }))
  }

  // ------------------------------------------------------------ step report

  async reportStep(input: StepReportInput): Promise<{ run: RunRecord; step: RunStepRecord; deduplicated: boolean }> {
    const run = this.repo.requireOwnedRun(input.runId, input.sessionId)
    if (isTerminalRun(run.status)) {
      throw new TaskEngineError(
        'TASK_RUN_ALREADY_FINISHED',
        `运行 ${run.runId} 已结束（${run.status}），不能继续报告步骤`,
      )
    }
    if (run.status !== 'running') {
      throw new TaskEngineError(
        'TASK_RUN_INTERRUPTED',
        run.status === 'queued'
          ? `运行 ${run.runId} 尚未开始（queued），请先调用 task_run_begin`
          : `运行 ${run.runId} 处于 ${run.status}，不能继续报告步骤；请先 task_run_finish 或 task_resume`,
      )
    }

    const steps = this.repo.listSteps(run.runId)
    const step = steps.find((candidate) => candidate.stepId === input.stepId)
    if (!step) {
      throw new TaskEngineError(
        'TASK_STEP_ORDER_INVALID',
        `步骤 ${input.stepId} 不属于运行 ${run.runId}；只能报告快照内的 stepId`,
      )
    }

    const target = input.action === 'started' ? 'running' : input.action
    // Retrying `started` is harmless and idempotent; repeating a terminal
    // report is a real ordering error and must be surfaced (PRD 14.2).
    if (input.action === 'started' && step.status === 'running') {
      return { run, step, deduplicated: true }
    }

    const stamp = this.now()
    const summary = truncateText(input.summary?.trim(), this.config.maxSummaryChars)
    const error =
      input.action === 'failed'
        ? normaliseError(input.error, 'TASK_STEP_FAILED', this.config.maxSummaryChars)
        : undefined

    if (input.action === 'started') {
      assertLinearStart(steps, input.stepId)
    }
    assertStepTransition(step.status, target, input.stepId)

    const updatedStep = await this.repo.mutateStep(run.runId, input.stepId, (current) => {
      const next: RunStepRecord = {
        ...current,
        status: target,
        attempt: input.action === 'started' ? current.attempt + 1 : current.attempt,
        updatedAt: stamp,
      }
      if (input.action === 'started') {
        next.startedAt = current.startedAt ?? stamp
        delete next.finishedAt
      } else {
        next.finishedAt = stamp
        if (summary) next.summary = summary
        if (error) next.error = error
      }
      return next
    })

    const refreshed = this.repo.listSteps(run.runId).map((candidate) =>
      candidate.stepId === updatedStep.stepId ? updatedStep : candidate,
    )
    const { progress, requiredTotal, requiredCompleted } = computeProgress(refreshed)
    const updatedRun = await this.repo.mutateRun(run.runId, (current) => {
      const next: RunRecord = {
        ...current,
        progress,
        requiredTotal,
        requiredCompleted,
        currentStepId: firstPendingStep(refreshed),
      }
      if (input.action === 'started') next.currentStepId = input.stepId
      if (input.action === 'failed' && error && !current.error) next.error = error
      if (next.currentStepId === undefined) delete next.currentStepId
      return next
    })

    this.audit.record({
      name: 'task.step.changed',
      taskId: updatedRun.taskId,
      runId: run.runId,
      stepId: updatedStep.stepId,
      from: step.status,
      to: updatedStep.status,
      sessionId: input.sessionId,
      source: 'task_step_report',
      detail: `progress=${progress}`,
    })

    return { run: updatedRun, step: updatedStep, deduplicated: false }
  }

  // ------------------------------------------------------------- finish run

  async finish(input: FinishRunInput): Promise<RunRecord> {
    const run = this.repo.requireOwnedRun(input.runId, input.sessionId)
    if (isTerminalRun(run.status)) {
      throw new TaskEngineError(
        'TASK_RUN_ALREADY_FINISHED',
        `运行 ${run.runId} 已结束（${run.status}），不能重复结束`,
      )
    }
    const steps = this.repo.listSteps(run.runId)
    const summary = truncateText(input.summary?.trim(), this.config.maxSummaryChars)
    const error = normaliseError(
      input.error,
      input.status === 'succeeded' ? 'TASK_RUN_SUCCEEDED' : 'TASK_RUN_FAILED',
      this.config.maxSummaryChars,
    )

    if (input.status === 'succeeded') {
      const settled = requiredStepsSettled(steps)
      if (!settled.ok) {
        throw new TaskEngineError(
          'TASK_STEP_ORDER_INVALID',
          `尚有必需步骤未完成，不能标记 succeeded：${settled.blockers.join('; ')}`,
        )
      }
    }
    if (input.status === 'failed') {
      const failedStep = steps.find((step) => step.status === 'failed')
      if (!failedStep && !error) {
        throw new TaskEngineError(
          'TASK_STEP_ORDER_INVALID',
          '标记 failed 前必须先 task_step_report(action="failed") 或提供 error 摘要（PRD 9.1 第 7 步）',
        )
      }
    }
    if (input.status === 'blocked' && !summary) {
      throw new TaskEngineError(
        'TASK_INVALID_ARGUMENTS',
        '标记 blocked 时必须在 summary 中说明缺少什么输入/权限或外部条件',
      )
    }

    assertRunTransition(run.status, input.status, 'task_run_finish')
    const stamp = this.now()
    const { progress, requiredTotal, requiredCompleted } = computeProgress(steps)
    const terminal = input.status !== 'blocked'
    const finishedAt = terminal ? stamp : undefined

    const updated = await this.repo.mutateRun(run.runId, (current) => {
      const next: RunRecord = {
        ...current,
        status: input.status,
        progress,
        requiredTotal,
        requiredCompleted,
        updatedAt: stamp,
      }
      if (terminal) next.finishedAt = stamp
      if (summary) next.summary = summary
      if (error) next.error = error
      else if (input.status === 'succeeded') delete next.error
      if (terminal) delete next.currentStepId
      return next
    })

    this.audit.record({
      name: 'task.run.finished',
      taskId: updated.taskId,
      runId: updated.runId,
      from: run.status,
      to: input.status,
      sessionId: input.sessionId,
      source: 'task_run_finish',
      detail: `progress=${progress}${finishedAt ? ` elapsed=${run.startedAt}->${finishedAt}` : ''}`,
    })
    return updated
  }

  // ---------------------------------------------------------------- resume

  async resume(input: ResumeRunInput): Promise<StartRunResult> {
    const source = this.repo.requireOwnedRun(input.runId, input.sessionId)
    if (isActiveRun(source.status)) {
      throw new TaskEngineError(
        'TASK_ALREADY_RUNNING',
        `无法确认运行 ${source.runId} 已终止（当前 ${source.status}），禁止并行启动恢复`,
        { relatedRunId: source.runId },
      )
    }
    if (!RESUMABLE_RUN_STATUSES.includes(source.status)) {
      throw new TaskEngineError(
        'TASK_RUN_ALREADY_FINISHED',
        `运行 ${source.runId} 以 ${source.status} 结束，无需恢复；如需重新执行请用 task_run`,
        { relatedRunId: source.runId },
      )
    }

    const sourceSteps = this.repo.listSteps(source.runId)
    const failedSteps = sourceSteps.filter((step) => step.status === 'failed')
    if (failedSteps.length > 0) {
      const confirmation = input.confirmation?.trim()
      if (!confirmation) {
        throw new TaskEngineError(
          'TASK_PERMISSION_DENIED',
          `运行 ${source.runId} 在步骤 ${failedSteps.map((step) => step.stepId).join(', ')} 失败，可能已产生外部副作用。` +
            '必须由用户确认后才能恢复：请确认旧执行已终止且重复执行的副作用可接受，然后在 confirmation 中写下该确认',
          { relatedRunId: source.runId },
        )
      }
    }

    const task = this.repo.requireTask(source.taskId)
    if (task.status === 'archived') {
      throw new TaskEngineError('TASK_PERMISSION_DENIED', '任务已归档，不能恢复运行')
    }
    const activeForTask = this.repo.listActiveRunsByTask(source.taskId)
    if (activeForTask.length >= this.config.maxParallelRunsPerTask) {
      throw new TaskEngineError(
        'TASK_ALREADY_RUNNING',
        `任务 ${source.taskId} 已有活动运行 ${activeForTask[0]!.runId}，不能同时启动恢复`,
        { relatedRunId: activeForTask[0]!.runId },
      )
    }
    const activeForOwner = this.repo.listActiveRunsByOwner(source.taskOwnerSessionId)
    if (activeForOwner.length >= this.config.maxActiveRunsPerOwner) {
      throw new TaskEngineError(
        'TASK_MAX_CONCURRENCY',
        `当前会话活动运行数已达上限 ${this.config.maxActiveRunsPerOwner}`,
      )
    }

    const stamp = this.now()
    const runId = newRunId()
    const snapshot = {
      revision: source.templateSnapshot.revision,
      title: source.templateSnapshot.title,
      steps: source.templateSnapshot.steps.map((step) => ({ ...step })),
    }
    const carried: RunStepRecord[] = sourceSteps
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((step) => {
        const base: RunStepRecord = {
          runId,
          stepId: step.stepId,
          taskId: source.taskId,
          order: step.order,
          title: step.title,
          required: step.required,
          status: 'pending',
          attempt: 0,
          updatedAt: stamp,
        }
        if (step.status === 'completed' || step.status === 'skipped') {
          base.status = step.status
          base.carryOverFromRunId = source.runId
          base.attempt = 1
          if (step.startedAt) base.startedAt = step.startedAt
          if (step.finishedAt) base.finishedAt = step.finishedAt
          if (step.summary) base.summary = step.summary
        }
        return base
      })

    const { progress, requiredTotal, requiredCompleted } = computeProgress(carried)
    const run: RunRecord = {
      runId,
      taskId: source.taskId,
      taskRevision: source.taskRevision,
      taskOwnerSessionId: source.taskOwnerSessionId,
      sessionId: input.sessionId,
      status: 'running',
      triggerType: source.triggerType,
      progress,
      requiredTotal,
      requiredCompleted,
      totalSteps: carried.length,
      startedAt: stamp,
      updatedAt: stamp,
      resumesRunId: source.runId,
      templateSnapshot: snapshot,
      schemaVersion: SCHEMA_VERSION,
    }
    if (source.scheduleId) run.scheduleId = source.scheduleId
    const next = firstPendingStep(carried)
    if (next) run.currentStepId = next

    await this.repo.putSteps(carried)
    const stored = await this.repo.insertRun(run)

    this.audit.record({
      name: 'task.run.resumed',
      taskId: stored.taskId,
      runId: stored.runId,
      from: source.runId,
      to: 'running',
      sessionId: input.sessionId,
      source: 'task_resume',
      detail: `carriedCompleted=${requiredCompleted}/${requiredTotal}`,
    })
    return { run: stored, steps: carried, deduplicated: false }
  }

  // --------------------------------------------------------------- history

  history(input: HistoryInput): { items: RunHistoryRow[]; nextCursor?: string } {
    const task = this.repo.requireOwnedTask(input.taskId, input.sessionId)
    const cutoff = daysAgoIso(this.config.historyRetentionDays)
    const runs = this.repo
      .listRunsByTask(task.taskId)
      .filter((run) => run.startedAt >= cutoff)
      .filter((run) => (input.status ? run.status === input.status : true))

    const page = paginate(runs, {
      limit: input.limit ?? 20,
      cursor: decodeCursorSafe(input.cursor),
      tsOf: (run) => run.startedAt,
      idOf: (run) => run.runId,
    })

    const items = page.items.map((run) => this.toHistoryRow(run))
    return page.nextCursor ? { items, nextCursor: page.nextCursor } : { items }
  }

  private toHistoryRow(run: RunRecord): RunHistoryRow {
    const steps = this.repo.listSteps(run.runId)
    const row: RunHistoryRow = {
      runId: run.runId,
      status: run.status,
      triggerType: run.triggerType,
      taskRevision: run.taskRevision,
      progress: run.progress,
      requiredCompleted: run.requiredCompleted,
      requiredTotal: run.requiredTotal,
      startedAt: run.startedAt,
      steps: steps.map((step) => ({ stepId: step.stepId, order: step.order, title: step.title, status: step.status })),
    }
    if (run.finishedAt) row.finishedAt = run.finishedAt
    if (run.currentStepId) row.currentStepId = run.currentStepId
    if (run.resumesRunId) row.resumesRunId = run.resumesRunId
    if (run.summary) row.summary = truncateText(run.summary, 300)
    if (run.error) row.error = run.error
    return row
  }

  // ------------------------------------------------------- startup recovery

  /**
   * Startup scan (PRD FR-007, 14.4): a run that was `queued`/`running` and has
   * not been touched for `staleRunAfterMinutes` cannot be verified, so it is
   * marked `interrupted`. Nothing is restarted automatically.
   */
  async recoverStale(): Promise<{ scanned: number; interrupted: string[] }> {
    const runs = this.repo.listRuns().filter((run) => ACTIVE_RUN_STATUSES.includes(run.status))
    const interrupted: string[] = []
    const stamp = this.now()
    for (const run of runs) {
      if (!isOlderThanMinutes(run.updatedAt, this.config.staleRunAfterMinutes)) continue
      const steps = this.repo.listSteps(run.runId)
      for (const step of steps) {
        if (step.status !== 'running') continue
        await this.repo.mutateStep(run.runId, step.stepId, (current) => {
          const next: RunStepRecord = {
            ...current,
            status: 'failed',
            finishedAt: stamp,
            error: {
              code: 'TASK_RUN_INTERRUPTED',
              message: '宿主进程重启或执行中断，无法核验该步骤是否产生副作用',
            },
          }
          return next
        })
      }
      const refreshed = this.repo.listSteps(run.runId).map((step) => ({ ...step }))
      const { progress, requiredTotal, requiredCompleted } = computeProgress(refreshed)
      await this.repo.mutateRun(run.runId, (current) => ({
        ...current,
        status: 'interrupted',
        progress,
        requiredTotal,
        requiredCompleted,
        finishedAt: stamp,
        error: {
          code: 'TASK_RUN_INTERRUPTED',
          message: `运行在 ${run.status} 状态超过 ${this.config.staleRunAfterMinutes} 分钟未更新，已标记 interrupted`,
        },
        currentStepId: undefined,
      }))
      interrupted.push(run.runId)
      this.audit.record({
        name: 'task.run.finished',
        taskId: run.taskId,
        runId: run.runId,
        from: run.status,
        to: 'interrupted',
        sessionId: run.sessionId,
        source: 'startup-recovery',
      })
    }
    return { scanned: runs.length, interrupted }
  }

  // ----------------------------------------------------------------- prune

  /**
   * Retention pruning (PRD 7.4 / FR-010): only terminal runs older than
   * `historyRetentionDays` and their step rows are removed. Templates, audit
   * information and every active run are preserved.
   */
  async prune(): Promise<{ runs: number; steps: number }> {
    const cutoff = daysAgoIso(this.config.historyRetentionDays)
    let runs = 0
    let steps = 0
    for (const run of this.repo.listRuns()) {
      if (!isTerminalRun(run.status)) continue
      const reference = run.finishedAt ?? run.updatedAt
      if (reference >= cutoff) continue
      const result = await this.repo.deleteRunCascade(run.runId)
      if (result.runDeleted) runs += 1
      steps += result.stepsDeleted
    }
    return { runs, steps }
  }

  // --------------------------------------------------------------- helpers

  /** Persisted step rows of one run, ordered. */
  stepsOf(runId: string): RunStepRecord[] {
    return this.repo.listSteps(runId)
  }

  countActiveRuns(ownerSessionId: string): number {
    return this.repo.listActiveRunsByOwner(ownerSessionId).length
  }
}

function decodeCursorSafe(cursor: string | undefined): CursorPayload | undefined {
  if (!cursor) return undefined
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as CursorPayload
  } catch {
    return undefined
  }
}

export const RUN_HISTORY_ORDER = compareDesc
