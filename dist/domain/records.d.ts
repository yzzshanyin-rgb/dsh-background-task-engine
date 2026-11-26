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
export declare const SCHEMA_VERSION = 2;
/**
 * Storage unit name. The host's backend accepts `^[a-z][a-z0-9_]*$` only,
 * which rules out the hyphenated package name.
 */
export declare const DOMAIN_NAME = "dsh_background_task_engine";
export declare const TASK_STATUSES: readonly ["active", "paused", "archived"];
export type TaskStatus = (typeof TASK_STATUSES)[number];
export declare const RUN_STATUSES: readonly ["queued", "running", "blocked", "succeeded", "failed", "interrupted", "skipped"];
export type RunStatus = (typeof RUN_STATUSES)[number];
export declare const STEP_STATUSES: readonly ["pending", "running", "completed", "failed", "skipped"];
export type StepStatus = (typeof STEP_STATUSES)[number];
export declare const TRIGGER_TYPES: readonly ["manual", "schedule"];
export type TriggerType = (typeof TRIGGER_TYPES)[number];
/**
 * How a step may be retried after a failure.
 *
 * The plugin never decides this from the instruction text: `manual_only` is the
 * conservative default for steps that touch the outside world, and only the
 * author of the task may lower it.
 */
export declare const RETRY_POLICIES: readonly ["safe_retry", "verify_before_retry", "manual_only"];
export type RetryPolicy = (typeof RETRY_POLICIES)[number];
/** Coarse cause of a failure, surfaced to the agent and the UI. */
export declare const FAILURE_CATEGORIES: readonly ["agent_error", "tool_error", "timeout", "permission", "missing_input", "external_side_effect", "unknown"];
export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];
/** What a schedule operation asked for, recorded before the host is touched. */
export declare const SCHEDULE_ACTIONS: readonly ["create", "update", "pause", "resume", "delete"];
export type ScheduleAction = (typeof SCHEDULE_ACTIONS)[number];
/**
 * Journal state of one schedule mutation.
 *
 * `pending` exists before the host call, so a crash in between is visible on
 * the next boot instead of silently half-applied. `reconciling` means the
 * startup pass could not settle it without guessing.
 */
