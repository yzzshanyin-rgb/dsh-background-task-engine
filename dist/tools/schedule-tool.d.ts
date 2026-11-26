/**
 * task_schedule: manage the link between a task template and a native DSH
 * Schedule entry (PRD FR-002, 14.3).
 *
 * The plugin owns the reference, the host owns the rule. When `ctx.schedule` is
 * not mounted this tool returns TASK_SCHEDULE_UNAVAILABLE while manual runs keep
 * working (PRD FR-012).
 */
import type { ToolDefinitionLike } from '../host.js';
import type { TaskEngine } from '../services/engine.js';
export declare function createScheduleTool(engine: () => TaskEngine): ToolDefinitionLike;
