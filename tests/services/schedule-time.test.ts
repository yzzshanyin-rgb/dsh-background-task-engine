import { describe, expect, it } from 'vitest'

import {
  DEFAULT_TIME_ZONE,
  buildWallClockRrule,
  describeNextOccurrence,
  isValidTimeZone,
  requireTimeZone,
  zonedParts,
  zonedWallClockToInstant,
} from '../../src/services/schedule-time.js'

describe('time zone validation', () => {
  it('accepts real IANA names and rejects free text', () => {
    expect(isValidTimeZone('Asia/Shanghai')).toBe(true)
    expect(isValidTimeZone('America/New_York')).toBe(true)
    expect(isValidTimeZone('UTC')).toBe(true)
    expect(isValidTimeZone('Mars/Olympus')).toBe(false)
    expect(isValidTimeZone('')).toBe(false)
  })

  it('falls back to the documented default when no zone is given', () => {
    expect(requireTimeZone(undefined)).toBe(DEFAULT_TIME_ZONE)
    expect(requireTimeZone('  ')).toBe(DEFAULT_TIME_ZONE)
  })

  it('names the offending zone instead of failing silently', () => {
    expect(() => requireTimeZone('Asia/Shanghia')).toThrow(/未知的时区名/)
  })
})

describe('wall clock conversion', () => {
  it('converts a Shanghai wall clock to its UTC instant', () => {
    const instant = zonedWallClockToInstant('Asia/Shanghai', { year: 2026, month: 11, day: 26, hour: 9, minute: 0 })
    expect(instant.toISOString()).toBe('2026-11-26T01:00:00.000Z')
  })

  it('keeps the wall clock across a daylight-saving change', () => {
    // 2026-03-08 is the US spring-forward day: 09:00 local is 13:00Z afterwards.
    const before = zonedWallClockToInstant('America/New_York', { year: 2026, month: 3, day: 7, hour: 9, minute: 0 })
    const after = zonedWallClockToInstant('America/New_York', { year: 2026, month: 3, day: 8, hour: 9, minute: 0 })
    expect(before.toISOString()).toBe('2026-03-07T14:00:00.000Z')
    expect(after.toISOString()).toBe('2026-03-08T13:00:00.000Z')
  })

  it('reads calendar parts in the requested zone', () => {
    // 16:30Z is already the next day in Shanghai.
    const parts = zonedParts('Asia/Shanghai', new Date('2026-11-26T16:30:00.000Z'))
    expect(parts).toMatchObject({ year: 2026, month: 11, day: 27, hour: 0, minute: 30 })
  })
})

describe('daily rule DTSTART', () => {
  it('uses the target zone calendar date, not the UTC one', () => {
    // 23:30 in Shanghai is still 2026-11-26 in UTC (15:30Z); a 09:00 rule must
    // therefore start on 2026-11-27, the next Shanghai day.
    const now = new Date('2026-11-26T15:30:00.000Z')
    const { rrule, firstOccurrence } = buildWallClockRrule('Asia/Shanghai', 9, 0, undefined, now)
    expect(rrule).toBe('DTSTART;TZID=Asia/Shanghai:20261127T090000\nRRULE:FREQ=DAILY')
    expect(firstOccurrence).toBe('2026-11-27T01:00:00.000Z')
  })

  it('does not immediately catch up on a slot that already passed today', () => {
    const now = new Date('2026-11-26T03:00:00.000Z') // 11:00 Shanghai
    const { rrule, firstOccurrence } = buildWallClockRrule('Asia/Shanghai', 9, 0, undefined, now)
    expect(rrule).toContain('DTSTART;TZID=Asia/Shanghai:20261127T090000')
    expect(firstOccurrence).toBe('2026-11-27T01:00:00.000Z')
  })

  it('keeps today when the slot is still ahead', () => {
    const now = new Date('2026-11-25T20:00:00.000Z') // 04:00 Shanghai on the 26th
    const { rrule, firstOccurrence } = buildWallClockRrule('Asia/Shanghai', 9, 0, undefined, now)
    expect(rrule).toContain('20261126T090000')
    expect(firstOccurrence).toBe('2026-11-26T01:00:00.000Z')
  })

  it('anchors a weekly rule on the requested weekday in that zone', () => {
    const now = new Date('2026-11-26T02:00:00.000Z') // Thursday 10:00 Shanghai
    const { rrule, firstOccurrence } = buildWallClockRrule('Asia/Shanghai', 8, 30, 1, now) // Monday
    expect(rrule).toBe('DTSTART;TZID=Asia/Shanghai:20261130T083000\nRRULE:FREQ=WEEKLY;BYDAY=MO')
    expect(firstOccurrence).toBe('2026-11-30T00:30:00.000Z')
  })

  it('refuses out-of-range wall clock values', () => {
    expect(() => buildWallClockRrule('Asia/Shanghai', 24, 0)).toThrow(/hour/)
    expect(() => buildWallClockRrule('Asia/Shanghai', 9, 61)).toThrow(/minute/)
  })
})

describe('human description', () => {
  it('describes the next occurrence in the rule zone', () => {
    const text = describeNextOccurrence('Asia/Shanghai', 'DTSTART;TZID=Asia/Shanghai:20261126T090000\nRRULE:FREQ=DAILY')
    expect(text).toContain('Asia/Shanghai')
  })

  it('returns undefined for a rule without a zoned DTSTART', () => {
    expect(describeNextOccurrence('Asia/Shanghai', 'RRULE:FREQ=DAILY')).toBeUndefined()
  })
})
