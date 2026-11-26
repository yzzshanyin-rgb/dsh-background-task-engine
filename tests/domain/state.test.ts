import { describe, expect, it } from 'vitest'

import {
  ACTIVE_RUN_STATUSES,
  HEALTH_LABELS,
  OCCUPYING_RUN_STATUSES,
  RESUMABLE_RUN_STATUSES,
  TERMINAL_RUN_STATUSES,
  failedSteps,
  firstPendingStep,
  isActiveRun,
  isTerminalRun,
  occupiesSlot,
  orderedSteps,
  requiredProgress,
  runHealth,
  runTransitionProblem,
  startBlockers,
  stepTransitionProblem,
  unsettledRequiredSteps,
} from '../../src/domain/state.js'
import type { RunStatus, RunStepRecord, StepStatus } from '../../src/domain/records.js'

function step(overrides: Partial<RunStepRecord> & Pick<RunStepRecord, 'stepId' | 'order'>): RunStepRecord {
  return {
    runId: 'run_0123456789abcdefghij',
    taskId: 'tsk_0123456789abcdefghij',
    title: `步骤 ${overrides.order}`,
    required: true,
    status: 'pending',
    attempt: 0,
    updatedAt: '2026-11-26T00:00:00.000Z',
    ...overrides,
  }
}

const ALL_RUN_STATUSES: RunStatus[] = [
  'queued',
  'running',
  'blocked',
  'succeeded',
  'failed',
  'interrupted',
  'skipped',
]

describe('run state machine', () => {
  const legal: Array<[RunStatus, RunStatus]> = [
    ['queued', 'running'],
    ['queued', 'interrupted'],
    ['queued', 'skipped'],
    ['queued', 'failed'],
    ['running', 'succeeded'],
    ['running', 'failed'],
    ['running', 'blocked'],
    ['running', 'interrupted'],
    ['blocked', 'failed'],
    ['blocked', 'interrupted'],
  ]

  it('accepts the documented transitions', () => {
    for (const [from, to] of legal) {
      expect(runTransitionProblem(from, to), `${from} -> ${to}`).toBeUndefined()
    }
  })

  it('never goes back to running once a run left queued/running', () => {
    for (const from of ['blocked', 'succeeded', 'failed', 'interrupted', 'skipped'] as RunStatus[]) {
      expect(runTransitionProblem(from, 'running')).toBeDefined()
    }
  })

  it('treats terminal statuses as final and blocks re-finishing', () => {
    for (const from of TERMINAL_RUN_STATUSES) {
      for (const to of ALL_RUN_STATUSES) {
        expect(runTransitionProblem(from, to)?.kind, `${from} -> ${to}`).toBe('already-finished')
      }
    }
  })

  it('reports a same-status write separately so callers can make it idempotent', () => {
    expect(runTransitionProblem('running', 'running')).toEqual({ kind: 'same-status' })
    expect(runTransitionProblem('queued', 'queued')).toEqual({ kind: 'same-status' })
  })

  it('reports illegal jumps with both ends', () => {
    expect(runTransitionProblem('queued', 'succeeded')).toEqual({
      kind: 'illegal',
      from: 'queued',
      to: 'succeeded',
    })
  })

  it('classifies statuses into active, occupying, resumable and terminal sets', () => {
    expect(ACTIVE_RUN_STATUSES).toEqual(['queued', 'running'])
    expect(OCCUPYING_RUN_STATUSES).toEqual(['queued', 'running', 'blocked'])
    expect(RESUMABLE_RUN_STATUSES).toEqual(['failed', 'interrupted', 'blocked'])
    expect(TERMINAL_RUN_STATUSES).toEqual(['succeeded', 'failed', 'interrupted', 'skipped'])
    expect(isActiveRun('blocked')).toBe(false)
    // A blocked run waits for a human but still holds the concurrency slot.
    expect(occupiesSlot('blocked')).toBe(true)
    expect(occupiesSlot('interrupted')).toBe(false)
    expect(isTerminalRun('failed')).toBe(true)
  })
})

