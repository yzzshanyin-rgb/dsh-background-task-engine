/**
 * Storage access for tasks, runs, steps and the three 1.2.0 indexes.
 *
 * Ownership is enforced here rather than in the services so a forgotten check
 * cannot leak another session's rows: every `requireOwned*` helper answers
 * `TASK_NOT_FOUND` / `TASK_RUN_NOT_FOUND` for a row that exists but belongs to
 * someone else, which is also what stops the tools from being an existence
 * oracle.
 */

import { TaskEngineError, invalidArguments } from '../errors.js';
import {
  TABLES,
  activeRunRecordSchema,
  idempotencyKeyOf,
  idempotencyRecordSchema,
  runIndexKey,
  runIndexRecordSchema,
  runRecordSchema,
  runStepRecordSchema,
  scheduleOpRecordSchema,
  stepKey,
  taskRecordSchema,
  type ActiveRunRecord,
  type GlobalState,
  type IdempotencyRecord,
  type RunIndexRecord,
  type RunRecord,
  type RunStepRecord,
  type ScheduleOpRecord,
  type TaskRecord,
} from '../domain/records.js';
import { runTransitionProblem, stepTransitionProblem } from '../domain/state.js';
import type { DomainLike, KvTableLike } from '../host.js';

const META_KEY = 'global';

export interface MutateOptions {
  now: () => Date;
}

export class Repository {
  readonly tasks: KvTableLike<TaskRecord>;
  readonly runs: KvTableLike<RunRecord>;
  readonly steps: KvTableLike<RunStepRecord>;
  readonly idempotency: KvTableLike<IdempotencyRecord>;
  readonly activeRuns: KvTableLike<ActiveRunRecord>;
  readonly runIndex: KvTableLike<RunIndexRecord>;
  readonly scheduleOps: KvTableLike<ScheduleOpRecord>;
  readonly meta: KvTableLike<GlobalState>;

  constructor(
    private readonly domain: DomainLike,
    private readonly now: () => Date,
  ) {
    this.tasks = domain.table<TaskRecord>(TABLES.tasks);
    this.runs = domain.table<RunRecord>(TABLES.runs);
    this.steps = domain.table<RunStepRecord>(TABLES.steps);
    this.idempotency = domain.table<IdempotencyRecord>(TABLES.idempotency);
    this.activeRuns = domain.table<ActiveRunRecord>(TABLES.activeRuns);
    this.runIndex = domain.table<RunIndexRecord>(TABLES.runIndex);
    this.scheduleOps = domain.table<ScheduleOpRecord>(TABLES.scheduleOps);
    this.meta = domain.table<GlobalState>(TABLES.meta);
  }

  getDomain(): DomainLike {
    return this.domain;
  }

  // -------------------------------------------------------------------------
  // Tasks
  // -------------------------------------------------------------------------

  getTask(taskId: string): TaskRecord | undefined {
    return this.tasks.get(taskId);
  }

  requireTask(taskId: string): TaskRecord {
    const task = this.tasks.get(taskId);
    if (task === undefined) {
      throw new TaskEngineError('TASK_NOT_FOUND', `任务 ${taskId} 不存在。`);
    }
    return task;
  }

  requireOwnedTask(taskId: string, sessionId: string): TaskRecord {
    const task = this.tasks.get(taskId);
    if (task === undefined || task.ownerSessionId !== sessionId) {
      throw new TaskEngineError('TASK_NOT_FOUND', `任务 ${taskId} 不存在，或不属于当前会话。`);
    }
    return task;
  }

  listTasks(): TaskRecord[] {
    return [...this.tasks.entries()].map(([, task]) => task);
  }

  listTasksByOwner(sessionId: string): TaskRecord[] {
    return this.listTasks().filter((task) => task.ownerSessionId === sessionId);
  }

  countUnarchivedTasks(sessionId: string): number {
    return this.listTasksByOwner(sessionId).filter((task) => task.status !== 'archived').length;
  }

