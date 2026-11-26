/**
 * Audit trail (PRD 10.4, 12.3).
 *
 * Events are emitted on the Cordis event bus as `task.*` events and mirrored to
 * the host log as one structured JSON line. Only ids, states, timestamps and
 * source are logged — never step instructions, summaries or credentials.
 */

import type { HostContextLike, LoggerLike } from '../host.js'
import type { RunStatus, StepStatus, TaskStatus } from '../domain/records.js'
import { nowIso } from '../utils/time.js'

export type AuditEventName =
  | 'task.created'
  | 'task.updated'
  | 'task.archived'
  | 'task.run.started'
  | 'task.step.changed'
  | 'task.run.finished'
  | 'task.schedule.changed'
  | 'task.run.resumed'

export interface AuditEvent {
  name: AuditEventName
  taskId?: string
  runId?: string
  stepId?: string
  from?: TaskStatus | RunStatus | StepStatus | string
  to?: TaskStatus | RunStatus | StepStatus | string
  sessionId?: string
  source?: string
  detail?: string
}

export interface AuditRecord {
  eventName: AuditEventName
  at: string
  taskId?: string
  runId?: string
  stepId?: string
  from?: string
  to?: string
  sessionId?: string
  source?: string
  detail?: string
}

export class AuditTrail {
  private readonly logger?: LoggerLike

  constructor(
    private readonly ctx: HostContextLike,
    logger?: LoggerLike,
  ) {
    this.logger = logger ?? ctx.logger
  }

  record(event: AuditEvent): AuditRecord {
    const record: AuditRecord = { eventName: event.name, at: nowIso() }
    if (event.taskId) record.taskId = event.taskId
    if (event.runId) record.runId = event.runId
    if (event.stepId) record.stepId = event.stepId
    if (event.from !== undefined) record.from = String(event.from)
    if (event.to !== undefined) record.to = String(event.to)
    if (event.sessionId) record.sessionId = event.sessionId
    if (event.source) record.source = event.source
    if (event.detail) record.detail = event.detail

    try {
      this.ctx.emit?.(event.name, record)
    } catch {
      /* audit must never break a state transition */
    }
    try {
      this.logger?.info(`[background-task-engine] ${JSON.stringify(record)}`)
    } catch {
      /* logging failures are non-fatal */
    }
    return record
  }
}
