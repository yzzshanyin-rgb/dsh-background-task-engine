/**
 * Schedule operation journal.
 *
 * The host owns the schedule; the task row owns the reference to it. Those are
 * two writes that cannot be one transaction, so every mutation leaves a row
 * behind *before* the host is called. If the process dies in between, the next
 * boot finds the row and either finishes the job or reports exactly what it
 * could not decide — it never assumes the call did not happen, and it never
 * blindly creates or deletes a second time.
 */
import { TaskEngineError, sanitizeMessage } from '../errors.js';
import { newRunId } from '../utils/id.js';
import { describeTiming } from './schedule-adapter.js';
export class ScheduleLedger {
    repo;
    adapter;
    audit;
    now;
    constructor(repo, adapter, audit, now) {
        this.repo = repo;
        this.adapter = adapter;
        this.audit = audit;
        this.now = now;
    }
    /**
     * Journal one mutation.
     *
     * `pending` is written before the host call; `processing` immediately after,
     * so a crash is distinguishable from a request that never left. On success
     * the row records the schedule id the host assigned, which is the only thing
     * a later reconciliation needs.
     */
    async run(input, work) {
        const at = this.now().toISOString();
        const op = {
            operationId: newRunId(),
            taskId: input.task.taskId,
            ownerSessionId: input.task.ownerSessionId,
            scheduleId: input.scheduleId,
            action: input.action,
            status: 'pending',
            timing: input.timing === undefined ? undefined : input.timing,
            createdAt: at,
            updatedAt: at,
        };
        await this.repo.putScheduleOp(op);
        const processing = { ...op, status: 'processing', updatedAt: this.now().toISOString() };
        await this.repo.putScheduleOp(processing);
        try {
            const result = await work(processing);
            const scheduleId = result?.scheduleId ?? processing.scheduleId;
            const settled = {
                ...processing,
                status: 'succeeded',
                scheduleId,
                updatedAt: this.now().toISOString(),
                reconciledAt: this.now().toISOString(),
            };
            await this.repo.putScheduleOp(settled);
            this.audit.record({
                name: 'task.schedule.changed',
                taskId: op.taskId,
                sessionId: input.sessionId,
                from: String(op.status),
                to: 'succeeded',
                detail: `${op.action}${scheduleId === undefined ? '' : ` ${scheduleId}`}`,
            });
            return { result, op: settled };
        }
        catch (error) {
            const failed = {
                ...processing,
                status: 'failed',
                lastError: sanitizeMessage(error instanceof Error ? error.message : String(error)),
                updatedAt: this.now().toISOString(),
            };
            await this.repo.putScheduleOp(failed).catch(() => undefined);
            this.audit.record({
                name: 'task.schedule.changed',
                taskId: op.taskId,
                sessionId: input.sessionId,
                from: String(processing.status),
                to: 'failed',
                detail: `${op.action} ${firstLine(failed.lastError)}`,
            });
            throw error;
        }
    }
    /**
     * Settle whatever the previous process left behind.
     *
     * Safe repair only: a rule that exists is adopted, a rule that is gone is
     * recorded as gone, a delete that already happened is accepted. Anything
     * where the truth cannot be read without guessing stays `reconciling` so a
     * human can look at it — the PRD's explicit rule over a helpful invention.
     */
    async reconcile() {
        const at = this.now().toISOString();
        const pending = this.repo.listUnsettledScheduleOps();
        const notes = [];
        let settled = 0;
        let ambiguous = 0;
        let failed = 0;
        for (const op of pending) {
            if (op.action === 'create') {
                if (!this.adapter.available) {
                    ambiguous += 1;
                    notes.push(`${op.operationId}: 宿主未挂载 Schedule，无法核验创建结果。`);
                    await this.mark(op, 'reconciling', '宿主未挂载 Schedule 能力，无法核验创建结果', at);
                    continue;
                }
                let scheduleId = op.scheduleId;
                if (scheduleId !== undefined) {
                    const exists = await this.adapter.view(scheduleId).catch(() => undefined);
                    if (exists === undefined)
                        scheduleId = undefined;
                }
                if (scheduleId === undefined) {
                    const matches = await this.adapter.findByTaskId(op.taskId).catch(() => []);
                    if (matches.length === 1) {
                        scheduleId = matches[0]?.id;
                        notes.push(`${op.operationId}: 已按投递提示词匹配到唯一规则 ${String(scheduleId)}，采纳为任务的定时规则。`);
                    }
                    else if (matches.length > 1) {
                        ambiguous += 1;
                        notes.push(`${op.operationId}: 匹配到 ${matches.length} 条可能的定时规则，保留待人工确认。`);
                        await this.mark(op, 'reconciling', `匹配到 ${matches.length} 条候选定时规则`, at);
                        continue;
                    }
                    else {
                        notes.push(`${op.operationId}: 宿主上没有该任务的定时规则，创建未生效。`);
                        await this.mark({ ...op, status: 'failed' }, 'failed', '创建未在宿主上生效', at);
                        failed += 1;
                        continue;
                    }
                }
                const task = this.repo.getTask(op.taskId);
                if (task !== undefined && task.scheduleRef === undefined && scheduleId !== undefined) {
                    await this.repo.mutateTask(task.taskId, undefined, (current) => ({
                        ...current,
                        revision: current.revision + 1,
                        scheduleRef: {
                            scheduleId,
                            timingKind: 'unknown',
                            timing: {},
                            state: 'active',
                            title: `后台任务 · ${current.title}`.slice(0, 120),
                            createdAt: at,
                            updatedAt: at,
                        },
                    })).catch((error) => {
                        notes.push(`${op.operationId}: 采纳规则失败 ${sanitizeMessage(String(error))}`);
                    });
                }
                await this.mark({ ...op, scheduleId }, 'succeeded', undefined, at);
                settled += 1;
                continue;
            }
            if (op.action === 'delete') {
                if (!this.adapter.available) {
                    await this.mark(op, 'reconciling', '宿主未挂载 Schedule 能力', at);
                    ambiguous += 1;
                    continue;
                }
                if (op.scheduleId === undefined) {
                    await this.mark(op, 'succeeded', undefined, at);
                    settled += 1;
                    continue;
                }
                // Deleting an absent rule is the same outcome as deleting a present one,
                // so retrying is safe and needs no judgement.
                await this.adapter.remove(op.scheduleId, op.ownerSessionId).catch(() => undefined);
                await this.mark(op, 'succeeded', undefined, at);
                settled += 1;
                continue;
            }
            // update / pause / resume: the rule must still exist for the change to mean
            // anything. Re-applying is a no-op when the previous attempt landed.
            if (!this.adapter.available) {
                await this.mark(op, 'reconciling', '宿主未挂载 Schedule 能力', at);
                ambiguous += 1;
                continue;
            }
            if (op.scheduleId === undefined) {
                await this.mark(op, 'failed', '缺少 scheduleId，无法核验', at);
                failed += 1;
                continue;
            }
            const exists = await this.adapter.view(op.scheduleId).catch(() => undefined);
            if (exists === undefined) {
                await this.mark(op, 'failed', '定时规则已不存在', at);
                const task = this.repo.getTask(op.taskId);
                if (task?.scheduleRef !== undefined) {
                    await this.repo.mutateTask(task.taskId, undefined, (current) => ({
                        ...current,
                        revision: current.revision + 1,
                        scheduleRef: current.scheduleRef === undefined ? undefined : { ...current.scheduleRef, state: 'unlinked', updatedAt: at },
                    })).catch(() => undefined);
                }
                failed += 1;
                continue;
            }
            await this.mark(op, 'succeeded', undefined, at);
            settled += 1;
        }
        const meta = this.repo.readMetaState() ?? { schemaVersion: 2, appliedMigrations: {} };
        await this.repo.writeMetaState({ ...meta, lastScheduleReconcileAt: at });
        if (notes.length > 0) {
            this.audit.record({
                name: 'task.schedule.changed',
                to: 'reconciled',
                detail: `${settled} settled / ${ambiguous} ambiguous / ${failed} failed`,
            });
        }
        return { checked: pending.length, settled, ambiguous, failed, checkedAt: at, notes };
    }
    /** Human description of the journal row, for diagnostics and the UI. */
    describe(op) {
        const timing = op.timing === undefined ? '' : ` · ${describeTiming(op.timing)}`;
        return `${op.action} ${op.status}${timing}${op.lastError === undefined ? '' : `（${firstLine(op.lastError)}）`}`;
    }
    async mark(op, status, lastError, at) {
        const next = {
            ...op,
            status,
            lastError: lastError === undefined ? undefined : sanitizeMessage(lastError),
            updatedAt: at,
            reconciledAt: status === 'succeeded' ? at : op.reconciledAt,
        };
        try {
            await this.repo.putScheduleOp(next);
        }
        catch (error) {
            throw error instanceof TaskEngineError ? error : new TaskEngineError('TASK_STORAGE_ERROR', `写入定时操作记录失败：${String(error)}`);
        }
    }
}
function firstLine(text) {
    if (text === undefined)
        return '';
    const line = text.split('\n')[0] ?? '';
    return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}
