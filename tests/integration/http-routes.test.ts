/**
 * The task board's data channel (PRD §6): the routes must answer only for the
 * session the page names, and every write goes through the same services (and
 * therefore the same permissions) as the tools.
 */

import { describe, expect, it } from 'vitest'

import { ROUTE_PREFIX, registerUiRoutes } from '../../src/services/http-routes.js'
import { TaskEngine } from '../../src/services/engine.js'
import { FakeDomainFacility, FakeSchedule } from '../helpers/fakes.js'
import { configRefs } from '../../src/config.js'
import { SESSION_A, SESSION_B, THREE_STEPS } from '../helpers/harness.js'

interface Reply {
  status: number
  body: Record<string, unknown>
}

function createServer(): {
  ctx: { inject: (deps: string[], callback: (scoped: unknown) => void) => void }
  routes: Map<string, (req: unknown, res: unknown) => Promise<void>>
  dispose: () => void
} {
  const routes = new Map<string, (req: unknown, res: unknown) => Promise<void>>()
  const dispose: Array<() => void> = []
  const ctx = {
    inject: (_deps: string[], callback: (scoped: unknown) => void) => {
      callback({
        webServer: {
          register: (route: { path: string; handler: (req: unknown, res: unknown) => Promise<void> }) => {
            routes.set(route.path, route.handler)
            return () => routes.delete(route.path)
          },
        },
        effect: (factory: () => () => void) => {
          dispose.push(factory())
        },
      })
    },
  }
  return { ctx, routes, dispose: () => dispose.forEach((fn) => fn()) }
}

async function call(
  routes: Map<string, (req: unknown, res: unknown) => Promise<void>>,
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<Reply> {
  const handler = routes.get(`${ROUTE_PREFIX}${path.split('?')[0]}`)
  if (handler === undefined) throw new Error(`未注册路由 ${path}`)
  const bodyText = options.body === undefined ? '' : JSON.stringify(options.body)
  const req = {
    method: options.method ?? 'GET',
    url: `${ROUTE_PREFIX}${path}`,
    async *[Symbol.asyncIterator]() {
      if (bodyText !== '') yield Buffer.from(bodyText)
    },
  }
  let status = 0
  let payload = ''
  const res = {
    setHeader: () => undefined,
    end: (text: string) => {
      payload = text
    },
    get statusCode() {
      return status
    },
    set statusCode(value: number) {
      status = value
    },
  }
  await handler(req, res)
  return { status, body: JSON.parse(payload) as Record<string, unknown> }
}

async function build(): Promise<{
  routes: Map<string, (req: unknown, res: unknown) => Promise<void>>
  engine: TaskEngine
  taskId: string
  runId: string
}> {
  const facility = new FakeDomainFacility()
  const engine = new TaskEngine(
    {
      storageDomain: facility,
      schedule: new FakeSchedule(),
      emit: () => undefined,
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      inject: () => undefined,
      effect: () => undefined,
    },
    configRefs(),
    () => new Date().toISOString(),
  )
  const server = createServer()
  registerUiRoutes(server.ctx as never, () => engine)
  await engine.ready
  const task = await engine.taskService.create({ sessionId: SESSION_A, title: '看板任务', steps: THREE_STEPS.map((s) => ({ ...s })) })
  const started = await engine.runService.start({ sessionId: SESSION_A, taskId: task.taskId })
  return { routes: server.routes, engine, taskId: task.taskId, runId: started.run.runId }
}

describe('board routes', () => {
  it('registers the documented endpoints', async () => {
    const { routes, engine } = await build()
    expect([...routes.keys()].sort()).toEqual([
      `${ROUTE_PREFIX}/action`,
      `${ROUTE_PREFIX}/run`,
      `${ROUTE_PREFIX}/status`,
      `${ROUTE_PREFIX}/task`,
      `${ROUTE_PREFIX}/tasks`,
    ])
    await engine.dispose()
  })

  it('lists only the requesting session tasks, with health and trigger', async () => {
    const { routes, engine, taskId } = await build()
    const mine = await call(routes, `/tasks?session=${SESSION_A}`)
    expect(mine.status).toBe(200)
    const items = mine.body.items as Array<Record<string, unknown>>
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ taskId, status: 'active', trigger: 'manual' })
    expect((items[0]!.lastRun as Record<string, unknown>).health).toBe('normal')

    const other = await call(routes, `/tasks?session=${SESSION_B}`)
    expect((other.body.items as unknown[])).toHaveLength(0)
    await engine.dispose()
  })

  it('refuses to answer without a session', async () => {
    const { routes, engine } = await build()
    const reply = await call(routes, '/tasks')
    expect(reply.status).toBe(403)
    expect((reply.body.error as { code: string }).code).toBe('TASK_PERMISSION_DENIED')
    await engine.dispose()
  })

  it('hides another session task behind the same not-found answer', async () => {
    const { routes, engine, taskId } = await build()
    const reply = await call(routes, `/task?session=${SESSION_B}&taskId=${taskId}`)
    expect(reply.status).toBe(404)
    expect((reply.body.error as { code: string }).code).toBe('TASK_NOT_FOUND')
    await engine.dispose()
  })

  it('returns the run timeline with per-step status and no internal token', async () => {
    const { routes, engine, runId } = await build()
    const reply = await call(routes, `/run?session=${SESSION_A}&runId=${runId}`)
    expect(reply.status).toBe(200)
    const steps = reply.body.steps as Array<Record<string, unknown>>
    expect(steps).toHaveLength(3)
    expect(steps[0]).toMatchObject({ order: 1, status: 'pending' })
    expect(JSON.stringify(reply.body)).not.toContain('exec_')
    await engine.dispose()
  })

  it('pauses and resumes a task through the same service the tools use', async () => {
    const { routes, engine, taskId } = await build()
    const paused = await call(routes, '/action', {
      method: 'POST',
      body: { session: SESSION_A, taskId, action: 'pause' },
    })
    expect(paused.status).toBe(200)
    expect(paused.body).toMatchObject({ taskId, status: 'paused', revision: 2 })

    const resumed = await call(routes, '/action', {
      method: 'POST',
      body: { session: SESSION_A, taskId, action: 'resume' },
    })
    expect(resumed.body).toMatchObject({ status: 'active', revision: 3 })
    await engine.dispose()
  })

  it('rejects an unknown action and a non-POST write', async () => {
    const { routes, engine, taskId } = await build()
    const bad = await call(routes, '/action', { method: 'POST', body: { session: SESSION_A, taskId, action: 'explode' } })
    expect(bad.status).toBe(400)
    expect((bad.body.error as { code: string }).code).toBe('TASK_INVALID_ARGUMENTS')

    const wrongMethod = await call(routes, '/action', { body: { session: SESSION_A, taskId, action: 'pause' } })
    expect(wrongMethod.status).toBe(400)
    await engine.dispose()
  })

  it('reports engine status scoped to the caller', async () => {
    const { routes, engine } = await build()
    const reply = await call(routes, `/status?session=${SESSION_A}`)
    expect(reply.body).toMatchObject({ storageAvailable: true, activeRunCount: 1 })
    const other = await call(routes, `/status?session=${SESSION_B}`)
    expect(other.body).toMatchObject({ activeRunCount: 0 })
    await engine.dispose()
  })
})
