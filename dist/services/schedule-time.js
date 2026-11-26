/**
 * Time-zone arithmetic for schedule timings.
 *
 * The 1.1.x builder pasted a wall-clock time onto *UTC's* calendar date, so a
 * daily 09:00 rule authored from Shanghai produced a DTSTART one day early
 * whenever UTC and the zone were on different dates — and the rule then fired
 * on the wrong day. Everything here works in the zone the timing is authored
 * in, and refuses a zone name the runtime does not know instead of silently
 * inventing one.
 */
export const DEFAULT_TIME_ZONE = 'Asia/Shanghai';
const DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
export function isValidTimeZone(timeZone) {
    if (typeof timeZone !== 'string' || timeZone.trim() === '')
        return false;
    try {
        // Throws RangeError for an unknown zone; the check is the constructor itself.
        new Intl.DateTimeFormat('en-US', { timeZone });
        return true;
    }
    catch {
        return false;
    }
}
export function requireTimeZone(timeZone) {
    const zone = timeZone === undefined || timeZone.trim() === '' ? DEFAULT_TIME_ZONE : timeZone.trim();
    if (!isValidTimeZone(zone)) {
        throw new Error(`未知的时区名“${zone}”，请使用 IANA 时区（例如 Asia/Shanghai、Europe/Berlin）。`);
    }
    return zone;
}
export function zonedParts(timeZone, instant) {
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hour12: false,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        weekday: 'short',
    });
    const parts = formatter.formatToParts(instant);
    const value = (type) => parts.find((part) => part.type === type)?.value ?? '0';
    const weekdayName = value('weekday');
    const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekdayName);
    return {
        year: Number(value('year')),
        month: Number(value('month')),
        day: Number(value('day')),
        // `hour12: false` still yields 24 for midnight in some ICU versions.
        hour: Number(value('hour')) % 24,
        minute: Number(value('minute')),
        second: Number(value('second')),
        weekday: weekday === -1 ? 0 : weekday,
    };
}
/** Offset of `timeZone` from UTC, in minutes, at the given instant. */
function offsetMinutes(timeZone, instantMs) {
    const parts = zonedParts(timeZone, new Date(instantMs));
    const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    return (asUtc - instantMs) / 60_000;
}
/**
 * The UTC instant of a wall-clock time in `timeZone`.
 *
 * Two passes: the first offset is computed at the naive instant, the second at
 * the corrected one, which settles the hours around a DST transition. A time
 * that does not exist (spring forward) lands on the instant after the gap
 * instead of throwing.
 */
export function zonedWallClockToInstant(timeZone, parts) {
    const naive = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0);
    let candidate = naive - offsetMinutes(timeZone, naive) * 60_000;
    candidate = naive - offsetMinutes(timeZone, candidate) * 60_000;
    return new Date(candidate);
}
function pad(value) {
    return String(value).padStart(2, '0');
}
function stamp(parts) {
    return `${parts.year}${pad(parts.month)}${pad(parts.day)}T${pad(parts.hour)}${pad(parts.minute)}00`;
}
/**
 * DTSTART for a daily or weekly wall-clock rule, expressed in the authoring
 * zone's own calendar date.
 *
 * The anchor is the next occurrence at or after "now", so a rule created at
 * 15:00 for 09:00 does not immediately catch up on a missed slot.
 */
export function buildWallClockRrule(timeZone, hour, minute, weeklyDay, now = new Date()) {
    const zone = requireTimeZone(timeZone);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23)
        throw new Error('hour 必须是 0–23 的整数');
    if (!Number.isInteger(minute) || minute < 0 || minute > 59)
        throw new Error('minute 必须是 0–59 的整数');
    const today = zonedParts(zone, now);
    let anchorDayOffset = 0;
    if (weeklyDay !== undefined) {
        const target = ((weeklyDay % 7) + 7) % 7;
        anchorDayOffset = (target - today.weekday + 7) % 7;
    }
    let anchor = new Date(zonedWallClockToInstant(zone, {
        year: today.year,
        month: today.month,
        day: today.day,
        hour,
        minute,
    }));
    if (anchorDayOffset > 0) {
        // Move by whole calendar days first, then recompute in the zone so a DST
        // change between now and the anchor cannot shift the wall clock.
        const shifted = new Date(anchor.getTime() + anchorDayOffset * 86_400_000);
        const shiftedParts = zonedParts(zone, shifted);
        anchor = zonedWallClockToInstant(zone, { ...shiftedParts, hour, minute });
    }
    else if (anchor.getTime() < now.getTime()) {
        const tomorrow = new Date(anchor.getTime() + 86_400_000);
        const tomorrowParts = zonedParts(zone, tomorrow);
        anchor = zonedWallClockToInstant(zone, { ...tomorrowParts, year: tomorrowParts.year, month: tomorrowParts.month, day: tomorrowParts.day, hour, minute });
    }
    const localAnchor = zonedParts(zone, anchor);
    const dayPart = weeklyDay !== undefined ? `;BYDAY=${DAY_CODES[localAnchor.weekday]}` : '';
    const freq = weeklyDay !== undefined ? 'WEEKLY' : 'DAILY';
    const rrule = `DTSTART;TZID=${zone}:${stamp(localAnchor)}\nRRULE:FREQ=${freq}${dayPart}`;
    return { rrule, firstOccurrence: anchor.toISOString() };
}
/** Human description of when a daily/weekly rule next fires, in its own zone. */
export function describeNextOccurrence(timeZone, rrule, now = new Date()) {
    const match = /DTSTART;TZID=([^:]+):(\d{8}T\d{4})/.exec(rrule);
    if (match === null)
        return undefined;
    const zone = match[1] ?? timeZone;
    const text = match[2] ?? '';
    const year = Number(text.slice(0, 4));
    const month = Number(text.slice(4, 6));
    const day = Number(text.slice(6, 8));
    const hour = Number(text.slice(9, 11));
    const minute = Number(text.slice(11, 13));
    if (!isValidTimeZone(zone) || [year, month, day, hour, minute].some((value) => !Number.isFinite(value))) {
        return undefined;
    }
    let instant = zonedWallClockToInstant(zone, { year, month, day, hour, minute });
    const weekly = /FREQ=WEEKLY/.test(rrule);
    if (instant.getTime() < now.getTime()) {
        const stepDays = weekly ? 7 : 1;
        while (instant.getTime() < now.getTime()) {
            const moved = new Date(instant.getTime() + stepDays * 86_400_000);
            const parts = zonedParts(zone, moved);
            instant = zonedWallClockToInstant(zone, { ...parts, hour, minute });
        }
    }
    return `${instant.toISOString()}（${zone} 当地时间 ${pad(hour)}:${pad(minute)}）`;
}
export { DAY_CODES };
