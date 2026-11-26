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
export declare const DEFAULT_TIME_ZONE = "Asia/Shanghai";
declare const DAY_CODES: readonly ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
export interface ZonedParts {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
    /** 0 = Sunday, matching {@link DAY_CODES}. */
    weekday: number;
}
export declare function isValidTimeZone(timeZone: string): boolean;
export declare function requireTimeZone(timeZone: string | undefined): string;
export declare function zonedParts(timeZone: string, instant: Date): ZonedParts;
/**
 * The UTC instant of a wall-clock time in `timeZone`.
 *
 * Two passes: the first offset is computed at the naive instant, the second at
 * the corrected one, which settles the hours around a DST transition. A time
 * that does not exist (spring forward) lands on the instant after the gap
 * instead of throwing.
 */
export declare function zonedWallClockToInstant(timeZone: string, parts: {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
}): Date;
/**
 * DTSTART for a daily or weekly wall-clock rule, expressed in the authoring
 * zone's own calendar date.
 *
 * The anchor is the next occurrence at or after "now", so a rule created at
 * 15:00 for 09:00 does not immediately catch up on a missed slot.
 */
export declare function buildWallClockRrule(timeZone: string, hour: number, minute: number, weeklyDay?: number, now?: Date): {
    rrule: string;
    firstOccurrence: string;
};
/** Human description of when a daily/weekly rule next fires, in its own zone. */
export declare function describeNextOccurrence(timeZone: string, rrule: string, now?: Date): string | undefined;
export { DAY_CODES };
