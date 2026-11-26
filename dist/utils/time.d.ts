/** RFC3339 UTC timestamps, e.g. 2026-11-26T01:02:03.456Z */
export declare function nowIso(): string;
export declare function toMillis(iso: string | undefined): number;
export declare function minutesAgoIso(minutes: number, now?: number): string;
export declare function daysAgoIso(days: number, now?: number): string;
export declare function isOlderThanMinutes(iso: string | undefined, minutes: number, now?: number): boolean;
export declare function elapsedLabel(fromIso: string | undefined, toIso: string | undefined): string;
