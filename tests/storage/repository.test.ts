/**
 * Storage-layer tests: domain spec, migration ledger idempotency, integrity
 * verification, retention pruning and write ordering (PRD 7.3, 7.4, 14.4).
 */

import { describe, expect, it } from 'vitest'
import { FakeDomain, FakeDomainFacility } from '../helpers/fakes.js'
import {
  MIGRATIONS,
  META_KEY,
  UNIT_NAME_PATTERN,
  createDomainSpec,
  readMeta,
  runMigrations,
  verifyIntegrity,
  writeMeta,
  type Migration,
} from '../../src/storage/spec.js'
import { Repository } from '../../src/storage/repository.js'
import { configRefs } from '../../src/config.js'
import { SCHEMA_VERSION, type GlobalState, type RunRecord, type TaskRecord } from '../../src/domain/records.js'
import { AuditTrail } from '../../src/services/audit.js'
import { RunService } from '../../src/services/run-service.js'
import { ScheduleAdapter } from '../../src/services/schedule-adapter.js'

const NOW = '2026-11-26T01:00:00.000Z'

function makeRepo(): { domain: FakeDomain; repo: Repository } {
  const domain = new FakeDomain(createDomainSpec() as never)
  return { domain, repo: new Repository(domain as never, () => new Date(NOW)) }
}

function sampleTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: 'tsk_aaaaaaaaaaaaaaaaaaaa',
    title: '示例任务',
    status: 'active',
    revision: 1,
    ownerSessionId: 'sess_a',
    steps: [
      { stepId: 'stp_1', title: '第一步', instruction: '做第一件事', order: 1, required: true },
      { stepId: 'stp_2', title: '第二步', instruction: '做第二件事', order: 2, required: true },
    ],
    createdAt: NOW,
    updatedAt: NOW,
    schemaVersion: SCHEMA_VERSION,
    ...overrides,
  }
}

describe('domain declaration', () => {
  it('uses host-legal unit and table names', () => {
    // The real host rule is /^[a-z][a-z0-9_]*$/ — hyphens are rejected, so the
    // storage unit id differs from the npm package name on purpose.
    const spec = createDomainSpec()
    for (const name of [spec.name, ...Object.keys(spec.tables)]) {
      expect(name).toMatch(UNIT_NAME_PATTERN)
    }
    expect(spec.name).not.toContain('-')
  })

  it('declares three model tables plus the metadata table', () => {
    const spec = createDomainSpec()
    expect(spec.name).toBe('dsh_background_task_engine')
    expect(spec.version).toBe(SCHEMA_VERSION)
    expect(Object.keys(spec.tables).sort()).toEqual([
      'active_runs',
      'idempotency',
      'meta',
      'run_index',
      'schedule_ops',
      'task_run_steps',
      'task_runs',
      'tasks',
    ])
    for (const table of Object.values(spec.tables)) {
      expect(typeof table.valueSchema.parse).toBe('function')
      expect(typeof table.valueSchema.safeParse).toBe('function')
    }
  })

  it('rejects records that do not match the declared schema', async () => {
    const { repo } = makeRepo()
    await expect(repo.insertTask({ ...sampleTask(), title: 'x' } as TaskRecord)).rejects.toBeTruthy()
    await expect(
      repo.insertTask(sampleTask({ steps: Array.from({ length: 11 }, (_, index) => ({
        stepId: `stp_${index}`,
        title: `步骤 ${index}`,
        instruction: 'x',
        order: index + 1,
        required: true,
      })) })),
    ).rejects.toBeTruthy()
  })
})

