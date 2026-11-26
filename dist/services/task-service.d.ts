/**
 * Task template service: create / list / get / update / archive and the
 * Schedule linkage (PRD 4.2, 5.1, FR-001, FR-002, FR-003).
 *
 * All persistence goes through Repository; all state changes are audited; every
 * entry point takes the caller SessionId and verifies ownership first.
 */
import { z } from 'zod';
import type { EngineConfig } from '../config.js';
import { type RunRecord, type ScheduleRef, type TaskRecord, type TaskStatus } from '../domain/records.js';
import type { Repository } from '../storage/repository.js';
import type { AuditTrail } from './audit.js';
import { type ScheduleAdapter, type TimingInput } from './schedule-adapter.js';
import type { ScheduleLedger } from './schedule-ledger.js';
import type { ScheduleOpRecord } from '../domain/records.js';
declare const stepInputSchema: z.ZodObject<{
    title: z.ZodString;
    instruction: z.ZodString;
    completionCriteria: z.ZodOptional<z.ZodString>;
    required: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    title: string;
    instruction: string;
    completionCriteria?: string | undefined;
    required?: boolean | undefined;
}, {
    title: string;
    instruction: string;
    completionCriteria?: string | undefined;
    required?: boolean | undefined;
}>;
export type StepInput = z.infer<typeof stepInputSchema>;
export interface CreateTaskInput {
    sessionId: string;
    title?: string;
    description?: string;
    steps?: StepInput[];
    copyFromTaskId?: string;
}
export interface UpdateTaskInput {
    sessionId: string;
    taskId: string;
    expectedRevision: number;
    title?: string;
    description?: string;
    steps?: StepInput[];
    status?: 'active' | 'paused';
}
export interface ListTasksInput {
    sessionId: string;
    status?: TaskStatus;
    query?: string;
    limit?: number;
    cursor?: string;
}
export interface TaskSummaryRow {
    taskId: string;
    title: string;
    status: TaskStatus;
    revision: number;
    stepCount: number;
    updatedAt: string;
    schedule: {
        scheduleId: string;
        state: ScheduleRef['state'];
        timing: string;
    } | null;
    lastRun: {
        runId: string;
        status: string;
        startedAt: string;
    } | null;
}
export declare class TaskService {
    private readonly repo;
    private readonly config;
    private readonly audit;
    private readonly schedules;
    private readonly ledger;
    private readonly now;
    constructor(repo: Repository, config: EngineConfig, audit: AuditTrail, schedules: ScheduleAdapter, ledger: ScheduleLedger, now?: () => string);
    create(input: CreateTaskInput): Promise<TaskRecord>;
    private normaliseSteps;
    list(input: ListTasksInput): {
        items: TaskSummaryRow[];
        nextCursor?: string;
    };
    private toSummaryRow;
    get(owner: string, taskId: string, options?: {
        includeRuns?: boolean;
    }): {
        task: TaskRecord;
        recentRuns: RunRecord[];
    };
    update(input: UpdateTaskInput): Promise<TaskRecord>;
    private applyStatusWithSchedule;
    private patchScheduleRef;
    archive(input: {
        sessionId: string;
        taskId: string;
        expectedRevision: number;
    }): Promise<TaskRecord>;
    scheduleCreate(input: {
        sessionId: string;
        taskId: string;
        timing: TimingInput;
    }): Promise<TaskRecord & {
        scheduleId: string;
    }>;
    scheduleUpdate(input: {
        sessionId: string;
        taskId: string;
        timing: TimingInput;
    }): Promise<TaskRecord>;
    scheduleSetActive(input: {
        sessionId: string;
        taskId: string;
        active: boolean;
    }): Promise<{
        task: TaskRecord;
        changed: boolean;
    }>;
    scheduleDelete(input: {
        sessionId: string;
        taskId: string;
    }): Promise<{
        task: TaskRecord;
        alreadyGone: boolean;
    }>;
    /**
     * Journal rows for one task, newest last.
     *
     * A row that never left pending/processing/reconciling is exactly the
     * evidence the PRD asks us to keep when the host and local record disagree.
     */
    scheduleOperations(sessionId: string, taskId: string): ScheduleOpRecord[];
    /** Settle journals left behind by a previous boot; safe to call repeatedly. */
    reconcileSchedules(): Promise<{
        checked: number;
        settled: number;
        ambiguous: number;
        failed: number;
        checkedAt: string;
        notes: string[];
    }>;
    scheduleStatus(input: {
        sessionId: string;
        taskId: string;
    }): Promise<{
        ref: ScheduleRef | null;
        live: {
            status?: string;
            scheduledAt?: string;
            title?: string;
        } | null;
        available: boolean;
    }>;
    scheduleRunNow(input: {
        sessionId: string;
        taskId: string;
    }): Promise<{
        pending: boolean;
    }>;
}
export {};
