/**
 * V1.2.0 reliability tests: the acceptance matrix in PRD §8 that cannot be
 * expressed through a single tool call — concurrency, idempotency races,
 * execution credentials, schedule journal reconciliation, migration of old
 * data and stable cursors.
 */

import { describe, expect, it, vi } from 'vitest'

import { createHarness, SESSION_A, SESSION_B, expectOk, errorCode, THREE_STEPS, type Harness } from '../helpers/harness.js'
import { FakeDomain, FakeDomainFacility, FakeSchedule } from '../helpers/fakes.js'
import { TaskEngine } from '../../src/services/engine.js'
import { configRefs, type EngineConfigValues } from '../../src/config.js'
import { createDomainSpec, META_KEY, runMigrations, verifyIntegrity } from '../../src/storage/spec.js'
import { MIGRATIONS } from '../../src/storage/spec.js'
import { SCHEMA_VERSION, TABLES } from '../../src/domain/records.js'

/** An engine wired to a durable fake domain, for tests that need internals. */
function buildEngine(config: Partial<EngineConfigValues> = {}): { engine: TaskEngine; domain: FakeDomain } {
  const facility = new FakeDomainFacility()
  const engine = new TaskEngine(
    {
      storageDomain: facility,
      schedule: new FakeSchedule(),
      emit: () => undefined,
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      inject: () => undefined,
      effect: () => undefined,
    },
    configRefs(config),
    () => new Date().toISOString(),
  )
  return { engine, domain: facility.domain! }
}

function threeSteps(): Array<{ title: string; instruction: string; completionCriteria: string }> {
  return THREE_STEPS.map((step) => ({ ...step }))
}

describe('idempotency under concurrency (PRD §2.1)', () => {
  it('turns 20 concurrent triggers on one key into a single run', async () => {
    const { engine } = buildEngine()
    await engine.ready
    const task = await engine.taskService.create({
      sessionId: SESSION_A,
      title: '并发巡检',
      steps: threeSteps(),
    })

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        engine.runService.start({ sessionId: SESSION_A, taskId: task.taskId, manualRunId: 'burst-1' }),
      ),
    )

    const runIds = new Set(results.map((result) => result.run.runId))
    expect(runIds.size).toBe(1)
    expect(engine.repository.listRuns()).toHaveLength(1)
    // Only the winner did work; the other 19 are marked deduplicated.
    expect(results.filter((result) => result.deduplicated).length).toBe(19)
  })

  it('gives a different key a different run, but still respects the per-task cap', async () => {
    const { engine } = buildEngine()
    await engine.ready
    const task = await engine.taskService.create({ sessionId: SESSION_A, title: '并发巡检', steps: threeSteps() })
    await engine.runService.start({ sessionId: SESSION_A, taskId: task.taskId, manualRunId: 'one' })

    await expect(
      engine.runService.start({ sessionId: SESSION_A, taskId: task.taskId, manualRunId: 'two' }),
    ).rejects.toMatchObject({ code: 'TASK_ALREADY_RUNNING' })
  })

  it('releases the reservation when creation fails, so a retry can succeed', async () => {
    const { engine, domain } = buildEngine()
    await engine.ready
    const task = await engine.taskService.create({ sessionId: SESSION_A, title: '并发巡检', steps: threeSteps() })

    // Break the run table for one attempt: the run cannot be written, but the
    // idempotency reservation was already taken.
    const runs = domain.table(TABLES.runs)
    const original = runs.put.bind(runs)
    ;(runs as unknown as { put: typeof runs.put }).put = async () => {
      throw new Error('磁盘写入失败')
    }
    await expect(
      engine.runService.start({ sessionId: SESSION_A, taskId: task.taskId, manualRunId: 'retry-1' }),
    ).rejects.toBeTruthy()
    ;(runs as unknown as { put: typeof original }).put = original

    const retried = await engine.runService.start({ sessionId: SESSION_A, taskId: task.taskId, manualRunId: 'retry-1' })
    expect(retried.deduplicated).toBe(false)
    expect(retried.run.status).toBe('running')
  })
})

