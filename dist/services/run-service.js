/**
 * Run lifecycle: creation, heartbeats, step reports, finishing, recovery.
 *
 * Two rules shape this file.
 *
 * 1. A run is created inside one serialized critical section: the idempotency
 *    lookup, the concurrency count, the reservation and the insert are one
 *    sequence, and the reservation survives a crash. A bare "check then write"
 *    is exactly the race the PRD calls out.
 * 2. A run's cached progress is never the source of truth. Every mutation
 *    recomputes it from the step rows, and a read that finds drift repairs it,
 *    so a step write that outlived a failed summary write heals on the next
 *    touch instead of leaving a run that can never finish.
 */
import { randomBytes } from 'node:crypto';
import { TaskEngineError } from '../errors.js';
import { DEFAULT_RETRY_POLICY, runIndexKey } from '../domain/records.js';
import { ACTIVE_RUN_STATUSES, RESUMABLE_RUN_STATUSES, failedSteps, firstPendingStep, isTerminalRun, occupiesSlot, orderedSteps, requiredProgress, runHealth, runTransitionProblem, startBlockers, stepTransitionProblem, unsettledRequiredSteps, } from '../domain/state.js';
import { parseTriggerMessage } from '../prompt/guidance.js';
import { newRunId } from '../utils/id.js';
import { KeyedMutex } from '../utils/mutex.js';
import { daysAgoIso, isOlderThanMinutes, toMillis } from '../utils/time.js';
import { truncateText } from '../utils/text.js';
import { clampLimit, decodeCursor, encodeCursor } from '../utils/page.js';
export const HISTORY_DEFAULT_LIMIT = 20;
export const HISTORY_MAX_LIMIT = 50;
export class RunService {
    repo;
    config;
    audit;
    now;
    lock = new KeyedMutex();
    constructor(repo, config, audit, now) {
        this.repo = repo;
        this.config = config;
        this.audit = audit;
        this.now = now;
    }
    // -------------------------------------------------------------------------
    // Creation
    // -------------------------------------------------------------------------
    /**
     * Create (or find) the run for one trigger.
     *
     * The same key always yields the same run: for schedules the key is the
     * schedule id plus its occurrence, for manual calls it is the caller's
     * manualRunId. Repeated delivery of one occurrence therefore returns the
     * existing run as `deduplicated` instead of starting a second execution.
     */
    async start(input) {
        const trigger = parseTriggerMessage(input.triggerPayload);
        const taskId = input.taskId ?? trigger.taskId;
        if (taskId === undefined || taskId === '') {
            throw new TaskEngineError('TASK_INVALID_ARGUMENTS', '缺少 taskId，且无法从触发消息中识别任务。');
        }
        const triggerType = input.triggerType ?? (trigger.scheduleId !== undefined ? 'schedule' : 'manual');
        const scheduleId = input.scheduleId ?? trigger.scheduleId;
        const occurrenceKey = input.occurrenceKey ?? trigger.occurrenceKey;
        const task = this.repo.requireOwnedTask(taskId, input.sessionId);
        const idempotencyKey = this.idempotencyKeyFor({ scheduleId, occurrenceKey, manualRunId: input.manualRunId, idempotencyKey: input.idempotencyKey });
        // Everything from here to the committed run is one critical section per
        // (owner, task): two concurrent triggers cannot both pass the checks.
        return this.lock.runExclusive(`start:${task.ownerSessionId}:${task.taskId}`, async () => {
            const currentTask = this.repo.requireOwnedTask(taskId, input.sessionId);
            if (idempotencyKey !== undefined) {
                const existing = this.repo.getIdempotency(currentTask.taskId, idempotencyKey);
                if (existing !== undefined) {
                    if (existing.state === 'committed' && existing.runId !== undefined) {
                        const run = this.repo.getRun(existing.runId);
                        if (run !== undefined) {
                            return { run, steps: this.repo.listSteps(run.runId), deduplicated: true };
                        }
                        // The run was pruned away; the reservation is stale, so take it over.
                        await this.repo.releaseIdempotency(currentTask.taskId, idempotencyKey);
                    }
                    else {
                        // A reservation without a committed run is a crashed attempt.
                        await this.repo.releaseIdempotency(currentTask.taskId, idempotencyKey);
                    }
                }
            }
            if (currentTask.status === 'archived') {
                throw new TaskEngineError('TASK_PERMISSION_DENIED', `任务 ${currentTask.taskId} 已归档，不能执行。`);
            }
            if (currentTask.status === 'paused') {
                throw new TaskEngineError('TASK_PERMISSION_DENIED', `任务 ${currentTask.taskId} 已暂停，恢复后才能执行。`);
            }
            this.assertConcurrency(currentTask.taskId, currentTask.ownerSessionId);
            const at = this.nowIso();
            const lease = this.leaseFrom(at);
            const runId = newRunId();
            const steps = this.buildFreshSteps(runId, currentTask.taskId, currentTask.steps, at);
            const progress = requiredProgress(steps);
            const run = {
                runId,
                taskId: currentTask.taskId,
                taskRevision: currentTask.revision,
                taskOwnerSessionId: currentTask.ownerSessionId,
                sessionId: input.sessionId,
                // A manual call starts executing immediately; `defer` keeps it queued so
                // the caller can claim it with task_run_begin (schedule deliveries).
                status: input.defer === true ? 'queued' : 'running',
                triggerType,
                scheduleId,
                occurrenceKey,
                idempotencyKey,
                currentStepId: steps[0]?.stepId,
                progress: progress.percent,
                requiredTotal: progress.total,
                requiredCompleted: progress.done,
                totalSteps: steps.length,
                startedAt: at,
                updatedAt: at,
                templateSnapshot: {
                    revision: currentTask.revision,
                    title: currentTask.title,
                    steps: currentTask.steps,
                },
                schemaVersion: 2,
                lastHeartbeatAt: at,
                leaseExpiresAt: lease,
                executionToken: this.newExecutionToken(runId, 1),
                executionGeneration: 1,
                needsUserConfirmation: false,
            };
            // Order matters: the step rows exist before the run that references them,
            // and the reservation exists before either, so a crash at any point is
            // visible on the next boot rather than silently half-applied.
            const reserved = idempotencyKey === undefined
                ? undefined
                : await this.repo.reserveIdempotency({
                    taskId: currentTask.taskId,
                    key: idempotencyKey,
                    ownerSessionId: currentTask.ownerSessionId,
                    at,
                });
            if (reserved !== undefined) {
                if (reserved.state === 'committed' && reserved.runId !== undefined) {
                    const existing = this.repo.getRun(reserved.runId);
                    if (existing !== undefined) {
                        return { run: existing, steps: this.repo.listSteps(existing.runId), deduplicated: true };
                    }
                }
                throw new TaskEngineError('TASK_ALREADY_RUNNING', '同一触发键正在创建运行，请稍后重试。');
            }
            try {
                await this.repo.putSteps(steps);
                await this.repo.insertRun(run);
            }
            catch (error) {
                await this.rollbackCreation(run, idempotencyKey, currentTask.taskId);
                throw error;
            }
            if (idempotencyKey !== undefined)
                await this.repo.commitIdempotency(currentTask.taskId, idempotencyKey, runId);
            if (occupiesSlot(run.status))
                await this.repo.addActiveRun(run);
            await this.repo.putRunIndex(run);
            this.audit.record({
                name: 'task.run.started',
                taskId: run.taskId,
                runId: run.runId,
                sessionId: run.sessionId,
                to: run.status,
                source: input.source ?? (triggerType === 'schedule' ? 'schedule' : 'manual'),
            });
            return { run, steps, deduplicated: false };
        });
    }
    async begin(input) {
        return this.lock.runExclusive(`run:${input.runId}`, async () => {
            const current = this.repo.requireOwnedRun(input.runId, input.sessionId);
            this.assertToken(current, input.executionToken);
            const steps = this.repo.listSteps(current.runId);
            const first = firstPendingStep(steps);
            const next = await this.repo.mutateRun(current.runId, (run) => {
                const draft = {
                    ...run,
                    status: run.status === 'queued' ? 'running' : run.status,
                    currentStepId: first?.stepId ?? run.currentStepId,
                    lastHeartbeatAt: this.nowIso(),
                    leaseExpiresAt: this.leaseFrom(this.nowIso()),
                    staleDetectedAt: undefined,
                };
                return draft;
            });
            if (next.status === 'running')
                await this.repo.refreshActiveRunLease(next.runId, next.leaseExpiresAt);
            return { run: next, steps: this.repo.listSteps(next.runId), deduplicated: false };
        });
    }
    // -------------------------------------------------------------------------
    // Heartbeat / lease
    // -------------------------------------------------------------------------
    /**
     * Accept one heartbeat and renew the lease.
     *
     * A heartbeat is evidence about the executor, not about the work: it never
     * changes a step's result and never decides that an external effect did not
     * happen.
     */
    async heartbeat(input) {
        return this.lock.runExclusive(`run:${input.runId}`, async () => {
            const current = this.repo.requireOwnedRun(input.runId, input.sessionId);
            if (isTerminalRun(current.status)) {
                throw new TaskEngineError('TASK_RUN_ALREADY_FINISHED', `运行 ${current.runId} 已结束（${current.status}），不再接受心跳。`);
            }
            const warning = this.tokenWarning(current, input.executionToken);
            this.assertToken(current, input.executionToken);
            const at = this.nowIso();
            const next = await this.repo.mutateRun(current.runId, (run) => ({
                ...run,
                lastHeartbeatAt: at,
                leaseExpiresAt: this.leaseFrom(at),
                staleDetectedAt: undefined,
            }));
            await this.repo.refreshActiveRunLease(next.runId, next.leaseExpiresAt);
            return { run: next, leaseExpiresAt: next.leaseExpiresAt, accepted: true, warning };
        });
    }
    // -------------------------------------------------------------------------
    // Step reports
    // -------------------------------------------------------------------------
    async reportStep(input) {
        return this.lock.runExclusive(`run:${input.runId}`, async () => {
            const current = this.repo.requireOwnedRun(input.runId, input.sessionId);
            if (isTerminalRun(current.status)) {
                throw new TaskEngineError('TASK_RUN_ALREADY_FINISHED', `运行 ${current.runId} 已结束（${current.status}），不能再上报步骤。`);
            }
            this.assertToken(current, input.executionToken);
            const steps = this.repo.listSteps(current.runId);
            const target = steps.find((step) => step.stepId === input.stepId);
            if (target === undefined) {
                throw new TaskEngineError('TASK_STEP_ORDER_INVALID', `步骤 ${input.stepId} 不在本次运行的模板快照内。`);
            }
            const at = this.nowIso();
            if (input.action === 'started') {
                const blockers = startBlockers(steps, input.stepId);
                if (blockers.length > 0) {
                    throw new TaskEngineError('TASK_STEP_ORDER_INVALID', `步骤 ${input.stepId} 不能开始：前置步骤 ${blockers.map((step) => step.stepId).join('、')} 尚未完成。`);
                }
                if (target.status === 'pending') {
                    const claimed = await this.repo.mutateStep(current.runId, input.stepId, (step) => ({
                        ...step,
                        status: 'running',
                        startedAt: step.startedAt ?? at,
                        attempt: step.attempt + 1,
                        lastHeartbeatAt: at,
                    }));
                    this.audit.record({
                        name: 'task.step.changed', taskId: current.taskId, runId: current.runId,
                        stepId: input.stepId, from: 'pending', to: claimed.status, sessionId: input.sessionId,
                    });
                }
                else if (target.status !== 'running') {
                    throw new TaskEngineError('TASK_STEP_ORDER_INVALID', `步骤 ${input.stepId} 已是 ${target.status}，不能重新开始。`);
                }
            }
            else {
                const nextStatus = input.action === 'completed' ? 'completed' : input.action === 'failed' ? 'failed' : 'skipped';
                if (target.status === nextStatus) {
                    throw new TaskEngineError('TASK_STEP_ORDER_INVALID', `步骤 ${input.stepId} 已经是 ${nextStatus}，不能重复上报。`);
                }
                const problem = stepTransitionProblem(target.status, nextStatus);
                if (problem !== undefined) {
                    throw new TaskEngineError('TASK_STEP_ORDER_INVALID', `步骤 ${input.stepId} 不能从 ${target.status} 变为 ${nextStatus}；未开始的步骤请先上报 started。`);
                }
                if (input.action === 'failed' && input.error === undefined) {
                    throw new TaskEngineError('TASK_INVALID_ARGUMENTS', '上报 failed 时必须提供 error。');
                }
                const summary = truncateText(input.summary, this.config.maxSummaryChars.get());
                const claimed = await this.repo.mutateStep(current.runId, input.stepId, (step) => ({
                    ...step,
                    status: nextStatus,
                    summary,
                    error: input.error,
                    finishedAt: at,
                    failureCategory: input.action === 'failed' ? (input.failureCategory ?? 'unknown') : undefined,
                }));
                this.audit.record({
                    name: 'task.step.changed', taskId: current.taskId, runId: current.runId,
                    stepId: input.stepId, from: target.status, to: claimed.status, sessionId: input.sessionId,
                });
            }
            const after = this.repo.listSteps(current.runId);
            const run = await this.syncRunSummary(current.runId, after, {
                lastHeartbeatAt: at,
                leaseExpiresAt: this.leaseFrom(at),
                staleDetectedAt: undefined,
            });
            return { run, step: this.repo.getStep(current.runId, input.stepId) ?? target, steps: after };
        });
    }
    // -------------------------------------------------------------------------
    // Finish
    // -------------------------------------------------------------------------
    async finish(input) {
        return this.lock.runExclusive(`run:${input.runId}`, async () => {
            const current = this.repo.requireOwnedRun(input.runId, input.sessionId);
            if (isTerminalRun(current.status)) {
                throw new TaskEngineError('TASK_RUN_ALREADY_FINISHED', `运行 ${current.runId} 已结束（${current.status}）。`);
            }
            this.assertToken(current, input.executionToken);
            const steps = this.repo.listSteps(current.runId);
            if (input.status === 'succeeded') {
                const unsettled = unsettledRequiredSteps(steps);
                if (unsettled.length > 0) {
                    throw new TaskEngineError('TASK_STEP_ORDER_INVALID', `仍有必需步骤未完成：${unsettled.map((step) => step.stepId).join('、')}，不能标记为 succeeded。`);
                }
            }
            if (input.status === 'failed' && failedSteps(steps).length === 0 && input.error === undefined) {
                throw new TaskEngineError('TASK_INVALID_ARGUMENTS', '标记 failed 时必须有失败的步骤或提供 error。');
            }
            if (input.status === 'blocked' && (input.summary === undefined || input.summary.trim() === '')) {
                throw new TaskEngineError('TASK_INVALID_ARGUMENTS', '标记 blocked 时必须说明等待什么。');
            }
            const at = this.nowIso();
            const summary = truncateText(input.summary, this.config.maxSummaryChars.get());
            const progress = requiredProgress(steps);
            const needsConfirmation = input.status === 'failed' ? this.requiresConfirmation(steps) : false;
            // A run finished from step reports carries no explicit error, but the
            // failing step's message is the summary a later reader needs. Never let a
            // bare `failed` erase the evidence already recorded on the step.
            const derivedError = input.error ?? failedSteps(steps)[0]?.error;
            const run = await this.repo.mutateRun(current.runId, (row) => ({
                ...row,
                status: input.status,
                progress: progress.percent,
                requiredCompleted: progress.done,
                requiredTotal: progress.total,
                currentStepId: firstPendingStep(steps)?.stepId,
                // blocked waits for a human; only terminal statuses record a finish time
                finishedAt: isTerminalRun(input.status) ? at : row.finishedAt,
                summary: summary ?? row.summary,
                error: input.status === 'succeeded' ? undefined : (derivedError ?? row.error),
                failureCategory: input.status === 'succeeded'
                    ? undefined
                    : input.failureCategory
                        ?? (derivedError === undefined ? row.failureCategory : (failedSteps(steps)[0]?.failureCategory ?? 'unknown')),
                needsUserConfirmation: needsConfirmation,
                lastHeartbeatAt: row.lastHeartbeatAt,
            }));
            await this.repo.removeActiveRun(run.runId);
            await this.repo.putRunIndex(run);
            this.audit.record({
                name: 'task.run.finished', taskId: run.taskId, runId: run.runId,
                from: current.status, to: run.status, sessionId: input.sessionId, detail: input.failureCategory,
            });
            return { run, steps };
        });
    }
    // -------------------------------------------------------------------------
    // Recovery
    // -------------------------------------------------------------------------
    /**
     * Start a new run from a finished one.
     *
     * The old run keeps its status and its steps: it is the record of what
     * happened. The new run carries `resumesRunId`, a fresh execution credential
     * and a higher generation, so the previous agent's reports can no longer
     * touch it.
     */
    async resume(input) {
        const source = this.repo.requireOwnedRun(input.runId, input.sessionId);
        // A run that may still be executing must never be resumed in parallel; that
        // check has to come first, or the resume would race the original executor.
        if (ACTIVE_RUN_STATUSES.includes(source.status)) {
            throw new TaskEngineError('TASK_ALREADY_RUNNING', `运行 ${source.runId} 仍在执行，不能同时启动恢复。`);
        }
        if (!RESUMABLE_RUN_STATUSES.includes(source.status)) {
            throw new TaskEngineError('TASK_INVALID_ARGUMENTS', `运行 ${source.runId} 的状态为 ${source.status}，只有 ${RESUMABLE_RUN_STATUSES.join('/')} 可以恢复。`);
        }
        return this.lock.runExclusive(`start:${source.taskOwnerSessionId}:${source.taskId}`, async () => {
            const task = this.repo.requireOwnedTask(source.taskId, input.sessionId);
            if (task.status === 'archived') {
                throw new TaskEngineError('TASK_PERMISSION_DENIED', '任务已归档，不能恢复运行。');
            }
            const sourceSteps = this.repo.listSteps(source.runId);
            const failed = failedSteps(sourceSteps);
            const risky = failed.filter((step) => (step.retryPolicy ?? DEFAULT_RETRY_POLICY) !== 'safe_retry');
            const needsConfirmation = risky.length > 0 || source.needsUserConfirmation === true;
            if (needsConfirmation && (input.confirmation === undefined || input.confirmation.trim() === '')) {
                throw new TaskEngineError('TASK_PERMISSION_DENIED', `恢复运行 ${source.runId} 会重复执行可能已产生外部副作用的步骤（${risky.map((step) => step.stepId).join('、') || '见失败步骤'}），请先向用户确认，再用 confirmation 说明确认内容后重试。`);
            }
            this.assertConcurrency(task.taskId, task.ownerSessionId);
            const at = this.nowIso();
            const runId = newRunId();
            const generation = (source.executionGeneration ?? 1) + 1;
            const steps = sourceSteps.map((step) => {
                if (step.status === 'completed' || step.status === 'skipped') {
                    return {
                        ...step,
                        runId,
                        taskId: task.taskId,
                        carryOverFromRunId: source.runId,
                        updatedAt: at,
                    };
                }
                return {
                    runId,
                    stepId: step.stepId,
                    taskId: task.taskId,
                    order: step.order,
                    title: step.title,
                    required: step.required,
                    status: 'pending',
                    attempt: step.attempt,
                    retryPolicy: step.retryPolicy ?? DEFAULT_RETRY_POLICY,
                    updatedAt: at,
                };
            });
            const progress = requiredProgress(steps);
            const run = {
                runId,
                taskId: task.taskId,
                taskRevision: source.taskRevision,
                taskOwnerSessionId: task.ownerSessionId,
                sessionId: input.sessionId,
                // The agent that asked to resume runs it right away; queued would wait
                // for a task_run_begin nobody is going to send.
                status: 'running',
                triggerType: source.triggerType,
                scheduleId: source.scheduleId,
                occurrenceKey: `${source.occurrenceKey ?? source.runId}:resume:${runId}`.slice(0, 256),
                currentStepId: firstPendingStep(steps)?.stepId,
                progress: progress.percent,
                requiredTotal: progress.total,
                requiredCompleted: progress.done,
                totalSteps: steps.length,
                startedAt: at,
                updatedAt: at,
                resumesRunId: source.runId,
                templateSnapshot: source.templateSnapshot,
                schemaVersion: 2,
                lastHeartbeatAt: at,
                leaseExpiresAt: this.leaseFrom(at),
                executionToken: this.newExecutionToken(runId, generation),
                executionGeneration: generation,
                needsUserConfirmation: false,
                recoveryConfirmation: {
                    sourceRunId: source.runId,
                    failedStepIds: failed.map((step) => step.stepId),
                    confirmedAt: at,
                    confirmationNote: truncateText(input.note ?? input.confirmation, 2000),
                },
            };
            await this.repo.putSteps(steps);
            await this.repo.insertRun(run);
            await this.repo.addActiveRun(run);
            await this.repo.putRunIndex(run);
            this.audit.record({
                name: 'task.run.resumed', taskId: run.taskId, runId: run.runId,
                sessionId: input.sessionId, from: source.runId, to: run.status,
                detail: needsConfirmation ? 'confirmed' : 'no-confirmation-needed',
            });
            return { run, steps: this.repo.listSteps(runId), deduplicated: false };
        });
    }
    /**
     * Find runs whose executor is gone.
     *
     * During a live process a missing heartbeat is only a suspicion, so it is
     * recorded and nothing else. At startup the previous process is provably
     * gone, which is the one moment the engine may declare the run interrupted —
     * and even then the steps are marked failed, never re-run.
     */
    async scanStale(options) {
        const staleMinutes = this.config.staleRunAfterMinutes.get();
        const now = this.now();
        const at = now.toISOString();
        let scanned = 0;
        let suspected = 0;
        let interrupted = 0;
        for (const run of this.repo.listRuns()) {
            if (options.sessionId !== undefined && run.taskOwnerSessionId !== options.sessionId)
                continue;
            if (!ACTIVE_RUN_STATUSES.includes(run.status))
                continue;
            scanned += 1;
            const heartbeat = run.lastHeartbeatAt ?? run.updatedAt;
            const silent = isOlderThanMinutes(heartbeat, staleMinutes, now.getTime());
            const leaseExpired = run.leaseExpiresAt !== undefined && toMillis(run.leaseExpiresAt) < now.getTime();
            if (!silent && !leaseExpired)
                continue;
            if (!options.startup) {
                if (run.staleDetectedAt === undefined) {
                    await this.repo.mutateRun(run.runId, (row) => ({ ...row, staleDetectedAt: at }));
                    suspected += 1;
                }
                continue;
            }
            const steps = this.repo.listSteps(run.runId);
            const error = {
                code: 'TASK_RUN_INTERRUPTED',
                message: `运行超过 ${staleMinutes} 分钟没有心跳（最后活动 ${heartbeat}），无法核验原执行是否已终止，已标记为中断。`,
            };
            const updated = await this.repo.mutateRun(run.runId, (row) => ({
                ...row,
                status: 'interrupted',
                error,
                failureCategory: leaseExpired ? 'timeout' : 'unknown',
                needsUserConfirmation: true,
                finishedAt: at,
                staleDetectedAt: row.staleDetectedAt ?? at,
            }));
            for (const step of steps) {
                if (step.status === 'running') {
                    await this.repo.mutateStep(run.runId, step.stepId, (row) => ({
                        ...row,
                        status: 'failed',
                        error,
                        failureCategory: 'unknown',
                        finishedAt: at,
                    })).catch(() => undefined);
                }
            }
            await this.repo.removeActiveRun(run.runId);
            await this.repo.putRunIndex(updated);
            this.audit.record({
                name: 'task.run.finished', taskId: updated.taskId, runId: updated.runId,
                from: run.status, to: 'interrupted', detail: 'stale-scan',
            });
            interrupted += 1;
        }
        const meta = this.repo.readMetaState() ?? { schemaVersion: 2, appliedMigrations: {} };
        await this.repo.writeMetaState({ ...meta, lastRecoveryScanAt: at });
        return { scanned, suspected, interrupted, scannedAt: at };
    }
    // -------------------------------------------------------------------------
    // Reads
    // -------------------------------------------------------------------------
    /**
     * History page.
     *
     * Keyset pagination on (startedAt, runId): a cursor names the last row shown,
     * so a page never repeats or skips rows that share a timestamp, and the
     * index makes the read a range instead of a scan of every run.
     */
    history(input) {
        this.repo.requireOwnedTask(input.taskId, input.sessionId);
        const limit = clampLimit(input.limit, HISTORY_DEFAULT_LIMIT, HISTORY_MAX_LIMIT);
        const cursor = decodeCursor(input.cursor);
        const { rows, hasMore } = this.repo.listRunIndexByTask(input.taskId, {
            status: input.status,
            before: cursor === undefined ? undefined : { startedAt: cursor.u, runId: cursor.i },
            limit,
        });
        const mapped = [];
        for (const row of rows) {
            const run = this.repo.getRun(row.runId);
            if (run === undefined)
                continue;
            mapped.push(this.toHistoryRow(run, this.repo.listSteps(run.runId)));
        }
        const last = rows.at(-1);
        return {
            rows: mapped,
            nextCursor: hasMore && last !== undefined ? encodeCursor({ u: last.startedAt, i: last.runId }) : undefined,
            total: mapped.length,
        };
    }
    /** Repair a run whose cached summary drifted from its steps. */
    async reconcileRun(runId) {
        const run = this.repo.getRun(runId);
        if (run === undefined)
            throw new TaskEngineError('TASK_RUN_NOT_FOUND', `运行 ${runId} 不存在。`);
        const steps = this.repo.listSteps(runId);
        const progress = requiredProgress(steps);
        const currentStepId = firstPendingStep(steps)?.stepId;
        const drift = progress.percent !== run.progress
            || progress.done !== run.requiredCompleted
            || progress.total !== run.requiredTotal
            || currentStepId !== run.currentStepId;
        if (!drift)
            return { run, repaired: false };
        const fixed = await this.repo.mutateRun(runId, (row) => ({
            ...row,
            progress: progress.percent,
            requiredCompleted: progress.done,
            requiredTotal: progress.total,
            currentStepId,
        }));
        await this.repo.putRunIndex(fixed);
        return { run: fixed, repaired: true };
    }
    async stepsOf(runId) {
        return this.repo.listSteps(runId);
    }
    countActiveRuns(ownerSessionId) {
        return this.repo.listActiveRunsByOwner(ownerSessionId).length;
    }
    countBlockedRuns(ownerSessionId) {
        return this.repo.listTasksByOwner(ownerSessionId)
            .flatMap((task) => this.repo.listRunsByTask(task.taskId))
            .filter((run) => run.status === 'blocked').length;
    }
    countInterruptedRuns(ownerSessionId) {
        return this.repo.listTasksByOwner(ownerSessionId)
            .flatMap((task) => this.repo.listRunsByTask(task.taskId))
            .filter((run) => run.status === 'interrupted').length;
    }
    healthOf(run) {
        return runHealth(run, this.now(), {
            timeoutMinutes: this.config.defaultTimeoutMinutes.get(),
            staleMinutes: this.config.staleRunAfterMinutes.get(),
        });
    }
    // -------------------------------------------------------------------------
    // Maintenance
    // -------------------------------------------------------------------------
    /**
     * Delete expired terminal runs in bounded batches.
     *
     * Never touches a run that still occupies a slot, and never touches steps of
     * a run it is not deleting, so an interrupted prune costs at most one run.
     */
    async prune(batchSize = 200) {
        const retentionDays = this.config.historyRetentionDays.get();
        const cutoff = daysAgoIso(retentionDays, this.now().getTime());
        let runsDeleted = 0;
        let stepsDeleted = 0;
        const touched = [];
        for (const run of this.repo.listRuns()) {
            if (runsDeleted >= batchSize)
                break;
            if (!isTerminalRun(run.status))
                continue;
            const finished = run.finishedAt ?? run.updatedAt;
            if (finished >= cutoff)
                continue;
            const result = await this.repo.deleteRunCascade(run);
            runsDeleted += 1;
            stepsDeleted += result.stepsDeleted;
            if (run.idempotencyKey !== undefined) {
                await this.repo.releaseIdempotency(run.taskId, run.idempotencyKey).catch(() => undefined);
            }
            touched.push({ taskId: run.taskId, runId: run.runId });
        }
        // Expired reservations from crashed creations are not runs; clear them too.
        for (const [key, row] of this.repo.idempotency.entries()) {
            if (row.state !== 'reserved')
                continue;
            if (!isOlderThanMinutes(row.updatedAt, this.config.staleRunAfterMinutes.get(), this.now().getTime()))
                continue;
            await this.repo.idempotency.delete(key).catch(() => undefined);
        }
        const at = this.nowIso();
        const meta = this.repo.readMetaState() ?? { schemaVersion: 2, appliedMigrations: {} };
        await this.repo.writeMetaState({ ...meta, lastPruneAt: at });
        void touched;
        return { runsDeleted, stepsDeleted, at };
    }
    // -------------------------------------------------------------------------
    // Internals
    // -------------------------------------------------------------------------
    idempotencyKeyFor(input) {
        if (input.idempotencyKey !== undefined && input.idempotencyKey !== '')
            return input.idempotencyKey.slice(0, 300);
        if (input.scheduleId !== undefined && input.scheduleId !== '') {
            const occurrence = input.occurrenceKey ?? 'unknown';
            return `schedule:${input.scheduleId}:${occurrence}`.slice(0, 300);
        }
        if (input.manualRunId !== undefined && input.manualRunId !== '')
            return `manual:${input.manualRunId}`.slice(0, 300);
        return undefined;
    }
    /**
     * Reject before creating anything: the counts come from the active-run index,
     * which holds exactly the rows that occupy a slot.
     */
    assertConcurrency(taskId, ownerSessionId) {
        const activeForTask = this.repo.listActiveRunsByTask(taskId);
        const maxPerTask = this.config.maxParallelRunsPerTask.get();
        if (activeForTask.length >= maxPerTask) {
            // Point the caller at the run that is in the way: "already running" alone
            // leaves an agent guessing which run to wait for.
            throw new TaskEngineError('TASK_ALREADY_RUNNING', `任务 ${taskId} 已有 ${activeForTask.length} 个运行在执行（上限 ${maxPerTask}）。`, { relatedRunId: activeForTask[0]?.runId });
        }
        const activeForOwner = this.repo.listActiveRunsByOwner(ownerSessionId);
        const maxPerOwner = this.config.maxActiveRunsPerOwner.get();
        if (activeForOwner.length >= maxPerOwner) {
            throw new TaskEngineError('TASK_MAX_CONCURRENCY', `当前会话已有 ${activeForOwner.length} 个运行（上限 ${maxPerOwner}），请等待其中一个结束后再试。`, { relatedRunId: activeForOwner[0]?.runId });
        }
    }
    buildFreshSteps(runId, taskId, definitions, at) {
        return [...definitions]
            .sort((a, b) => a.order - b.order)
            .map((definition) => ({
            runId,
            stepId: definition.stepId,
            taskId,
            order: definition.order,
            title: definition.title,
            required: definition.required,
            status: 'pending',
            attempt: 0,
            retryPolicy: definition.retryPolicy ?? DEFAULT_RETRY_POLICY,
            updatedAt: at,
        }));
    }
    async rollbackCreation(run, idempotencyKey, taskId) {
        if (idempotencyKey !== undefined)
            await this.repo.releaseIdempotency(taskId, idempotencyKey).catch(() => undefined);
        await this.repo.deleteSteps(run.runId).catch(() => undefined);
        await this.repo.runs.delete(run.runId).catch(() => undefined);
        await this.repo.removeActiveRun(run.runId).catch(() => undefined);
    }
    /** Recompute the run's cached summary from the step rows after a step write. */
    async syncRunSummary(runId, steps, liveness) {
        const progress = requiredProgress(steps);
        const currentStepId = firstPendingStep(steps)?.stepId;
        return this.repo.mutateRun(runId, (row) => ({
            ...row,
            status: row.status === 'queued' ? 'running' : row.status,
            progress: progress.percent,
            requiredCompleted: progress.done,
            requiredTotal: progress.total,
            currentStepId,
            lastHeartbeatAt: liveness.lastHeartbeatAt ?? row.lastHeartbeatAt,
            leaseExpiresAt: liveness.leaseExpiresAt ?? row.leaseExpiresAt,
            staleDetectedAt: liveness.staleDetectedAt,
        }));
    }
    requiresConfirmation(steps) {
        const failed = failedSteps(steps);
        if (failed.length === 0)
            return false;
        return failed.some((step) => (step.retryPolicy ?? DEFAULT_RETRY_POLICY) !== 'safe_retry');
    }
    /**
     * Credential policy, stated once:
     * - a run written before 1.2.0 has no token, so any caller may report on it;
     * - a caller that presents no token on a token-bearing run is accepted for
     *   compatibility and gets a warning, because 1.1.x agents never sent one;
     * - a caller that presents the wrong token is rejected: it is a live agent
     *   from a generation that no longer owns this run.
     */
    assertToken(run, token) {
        if (token === undefined || token === '')
            return;
        if (run.executionToken === undefined)
            return;
        if (token !== run.executionToken) {
            throw new TaskEngineError('TASK_RUN_INTERRUPTED', `执行凭证已失效：运行 ${run.runId} 当前属于第 ${run.executionGeneration ?? 1} 代执行，请重新 task_run_begin 获取新的 executionToken。`);
        }
    }
    tokenWarning(run, token) {
        if (token !== undefined && token !== '')
            return undefined;
        if (run.executionToken === undefined)
            return undefined;
        return '未提供 executionToken，已按兼容模式接受；建议后续调用携带 task_run 返回的 executionToken，以免旧执行写入新运行。';
    }
    newExecutionToken(runId, generation) {
        return `exec_${runId}_${generation}_${randomBytes(6).toString('hex')}`;
    }
    leaseFrom(at) {
        const millis = toMillis(at) || this.now().getTime();
        return new Date(millis + this.config.staleRunAfterMinutes.get() * 60_000).toISOString();
    }
    nowIso() {
        return this.now().toISOString();
    }
    toHistoryRow(run, steps) {
        const row = {
            steps: steps.map((step) => ({
                stepId: step.stepId,
                order: step.order,
                title: step.title,
                status: step.status,
                required: step.required,
            })),
            runId: run.runId,
            taskId: run.taskId,
            status: run.status,
            triggerType: run.triggerType,
            taskRevision: run.taskRevision,
            startedAt: run.startedAt,
            progress: run.progress,
            requiredCompleted: run.requiredCompleted,
            requiredTotal: run.requiredTotal,
        };
        if (run.finishedAt !== undefined)
            row.finishedAt = run.finishedAt;
        if (run.summary !== undefined)
            row.summary = run.summary;
        if (run.error !== undefined)
            row.error = run.error;
        if (run.failureCategory !== undefined)
            row.failureCategory = run.failureCategory;
        if (run.resumesRunId !== undefined)
            row.resumesRunId = run.resumesRunId;
        if (run.needsUserConfirmation !== undefined)
            row.needsUserConfirmation = run.needsUserConfirmation;
        return row;
    }
}
export { runIndexKey, orderedSteps, runTransitionProblem };