  async insertTask(task: TaskRecord): Promise<TaskRecord> {
    const parsed = taskRecordSchema.parse(task);
    if (this.tasks.get(parsed.taskId) !== undefined) {
      throw new TaskEngineError('TASK_ALREADY_RUNNING', `任务 ${parsed.taskId} 已存在。`);
    }
    await this.write(() => this.tasks.put(parsed.taskId, parsed), 'TASK_STORAGE_ERROR');
    return parsed;
  }

  /**
   * Optimistic mutate.
   *
   * The revision comparison happens inside the table mutator, which the host
   * runs in the key's serialized slot: two writers cannot both observe
   * revision N and both succeed.
   */
  async mutateTask(
    taskId: string,
    expectedRevision: number | undefined,
    mutate: (current: TaskRecord) => TaskRecord,
  ): Promise<TaskRecord> {
    const table = this.tasks;
    const apply = (current: TaskRecord): TaskRecord => {
      if (expectedRevision !== undefined && current.revision !== expectedRevision) {
        throw new TaskEngineError(
          'TASK_REVISION_CONFLICT',
          `任务 ${taskId} 的 revision 已由 ${expectedRevision} 变为 ${current.revision}，请重新读取后再试。`,
        );
      }
      const next = taskRecordSchema.parse({ ...mutate(current), updatedAt: this.now().toISOString() });
      if (next.revision < current.revision) {
        throw new TaskEngineError('TASK_REVISION_CONFLICT', 'revision 不能回退。');
      }
      return next;
    };
    return this.updateOrReject(taskId, apply, 'task');
  }

  // -------------------------------------------------------------------------
  // Runs
  // -------------------------------------------------------------------------

  getRun(runId: string): RunRecord | undefined {
    return this.runs.get(runId);
  }

  requireRun(runId: string): RunRecord {
    const run = this.runs.get(runId);
    if (run === undefined) {
      throw new TaskEngineError('TASK_RUN_NOT_FOUND', `运行 ${runId} 不存在。`);
    }
    return run;
  }

  /**
   * A run belongs to the session that owns its task. Cross-session access is
   * indistinguishable from absence, by design.
   */
  requireOwnedRun(runId: string, sessionId: string): RunRecord {
    const run = this.runs.get(runId);
    if (run === undefined || run.taskOwnerSessionId !== sessionId) {
      throw new TaskEngineError('TASK_RUN_NOT_FOUND', `运行 ${runId} 不存在，或不属于当前会话。`);
    }
    return run;
  }

  listRuns(): RunRecord[] {
    return [...this.runs.entries()].map(([, run]) => run);
  }

  listRunsByTask(taskId: string): RunRecord[] {
    return this.listRuns().filter((run) => run.taskId === taskId);
  }

  /**
   * Runs owned by one session.
   *
   * The run table is the authority for ownership (`taskOwnerSessionId`), so this
   * stays correct even if a task row is archived or removed later.
   */
  listRunsByOwner(ownerSessionId: string): RunRecord[] {
    return this.listRuns().filter((run) => run.taskOwnerSessionId === ownerSessionId);
  }

  listActiveRuns(): ActiveRunRecord[] {
    return [...this.activeRuns.entries()].map(([, row]) => row);
  }

  /** Runs that hold a concurrency slot, for one owner. O(active), not O(all). */
  listActiveRunsByOwner(ownerSessionId: string): ActiveRunRecord[] {
    return [...this.activeRuns.entries()]
      .map(([, row]) => row)
      .filter((row) => row.ownerSessionId === ownerSessionId);
  }

  listActiveRunsByTask(taskId: string): ActiveRunRecord[] {
    return [...this.activeRuns.entries()].map(([, row]) => row).filter((row) => row.taskId === taskId);
  }

  async insertRun(run: RunRecord): Promise<void> {
    const parsed = runRecordSchema.parse(run);
    if (this.runs.get(parsed.runId) !== undefined) {
      throw new TaskEngineError('TASK_ALREADY_RUNNING', `运行 ${parsed.runId} 已存在。`);
    }
    await this.write(() => this.runs.put(parsed.runId, parsed), 'TASK_STORAGE_ERROR');
  }

