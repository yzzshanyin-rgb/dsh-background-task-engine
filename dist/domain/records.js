/**
 * Persisted record shapes.
 *
 * Every record is parsed on write and re-parsed by the storage domain on load,
 * so the zod schema here is the single source of truth for what may be stored.
 * Fields added after 1.1.1 are optional with described defaults: a record
 * written by an older version must load unchanged, and must never be
 * reinterpreted as stale, interrupted, or failed just because the new fields
 * are absent.
 */
import { z } from 'zod';
/** Bumped when the stored shape changes; migrations bring older rows forward. */
export const SCHEMA_VERSION = 2;
/**
 * Storage unit name. The host's backend accepts `^[a-z][a-z0-9_]*$` only,
 * which rules out the hyphenated package name.
 */
export const DOMAIN_NAME = 'dsh_background_task_engine';
export const TASK_STATUSES = ['active', 'paused', 'archived'];
export const RUN_STATUSES = [
    'queued',
    'running',
    'blocked',
    'succeeded',
    'failed',
    'interrupted',
    'skipped',
];
export const STEP_STATUSES = ['pending', 'running', 'completed', 'failed', 'skipped'];
export const TRIGGER_TYPES = ['manual', 'schedule'];
/**
 * How a step may be retried after a failure.
 *
 * The plugin never decides this from the instruction text: `manual_only` is the
 * conservative default for steps that touch the outside world, and only the
 * author of the task may lower it.
 */
export const RETRY_POLICIES = ['safe_retry', 'verify_before_retry', 'manual_only'];
/** Coarse cause of a failure, surfaced to the agent and the UI. */
export const FAILURE_CATEGORIES = [
    'agent_error',
    'tool_error',
    'timeout',
    'permission',
    'missing_input',
    'external_side_effect',
    'unknown',
];
/** What a schedule operation asked for, recorded before the host is touched. */
export const SCHEDULE_ACTIONS = ['create', 'update', 'pause', 'resume', 'delete'];
/**
 * Journal state of one schedule mutation.
 *
 * `pending` exists before the host call, so a crash in between is visible on
 * the next boot instead of silently half-applied. `reconciling` means the
 * startup pass could not settle it without guessing.
 */
