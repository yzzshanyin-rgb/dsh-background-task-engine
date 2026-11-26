/**
 * Read/write API for the in-app task board (1.2.0 §6).
 *
 * The board lives in the DSH Web/Desktop page, so it talks to the plugin over
 * the host's own `webServer` — the same channel dshmarket and dsh-context use.
 *
 * Two rules shape this file:
 *   - the session is the *only* authority: every query is filtered by the
 *     `session` the page supplies, and no endpoint lists sessions. A caller
 *     cannot reach another session's tasks by guessing a task id, because the
 *     repository's ownership check answers "not found" identically.
 *   - the board never computes state. Progress, health and "can resume" are
 *     produced by the services; the client only formats them.
 */

import type { HostContextLike } from '../host.js'
import { TaskEngineError, toErrorPayload } from '../errors.js'
import { HEALTH_LABELS, runHealth, type RunHealth, type RunHealthResult } from '../domain/state.js'
import { describeNextRun } from './schedule-adapter.js'
import type { TaskEngine } from './engine.js'
import type { RunRecord, RunStepRecord, ScheduleRef, TaskRecord, TaskStatus } from '../domain/records.js'

export const ROUTE_PREFIX = '/dsh-background-task/api'

interface WebServerLike {
  register(route: { kind: 'exact' | 'prefix'; path: string; handler: (req: any, res: any) => unknown }): () => void
}

export function registerUiRoutes(ctx: HostContextLike, engine: () => TaskEngine): void {
  const inject = (ctx as unknown as { inject?: (deps: string[], cb: (scoped: any) => void) => unknown }).inject
  if (typeof inject !== 'function') return
  inject.call(ctx, ['webServer'], (scoped: HostContextLike & { webServer?: WebServerLike }) => {
    const server = scoped.webServer
    if (!server || typeof server.register !== 'function') return
    const disposers: Array<() => void> = []
    const routes: Array<{ path: string; handler: (req: any, res: any) => Promise<void> }> = [
      { path: `${ROUTE_PREFIX}/status`, handler: statusRoute(engine) },
      { path: `${ROUTE_PREFIX}/tasks`, handler: tasksRoute(engine) },
      { path: `${ROUTE_PREFIX}/task`, handler: taskRoute(engine) },
      { path: `${ROUTE_PREFIX}/run`, handler: runRoute(engine) },
      { path: `${ROUTE_PREFIX}/action`, handler: actionRoute(engine) },
    ]
    for (const route of routes) {
      try {
        disposers.push(server.register({ kind: 'exact', path: route.path, handler: route.handler }))
      } catch (error) {
        ctx.logger?.warn?.(`[background-task-engine] 注册 UI 路由 ${route.path} 失败：${String(error)}`)
      }
    }
    scoped.effect?.(() => () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          // A route that is already gone needs no second removal.
        }
      }
    })
  })
}

// ---------------------------------------------------------------- routes

function statusRoute(engine: () => TaskEngine) {
  return async (req: any, res: any): Promise<void> => {
    await handle(res, async () => {
      const session = query(req).get('session') ?? ''
      const active = engine()
      const diagnostics = await active.diagnosticsFor(session)
      return {
        storageAvailable: diagnostics.storageAvailable,
        scheduleAvailable: diagnostics.scheduleAvailable,
        activeRunCount: diagnostics.activeRunCount,
        blockedRunCount: diagnostics.blockedRunCount,
        interruptedRunCount: diagnostics.interruptedRunCount,
        integrityStatus: diagnostics.integrityStatus,
        lastRecoveryScanAt: diagnostics.lastRecoveryScanAt ?? null,
        unsettledScheduleOps: diagnostics.unsettledScheduleOps,
        // The board routes are served by the host's local web server, which has no
        // per-request authentication: the session below is a data selector, not a
        // verified identity. Saying so in the payload keeps the UI honest.
        deploymentModel: 'local-single-user',
        sessionVerified: false,
      }
    })
  }
}

function tasksRoute(engine: () => TaskEngine) {
  return async (req: any, res: any): Promise<void> => {
    await handle(res, async () => {
      const q = query(req)
      const session = requireSession(q.get('session'))
      const active = engine()
      const status = q.get('status') as TaskStatus | null
      const page = active.taskService.list({
        sessionId: session,
        ...(status === null || !isTaskStatus(status) ? {} : { status }),
        ...(q.get('query') === null ? {} : { query: String(q.get('query')) }),
        limit: clampLimit(q.get('limit'), 20, 50),
        ...(q.get('cursor') === null ? {} : { cursor: String(q.get('cursor')) }),
      })
      const now = new Date()
      const items = page.items.map((row) => {
        const run = row.lastRun === null ? undefined : active.repository.getRun(row.lastRun.runId)
        const health = run === undefined ? null : healthOf(active, run, now).health
        return {
          taskId: row.taskId,
          title: row.title,
          status: row.status,
          revision: row.revision,
          stepCount: row.stepCount,
          updatedAt: row.updatedAt,
          trigger: row.schedule === null ? 'manual' : 'schedule',
          schedule: row.schedule,
          lastRun: row.lastRun === null ? null : { ...row.lastRun, health },
        }
      })
      return { items, nextCursor: page.nextCursor ?? null }
    })
  }
}