  async mutateRun(runId: string, mutate: (current: RunRecord) => RunRecord): Promise<RunRecord> {
    return this.updateOrReject(
      runId,
      (current) => {
        const draft = mutate(current);
        if (draft.status !== current.status) {
          const problem = runTransitionProblem(current.status, draft.status);
          if (problem !== undefined) {
            if (problem.kind === 'already-finished') {
              throw new TaskEngineError('TASK_RUN_ALREADY_FINISHED', `运行 ${runId} 已结束（${current.status}），不能再次变更。`);
            }
            if (problem.kind === 'same-status') {
              throw new TaskEngineError('TASK_ALREADY_RUNNING', `运行 ${runId} 已经是 ${current.status}。`);
            }
            throw new TaskEngineError(
              'TASK_STEP_ORDER_INVALID',
              `运行状态不能从 ${problem.from} 变为 ${problem.to}。`,
            );
          }
        }
        return runRecordSchema.parse({ ...draft, updatedAt: this.now().toISOString() });
      },
      'run',
    );
  }

  // -------------------------------------------------------------------------
  // Steps
  // -------------------------------------------------------------------------

  getStep(runId: string, stepId: string): RunStepRecord | undefined {
    return this.steps.get(stepKey(runId, stepId));
  }

  listSteps(runId: string): RunStepRecord[] {
    const prefix = `${runId}/`;
    const rows: RunStepRecord[] = [];
    for (const [key, step] of this.steps.entries()) {
      if (key.startsWith(prefix)) rows.push(step);
    }
    return rows.sort((a, b) => a.order - b.order);
  }

  async putStep(step: RunStepRecord): Promise<void> {
    const parsed = runStepRecordSchema.parse(step);
    await this.write(() => this.steps.put(stepKey(parsed.runId, parsed.stepId), parsed), 'TASK_STORAGE_ERROR');
  }

  async putSteps(steps: RunStepRecord[]): Promise<void> {
    for (const step of steps) await this.putStep(step);
  }

  /**
   * Step mutate with the transition checked inside the mutator.
   *
   * A concurrent report for the same step therefore fails on the stored row,
   * not on a snapshot read before the write — which is what stops a second
   * `completed` from overwriting the first one's summary.
   */
  async mutateStep(
    runId: string,
    stepId: string,
    mutate: (current: RunStepRecord) => RunStepRecord,
  ): Promise<RunStepRecord> {
    const key = stepKey(runId, stepId);
    return this.updateOrReject(
      key,
      (current) => {
        const draft = mutate(current);
        if (draft.status !== current.status) {
          const problem = stepTransitionProblem(current.status, draft.status);
          if (problem !== undefined) {
            if (problem.kind === 'same-status') {
              throw new TaskEngineError('TASK_STEP_ORDER_INVALID', `步骤 ${stepId} 已经是 ${current.status}。`);
            }
            if (problem.kind === 'illegal') {
              throw new TaskEngineError(
                'TASK_STEP_ORDER_INVALID',
                `步骤 ${stepId} 不能从 ${problem.from} 变为 ${problem.to}。`,
              );
            }
            throw new TaskEngineError('TASK_STEP_ORDER_INVALID', `步骤 ${stepId} 当前状态不允许修改。`);
          }
        }
        return runStepRecordSchema.parse({ ...draft, updatedAt: this.now().toISOString() });
      },
      'step',
      `${runId}/${stepId}`,
    );
  }

  async deleteSteps(runId: string): Promise<number> {
    const prefix = `${runId}/`;
    const keys = [...this.steps.entries()].map(([key]) => key).filter((key) => key.startsWith(prefix));
    if (keys.length === 0) return 0;
    await this.steps.deleteMany(keys);
    return keys.length;
  }

  // -------------------------------------------------------------------------
  // Idempotency
  // -------------------------------------------------------------------------

  getIdempotency(taskId: string, key: string): IdempotencyRecord | undefined {
    return this.idempotency.get(idempotencyKeyOf(taskId, key));
  }

