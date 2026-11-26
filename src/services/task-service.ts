/**
 * Task template service: create / list / get / update / archive and the
 * Schedule linkage (PRD 4.2, 5.1, FR-001, FR-002, FR-003).
 *
 * All persistence goes through Repository; all state changes are audited; every
 * entry point takes the caller SessionId and verifies ownership first.
 */

import { z } from 'zod'
import { TaskEngineError } from '../errors.js'
import type { EngineConfig } from '../config.js'
import {
  SCHEMA_VERSION,
  type RunRecord,
  type ScheduleRef,
  type StepDefinition,
  type TaskRecord,
  type TaskStatus,
} from '../domain/records.js'
import { newStepId, newTaskId } from '../utils/id.js'
import { nowIso } from '../utils/time.js'
import { truncateText } from '../utils/text.js'
import { compareDesc, paginate, type CursorPayload } from '../utils/page.js'
import type { Repository } from '../storage/repository.js'
import type { AuditTrail } from './audit.js'
import { describeTiming, toHostTiming, type ScheduleAdapter, type TimingInput } from './schedule-adapter.js'

const stepInputSchema = z.object({
  title: z.string().trim().min(1, '步骤标题不能为空').max(120),
  instruction: z.string().trim().min(1, '步骤 instruction 不能为空').max(8000),
  completionCriteria: z.string().trim().max(2000).optional(),
  required: z.boolean().optional(),
})

export type StepInput = z.infer<typeof stepInputSchema>

export interface CreateTaskInput {
  sessionId: string
  title?: string
  description?: string
  steps?: StepInput[]
  copyFromTaskId?: string
}

export interface UpdateTaskInput {
  sessionId: string
  taskId: string
  expectedRevision: number
  title?: string
  description?: string
  steps?: StepInput[]
  status?: 'active' | 'paused'
}

export interface ListTasksInput {
  sessionId: string
  status?: TaskStatus
  query?: string
  limit?: number
  cursor?: string
}

export interface TaskSummaryRow {
  taskId: string
  title: string
  status: TaskStatus
  revision: number
  stepCount: number
  updatedAt: string
  schedule: { scheduleId: string; state: ScheduleRef['state']; timing: string } | null
  lastRun: { runId: string; status: string; startedAt: string } | null
}

export class TaskService {
  constructor(
    private readonly repo: Repository,
    private readonly config: EngineConfig,
    private readonly audit: AuditTrail,
    private readonly schedules: ScheduleAdapter,
    private readonly now: () => string = nowIso,
  ) {}

  // ---------------------------------------------------------------- create

  async create(input: CreateTaskInput): Promise<TaskRecord> {
    const owner = input.sessionId
    let source: TaskRecord | undefined
    if (input.copyFromTaskId) {
      source = this.repo.requireOwnedTask(input.copyFromTaskId, owner)
    }

    const rawSteps = input.steps && input.steps.length > 0 ? input.steps : source?.steps
    if (!rawSteps || rawSteps.length === 0) {
      throw new TaskEngineError('TASK_INVALID_STEPS', '任务至少需要 1 个步骤')
    }
    const steps = this.normaliseSteps(rawSteps)

    const title = (input.title ?? (source ? `${source.title} (副本)` : '')).trim()
    if (title.length < 2 || title.length > 80) {
      throw new TaskEngineError('TASK_INVALID_ARGUMENTS', '任务标题长度必须为 2–80 个字符')
    }
    const description = truncateText((input.description ?? source?.description ?? '').trim(), 2000) || undefined

    const existing = this.repo.countUnarchivedTasks(owner)
    if (existing >= this.config.maxTasksPerOwner) {
      throw new TaskEngineError(
        'TASK_PERMISSION_DENIED',
        `当前会话可保留的未归档任务已达上限 ${this.config.maxTasksPerOwner}，请先归档不再使用的任务`,
      )
    }

    const stamp = this.now()
    const record: TaskRecord = {
      taskId: newTaskId(),
      title,
      status: 'active',
      revision: 1,
      ownerSessionId: owner,
      steps,
      createdAt: stamp,
      updatedAt: stamp,
      schemaVersion: SCHEMA_VERSION,
    }
    if (description) record.description = description

    const stored = await this.repo.insertTask(record)
    this.audit.record({
      name: 'task.created',
      taskId: stored.taskId,
      to: stored.status,
      sessionId: owner,
      source: source ? `copy:${source.taskId}` : 'task_create',
      detail: `steps=${stored.steps.length}`,
    })
    return stored
  }