function taskRoute(engine: () => TaskEngine) {
  return async (req: any, res: any): Promise<void> => {
    await handle(res, async () => {
      const q = query(req)
      const session = requireSession(q.get('session'))
      const taskId = requireParam(q.get('taskId'), 'taskId')
      const active = engine()
      const detail = active.taskService.get(session, taskId, { includeRuns: true })
      const task = detail.task as TaskRecord
      const runs = detail.recentRuns
      const now = new Date()
      const schedule = task.scheduleRef === undefined ? null : await scheduleInfo(active, task.scheduleRef, session)
      return {
        task: {
          taskId: task.taskId,
          title: task.title,
          description: task.description ?? null,
          status: task.status,
          revision: task.revision,
          createdAt: task.createdAt,
          updatedAt: task.updatedAt,
          steps: task.steps.map((step) => ({
            stepId: step.stepId,
            order: step.order,
            title: step.title,
            required: step.required !== false,
            retryPolicy: step.retryPolicy ?? null,
          })),
        },
        schedule,
        operations: active.taskService.scheduleOperations(session, taskId).map((op) => ({
          operationId: op.operationId,
          action: op.action,
          status: op.status,
          lastError: op.lastError ?? null,
          createdAt: op.createdAt,
          updatedAt: op.updatedAt,
        })),
        runs: runs.slice(0, 20).map((run) => summarizeRun(active, run, now)),
      }
    })
  }
}

function runRoute(engine: () => TaskEngine) {
  return async (req: any, res: any): Promise<void> => {
    await handle(res, async () => {
      const q = query(req)
      const session = requireSession(q.get('session'))
      const runId = requireParam(q.get('runId'), 'runId')
      const active = engine()
      const run = active.repository.requireOwnedRun(runId, session)
      const steps = await active.runService.stepsOf(runId)
      return {
        run: summarizeRun(active, run, new Date()),
        steps: steps
          .slice()
          .sort((a, b) => a.order - b.order)
          .map((step) => stepView(step)),
        recovery: run.recoveryConfirmation ?? null,
      }
    })
  }
}

function actionRoute(engine: () => TaskEngine) {
  return async (req: any, res: any): Promise<void> => {
    await handle(res, async () => {
      if (req.method !== 'POST') throw new TaskEngineError('TASK_INVALID_ARGUMENTS', '该接口只接受 POST')
      const body = await readBody(req)
      const session = requireSession(typeof body.session === 'string' ? body.session : undefined)
      const taskId = requireParam(typeof body.taskId === 'string' ? body.taskId : undefined, 'taskId')
      const action = requireParam(typeof body.action === 'string' ? body.action : undefined, 'action')
      const expectedRevision = typeof body.expectedRevision === 'number' ? body.expectedRevision : undefined
      const active = engine()

      if (action === 'pause' || action === 'resume') {
        const result = await active.taskService.update({
          sessionId: session,
          taskId,
          expectedRevision: expectedRevision ?? active.taskService.get(session, taskId).task.revision,
          status: action === 'pause' ? 'paused' : 'active',
        })
        return { taskId: result.taskId, status: result.status, revision: result.revision }
      }
      if (action === 'archive') {
        const result = await active.taskService.archive({
          sessionId: session,
          taskId,
          expectedRevision: expectedRevision ?? active.taskService.get(session, taskId).task.revision,
        })
        return { taskId: result.taskId, status: result.status, revision: result.revision }
      }
      if (action === 'resume-run') {
        const runId = requireParam(typeof body.runId === 'string' ? body.runId : undefined, 'runId')
        const result = await active.runService.resume({
          sessionId: session,
          runId,
          confirmation: typeof body.confirmation === 'string' ? body.confirmation : undefined,
        })
        return { runId: result.run.runId, status: result.run.status, resumesRunId: result.run.resumesRunId ?? null }
      }
      throw new TaskEngineError('TASK_INVALID_ARGUMENTS', `未知操作 ${action}`)
    })
  }
}

// ------------------------------------------------------------- projections

function summarizeRun(engine: TaskEngine, run: RunRecord, now: Date) {
  const health = healthOf(engine, run, now)
  return {
    runId: run.runId,
    taskId: run.taskId,
    taskRevision: run.taskRevision,
    title: run.templateSnapshot?.title ?? '',
    status: run.status,
    triggerType: run.triggerType,
    progress: run.progress,
    requiredCompleted: run.requiredCompleted,
    requiredTotal: run.requiredTotal,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    finishedAt: run.finishedAt ?? null,
    lastHeartbeatAt: run.lastHeartbeatAt ?? null,
    leaseExpiresAt: run.leaseExpiresAt ?? null,
    staleDetectedAt: run.staleDetectedAt ?? null,
    summary: run.summary ?? null,
    error: run.error ?? null,
    failureCategory: run.failureCategory ?? null,
    needsUserConfirmation: run.needsUserConfirmation ?? false,
    resumesRunId: run.resumesRunId ?? null,
    executionGeneration: run.executionGeneration ?? null,
    health: health.health,
    healthLabel: health.label,
    healthReasons: health.reasons,
    resumable: health.resumable,
  }
}

