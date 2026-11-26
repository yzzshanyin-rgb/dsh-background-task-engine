/**
 * Model-facing output tests (PRD 11.4, 12.2, FR-009): rendering, timing
 * translation and the uniform error envelope the agent branches on.
 */

import { describe, expect, it } from 'vitest'
import { SESSION_A, THREE_STEPS, createHarness, expectOk } from '../helpers/harness.js'
import { renderGeneric, out, TASK_FIELDS } from '../../src/tools/shared.js'
import { describeTiming, toHostTiming, ScheduleAdapter } from '../../src/services/schedule-adapter.js'
import { buildSchedulePrompt } from '../../src/prompt/guidance.js'

describe('uniform envelope', () => {
  it('renders failures as a single actionable line', () => {
    const blocks = renderGeneric({}, {
      success: false,
      error: { code: 'TASK_REVISION_CONFLICT', message: 'revision 冲突', retryable: true },
    })
    expect(blocks[0]!.text).toContain('TASK_REVISION_CONFLICT')
    expect(blocks[0]!.text).toContain('revision 冲突')
  })

  it('declares success and error on every output schema', () => {
    const schema = out(TASK_FIELDS, ['taskId'])
    expect(schema.properties?.success).toEqual({ type: 'boolean' })
    expect(schema.properties?.error?.properties?.code?.enum).toContain('TASK_RUN_ALREADY_FINISHED')
    expect(schema.required).toEqual(['success', 'taskId'])
  })
})

describe('timing translation', () => {
  it('passes through at / every / rrule / cron', () => {
    const at = toHostTiming({ kind: 'at', at: '2099-01-01T09:00:00+08:00' })
    expect(at).toEqual({ kind: 'at', at: '2099-01-01T01:00:00.000Z' })
    expect(toHostTiming({ kind: 'every', everySeconds: 600 })).toEqual({ kind: 'every', every_seconds: 600 })
    expect(toHostTiming({ kind: 'rrule', rrule: 'DTSTART:20990101T000000Z\nRRULE:FREQ=DAILY' }).kind).toBe('rrule')
    expect(toHostTiming({ kind: 'cron', expression: '0 9 * * 1-5' })).toEqual({
      kind: 'cron',
      cron: { expression: '0 9 * * 1-5', time_zone: 'Asia/Shanghai' },
    })
  })

  it('expresses daily and weekly wall-clock schedules as an RRULE', () => {
    const daily = toHostTiming({ kind: 'daily', hour: 9, minute: 30, timeZone: 'Asia/Shanghai' })
    expect(daily.kind).toBe('rrule')
    expect(String(daily.rrule)).toContain('DTSTART;TZID=Asia/Shanghai:')
    expect(String(daily.rrule)).toContain('RRULE:FREQ=DAILY')

    const weekly = toHostTiming({ kind: 'weekly', dayOfWeek: 1, hour: 8, minute: 0 })
    expect(String(weekly.rrule)).toContain('BYDAY=MO')
  })

  it('rejects invalid timing input instead of silently accepting it', () => {
    expect(() => toHostTiming({ kind: 'at', at: 'not-a-date' })).toThrow(/RFC3339/)
    expect(() => toHostTiming({ kind: 'at', at: '2020-01-01T00:00:00Z' })).toThrow(/必须晚于当前时间/)
    expect(() => toHostTiming({ kind: 'every', everySeconds: 5 })).toThrow(/整数/)
    expect(() => toHostTiming({ kind: 'rrule', rrule: 'FREQ=DAILY' })).toThrow(/RRULE:/)
    expect(() => toHostTiming({ kind: 'cron', expression: '0 9 * *' })).toThrow(/5 段/)
    expect(() => toHostTiming({ kind: 'daily', hour: 24, minute: 0 })).toThrow(/整数/)
  })

  it('describes every timing shape for display', () => {
    expect(describeTiming({ kind: 'every', every_seconds: 600 })).toContain('600')
    expect(describeTiming({ kind: 'cron', cron: { expression: '0 9 * * 1-5' } })).toContain('0 9 * * 1-5')
    expect(describeTiming({ kind: 'daily', hour: 9, minute: 5 })).toContain('09:05')
  })
})

describe('host schedule prompt', () => {
  it('carries the task id so a delivery can be mapped back to a task', () => {
    const prompt = buildSchedulePrompt({ taskId: 'tsk_abcdefgh12345678', taskTitle: '每日巡检' })
    expect(prompt).toContain('task_id_json: "tsk_abcdefgh12345678"')
    expect(prompt).toContain('task_run_begin')
    expect(prompt).toContain('occurrenceKey')
    expect(prompt).toContain('不代表任务已完成')
    // It must not claim elevated authority.
    expect(prompt).not.toMatch(/忽略.*(权限|审批)/)
  })
})