  private normaliseSteps(rawSteps: StepInput[]): StepDefinition[] {
    if (!Array.isArray(rawSteps)) {
      throw new TaskEngineError('TASK_INVALID_STEPS', 'steps 必须是数组')
    }
    if (rawSteps.length > this.config.maxStepsPerTask) {
      throw new TaskEngineError(
        'TASK_INVALID_STEPS',
        `步骤数量 ${rawSteps.length} 超过上限 ${this.config.maxStepsPerTask}（V1.0 为线性任务，最多 10 步）`,
      )
    }
    const parsed: StepInput[] = []
    for (const [index, candidate] of rawSteps.entries()) {
      const result = stepInputSchema.safeParse(candidate)
      if (!result.success) {
        const issue = result.error.issues[0]
        throw new TaskEngineError(
          'TASK_INVALID_STEPS',
          `第 ${index + 1} 个步骤无效：${issue?.path.join('.') || 'step'} ${issue?.message ?? ''}`.trim(),
        )
      }
      parsed.push(result.data)
    }
    const seen = new Set<string>()
    const steps: StepDefinition[] = parsed.map((step, index) => {
      let stepId = newStepId()
      while (seen.has(stepId)) stepId = newStepId()
      seen.add(stepId)
      const definition: StepDefinition = {
        stepId,
        title: step.title,
        instruction: step.instruction,
        order: index + 1,
        required: step.required !== false,
      }
      if (step.completionCriteria) definition.completionCriteria = step.completionCriteria
      return definition
    })
    if (steps.length === 0) {
      throw new TaskEngineError('TASK_INVALID_STEPS', '任务至少需要 1 个步骤')
    }
    return steps
  }

  // ------------------------------------------------------------------ list

  list(input: ListTasksInput): { items: TaskSummaryRow[]; nextCursor?: string } {
    const owner = input.sessionId
    const query = input.query?.trim().toLowerCase()
    const runs = this.repo.listRuns()
    const lastRunByTask = new Map<string, RunRecord>()
    for (const run of runs) {
      if (run.taskOwnerSessionId !== owner) continue
      const current = lastRunByTask.get(run.taskId)
      if (!current || run.startedAt > current.startedAt) lastRunByTask.set(run.taskId, run)
    }

    const filtered = this.repo
      .listTasksByOwner(owner)
      .filter((task) => (input.status ? task.status === input.status : true))
      .filter((task) => {
        if (!query) return true
        return (
          task.title.toLowerCase().includes(query) ||
          (task.description ?? '').toLowerCase().includes(query) ||
          task.taskId === input.query?.trim()
        )
      })
      .sort((a, b) => compareDesc(a.updatedAt, a.taskId, b.updatedAt, b.taskId))

    const page = paginate(filtered, {
      limit: input.limit ?? 20,
      cursor: decodeCursorSafe(input.cursor),
      tsOf: (task) => task.updatedAt,
      idOf: (task) => task.taskId,
    })

    const items = page.items.map((task) => this.toSummaryRow(task, lastRunByTask.get(task.taskId)))
    return page.nextCursor ? { items, nextCursor: page.nextCursor } : { items }
  }

  private toSummaryRow(task: TaskRecord, run: RunRecord | undefined): TaskSummaryRow {
    return {
      taskId: task.taskId,
      title: task.title,
      status: task.status,
      revision: task.revision,
      stepCount: task.steps.length,
      updatedAt: task.updatedAt,
      schedule: task.scheduleRef
        ? {
            scheduleId: task.scheduleRef.scheduleId,
            state: task.scheduleRef.state,
            timing: describeTiming(task.scheduleRef.timing as unknown as TimingInput),
          }
        : null,
      lastRun: run ? { runId: run.runId, status: run.status, startedAt: run.startedAt } : null,
    }
  }

  // ------------------------------------------------------------------- get

  get(owner: string, taskId: string, options: { includeRuns?: boolean } = {}): {
    task: TaskRecord
    recentRuns: RunRecord[]
  } {
    const task = this.repo.requireOwnedTask(taskId, owner)
    const recentRuns = options.includeRuns === false ? [] : this.repo.listRunsByTask(taskId).slice(0, 5)
    return { task, recentRuns }
  }

  // ---------------------------------------------------------------- update