function stepView(step: RunStepRecord) {
  return {
    stepId: step.stepId,
    order: step.order,
    title: step.title,
    required: step.required,
    status: step.status,
    attempt: step.attempt,
    startedAt: step.startedAt ?? null,
    finishedAt: step.finishedAt ?? null,
    summary: step.summary ?? null,
    error: step.error ?? null,
    failureCategory: step.failureCategory ?? null,
    retryPolicy: step.retryPolicy ?? null,
    carryOverFromRunId: step.carryOverFromRunId ?? null,
  }
}

function healthOf(engine: TaskEngine, run: RunRecord, now: Date): RunHealthResult & { label: string } {
  const health = runHealth(run, now, {
    timeoutMinutes: engine.config.defaultTimeoutMinutes.get(),
    staleMinutes: engine.config.staleRunAfterMinutes.get(),
  })
  return { ...health, label: HEALTH_LABELS[health.health] }
}

async function scheduleInfo(
  engine: TaskEngine,
  ref: ScheduleRef,
  session: string,
): Promise<Record<string, unknown>> {
  const adapter = engine.scheduleAdapter
  const live = adapter.available ? await adapter.view(ref.scheduleId).catch(() => undefined) : undefined
  return {
    scheduleId: ref.scheduleId,
    state: ref.state,
    timingKind: ref.timingKind,
    timing: ref.timing,
    nextRunAt: describeNextRun(ref.timing as never) ?? null,
    hostStatus: live === undefined ? (adapter.available ? 'missing' : 'unavailable') : String(live.status ?? ''),
    hostScheduledAt: live?.scheduledAt ?? null,
    lastError: ref.lastError ?? null,
    session,
  }
}

// --------------------------------------------------------------- plumbing

function query(req: any): URLSearchParams {
  const url = new URL(String(req.url ?? '/'), 'http://127.0.0.1')
  return url.searchParams
}

/** Session ids the host mints are opaque tokens; anything else is a bad request. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{6,128}$/

function requireSession(value: string | null | undefined): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TaskEngineError('TASK_PERMISSION_DENIED', '无法识别当前会话：请从 DSH 页面打开看板')
  }
  // SEC-05: a malformed selector must be rejected, not turned into a loose query
  // that could match an unintended owner.
  if (!SESSION_ID_PATTERN.test(value)) {
    throw new TaskEngineError(
      'TASK_INVALID_ARGUMENTS',
      '会话标识格式不合法：只接受宿主生成的字母数字标识',
    )
  }
  return value
}

function requireParam(value: string | null | undefined, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TaskEngineError('TASK_INVALID_ARGUMENTS', `缺少参数 ${field}`)
  }
  return value
}

function isTaskStatus(value: string): value is TaskStatus {
  return value === 'active' || value === 'paused' || value === 'archived'
}

function clampLimit(raw: string | null, fallback: number, max: number): number {
  const value = raw === null ? Number.NaN : Number(raw)
  if (!Number.isFinite(value)) return fallback
  const rounded = Math.floor(value)
  if (rounded < 1) return 1
  return rounded > max ? max : rounded
}

async function readBody(req: any): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    if (chunks.reduce((total, buffer) => total + buffer.length, 0) > 64 * 1024) {
      throw new TaskEngineError('TASK_INVALID_ARGUMENTS', '请求体过大')
    }
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new TaskEngineError('TASK_INVALID_ARGUMENTS', '请求体必须是 JSON 对象')
    }
    return parsed as Record<string, unknown>
  } catch (error) {
    if (error instanceof TaskEngineError) throw error
    throw new TaskEngineError('TASK_INVALID_ARGUMENTS', '请求体不是合法 JSON')
  }
}

async function handle(res: any, work: () => Promise<unknown>): Promise<void> {
  try {
    const value = await work()
    writeJson(res, 200, { success: true, ...(value as Record<string, unknown>) })
  } catch (error) {
    const payload = toErrorPayload(error)
    const status = payload.code === 'TASK_PERMISSION_DENIED' ? 403 : payload.code.endsWith('NOT_FOUND') ? 404 : 400
    writeJson(res, status, { success: false, error: payload })
  }
}

function writeJson(res: any, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.statusCode = status
  res.setHeader?.('content-type', 'application/json; charset=utf-8')
  res.setHeader?.('cache-control', 'no-store')
  res.setHeader?.('x-content-type-options', 'nosniff')
  res.end?.(text)
}
