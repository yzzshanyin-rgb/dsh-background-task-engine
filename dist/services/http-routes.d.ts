/**
 * Read/write API for the in-app task board (1.2.0 §6).
 *
 * The board lives in the DSH Web/Desktop page, so it talks to the plugin over
 * the host's own `webServer` — the same channel dshmarket and dsh-context use.
 *
 * Two rules shape this file:
 *   - the session is the *only* authority: every query is filtered by the
 *     `session` the page supplies, and no endpoint lists sessions. A caller
 *     cannot reach another session's tasks by guessing a task id, because the
 *     repository's ownership check answers "not found" identically.
 *   - the board never computes state. Progress, health and "can resume" are
 *     produced by the services; the client only formats them.
 */
import type { HostContextLike } from '../host.js';
import type { TaskEngine } from './engine.js';
export declare const ROUTE_PREFIX = "/dsh-background-task/api";
export declare function registerUiRoutes(ctx: HostContextLike, engine: () => TaskEngine): void;
