/**
 * Run service: manual/schedule execution lifecycle (PRD 5.2, 5.3, FR-005..FR-008,
 * chapter 9.1, acceptance 14.2 / 14.4).
 *
 * Invariants enforced here:
 *  - a TaskRun is created only after ownership, task status, concurrency and
 *    idempotency checks pass;
 *  - the step template is snapshotted into the run, so later task edits cannot
 *    change an in-flight run;
 *  - steps advance strictly by `order`; a step cannot be reported before its
 *    predecessors settled;
 *  - `succeeded` requires every required step to be completed;
 *  - a failed step is never replayed silently: recovery needs a confirmation.
 */
import type { EngineConfig } from '../config.js';
import { type RunRecord, type RunStatus, type RunStepRecord, type TriggerType } from '../domain/records.js';
import { compareDesc } from '../utils/page.js';
import type { Repository } from '../storage/repository.js';
import type { AuditTrail } from './audit.js';
export type StepReportAction = 'started' | 'completed' | 'failed' | 'skipped';
export type FinishStatus = 'succeeded' | 'failed' | 'interrupted' | 'skipped' | 'blocked';
export interface StartRunInput {
    sessionId: string;
    taskId?: string;
    triggerPayload?: string;
    triggerType?: TriggerType;
    scheduleId?: string;
    occurrenceKey?: string;
    idempotencyKey?: string;
    manualRunId?: string;
    /** Create the run as `queued` instead of `running` (explicit two-phase start). */
    defer?: boolean;
    source: string;
}
export interface StartRunResult {
    run: RunRecord;
    steps: RunStepRecord[];
    deduplicated: boolean;
}
export interface StepReportInput {
    sessionId: string;
    runId: string;
    stepId: string;
    action: StepReportAction;
    summary?: string;
    error?: {
        code?: string;
        message: string;
    } | string;
}
export interface FinishRunInput {
    sessionId: string;
    runId: string;
    status: FinishStatus;
    summary?: string;
    error?: {
        code?: string;
        message: string;
    } | string;
}
export interface ResumeRunInput {
    sessionId: string;
    runId: string;
    confirmation?: string;
}
export interface HistoryInput {
    sessionId: string;
    taskId: string;
    status?: RunStatus;
    limit?: number;
    cursor?: string;
}
export interface RunHistoryRow {
    runId: string;
    status: RunStatus;
    triggerType: TriggerType;
    taskRevision: number;
    progress: number;
    requiredCompleted: number;
    requiredTotal: number;
    startedAt: string;
    finishedAt?: string;
    currentStepId?: string;
    resumesRunId?: string;
    summary?: string;
    error?: {
        code: string;
        message: string;
    };
    steps: Array<{
        stepId: string;
        order: number;
        title: string;
        status: string;
    }>;
}
export declare class RunService {
    private readonly repo;
    private readonly config;
    private readonly audit;
    private readonly now;
    constructor(repo: Repository, config: EngineConfig, audit: AuditTrail, now?: () => string);
    start(input: StartRunInput): Promise<StartRunResult>;
    /** Two-phase start: transition an existing `queued` run to `running`. */
    begin(input: {
        sessionId: string;
        runId: string;
        source: string;
    }): Promise<StartRunResult>;
    private buildFreshSteps;
    reportStep(input: StepReportInput): Promise<{
        run: RunRecord;
        step: RunStepRecord;
        deduplicated: boolean;
    }>;
    finish(input: FinishRunInput): Promise<RunRecord>;
    resume(input: ResumeRunInput): Promise<StartRunResult>;
    history(input: HistoryInput): {
        items: RunHistoryRow[];
        nextCursor?: string;
    };
    private toHistoryRow;
    /**
     * Startup scan (PRD FR-007, 14.4): a run that was `queued`/`running` and has
     * not been touched for `staleRunAfterMinutes` cannot be verified, so it is
     * marked `interrupted`. Nothing is restarted automatically.
     */
    recoverStale(): Promise<{
        scanned: number;
        interrupted: string[];
    }>;
    /**
     * Retention pruning (PRD 7.4 / FR-010): only terminal runs older than
     * `historyRetentionDays` and their step rows are removed. Templates, audit
     * information and every active run are preserved.
     */
    prune(): Promise<{
        runs: number;
        steps: number;
    }>;
    /** Persisted step rows of one run, ordered. */
    stepsOf(runId: string): RunStepRecord[];
    countActiveRuns(ownerSessionId: string): number;
}
export declare const RUN_HISTORY_ORDER: typeof compareDesc;
