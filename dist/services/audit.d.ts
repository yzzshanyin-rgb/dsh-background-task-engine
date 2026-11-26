/**
 * Audit trail (PRD 10.4, 12.3).
 *
 * Events are emitted on the Cordis event bus as `task.*` events and mirrored to
 * the host log as one structured JSON line. Only ids, states, timestamps and
 * source are logged — never step instructions, summaries or credentials.
 */
import type { HostContextLike, LoggerLike } from '../host.js';
import type { RunStatus, StepStatus, TaskStatus } from '../domain/records.js';
export type AuditEventName = 'task.created' | 'task.updated' | 'task.archived' | 'task.run.started' | 'task.step.changed' | 'task.run.finished' | 'task.schedule.changed' | 'task.run.resumed';
export interface AuditEvent {
    name: AuditEventName;
    taskId?: string;
    runId?: string;
    stepId?: string;
    from?: TaskStatus | RunStatus | StepStatus | string;
    to?: TaskStatus | RunStatus | StepStatus | string;
    sessionId?: string;
    source?: string;
    detail?: string;
}
export interface AuditRecord {
    eventName: AuditEventName;
    at: string;
    taskId?: string;
    runId?: string;
    stepId?: string;
    from?: string;
    to?: string;
    sessionId?: string;
    source?: string;
    detail?: string;
}
export declare class AuditTrail {
    private readonly ctx;
    private readonly logger?;
    constructor(ctx: HostContextLike, logger?: LoggerLike);
    record(event: AuditEvent): AuditRecord;
}
