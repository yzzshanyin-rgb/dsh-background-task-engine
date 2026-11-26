/**
 * Status machines and the derived health of a run.
 *
 * Nothing here touches storage: these are pure predicates so the same rules can
 * be applied inside a `table.update` mutator (where the read and the write are
 * one atomic step) and in plain validation before a write.
 */
export const ACTIVE_RUN_STATUSES = ['queued', 'running'];
export const TERMINAL_RUN_STATUSES = ['succeeded', 'failed', 'interrupted', 'skipped'];
export const RESUMABLE_RUN_STATUSES = ['failed', 'interrupted', 'blocked'];
/** Statuses that hold a concurrency slot. */
export const OCCUPYING_RUN_STATUSES = ['queued', 'running', 'blocked'];
export function isRunStatus(value) {
    return value === 'queued' || value === 'running' || value === 'blocked'
        || value === 'succeeded' || value === 'failed' || value === 'interrupted' || value === 'skipped';
}
export function isStepStatus(value) {
    return value === 'pending' || value === 'running' || value === 'completed'
        || value === 'failed' || value === 'skipped';
}
export function isTaskStatus(value) {
    return value === 'active' || value === 'paused' || value === 'archived';
}
export function isTerminalRun(status) {
    return TERMINAL_RUN_STATUSES.includes(status);
}
export function isActiveRun(status) {
    return ACTIVE_RUN_STATUSES.includes(status);
}
/** A run that still occupies a concurrency slot. */
export function occupiesSlot(status) {
    return OCCUPYING_RUN_STATUSES.includes(status);
}
const RUN_TRANSITIONS = {
    queued: ['running', 'interrupted', 'skipped', 'failed'],
    running: ['succeeded', 'failed', 'blocked', 'interrupted'],
    // A blocked run may still settle either way once the agent or the user
    // answers the question that blocked it; it may never silently resume.
    blocked: ['failed', 'interrupted'],
    succeeded: [],
    failed: [],
    interrupted: [],
    skipped: [],
};
const STEP_TRANSITIONS = {
    pending: ['running', 'skipped', 'failed'],
    running: ['completed', 'failed', 'skipped'],
    completed: [],
    failed: [],
    skipped: [],
};
export function runTransitionProblem(from, to) {
    if (isTerminalRun(from))
        return { kind: 'already-finished' };
    if (from === to)
        return { kind: 'same-status' };
    if (!RUN_TRANSITIONS[from].includes(to))
        return { kind: 'illegal', from, to };
    return undefined;
}
export function stepTransitionProblem(from, to) {
    if (from === to)
        return { kind: 'same-status' };
    if (!STEP_TRANSITIONS[from].includes(to))
        return { kind: 'illegal', from, to };
    return undefined;
}
// ---------------------------------------------------------------------------
// Step ordering
// ---------------------------------------------------------------------------
export function orderedSteps(steps) {
    return [...steps].sort((a, b) => a.order - b.order);
}
/** The first step that is not settled, i.e. where execution continues. */
export function firstPendingStep(steps) {
    return orderedSteps(steps).find((step) => step.status === 'pending' || step.status === 'running');
}
/**
 * Problems that prevent `stepId` from being started now.
 *
 * A step may start only when every earlier step is settled (completed or
 * skipped). The check reads the step rows themselves rather than a cached
 * cursor, so a stale cache cannot reorder work.
 */
export function startBlockers(steps, stepId) {
    const target = steps.find((step) => step.stepId === stepId);
    if (target === undefined)
        return [];
    return orderedSteps(steps).filter((step) => step.order < target.order
        && step.status !== 'completed' && step.status !== 'skipped');
}
/** `{done, total}` over required steps; failed and skipped never count as done. */
export function requiredProgress(steps) {
    const required = steps.filter((step) => step.required);
    const done = required.filter((step) => step.status === 'completed').length;
    const total = required.length;
    const percent = total === 0 ? 100 : Math.floor((done / total) * 100);
    return { done, total, percent };
}
/** Required steps that still prevent a run from being reported as succeeded. */
export function unsettledRequiredSteps(steps) {
    return orderedSteps(steps).filter((step) => step.required && step.status === 'completed' ? false : step.required && step.status !== 'skipped');
}
export function failedSteps(steps) {
    return orderedSteps(steps).filter((step) => step.status === 'failed');
}
const MINUTE_MS = 60_000;
export function runHealth(run, now, limits) {
    const reasons = [];
    if (isTerminalRun(run.status)) {
        if (run.status === 'interrupted')
            reasons.push('执行被中断，旧的执行实例已失效。');
        if (run.status === 'failed')
            reasons.push('执行失败，可人工恢复。');
        return {
            health: run.status === 'interrupted' ? 'interrupted' : 'finished',
            reasons,
            resumable: RESUMABLE_RUN_STATUSES.includes(run.status),
            needsConfirmation: run.needsUserConfirmation === true,
        };
    }
    if (run.status === 'blocked') {
        return {
            health: 'blocked',
            reasons: ['执行被阻塞，等待补充输入或权限。'],
            resumable: true,
            needsConfirmation: false,
        };
    }
    const ageMinutes = (now.getTime() - Date.parse(run.startedAt)) / MINUTE_MS;
    if (Number.isFinite(ageMinutes) && ageMinutes > limits.timeoutMinutes) {
        reasons.push(`已运行 ${Math.round(ageMinutes)} 分钟，超过配置的运行上限 ${limits.timeoutMinutes} 分钟。`);
        return { health: 'timeout', reasons, resumable: false, needsConfirmation: false };
    }
    const lastSignal = run.lastHeartbeatAt ?? run.staleDetectedAt;
    if (lastSignal !== undefined) {
        const silentMinutes = (now.getTime() - Date.parse(lastSignal)) / MINUTE_MS;
        if (Number.isFinite(silentMinutes) && silentMinutes > limits.staleMinutes) {
            reasons.push(`已 ${Math.round(silentMinutes)} 分钟没有心跳，疑似失联（待核验）。`);
            return { health: 'suspected_stale', reasons, resumable: false, needsConfirmation: true };
        }
    }
    if (run.leaseExpiresAt !== undefined) {
        const leaseLeft = Date.parse(run.leaseExpiresAt) - now.getTime();
        if (Number.isFinite(leaseLeft) && leaseLeft < 0) {
            reasons.push('执行租约已过期，需要人工确认后才能恢复。');
            return { health: 'suspected_stale', reasons, resumable: false, needsConfirmation: true };
        }
    }
    if (run.needsUserConfirmation === true) {
        return { health: 'awaiting_confirmation', reasons, resumable: true, needsConfirmation: true };
    }
    return { health: 'normal', reasons, resumable: false, needsConfirmation: false };
}
export const HEALTH_LABELS = {
    normal: '运行中',
    timeout: '已超时',
    suspected_stale: '疑似失联',
    interrupted: '已中断',
    awaiting_confirmation: '等待确认',
    blocked: '已阻塞',
    finished: '已结束',
};