describe('concurrency caps (PRD §2.2)', () => {
  it('enforces the session-wide cap and frees the slot when a run finishes', async () => {
    const { engine } = buildEngine({ maxActiveRunsPerOwner: 1 })
    await engine.ready
    const first = await engine.taskService.create({ sessionId: SESSION_A, title: '任务一', steps: threeSteps() })
    const second = await engine.taskService.create({ sessionId: SESSION_A, title: '任务二', steps: threeSteps() })

    const run = await engine.runService.start({ sessionId: SESSION_A, taskId: first.taskId })
    await expect(engine.runService.start({ sessionId: SESSION_A, taskId: second.taskId })).rejects.toMatchObject({
      code: 'TASK_MAX_CONCURRENCY',
    })

    for (const step of run.steps) {
      await engine.runService.reportStep({
        sessionId: SESSION_A, runId: run.run.runId, stepId: step.stepId, action: 'started',
      })
      await engine.runService.reportStep({
        sessionId: SESSION_A, runId: run.run.runId, stepId: step.stepId, action: 'completed', summary: '完成',
      })
    }
    await engine.runService.finish({ sessionId: SESSION_A, runId: run.run.runId, status: 'succeeded', summary: '完成' })

    // The finished run released its slot.
    await expect(engine.runService.start({ sessionId: SESSION_A, taskId: second.taskId })).resolves.toBeTruthy()
  })

  it('counts runs per owner, not globally', async () => {
    const { engine } = buildEngine({ maxActiveRunsPerOwner: 1 })
    await engine.ready
    const mine = await engine.taskService.create({ sessionId: SESSION_A, title: '我的任务', steps: threeSteps() })
    const other = await engine.taskService.create({ sessionId: SESSION_B, title: '别人的任务', steps: threeSteps() })

    await engine.runService.start({ sessionId: SESSION_A, taskId: mine.taskId })
    // SESSION_B has its own budget, but cannot start SESSION_A's task.
    await expect(engine.runService.start({ sessionId: SESSION_B, taskId: other.taskId })).resolves.toBeTruthy()
    await expect(engine.runService.start({ sessionId: SESSION_B, taskId: mine.taskId })).rejects.toMatchObject({
      code: 'TASK_NOT_FOUND',
    })
  })
})

