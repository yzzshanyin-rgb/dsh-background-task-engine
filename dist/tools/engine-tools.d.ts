/**
 * Engine-level tools: task_run_heartbeat and task_engine_status (1.2.0 §3, §5).
 *
 * Both are read-mostly observation tools. Heartbeat renews a lease; status
 * reports what the store says. Neither can advance a step, finish a run, or
 * repair data — that stays in the services.
 */
import type { ToolDefinitionLike } from '../host.js';
import type { TaskEngine } from '../services/engine.js';
export declare function createEngineTools(engine: () => TaskEngine): ToolDefinitionLike[];
