/**
 * dsh-background-task-engine — DSH Host plugin entry.
 *
 * Registers 14 model-facing `task_*` tools over DSH native capabilities:
 *   - `ctx.storageDomain` for durable task/run/step records (required)
 *   - `ctx.schedule` for optional native timing (never reimplemented)
 *   - `ctx.tools` for the tool surface
 *
 * Missing StorageDomain is a startup failure with an explicit diagnostic
 * (PRD FR-012, 16.3): the plugin never degrades to in-memory storage.
 *
 * @module dsh-background-task-engine
 */

import type { HostContextLike, ToolsServiceLike } from './host.js'
import { Config, resolveConfig } from './config.js'
import { TaskEngine } from './services/engine.js'
import { createTaskTools } from './tools/task-tools.js'
import { createRunTools } from './tools/run-tools.js'
import { createScheduleTool } from './tools/schedule-tool.js'
import { createEngineTools } from './tools/engine-tools.js'
import { registerUiRoutes } from './services/http-routes.js'

export const name = 'dsh-background-task-engine'

/** Hard dependencies: tools to register on, StorageDomain to persist through. */
export const inject = ['tools', 'storageDomain']

export { Config } from './config.js'
export { TaskEngine } from './services/engine.js'
export { TaskEngineError, TASK_ERROR_CODES, toErrorPayload, sanitizeMessage } from './errors.js'
export { resolveConfig, CONFIG_LIMITS, DEFAULT_CONFIG } from './config.js'
export type { EngineConfig } from './config.js'
export {
  SCHEMA_VERSION,
  DOMAIN_NAME,
  RUN_STATUSES,
  STEP_STATUSES,
  TASK_STATUSES,
  TRIGGER_TYPES,
} from './domain/records.js'
export { createDomainSpec, runMigrations, verifyIntegrity, MIGRATIONS } from './storage/spec.js'
export { parseTriggerMessage, EXECUTION_PROTOCOL } from './prompt/guidance.js'
export { ROUTE_PREFIX } from './services/http-routes.js'

/** Engine holders keyed by the plugin context that created them. */
const engines = new WeakMap<object, TaskEngine>()

/**
 * Mount the plugin.
 *
 * @param ctx - Cordis context carrying `tools` and `storageDomain`.
 * @param rawConfig - Profile config validated by {@link Config}.
 */
export function apply(ctx: HostContextLike, rawConfig?: unknown): void {
  const config = resolveConfig(rawConfig)
  const tools = ctx.tools
  if (!tools || typeof tools.register !== 'function') {
    throw new Error('dsh-background-task-engine: ctx.tools 不可用，无法注册 task_* 工具')
  }

  // PRD FR-012 / 16.3: StorageDomain is a hard dependency. A missing mount is a
  // load-time failure with a concrete message, never a silent memory fallback.
  if (!ctx.storageDomain || typeof ctx.storageDomain.open !== 'function') {
    throw new Error(
      'dsh-background-task-engine: 未挂载 ctx.storageDomain，插件拒绝启动，也不会降级为内存存储。'
        + '请确认宿主已启用 StorageDomain（如 base bundle 的 storage-domain backend=json）。',
    )
  }

  const engine = new TaskEngine(ctx, config)
  engines.set(ctx, engine)

  // Storage failures surface at startup through the context logger and through
  // every tool result (TASK_STORAGE_ERROR); they are never swallowed.
  engine.ready.catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    ctx.logger?.error?.(`[background-task-engine] 启动失败：${message}`)
  })

  registerTools(tools, () => engine)
  // The task board reads through the plugin's own HTTP routes (1.2.0 §6); when
  // the host has no webServer the board is simply absent, tools unaffected.
  registerUiRoutes(ctx, () => engine)

  ctx.effect?.(() => () => {
    void engine.dispose()
  })
}

function registerTools(tools: ToolsServiceLike, engine: () => TaskEngine): void {
  const definitions = [
    ...createTaskTools(engine),
    ...createRunTools(engine),
    createScheduleTool(engine),
    ...createEngineTools(engine),
  ]
  for (const definition of definitions) {
    try {
      tools.register(definition)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`dsh-background-task-engine: 注册工具 ${definition.name} 失败：${message}`)
    }
  }
}

/** Internal accessor used by tests and diagnostics. */
export function engineOf(ctx: object): TaskEngine | undefined {
  return engines.get(ctx)
}

export default { name, inject, Config, apply }