describe('step state machine', () => {
  it('accepts pending -> running -> completed', () => {
    expect(stepTransitionProblem('pending', 'running')).toBeUndefined()
    expect(stepTransitionProblem('running', 'completed')).toBeUndefined()
  })

  it('allows failing or skipping from pending and running', () => {
    expect(stepTransitionProblem('pending', 'failed')).toBeUndefined()
    expect(stepTransitionProblem('pending', 'skipped')).toBeUndefined()
    expect(stepTransitionProblem('running', 'failed')).toBeUndefined()
    expect(stepTransitionProblem('running', 'skipped')).toBeUndefined()
  })

  it('refuses to reopen a settled step, including re-reporting the same status', () => {
    for (const from of ['completed', 'failed', 'skipped'] as StepStatus[]) {
      for (const to of ['pending', 'running', 'completed', 'failed', 'skipped'] as StepStatus[]) {
        const problem = stepTransitionProblem(from, to)
        expect(problem, `${from} -> ${to}`).toBeDefined()
        if (from === to) expect(problem?.kind).toBe('same-status')
      }
    }
  })
})

describe('progress and ordering', () => {
  it('computes floor(completed required / required total * 100)', () => {
    expect(requiredProgress([])).toEqual({ done: 0, total: 0, percent: 100 })
    expect(
      requiredProgress([
        step({ stepId: 'stp_a', order: 1, status: 'completed' }),
        step({ stepId: 'stp_b', order: 2, status: 'running' }),
        step({ stepId: 'stp_c', order: 3, status: 'pending' }),
      ]),
    ).toEqual({ done: 1, total: 3, percent: 33 })
    // 2/3 must floor to 66, not round to 67: progress can never overstate work.
    expect(
      requiredProgress([
        step({ stepId: 'stp_a', order: 1, status: 'completed' }),
        step({ stepId: 'stp_b', order: 2, status: 'completed' }),
        step({ stepId: 'stp_c', order: 3, status: 'pending' }),
      ]).percent,
    ).toBe(66)
  })

  it('never counts optional, failed or skipped steps as progress', () => {
    expect(
      requiredProgress([
        step({ stepId: 'stp_a', order: 1, status: 'completed', required: false }),
        step({ stepId: 'stp_b', order: 2, status: 'failed' }),
        step({ stepId: 'stp_c', order: 3, status: 'skipped' }),
        step({ stepId: 'stp_d', order: 4, status: 'completed' }),
      ]),
    ).toEqual({ done: 1, total: 3, percent: 33 })
  })

  it('orders steps by order regardless of input order', () => {
    const shuffled = [step({ stepId: 'stp_c', order: 3 }), step({ stepId: 'stp_a', order: 1 }), step({ stepId: 'stp_b', order: 2 })]
    expect(orderedSteps(shuffled).map((row) => row.stepId)).toEqual(['stp_a', 'stp_b', 'stp_c'])
  })

  it('finds the first unfinished step in order', () => {
    const steps = [
      step({ stepId: 'stp_a', order: 1, status: 'completed' }),
      step({ stepId: 'stp_b', order: 2, status: 'running' }),
      step({ stepId: 'stp_c', order: 3, status: 'pending' }),
    ]
    expect(firstPendingStep(steps)?.stepId).toBe('stp_b')
    expect(firstPendingStep([step({ stepId: 'stp_a', order: 1, status: 'completed' })])).toBeUndefined()
  })

  it('blocks succeeded while a required step is unfinished but allows skipped ones', () => {
    const unfinished = [
      step({ stepId: 'stp_a', order: 1, status: 'completed' }),
      step({ stepId: 'stp_b', order: 2, status: 'pending' }),
    ]
    expect(unsettledRequiredSteps(unfinished).map((row) => row.stepId)).toEqual(['stp_b'])

    const skipped = [
      step({ stepId: 'stp_a', order: 1, status: 'completed' }),
      step({ stepId: 'stp_b', order: 2, status: 'skipped' }),
    ]
    expect(unsettledRequiredSteps(skipped)).toEqual([])

    // An optional step never blocks the run.
    const optional = [step({ stepId: 'stp_a', order: 1, status: 'pending', required: false })]
    expect(unsettledRequiredSteps(optional)).toEqual([])
  })

  it('refuses to start a later step before its predecessors settle', () => {
    const steps = [
      step({ stepId: 'stp_a', order: 1, status: 'pending' }),
      step({ stepId: 'stp_b', order: 2, status: 'pending' }),
    ]
    expect(startBlockers(steps, 'stp_b').map((row) => row.stepId)).toEqual(['stp_a'])
    expect(startBlockers(steps, 'stp_a')).toEqual([])
    // Skipped predecessors are settled, so the next step may start.
    expect(startBlockers([step({ stepId: 'stp_a', order: 1, status: 'skipped' })], 'stp_b')).toEqual([])
  })

  it('lists failed steps in order', () => {
    const steps = [
      step({ stepId: 'stp_b', order: 2, status: 'failed' }),
      step({ stepId: 'stp_a', order: 1, status: 'failed' }),
      step({ stepId: 'stp_c', order: 3, status: 'completed' }),
    ]
    expect(failedSteps(steps).map((row) => row.stepId)).toEqual(['stp_a', 'stp_b'])
  })
})