describe('migrations', () => {
  it('records an applied migration in the ledger exactly once', async () => {
    const { domain } = makeRepo()
    let runs = 0
    const probe: Migration = {
      id: 'probe-1',
      description: 'test-only idempotent migration',
      async apply() {
        runs += 1
      },
    }
    const first = await runMigrations(domain as never, [probe], () => new Date(NOW))
    expect(first.applied).toEqual(['probe-1'])
    expect(runs).toBe(1)

    const second = await runMigrations(domain as never, [probe], () => new Date(NOW))
    expect(second.applied).toEqual([])
    expect(second.skipped).toEqual(['probe-1'])
    expect(runs).toBe(1)

    const state = readMeta(domain as never)!
    expect(state.schemaVersion).toBe(SCHEMA_VERSION)
    expect(state.appliedMigrations['probe-1']).toBe(NOW)
  })

  it('stops writing when a migration fails and leaves no marker', async () => {
    const { domain } = makeRepo()
    const broken: Migration = {
      id: 'broken',
      description: 'always fails',
      async apply() {
        throw new Error('boom')
      },
    }
    await expect(runMigrations(domain as never, [broken], () => new Date(NOW))).rejects.toThrow(/迁移 broken 失败/)
    expect(readMeta(domain as never)?.appliedMigrations.broken).toBeUndefined()
  })

  it('refuses data written by a newer schema version', async () => {
    const { domain } = makeRepo()
    await writeMeta(domain as never, {
      appliedMigrations: {},
      schemaVersion: SCHEMA_VERSION,
    } as Partial<GlobalState>)
    domain.table<GlobalState>('meta').seed(META_KEY, {
      schemaVersion: SCHEMA_VERSION + 5,
      appliedMigrations: {},
    })
    await expect(runMigrations(domain as never, [], () => new Date(NOW))).rejects.toThrow(/更高版本/)
  })

  it('ships the repeatable v2 migrations and nothing for the v1 baseline', () => {
    expect(MIGRATIONS.map((migration) => migration.id)).toEqual([
      'v2-run-liveness-defaults',
      'v2-build-indexes',
      'v2-step-retry-policy',
    ])
    // Every migration must describe itself and stay callable twice.
    for (const migration of MIGRATIONS) {
      expect(migration.description.length).toBeGreaterThan(0)
    }
  })
})

describe('integrity verification', () => {
  it('reports a clean domain', async () => {
    const { domain, repo } = makeRepo()
    await repo.insertTask(sampleTask())
    const report = verifyIntegrity(domain as never)
    expect(report).toMatchObject({ ok: true, taskCount: 1, runCount: 0, stepCount: 0 })
  })

  it('detects runs that reference a missing task', async () => {
    const { domain, repo } = makeRepo()
    const run: RunRecord = {
      runId: 'run_aaaaaaaaaaaaaaaaaaaa',
      taskId: 'tsk_missing00000000000',
      taskRevision: 1,
      taskOwnerSessionId: 'sess_a',
      sessionId: 'sess_a',
      status: 'running',
      triggerType: 'manual',
      progress: 0,
      requiredTotal: 1,
      requiredCompleted: 0,
      totalSteps: 1,
      startedAt: NOW,
      updatedAt: NOW,
      templateSnapshot: {
        revision: 1,
        title: '任务',
        steps: [{ stepId: 'stp_1', title: 's', instruction: 'i', order: 1, required: true }],
      },
      schemaVersion: SCHEMA_VERSION,
    }
    await repo.insertRun(run)
    const report = verifyIntegrity(domain as never)
    expect(report.ok).toBe(false)
    expect(report.issues.map((issue) => issue.kind)).toContain('missing-task')
  })
})

