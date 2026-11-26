/**
 * Domain-level unit tests (PRD 14.1, 14.2, 14.5: state machine, progress,
 * ordering guards, error sanitisation, config ranges).
 */

import { describe, expect, it } from 'vitest'
import {
  assertLinearStart,
  assertRunTransition,
  assertStepTransition,
  canTransitionRun,
  computeProgress,
  firstPendingStep,
  isActiveRun,
  isTerminalRun,
  requiredStepsSettled,
} from '../../src/domain/state.js'
import { TaskEngineError, sanitizeMessage, toErrorPayload } from '../../src/errors.js'
import { resolveConfig, DEFAULT_CONFIG } from '../../src/config.js'
import { parseTriggerMessage } from '../../src/prompt/guidance.js'
import { decodeCursor, encodeCursor, isAfterCursor, paginate } from '../../src/utils/page.js'
import { truncateText, untrustedText } from '../../src/utils/text.js'

describe('TaskRun state machine', () => {
  it('accepts the documented transitions', () => {
    expect(canTransitionRun('queued', 'running')).toBe(true)
    expect(canTransitionRun('running', 'succeeded')).toBe(true)
    expect(canTransitionRun('running', 'failed')).toBe(true)
    expect(canTransitionRun('running', 'blocked')).toBe(true)
    expect(canTransitionRun('queued', 'skipped')).toBe(true)
  })

  it('refuses to go back from a non-running state to running', () => {
    for (const from of ['blocked', 'failed', 'interrupted'] as const) {
      expect(() => assertRunTransition(from, 'running', 'test')).toThrow(TaskEngineError)
    }
  })

  it('treats terminal states as final', () => {
    for (const status of ['succeeded', 'failed', 'interrupted', 'skipped'] as const) {
      expect(isTerminalRun(status)).toBe(true)
      expect(() => assertRunTransition(status, 'failed', 'test')).toThrow(/已结束/)
    }
    expect(isActiveRun('running')).toBe(true)
    expect(isActiveRun('succeeded')).toBe(false)
  })

  it('rejects re-reporting the same step status', () => {
    expect(() => assertStepTransition('completed', 'completed', 'stp_1')).toThrow(/重复报告/)
    expect(() => assertStepTransition('completed', 'running', 'stp_1')).toThrow(/不能从 completed/)
    expect(() => assertStepTransition('pending', 'running', 'stp_1')).not.toThrow()
    expect(() => assertStepTransition('running', 'completed', 'stp_1')).not.toThrow()
  })
})

describe('progress and ordering', () => {
  const steps = [
    { stepId: 'a', order: 1, required: true, status: 'completed' as const },
    { stepId: 'b', order: 2, required: true, status: 'completed' as const },
    { stepId: 'c', order: 3, required: true, status: 'pending' as const },
  ]

  it('computes floor(completed required / required total * 100)', () => {
    expect(computeProgress(steps)).toEqual({ progress: 66, requiredTotal: 3, requiredCompleted: 2 })
    expect(computeProgress([{ required: true, status: 'pending' }])).toEqual({
      progress: 0,
      requiredTotal: 1,
      requiredCompleted: 0,
    })
  })

  it('never counts optional or non-completed steps as progress', () => {
    expect(
      computeProgress([
        { required: true, status: 'completed' },
        { required: false, status: 'completed' },
        { required: true, status: 'skipped' },
      ]),
    ).toEqual({ progress: 50, requiredTotal: 2, requiredCompleted: 1 })
  })

  it('finds the first unfinished step in order', () => {
    expect(firstPendingStep(steps)).toBe('c')
    expect(firstPendingStep([{ stepId: 'x', order: 1, status: 'completed' }])).toBeUndefined()
  })

  it('blocks succeeded while a required step is unfinished', () => {
    const settled = requiredStepsSettled(steps)
    expect(settled.ok).toBe(false)
    expect(settled.blockers.join()).toContain('c')
  })

  it('refuses to start a later step before its predecessors', () => {
    expect(() => assertLinearStart(steps, 'c')).not.toThrow()
    expect(() => assertLinearStart([{ ...steps[0]!, status: 'running' }, steps[2]!], 'c')).toThrow(
      /按 order 顺序/,
    )
    expect(() => assertLinearStart(steps, 'zzz')).toThrow(/不属于本次运行/)
  })
})