  /**
   * Take the reservation for a key.
   *
   * Returns the row that already held it, or `undefined` after storing ours.
   * The caller holds the per-task lock, so "check then put" is not racy inside
   * one engine; the stored row is what makes it survive a restart.
   */
  async reserveIdempotency(input: {
    taskId: string;
    key: string;
    ownerSessionId: string;
    at: string;
  }): Promise<IdempotencyRecord | undefined> {
    const storageKey = idempotencyKeyOf(input.taskId, input.key);
    const existing = this.idempotency.get(storageKey);
    if (existing !== undefined) return existing;
    const row = idempotencyRecordSchema.parse({
      taskId: input.taskId,
      idempotencyKey: input.key,
      ownerSessionId: input.ownerSessionId,
      state: 'reserved',
      createdAt: input.at,
      updatedAt: input.at,
    });
    await this.write(() => this.idempotency.put(storageKey, row), 'TASK_STORAGE_ERROR');
    return undefined;
  }

  async commitIdempotency(taskId: string, key: string, runId: string): Promise<void> {
    const storageKey = idempotencyKeyOf(taskId, key);
    await this.idempotency.update(storageKey, (current) => idempotencyRecordSchema.parse({
      ...current,
      state: 'committed',
      runId,
      updatedAt: this.now().toISOString(),
    }));
  }

  async releaseIdempotency(taskId: string, key: string): Promise<void> {
    await this.idempotency.delete(idempotencyKeyOf(taskId, key));
  }

  // -------------------------------------------------------------------------
  // Active-run index
  // -------------------------------------------------------------------------

  async addActiveRun(run: RunRecord): Promise<void> {
    const row = activeRunRecordSchema.parse({
      runId: run.runId,
      taskId: run.taskId,
      ownerSessionId: run.taskOwnerSessionId,
      sessionId: run.sessionId,
      startedAt: run.startedAt,
      leaseExpiresAt: run.leaseExpiresAt,
    });
    if (this.activeRuns.get(run.runId) === undefined) await this.activeRuns.put(run.runId, row);
    else await this.activeRuns.update(run.runId, () => row);
  }

  async removeActiveRun(runId: string): Promise<void> {
    if (this.activeRuns.get(runId) !== undefined) await this.activeRuns.delete(runId);
  }

  async refreshActiveRunLease(runId: string, leaseExpiresAt: string | undefined): Promise<void> {
    if (this.activeRuns.get(runId) === undefined) return;
    await this.activeRuns.update(runId, (current) => activeRunRecordSchema.parse({ ...current, leaseExpiresAt }));
  }

  // -------------------------------------------------------------------------
  // Per-task run index (history pagination)
  // -------------------------------------------------------------------------

  async putRunIndex(run: RunRecord): Promise<void> {
    const key = runIndexKey(run.taskId, run.startedAt, run.runId);
    const row = runIndexRecordSchema.parse({
      runId: run.runId,
      taskId: run.taskId,
      ownerSessionId: run.taskOwnerSessionId,
      status: run.status,
      startedAt: run.startedAt,
    });
    if (this.runIndex.get(key) === undefined) await this.runIndex.put(key, row);
    else await this.runIndex.update(key, () => row);
  }

  async deleteRunIndex(run: RunRecord): Promise<void> {
    const key = runIndexKey(run.taskId, run.startedAt, run.runId);
    if (this.runIndex.get(key) !== undefined) await this.runIndex.delete(key);
  }