describe('execution credentials (PRD §3.2)', () => {
  it('accepts a heartbeat from the holder and rejects a foreign token', async () => {
    const { engine, domain } = buildEngine()
    await engine.ready
    const task = await engine.taskService.create({ sessionId: SESSION_A, title: '心跳', steps: threeSteps() })
    const started = await engine.runService.start({ sessionId: SESSION_A, taskId: task.taskId })
    const token = domain.table<Record<string, unknown>>(TABLES.runs).get(started.run.runId)!.executionToken as string
    expect(token).toMatch(/^exec_/)

    await new Promise((resolve) => setTimeout(resolve, 5))
    const beat = await engine.runService.heartbeat({
      sessionId: SESSION_A, runId: started.run.runId, executionToken: token, note: '仍在执行',
    })
    expect(beat.accepted).toBe(true)
    expect(beat.run.lastHeartbeatAt).not.toBe(started.run.lastHeartbeatAt)
    expect(Date.parse(beat.leaseExpiresAt)).toBeGreaterThan(Date.now())

    await expect(
      engine.runService.heartbeat({ sessionId: SESSION_A, runId: started.run.runId, executionToken: 'exec_forged' }),
    ).rejects.toMatchObject({ code: 'TASK_RUN_INTERRUPTED' })
  })

  it('refuses reports from the previous generation after a resume', async () => {
    const { engine, domain } = buildEngine()
    await engine.ready
    const task = await engine.taskService.create({ sessionId: SESSION_A, title: '代际', steps: threeSteps() })
    const started = await engine.runService.start({ sessionId: SESSION_A, taskId: task.taskId })
    const oldToken = domain.table<Record<string, unknown>>(TABLES.runs).get(started.run.runId)!.executionToken as string

    await engine.runService.reportStep({
      sessionId: SESSION_A, runId: started.run.runId, stepId: started.steps[0]!.stepId, action: 'failed',
      error: { code: 'BOOM', message: '工具失败' },
    })
    await engine.runService.finish({ sessionId: SESSION_A, runId: started.run.runId, status: 'failed', summary: '失败' })

    const resumed = await engine.runService.resume({
      sessionId: SESSION_A, runId: started.run.runId, confirmation: '已确认旧执行终止',
    })
    const newToken = domain.table<Record<string, unknown>>(TABLES.runs).get(resumed.run.runId)!.executionToken as string
    expect(newToken).not.toBe(oldToken)
    expect(resumed.run.resumesRunId).toBe(started.run.runId)
    expect(resumed.run.executionGeneration).toBe(2)

    await expect(
      engine.runService.reportStep({
        sessionId: SESSION_A, runId: resumed.run.runId, stepId: resumed.steps[0]!.stepId,
        action: 'started', executionToken: oldToken,
      }),
    ).rejects.toMatchObject({ code: 'TASK_RUN_INTERRUPTED' })
  })

  it('marks a silent run as suspected before interrupting it', async () => {
    const { engine, domain } = buildEngine({ staleRunAfterMinutes: 1 })
    await engine.ready
    const task = await engine.taskService.create({ sessionId: SESSION_A, title: '失联', steps: threeSteps() })
    const started = await engine.runService.start({ sessionId: SESSION_A, taskId: task.taskId })

    const staleAt = new Date(Date.now() - 10 * 60_000).toISOString()
    const runs = domain.table<Record<string, unknown>>(TABLES.runs)
    runs.seed(started.run.runId, { ...runs.get(started.run.runId)!, lastHeartbeatAt: staleAt, leaseExpiresAt: staleAt })

    // A periodic scan only flags it; nothing is replayed or cancelled on a guess.
    const flagged = await engine.runService.scanStale({ startup: false })
    expect(flagged.suspected).toBe(1)
    expect(engine.repository.getRun(started.run.runId)!.status).toBe('running')
    expect(engine.repository.getRun(started.run.runId)!.staleDetectedAt).toBeTruthy()

    const interrupted = await engine.runService.scanStale({ startup: true })
    expect(interrupted.interrupted).toBe(1)
    const row = engine.repository.getRun(started.run.runId)!
    expect(row.status).toBe('interrupted')
    expect(row.needsUserConfirmation).toBe(true)
    // Interruption never starts a replacement run by itself.
    expect(engine.repository.listRuns()).toHaveLength(1)
  })
})

describe('run summary repair (PRD §2.3)', () => {
  it('recomputes a cached progress that drifted from the steps', async () => {
    const { engine, domain } = buildEngine()
    await engine.ready
    const task = await engine.taskService.create({ sessionId: SESSION_A, title: '漂移', steps: threeSteps() })
    const started = await engine.runService.start({ sessionId: SESSION_A, taskId: task.taskId })
    await engine.runService.reportStep({
      sessionId: SESSION_A, runId: started.run.runId, stepId: started.steps[0]!.stepId, action: 'started',
    })
    await engine.runService.reportStep({
      sessionId: SESSION_A, runId: started.run.runId, stepId: started.steps[0]!.stepId, action: 'completed', summary: '完成',
    })

    // Simulate the crash window: the step write landed, the run summary did not.
    const runs = domain.table<Record<string, unknown>>(TABLES.runs)
    runs.seed(started.run.runId, { ...runs.get(started.run.runId)!, progress: 0, requiredCompleted: 0 })
    const report = verifyIntegrity(domain as never)
    expect(report.issues.map((issue) => issue.kind)).toContain('progress-drift')

    const repaired = await engine.runService.reconcileRun(started.run.runId)
    expect(repaired.repaired).toBe(true)
    expect(repaired.run.progress).toBe(33)
    expect(repaired.run.requiredCompleted).toBe(1)
    expect(verifyIntegrity(domain as never).issues.map((issue) => issue.kind)).not.toContain('progress-drift')
  })
})