describe('run health', () => {
  const now = new Date('2026-11-26T12:00:00.000Z')
  const limits = { timeoutMinutes: 60, staleMinutes: 30 }

  it('reports a healthy run as normal', () => {
    const health = runHealth(
      { status: 'running', startedAt: '2026-11-26T11:50:00.000Z', lastHeartbeatAt: '2026-11-26T11:59:00.000Z' },
      now,
      limits,
    )
    expect(health.health).toBe('normal')
    expect(health.resumable).toBe(false)
  })

  it('separates a long run (timeout) from a silent one (suspected_stale)', () => {
    const timedOut = runHealth(
      { status: 'running', startedAt: '2026-11-26T10:00:00.000Z', lastHeartbeatAt: '2026-11-26T11:59:00.000Z' },
      now,
      limits,
    )
    expect(timedOut.health).toBe('timeout')
    expect(timedOut.reasons[0]).toContain('超过配置的运行上限')

    const silent = runHealth(
      { status: 'running', startedAt: '2026-11-26T11:00:00.000Z', lastHeartbeatAt: '2026-11-26T11:00:00.000Z' },
      now,
      limits,
    )
    expect(silent.health).toBe('suspected_stale')
    // Silence is a warning, never permission to replay work.
    expect(silent.needsConfirmation).toBe(true)
    expect(silent.resumable).toBe(false)
  })

  it('treats an expired lease as suspected loss of contact', () => {
    const health = runHealth(
      {
        status: 'running',
        startedAt: '2026-11-26T11:50:00.000Z',
        lastHeartbeatAt: '2026-11-26T11:59:00.000Z',
        leaseExpiresAt: '2026-11-26T11:55:00.000Z',
      },
      now,
      limits,
    )
    expect(health.health).toBe('suspected_stale')
  })

  it('describes terminal and blocked runs without a timeout claim', () => {
    expect(runHealth({ status: 'interrupted', startedAt: '2026-11-26T09:00:00.000Z' }, now, limits)).toMatchObject({
      health: 'interrupted',
      resumable: true,
    })
    expect(runHealth({ status: 'failed', startedAt: '2026-11-26T09:00:00.000Z' }, now, limits)).toMatchObject({
      health: 'finished',
      resumable: true,
    })
    expect(runHealth({ status: 'blocked', startedAt: '2026-11-26T09:00:00.000Z' }, now, limits)).toMatchObject({
      health: 'blocked',
      resumable: true,
    })
  })

  it('reports a run awaiting confirmation', () => {
    const health = runHealth(
      {
        status: 'running',
        startedAt: '2026-11-26T11:55:00.000Z',
        lastHeartbeatAt: '2026-11-26T11:59:30.000Z',
        needsUserConfirmation: true,
      },
      now,
      limits,
    )
    expect(health.health).toBe('awaiting_confirmation')
    expect(health.needsConfirmation).toBe(true)
  })

  it('labels every health state', () => {
    expect(Object.keys(HEALTH_LABELS).sort()).toEqual(
      ['awaiting_confirmation', 'blocked', 'finished', 'interrupted', 'normal', 'suspected_stale', 'timeout'].sort(),
    )
  })
})