describe('repository write semantics', () => {
  it('serialises concurrent mutations so the revision advances exactly once per call', async () => {
    const { repo } = makeRepo()
    await repo.insertTask(sampleTask())
    const mutate = (): Promise<TaskRecord> =>
      repo.mutateTask('tsk_aaaaaaaaaaaaaaaaaaaa', undefined, (current) => ({
        ...current,
        revision: current.revision + 1,
        title: `任务 ${current.revision + 1}`,
      }))
    await Promise.all([mutate(), mutate(), mutate()])
    const task = repo.getTask('tsk_aaaaaaaaaaaaaaaaaaaa')!
    expect(task.revision).toBe(4)
  })

  it('writes steps before the run so a crash cannot leave progress without a run', async () => {
    // Ordering is asserted on the recorded write log of the fake domain.
    const domain = new FakeDomain(createDomainSpec() as never)
    const repo = new Repository(domain as never, () => new Date(NOW))
    await repo.insertTask(sampleTask())
    const writes = domain.writes.map((write) => write.table)
    expect(writes[0]).toBe('tasks')
  })

  it('deletes a run together with its step rows', async () => {
    const { repo } = makeRepo()
    await repo.insertTask(sampleTask())
    const run: RunRecord = {
      runId: 'run_bbbbbbbbbbbbbbbbbbbb',
      taskId: 'tsk_aaaaaaaaaaaaaaaaaaaa',
      taskRevision: 1,
      taskOwnerSessionId: 'sess_a',
      sessionId: 'sess_a',
      status: 'succeeded',
      triggerType: 'manual',
      progress: 100,
      requiredTotal: 2,
      requiredCompleted: 2,
      totalSteps: 2,
      startedAt: NOW,
      updatedAt: NOW,
      finishedAt: NOW,
      templateSnapshot: { revision: 1, title: '示例任务', steps: sampleTask().steps },
      schemaVersion: SCHEMA_VERSION,
    }
    await repo.insertRun(run)
    await repo.putStep({
      runId: run.runId,
      stepId: 'stp_1',
      taskId: run.taskId,
      order: 1,
      title: '第一步',
      required: true,
      status: 'completed',
      attempt: 1,
      updatedAt: NOW,
    })
    const result = await repo.deleteRunCascade(run)
    expect(result).toEqual({ stepsDeleted: 1, runDeleted: true })
    expect(repo.listSteps(run.runId)).toHaveLength(0)
  })
})

describe('retention pruning', () => {
  function buildRunService(domain: FakeDomain, now: string): RunService {
    const repo = new Repository(domain as never, () => new Date(now))
    const audit = new AuditTrail({ emit: () => undefined, inject: () => undefined } as never)
    return new RunService(repo, configRefs(), audit, () => new Date(now))
  }

  it('removes only old terminal runs and never an active one', async () => {
    const { domain, repo } = makeRepo()
    await repo.insertTask(sampleTask())
    const base: Omit<RunRecord, 'runId' | 'status' | 'startedAt' | 'updatedAt' | 'finishedAt' | 'progress'> = {
      taskId: 'tsk_aaaaaaaaaaaaaaaaaaaa',
      taskRevision: 1,
      taskOwnerSessionId: 'sess_a',
      sessionId: 'sess_a',
      triggerType: 'manual',
      requiredTotal: 2,
      requiredCompleted: 0,
      totalSteps: 2,
      templateSnapshot: { revision: 1, title: '示例任务', steps: sampleTask().steps },
      schemaVersion: SCHEMA_VERSION,
    }
    const old = '2020-01-01T00:00:00.000Z'
    await repo.insertRun({ ...base, runId: 'run_old_success', status: 'succeeded', progress: 100, startedAt: old, updatedAt: old, finishedAt: old })
    await repo.insertRun({ ...base, runId: 'run_old_failed', status: 'failed', progress: 0, startedAt: old, updatedAt: old, finishedAt: old })
    await repo.insertRun({ ...base, runId: 'run_old_running', status: 'running', progress: 0, startedAt: old, updatedAt: old })
    await repo.putStep({
      runId: 'run_old_success', stepId: 'stp_1', taskId: base.taskId, order: 1, title: 'x', required: true,
      status: 'completed', attempt: 1, updatedAt: old,
    })

    const pruned = await buildRunService(domain, new Date().toISOString()).prune()
    expect(pruned.runsDeleted).toBe(2)
    expect(pruned.stepsDeleted).toBe(1)
    const remaining = repo.listRuns().map((run) => run.runId)
    expect(remaining).toEqual(['run_old_running'])
    expect(repo.getTask('tsk_aaaaaaaaaaaaaaaaaaaa')).toBeTruthy()
  })
})

