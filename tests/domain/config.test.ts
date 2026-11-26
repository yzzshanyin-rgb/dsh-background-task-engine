import { describe, expect, it } from 'vitest'

import { CONFIG_LIMITS, Config, configRefs, configValues, DEFAULT_CONFIG, resolveConfig } from '../../src/config.js'

/**
 * The configuration contract has two halves, and both are load-bearing:
 *
 * 1. The schema must expose every field as VOLATILE — that is the only thing
 *    that makes `dsh-settings` serve a namespace for this plugin, and the
 *    Plugins page draws a card only for a served namespace. A schema of plain
 *    fields silently has no settings UI.
 * 2. The plugin must read the live reference on every use, not a value copied at
 *    load time; otherwise a save from the card would need a restart.
 *
 * These tests pin both, because a regression in either one is invisible in the
 * host log — the card just stops appearing, or edits stop taking effect.
 */
describe('configuration schema', () => {
  it('declares every field volatile so the settings namespace is served', () => {
    const schema = Config as unknown as { dict?: Record<string, { meta?: { volatile?: boolean } }> }
    const fields = Object.keys(schema.dict ?? {})
    expect(fields.sort()).toEqual(Object.keys(CONFIG_LIMITS).sort())
    const plain = fields.filter((key) => schema.dict?.[key]?.meta?.volatile !== true)
    expect(plain).toEqual([])
  })

  it('parses a missing config into live references that answer with defaults', () => {
    const parsed = Config({}) as unknown as Record<string, { get?: () => unknown }>
    for (const key of Object.keys(CONFIG_LIMITS) as (keyof typeof CONFIG_LIMITS)[]) {
      const field = parsed[key]
      expect(typeof field?.get).toBe('function')
      expect(field?.get?.()).toBe(CONFIG_LIMITS[key].default)
    }
  })

  it('rejects an out-of-range value at load time instead of clamping it', () => {
    expect(() => resolveConfig({ maxStepsPerTask: 11 })).toThrow(/超出允许范围/)
    expect(() => resolveConfig({ maxActiveRunsPerOwner: 0 })).toThrow(/超出允许范围/)
    expect(() => resolveConfig({ maxSummaryChars: 1.5 })).toThrow(/必须是整数/)
    expect(() => resolveConfig('not an object')).toThrow(/配置必须是对象/)
  })
})

describe('live configuration', () => {
  it('reads the current value of a host reference instead of a snapshot', () => {
    let current = 3
    const config = resolveConfig({
      maxActiveRunsPerOwner: { get: () => current },
    })
    expect(config.maxActiveRunsPerOwner.get()).toBe(3)
    // The host updates a volatile field in place; the plugin must see the change.
    current = 5
    expect(config.maxActiveRunsPerOwner.get()).toBe(5)
  })

  it('falls back to the default when a hand-edited value drifts out of range', () => {
    let current: unknown = 3
    const config = resolveConfig({ maxActiveRunsPerOwner: { get: () => current } })
    current = 99
    // Reading must not throw inside a tool call; the validated default is safer.
    expect(config.maxActiveRunsPerOwner.get()).toBe(CONFIG_LIMITS.maxActiveRunsPerOwner.default)
    current = '7'
    expect(config.maxActiveRunsPerOwner.get()).toBe(7)
  })

  it('accepts plain numbers as well as references', () => {
    const config = resolveConfig({ ...DEFAULT_CONFIG, maxSummaryChars: 500 })
    expect(config.maxSummaryChars.get()).toBe(500)
    expect(config.maxTasksPerOwner.get()).toBe(DEFAULT_CONFIG.maxTasksPerOwner)
  })

  it('builds references over plain values for embedded engines', () => {
    expect(configValues(configRefs())).toEqual(DEFAULT_CONFIG)
    expect(configValues(configRefs({ historyRetentionDays: 7 })).historyRetentionDays).toBe(7)
    expect(() => configRefs({ maxStepsPerTask: 42 })).toThrow(/超出允许范围/)
  })
})