export const SCHEDULE_OP_STATUSES = ['pending', 'processing', 'succeeded', 'failed', 'reconciling'];
export const idSchema = z.string().min(4).max(64);
export const timestampSchema = z.string().min(20).max(40);
export const stepErrorSchema = z.object({
    code: z.string().min(1).max(64),
    message: z.string().min(1).max(2000),
});
export const stepDefinitionSchema = z.object({
    stepId: idSchema,
    title: z.string().min(1).max(120),
    instruction: z.string().min(1).max(8000),
    completionCriteria: z.string().max(4000).optional(),
    order: z.number().int().min(1).max(10),
    required: z.boolean(),
    /** Absent on rows written before 1.2.0 — read as {@link DEFAULT_RETRY_POLICY}. */
    retryPolicy: z.enum(RETRY_POLICIES).optional(),
});
export const DEFAULT_RETRY_POLICY = 'verify_before_retry';
export const scheduleRefSchema = z.object({
    scheduleId: z.string().min(1).max(128),
    timingKind: z.string().min(1).max(32),
    timing: z.record(z.unknown()),
    state: z.enum(['active', 'paused', 'unlinked']),
    title: z.string().max(120),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    lastError: z.string().max(2000).optional(),
    /** Wall clock the next occurrence is expected at, when the host reports one. */
    nextRunAt: timestampSchema.optional(),
    /** IANA zone the timing was authored in; the host keeps it per timing kind. */
    timeZone: z.string().max(64).optional(),
});
export const taskRecordSchema = z.object({
    taskId: idSchema,
    title: z.string().min(2).max(80),
    description: z.string().max(2000).optional(),
    status: z.enum(TASK_STATUSES),
    revision: z.number().int().min(1),
    ownerSessionId: z.string().min(1).max(128),
    steps: z.array(stepDefinitionSchema).min(1).max(10),
    scheduleRef: scheduleRefSchema.optional(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    schemaVersion: z.number().int().min(0),
});
export const templateSnapshotSchema = z.object({
    revision: z.number().int().min(1),
    title: z.string().min(2).max(80),
    steps: z.array(stepDefinitionSchema).min(1).max(10),
});
/** The user's confirmation that re-running a run may repeat external effects. */
export const recoveryConfirmationSchema = z.object({
    sourceRunId: idSchema,
    failedStepIds: z.array(z.string().min(1).max(64)).max(10),
    confirmedAt: timestampSchema,
    confirmationNote: z.string().max(2000).optional(),
});
export const runRecordSchema = z.object({
    runId: idSchema,
    taskId: idSchema,
    taskRevision: z.number().int().min(1),
    taskOwnerSessionId: z.string().min(1).max(128),
    sessionId: z.string().min(1).max(128),
    status: z.enum(RUN_STATUSES),
    triggerType: z.enum(TRIGGER_TYPES),
    scheduleId: z.string().max(128).optional(),
    occurrenceKey: z.string().max(256).optional(),
    idempotencyKey: z.string().max(300).optional(),
    currentStepId: z.string().max(64).optional(),
    progress: z.number().int().min(0).max(100),
    requiredTotal: z.number().int().min(0),
    requiredCompleted: z.number().int().min(0),
    totalSteps: z.number().int().min(1).max(10),
    startedAt: timestampSchema,
    updatedAt: timestampSchema,
    finishedAt: timestampSchema.optional(),
    summary: z.string().max(20000).optional(),
    error: stepErrorSchema.optional(),
    resumesRunId: idSchema.optional(),
    templateSnapshot: templateSnapshotSchema,
    schemaVersion: z.number().int().min(0),
    // ---- 1.2.0 liveness. Absent on older rows, and absence means "unknown",
    // never "expired": a run written by 1.1.1 must not be marked interrupted
    // merely because it has no heartbeat.
    /** Last heartbeat or step report accepted for this run. */
    lastHeartbeatAt: timestampSchema.optional(),
    /** Wall clock after which the run's execution credential is assumed dead. */
    leaseExpiresAt: timestampSchema.optional(),
    /** Credential handed to the agent that owns this execution. */
    executionToken: z.string().max(128).optional(),
    /** Increments when the same logical work is re-adopted by a new execution. */
    executionGeneration: z.number().int().min(1).optional(),
    /** First time the engine suspected the run had lost its executor. */
    staleDetectedAt: timestampSchema.optional(),
    /** Coarse cause, populated on failure/interruption. */
    failureCategory: z.enum(FAILURE_CATEGORIES).optional(),
    /** True when resuming would repeat work that may already have taken effect. */
    needsUserConfirmation: z.boolean().optional(),
    /** The confirmation this run was started with, if any. */
    recoveryConfirmation: recoveryConfirmationSchema.optional(),
});
export const runStepRecordSchema = z.object({
    runId: idSchema,
    stepId: idSchema,
    taskId: idSchema,
    order: z.number().int().min(1).max(10),
    title: z.string().min(1).max(120),
    required: z.boolean(),
    status: z.enum(STEP_STATUSES),
    attempt: z.number().int().min(0).max(100),
    startedAt: timestampSchema.optional(),
    finishedAt: timestampSchema.optional(),
    summary: z.string().max(4000).optional(),
    error: stepErrorSchema.optional(),
    carryOverFromRunId: idSchema.optional(),
    updatedAt: timestampSchema,
    /** 1.2.0: why this step failed, and how it may be retried. */
    failureCategory: z.enum(FAILURE_CATEGORIES).optional(),
    retryPolicy: z.enum(RETRY_POLICIES).optional(),
    lastHeartbeatAt: timestampSchema.optional(),
});
/**
 * Idempotency reservation.
 *
 * Written before the run row so two concurrent triggers with the same key
 * cannot both create a run, and removed when the creation fails so a retry is
 * possible. `state: 'committed'` means the run exists.
 */
export const idempotencyRecordSchema = z.object({
    taskId: idSchema,
    idempotencyKey: z.string().min(1).max(300),
    ownerSessionId: z.string().min(1).max(128),
    state: z.enum(['reserved', 'committed']),
    runId: idSchema.optional(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
});
/**
 * Concurrency accounting: one row per non-terminal run.
 *
 * Counting the index is O(active runs); scanning every run to count them is
 * not, and the PRD's 50k-run dataset makes the difference observable. The
 * index is rebuilt from persisted runs on boot, so a crash cannot leak a slot.
 */
export const activeRunRecordSchema = z.object({
    runId: idSchema,
    taskId: idSchema,
    ownerSessionId: z.string().min(1).max(128),
    sessionId: z.string().min(1).max(128),
    startedAt: timestampSchema,
    leaseExpiresAt: timestampSchema.optional(),
});
/**
 * Per-task run index, ordered by creation time then run id.
 *
 * This is what makes history pagination a range read instead of a scan of every
 * run in the domain, and what keeps the cursor stable when two runs share a
 * millisecond.
 */
export const runIndexRecordSchema = z.object({
    runId: idSchema,
    taskId: idSchema,
    ownerSessionId: z.string().min(1).max(128),
    status: z.enum(RUN_STATUSES),
    startedAt: timestampSchema,
});
/** One journal row per schedule mutation, so a half-applied change is visible. */
export const scheduleOpRecordSchema = z.object({
    operationId: idSchema,
    taskId: idSchema,
    ownerSessionId: z.string().min(1).max(128),
    scheduleId: z.string().max(128).optional(),
    action: z.enum(SCHEDULE_ACTIONS),
    status: z.enum(SCHEDULE_OP_STATUSES),
    /** Timing the operation was asked to install, replayed by reconciliation. */
    timing: z.record(z.unknown()).optional(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    lastError: z.string().max(2000).optional(),
    /** Set when reconciliation settled the row, for the audit trail. */
    reconciledAt: timestampSchema.optional(),
});
export const globalStateSchema = z.object({
    schemaVersion: z.number().int().min(0),
    appliedMigrations: z.record(z.string()),
    lastRecoveryScanAt: timestampSchema.optional(),
    lastPruneAt: timestampSchema.optional(),
    /** Last time the schedule journal was reconciled. */
    lastScheduleReconcileAt: timestampSchema.optional(),
});
export const TABLES = {
    tasks: 'tasks',
    runs: 'task_runs',
    steps: 'task_run_steps',
    idempotency: 'idempotency',
    activeRuns: 'active_runs',
    runIndex: 'run_index',
    scheduleOps: 'schedule_ops',
    meta: 'meta',
};
/** `${runId}/${stepId}` — the composite key of the step table. */
export function stepKey(runId, stepId) {
    return `${runId}/${stepId}`;
}
/** `${taskId}/${startedAt}/${runId}` — sortable per-task run index key. */
export function runIndexKey(taskId, startedAt, runId) {
    return `${taskId}/${startedAt}/${runId}`;
}
/** `${taskId}/${idempotencyKey}` — one reservation per key per task. */
export function idempotencyKeyOf(taskId, idempotencyKey) {
    return `${taskId}/${idempotencyKey}`;
}