  async update(input: UpdateTaskInput): Promise<TaskRecord> {
    const task = this.repo.requireOwnedTask(input.taskId, input.sessionId)
    if (task.status === 'archived') {
      throw new TaskEngineError('TASK_PERMISSION_DENIED', '任务已归档，只能查看历史，不能修改')
    }
    if (task.revision !== input.expectedRevision) {
      throw new TaskEngineError(
        'TASK_REVISION_CONFLICT',
        `revision 冲突：期望 ${input.expectedRevision}，当前 ${task.revision}；请先 task_get 获取最新 revision`,
        { details: { expectedRevision: input.expectedRevision, actualRevision: task.revision } },
      )
    }

    let steps: StepDefinition[] | undefined
    if (input.steps) steps = this.normaliseSteps(input.steps)
    const title = input.title?.trim()
    if (title !== undefined && (title.length < 2 || title.length > 80)) {
      throw new TaskEngineError('TASK_INVALID_ARGUMENTS', '任务标题长度必须为 2–80 个字符')
    }
    const description = input.description !== undefined ? truncateText(input.description.trim(), 2000) : undefined

    if (input.status && input.status !== task.status) {
      // Schedule first: a failed host update must leave the task status untouched.
      await this.applyStatusWithSchedule(task, input.status, input.sessionId)
    }

    const updated = await this.repo.mutateTask(input.taskId, input.expectedRevision, (current) => {
      const next: TaskRecord = {
        ...current,
        revision: current.revision + 1,
        updatedAt: this.now(),
      }
      if (title !== undefined) next.title = title
      if (description !== undefined) {
        if (description) next.description = description
        else delete next.description
      }
      if (steps) next.steps = steps
      if (input.status) next.status = input.status
      return next
    })

    this.audit.record({
      name: 'task.updated',
      taskId: updated.taskId,
      from: String(task.revision),
      to: String(updated.revision),
      sessionId: input.sessionId,
      source: 'task_update',
      detail: [title !== undefined ? 'title' : '', steps ? 'steps' : '', input.status ? `status=${input.status}` : '']
        .filter(Boolean)
        .join(','),
    })
    return updated
  }

  private async applyStatusWithSchedule(task: TaskRecord, target: 'active' | 'paused', sessionId: string): Promise<void> {
    const ref = task.scheduleRef
    if (!ref || ref.state === 'unlinked') return
    if (target === 'paused' && ref.state === 'active') {
      await this.schedules.update({ scheduleId: ref.scheduleId, patch: { active: false }, sessionId })
      await this.patchScheduleRef(task.taskId, (current) => ({ ...current, state: 'paused', updatedAt: this.now() }))
      this.audit.record({
        name: 'task.schedule.changed',
        taskId: task.taskId,
        from: 'active',
        to: 'paused',
        sessionId,
        source: 'task_update',
      })
      return
    }
    if (target === 'active' && ref.state === 'paused') {
      await this.schedules.update({ scheduleId: ref.scheduleId, patch: { active: true }, sessionId })
      await this.patchScheduleRef(task.taskId, (current) => ({ ...current, state: 'active', updatedAt: this.now() }))
      this.audit.record({
        name: 'task.schedule.changed',
        taskId: task.taskId,
        from: 'paused',
        to: 'active',
        sessionId,
        source: 'task_update',
      })
    }
  }

  private async patchScheduleRef(
    taskId: string,
    mutate: (current: ScheduleRef) => ScheduleRef,
  ): Promise<void> {
    try {
      await this.repo.mutateTask(taskId, undefined, (current) => {
        if (!current.scheduleRef) return current
        return { ...current, scheduleRef: mutate({ ...current.scheduleRef }), revision: current.revision }
      })
    } catch {
      /* diagnostics-only patch: never mask the original operation result */
    }
  }

  // --------------------------------------------------------------- archive

