/**
 * Run lifecycle: creation, heartbeats, step reports, finishing, recovery.
 *
 * Two rules shape this file.
 *
 * 1. A run is created inside one serialized critical section: the idempotency
 *    lookup, the concurrency count, the reservation and the insert are one
 *    sequence, and the reservation survives a crash. A bare "check then write"
 *    is exactly the race the PRD calls out.
 * 2. A run's cached progress is never the source of truth. Every mutation
 *    recomputes it from the step rows, and a read that finds drift repairs it,
 *    so a step write that outlived a failed summary write heals on the next
 *    touch instead of leaving a run that can never finish.
 */
import type { RunRecord, RunStepRecord, StepError, FailureCategory } from '../domain/records.js';
import { runIndexKey } from '../domain/records.js';
import { orderedSteps, runTransitionProblem } from '../domain/state.js';
import type { EngineConfig } from '../config.js';
import type { AuditTrail } from './audit.js';
import type { Repository } from '../storage/repository.js';
export declare const HISTORY_DEFAULT_LIMIT = 20;
export declare const HISTORY_MAX_LIMIT = 50;
export interface StartRunInput {
    sessionId: string;
    taskId?: string;
    triggerPayload?: string;
    triggerType?: 'manual' | 'schedule';
    scheduleId?: string;
    occurrenceKey?: string;
    idempotencyKey?: string;
    manualRunId?: string;
    defer?: boolean;
    source?: string;
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
    action: 'started' | 'completed' | 'failed' | 'skipped';
    summary?: string;
    error?: StepError;
    failureCategory?: FailureCategory;
    executionToken?: string;
    source?: string;
}
export interface FinishInput {
    sessionId: string;
    runId: string;
    status: 'succeeded' | 'failed' | 'blocked' | 'interrupted' | 'skipped';
    summary?: string;
    error?: StepError;
    failureCategory?: FailureCategory;
    executionToken?: string;
    source?: string;
}
export interface ResumeInput {
    sessionId: string;
    runId: string;
    confirmation?: string;
    note?: string;
}
export interface HistoryInput {
    sessionId: string;
    taskId: string;
    status?: string;
    limit?: number;
    cursor?: string;
}
export interface HistoryRow {
    runId: string;
    taskId: string;
    status: string;
    triggerType: string;
    taskRevision: number;
    startedAt: string;
    finishedAt?: string;
    progress: number;
    requiredCompleted: number;
    requiredTotal: number;
    summary?: string;
    error?: StepError;
    failureCategory?: FailureCategory;
    resumesRunId?: string;
    needsUserConfirmation?: boolean;
    steps: Array<{
        stepId: string;
        order: number;
        title: string;
        status: string;
        required: boolean;
    }>;
}
export interface HistoryResult {
    rows: HistoryRow[];
    nextCursor?: string;
    total: number;
}
export declare class RunService {
    private readonly repo;
    private readonly config;
    private readonly audit;
    private readonly now;
    private readonly lock;
    constructor(repo: Repository, config: EngineConfig, audit: AuditTrail, now: () => Date);
    /**
     * Create (or find) the run for one trigger.
     *
     * The same key always yields the same run: for schedules the key is the
     * schedule id plus its occurrence, for manual calls it is the caller's
     * manualRunId. Repeated delivery of one occurrence therefore returns the
     * existing run as `deduplicated` instead of starting a second execution.
     */
    start(input: StartRunInput): Promise<StartRunResult>;
    begin(input: {
        sessionId: string;
        runId: string;
        executionToken?: string;
        source?: string;
    }): Promise<{
        run: RunRecord;
        steps: RunStepRecord[];
        deduplicated: boolean;
    }>;
    /**
     * Accept one heartbeat and renew the lease.
     *
     * A heartbeat is evidence about the executor, not about the work: it never
     * changes a step's result and never decides that an external effect did not
     * happen.
     */
    heartbeat(input: {
        sessionId: string;
        runId: string;
        executionToken?: string;
        note?: string;
    }): Promise<{
        run: RunRecord;
        leaseExpiresAt?: string;
        accepted: boolean;
        warning?: string;
    }>;
    reportStep(input: StepReportInput): Promise<{
        run: RunRecord;
        step: RunStepRecord;
        steps: RunStepRecord[];
    }>;
    finish(input: FinishInput): Promise<{
        run: RunRecord;
        steps: RunStepRecord[];
    }>;
    /**
     * Start a new run from a finished one.
     *
     * The old run keeps its status and its steps: it is the record of what
     * happened. The new run carries `resumesRunId`, a fresh execution credential
     * and a higher generation, so the previous agent's reports can no longer
     * touch it.
     */
    resume(input: ResumeInput): Promise<StartRunResult>;
    /**
     * Find runs whose executor is gone.
     *
     * During a live process a missing heartbeat is only a suspicion, so it is
     * recorded and nothing else. At startup the previous process is provably
     * gone, which is the one moment the engine may declare the run interrupted —
     * and even then the steps are marked failed, never re-run.
     */
    scanStale(options: {
        startup: boolean;
        sessionId?: string;
    }): Promise<{
        scanned: number;
        suspected: number;
        interrupted: number;
        scannedAt: string;
    }>;
    /**
     * History page.
     *
     * Keyset pagination on (startedAt, runId): a cursor names the last row shown,
     * so a page never repeats or skips rows that share a timestamp, and the
     * index makes the read a range instead of a scan of every run.
     */
    history(input: HistoryInput): HistoryResult;
    /** Repair a run whose cached summary drifted from its steps. */
    reconcileRun(runId: string): Promise<{
        run: RunRecord;
        repaired: boolean;
    }>;
    stepsOf(runId: string): Promise<RunStepRecord[]>;
    countActiveRuns(ownerSessionId: string): number;
    countBlockedRuns(ownerSessionId: string): number;
    countInterruptedRuns(ownerSessionId: string): number;
    healthOf(run: RunRecord): import("../domain/state.js").RunHealthResult;
    /**
     * Delete expired terminal runs in bounded batches.
     *
     * Never touches a run that still occupies a slot, and never touches steps of
     * a run it is not deleting, so an interrupted prune costs at most one run.
     */
    prune(batchSize?: number): Promise<{
        runsDeleted: number;
        stepsDeleted: number;
        at: string;
    }>;
    private idempotencyKeyFor;
    /**
     * Reject before creating anything: the counts come from the active-run index,
     * which holds exactly the rows that occupy a slot.
     */
    private assertConcurrency;
    private buildFreshSteps;
    private rollbackCreation;
    /** Recompute the run's cached summary from the step rows after a step write. */
    private syncRunSummary;
    private requiresConfirmation;
    /**
     * Credential policy, stated once:
     * - a run written before 1.2.0 has no token, so any caller may report on it;
     * - a caller that presents no token on a token-bearing run is accepted for
     *   compatibility and gets a warning, because 1.1.x agents never sent one;
     * - a caller that presents the wrong token is rejected: it is a live agent
     *   from a generation that no longer owns this run.
     */
    private assertToken;
    private tokenWarning;
    private newExecutionToken;
    private leaseFrom;
    private nowIso;
    private toHistoryRow;
}
export { runIndexKey, orderedSteps, runTransitionProblem };
