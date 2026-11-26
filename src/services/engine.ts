/**
 * TaskEngine: composition root for the plugin (PRD 8.2, 8.4, FR-012, 1.2.0 §5).
 *
 * Startup sequence (all failures are explicit, never silent):
 *   1. open the StorageDomain declared in src/storage/spec.ts
 *   2. run idempotent migrations from the persisted ledger
 *   3. verify record integrity (runs reference tasks, steps belong to runs)
 *   4. reconcile schedule journals a previous process left open
 *   5. scan for stale runs — at startup a dead run becomes `interrupted`,
 *      while during a session it is only marked as suspected
 *   6. prune terminal runs older than `historyRetentionDays`
 *
 * If step 1 fails the `ready` promise rejects and every tool returns
 * TASK_STORAGE_ERROR — the plugin does not fall back to in-memory storage
 * (PRD 16.3).
 */

import { optionalService, type HostContextLike, type DomainLike, type ScheduleServiceLike } from '../host.js'
import { TaskEngineError } from '../errors.js'
import type { EngineConfig } from '../config.js'
import { SCHEMA_VERSION, globalStateSchema, runRecordSchema, runStepRecordSchema, taskRecordSchema } from '../domain/records.js'
import { Repository } from '../storage/repository.js'
import {
  MIGRATIONS,
  UNIT_NAME_PATTERN,
  createDomainSpec,
  runMigrations,
  verifyIntegrity,
  type IntegrityReport,
} from '../storage/spec.js'
import { AuditTrail } from './audit.js'
import { ScheduleAdapter } from './schedule-adapter.js'
import { ScheduleLedger } from './schedule-ledger.js'
import { TaskService } from './task-service.js'
import { RunService } from './run-service.js'
import { nowIso } from '../utils/time.js'

export type IntegrityStatus = 'ok' | 'issues' | 'unknown'

export interface EngineDiagnostics {
  storageAvailable: boolean
  scheduleAvailable: boolean
  activeRunCount: number
  blockedRunCount: number
  interruptedRunCount: number
  schemaVersion: number
  taskCount: number
  runCount: number
  lastRecoveryScanAt?: string
  lastPruneAt?: string
  lastScheduleReconcileAt?: string
  staleRunsInterrupted: number
  staleRunsSuspected: number
  unsettledScheduleOps: number
  integrityStatus: IntegrityStatus
  integrity: IntegrityReport | null
  migrations: { applied: string[]; skipped: string[] } | null
  lastError?: string
}

export class TaskEngine {
  readonly config: EngineConfig
  readonly ready: Promise<void>

  private domain?: DomainLike
  private repo?: Repository
  private audit?: AuditTrail
  private schedules?: ScheduleAdapter
  private ledger?: ScheduleLedger
  private tasks?: TaskService
  private runs?: RunService
  private initError?: TaskEngineError
  private disposed = false

  private readonly diagnostics: EngineDiagnostics = {
    storageAvailable: false,
    scheduleAvailable: false,
    activeRunCount: 0,
    blockedRunCount: 0,
    interruptedRunCount: 0,
    schemaVersion: SCHEMA_VERSION,
    taskCount: 0,
    runCount: 0,
    staleRunsInterrupted: 0,
    staleRunsSuspected: 0,
    unsettledScheduleOps: 0,
    integrityStatus: 'unknown',
    integrity: null,
    migrations: null,
  }

  constructor(
    private readonly ctx: HostContextLike,
    config: EngineConfig,
    private readonly now: () => string = nowIso,
  ) {
    this.config = config
    const schedule = optionalService<ScheduleServiceLike>(ctx, 'schedule')
    this.schedules = new ScheduleAdapter(schedule, { warn: (...args: unknown[]) => ctx.logger?.warn?.(...args) })
    this.diagnostics.scheduleAvailable = this.schedules.available
    this.ready = this.init()
  }