describe('schedule journal (PRD §4)', () => {
  it('reconciles a host rule when the task write failed after creation', async () => {
    const { engine } = buildEngine()
    await engine.ready
    const task = await engine.taskService.create({ sessionId: SESSION_A, title: '定时巡检', steps: threeSteps() })
    vi.spyOn(engine.repository, 'mutateTask').mockRejectedValueOnce(new Error('本地写入失败'))

    const input = { sessionId: SESSION_A, taskId: task.taskId, timing: { kind: 'every' as const, everySeconds: 3600 } }
    await expect(engine.taskService.scheduleCreate(input)).rejects.toThrow('本地写入失败')
    await expect(engine.taskService.scheduleCreate(input)).rejects.toMatchObject({ code: 'TASK_SCHEDULE_FAILED' })
    expect(engine.taskService.scheduleOperations(SESSION_A, task.taskId)[0]?.status).toBe('failed')
    expect(engine.repository.getTask(task.taskId)?.scheduleRef).toBeUndefined()

    await expect(engine.taskService.reconcileSchedules()).resolves.toMatchObject({ checked: 1, settled: 1 })
    expect(engine.repository.getTask(task.taskId)?.scheduleRef).toMatchObject({ timingKind: 'every' })
  })

  it('keeps a delete pending until the host removes the rule and the local reference is cleared', async () => {
    const { engine } = buildEngine()
    await engine.ready
    const task = await engine.taskService.create({ sessionId: SESSION_A, title: '定时巡检', steps: threeSteps() })
    const input = { sessionId: SESSION_A, taskId: task.taskId }
    await engine.taskService.scheduleCreate({ ...input, timing: { kind: 'every', everySeconds: 3600 } })
    vi.spyOn(engine.scheduleAdapter, 'remove').mockRejectedValueOnce(new Error('宿主暂时不可用'))
      .mockRejectedValueOnce(new Error('宿主仍不可用'))

    await expect(engine.taskService.scheduleDelete(input)).rejects.toThrow('宿主暂时不可用')
    await expect(engine.taskService.reconcileSchedules()).resolves.toMatchObject({ settled: 0, ambiguous: 1 })
    expect(engine.repository.getTask(task.taskId)?.scheduleRef).toBeDefined()
    await expect(engine.taskService.reconcileSchedules()).resolves.toMatchObject({ settled: 1, ambiguous: 0 })
    expect(engine.repository.getTask(task.taskId)?.scheduleRef).toBeUndefined()
  })

  it('creates just one host rule when requests overlap', async () => {
    const { engine } = buildEngine()
    await engine.ready
    const task = await engine.taskService.create({ sessionId: SESSION_A, title: '定时巡检', steps: threeSteps() })
    const create = vi.spyOn(engine.scheduleAdapter, 'create')
    const input = { sessionId: SESSION_A, taskId: task.taskId, timing: { kind: 'every' as const, everySeconds: 3600 } }
    const results = await Promise.allSettled([engine.taskService.scheduleCreate(input), engine.taskService.scheduleCreate(input)])
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected'])
    expect(create).toHaveBeenCalledTimes(1)
  })
})

