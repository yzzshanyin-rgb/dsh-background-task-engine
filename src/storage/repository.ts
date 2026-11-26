/**
 * Repository layer: the only place that talks to StorageDomain tables.
 *
 * Rules encoded here (PRD 7.3, 8.4):
 *  - records are immutable; every write produces a new validated object
 *  - read-modify-write goes through `table.update`, whose mutator runs inside
 *    the domain's per-key chain, so two concurrent calls cannot interleave
 *  - ownership is verified on read (`requireOwnedTask` / `requireOwnedRun`)
 *  - step records are keyed `runId/stepId`: one row per (runId, stepId)
 */

import type { DomainLike, KvTableLike } from '../host.js'
import { TaskEngineError } from '../errors.js'
import {
  TABLES,
  globalStateSchema,
  runRecordSchema,
  runStepRecordSchema,
  stepKey,
  taskRecordSchema,
  type GlobalState,
  type RunRecord,
  type RunStepRecord,
  type TaskRecord,
} from '../domain/records.js'
import { META_KEY } from './spec.js'

export class Repository {
  readonly tasks: KvTableLike<TaskRecord>
  readonly runs: KvTableLike<RunRecord>
  readonly steps: KvTableLike<RunStepRecord>
  readonly meta: KvTableLike<GlobalState>

  constructor(
    readonly domain: DomainLike,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    this.tasks = domain.table<TaskRecord>(TABLES.tasks)
    this.runs = domain.table<RunRecord>(TABLES.runs)
    this.steps = domain.table<RunStepRecord>(TABLES.steps)
    this.meta = domain.table<GlobalState>('meta')
  }

  // ----------------------------------------------------------------- tasks

  getTask(taskId: string): TaskRecord | undefined {
    return this.tasks.get(taskId)
  }

  requireTask(taskId: string): TaskRecord {
    const task = this.tasks.get(taskId)
    if (!task) {
      throw new TaskEngineError('TASK_NOT_FOUND', `任务 ${taskId} 不存在或已被清理`)
    }
    return task
  }

  /**
   * Ownership gate for every tool entry point (PRD 10.1). A record owned by a
   * different Session is reported as "not found" so the error cannot be used to
   * probe another Session's data.
   */
  requireOwnedTask(taskId: string, sessionId: string): TaskRecord {
    const task = this.tasks.get(taskId)
    if (!task || task.ownerSessionId !== sessionId) {
      throw new TaskEngineError('TASK_NOT_FOUND', `任务 ${taskId} 不存在或不属于当前会话`)
    }
    return task
  }

  listTasks(): TaskRecord[] {
    return [...this.tasks.entries()].map(([, task]) => task)
  }

  listTasksByOwner(ownerSessionId: string): TaskRecord[] {
    return this.listTasks().filter((task) => task.ownerSessionId === ownerSessionId)
  }

  countUnarchivedTasks(ownerSessionId: string): number {
    return this.listTasksByOwner(ownerSessionId).filter((task) => task.status !== 'archived').length
  }

  async insertTask(record: TaskRecord): Promise<TaskRecord> {
    const parsed = taskRecordSchema.parse(record)
    await this.tasks.put(parsed.taskId, parsed)
    return parsed
  }

  /**
   * Atomic task mutation with optimistic locking. The revision check runs inside
   * the domain's update chain, so a stale `expectedRevision` can never win.
   */
  async mutateTask(
    taskId: string,
    expectedRevision: number | undefined,
    mutate: (current: TaskRecord) => TaskRecord,
  ): Promise<TaskRecord> {
    try {
      return await this.tasks.update(taskId, (current) => {
        if (expectedRevision !== undefined && current.revision !== expectedRevision) {
          throw new TaskEngineError(
            'TASK_REVISION_CONFLICT',
            `任务 ${taskId} 的 revision 已变化：期望 ${expectedRevision}，实际 ${current.revision}；请先 task_get 再重试`,
            { retryable: true, details: { expectedRevision, actualRevision: current.revision } },
          )
        }
        const next = mutate({ ...current })
        return taskRecordSchema.parse({ ...next, updatedAt: next.updatedAt || this.now() })
      })
    } catch (error) {
      throw this.normaliseWriteError(error, 'TASK_NOT_FOUND', `任务 ${taskId} 不存在或已被清理`)
    }
  }

  // ------------------------------------------------------------------ runs

  getRun(runId: string): RunRecord | undefined {
    return this.runs.get(runId)
  }

  requireRun(runId: string): RunRecord {
    const run = this.runs.get(runId)
    if (!run) throw new TaskEngineError('TASK_RUN_NOT_FOUND', `运行 ${runId} 不存在或已被清理`)
    return run
  }