  async archive(input: { sessionId: string; taskId: string; expectedRevision: number }): Promise<TaskRecord> {
    const task = this.repo.requireOwnedTask(input.taskId, input.sessionId)
    if (task.status === 'archived') return task
    if (task.revision !== input.expectedRevision) {
      throw new TaskEngineError(
        'TASK_REVISION_CONFLICT',
        `revision 冲突：期望 ${input.expectedRevision}，当前 ${task.revision}`,
        { details: { expectedRevision: input.expectedRevision, actualRevision: task.revision } },
      )
    }
    const active = this.repo.listActiveRunsByTask(task.taskId)
    if (active.length > 0) {
      throw new TaskEngineError(
        'TASK_ALREADY_RUNNING',
        `任务仍有活动运行 ${active[0]!.runId}，请先结束运行再归档`,
        { relatedRunId: active[0]!.runId },
      )
    }

    // Unlink the host schedule first: archiving must not leave a live rule that
    // can still fire for an archived task.
    let unlinkedId: string | undefined
    if (task.scheduleRef) {
      const removed = await this.schedules.remove(task.scheduleRef.scheduleId, input.sessionId)
      unlinkedId = task.scheduleRef.scheduleId
      this.audit.record({
        name: 'task.schedule.changed',
        taskId: task.taskId,
        from: task.scheduleRef.state,
        to: 'deleted',
        sessionId: input.sessionId,
        source: 'task_archive',
        detail: removed.alreadyGone ? 'already-gone' : undefined,
      })
    }

    const archived = await this.repo.mutateTask(input.taskId, input.expectedRevision, (current) => {
      const next: TaskRecord = { ...current, status: 'archived', revision: current.revision + 1, updatedAt: this.now() }
      delete next.scheduleRef
      return next
    })

    this.audit.record({
      name: 'task.archived',
      taskId: archived.taskId,
      from: task.status,
      to: 'archived',
      sessionId: input.sessionId,
      source: 'task_archive',
      detail: unlinkedId ? `unlinked=${unlinkedId}` : undefined,
    })
    return archived
  }

  // ------------------------------------------------------- schedule linkage

  async scheduleCreate(input: {
    sessionId: string
    taskId: string
    timing: TimingInput
  }): Promise<TaskRecord & { scheduleId: string }> {
    const task = this.repo.requireOwnedTask(input.taskId, input.sessionId)
    if (task.status === 'archived') {
      throw new TaskEngineError('TASK_PERMISSION_DENIED', '任务已归档，不能创建定时规则')
    }
    if (task.scheduleRef) {
      throw new TaskEngineError(
        'TASK_SCHEDULE_FAILED',
        `任务已有定时规则 ${task.scheduleRef.scheduleId}；请使用 action="update" 修改或 action="delete" 后重建`,
      )
    }
    const created = await this.schedules.create({
      taskId: task.taskId,
      taskTitle: task.title,
      timing: input.timing,
      sessionId: input.sessionId,
    })
    const stamp = this.now()
    const ref: ScheduleRef = {
      scheduleId: created.scheduleId,
      timingKind: input.timing.kind,
      timing: toHostTiming(input.timing) as unknown as Record<string, unknown>,
      state: 'active',
      title: `后台任务 · ${task.title}`.slice(0, 120),
      createdAt: stamp,
      updatedAt: stamp,
    }
    const updated = await this.repo.mutateTask(task.taskId, undefined, (current) => ({
      ...current,
      scheduleRef: ref,
      revision: current.revision + 1,
      updatedAt: stamp,
    }))
    this.audit.record({
      name: 'task.schedule.changed',
      taskId: task.taskId,
      from: 'none',
      to: 'active',
      sessionId: input.sessionId,
      source: 'task_schedule:create',
      detail: `scheduleId=${created.scheduleId}`,
    })
    return { ...updated, scheduleId: created.scheduleId }
  }

  async scheduleUpdate(input: {
    sessionId: string
    taskId: string
    timing: TimingInput
  }): Promise<TaskRecord> {
    const task = this.repo.requireOwnedTask(input.taskId, input.sessionId)
    const ref = task.scheduleRef
    if (!ref) throw new TaskEngineError('TASK_SCHEDULE_FAILED', '任务尚未关联定时规则，请先 action="create"')
    if (task.status === 'archived') throw new TaskEngineError('TASK_PERMISSION_DENIED', '任务已归档，不能修改定时规则')

    try {
      await this.schedules.update({ scheduleId: ref.scheduleId, patch: { timing: input.timing }, sessionId: input.sessionId })
    } catch (error) {
      // Persist the failure for diagnostics but keep the old rule untouched and
      // never report success (acceptance 14.3).
      const message = error instanceof Error ? error.message : String(error)
      await this.patchScheduleRef(task.taskId, (current) => ({
        ...current,
        updatedAt: this.now(),
        lastError: { code: 'TASK_SCHEDULE_FAILED', message: message.slice(0, 500) },
      }))
      throw error
    }

    const updated = await this.repo.mutateTask(task.taskId, undefined, (current) => {
      const nextRef: ScheduleRef = {
        ...(current.scheduleRef ?? ref),
        timingKind: input.timing.kind,
        timing: toHostTiming(input.timing) as unknown as Record<string, unknown>,
        updatedAt: this.now(),
      }
      delete nextRef.lastError
      return { ...current, scheduleRef: nextRef, revision: current.revision + 1, updatedAt: this.now() }
    })
    this.audit.record({
      name: 'task.schedule.changed',
      taskId: task.taskId,
      from: ref.timingKind,
      to: input.timing.kind,
      sessionId: input.sessionId,
      source: 'task_schedule:update',
      detail: `scheduleId=${ref.scheduleId}`,
    })
    return updated
  }