  private async init(): Promise<void> {
    const facility = this.ctx.storageDomain
    if (!facility || typeof facility.open !== 'function') {
      throw new TaskEngineError(
        'TASK_STORAGE_ERROR',
        '未挂载 ctx.storageDomain：dsh-background-task-engine 拒绝启动，也不会降级为内存存储。请确认宿主已启用 StorageDomain（base bundle 配置 storage-domain backend=json）。',
      )
    }
    try {
      const spec = createDomainSpec() as { name: string; tables: Record<string, unknown> }
      // Fail loudly before touching the backend if the declaration itself is
      // invalid for this host version (cheap, and names the exact field).
      for (const unitName of [spec.name, ...Object.keys(spec.tables)]) {
        if (!UNIT_NAME_PATTERN.test(unitName)) {
          throw new TaskEngineError(
            'TASK_STORAGE_ERROR',
            `存储单元名 ${unitName} 不合法：宿主要求 /^[a-z][a-z0-9_]*$/（不允许连字符）`,
          )
        }
      }
      const domain = await facility.open(spec)
      this.domain = domain
      this.repo = new Repository(domain, () => new Date(this.now()))
      this.audit = new AuditTrail(this.ctx, this.ctx.logger)
      this.ledger = new ScheduleLedger(this.repo, this.schedules!, this.audit, () => new Date(this.now()))
      this.tasks = new TaskService(this.repo, this.config, this.audit, this.schedules!, this.ledger, this.now)
      this.runs = new RunService(this.repo, this.config, this.audit, () => new Date(this.now()))

      this.diagnostics.migrations = await runMigrations(domain, MIGRATIONS, () => new Date(this.now()), (message) =>
        this.ctx.logger?.info?.(message),
      )
      const integrity = verifyIntegrity(domain)
      this.diagnostics.integrity = integrity
      this.diagnostics.integrityStatus = integrity.issues.length === 0 ? 'ok' : 'issues'
      this.diagnostics.storageAvailable = true
      this.diagnostics.taskCount = this.repo.listTasks().length
      this.diagnostics.runCount = this.repo.listRuns().length

      // Journals first: a half-finished schedule mutation changes what the
      // stale-run scan should consider recoverable, so settle them before it.
      const reconcile = await this.ledger.reconcile()
      this.diagnostics.lastScheduleReconcileAt = reconcile.checkedAt
      this.diagnostics.unsettledScheduleOps = reconcile.ambiguous
      if (reconcile.checked > 0) {
        this.ctx.logger?.info?.(
          `[background-task-engine] schedule reconcile: checked=${reconcile.checked} settled=${reconcile.settled} ambiguous=${reconcile.ambiguous} failed=${reconcile.failed}`,
        )
      }

      const recovery = await this.runs.scanStale({ startup: true })
      this.diagnostics.lastRecoveryScanAt = this.now()
      this.diagnostics.staleRunsInterrupted = recovery.interrupted
      this.diagnostics.staleRunsSuspected = recovery.suspected
      this.ctx.logger?.info?.(
        `[background-task-engine] startup scan: examined=${recovery.scanned} interrupted=${recovery.interrupted}`,
      )

      const pruned = await this.runs.prune()
      this.diagnostics.lastPruneAt = this.now()
      if (pruned.runsDeleted > 0 || pruned.stepsDeleted > 0) {
        this.ctx.logger?.info?.(
          `[background-task-engine] prune removed ${pruned.runsDeleted} runs / ${pruned.stepsDeleted} step records`,
        )
      }
      this.refreshCounters()
    } catch (error) {
      const taskError =
        error instanceof TaskEngineError ? error : new TaskEngineError('TASK_STORAGE_ERROR', `存储初始化失败：${error instanceof Error ? error.message : String(error)}`)
      this.initError = taskError
      this.diagnostics.lastError = taskError.message
      throw taskError
    }
  }

  /** Wait for startup to finish; throws a TaskEngineError when storage is unavailable. */
  async waitReady(): Promise<void> {
    await this.ready
  }

  get taskService(): TaskService {
    if (!this.tasks) {
      throw new TaskEngineError('TASK_STORAGE_ERROR', '插件尚未完成存储初始化，无法执行任务操作')
    }
    return this.tasks
  }

  get runService(): RunService {
    if (!this.runs) {
      throw new TaskEngineError('TASK_STORAGE_ERROR', '插件尚未完成存储初始化，无法执行运行操作')
    }
    return this.runs
  }

  /** TaskService may be used for schedule-only operations; storage must be ready. */
  get scheduleAdapter(): ScheduleAdapter {
    if (!this.schedules) throw new TaskEngineError('TASK_STORAGE_ERROR', '插件尚未初始化')
    return this.schedules
  }

  get repository(): Repository {
    if (!this.repo) throw new TaskEngineError('TASK_STORAGE_ERROR', '插件尚未完成存储初始化')
    return this.repo
  }

  get startupError(): TaskEngineError | undefined {
    return this.initError
  }

  /**
   * Diagnostics for one caller.
   *
   * Every number is read from the persisted tables at call time — never from a
   * cached snapshot — so a report can be trusted as "what the store says now".
   */
  async diagnosticsFor(sessionId: string): Promise<EngineDiagnostics> {
    if (!this.repo) {
      return { ...this.diagnostics, activeRunCount: 0, blockedRunCount: 0, interruptedRunCount: 0 }
    }
    const runs = this.repo.listRunsByOwner(sessionId)
    const activeRunCount = runs.filter((run) => run.status === 'queued' || run.status === 'running').length
    const blockedRunCount = runs.filter((run) => run.status === 'blocked').length
    const interruptedRunCount = runs.filter((run) => run.status === 'interrupted').length
    const unsettled = this.repo.listUnsettledScheduleOps().filter((op) => op.ownerSessionId === sessionId).length
    return {
      ...this.diagnostics,
      activeRunCount,
      blockedRunCount,
      interruptedRunCount,
      unsettledScheduleOps: unsettled,
    }
  }

  /** Re-verify integrity on demand (used by the status tool and the UI). */
  recheckIntegrity(): IntegrityReport | null {
    if (!this.domain) return null
    const report = verifyIntegrity(this.domain)
    this.diagnostics.integrity = report
    this.diagnostics.integrityStatus = report.issues.length === 0 ? 'ok' : 'issues'
    return report
  }

  /** Recompute the cached counters without touching persistence. */
  refreshCounters(): void {
    if (!this.repo) return
    this.diagnostics.taskCount = this.repo.listTasks().length
    this.diagnostics.runCount = this.repo.listRuns().length
    this.diagnostics.activeRunCount = this.repo.listActiveRuns().length
  }

  /** Release the domain handle. User data is never deleted. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    try {
      await this.domain?.close()
    } catch (error) {
      this.ctx.logger?.warn?.(`[background-task-engine] 关闭 StorageDomain 失败：${String(error)}`)
    }
    this.ctx.logger?.info?.('[background-task-engine] disposed (user data preserved)')
  }
}

/** Domain record schemas, re-exported for diagnostics and tests. */
export const domainSchemas = {
  tasks: taskRecordSchema,
  runs: runRecordSchema,
  steps: runStepRecordSchema,
  meta: globalStateSchema,
}
