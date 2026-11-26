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

export type Disposer = () => void

/** A model-visible content block produced by a tool's `output.render`. */
export interface ContentBlock {
  type: 'text'
  text: string
}

/**
 * The JSON Schema subset accepted by dsh-tools `assertSupportedJsonSchema`.
 * Keys outside this set (minLength, pattern, maximum, format, ...) throw at
 * registration time, so range/length rules are enforced in code instead.
 */
export interface JsonSchemaNode {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null'
  oneOf?: JsonSchemaNode[]
  properties?: Record<string, JsonSchemaNode>
  required?: string[]
  additionalProperties?: boolean
  items?: JsonSchemaNode
  enum?: Array<string | number | boolean | null>
  const?: string | number | boolean | null
  description?: string
  title?: string
  default?: unknown
  examples?: unknown[]
}

/** Tool execution context handed to `execute(args, exec)` by dsh-tools. */
export interface ToolRunContextLike {
  readonly callId?: string
  readonly name?: string
  readonly arguments?: unknown
  readonly signal?: AbortSignal
  /** Live agent face. `agent.id` and `agent.session.id` are both SessionIds. */
  readonly agent?: {
    readonly id?: string
    readonly session?: { readonly id?: string }
  }
}

/** Public tool definition shape (dsh-tools `ToolDefinition`). */
export interface ToolDefinitionLike {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: JsonSchemaNode
    render(args: unknown, value: unknown): ContentBlock[]
  }
  execute(args: unknown, exec: ToolRunContextLike): Promise<unknown>
  timeoutMs?: number
  isConcurrencySafe?: boolean
}

/** `ctx.tools` */
export interface ToolsServiceLike {
  register(definition: ToolDefinitionLike): Disposer
}

/** One table handle inside an opened StorageDomain. Reads are synchronous. */
export interface KvTableLike<V> {
  get(key: string): V | undefined
  entries(): IterableIterator<[string, V]>
  keys(): IterableIterator<string>
  readonly size: number
  put(key: string, value: V): Promise<void>
  delete(key: string): Promise<boolean>
  deleteMany(keys: string[]): Promise<number>
  update(key: string, mutator: (current: V) => V): Promise<V>
}

/** An opened StorageDomain handle. Records are shared immutables: never mutate. */
export interface DomainLike {
  readonly name: string
  table<V>(name: string): KvTableLike<V>
  close(): Promise<void>
}

/** `ctx.storageDomain` (DomainFacility). */
export interface DomainFacilityLike {
  open(spec: unknown): Promise<DomainLike>
  get(name: string): DomainLike | undefined
}

/** Public subset of `ctx.schedule` (ScheduleService) used by this plugin. */
export interface ScheduleRecordLike {
  id: string
  title: string
  prompt: string
  scheduledAt?: string
  status?: 'active' | 'paused' | 'ended'
  target?: Record<string, unknown>
  createdAt?: string
  updatedAt?: string
  executionActive?: boolean
  [key: string]: unknown
}

export interface ScheduleEditResultLike {
  id: string
  deleted?: boolean
  code?: string
  [key: string]: unknown
}

export interface ScheduleRunResultLike {
  id: string
  code?: string
  [key: string]: unknown
}

export interface ScheduleServiceLike {
  create(request: unknown, actorSessionId?: string, signal?: AbortSignal): Promise<ScheduleRecordLike>
  edit(request: unknown, actorSessionId?: string, signal?: AbortSignal): Promise<ScheduleEditResultLike>
  view(request: unknown): Promise<ScheduleRecordLike | { id: string; code: string }>
  run(request: unknown, signal?: AbortSignal): Promise<ScheduleRunResultLike>
  list(request?: unknown): Promise<{ items: ScheduleRecordLike[] }>
}

export interface LoggerLike {
  debug(...args: unknown[]): void
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

/** The Cordis context slice this plugin touches. */
export interface HostContextLike {
  get?(name: string): unknown
  /**
   * Cordis scoped injection: `callback` runs once every dependency is
   * available, and its registrations are disposed with the scope.
   */
  inject(deps: string[], callback: (ctx: HostContextLike) => void): unknown
  emit?(event: string, ...args: unknown[]): unknown
  on?(event: string, listener: (...args: unknown[]) => void): Disposer
  effect?(setup: () => Disposer | void): void
  logger?: LoggerLike
  tools?: ToolsServiceLike
  storageDomain?: DomainFacilityLike
  schedule?: ScheduleServiceLike
}

export interface PluginApplyTarget {
  (ctx: HostContextLike, config?: unknown): void
}

/**
 * Read an OPTIONAL host service.
 *
 * Cordis only exposes an injected service as a context property; touching a
 * property that was not declared in `inject` throws
 * `cannot get property "<name>" without inject`. Schedule is optional (PRD
 * FR-012: manual tasks still work without it), so it is resolved with
 * `ctx.get(name)` and a failure means "not mounted".
 */
export function optionalService<T>(ctx: HostContextLike, name: string): T | undefined {
  try {
    const getter = (ctx as { get?: (key: string) => unknown }).get
    if (typeof getter === 'function') {
      const value = getter.call(ctx, name)
      if (value !== undefined && value !== null) return value as T
    }
  } catch {
    /* not mounted, or not readable at this point in the lifecycle */
  }
  try {
    const value = (ctx as unknown as Record<string, unknown>)[name]
    if (value !== undefined && value !== null) return value as T
  } catch {
    /* property access without inject throws: treat as absent */
  }
  return undefined
}

/** Extract the calling SessionId from a tool run context. */
export function sessionIdOf(exec: ToolRunContextLike): string | undefined {
  const agent = exec?.agent
  const fromSession = agent?.session?.id
  if (typeof fromSession === 'string' && fromSession.length > 0) return fromSession
  const fromAgent = agent?.id
  if (typeof fromAgent === 'string' && fromAgent.length > 0) return fromAgent
  return undefined
}