  async scheduleSetActive(input: {
    sessionId: string
    taskId: string
    active: boolean
  }): Promise<{ task: TaskRecord; changed: boolean }> {
    const task = this.repo.requireOwnedTask(input.taskId, input.sessionId)
    const ref = task.scheduleRef
    if (!ref) throw new TaskEngineError('TASK_SCHEDULE_FAILED', '任务尚未关联定时规则')
    const targetState = input.active ? 'active' : 'paused'
    if (ref.state === targetState) return { task, changed: false }

    await this.schedules.update({ scheduleId: ref.scheduleId, patch: { active: input.active }, sessionId: input.sessionId })
    const updated = await this.repo.mutateTask(task.taskId, undefined, (current) => ({
      ...current,
      scheduleRef: current.scheduleRef
        ? { ...current.scheduleRef, state: targetState, updatedAt: this.now() }
        : undefined,
      revision: current.revision + 1,
      updatedAt: this.now(),
    }))
    this.audit.record({
      name: 'task.schedule.changed',
      taskId: task.taskId,
      from: ref.state,
      to: targetState,
      sessionId: input.sessionId,
      source: 'task_schedule:setActive',
      detail: `scheduleId=${ref.scheduleId}`,
    })
    return { task: updated, changed: true }
  }

  async scheduleDelete(input: { sessionId: string; taskId: string }): Promise<{ task: TaskRecord; alreadyGone: boolean }> {
    const task = this.repo.requireOwnedTask(input.taskId, input.sessionId)
    const ref = task.scheduleRef
    if (!ref) throw new TaskEngineError('TASK_SCHEDULE_FAILED', '任务没有关联的定时规则')
    const removed = await this.schedules.remove(ref.scheduleId, input.sessionId)
    const updated = await this.repo.mutateTask(task.taskId, undefined, (current) => {
      const next: TaskRecord = { ...current, revision: current.revision + 1, updatedAt: this.now() }
      delete next.scheduleRef
      return next
    })
    this.audit.record({
      name: 'task.schedule.changed',
      taskId: task.taskId,
      from: ref.state,
      to: 'deleted',
      sessionId: input.sessionId,
      source: 'task_schedule:delete',
      detail: `scheduleId=${ref.scheduleId}`,
    })
    return { task: updated, alreadyGone: removed.alreadyGone }
  }

  async scheduleStatus(input: { sessionId: string; taskId: string }): Promise<{
    ref: ScheduleRef | null
    live: { status?: string; scheduledAt?: string; title?: string } | null
    available: boolean
  }> {
    const task = this.repo.requireOwnedTask(input.taskId, input.sessionId)
    const ref = task.scheduleRef ?? null
    if (!ref || !this.schedules.available) return { ref, live: null, available: this.schedules.available }
    const entry = await this.schedules.view(ref.scheduleId).catch(() => undefined)
    return {
      ref,
      live: entry
        ? { status: entry.status, scheduledAt: entry.scheduledAt, title: entry.title }
        : null,
      available: true,
    }
  }

  async scheduleRunNow(input: { sessionId: string; taskId: string }): Promise<{ pending: boolean }> {
    const task = this.repo.requireOwnedTask(input.taskId, input.sessionId)
    const ref = task.scheduleRef
    if (!ref) throw new TaskEngineError('TASK_SCHEDULE_FAILED', '任务没有关联的定时规则；可直接使用 task_run 手动执行')
    const result = await this.schedules.runNow(ref.scheduleId)
    this.audit.record({
      name: 'task.schedule.changed',
      taskId: task.taskId,
      to: result.pending ? 'run-pending' : 'run-requested',
      sessionId: input.sessionId,
      source: 'task_schedule:run_now',
      detail: `scheduleId=${ref.scheduleId}`,
    })
    return { pending: result.pending }
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