  requireOwnedRun(runId: string, sessionId: string): RunRecord {
    const run = this.runs.get(runId)
    if (!run || run.taskOwnerSessionId !== sessionId) {
      throw new TaskEngineError('TASK_RUN_NOT_FOUND', `运行 ${runId} 不存在或不属于当前会话`)
    }
    return run
  }

  listRuns(): RunRecord[] {
    return [...this.runs.entries()].map(([, run]) => run)
  }

  listRunsByTask(taskId: string): RunRecord[] {
    return this.listRuns()
      .filter((run) => run.taskId === taskId)
      .sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : a.runId < b.runId ? 1 : -1))
  }

  listActiveRunsByOwner(ownerSessionId: string): RunRecord[] {
    return this.listRuns().filter(
      (run) => run.taskOwnerSessionId === ownerSessionId && (run.status === 'queued' || run.status === 'running'),
    )
  }

  listActiveRunsByTask(taskId: string): RunRecord[] {
    return this.listRuns().filter(
      (run) => run.taskId === taskId && (run.status === 'queued' || run.status === 'running'),
    )
  }

  findRunByIdempotencyKey(taskId: string, idempotencyKey: string): RunRecord | undefined {
    return this.listRunsByTask(taskId).find((run) => run.idempotencyKey === idempotencyKey)
  }

  async insertRun(record: RunRecord): Promise<RunRecord> {
    const parsed = runRecordSchema.parse(record)
    await this.runs.put(parsed.runId, parsed)
    return parsed
  }

  async mutateRun(runId: string, mutate: (current: RunRecord) => RunRecord): Promise<RunRecord> {
    try {
      return await this.runs.update(runId, (current) => {
        const next = mutate({ ...current })
        return runRecordSchema.parse({ ...next, updatedAt: this.now() })
      })
    } catch (error) {
      throw this.normaliseWriteError(error, 'TASK_RUN_NOT_FOUND', `运行 ${runId} 不存在或已被清理`)
    }
  }

  // ----------------------------------------------------------------- steps

  getStep(runId: string, stepId: string): RunStepRecord | undefined {
    return this.steps.get(stepKey(runId, stepId))
  }

  listSteps(runId: string): RunStepRecord[] {
    return [...this.steps.entries()]
      .filter(([key]) => key.startsWith(`${runId}/`))
      .map(([, step]) => step)
      .sort((a, b) => a.order - b.order)
  }

  async putStep(record: RunStepRecord): Promise<RunStepRecord> {
    const parsed = runStepRecordSchema.parse(record)
    await this.steps.put(stepKey(parsed.runId, parsed.stepId), parsed)
    return parsed
  }

  /**
   * Steps are written before the run record on every transition, so a crash
   * leaves the run short of its terminal write (recoverable: the startup scan
   * marks it interrupted) rather than reporting progress that was never stored.
   */
  async putSteps(records: RunStepRecord[]): Promise<void> {
    for (const record of records) {
      await this.putStep(record)
    }
  }

  async mutateStep(
    runId: string,
    stepId: string,
    mutate: (current: RunStepRecord) => RunStepRecord,
  ): Promise<RunStepRecord> {
    const key = stepKey(runId, stepId)
    try {
      return await this.steps.update(key, (current) => {
        const next = mutate({ ...current })
        return runStepRecordSchema.parse({ ...next, updatedAt: this.now() })
      })
    } catch (error) {
      throw this.normaliseWriteError(
        error,
        'TASK_STEP_ORDER_INVALID',
        `步骤 ${stepId} 不属于运行 ${runId}`,
      )
    }
  }

  async deleteRunCascade(runId: string): Promise<{ stepsDeleted: number; runDeleted: boolean }> {
    const stepKeys = [...this.steps.keys()].filter((key) => key.startsWith(`${runId}/`))
    const stepsDeleted = stepKeys.length > 0 ? await this.steps.deleteMany(stepKeys) : 0
    const runDeleted = await this.runs.delete(runId)
    return { stepsDeleted, runDeleted }
  }

  // ------------------------------------------------------------------ meta

  readMetaState(): GlobalState | undefined {
    return this.meta.get(META_KEY)
  }

  async writeMetaState(state: GlobalState): Promise<void> {
    await this.meta.put(META_KEY, globalStateSchema.parse(state))
  }

  // --------------------------------------------------------------- helpers

  private normaliseWriteError(error: unknown, notFoundCode: 'TASK_NOT_FOUND' | 'TASK_RUN_NOT_FOUND' | 'TASK_STEP_ORDER_INVALID', notFoundMessage: string): unknown {
    if (error instanceof TaskEngineError) return error
    const message = error instanceof Error ? error.message : String(error)
    if (/missing-key/.test(message)) {
      return new TaskEngineError(notFoundCode, notFoundMessage)
    }
    return error
  }
}
