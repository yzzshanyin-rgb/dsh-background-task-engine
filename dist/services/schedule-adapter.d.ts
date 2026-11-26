/**
 * DSH Schedule adapter (PRD 4.5, 8.3, FR-002, FR-008; acceptance 14.3).
 *
 * The plugin never implements its own scheduler: occurrences, catch-up and
 * delivery are owned by `ctx.schedule`. This adapter only
 *  - translates the plugin's timing input into a documented host timing,
 *  - stores the returned scheduleId on the task (`scheduleRef`),
 *  - maps host failures onto TASK_SCHEDULE_* codes so a failed rule update is
 *    never reported as success.
 *
 * When `ctx.schedule` is not mounted every method throws
 * TASK_SCHEDULE_UNAVAILABLE and manual task execution keeps working
 * (PRD FR-012).
 */
import type { ScheduleRecordLike, ScheduleServiceLike } from '../host.js';
export type TimingInput = {
    kind: 'at';
    at: string;
} | {
    kind: 'every';
    everySeconds: number;
} | {
    kind: 'rrule';
    rrule: string;
} | {
    kind: 'cron';
    expression: string;
    timeZone?: string;
} | {
    kind: 'daily';
    hour: number;
    minute: number;
    timeZone?: string;
} | {
    kind: 'weekly';
    dayOfWeek: number;
    hour: number;
    minute: number;
    timeZone?: string;
};
export interface HostTiming {
    kind: string;
    [key: string]: unknown;
}
/**
 * Translate validated timing input into the host's documented timing shapes.
 * Only `at`, `every`, `rrule` and `cron` are passed through; daily/weekly are
 * expressed as an equivalent RRULE so the plugin depends on one less host shape.
 */
export declare function toHostTiming(input: TimingInput): HostTiming;
export declare function describeTiming(timing: TimingInput | HostTiming): string;
export interface CreateScheduleResult {
    scheduleId: string;
    entry: ScheduleRecordLike;
}
export declare class ScheduleAdapter {
    private readonly schedule;
    private readonly log?;
    constructor(schedule: ScheduleServiceLike | undefined, log?: {
        warn(...args: unknown[]): void;
    } | undefined);
    get available(): boolean;
    private require;
    create(input: {
        taskId: string;
        taskTitle: string;
        timing: TimingInput;
        sessionId: string;
    }): Promise<CreateScheduleResult>;
    update(input: {
        scheduleId: string;
        patch: {
            timing?: TimingInput;
            title?: string;
            prompt?: string;
            active?: boolean;
        };
        sessionId: string;
    }): Promise<ScheduleRecordLike>;
    remove(scheduleId: string, sessionId: string): Promise<{
        deleted: boolean;
        alreadyGone: boolean;
    }>;
    view(scheduleId: string): Promise<ScheduleRecordLike | undefined>;
    runNow(scheduleId: string): Promise<{
        pending: boolean;
        entry?: ScheduleRecordLike;
    }>;
    private wrap;
}
/** Loose staleness helper used by diagnostics (kept here to avoid cycles). */
export declare function scheduleLooksStale(scheduledAt: string | undefined, minutes: number): boolean;
