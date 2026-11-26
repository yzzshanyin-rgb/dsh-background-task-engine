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
import type { DomainLike, KvTableLike } from '../host.js';
import { type GlobalState, type RunRecord, type RunStepRecord, type TaskRecord } from '../domain/records.js';
export declare class Repository {
    readonly domain: DomainLike;
    private readonly now;
    readonly tasks: KvTableLike<TaskRecord>;
    readonly runs: KvTableLike<RunRecord>;
    readonly steps: KvTableLike<RunStepRecord>;
    readonly meta: KvTableLike<GlobalState>;
    constructor(domain: DomainLike, now?: () => string);
    getTask(taskId: string): TaskRecord | undefined;
    requireTask(taskId: string): TaskRecord;
    /**
     * Ownership gate for every tool entry point (PRD 10.1). A record owned by a
     * different Session is reported as "not found" so the error cannot be used to
     * probe another Session's data.
     */
    requireOwnedTask(taskId: string, sessionId: string): TaskRecord;
    listTasks(): TaskRecord[];
    listTasksByOwner(ownerSessionId: string): TaskRecord[];
    countUnarchivedTasks(ownerSessionId: string): number;
    insertTask(record: TaskRecord): Promise<TaskRecord>;
    /**
     * Atomic task mutation with optimistic locking. The revision check runs inside
     * the domain's update chain, so a stale `expectedRevision` can never win.
     */
    mutateTask(taskId: string, expectedRevision: number | undefined, mutate: (current: TaskRecord) => TaskRecord): Promise<TaskRecord>;
    getRun(runId: string): RunRecord | undefined;
    requireRun(runId: string): RunRecord;
    requireOwnedRun(runId: string, sessionId: string): RunRecord;
    listRuns(): RunRecord[];
    listRunsByTask(taskId: string): RunRecord[];
    listActiveRunsByOwner(ownerSessionId: string): RunRecord[];
    listActiveRunsByTask(taskId: string): RunRecord[];
    findRunByIdempotencyKey(taskId: string, idempotencyKey: string): RunRecord | undefined;
    insertRun(record: RunRecord): Promise<RunRecord>;
    mutateRun(runId: string, mutate: (current: RunRecord) => RunRecord): Promise<RunRecord>;
    getStep(runId: string, stepId: string): RunStepRecord | undefined;
    listSteps(runId: string): RunStepRecord[];
    putStep(record: RunStepRecord): Promise<RunStepRecord>;
    /**
     * Steps are written before the run record on every transition, so a crash
     * leaves the run short of its terminal write (recoverable: the startup scan
     * marks it interrupted) rather than reporting progress that was never stored.
     */
    putSteps(records: RunStepRecord[]): Promise<void>;
    mutateStep(runId: string, stepId: string, mutate: (current: RunStepRecord) => RunStepRecord): Promise<RunStepRecord>;
    deleteRunCascade(runId: string): Promise<{
        stepsDeleted: number;
        runDeleted: boolean;
    }>;
    readMetaState(): GlobalState | undefined;
    writeMetaState(state: GlobalState): Promise<void>;
    private normaliseWriteError;
}
