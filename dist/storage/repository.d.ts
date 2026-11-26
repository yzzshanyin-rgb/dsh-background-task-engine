/**
 * Storage access for tasks, runs, steps and the three 1.2.0 indexes.
 *
 * Ownership is enforced here rather than in the services so a forgotten check
 * cannot leak another session's rows: every `requireOwned*` helper answers
 * `TASK_NOT_FOUND` / `TASK_RUN_NOT_FOUND` for a row that exists but belongs to
 * someone else, which is also what stops the tools from being an existence
 * oracle.
 */
import { invalidArguments } from '../errors.js';
import { type ActiveRunRecord, type GlobalState, type IdempotencyRecord, type RunIndexRecord, type RunRecord, type RunStepRecord, type ScheduleOpRecord, type TaskRecord } from '../domain/records.js';
import type { DomainLike, KvTableLike } from '../host.js';
export interface MutateOptions {
    now: () => Date;
}
export declare class Repository {
    private readonly domain;
    private readonly now;
    readonly tasks: KvTableLike<TaskRecord>;
    readonly runs: KvTableLike<RunRecord>;
    readonly steps: KvTableLike<RunStepRecord>;
    readonly idempotency: KvTableLike<IdempotencyRecord>;
    readonly activeRuns: KvTableLike<ActiveRunRecord>;
    readonly runIndex: KvTableLike<RunIndexRecord>;
    readonly scheduleOps: KvTableLike<ScheduleOpRecord>;
    readonly meta: KvTableLike<GlobalState>;
    constructor(domain: DomainLike, now: () => Date);
    getDomain(): DomainLike;
    getTask(taskId: string): TaskRecord | undefined;
    requireTask(taskId: string): TaskRecord;
    requireOwnedTask(taskId: string, sessionId: string): TaskRecord;
    listTasks(): TaskRecord[];
    listTasksByOwner(sessionId: string): TaskRecord[];
    countUnarchivedTasks(sessionId: string): number;
    insertTask(task: TaskRecord): Promise<TaskRecord>;
    /**
     * Optimistic mutate.
     *
     * The revision comparison happens inside the table mutator, which the host
     * runs in the key's serialized slot: two writers cannot both observe
     * revision N and both succeed.
     */
    mutateTask(taskId: string, expectedRevision: number | undefined, mutate: (current: TaskRecord) => TaskRecord): Promise<TaskRecord>;
    getRun(runId: string): RunRecord | undefined;
    requireRun(runId: string): RunRecord;
    /**
     * A run belongs to the session that owns its task. Cross-session access is
     * indistinguishable from absence, by design.
     */
    requireOwnedRun(runId: string, sessionId: string): RunRecord;
    listRuns(): RunRecord[];
    listRunsByTask(taskId: string): RunRecord[];
    /**
     * Runs owned by one session.
     *
     * The run table is the authority for ownership (`taskOwnerSessionId`), so this
     * stays correct even if a task row is archived or removed later.
     */
    listRunsByOwner(ownerSessionId: string): RunRecord[];
    listActiveRuns(): ActiveRunRecord[];
    /** Runs that hold a concurrency slot, for one owner. O(active), not O(all). */
    listActiveRunsByOwner(ownerSessionId: string): ActiveRunRecord[];
    listActiveRunsByTask(taskId: string): ActiveRunRecord[];
    insertRun(run: RunRecord): Promise<void>;
    mutateRun(runId: string, mutate: (current: RunRecord) => RunRecord): Promise<RunRecord>;
    getStep(runId: string, stepId: string): RunStepRecord | undefined;
    listSteps(runId: string): RunStepRecord[];
    putStep(step: RunStepRecord): Promise<void>;
    putSteps(steps: RunStepRecord[]): Promise<void>;
    /**
     * Step mutate with the transition checked inside the mutator.
     *
     * A concurrent report for the same step therefore fails on the stored row,
     * not on a snapshot read before the write — which is what stops a second
     * `completed` from overwriting the first one's summary.
     */
    mutateStep(runId: string, stepId: string, mutate: (current: RunStepRecord) => RunStepRecord): Promise<RunStepRecord>;
    deleteSteps(runId: string): Promise<number>;
    getIdempotency(taskId: string, key: string): IdempotencyRecord | undefined;
    /**
     * Take the reservation for a key.
     *
     * Returns the row that already held it, or `undefined` after storing ours.
     * The caller holds the per-task lock, so "check then put" is not racy inside
     * one engine; the stored row is what makes it survive a restart.
     */
    reserveIdempotency(input: {
        taskId: string;
        key: string;
        ownerSessionId: string;
        at: string;
    }): Promise<IdempotencyRecord | undefined>;
    commitIdempotency(taskId: string, key: string, runId: string): Promise<void>;
    releaseIdempotency(taskId: string, key: string): Promise<void>;
    addActiveRun(run: RunRecord): Promise<void>;
    removeActiveRun(runId: string): Promise<void>;
    refreshActiveRunLease(runId: string, leaseExpiresAt: string | undefined): Promise<void>;
    putRunIndex(run: RunRecord): Promise<void>;
    deleteRunIndex(run: RunRecord): Promise<void>;
    /**
     * History page, newest first, from the per-task index.
     *
     * Keys are ``${taskId}/${startedAt}/${runId}`` so a page is a range over a
     * sorted table: no full scan, and runs sharing a millisecond still order
     * deterministically by runId.
     */
    listRunIndexByTask(taskId: string, options: {
        status?: string;
        before?: {
            startedAt: string;
            runId: string;
        };
        limit: number;
    }): {
        rows: RunIndexRecord[];
        hasMore: boolean;
    };
    getScheduleOp(operationId: string): ScheduleOpRecord | undefined;
    putScheduleOp(op: ScheduleOpRecord): Promise<void>;
    listScheduleOps(taskId?: string): ScheduleOpRecord[];
    listUnsettledScheduleOps(): ScheduleOpRecord[];
    readMetaState(): GlobalState | undefined;
    writeMetaState(state: GlobalState): Promise<void>;
    deleteRunCascade(run: RunRecord): Promise<{
        stepsDeleted: number;
        runDeleted: boolean;
    }>;
    private updateOrReject;
    private tableFor;
    private normaliseWriteError;
    private write;
}
export { invalidArguments };