  /**
   * History page, newest first, from the per-task index.
   *
   * Keys are ``${taskId}/${startedAt}/${runId}`` so a page is a range over a
   * sorted table: no full scan, and runs sharing a millisecond still order
   * deterministically by runId.
   */
  listRunIndexByTask(
    taskId: string,
    options: { status?: string; before?: { startedAt: string; runId: string }; limit: number },
  ): { rows: RunIndexRecord[]; hasMore: boolean } {
    const prefix = `${taskId}/`;
    const all = [...this.runIndex.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, row]) => row)
      .sort((a, b) => (a.startedAt === b.startedAt ? (a.runId < b.runId ? 1 : -1) : (a.startedAt < b.startedAt ? 1 : -1)));
    const filtered = options.status === undefined ? all : all.filter((row) => row.status === options.status);
    const before = options.before;
    const paged = before === undefined
      ? filtered
      : filtered.filter((row) => row.startedAt < before.startedAt
        || (row.startedAt === before.startedAt && row.runId < before.runId));
    const rows = paged.slice(0, options.limit);
    return { rows, hasMore: paged.length > rows.length };
  }

  // -------------------------------------------------------------------------
  // Schedule journal
  // -------------------------------------------------------------------------

  getScheduleOp(operationId: string): ScheduleOpRecord | undefined {
    return this.scheduleOps.get(operationId);
  }

  async putScheduleOp(op: ScheduleOpRecord): Promise<void> {
    const parsed = scheduleOpRecordSchema.parse(op);
    if (this.scheduleOps.get(parsed.operationId) === undefined) await this.scheduleOps.put(parsed.operationId, parsed);
    else await this.scheduleOps.update(parsed.operationId, () => parsed);
  }

  listScheduleOps(taskId?: string): ScheduleOpRecord[] {
    const rows = [...this.scheduleOps.entries()].map(([, row]) => row);
    return taskId === undefined ? rows : rows.filter((row) => row.taskId === taskId);
  }

  listUnsettledScheduleOps(): ScheduleOpRecord[] {
    return this.listScheduleOps().filter((row) => row.status !== 'succeeded');
  }

  // -------------------------------------------------------------------------
  // Meta
  // -------------------------------------------------------------------------

  readMetaState(): GlobalState | undefined {
    return this.meta.get(META_KEY);
  }

  async writeMetaState(state: GlobalState): Promise<void> {
    if (this.meta.get(META_KEY) === undefined) await this.meta.put(META_KEY, state);
    else await this.meta.update(META_KEY, () => state);
  }

  // -------------------------------------------------------------------------
  // Deletion
  // -------------------------------------------------------------------------

  async deleteRunCascade(run: RunRecord): Promise<{ stepsDeleted: number; runDeleted: boolean }> {
    const stepsDeleted = await this.deleteSteps(run.runId);
    await this.deleteRunIndex(run);
    await this.removeActiveRun(run.runId);
    const deleted = await this.runs.delete(run.runId);
    return { stepsDeleted, runDeleted: deleted };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async updateOrReject<T>(
    key: string,
    mutate: (current: T) => T,
    kind: 'task' | 'run' | 'step',
    stepLabel?: string,
  ): Promise<T> {
    try {
      return await (this.tableFor(kind) as KvTableLike<T>).update(key, mutate);
    } catch (error) {
      throw this.normaliseWriteError(error, kind, key, stepLabel);
    }
  }

  private tableFor(kind: 'task' | 'run' | 'step'): KvTableLike<unknown> {
    if (kind === 'task') return this.tasks as KvTableLike<unknown>;
    if (kind === 'run') return this.runs as KvTableLike<unknown>;
    return this.steps as KvTableLike<unknown>;
  }

  private normaliseWriteError(error: unknown, kind: 'task' | 'run' | 'step', key: string, stepLabel?: string): unknown {
    if (error instanceof TaskEngineError) return error;
    const message = error instanceof Error ? error.message : String(error);
    if (/missing-key/.test(message)) {
      if (kind === 'task') return new TaskEngineError('TASK_NOT_FOUND', `任务 ${key} 不存在。`);
      if (kind === 'run') return new TaskEngineError('TASK_RUN_NOT_FOUND', `运行 ${key} 不存在。`);
      return new TaskEngineError('TASK_RUN_NOT_FOUND', `步骤 ${stepLabel ?? key} 不存在。`);
    }
    return new TaskEngineError('TASK_STORAGE_ERROR', `写入失败：${message}`);
  }

  private async write(operation: () => Promise<void>, code: 'TASK_STORAGE_ERROR'): Promise<void> {
    try {
      await operation();
    } catch (error) {
      if (error instanceof TaskEngineError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new TaskEngineError(code, `写入失败：${message}`);
    }
  }
}

export { invalidArguments };