export declare const SCHEDULE_OP_STATUSES: readonly ["pending", "processing", "succeeded", "failed", "reconciling"];
export type ScheduleOpStatus = (typeof SCHEDULE_OP_STATUSES)[number];
export declare const idSchema: z.ZodString;
export declare const timestampSchema: z.ZodString;
export declare const stepErrorSchema: z.ZodObject<{
    code: z.ZodString;
    message: z.ZodString;
}, "strip", z.ZodTypeAny, {
    code: string;
    message: string;
}, {
    code: string;
    message: string;
}>;
export type StepError = z.infer<typeof stepErrorSchema>;
export declare const stepDefinitionSchema: z.ZodObject<{
    stepId: z.ZodString;
    title: z.ZodString;
    instruction: z.ZodString;
    completionCriteria: z.ZodOptional<z.ZodString>;
    order: z.ZodNumber;
    required: z.ZodBoolean;
    /** Absent on rows written before 1.2.0 — read as {@link DEFAULT_RETRY_POLICY}. */
    retryPolicy: z.ZodOptional<z.ZodEnum<["safe_retry", "verify_before_retry", "manual_only"]>>;
}, "strip", z.ZodTypeAny, {
    title: string;
    stepId: string;
    instruction: string;
    order: number;
    required: boolean;
    completionCriteria?: string | undefined;
    retryPolicy?: "safe_retry" | "verify_before_retry" | "manual_only" | undefined;
}, {
    title: string;
    stepId: string;
    instruction: string;
    order: number;
    required: boolean;
    completionCriteria?: string | undefined;
    retryPolicy?: "safe_retry" | "verify_before_retry" | "manual_only" | undefined;
}>;
export type StepDefinition = z.infer<typeof stepDefinitionSchema>;
export declare const DEFAULT_RETRY_POLICY: RetryPolicy;
export declare const scheduleRefSchema: z.ZodObject<{
    scheduleId: z.ZodString;
    timingKind: z.ZodString;
    timing: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    state: z.ZodEnum<["active", "paused", "unlinked"]>;
    title: z.ZodString;
    createdAt: z.ZodString;
    updatedAt: z.ZodString;
    lastError: z.ZodOptional<z.ZodString>;
    /** Wall clock the next occurrence is expected at, when the host reports one. */
    nextRunAt: z.ZodOptional<z.ZodString>;
    /** IANA zone the timing was authored in; the host keeps it per timing kind. */
    timeZone: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    title: string;
    createdAt: string;
    updatedAt: string;
    scheduleId: string;
    timingKind: string;
    timing: Record<string, unknown>;
    state: "active" | "paused" | "unlinked";
    lastError?: string | undefined;
    nextRunAt?: string | undefined;
    timeZone?: string | undefined;
}, {
    title: string;
    createdAt: string;
    updatedAt: string;
    scheduleId: string;
    timingKind: string;
    timing: Record<string, unknown>;
    state: "active" | "paused" | "unlinked";
    lastError?: string | undefined;
    nextRunAt?: string | undefined;
    timeZone?: string | undefined;
}>;
export type ScheduleRef = z.infer<typeof scheduleRefSchema>;
export declare const taskRecordSchema: z.ZodObject<{
    taskId: z.ZodString;
    title: z.ZodString;
    description: z.ZodOptional<z.ZodString>;
    status: z.ZodEnum<["active", "paused", "archived"]>;
    revision: z.ZodNumber;
    ownerSessionId: z.ZodString;
    steps: z.ZodArray<z.ZodObject<{
        stepId: z.ZodString;
        title: z.ZodString;
        instruction: z.ZodString;
        completionCriteria: z.ZodOptional<z.ZodString>;
        order: z.ZodNumber;
        required: z.ZodBoolean;
        /** Absent on rows written before 1.2.0 — read as {@link DEFAULT_RETRY_POLICY}. */
        retryPolicy: z.ZodOptional<z.ZodEnum<["safe_retry", "verify_before_retry", "manual_only"]>>;
    }, "strip", z.ZodTypeAny, {
        title: string;
        stepId: string;
        instruction: string;
        order: number;
        required: boolean;
        completionCriteria?: string | undefined;
        retryPolicy?: "safe_retry" | "verify_before_retry" | "manual_only" | undefined;
    }, {
        title: string;
        stepId: string;
        instruction: string;
        order: number;
        required: boolean;
        completionCriteria?: string | undefined;
        retryPolicy?: "safe_retry" | "verify_before_retry" | "manual_only" | undefined;
    }>, "many">;
    scheduleRef: z.ZodOptional<z.ZodObject<{
        scheduleId: z.ZodString;
        timingKind: z.ZodString;
        timing: z.ZodRecord<z.ZodString, z.ZodUnknown>;
        state: z.ZodEnum<["active", "paused", "unlinked"]>;
        title: z.ZodString;
        createdAt: z.ZodString;
        updatedAt: z.ZodString;
        lastError: z.ZodOptional<z.ZodString>;
        /** Wall clock the next occurrence is expected at, when the host reports one. */
        nextRunAt: z.ZodOptional<z.ZodString>;
        /** IANA zone the timing was authored in; the host keeps it per timing kind. */
        timeZone: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        title: string;
        createdAt: string;
        updatedAt: string;
        scheduleId: string;
        timingKind: string;
        timing: Record<string, unknown>;
        state: "active" | "paused" | "unlinked";
        lastError?: string | undefined;
        nextRunAt?: string | undefined;
        timeZone?: string | undefined;
    }, {
        title: string;
        createdAt: string;
        updatedAt: string;
        scheduleId: string;
        timingKind: string;
        timing: Record<string, unknown>;
        state: "active" | "paused" | "unlinked";
        lastError?: string | undefined;
        nextRunAt?: string | undefined;
        timeZone?: string | undefined;
    }>>;
    createdAt: z.ZodString;
    updatedAt: z.ZodString;
    schemaVersion: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    title: string;
    status: "active" | "paused" | "archived";
    createdAt: string;
    updatedAt: string;
    taskId: string;
    revision: number;
    ownerSessionId: string;
    steps: {
        title: string;
        stepId: string;
        instruction: string;
        order: number;
        required: boolean;
        completionCriteria?: string | undefined;
        retryPolicy?: "safe_retry" | "verify_before_retry" | "manual_only" | undefined;
    }[];
    schemaVersion: number;
    description?: string | undefined;
    scheduleRef?: {
        title: string;
        createdAt: string;
        updatedAt: string;
        scheduleId: string;
        timingKind: string;
        timing: Record<string, unknown>;
        state: "active" | "paused" | "unlinked";
        lastError?: string | undefined;
        nextRunAt?: string | undefined;
        timeZone?: string | undefined;
    } | undefined;
}, {
    title: string;
    status: "active" | "paused" | "archived";
    createdAt: string;
    updatedAt: string;
    taskId: string;
    revision: number;
    ownerSessionId: string;
    steps: {
        title: string;
        stepId: string;
        instruction: string;
        order: number;
        required: boolean;
        completionCriteria?: string | undefined;
        retryPolicy?: "safe_retry" | "verify_before_retry" | "manual_only" | undefined;
    }[];
    schemaVersion: number;
    description?: string | undefined;
    scheduleRef?: {
        title: string;
        createdAt: string;
        updatedAt: string;
        scheduleId: string;
        timingKind: string;
        timing: Record<string, unknown>;
        state: "active" | "paused" | "unlinked";
        lastError?: string | undefined;
        nextRunAt?: string | undefined;
        timeZone?: string | undefined;
    } | undefined;
}>;
export type TaskRecord = z.infer<typeof taskRecordSchema>;
export declare const templateSnapshotSchema: z.ZodObject<{
    revision: z.ZodNumber;
    title: z.ZodString;
    steps: z.ZodArray<z.ZodObject<{
        stepId: z.ZodString;
        title: z.ZodString;
        instruction: z.ZodString;
        completionCriteria: z.ZodOptional<z.ZodString>;
        order: z.ZodNumber;
        required: z.ZodBoolean;
        /** Absent on rows written before 1.2.0 — read as {@link DEFAULT_RETRY_POLICY}. */
        retryPolicy: z.ZodOptional<z.ZodEnum<["safe_retry", "verify_before_retry", "manual_only"]>>;
    }, "strip", z.ZodTypeAny, {
        title: string;
        stepId: string;
        instruction: string;
        order: number;
        required: boolean;
        completionCriteria?: string | undefined;
        retryPolicy?: "safe_retry" | "verify_before_retry" | "manual_only" | undefined;
    }, {
        title: string;
        stepId: string;
        instruction: string;
        order: number;
        required: boolean;
        completionCriteria?: string | undefined;
        retryPolicy?: "safe_retry" | "verify_before_retry" | "manual_only" | undefined;
    }>, "many">;
}, "strip", z.ZodTypeAny, {
    title: string;
    revision: number;
    steps: {
        title: string;
        stepId: string;
        instruction: string;
        order: number;
        required: boolean;
        completionCriteria?: string | undefined;
        retryPolicy?: "safe_retry" | "verify_before_retry" | "manual_only" | undefined;
    }[];
}, {
    title: string;
    revision: number;
    steps: {
        title: string;
        stepId: string;
        instruction: string;
        order: number;
        required: boolean;
        completionCriteria?: string | undefined;
        retryPolicy?: "safe_retry" | "verify_before_retry" | "manual_only" | undefined;
    }[];
}>;
export type TemplateSnapshot = z.infer<typeof templateSnapshotSchema>;
/** The user's confirmation that re-running a run may repeat external effects. */
export declare const recoveryConfirmationSchema: z.ZodObject<{
    sourceRunId: z.ZodString;
    failedStepIds: z.ZodArray<z.ZodString, "many">;
    confirmedAt: z.ZodString;
    confirmationNote: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    sourceRunId: string;
    failedStepIds: string[];
    confirmedAt: string;
    confirmationNote?: string | undefined;
}, {
    sourceRunId: string;
    failedStepIds: string[];
    confirmedAt: string;
    confirmationNote?: string | undefined;
}>;
export type RecoveryConfirmation = z.infer<typeof recoveryConfirmationSchema>;
export declare const runRecordSchema: z.ZodObject<{
    runId: z.ZodString;
    taskId: z.ZodString;
    taskRevision: z.ZodNumber;
    taskOwnerSessionId: z.ZodString;
    sessionId: z.ZodString;
    status: z.ZodEnum<["queued", "running", "blocked", "succeeded", "failed", "interrupted", "skipped"]>;
    triggerType: z.ZodEnum<["manual", "schedule"]>;
    scheduleId: z.ZodOptional<z.ZodString>;
    occurrenceKey: z.ZodOptional<z.ZodString>;
    idempotencyKey: z.ZodOptional<z.ZodString>;
    currentStepId: z.ZodOptional<z.ZodString>;
    progress: z.ZodNumber;
    requiredTotal: z.ZodNumber;
    requiredCompleted: z.ZodNumber;
    totalSteps: z.ZodNumber;
    startedAt: z.ZodString;
    updatedAt: z.ZodString;
    finishedAt: z.ZodOptional<z.ZodString>;
    summary: z.ZodOptional<z.ZodString>;
    error: z.ZodOptional<z.ZodObject<{
        code: z.ZodString;
        message: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        code: string;
        message: string;
    }, {
        code: string;
        message: string;
    }>>;
    resumesRunId: z.ZodOptional<z.ZodString>;
    templateSnapshot: z.ZodObject<{
        revision: z.ZodNumber;
        title: z.ZodString;
        steps: z.ZodArray<z.ZodObject<{
            stepId: z.ZodString;
            title: z.ZodString;
            instruction: z.ZodString;
            completionCriteria: z.ZodOptional<z.ZodString>;
            order: z.ZodNumber;
            required: z.ZodBoolean;
            /** Absent on rows written before 1.2.0 — read as {@link DEFAULT_RETRY_POLICY}. */
            retryPolicy: z.ZodOptional<z.ZodEnum<["safe_retry", "verify_before_retry", "manual_only"]>>;
        }, "strip", z.ZodTypeAny, {
            title: string;
            stepId: string;
            instruction: string;
            order: number;
            required: boolean;
            completionCriteria?: string | undefined;
            retryPolicy?: "safe_retry" | "verify_before_retry" | "manual_only" | undefined;
        }, {
            title: string;
            stepId: string;
            instruction: string;
            order: number;
            required: boolean;
            completionCriteria?: string | undefined;
            retryPolicy?: "safe_retry" | "verify_before_retry" | "manual_only" | undefined;
        }>, "many">;
    }, "strip", z.ZodTypeAny, {
        title: string;
        revision: number;
        steps: {
            title: string;
            stepId: string;
            instruction: string;
            order: number;
            required: boolean;
            completionCriteria?: string | undefined;
            retryPolicy?: "safe_retry" | "verify_before_retry" | "manual_only" | undefined;
        }[];
    }, {
        title: string;
        revision: number;
        steps: {
            title: string;
            stepId: string;
            instruction: string;
            order: number;
            required: boolean;
            completionCriteria?: string | undefined;
            retryPolicy?: "safe_retry" | "verify_before_retry" | "manual_only" | undefined;
        }[];
    }>;
    schemaVersion: z.ZodNumber;
    /** Last heartbeat or step report accepted for this run. */
    lastHeartbeatAt: z.ZodOptional<z.ZodString>;
    /** Wall clock after which the run's execution credential is assumed dead. */
    leaseExpiresAt: z.ZodOptional<z.ZodString>;
    /** Credential handed to the agent that owns this execution. */
    executionToken: z.ZodOptional<z.ZodString>;
    /** Increments when the same logical work is re-adopted by a new execution. */
    executionGeneration: z.ZodOptional<z.ZodNumber>;
    /** First time the engine suspected the run had lost its executor. */
    staleDetectedAt: z.ZodOptional<z.ZodString>;
    /** Coarse cause, populated on failure/interruption. */
    failureCategory: z.ZodOptional<z.ZodEnum<["agent_error", "tool_error", "timeout", "permission", "missing_input", "external_side_effect", "unknown"]>>;
    /** True when resuming would repeat work that may already have taken effect. */
    needsUserConfirmation: z.ZodOptional<z.ZodBoolean>;
    /** The confirmation this run was started with, if any. */
    recoveryConfirmation: z.ZodOptional<z.ZodObject<{
        sourceRunId: z.ZodString;
        failedStepIds: z.ZodArray<z.ZodString, "many">;
        confirmedAt: z.ZodString;
        confirmationNote: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        sourceRunId: string;
        failedStepIds: string[];
        confirmedAt: string;
        confirmationNote?: string | undefined;
    }, {
        sourceRunId: string;
        failedStepIds: string[];
        confirmedAt: string;
        confirmationNote?: string | undefined;
    }>>;
}, "strip", z.ZodTypeAny, {
    status: "queued" | "running" | "blocked" | "succeeded" | "failed" | "interrupted" | "skipped";
    updatedAt: string;
    taskId: string;
    schemaVersion: number;
    runId: string;
    taskRevision: number;
    taskOwnerSessionId: string;
    sessionId: string;
    triggerType: "manual" | "schedule";
    progress: number;
    requiredTotal: number;
    requiredCompleted: number;
    totalSteps: number;
    startedAt: string;
    templateSnapshot: {
        title: string;
        revision: number;
        steps: {
            title: string;
            stepId: string;
            instruction: string;
            order: number;
            required: boolean;
            completionCriteria?: string | undefined;
            retryPolicy?: "safe_retry" | "verify_before_retry" | "manual_only" | undefined;
        }[];
    };
    scheduleId?: string | undefined;
    occurrenceKey?: string | undefined;
    idempotencyKey?: string | undefined;
    currentStepId?: string | undefined;
    finishedAt?: string | undefined;
    summary?: string | undefined;
    error?: {
        code: string;
        message: string;
    } | undefined;
    resumesRunId?: string | undefined;
    lastHeartbeatAt?: string | undefined;
    leaseExpiresAt?: string | undefined;
    executionToken?: string | undefined;
    executionGeneration?: number | undefined;
    staleDetectedAt?: string | undefined;
    failureCategory?: "agent_error" | "tool_error" | "timeout" | "permission" | "missing_input" | "external_side_effect" | "unknown" | undefined;
    needsUserConfirmation?: boolean | undefined;
    recoveryConfirmation?: {
        sourceRunId: string;
        failedStepIds: string[];
        confirmedAt: string;
        confirmationNote?: string | undefined;
    } | undefined;
}, {
    status: "queued" | "running" | "blocked" | "succeeded" | "failed" | "interrupted" | "skipped";
    updatedAt: string;
    taskId: string;
    schemaVersion: number;
    runId: string;
    taskRevision: number;
    taskOwnerSessionId: string;
    sessionId: string;
    triggerType: "manual" | "schedule";
    progress: number;
    requiredTotal: number;
    requiredCompleted: number;
    totalSteps: number;
    startedAt: string;
    templateSnapshot: {
        title: string;
        revision: number;
        steps: {
            title: string;
            stepId: string;
            instruction: string;
            order: number;
            required: boolean;
            completionCriteria?: string | undefined;
            retryPolicy?: "safe_retry" | "verify_before_retry" | "manual_only" | undefined;
        }[];
    };
    scheduleId?: string | undefined;
    occurrenceKey?: string | undefined;
    idempotencyKey?: string | undefined;
    currentStepId?: string | undefined;
    finishedAt?: string | undefined;
    summary?: string | undefined;
    error?: {
        code: string;
        message: string;
    } | undefined;
    resumesRunId?: string | undefined;
    lastHeartbeatAt?: string | undefined;
    leaseExpiresAt?: string | undefined;
    executionToken?: string | undefined;
    executionGeneration?: number | undefined;
    staleDetectedAt?: string | undefined;
    failureCategory?: "agent_error" | "tool_error" | "timeout" | "permission" | "missing_input" | "external_side_effect" | "unknown" | undefined;
    needsUserConfirmation?: boolean | undefined;
    recoveryConfirmation?: {
        sourceRunId: string;
        failedStepIds: string[];
        confirmedAt: string;
        confirmationNote?: string | undefined;
    } | undefined;
}>;
export type RunRecord = z.infer<typeof runRecordSchema>;
export declare const runStepRecordSchema: z.ZodObject<{
    runId: z.ZodString;
    stepId: z.ZodString;
    taskId: z.ZodString;
    order: z.ZodNumber;
    title: z.ZodString;
    required: z.ZodBoolean;
    status: z.ZodEnum<["pending", "running", "completed", "failed", "skipped"]>;
    attempt: z.ZodNumber;
    startedAt: z.ZodOptional<z.ZodString>;
    finishedAt: z.ZodOptional<z.ZodString>;
    summary: z.ZodOptional<z.ZodString>;
    error: z.ZodOptional<z.ZodObject<{
        code: z.ZodString;
        message: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        code: string;
        message: string;
    }, {
        code: string;
        message: string;
    }>>;
    carryOverFromRunId: z.ZodOptional<z.ZodString>;
    updatedAt: z.ZodString;
    /** 1.2.0: why this step failed, and how it may be retried. */
    failureCategory: z.ZodOptional<z.ZodEnum<["agent_error", "tool_error", "timeout", "permission", "missing_input", "external_side_effect", "unknown"]>>;
    retryPolicy: z.ZodOptional<z.ZodEnum<["safe_retry", "verify_before_retry", "manual_only"]>>;
    lastHeartbeatAt: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    title: string;
    status: "running" | "failed" | "skipped" | "pending" | "completed";
    updatedAt: string;
    stepId: string;
    order: number;
    required: boolean;
    taskId: string;
    runId: string;
    attempt: number;
    retryPolicy?: "safe_retry" | "verify_before_retry" | "manual_only" | undefined;
    startedAt?: string | undefined;
    finishedAt?: string | undefined;
    summary?: string | undefined;
    error?: {
        code: string;
        message: string;
    } | undefined;
    lastHeartbeatAt?: string | undefined;
    failureCategory?: "agent_error" | "tool_error" | "timeout" | "permission" | "missing_input" | "external_side_effect" | "unknown" | undefined;
    carryOverFromRunId?: string | undefined;
}, {
    title: string;
    status: "running" | "failed" | "skipped" | "pending" | "completed";
    updatedAt: string;
    stepId: string;
    order: number;
    required: boolean;
    taskId: string;
    runId: string;
    attempt: number;
    retryPolicy?: "safe_retry" | "verify_before_retry" | "manual_only" | undefined;
    startedAt?: string | undefined;
    finishedAt?: string | undefined;
    summary?: string | undefined;
    error?: {
        code: string;
        message: string;
    } | undefined;
    lastHeartbeatAt?: string | undefined;
    failureCategory?: "agent_error" | "tool_error" | "timeout" | "permission" | "missing_input" | "external_side_effect" | "unknown" | undefined;
    carryOverFromRunId?: string | undefined;
}>;
export type RunStepRecord = z.infer<typeof runStepRecordSchema>;
/**
 * Idempotency reservation.
 *
 * Written before the run row so two concurrent triggers with the same key
 * cannot both create a run, and removed when the creation fails so a retry is
 * possible. `state: 'committed'` means the run exists.
 */