describe('migration of v1 data (PRD §7)', () => {
  it('adds liveness defaults without touching status and rebuilds indexes', async () => {
    const facility = new FakeDomainFacility()
    const domain = await facility.open(createDomainSpec() as never)
    const old = '2026-11-20T00:00:00.000Z'

    // A v1-shaped task and run: no executionGeneration, no heartbeat, no index.
    await domain.table(TABLES.tasks).put('tsk_old00000000000000001', {
      taskId: 'tsk_old00000000000000001',
      title: '旧任务',
      status: 'active',
      revision: 1,
      ownerSessionId: SESSION_A,
      steps: [{ stepId: 'stp_1', title: '一步', instruction: '做', order: 1, required: true }],
      createdAt: old,
      updatedAt: old,
      schemaVersion: 1,
    } as never)
    await domain.table(TABLES.runs).put('run_old00000000000000001', {
      runId: 'run_old00000000000000001',
      taskId: 'tsk_old00000000000000001',
      taskRevision: 1,
      taskOwnerSessionId: SESSION_A,
      sessionId: SESSION_A,
      status: 'failed',
      triggerType: 'manual',
      progress: 0,
      requiredTotal: 1,
      requiredCompleted: 0,
      totalSteps: 1,
      startedAt: old,
      updatedAt: old,
      finishedAt: old,
      error: { code: 'OLD', message: '旧失败' },
      templateSnapshot: {
        revision: 1,
        title: '旧任务',
        steps: [{ stepId: 'stp_1', title: '一步', instruction: '做', order: 1, required: true }],
      },
      schemaVersion: 1,
    } as never)
    await domain.table(TABLES.steps).put('run_old00000000000000001/stp_1', {
      runId: 'run_old00000000000000001',
      stepId: 'stp_1',
      taskId: 'tsk_old00000000000000001',
      order: 1,
      title: '一步',
      required: true,
      status: 'failed',
      attempt: 1,
      finishedAt: old,
      updatedAt: old,
    } as never)
    await domain.table(TABLES.meta).put(META_KEY, { schemaVersion: 1, appliedMigrations: {} } as never)

    await runMigrations(domain as never, MIGRATIONS, () => new Date())

    const run = await domain.table<Record<string, unknown>>(TABLES.runs).get('run_old00000000000000001')!
    expect(run.schemaVersion).toBe(SCHEMA_VERSION)
    expect(run.status).toBe('failed') // never re-labelled as interrupted
    expect(run.executionGeneration).toBe(1)
    expect(run.lastHeartbeatAt).toBe(old)
    expect(run.leaseExpiresAt).toBeUndefined() // no lease invented for old runs
    const step = await domain.table<Record<string, unknown>>(TABLES.steps).get('run_old00000000000000001/stp_1')!
    expect(step.retryPolicy).toBe('verify_before_retry')

    // The rebuilt index makes old runs visible to keyset pagination.
    const index = [...domain.table<Record<string, unknown>>(TABLES.runIndex).entries()]
    expect(index.length).toBe(1)

    // Re-running is a no-op.
    const again = await runMigrations(domain as never, MIGRATIONS, () => new Date())
    expect(again.applied).toEqual([])
  })
})

describe('stable history cursors (PRD §7.1)', () => {
  it('pages runs sharing one timestamp without duplicates or gaps', async () => {
    const { engine, domain } = buildEngine()
    await engine.ready
    const task = await engine.taskService.create({ sessionId: SESSION_A, title: '大量历史', steps: threeSteps() })
    const sameInstant = '2026-11-20T00:00:00.000Z'
    const runs = domain.table<Record<string, unknown>>(TABLES.runs)

    for (let index = 0; index < 30; index += 1) {
      const runId = `run_seed${String(index).padStart(16, '0')}`
      runs.seed(runId, {
        runId,
        taskId: task.taskId,
        taskRevision: 1,
        taskOwnerSessionId: SESSION_A,
        sessionId: SESSION_A,
        status: 'succeeded',
        triggerType: 'manual',
        progress: 100,
        requiredTotal: 3,
        requiredCompleted: 3,
        totalSteps: 3,
        startedAt: sameInstant,
        updatedAt: sameInstant,
        finishedAt: sameInstant,
        templateSnapshot: { revision: 1, title: '大量历史', steps: task.steps },
        schemaVersion: SCHEMA_VERSION,
      })
      domain.table(TABLES.runIndex).seed(`${task.taskId}/${sameInstant}/${runId}`, {
        runId,
        taskId: task.taskId,
        ownerSessionId: SESSION_A,
        status: 'succeeded',
        startedAt: sameInstant,
      })
    }

    const seen: string[] = []
    let cursor: string | undefined
    for (let page = 0; page < 10; page += 1) {
      const result = await engine.runService.history({ sessionId: SESSION_A, taskId: task.taskId, limit: 7, cursor })
      seen.push(...result.rows.map((row) => row.runId))
      if (result.nextCursor === undefined) break
      cursor = result.nextCursor
    }

    expect(new Set(seen).size).toBe(seen.length)
    expect(seen).toHaveLength(30)
  })
})

describe('pruning never touches live work (PRD §7.2)', () => {
  it('keeps active runs and their steps while removing old terminal ones', async () => {
    const { engine } = buildEngine({ historyRetentionDays: 1 })
    await engine.ready
    const task = await engine.taskService.create({ sessionId: SESSION_A, title: '清理', steps: threeSteps() })
    const live = await engine.runService.start({ sessionId: SESSION_A, taskId: task.taskId })

    const pruned = await engine.runService.prune()
    expect(pruned.runsDeleted).toBe(0)
    expect(engine.repository.getRun(live.run.runId)).toBeDefined()
    expect(engine.repository.listSteps(live.run.runId)).toHaveLength(3)
  })
})

