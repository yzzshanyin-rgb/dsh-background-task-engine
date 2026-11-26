/**
 * Persisted record schemas (PRD 5.x, 7.3).
 *
 * Everything written to the StorageDomain is validated by these zod schemas
 * before it is stored and again when the domain is opened, so a corrupted or
 * hand-edited record fails loudly instead of silently degrading behaviour.
 */
import { z } from 'zod';
/** Bumped only when the persisted shape changes; drives the migration runner. */
export declare const SCHEMA_VERSION = 1;
/**
 * StorageDomain unit name.
 *
 * The host's `UNIT_NAME_RE` is `/^[a-z][a-z0-9_]*$/` (verified against the
 * installed @deepseek-ai/dsh-storage), so the domain id uses underscores even
 * though the npm package name uses hyphens. The two are deliberately different
 * values: the package name is the npm identity, this is the storage unit.
 */
export declare const DOMAIN_NAME = "dsh_background_task_engine";
export declare const TASK_STATUSES: readonly ["active", "paused", "archived"];
export declare const RUN_STATUSES: readonly ["queued", "running", "blocked", "succeeded", "failed", "interrupted", "skipped"];
export declare const STEP_STATUSES: readonly ["pending", "running", "completed", "failed", "skipped"];
export declare const TRIGGER_TYPES: readonly ["manual", "schedule"];
export type TaskStatus = (typeof TASK_STATUSES)[number];
export type RunStatus = (typeof RUN_STATUSES)[number];
export type StepStatus = (typeof STEP_STATUSES)[number];
export type TriggerType = (typeof TRIGGER_TYPES)[number];
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
export declare const stepDefinitionSchema: z.ZodObject<{
    stepId: z.ZodString;
    title: z.ZodString;
    instruction: z.ZodString;
    completionCriteria: z.ZodOptional<z.ZodString>;
    order: z.ZodNumber;
    required: z.ZodBoolean;
}, "strip", z.ZodTypeAny, {
    title: string;
    stepId: string;
    instruction: string;
    order: number;
    required: boolean;
    completionCriteria?: string | undefined;
}, {
    title: string;
    stepId: string;
    instruction: string;
    order: number;
    required: boolean;
    completionCriteria?: string | undefined;
}>;
export type StepDefinition = z.infer<typeof stepDefinitionSchema>;
export declare const scheduleRefSchema: z.ZodObject<{
    scheduleId: z.ZodString;
    /** Original timing kind requested by the user (at / every / rrule). */
    timingKind: z.ZodString;
    timing: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    state: z.ZodEnum<["active", "paused", "unlinked"]>;
    title: z.ZodString;
    createdAt: z.ZodString;
    updatedAt: z.ZodString;
    lastError: z.ZodOptional<z.ZodObject<{
        code: z.ZodString;
        message: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        code: string;
        message: string;
    }, {
        code: string;
        message: string;
    }>>;
}, "strip", z.ZodTypeAny, {
    title: string;
    createdAt: string;
    updatedAt: string;
    scheduleId: string;
    timingKind: string;
    timing: Record<string, unknown>;
    state: "active" | "paused" | "unlinked";
    lastError?: {
        code: string;
        message: string;
    } | undefined;
}, {
    title: string;
    createdAt: string;
    updatedAt: string;
    scheduleId: string;
    timingKind: string;
    timing: Record<string, unknown>;
    state: "active" | "paused" | "unlinked";
    lastError?: {
        code: string;
        message: string;
    } | undefined;
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
    }, "strip", z.ZodTypeAny, {
        title: string;
        stepId: string;
        instruction: string;
        order: number;
        required: boolean;
        completionCriteria?: string | undefined;
    }, {
        title: string;
        stepId: string;
        instruction: string;
        order: number;
        required: boolean;
        completionCriteria?: string | undefined;
    }>, "many">;
    scheduleRef: z.ZodOptional<z.ZodObject<{
        scheduleId: z.ZodString;
        /** Original timing kind requested by the user (at / every / rrule). */
        timingKind: z.ZodString;
        timing: z.ZodRecord<z.ZodString, z.ZodUnknown>;
        state: z.ZodEnum<["active", "paused", "unlinked"]>;
        title: z.ZodString;
        createdAt: z.ZodString;
        updatedAt: z.ZodString;
        lastError: z.ZodOptional<z.ZodObject<{
            code: z.ZodString;
            message: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            code: string;
            message: string;
        }, {
            code: string;
            message: string;
        }>>;
    }, "strip", z.ZodTypeAny, {
        title: string;
        createdAt: string;
        updatedAt: string;
        scheduleId: string;
        timingKind: string;
        timing: Record<string, unknown>;
        state: "active" | "paused" | "unlinked";
        lastError?: {
            code: string;
            message: string;
        } | undefined;
    }, {
        title: string;
        createdAt: string;
        updatedAt: string;
        scheduleId: string;
        timingKind: string;
        timing: Record<string, unknown>;
        state: "active" | "paused" | "unlinked";
        lastError?: {
            code: string;
            message: string;
        } | undefined;
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
        lastError?: {
            code: string;
            message: string;
        } | undefined;
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
        lastError?: {
            code: string;
            message: string;
        } | undefined;
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
    }, "strip", z.ZodTypeAny, {
        title: string;
        stepId: string;
        instruction: string;
        order: number;
        required: boolean;
        completionCriteria?: string | undefined;
    }, {
        title: string;
        stepId: string;
        instruction: string;
        order: number;
        required: boolean;
        completionCriteria?: string | undefined;
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
    }[];
}>;
export type TemplateSnapshot = z.infer<typeof templateSnapshotSchema>;
export declare const runRecordSchema: z.ZodObject<{
    runId: z.ZodString;
    taskId: z.ZodString;
    taskRevision: z.ZodNumber;
    /** Owner of the task; every tool entry point compares this with the caller. */
    taskOwnerSessionId: z.ZodString;
    /** Session that started the run (equals owner in V1.0). */
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
        }, "strip", z.ZodTypeAny, {
            title: string;
            stepId: string;
            instruction: string;
            order: number;
            required: boolean;
            completionCriteria?: string | undefined;
        }, {
            title: string;
            stepId: string;
            instruction: string;
            order: number;
            required: boolean;
            completionCriteria?: string | undefined;
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
        }[];
    }>;
    schemaVersion: z.ZodNumber;
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
    /** Set when a resume carries a completed step over into the new run. */
    carryOverFromRunId: z.ZodOptional<z.ZodString>;
    updatedAt: z.ZodString;
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
    startedAt?: string | undefined;
    finishedAt?: string | undefined;
    summary?: string | undefined;
    error?: {
        code: string;
        message: string;
    } | undefined;
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
    startedAt?: string | undefined;
    finishedAt?: string | undefined;
    summary?: string | undefined;
    error?: {
        code: string;
        message: string;
    } | undefined;
    carryOverFromRunId?: string | undefined;
}>;
export type RunStepRecord = z.infer<typeof runStepRecordSchema>;
export declare const globalStateSchema: z.ZodObject<{
    schemaVersion: z.ZodNumber;
    /** migrationId -> ISO timestamp; presence means "already applied". */
    appliedMigrations: z.ZodRecord<z.ZodString, z.ZodString>;
    lastRecoveryScanAt: z.ZodOptional<z.ZodString>;
    lastPruneAt: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    schemaVersion: number;
    appliedMigrations: Record<string, string>;
    lastRecoveryScanAt?: string | undefined;
    lastPruneAt?: string | undefined;
}, {
    schemaVersion: number;
    appliedMigrations: Record<string, string>;
    lastRecoveryScanAt?: string | undefined;
    lastPruneAt?: string | undefined;
}>;
export type GlobalState = z.infer<typeof globalStateSchema>;
/** Table names, kept in one place so spec and repository cannot drift. */
export declare const TABLES: {
    readonly tasks: "tasks";
    readonly runs: "task_runs";
    readonly steps: "task_run_steps";
};
/** Composite key for one step record: one row per (runId, stepId). */
export declare function stepKey(runId: string, stepId: string): string;