describe('error contract', () => {
  it('sanitises paths, stacks and credentials', () => {
    const message = sanitizeMessage(
      'Error: failed at /Users/someone/secret/project/file.ts\n    at fn (/Users/someone/x.js:1:2)\napiKey=sk-live-abc123',
    )
    expect(message).not.toContain('/Users/')
    expect(message).not.toContain('sk-live-abc123')
    expect(message).not.toContain('at fn')
    expect(message).toContain('<path>')
  })

  it('maps unknown failures to TASK_INTERNAL_ERROR and missing keys to TASK_NOT_FOUND', () => {
    expect(toErrorPayload(new Error('boom')).code).toBe('TASK_INTERNAL_ERROR')
    expect(toErrorPayload(new Error('missing-key: tasks/x')).code).toBe('TASK_NOT_FOUND')
    const payload = toErrorPayload(new TaskEngineError('TASK_ALREADY_RUNNING', 'busy', { relatedRunId: 'run_1' }))
    expect(payload).toMatchObject({ code: 'TASK_ALREADY_RUNNING', retryable: true, relatedRunId: 'run_1' })
  })
})

describe('configuration validation', () => {
  it('fills documented defaults', () => {
    expect(resolveConfig(undefined)).toEqual(DEFAULT_CONFIG)
    const defaults = resolveConfig({})
    expect(defaults.maxStepsPerTask).toBe(10)
    expect(defaults.maxParallelRunsPerTask).toBe(1)
    expect(defaults.historyRetentionDays).toBe(90)
  })

  it('rejects out-of-range values instead of clamping', () => {
    expect(() => resolveConfig({ maxStepsPerTask: 11 })).toThrow(/超出允许范围/)
    expect(() => resolveConfig({ maxParallelRunsPerTask: 2 })).toThrow(/超出允许范围/)
    expect(() => resolveConfig({ historyRetentionDays: 0 })).toThrow(/超出允许范围/)
    expect(() => resolveConfig({ maxTasksPerOwner: 1.5 })).toThrow(/必须是整数/)
  })
})

describe('trigger payload parsing', () => {
  it('extracts task, schedule and occurrence from a delivery message', () => {
    const text = [
      '[SCHEDULE REMINDER]',
      'This is a scheduled message from the user',
      'schedule_id_json: "sch_0001"',
      'occurrence_at: "2026-11-26T01:00:00.000Z"',
      'reminder_prompt_json: "{\\"task_id_json\\": \\"tsk_abcdefgh1234\\"}"',
    ].join('\n')
    const parsed = parseTriggerMessage(text)
    expect(parsed.taskId).toBe('tsk_abcdefgh1234')
    expect(parsed.scheduleId).toBe('sch_0001')
    expect(parsed.occurrenceKey).toBe('2026-11-26T01:00:00.000Z')
  })

  it('returns an empty envelope for unrelated text', () => {
    expect(parseTriggerMessage('普通消息，没有任务标识')).toEqual({})
    expect(parseTriggerMessage(undefined)).toEqual({})
  })
})

describe('pagination and text limits', () => {
  const rows = [
    { id: 'r3', ts: '2026-11-26T03:00:00.000Z' },
    { id: 'r2', ts: '2026-11-26T02:00:00.000Z' },
    { id: 'r1', ts: '2026-11-26T01:00:00.000Z' },
  ]

  it('round-trips cursors and keysets by (timestamp, id)', () => {
    const first = paginate(rows, { limit: 2, cursor: undefined, tsOf: (row) => row.ts, idOf: (row) => row.id })
    expect(first.items.map((row) => row.id)).toEqual(['r3', 'r2'])
    expect(first.nextCursor).toBeTruthy()
    const cursor = decodeCursor(first.nextCursor)
    expect(cursor).toEqual({ u: '2026-11-26T02:00:00.000Z', i: 'r2' })
    const second = paginate(rows, { limit: 2, cursor, tsOf: (row) => row.ts, idOf: (row) => row.id })
    expect(second.items.map((row) => row.id)).toEqual(['r1'])
    expect(second.nextCursor).toBeUndefined()
  })

  it('treats an invalid cursor as the first page and compares ties by id', () => {
    expect(decodeCursor('not-a-cursor')).toBeUndefined()
    expect(decodeCursor(encodeCursor({ u: '2026-11-26T02:00:00.000Z', i: 'r2' }))).toEqual({
      u: '2026-11-26T02:00:00.000Z',
      i: 'r2',
    })
    expect(isAfterCursor('2026-11-26T02:00:00.000Z', 'r1', { u: '2026-11-26T02:00:00.000Z', i: 'r2' })).toBe(true)
    expect(isAfterCursor('2026-11-26T02:00:00.000Z', 'r3', { u: '2026-11-26T02:00:00.000Z', i: 'r2' })).toBe(false)
  })

  it('truncates summaries at the configured bound and strips control characters', () => {
    const truncated = truncateText('x'.repeat(500), 100)!
    expect(truncated.length).toBeLessThanOrEqual(100)
    expect(truncated.endsWith('[truncated]')).toBe(true)
    expect(untrustedText('a\u0000b\nc')).toBe('a b c')
  })
})