describe('tool rendering (what the model sees)', () => {
  it('renders a created task with its id, steps and revision', async () => {
    const harness = createHarness()
    const definition = harness.tools.get('task_create')!
    const value = expectOk(
      await definition.execute({ title: '每日项目巡检', steps: THREE_STEPS }, { agent: { session: { id: SESSION_A } } }),
    )
    const blocks = definition.output.render({}, value)
    const text = blocks.map((block) => block.text).join('\n')
    expect(text).toContain('每日项目巡检')
    expect(text).toContain(String(value.taskId))
    expect(text).toContain('1. 检查 Git 状态')
    expect(text).toContain('3. 生成巡检报告')
  })

  it('renders run progress with per-step marks and the next step', async () => {
    const harness = createHarness()
    const task = expectOk(await harness.call('task_create', SESSION_A, { title: '巡检', steps: THREE_STEPS }))
    const run = expectOk(await harness.call('task_run', SESSION_A, { taskId: task.taskId }))
    const steps = run.steps as Array<Record<string, unknown>>
    const report = harness.tools.get('task_step_report')!
    await report.execute(
      { runId: run.runId, stepId: steps[0]!.stepId, action: 'started' },
      { agent: { session: { id: SESSION_A } } },
    )
    const value = expectOk(
      await report.execute(
        { runId: run.runId, stepId: steps[0]!.stepId, action: 'completed', summary: '已检查 2 个文件' },
        { agent: { session: { id: SESSION_A } } },
      ),
    )
    const text = report.output.render({}, value)
      .map((block) => block.text)
      .join('\n')
    expect(text).toContain('进度 33%')
    expect(text).toContain('✓ 1. 检查 Git 状态')
    expect(text).toContain('○ 2. 检查代码问题')
    expect(text).toContain('下一步')
  })

  it('renders a failure with the failing step and the recovery hint', async () => {
    const harness = createHarness()
    const task = expectOk(await harness.call('task_create', SESSION_A, { title: '巡检', steps: THREE_STEPS }))
    const run = expectOk(await harness.call('task_run', SESSION_A, { taskId: task.taskId }))
    const steps = run.steps as Array<Record<string, unknown>>
    const report = harness.tools.get('task_step_report')!
    await report.execute(
      { runId: run.runId, stepId: steps[0]!.stepId, action: 'started' },
      { agent: { session: { id: SESSION_A } } },
    )
    await report.execute(
      {
        runId: run.runId,
        stepId: steps[0]!.stepId,
        action: 'failed',
        error: { code: 'GIT_UNREACHABLE', message: 'Git 仓库不可访问' },
      },
      { agent: { session: { id: SESSION_A } } },
    )
    const finish = harness.tools.get('task_run_finish')!
    const value = expectOk(
      await finish.execute(
        { runId: run.runId, status: 'failed', summary: '第一步失败' },
        { agent: { session: { id: SESSION_A } } },
      ),
    )
    const text = finish.output.render({}, value).map((block) => block.text).join('\n')
    expect(text).toContain('failed')
    expect(text).toContain('GIT_UNREACHABLE: Git 仓库不可访问')
    expect(text).toContain('进度 0%')
  })

  it('renders every tool without throwing on a failure envelope', () => {
    const harness = createHarness()
    for (const definition of harness.tools.values()) {
      const blocks = definition.output.render({}, {
        success: false,
        error: { code: 'TASK_INTERNAL_ERROR', message: 'boom', retryable: false },
      })
      expect(blocks.length).toBeGreaterThan(0)
      expect(blocks[0]!.text).toContain('boom')
    }
  })
})

describe('schedule adapter failure mapping', () => {
  it('maps host rejections to TASK_SCHEDULE_FAILED with a sanitised message', async () => {
    const adapter = new ScheduleAdapter({
      create: async () => {
        throw new Error('schedule/input-invalid at /Users/x/internal.ts')
      },
      edit: async () => ({ id: 'sch_1' }),
      view: async () => ({ id: 'sch_1', code: 'schedule_not_found' }),
      run: async () => ({ id: 'sch_1' }),
      list: async () => ({ items: [] }),
    })
    await expect(
      adapter.create({ taskId: 't', taskTitle: 'T', timing: { kind: 'every', everySeconds: 60 }, sessionId: 's' }),
    ).rejects.toMatchObject({ code: 'TASK_SCHEDULE_FAILED' })
  })

  it('treats a missing host entry as already gone rather than a hard failure', async () => {
    const adapter = new ScheduleAdapter({
      create: async () => ({ id: 'sch_1', title: 't', prompt: 'p' }),
      edit: async () => ({ id: 'sch_1', code: 'schedule_not_found' }),
      view: async () => ({ id: 'sch_1', code: 'schedule_not_found' }),
      run: async () => ({ id: 'sch_1' }),
      list: async () => ({ items: [] }),
    })
    await expect(adapter.remove('sch_1', 'sess')).resolves.toEqual({ deleted: false, alreadyGone: true })
    await expect(adapter.view('sch_1')).resolves.toBeUndefined()
  })
})
