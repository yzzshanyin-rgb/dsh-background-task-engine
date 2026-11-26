/**
 * Status machines and the derived health of a run.
 *
 * Nothing here touches storage: these are pure predicates so the same rules can
 * be applied inside a `table.update` mutator (where the read and the write are
 * one atomic step) and in plain validation before a write.
 */
import type { RunStatus, StepStatus, TaskStatus } from './records.js';
import type { RunStepRecord } from './records.js';
export declare const ACTIVE_RUN_STATUSES: readonly RunStatus[];
export declare const TERMINAL_RUN_STATUSES: readonly RunStatus[];
export declare const RESUMABLE_RUN_STATUSES: readonly RunStatus[];
/** Statuses that hold a concurrency slot. */
export declare const OCCUPYING_RUN_STATUSES: readonly RunStatus[];
export declare function isRunStatus(value: unknown): value is RunStatus;
export declare function isStepStatus(value: unknown): value is StepStatus;
export declare function isTaskStatus(value: unknown): value is TaskStatus;
export declare function isTerminalRun(status: RunStatus): boolean;
export declare function isActiveRun(status: RunStatus): boolean;
/** A run that still occupies a concurrency slot. */
export declare function occupiesSlot(status: RunStatus): boolean;
export type TransitionProblem = {
    kind: 'already-finished';
} | {
    kind: 'same-status';
} | {
    kind: 'illegal';
    from: RunStatus | StepStatus;
    to: RunStatus | StepStatus;
};
export declare function runTransitionProblem(from: RunStatus, to: RunStatus): TransitionProblem | undefined;
export declare function stepTransitionProblem(from: StepStatus, to: StepStatus): TransitionProblem | undefined;
export declare function orderedSteps(steps: RunStepRecord[]): RunStepRecord[];
/** The first step that is not settled, i.e. where execution continues. */
export declare function firstPendingStep(steps: RunStepRecord[]): RunStepRecord | undefined;
/**
 * Problems that prevent `stepId` from being started now.
 *
 * A step may start only when every earlier step is settled (completed or
 * skipped). The check reads the step rows themselves rather than a cached
 * cursor, so a stale cache cannot reorder work.
 */
export declare function startBlockers(steps: RunStepRecord[], stepId: string): RunStepRecord[];
/** `{done, total}` over required steps; failed and skipped never count as done. */
export declare function requiredProgress(steps: RunStepRecord[]): {
    done: number;
    total: number;
    percent: number;
};
/** Required steps that still prevent a run from being reported as succeeded. */
export declare function unsettledRequiredSteps(steps: RunStepRecord[]): RunStepRecord[];
export declare function failedSteps(steps: RunStepRecord[]): RunStepRecord[];
/**
 * How a run looks to a human right now.
 *
 * A run's stored status is not enough: a `running` run whose executor died and
 * a `running` run that is simply slow look identical in storage. These states
 * are derived on read and never persisted as the run's status, because "the
 * heartbeat stopped" is not the same fact as "the work stopped".
 */
export type RunHealth = 'normal' | 'timeout' | 'suspected_stale' | 'interrupted' | 'awaiting_confirmation' | 'blocked' | 'finished';
export interface RunHealthInput {
    status: RunStatus;
    startedAt: string;
    lastHeartbeatAt?: string;
    leaseExpiresAt?: string;
    staleDetectedAt?: string;
    needsUserConfirmation?: boolean;
}
export interface RunHealthResult {
    health: RunHealth;
    /** Human-readable reasons, newest first. Safe to show: no paths, no stack. */
    reasons: string[];
    /** True when the run may be resumed right now (subject to confirmation). */
    resumable: boolean;
    /** True when resuming would repeat work that may already have taken effect. */
    needsConfirmation: boolean;
}
export declare function runHealth(run: RunHealthInput, now: Date, limits: {
    timeoutMinutes: number;
    staleMinutes: number;
}): RunHealthResult;
export declare const HEALTH_LABELS: Record<RunHealth, string>;