export declare const idempotencyRecordSchema: z.ZodObject<{
    taskId: z.ZodString;
    idempotencyKey: z.ZodString;
    ownerSessionId: z.ZodString;
    state: z.ZodEnum<["reserved", "committed"]>;
    runId: z.ZodOptional<z.ZodString>;
    createdAt: z.ZodString;
    updatedAt: z.ZodString;
}, "strip", z.ZodTypeAny, {
    createdAt: string;
    updatedAt: string;
    state: "reserved" | "committed";
    taskId: string;
    ownerSessionId: string;
    idempotencyKey: string;
    runId?: string | undefined;
}, {
    createdAt: string;
    updatedAt: string;
    state: "reserved" | "committed";
    taskId: string;
    ownerSessionId: string;
    idempotencyKey: string;
    runId?: string | undefined;
}>;
export type IdempotencyRecord = z.infer<typeof idempotencyRecordSchema>;
/**
 * Concurrency accounting: one row per non-terminal run.
 *
 * Counting the index is O(active runs); scanning every run to count them is
 * not, and the PRD's 50k-run dataset makes the difference observable. The
 * index is rebuilt from persisted runs on boot, so a crash cannot leak a slot.
 */
export declare const activeRunRecordSchema: z.ZodObject<{
    runId: z.ZodString;
    taskId: z.ZodString;
    ownerSessionId: z.ZodString;
    sessionId: z.ZodString;
    startedAt: z.ZodString;
    leaseExpiresAt: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    taskId: string;
    ownerSessionId: string;
    runId: string;
    sessionId: string;
    startedAt: string;
    leaseExpiresAt?: string | undefined;
}, {
    taskId: string;
    ownerSessionId: string;
    runId: string;
    sessionId: string;
    startedAt: string;
    leaseExpiresAt?: string | undefined;
}>;
export type ActiveRunRecord = z.infer<typeof activeRunRecordSchema>;
/**
 * Per-task run index, ordered by creation time then run id.
 *
 * This is what makes history pagination a range read instead of a scan of every
 * run in the domain, and what keeps the cursor stable when two runs share a
 * millisecond.
 */
