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
export const TASK_ERROR_CODES = [
    'TASK_NOT_FOUND',
    'TASK_ALREADY_RUNNING',
    'TASK_REVISION_CONFLICT',
    'TASK_INVALID_STEPS',
    'TASK_RUN_NOT_FOUND',
    'TASK_RUN_ALREADY_FINISHED',
    'TASK_STEP_ORDER_INVALID',
    'TASK_PERMISSION_DENIED',
    'TASK_SCHEDULE_UNAVAILABLE',
    'TASK_SCHEDULE_FAILED',
    'TASK_STORAGE_ERROR',
    'TASK_RUN_INTERRUPTED',
    'TASK_MAX_CONCURRENCY',
    'TASK_INVALID_ARGUMENTS',
    'TASK_INTERNAL_ERROR',
];
/** Codes callers may safely retry with the same arguments. */
const RETRYABLE = new Set([
    'TASK_ALREADY_RUNNING',
    'TASK_REVISION_CONFLICT',
    'TASK_MAX_CONCURRENCY',
    'TASK_SCHEDULE_FAILED',
    'TASK_STORAGE_ERROR',
]);
export class TaskEngineError extends Error {
    code;
    retryable;
    relatedRunId;
    details;
    constructor(code, message, options = {}) {
        super(sanitizeMessage(message));
        this.name = 'TaskEngineError';
        this.code = code;
        this.retryable = options.retryable ?? RETRYABLE.has(code);
        if (options.relatedRunId !== undefined)
            this.relatedRunId = options.relatedRunId;
        if (options.details !== undefined)
            this.details = options.details;
    }
}
/**
 * Remove host paths, stack frames and credentials from any message that may
 * reach the model (PRD 10.3 / 12.3: errors must not leak paths, stacks or
 * other Sessions' data).
 */
export function sanitizeMessage(input, maxLength = 800) {
    let text = String(input ?? '');
    // Drop stack frames entirely.
    text = text
        .split('\n')
        .filter((line) => !/^\s+at\s/.test(line))
        .join(' ');
    // Redact credential-looking assignments.
    text = text.replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|authorization|bearer)\b(\s*[:=]\s*|\s+)(\S+)/gi, (_m, key) => `${key}: [redacted]`);
    // Redact absolute POSIX paths (home dirs, app bundles, node_modules).
    text = text.replace(/\/(?:Users|home|Applications|private|var|opt|usr|tmp)\/[^\s"'`)]*/g, '<path>');
    text = text.replace(/\b[A-Za-z]:\\[^\s"'`)]*/g, '<path>');
    text = text.replace(/\s+/g, ' ').trim();
    if (text.length > maxLength)
        text = `${text.slice(0, maxLength)}…`;
    return text;
}
/** Normalise any thrown value into the plugin's uniform error payload. */
export function toErrorPayload(error) {
    if (error instanceof TaskEngineError) {
        const payload = {
            code: error.code,
            message: error.message,
            retryable: error.retryable,
        };
        if (error.relatedRunId !== undefined)
            payload.relatedRunId = error.relatedRunId;
        return payload;
    }
    const message = error instanceof Error ? error.message : String(error);
    const isMissingKey = /missing-key/.test(message);
    if (isMissingKey) {
        return { code: 'TASK_NOT_FOUND', message: '记录不存在或已被清理', retryable: false };
    }
    return {
        code: 'TASK_INTERNAL_ERROR',
        message: sanitizeMessage(message || '未知错误'),
        retryable: false,
    };
}
export function invalidArguments(message) {
    return new TaskEngineError('TASK_INVALID_ARGUMENTS', message);
}