describe('tool surface still respects isolation', () => {
  it('never exposes another session task through the engine status', async () => {
    const harness: Harness = createHarness()
    const task = expectOk(await harness.call('task_create', SESSION_A, { title: '隔离任务', steps: threeSteps() }))
    const status = expectOk(await harness.call('task_engine_status', SESSION_B, {}))
    expect(status.activeRunCount).toBe(0)
    expect(status.taskCount).toBe(0)
    expect(errorCode(await harness.call('task_get', SESSION_B, { taskId: task.taskId }))).toBe('TASK_NOT_FOUND')
  })
})


describe('run and task consistency', () => {
  it('enforces the owner limit across simultaneous starts for different tasks', async () => {
    const { engine } = buildEngine({ maxActiveRunsPerOwner: 1 })
    await engine.ready
    const tasks = await Promise.all(['任务甲', '任务乙'].map((title) =>
      engine.taskService.create({ sessionId: SESSION_A, title, steps: threeSteps() }),
    ))
    const starts = await Promise.allSettled(tasks.map(({ taskId }) =>
      engine.runService.start({ sessionId: SESSION_A, taskId }),
    ))
    expect(starts[0]?.status).toBe('fulfilled')
    expect(starts[1]).toMatchObject({ status: 'rejected', reason: { code: 'TASK_MAX_CONCURRENCY' } })
    expect(engine.repository.listActiveRuns()).toHaveLength(1)
  })

  it('rolls back a failed history-index write and allows retry with the same key', async () => {
    const { engine } = buildEngine()
    await engine.ready
    const task = await engine.taskService.create({ sessionId: SESSION_A, title: '索引巡检', steps: threeSteps() })
    const input = { sessionId: SESSION_A, taskId: task.taskId, manualRunId: 'retry' }
    vi.spyOn(engine.repository, 'putRunIndex').mockRejectedValueOnce(new Error('索引写入失败'))
    await expect(engine.runService.start(input)).rejects.toThrow('索引写入失败')
    expect(engine.repository.listRuns()).toHaveLength(0)
    expect(engine.repository.listActiveRuns()).toHaveLength(0)
    expect([...engine.repository.steps.entries()]).toHaveLength(0)
    await expect(engine.runService.start(input)).resolves.toMatchObject({ deduplicated: false })
  })

  it('filters history by the stored run state even when an older index is stale', async () => {
    const { engine } = buildEngine()
    await engine.ready
    const task = await engine.taskService.create({ sessionId: SESSION_A, title: '历史巡检', steps: threeSteps() })
    const input = { sessionId: SESSION_A, taskId: task.taskId }
    const { run } = await engine.runService.start({ ...input, defer: true })
    await engine.runService.begin({ sessionId: SESSION_A, runId: run.runId })
    expect([...engine.repository.runIndex.entries()][0]?.[1].status).toBe('running')
    await engine.repository.putRunIndex(run)
    expect(engine.runService.history({ ...input, status: 'queued' }).rows).toHaveLength(0)
    expect(engine.runService.history({ ...input, status: 'running' }).rows).toMatchObject([{ runId: run.runId }])
  })

  it('returns the newest five runs and ignores malformed task-list cursors', async () => {
    const { engine } = buildEngine()
    await engine.ready
    const task = await engine.taskService.create({ sessionId: SESSION_A, title: '历史巡检', steps: threeSteps() })
    for (let index = 0; index < 6; index += 1) {
      const { run } = await engine.runService.start({ sessionId: SESSION_A, taskId: task.taskId, defer: true })
      await engine.runService.finish({ sessionId: SESSION_A, runId: run.runId, status: 'skipped' })
    }
    const expected = engine.runService.history({ sessionId: SESSION_A, taskId: task.taskId, limit: 5 }).rows
    expect(engine.taskService.get(SESSION_A, task.taskId).recentRuns.map(({ runId }) => runId)).toEqual(expected.map(({ runId }) => runId))
    const cursor = Buffer.from('{}').toString('base64url')
    expect(engine.taskService.list({ sessionId: SESSION_A, cursor }).items).toMatchObject([{ taskId: task.taskId }])
  })
})