export declare const runIndexRecordSchema: z.ZodObject<{
    runId: z.ZodString;
    taskId: z.ZodString;
    ownerSessionId: z.ZodString;
    status: z.ZodEnum<["queued", "running", "blocked", "succeeded", "failed", "interrupted", "skipped"]>;
    startedAt: z.ZodString;
}, "strip", z.ZodTypeAny, {
    status: "queued" | "running" | "blocked" | "succeeded" | "failed" | "interrupted" | "skipped";
    taskId: string;
    ownerSessionId: string;
    runId: string;
    startedAt: string;
}, {
    status: "queued" | "running" | "blocked" | "succeeded" | "failed" | "interrupted" | "skipped";
    taskId: string;
    ownerSessionId: string;
    runId: string;
    startedAt: string;
}>;
export type RunIndexRecord = z.infer<typeof runIndexRecordSchema>;
/** One journal row per schedule mutation, so a half-applied change is visible. */
export declare const scheduleOpRecordSchema: z.ZodObject<{
    operationId: z.ZodString;
    taskId: z.ZodString;
    ownerSessionId: z.ZodString;
    scheduleId: z.ZodOptional<z.ZodString>;
    action: z.ZodEnum<["create", "update", "pause", "resume", "delete"]>;
    status: z.ZodEnum<["pending", "processing", "succeeded", "failed", "reconciling"]>;
    /** Timing the operation was asked to install, replayed by reconciliation. */
    timing: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    createdAt: z.ZodString;
    updatedAt: z.ZodString;
    lastError: z.ZodOptional<z.ZodString>;
    /** Set when reconciliation settled the row, for the audit trail. */
    reconciledAt: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    status: "succeeded" | "failed" | "pending" | "processing" | "reconciling";
    createdAt: string;
    updatedAt: string;
    taskId: string;
    ownerSessionId: string;
    operationId: string;
    action: "create" | "update" | "pause" | "resume" | "delete";
    scheduleId?: string | undefined;
    timing?: Record<string, unknown> | undefined;
    lastError?: string | undefined;
    reconciledAt?: string | undefined;
}, {
    status: "succeeded" | "failed" | "pending" | "processing" | "reconciling";
    createdAt: string;
    updatedAt: string;
    taskId: string;
    ownerSessionId: string;
    operationId: string;
    action: "create" | "update" | "pause" | "resume" | "delete";
    scheduleId?: string | undefined;
    timing?: Record<string, unknown> | undefined;
    lastError?: string | undefined;
    reconciledAt?: string | undefined;
}>;
export type ScheduleOpRecord = z.infer<typeof scheduleOpRecordSchema>;
export declare const globalStateSchema: z.ZodObject<{
    schemaVersion: z.ZodNumber;
    appliedMigrations: z.ZodRecord<z.ZodString, z.ZodString>;
    lastRecoveryScanAt: z.ZodOptional<z.ZodString>;
    lastPruneAt: z.ZodOptional<z.ZodString>;
    /** Last time the schedule journal was reconciled. */
    lastScheduleReconcileAt: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    schemaVersion: number;
    appliedMigrations: Record<string, string>;
    lastRecoveryScanAt?: string | undefined;
    lastPruneAt?: string | undefined;
    lastScheduleReconcileAt?: string | undefined;
}, {
    schemaVersion: number;
    appliedMigrations: Record<string, string>;
    lastRecoveryScanAt?: string | undefined;
    lastPruneAt?: string | undefined;
    lastScheduleReconcileAt?: string | undefined;
}>;
export type GlobalState = z.infer<typeof globalStateSchema>;
export declare const TABLES: {
    readonly tasks: "tasks";
    readonly runs: "task_runs";
    readonly steps: "task_run_steps";
    readonly idempotency: "idempotency";
    readonly activeRuns: "active_runs";
    readonly runIndex: "run_index";
    readonly scheduleOps: "schedule_ops";
    readonly meta: "meta";
};
/** `${runId}/${stepId}` — the composite key of the step table. */
export declare function stepKey(runId: string, stepId: string): string;
/** `${taskId}/${startedAt}/${runId}` — sortable per-task run index key. */
export declare function runIndexKey(taskId: string, startedAt: string, runId: string): string;
/** `${taskId}/${idempotencyKey}` — one reservation per key per task. */
export declare function idempotencyKeyOf(taskId: string, idempotencyKey: string): string;
