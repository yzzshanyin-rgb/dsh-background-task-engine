/**
 * TaskEngine: composition root for the plugin (PRD 8.2, 8.4, FR-012).
 *
 * Startup sequence (all failures are explicit, never silent):
 *   1. open the StorageDomain declared in src/storage/spec.ts
 *   2. run idempotent migrations from the persisted ledger
 *   3. verify record integrity (runs reference tasks, steps belong to runs)
 *   4. recover stale `queued`/`running` rows into `interrupted`
 *   5. prune terminal runs older than `historyRetentionDays`
 *
 * If step 1 fails the `ready` promise rejects and every tool returns
 * TASK_STORAGE_ERROR — the plugin does not fall back to in-memory storage
 * (PRD 16.3).
 */
import { type HostContextLike } from '../host.js';
import type { EngineConfig } from '../config.js';
import { type MigrationReport, type IntegrityReport } from '../storage/spec.js';
import { ScheduleAdapter } from './schedule-adapter.js';
import { TaskService } from './task-service.js';
import { RunService } from './run-service.js';
export interface EngineDiagnostics {
    storageAvailable: boolean;
    scheduleAvailable: boolean;
    activeRunCount: number;
    schemaVersion: number;
    taskCount: number;
    runCount: number;
    lastRecoveryScanAt?: string;
    lastPruneAt?: string;
    staleRunsInterrupted: number;
    integrity: IntegrityReport | null;
    migrations: MigrationReport | null;
    lastError?: string;
}
export declare class TaskEngine {
    private readonly ctx;
    private readonly now;
    readonly config: EngineConfig;
    readonly ready: Promise<void>;
    private domain?;
    private repo?;
    private audit?;
    private schedules?;
    private tasks?;
    private runs?;
    private initError?;
    private disposed;
    private readonly diagnostics;
    constructor(ctx: HostContextLike, config: EngineConfig, now?: () => string);
    private init;
    /** Wait for startup to finish; throws a TaskEngineError when storage is unavailable. */
    waitReady(): Promise<void>;
    get taskService(): TaskService;
    get runService(): RunService;
    /** TaskService may be used for schedule-only operations; storage must be ready. */
    get scheduleAdapter(): ScheduleAdapter;
    diagnosticsFor(sessionId: string): Promise<EngineDiagnostics>;
    /** Release the domain handle. User data is never deleted. */
    dispose(): Promise<void>;
}
/** Domain record schemas, re-exported for diagnostics and tests. */
export declare const domainSchemas: {
    tasks: import("zod").ZodObject<{
        taskId: import("zod").ZodString;
        title: import("zod").ZodString;
        description: import("zod").ZodOptional<import("zod").ZodString>;
        status: import("zod").ZodEnum<["active", "paused", "archived"]>;
        revision: import("zod").ZodNumber;
        ownerSessionId: import("zod").ZodString;
        steps: import("zod").ZodArray<import("zod").ZodObject<{
            stepId: import("zod").ZodString;
            title: import("zod").ZodString;
            instruction: import("zod").ZodString;
            completionCriteria: import("zod").ZodOptional<import("zod").ZodString>;
            order: import("zod").ZodNumber;
            required: import("zod").ZodBoolean;
        }, "strip", import("zod").ZodTypeAny, {
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
        scheduleRef: import("zod").ZodOptional<import("zod").ZodObject<{
            scheduleId: import("zod").ZodString;
            timingKind: import("zod").ZodString;
            timing: import("zod").ZodRecord<import("zod").ZodString, import("zod").ZodUnknown>;
            state: import("zod").ZodEnum<["active", "paused", "unlinked"]>;
            title: import("zod").ZodString;
            createdAt: import("zod").ZodString;
            updatedAt: import("zod").ZodString;
            lastError: import("zod").ZodOptional<import("zod").ZodObject<{
                code: import("zod").ZodString;
                message: import("zod").ZodString;
            }, "strip", import("zod").ZodTypeAny, {
                code: string;
                message: string;
            }, {
                code: string;
                message: string;
            }>>;
        }, "strip", import("zod").ZodTypeAny, {
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
        createdAt: import("zod").ZodString;
        updatedAt: import("zod").ZodString;
        schemaVersion: import("zod").ZodNumber;
    }, "strip", import("zod").ZodTypeAny, {
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
    runs: import("zod").ZodObject<{
        runId: import("zod").ZodString;
        taskId: import("zod").ZodString;
        taskRevision: import("zod").ZodNumber;
        taskOwnerSessionId: import("zod").ZodString;
        sessionId: import("zod").ZodString;
        status: import("zod").ZodEnum<["queued", "running", "blocked", "succeeded", "failed", "interrupted", "skipped"]>;
        triggerType: import("zod").ZodEnum<["manual", "schedule"]>;
        scheduleId: import("zod").ZodOptional<import("zod").ZodString>;
        occurrenceKey: import("zod").ZodOptional<import("zod").ZodString>;
        idempotencyKey: import("zod").ZodOptional<import("zod").ZodString>;
        currentStepId: import("zod").ZodOptional<import("zod").ZodString>;
        progress: import("zod").ZodNumber;
        requiredTotal: import("zod").ZodNumber;
        requiredCompleted: import("zod").ZodNumber;
        totalSteps: import("zod").ZodNumber;
        startedAt: import("zod").ZodString;
        updatedAt: import("zod").ZodString;
        finishedAt: import("zod").ZodOptional<import("zod").ZodString>;
        summary: import("zod").ZodOptional<import("zod").ZodString>;
        error: import("zod").ZodOptional<import("zod").ZodObject<{
            code: import("zod").ZodString;
            message: import("zod").ZodString;
        }, "strip", import("zod").ZodTypeAny, {
            code: string;
            message: string;
        }, {
            code: string;
            message: string;
        }>>;
        resumesRunId: import("zod").ZodOptional<import("zod").ZodString>;
        templateSnapshot: import("zod").ZodObject<{
            revision: import("zod").ZodNumber;
            title: import("zod").ZodString;
            steps: import("zod").ZodArray<import("zod").ZodObject<{
                stepId: import("zod").ZodString;
                title: import("zod").ZodString;
                instruction: import("zod").ZodString;
                completionCriteria: import("zod").ZodOptional<import("zod").ZodString>;
                order: import("zod").ZodNumber;
                required: import("zod").ZodBoolean;
            }, "strip", import("zod").ZodTypeAny, {
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
        }, "strip", import("zod").ZodTypeAny, {
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
        schemaVersion: import("zod").ZodNumber;
    }, "strip", import("zod").ZodTypeAny, {
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
    steps: import("zod").ZodObject<{
        runId: import("zod").ZodString;
        stepId: import("zod").ZodString;
        taskId: import("zod").ZodString;
        order: import("zod").ZodNumber;
        title: import("zod").ZodString;
        required: import("zod").ZodBoolean;
        status: import("zod").ZodEnum<["pending", "running", "completed", "failed", "skipped"]>;
        attempt: import("zod").ZodNumber;
        startedAt: import("zod").ZodOptional<import("zod").ZodString>;
        finishedAt: import("zod").ZodOptional<import("zod").ZodString>;
        summary: import("zod").ZodOptional<import("zod").ZodString>;
        error: import("zod").ZodOptional<import("zod").ZodObject<{
            code: import("zod").ZodString;
            message: import("zod").ZodString;
        }, "strip", import("zod").ZodTypeAny, {
            code: string;
            message: string;
        }, {
            code: string;
            message: string;
        }>>;
        carryOverFromRunId: import("zod").ZodOptional<import("zod").ZodString>;
        updatedAt: import("zod").ZodString;
    }, "strip", import("zod").ZodTypeAny, {
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
    meta: import("zod").ZodObject<{
        schemaVersion: import("zod").ZodNumber;
        appliedMigrations: import("zod").ZodRecord<import("zod").ZodString, import("zod").ZodString>;
        lastRecoveryScanAt: import("zod").ZodOptional<import("zod").ZodString>;
        lastPruneAt: import("zod").ZodOptional<import("zod").ZodString>;
    }, "strip", import("zod").ZodTypeAny, {
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
};
