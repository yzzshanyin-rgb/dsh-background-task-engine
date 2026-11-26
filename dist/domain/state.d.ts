/**
 * Task/Run/Step state machines (PRD 4.7, 7.3).
 *
 * Every transition goes through `assertRunTransition` / `assertStepTransition`
 * so an illegal change (e.g. failed -> running, or re-finishing a finished run)
 * is rejected no matter which tool triggered it.
 */
import type { RunStatus, StepStatus, TaskStatus } from './records.js';
/** Runs that still occupy a concurrency slot. */
export declare const ACTIVE_RUN_STATUSES: readonly RunStatus[];
/** Runs that can no longer receive progress reports. */
export declare const TERMINAL_RUN_STATUSES: readonly RunStatus[];
/** Runs a resume may start from. `blocked` is recoverable, not finished. */
export declare const RESUMABLE_RUN_STATUSES: readonly RunStatus[];
export declare function isRunStatus(value: unknown): value is RunStatus;
export declare function isStepStatus(value: unknown): value is StepStatus;
export declare function isTaskStatus(value: unknown): value is TaskStatus;
export declare function isTerminalRun(status: RunStatus): boolean;
export declare function isActiveRun(status: RunStatus): boolean;
export declare function canTransitionRun(from: RunStatus, to: RunStatus): boolean;
export declare function assertRunTransition(from: RunStatus, to: RunStatus, context: string): void;
export declare function assertStepTransition(from: StepStatus, to: StepStatus, stepId: string): void;
/**
 * Progress is derived from persisted step records only (PRD 11.4), counting
 * required steps that are completed. Skipped/failed required steps never
 * contribute, so a run cannot look "nearly done" while blocking.
 */
export declare function computeProgress(steps: ReadonlyArray<{
    required: boolean;
    status: StepStatus;
}>): {
    progress: number;
    requiredTotal: number;
    requiredCompleted: number;
};
/** First step, in order, that still needs work. */
export declare function firstPendingStep(steps: ReadonlyArray<{
    stepId: string;
    order: number;
    status: StepStatus;
}>): string | undefined;
/** All required steps completed => the run may be reported as succeeded. */
export declare function requiredStepsSettled(steps: ReadonlyArray<{
    required: boolean;
    status: StepStatus;
    stepId: string;
    order: number;
}>): {
    ok: boolean;
    blockers: string[];
};
/**
 * Linear execution guard (PRD 9.1 step 3): a step may only start when every
 * earlier required step is completed or skipped.
 */
export declare function assertLinearStart(steps: ReadonlyArray<{
    stepId: string;
    order: number;
    required: boolean;
    status: StepStatus;
}>, stepId: string): void;
