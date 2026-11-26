/**
 * Schedule operation journal.
 *
 * The host owns the schedule; the task row owns the reference to it. Those are
 * two writes that cannot be one transaction, so every mutation leaves a row
 * behind *before* the host is called. If the process dies in between, the next
 * boot finds the row and either finishes the job or reports exactly what it
 * could not decide — it never assumes the call did not happen, and it never
 * blindly creates or deletes a second time.
 */
import type { ScheduleAction, ScheduleOpRecord, TaskRecord } from '../domain/records.js';
import type { AuditTrail } from './audit.js';
import type { Repository } from '../storage/repository.js';
import { type ScheduleAdapter, type TimingInput } from './schedule-adapter.js';
export interface ScheduleOpInput {
    action: ScheduleAction;
    task: TaskRecord;
    sessionId: string;
    scheduleId?: string;
    timing?: TimingInput;
}
export interface ReconcileReport {
    checked: number;
    settled: number;
    ambiguous: number;
    failed: number;
    checkedAt: string;
    notes: string[];
}
export declare class ScheduleLedger {
    private readonly repo;
    private readonly adapter;
    private readonly audit;
    private readonly now;
    constructor(repo: Repository, adapter: ScheduleAdapter, audit: AuditTrail, now: () => Date);
    /**
     * Journal one mutation.
     *
     * `pending` is written before the host call; `processing` immediately after,
     * so a crash is distinguishable from a request that never left. On success
     * the row records the schedule id the host assigned, which is the only thing
     * a later reconciliation needs.
     */
    run<T>(input: ScheduleOpInput, work: (op: ScheduleOpRecord) => Promise<T>): Promise<{
        result: T;
        op: ScheduleOpRecord;
    }>;
    /**
     * Settle whatever the previous process left behind.
     *
     * Safe repair only: a rule that exists is adopted, a rule that is gone is
     * recorded as gone, a delete that already happened is accepted. Anything
     * where the truth cannot be read without guessing stays `reconciling` so a
     * human can look at it — the PRD's explicit rule over a helpful invention.
     */
    reconcile(): Promise<ReconcileReport>;
    /** Human description of the journal row, for diagnostics and the UI. */
    describe(op: ScheduleOpRecord): string;
    private mark;
}
