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
import { TaskEngineError } from '../errors.js';
import { TABLES, globalStateSchema, runRecordSchema, runStepRecordSchema, stepKey, taskRecordSchema, } from '../domain/records.js';
import { META_KEY } from './spec.js';
export class Repository {
    domain;
    now;
    tasks;
    runs;
    steps;
    meta;
    constructor(domain, now = () => new Date().toISOString()) {
        this.domain = domain;
        this.now = now;
        this.tasks = domain.table(TABLES.tasks);
        this.runs = domain.table(TABLES.runs);
        this.steps = domain.table(TABLES.steps);
        this.meta = domain.table('meta');
    }
    // ----------------------------------------------------------------- tasks
    getTask(taskId) {
        return this.tasks.get(taskId);
    }
    requireTask(taskId) {
        const task = this.tasks.get(taskId);
        if (!task) {
            throw new TaskEngineError('TASK_NOT_FOUND', `任务 ${taskId} 不存在或已被清理`);
        }
        return task;
    }
    /**
     * Ownership gate for every tool entry point (PRD 10.1). A record owned by a
     * different Session is reported as "not found" so the error cannot be used to
     * probe another Session's data.
     */
    requireOwnedTask(taskId, sessionId) {
        const task = this.tasks.get(taskId);
        if (!task || task.ownerSessionId !== sessionId) {
            throw new TaskEngineError('TASK_NOT_FOUND', `任务 ${taskId} 不存在或不属于当前会话`);
        }
        return task;
    }
    listTasks() {
        return [...this.tasks.entries()].map(([, task]) => task);
    }
    listTasksByOwner(ownerSessionId) {
        return this.listTasks().filter((task) => task.ownerSessionId === ownerSessionId);
    }
    countUnarchivedTasks(ownerSessionId) {
        return this.listTasksByOwner(ownerSessionId).filter((task) => task.status !== 'archived').length;
    }
    async insertTask(record) {
        const parsed = taskRecordSchema.parse(record);
        await this.tasks.put(parsed.taskId, parsed);
        return parsed;
    }
    /**
     * Atomic task mutation with optimistic locking. The revision check runs inside
     * the domain's update chain, so a stale `expectedRevision` can never win.
     */
    async mutateTask(taskId, expectedRevision, mutate) {
        try {
            return await this.tasks.update(taskId, (current) => {
                if (expectedRevision !== undefined && current.revision !== expectedRevision) {
                    throw new TaskEngineError('TASK_REVISION_CONFLICT', `任务 ${taskId} 的 revision 已变化：期望 ${expectedRevision}，实际 ${current.revision}；请先 task_get 再重试`, { retryable: true, details: { expectedRevision, actualRevision: current.revision } });
                }
                const next = mutate({ ...current });
                return taskRecordSchema.parse({ ...next, updatedAt: next.updatedAt || this.now() });
            });
        }
        catch (error) {
            throw this.normaliseWriteError(error, 'TASK_NOT_FOUND', `任务 ${taskId} 不存在或已被清理`);
        }
    }
    // ------------------------------------------------------------------ runs
    getRun(runId) {
        return this.runs.get(runId);
    }
    requireRun(runId) {
        const run = this.runs.get(runId);
        if (!run)
            throw new TaskEngineError('TASK_RUN_NOT_FOUND', `运行 ${runId} 不存在或已被清理`);
        return run;
    }
    requireOwnedRun(runId, sessionId) {
        const run = this.runs.get(runId);
        if (!run || run.taskOwnerSessionId !== sessionId) {
            throw new TaskEngineError('TASK_RUN_NOT_FOUND', `运行 ${runId} 不存在或不属于当前会话`);
        }
        return run;
    }
    listRuns() {
        return [...this.runs.entries()].map(([, run]) => run);
    }
    listRunsByTask(taskId) {
        return this.listRuns()
            .filter((run) => run.taskId === taskId)
            .sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : a.runId < b.runId ? 1 : -1));
    }
    listActiveRunsByOwner(ownerSessionId) {
        return this.listRuns().filter((run) => run.taskOwnerSessionId === ownerSessionId && (run.status === 'queued' || run.status === 'running'));
    }
    listActiveRunsByTask(taskId) {
        return this.listRuns().filter((run) => run.taskId === taskId && (run.status === 'queued' || run.status === 'running'));
    }
    findRunByIdempotencyKey(taskId, idempotencyKey) {
        return this.listRunsByTask(taskId).find((run) => run.idempotencyKey === idempotencyKey);
    }
    async insertRun(record) {
        const parsed = runRecordSchema.parse(record);
        await this.runs.put(parsed.runId, parsed);
        return parsed;
    }
    async mutateRun(runId, mutate) {
        try {
            return await this.runs.update(runId, (current) => {
                const next = mutate({ ...current });
                return runRecordSchema.parse({ ...next, updatedAt: this.now() });
            });
        }
        catch (error) {
            throw this.normaliseWriteError(error, 'TASK_RUN_NOT_FOUND', `运行 ${runId} 不存在或已被清理`);
        }
    }
    // ----------------------------------------------------------------- steps
    getStep(runId, stepId) {
        return this.steps.get(stepKey(runId, stepId));
    }
    listSteps(runId) {
        return [...this.steps.entries()]
            .filter(([key]) => key.startsWith(`${runId}/`))
            .map(([, step]) => step)
            .sort((a, b) => a.order - b.order);
    }
    async putStep(record) {
        const parsed = runStepRecordSchema.parse(record);
        await this.steps.put(stepKey(parsed.runId, parsed.stepId), parsed);
        return parsed;
    }
    /**
     * Steps are written before the run record on every transition, so a crash
     * leaves the run short of its terminal write (recoverable: the startup scan
     * marks it interrupted) rather than reporting progress that was never stored.
     */
    async putSteps(records) {
        for (const record of records) {
            await this.putStep(record);
        }
    }
    async mutateStep(runId, stepId, mutate) {
        const key = stepKey(runId, stepId);
        try {
            return await this.steps.update(key, (current) => {
                const next = mutate({ ...current });
                return runStepRecordSchema.parse({ ...next, updatedAt: this.now() });
            });
        }
        catch (error) {
            throw this.normaliseWriteError(error, 'TASK_STEP_ORDER_INVALID', `步骤 ${stepId} 不属于运行 ${runId}`);
        }
    }
    async deleteRunCascade(runId) {
        const stepKeys = [...this.steps.keys()].filter((key) => key.startsWith(`${runId}/`));
        const stepsDeleted = stepKeys.length > 0 ? await this.steps.deleteMany(stepKeys) : 0;
        const runDeleted = await this.runs.delete(runId);
        return { stepsDeleted, runDeleted };
    }
    // ------------------------------------------------------------------ meta
    readMetaState() {
        return this.meta.get(META_KEY);
    }
    async writeMetaState(state) {
        await this.meta.put(META_KEY, globalStateSchema.parse(state));
    }
    // --------------------------------------------------------------- helpers
    normaliseWriteError(error, notFoundCode, notFoundMessage) {
        if (error instanceof TaskEngineError)
            return error;
        const message = error instanceof Error ? error.message : String(error);
        if (/missing-key/.test(message)) {
            return new TaskEngineError(notFoundCode, notFoundMessage);
        }
        return error;
    }
}
