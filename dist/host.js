/**
 * Structural declarations of the DeepSeek Harness (DSH) Cordis plugin surface
 * used by this plugin.
 *
 * The plugin is loaded from a profile directory where only `zod` and
 * `@deepseek-ai/schemastery` resolve; `@deepseek-ai/dsh-*` packages are NOT
 * importable (verified with `require.resolve` in
 * docs/API-COMPATIBILITY-AUDIT.md). The host contract is therefore expressed
 * structurally: we depend on the documented public shape, never on a private
 * module path, and every optional capability is feature-detected at runtime.
 *
 * Anything added here must be backed by an entry in
 * docs/API-COMPATIBILITY-AUDIT.md (file + symbol + verified version).
 */
/**
 * Read an OPTIONAL host service.
 *
 * Cordis only exposes an injected service as a context property; touching a
 * property that was not declared in `inject` throws
 * `cannot get property "<name>" without inject`. Schedule is optional (PRD
 * FR-012: manual tasks still work without it), so it is resolved with
 * `ctx.get(name)` and a failure means "not mounted".
 */
export function optionalService(ctx, name) {
    try {
        const getter = ctx.get;
        if (typeof getter === 'function') {
            const value = getter.call(ctx, name);
            if (value !== undefined && value !== null)
                return value;
        }
    }
    catch {
        /* not mounted, or not readable at this point in the lifecycle */
    }
    try {
        const value = ctx[name];
        if (value !== undefined && value !== null)
            return value;
    }
    catch {
        /* property access without inject throws: treat as absent */
    }
    return undefined;
}
/** Extract the calling SessionId from a tool run context. */
export function sessionIdOf(exec) {
    const agent = exec?.agent;
    const fromSession = agent?.session?.id;
    if (typeof fromSession === 'string' && fromSession.length > 0)
        return fromSession;
    const fromAgent = agent?.id;
    if (typeof fromAgent === 'string' && fromAgent.length > 0)
        return fromAgent;
    return undefined;
}
