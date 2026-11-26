/**
 * Shared harness: a fake Cordis context wired to the real plugin entry point,
 * so tests drive the public `apply()` / `ctx.tools.register` path rather than
 * internal services.
 */

import { apply, engineOf, resolveConfig } from '../../src/index.js'
import type { HostContextLike, ToolDefinitionLike, ToolRunContextLike } from '../../src/host.js'
import type { EngineConfig } from '../../src/config.js'
import { FakeBus, FakeDomainFacility, FakeSchedule, type FakeScheduleOptions } from './fakes.js'

export interface HarnessOptions {
  config?: Partial<EngineConfig>
  storage?: 'ok' | 'missing' | { failWith: Error }
  schedule?: false | FakeScheduleOptions
}

export interface Harness {
  ctx: HostContextLike
  tools: Map<string, ToolDefinitionLike>
  bus: FakeBus
  facility?: FakeDomainFacility
  schedule?: FakeSchedule
  logs: string[]
  /** Error thrown by apply(), if the plugin refused to start. */
  applyError?: unknown
  /** Call one registered tool as `sessionId`. */
  call(name: string, sessionId: string, args: Record<string, unknown>): Promise<Record<string, unknown>>
  dispose(): Promise<void>
}

export const SESSION_A = 'sess_alpha_0001'
export const SESSION_B = 'sess_beta_0002'

export function createHarness(options: HarnessOptions = {}): Harness {
  const tools = new Map<string, ToolDefinitionLike>()
  const bus = new FakeBus()
  const logs: string[] = []
  const disposers: Array<() => void> = []

  let facility: FakeDomainFacility | undefined
  const storageOption = options.storage ?? 'ok'
  if (storageOption === 'ok') facility = new FakeDomainFacility()
  else if (typeof storageOption === 'object') facility = new FakeDomainFacility(storageOption.failWith)

  const schedule = options.schedule === false ? undefined : new FakeSchedule(options.schedule ?? {})

  const logger = {
    debug: (...args: unknown[]) => logs.push(`debug ${args.join(' ')}`),
    info: (...args: unknown[]) => logs.push(`info ${args.join(' ')}`),
    warn: (...args: unknown[]) => logs.push(`warn ${args.join(' ')}`),
    error: (...args: unknown[]) => logs.push(`error ${args.join(' ')}`),
  }

  const services: Record<string, unknown> = {}
  if (storageOption !== 'missing') services.storageDomain = facility
  if (schedule) services.schedule = schedule

  const ctx: HostContextLike = {
    get: (key: string) => {
      const value = services[key]
      if (value === undefined) throw new Error(`cannot get property "${key}" without inject`)
      return value
    },
    tools: {
      register: (definition: ToolDefinitionLike) => {
        if (tools.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`)
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    ...(storageOption === 'missing' ? {} : { storageDomain: facility }),
    ...(schedule ? { schedule } : {}),
    emit: (event: string, payload: unknown) => bus.emit(event, payload),
    inject: (_deps, callback) => {
      callback(ctx)
    },
    effect: (setup: () => (() => void) | void) => {
      const disposer = setup()
      if (typeof disposer === 'function') disposers.push(disposer)
    },
    logger,
  }

  let applyError: unknown
  try {
    apply(ctx, options.config ? resolveConfig(options.config) : undefined)
  } catch (error) {
    // A startup failure (e.g. missing StorageDomain) is part of the contract.
    applyError = error
  }

  const engine = engineOf(ctx)

  const call = async (
    name: string,
    sessionId: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const definition = tools.get(name)
    if (!definition) throw new Error(`tool ${name} is not registered`)
    const exec: ToolRunContextLike = { agent: { session: { id: sessionId } }, id: sessionId }
    const value = await definition.execute(args, exec)
    return value as Record<string, unknown>
  }

  return {
    ctx,
    tools,
    bus,
    facility,
    schedule,
    logs,
    applyError,
    call,
    async dispose() {
      for (const disposer of disposers.reverse()) disposer()
      await engine?.dispose()
    },
  }
}

/** Assert a successful tool result and return it typed. */
export function expectOk(result: Record<string, unknown>): Record<string, unknown> {
  if (result.success !== true) {
    throw new Error(`expected success, got ${JSON.stringify(result.error)}`)
  }
  return result
}

/** Read the error code from a failed tool result. */
export function errorCode(result: Record<string, unknown>): string {
  const error = result.error as { code?: string } | undefined
  if (result.success !== false || !error?.code) {
    throw new Error(`expected failure with an error code, got ${JSON.stringify(result).slice(0, 300)}`)
  }
  return error.code
}

export const THREE_STEPS = [
  { title: '检查 Git 状态', instruction: '查看当前项目的修改情况', completionCriteria: '输出修改文件及状态' },
  { title: '检查代码问题', instruction: '分析近期变更和明显异常', completionCriteria: '生成问题列表' },
  { title: '生成巡检报告', instruction: '汇总检查结果', completionCriteria: '报告包含结果与建议' },
]
