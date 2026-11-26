/**
 * Stable error codes, error payloads and message sanitisation.
 *
 * The 13 codes below are the PRD (chapter 6.5) contract. Two additional codes
 * cover cases the PRD table does not name but that must never be reported as a
 * misleading PRD code:
 *   - TASK_INVALID_ARGUMENTS: a tool argument failed schema/limit validation.
 *   - TASK_INTERNAL_ERROR:    an unexpected runtime failure (bug / IO).
 * They are documented in README.md and docs/API-COMPATIBILITY-AUDIT.md.
 */
export type TaskErrorCode = 'TASK_NOT_FOUND' | 'TASK_ALREADY_RUNNING' | 'TASK_REVISION_CONFLICT' | 'TASK_INVALID_STEPS' | 'TASK_RUN_NOT_FOUND' | 'TASK_RUN_ALREADY_FINISHED' | 'TASK_STEP_ORDER_INVALID' | 'TASK_PERMISSION_DENIED' | 'TASK_SCHEDULE_UNAVAILABLE' | 'TASK_SCHEDULE_FAILED' | 'TASK_STORAGE_ERROR' | 'TASK_RUN_INTERRUPTED' | 'TASK_MAX_CONCURRENCY' | 'TASK_INVALID_ARGUMENTS' | 'TASK_INTERNAL_ERROR';
export declare const TASK_ERROR_CODES: readonly TaskErrorCode[];
export interface TaskErrorPayload {
    code: TaskErrorCode;
    message: string;
    retryable: boolean;
    relatedRunId?: string;
}
export declare class TaskEngineError extends Error {
    readonly code: TaskErrorCode;
    readonly retryable: boolean;
    readonly relatedRunId?: string;
    readonly details?: Record<string, unknown>;
    constructor(code: TaskErrorCode, message: string, options?: {
        retryable?: boolean;
        relatedRunId?: string;
        details?: Record<string, unknown>;
    });
}
/**
 * Remove host paths, stack frames and credentials from any message that may
 * reach the model (PRD 10.3 / 12.3: errors must not leak paths, stacks or
 * other Sessions' data).
 */
export declare function sanitizeMessage(input: string, maxLength?: number): string;
/** Normalise any thrown value into the plugin's uniform error payload. */
export declare function toErrorPayload(error: unknown): TaskErrorPayload;
export declare function invalidArguments(message: string): TaskEngineError;
