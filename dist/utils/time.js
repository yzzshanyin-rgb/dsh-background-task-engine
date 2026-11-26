/** RFC3339 UTC timestamps, e.g. 2026-11-26T01:02:03.456Z */
export function nowIso() {
    return new Date().toISOString();
}
export function toMillis(iso) {
    if (!iso)
        return 0;
    const value = Date.parse(iso);
    return Number.isFinite(value) ? value : 0;
}
export function minutesAgoIso(minutes, now = Date.now()) {
    return new Date(now - minutes * 60_000).toISOString();
}
export function daysAgoIso(days, now = Date.now()) {
    return new Date(now - days * 24 * 60 * 60_000).toISOString();
}
export function isOlderThanMinutes(iso, minutes, now = Date.now()) {
    if (!iso)
        return true;
    const millis = toMillis(iso);
    if (millis === 0)
        return true;
    return now - millis > minutes * 60_000;
}
export function elapsedLabel(fromIso, toIso) {
    const from = toMillis(fromIso);
    const to = toIso ? toMillis(toIso) : Date.now();
    if (!from || !to)
        return '—';
    const seconds = Math.max(0, Math.round((to - from) / 1000));
    if (seconds < 60)
        return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60)
        return `${minutes}m${seconds % 60 ? `${seconds % 60}s` : ''}`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h${minutes % 60 ? `${minutes % 60}m` : ''}`;
}
