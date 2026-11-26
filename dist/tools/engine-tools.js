/**
 * Engine-level tools: task_run_heartbeat and task_engine_status (1.2.0 §3, §5).
 *
 * Both are read-mostly observation tools. Heartbeat renews a lease; status
 * reports what the store says. Neither can advance a step, finish a run, or
 * repair data — that stays in the services.
 */
import { z } from 'zod';
import { elapsedLabel } from '../utils/time.js';
import { HEALTH_LABELS, runHealth } from '../domain/state.js';
import { buildTool, isFailure, out, renderGeneric, RUN_FIELDS, runView } from './shared.js';
function renderHeartbeat(args, value) {
    if (isFailure(value))
        return renderGeneric(args, value);
    const record = value;
    const lines = [
        `💓 心跳已记录：运行 ${String(record.runId ?? '')}（${String(record.status ?? '')}）`,
        `租约到期：${String(record.leaseExpiresAt ?? '—')}`,
    ];
    if (record.warning !== undefined)
        lines.push(`注意：${String(record.warning)}`);
    return [{ type: 'text', text: lines.join('\n') }];
}
export function createEngineTools(engine) {
    const heartbeat = buildTool({
        name: 'task_run_heartbeat',
        description: '为一次进行中的运行上报心跳并续租。步骤执行时间较长（外部命令、构建、下载）时调用，避免被判为疑似失联。'
            + '心跳只证明执行方仍活着，不代表外部操作成功，也不会推进任何步骤。'
            + '运行已结束、或执行凭证与当前代际不匹配时报错，不会修改状态。',
        parameters: {
            runId: { type: 'string', description: '运行 ID。' },
            executionToken: {
                type: 'string',
                description: '创建/恢复运行时返回的执行凭证；旧运行可省略，新运行建议始终携带。',
            },
            note: { type: 'string', description: '可选备注（例如正在等待构建），只进日志与诊断，不影响状态。' },
        },
        args: z.object({
            runId: z.string().trim().min(4).max(64),
            executionToken: z.string().trim().min(4).max(200).optional(),
            note: z.string().trim().max(200).optional(),
        }),
        output: out({
            ...RUN_FIELDS,
            leaseExpiresAt: { type: 'string' },
            accepted: { type: 'boolean' },
            warning: { type: 'string' },
        }, ['runId', 'status', 'accepted']),
        render: renderHeartbeat,
        async execute(args, active) {
            const result = await active.runService.heartbeat({
                sessionId: String(args.sessionId),
                runId: String(args.runId),
                executionToken: args.executionToken,
                note: args.note,
            });
            return {
                ...runView(result.run, await active.runService.stepsOf(result.run.runId)),
                ...(result.leaseExpiresAt === undefined ? {} : { leaseExpiresAt: result.leaseExpiresAt }),
                accepted: result.accepted,
                ...(result.warning === undefined ? {} : { warning: result.warning }),
            };
        },
    }, engine);
    const status = buildTool({
        name: 'task_engine_status',
        description: '查询任务引擎状态与诊断信息：存储与调度是否可用、当前会话的活动/阻塞/中断运行数、'
            + '最近一次恢复扫描与清理时间、完整性检查结果、未完成的定时操作数。'
            + '不返回其他会话的数据，不修改任何状态。',
        parameters: {
            includeIntegrity: {
                type: 'boolean',
                description: 'true 时重新执行一次完整性检查（会遍历记录，默认 false 直接返回最近结果）。',
            },
        },
        args: z.object({ includeIntegrity: z.boolean().optional() }),
        output: out({
            storageAvailable: { type: 'boolean' },
            scheduleAvailable: { type: 'boolean' },
            activeRunCount: { type: 'integer' },
            blockedRunCount: { type: 'integer' },
            interruptedRunCount: { type: 'integer' },
            taskCount: { type: 'integer' },
            runCount: { type: 'integer' },
            schemaVersion: { type: 'integer' },
            integrityStatus: { type: 'string', enum: ['ok', 'issues', 'unknown'] },
            integrityIssues: { type: 'array', items: { type: 'object', additionalProperties: true } },
            lastRecoveryScanAt: { type: 'string' },
            lastPruneAt: { type: 'string' },
            lastScheduleReconcileAt: { type: 'string' },
            unsettledScheduleOps: { type: 'integer' },
            staleRunsInterrupted: { type: 'integer' },
            staleRunsSuspected: { type: 'integer' },
            lastError: { type: 'string' },
            runs: { type: 'array', items: { type: 'object', additionalProperties: true } },
        }, ['storageAvailable', 'scheduleAvailable', 'integrityStatus']),
        render: (args, value) => {
            if (isFailure(value))
                return renderGeneric(args, value);
            const record = value;
            const mark = (ok) => (ok ? '✅' : '⛔');
            const lines = [
                `${mark(record.storageAvailable === true)} StorageDomain ${record.storageAvailable === true ? '可用' : '不可用'}`,
                `${mark(record.scheduleAvailable === true)} Schedule ${record.scheduleAvailable === true ? '可用' : '不可用（手动任务不受影响）'}`,
                `运行：活动 ${String(record.activeRunCount ?? 0)} · 阻塞 ${String(record.blockedRunCount ?? 0)} · 中断 ${String(record.interruptedRunCount ?? 0)}`,
                `数据：任务 ${String(record.taskCount ?? 0)} · 运行 ${String(record.runCount ?? 0)} · schemaVersion ${String(record.schemaVersion ?? '')}`,
                `完整性：${String(record.integrityStatus ?? 'unknown')}`,
            ];
            if (record.lastRecoveryScanAt !== undefined)
                lines.push(`最近恢复扫描：${String(record.lastRecoveryScanAt)}`);
            if (record.lastPruneAt !== undefined)
                lines.push(`最近清理：${String(record.lastPruneAt)}`);
            if (record.lastScheduleReconcileAt !== undefined) {
                lines.push(`最近定时对账：${String(record.lastScheduleReconcileAt)}`);
            }
            if (Number(record.unsettledScheduleOps ?? 0) > 0) {
                lines.push(`⚠️ 有 ${String(record.unsettledScheduleOps)} 条定时操作待核验（可能是宿主成功但本地写入失败）`);
            }
            if (record.lastError !== undefined)
                lines.push(`最近错误：${String(record.lastError)}`);
            const runs = (record.runs ?? []);
            if (runs.length > 0) {
                lines.push('最近运行：');
                for (const run of runs) {
                    lines.push(`· ${String(run.runId ?? '')} ${String(run.status ?? '')} ${String(run.progress ?? 0)}% `
                        + `${String(run.healthLabel ?? '')} ${elapsedLabel(String(run.startedAt ?? ''), undefined)}`);
                }
            }
            return [{ type: 'text', text: lines.join('\n') }];
        },
        async execute(args, active) {
            const sessionId = String(args.sessionId);
            const diagnostics = await active.diagnosticsFor(sessionId);
            const integrity = args.includeIntegrity === true ? active.recheckIntegrity() : diagnostics.integrity;
            const runs = active.repository
                .listRunsByOwner(sessionId)
                .sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0))
                .slice(0, 5)
                .map((run) => {
                const health = runHealth(run, new Date(), {
                    timeoutMinutes: active.config.defaultTimeoutMinutes.get(),
                    staleMinutes: active.config.staleRunAfterMinutes.get(),
                });
                return {
                    runId: run.runId,
                    taskId: run.taskId,
                    status: run.status,
                    progress: run.progress,
                    health: health.health,
                    healthLabel: HEALTH_LABELS[health.health],
                    startedAt: run.startedAt,
                    lastHeartbeatAt: run.lastHeartbeatAt ?? null,
                };
            });
            return {
                storageAvailable: diagnostics.storageAvailable,
                scheduleAvailable: diagnostics.scheduleAvailable,
                activeRunCount: diagnostics.activeRunCount,
                blockedRunCount: diagnostics.blockedRunCount,
                interruptedRunCount: diagnostics.interruptedRunCount,
                taskCount: diagnostics.taskCount,
                runCount: diagnostics.runCount,
                schemaVersion: diagnostics.schemaVersion,
                integrityStatus: diagnostics.integrityStatus,
                integrityIssues: (integrity?.issues ?? []).slice(0, 20),
                ...(diagnostics.lastRecoveryScanAt === undefined ? {} : { lastRecoveryScanAt: diagnostics.lastRecoveryScanAt }),
                ...(diagnostics.lastPruneAt === undefined ? {} : { lastPruneAt: diagnostics.lastPruneAt }),
                ...(diagnostics.lastScheduleReconcileAt === undefined
                    ? {}
                    : { lastScheduleReconcileAt: diagnostics.lastScheduleReconcileAt }),
                unsettledScheduleOps: diagnostics.unsettledScheduleOps,
                staleRunsInterrupted: diagnostics.staleRunsInterrupted,
                staleRunsSuspected: diagnostics.staleRunsSuspected,
                ...(diagnostics.lastError === undefined ? {} : { lastError: diagnostics.lastError }),
                runs,
            };
        },
    }, engine);
    return [heartbeat, status];
}