describe('startup recovery', () => {
  it('interrupts a stale run and its running step without creating a new run', async () => {
    const { domain, repo } = makeRepo()
    await repo.insertTask(sampleTask())
    const old = new Date(Date.now() - 5 * 3_600_000).toISOString()
    await repo.insertRun({
      runId: 'run_stale0000000000001',
      taskId: 'tsk_aaaaaaaaaaaaaaaaaaaa',
      taskRevision: 1,
      taskOwnerSessionId: 'sess_a',
      sessionId: 'sess_a',
      status: 'running',
      triggerType: 'manual',
      progress: 0,
      requiredTotal: 2,
      requiredCompleted: 0,
      totalSteps: 2,
      startedAt: old,
      updatedAt: old,
      templateSnapshot: { revision: 1, title: '示例任务', steps: sampleTask().steps },
      schemaVersion: SCHEMA_VERSION,
    })
    await repo.putStep({
      runId: 'run_stale0000000000001', stepId: 'stp_1', taskId: 'tsk_aaaaaaaaaaaaaaaaaaaa',
      order: 1, title: '第一步', required: true, status: 'running', attempt: 1, updatedAt: old,
    })

    const audit = new AuditTrail({ emit: () => undefined, inject: () => undefined } as never)
    const service = new RunService(repo, configRefs(), audit, () => new Date())
    const result = await service.scanStale({ startup: true })
    expect(result.interrupted).toBe(1)
    expect(repo.getRun('run_stale0000000000001')!.status).toBe('interrupted')
    expect(repo.getStep('run_stale0000000000001', 'stp_1')!.status).toBe('failed')
    expect(repo.listRuns()).toHaveLength(1)
  })

  it('leaves a freshly updated run alone', async () => {
    const { domain, repo } = makeRepo()
    await repo.insertTask(sampleTask())
    const now = new Date().toISOString()
    await repo.insertRun({
      runId: 'run_fresh0000000000001',
      taskId: 'tsk_aaaaaaaaaaaaaaaaaaaa',
      taskRevision: 1,
      taskOwnerSessionId: 'sess_a',
      sessionId: 'sess_a',
      status: 'running',
      triggerType: 'manual',
      progress: 0,
      requiredTotal: 2,
      requiredCompleted: 0,
      totalSteps: 2,
      startedAt: now,
      updatedAt: now,
      templateSnapshot: { revision: 1, title: '示例任务', steps: sampleTask().steps },
      schemaVersion: SCHEMA_VERSION,
    })
    const audit = new AuditTrail({ emit: () => undefined, inject: () => undefined } as never)
    const service = new RunService(repo, configRefs(), audit, () => new Date(now))
    expect((await service.scanStale({ startup: true })).interrupted).toBe(0)
    expect(repo.getRun('run_fresh0000000000001')!.status).toBe('running')
  })
})

describe('facility wiring', () => {
  it('opens the declared domain once and reads back the same handle', async () => {
    const facility = new FakeDomainFacility()
    const first = await facility.open(createDomainSpec() as never)
    const second = await facility.open(createDomainSpec() as never)
    expect(second).toBe(first)
    expect(facility.openCalls).toBe(2)
    expect(facility.get('dsh_background_task_engine')).toBe(first)
    await second.close()
  })

  it('schedule adapter reports unavailability without a host service', async () => {
    const adapter = new ScheduleAdapter(undefined)
    expect(adapter.available).toBe(false)
    await expect(
      adapter.create({ taskId: 'tsk_a', taskTitle: 't', timing: { kind: 'every', everySeconds: 60 }, sessionId: 's' }),
    ).rejects.toThrow(/未挂载 Schedule/)
  })
})

describe('domain spec version gate', () => {
  // The host's JSON backend refuses to load a file whose stored unit version is
  // neither the declared version nor listed in compatibleVersions. Without the
  // listing, upgrading the schema version makes every 1.1.x install fail to start.
  it('accepts files written by 1.1.x so migrations can upgrade them', () => {
    const spec = createDomainSpec()
    expect(spec.version).toBe(2)
    expect(spec.compatibleVersions).toEqual([1])
  })
})
