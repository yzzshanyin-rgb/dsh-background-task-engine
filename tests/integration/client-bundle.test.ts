import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * Contract tests for the browser half.
 *
 * These are the parts that fail *silently* in the real app: the bundle registers
 * under the wrong slot key (the card never appears), or it edits a namespace the
 * host does not serve (the card renders but nothing saves). Both are only
 * observable by opening the Plugins page, so the shape is pinned here instead.
 *
 * The bundle is hand-written (no build step); it talks to the shell through
 * `window.__ModuleLoader__.load` and to React through the shell's module table.
 * The test therefore supplies both, plus a minimal hook runtime.
 */

const CLIENT_ENTRY = fileURLToPath(new URL('../../client/client.js', import.meta.url))
const PACKAGE_NAME = 'dsh-background-task-engine'
const ROW_ID = 'background-task-engine'

interface TreeNode {
  type: unknown
  props: Record<string, unknown>
}

/**
 * Minimal function component runtime.
 *
 * It expands function components recursively (keyed by tree path, so hook order
 * is stable per instance) and replays effects until nothing is dirty. That is
 * enough to observe what the card and the board actually render — including the
 * children, which a single-level expander would never execute.
 */
function createReact() {
  const store = new Map<string, unknown[]>()
  const depStore = new Map<string, Array<unknown[] | undefined>>()
  let effects: Array<() => void> = []
  let dirty = false
  let currentPath = ''
  let currentIndex = 0

  function slotsFor(path: string): unknown[] {
    let slots = store.get(path)
    if (slots === undefined) {
      slots = []
      store.set(path, slots)
    }
    return slots
  }

  const React = {
    createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): TreeNode {
      const next: Record<string, unknown> = { ...(props ?? {}) }
      if (children.length > 0) next.children = children.length === 1 ? children[0] : children
      return { type, props: next }
    },
    useState(initial: unknown) {
      const index = currentIndex++
      const slots = slotsFor(currentPath)
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial
      const set = (value: unknown) => {
        // React semantics: an updater function receives the previous value.
        const next = typeof value === 'function' ? (value as (prev: unknown) => unknown)(slots[index]) : value
        // Object.is guard: an identical snapshot must not schedule a render, or a
        // subscribe-then-set effect would spin forever.
        if (Object.is(slots[index], next)) return
        slots[index] = next
        dirty = true
      }
      return [slots[index], set]
    },
    useRef(initial: unknown) {
      const index = currentIndex++
      const slots = slotsFor(currentPath)
      if (!(index in slots)) slots[index] = { current: initial }
      return slots[index]
    },
    useEffect(effect: () => unknown, deps?: unknown[]) {
      const index = currentIndex++
      let depsList = depStore.get(currentPath)
      if (depsList === undefined) {
        depsList = []
        depStore.set(currentPath, depsList)
      }
      const previous = depsList[index]
      const changed =
        deps === undefined ||
        previous === undefined ||
        previous.length !== deps.length ||
        deps.some((value, at) => !Object.is(value, previous[at]))
      depsList[index] = deps
      // Dependency tracking matters: without it the draft-sync effect would
      // rewrite state on every pass and never settle.
      if (changed) effects.push(effect as () => void)
    },
  }

  type Component = (props: Record<string, unknown>) => unknown

  function expand(node: unknown, path: string): unknown {
    if (node === null || node === undefined || typeof node !== 'object') return node
    if (Array.isArray(node)) return node.map((child, index) => expand(child, `${path}/${index}`))
    const tree = node as TreeNode
    if (typeof tree.type === 'function') {
      const outerPath = currentPath
      const outerIndex = currentIndex
      currentPath = path
      currentIndex = 0
      const output = (tree.type as Component)(tree.props)
      const expanded = expand(output, path)
      currentPath = outerPath
      currentIndex = outerIndex
      return expanded
    }
    const props: Record<string, unknown> = { ...tree.props }
    if ('children' in props) props.children = expand(props.children, `${path}/c`)
    return { type: tree.type, props }
  }

  function render(component: Component, props: Record<string, unknown>): TreeNode | null {
    for (let guard = 0; guard < 50; guard += 1) {
      dirty = false
      effects = []
      const tree = expand({ type: component, props }, 'root') as TreeNode | null
      for (const effect of effects) effect()
      if (!dirty) return tree
    }
    throw new Error('render loop did not settle')
  }

  return { React, render }
}

function walk(node: unknown, visit: (node: TreeNode) => void): void {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  const tree = node as TreeNode
  if (typeof tree.type !== 'string' && typeof tree.type !== 'function') return
  visit(tree)
  walk(tree.props?.children, visit)
}

function findAll(root: unknown, predicate: (node: TreeNode) => boolean): TreeNode[] {
  const found: TreeNode[] = []
  walk(root, (node) => {
    if (predicate(node)) found.push(node)
  })
  return found
}

interface FakeForm {
  getSnapshot: () => Record<string, unknown>
  subscribe: (listener: () => void) => () => void
  set: (field: string, value: unknown) => void
  unset: (field: string) => void
  mutate: (ops: unknown[], revision?: number) => Promise<boolean>
  calls: Array<Record<string, unknown>>
  rendered: () => void
}

function createForm(values: Record<string, number>): FakeForm {
  const calls: Array<Record<string, unknown>> = []
  const listeners = new Set<() => void>()
  let snapshot: Record<string, unknown> = {
    status: 'ready',
    value: { ...values },
    base: {},
    user: {},
    revision: 1,
    writable: true,
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set: (field, value) => calls.push({ op: 'set', path: [field], value }),
    unset: (field) => calls.push({ op: 'unset', path: [field] }),
    mutate: async (ops, revision) => {
      calls.push({ ops, revision })
      return true
    },
    calls,
    rendered: () => {
      for (const listener of listeners) listener()
    },
  }
}

interface Harness {
  module: { load: (definition: { id: string; factory: (require: (id: string) => unknown) => unknown }) => void }
  registrations: Array<{ options: Record<string, unknown>; Component: (props: Record<string, unknown>) => TreeNode | null }>
  servedWith: string[]
  render: ReturnType<typeof createReact>['render']
  React: unknown
}

function mountClient(
  form: FakeForm,
  served: string[],
  options: { fetchImpl?: (url: string, init?: unknown) => Promise<unknown>; session?: string } = {},
): Harness {
  const source = readFileSync(CLIENT_ENTRY, 'utf8')
  const { React, render } = createReact()

  let definition: { id: string; factory: (require: (id: string) => unknown) => unknown } | undefined
  const storage = new Map<string, string>()
  if (options.session !== undefined) storage.set('dsh-background-task-engine:session', options.session)
  const windowStub = {
    __ModuleLoader__: {
      load(next: { id: string; factory: (require: (id: string) => unknown) => unknown }) {
        definition = next
      },
    },
    location: { search: '', hash: '' },
    localStorage: {
      getItem: (key: string) => (storage.has(key) ? storage.get(key)! : null),
      setItem: (key: string, value: string) => storage.set(key, value),
    },
  }
  // The bundle installs its stylesheet through `document`; the real shell has
  // one, so the fixture needs the two calls it makes.
  const documentStub = {
    baseURI: 'http://127.0.0.1:64574/',
    head: { appendChild: () => undefined },
    createElement: () => ({ setAttribute: () => undefined, remove: () => undefined, textContent: '' }),
  }
  const fetchStub = (url: string, init?: unknown) => {
    if (options.fetchImpl === undefined) throw new Error(`unexpected fetch(${url})`)
    return options.fetchImpl(url, init)
  }
  // The bundle is a plain script (not a module): it installs itself on `window`.
  new Function('window', 'fetch', 'document', source)(windowStub, fetchStub, documentStub)
  expect(definition, 'client bundle did not register itself').toBeDefined()

  const registrations: Harness['registrations'] = []
  const servedWith: string[] = []

  const exports = definition!.factory(((id: string) => {
    if (id === 'react') return React
    throw new Error(`unexpected require(${id})`)
  }) as (id: string) => unknown) as {
    name: string
    inject: string[]
    apply: (ctx: Record<string, unknown>) => void
  }

  const slots = {
    inject(name: string, factory: () => unknown) {
      return factory()
    },
    register(options: Record<string, unknown>, Component: Harness['registrations'][number]['Component']) {
      registrations.push({ options, Component })
      return () => undefined
    },
  }

  // Mirrors the real `configForms.describe()` contract: a snapshot of the
  // served namespaces, keyed by profile row id, each carrying its schema.
  const mirror = {
    getSnapshot: () => ({
      view: {
        namespaces: served.map((ns) => ({
          ns,
          schema: ns.includes('stranger') ? { type: 'object', properties: { apiKey: { type: 'string' } } } : FORM_SCHEMA,
        })),
      },
    }),
    ensure: () => undefined,
    subscribe: () => () => undefined,
  }

  const forms = {
    get(namespace: string) {
      servedWith.push(namespace)
      return form
    },
    describe: () => mirror,
  }

  const ctx = {
    effect(fn: () => unknown) {
      fn()
      return () => undefined
    },
    inject(deps: string[], callback: (scoped: Record<string, unknown>) => void) {
      callback({ ...ctx, configForms: forms })
    },
    slots,
  }

  expect(exports.name).toBe(PACKAGE_NAME)
  expect(exports.inject).toContain('slots')
  exports.apply(ctx)

  return { module: windowStub.__ModuleLoader__, registrations, servedWith, render, React }
}

const FORM_SCHEMA = {
  type: 'object',
  properties: {
    maxTasksPerOwner: { type: 'number' },
    maxStepsPerTask: { type: 'number' },
    maxActiveRunsPerOwner: { type: 'number' },
    maxParallelRunsPerTask: { type: 'number' },
    defaultTimeoutMinutes: { type: 'number' },
    staleRunAfterMinutes: { type: 'number' },
    historyRetentionDays: { type: 'number' },
    maxSummaryChars: { type: 'number' },
  },
}

const DEFAULTS = {
  maxTasksPerOwner: 100,
  maxStepsPerTask: 10,
  maxActiveRunsPerOwner: 3,
  maxParallelRunsPerTask: 1,
  defaultTimeoutMinutes: 60,
  staleRunAfterMinutes: 30,
  historyRetentionDays: 90,
  maxSummaryChars: 2000,
}

function registrationsFor(harness: Harness, slot: string) {
  return harness.registrations.filter((entry) => entry.options.name === slot)
}

describe('client bundle registration', () => {
  it('loads itself under the package name', () => {
    const harness = mountClient(createForm(DEFAULTS), [ROW_ID])
    expect(Object.keys(harness.module)).toContain('load')
  })

  it('registers the bundle configuration card under the package name', () => {
    const harness = mountClient(createForm(DEFAULTS), [ROW_ID])
    const cards = registrationsFor(harness, 'plugins.bundle.config')
    expect(cards).toHaveLength(1)
    const options = cards[0]!.options
    expect(options.name).toBe('plugins.bundle.config')
    // The Plugins page keys this slot by `pkg.name`: any other key means no card.
    expect(options.key).toBe(PACKAGE_NAME)
  })

  it('edits the profile row id, not the package name', () => {
    const harness = mountClient(createForm(DEFAULTS), [ROW_ID])
    // dsh-settings serves entries keyed by `entry.options.id` — the row id from
    // cordis.patch.yml.
    expect(harness.servedWith).toEqual([ROW_ID])
  })

  it('falls back to the package name when the row id is overridden', () => {
    const harness = mountClient(createForm(DEFAULTS), [PACKAGE_NAME])
    expect(harness.servedWith).toEqual([PACKAGE_NAME])
  })

  it('claims a namespace by schema when the row id is unrelated', () => {
    // A user who renames the row id still gets a card: the schema is the
    // identity of the plugin's own settings.
    const harness = mountClient(createForm(DEFAULTS), ['some-custom-bundle'])
    expect(registrationsFor(harness, 'plugins.bundle.config')).toHaveLength(1)
    expect(harness.servedWith).toEqual(['some-custom-bundle'])
  })

  it('stays out when no served namespace carries these fields', () => {
    const harness = mountClient(createForm(DEFAULTS), ['stranger'])
    expect(registrationsFor(harness, 'plugins.bundle.config')).toHaveLength(0)
  })

  it('stays out of the summary view', () => {
    const harness = mountClient(createForm(DEFAULTS), [ROW_ID])
    const { Component } = registrationsFor(harness, 'plugins.bundle.config')[0]!
    expect(Component({ view: 'summary' })).toBeNull()
  })
})

describe('configuration card', () => {
  function card(form: FakeForm) {
    const harness = mountClient(form, [ROW_ID])
    const { Component, options } = harness.registrations[0]!
    const injected = (options.inject as () => Record<string, unknown>)()
    const tree = harness.render(Component, { view: 'page', ...injected })
    return { tree, form, harness }
  }

  it('shows every field with its current value', () => {
    const { tree } = card(createForm(DEFAULTS))
    const inputs = findAll(tree, (node) => node.type === 'input')
    expect(inputs).toHaveLength(8)
    expect(inputs.map((node) => node.props.value)).toEqual([
      '100',
      '10',
      '3',
      '1',
      '60',
      '30',
      '90',
      '2000',
    ])
  })

  it('saves only the fields that changed, at the observed revision', async () => {
    const form = createForm(DEFAULTS)
    const first = card(form)
    const input = findAll(first.tree, (node) => node.type === 'input')[1]!
    ;(input.props.onChange as (event: unknown) => void)({ target: { value: '7' } })

    // Re-render: the save handler closes over the draft of the render it came from.
    const second = first.harness.render(first.harness.registrations[0]!.Component, {
      view: 'page',
      ...(first.harness.registrations[0]!.options.inject as () => Record<string, unknown>)(),
    })
    const save = findAll(second, (node) => node.type === 'button' && node.props.className === 'dbte-save')[0]!
    ;(save.props.onClick as () => void)()
    await Promise.resolve()
    await Promise.resolve()

    expect(form.calls).toHaveLength(1)
    expect(form.calls[0]).toEqual({ ops: [{ op: 'set', path: ['maxStepsPerTask'], value: 7 }], revision: 1 })
  })

  it('refuses an out-of-range value instead of sending it', async () => {
    const form = createForm(DEFAULTS)
    const first = card(form)
    const input = findAll(first.tree, (node) => node.type === 'input')[1]!
    ;(input.props.onChange as (event: unknown) => void)({ target: { value: '99' } })

    const second = first.harness.render(first.harness.registrations[0]!.Component, {
      view: 'page',
      ...(first.harness.registrations[0]!.options.inject as () => Record<string, unknown>)(),
    })
    const save = findAll(second, (node) => node.type === 'button' && node.props.className === 'dbte-save')[0]!
    ;(save.props.onClick as () => void)()
    await Promise.resolve()

    // Nothing reached the host: the range check runs before the write.
    expect(form.calls).toHaveLength(0)
  })

  it('restores a single field to its default', async () => {
    const form = createForm({ ...DEFAULTS, maxSummaryChars: 500 })
    const { tree } = card(form)
    const reset = findAll(tree, (node) => node.type === 'button' && node.props.className === 'dbte-reset')[7]!
    ;(reset.props.onClick as () => void)()
    await Promise.resolve()

    expect(form.calls).toContainEqual({ op: 'unset', path: ['maxSummaryChars'] })
  })

  it('explains a namespace the host does not serve', () => {
    const form = createForm(DEFAULTS)
    const base = form.getSnapshot
    form.getSnapshot = () => ({ ...base(), status: 'unavailable' })
    const harness = mountClient(form, [ROW_ID])
    const { Component, options } = harness.registrations[0]!
    const tree = harness.render(Component, {
      view: 'page',
      ...(options.inject as () => Record<string, unknown>)(),
    })
    expect(findAll(tree, (node) => node.props?.className === 'dbte-banner')).toHaveLength(1)
    expect(findAll(tree, (node) => node.type === 'input')).toHaveLength(0)
  })
})

/**
 * 任务看板（PRD §6）。
 *
 * 看板是唯一会「静默坏掉」的界面：插槽名写错就整个入口消失，会话取错就会
 * 显示别人的任务，状态文案错就会让人误以为运行成功。这里把这三件事钉住。
 */
interface FakeResponse {
  ok: boolean
  status: number
  text: () => Promise<string>
}

function jsonResponse(body: unknown, status = 200): FakeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  }
}

/** 让 promise 链与 effect 队列都跑完，再渲染一次拿到新状态。 */
async function settle(
  harness: Harness,
  component: (props: Record<string, unknown>) => TreeNode | null,
  props: Record<string, unknown>,
): Promise<TreeNode | null> {
  let tree = harness.render(component, props)
  for (let pass = 0; pass < 8; pass += 1) {
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    tree = harness.render(component, props)
  }
  return tree
}

function textOf(node: unknown): string {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  const tree = node as TreeNode
  if (typeof tree.type === 'function') return textOf((tree.type as (p: unknown) => unknown)(tree.props))
  return textOf(tree.props?.children)
}

const BOARD_FIXTURE = {
  items: [
    {
      taskId: 'tsk_alpha',
      title: '每周巡检',
      status: 'active',
      revision: 2,
      stepCount: 3,
      updatedAt: '2026-11-26T10:00:00.000Z',
      trigger: 'manual',
      schedule: null,
      lastRun: {
        runId: 'run_alpha',
        status: 'succeeded',
        startedAt: '2026-11-26T09:00:00.000Z',
        finishedAt: '2026-11-26T09:05:00.000Z',
        health: 'finished',
      },
    },
  ],
  nextCursor: null,
}

describe('task board', () => {
  it('registers an entry point above the composer', () => {
    const harness = mountClient(createForm(DEFAULTS), [ROW_ID], { session: 'sess_alpha_0001' })
    const docks = registrationsFor(harness, 'conversation.composer.dock')
    expect(docks).toHaveLength(1)
    expect(docks[0]!.options.id).toBe('background-task-board')
  })

  it('asks for a session instead of guessing one', async () => {
    const harness = mountClient(createForm(DEFAULTS), [ROW_ID])
    const { Component } = registrationsFor(harness, 'conversation.composer.dock')[0]!
    const chipTree = await settle(harness, Component, {})
    const chip = findAll(chipTree, (node) => node.props.className === 'dbte-chip')
    expect(chip).toHaveLength(1)
    ;(chip[0]!.props.onClick as () => void)()

    const opened = await settle(harness, Component, {})
    expect(textOf(opened)).toContain('无法自动识别当前会话')
  })

  it('lists the tasks of the known session through the host route', async () => {
    const urls: string[] = []
    const harness = mountClient(createForm(DEFAULTS), [ROW_ID], {
      session: 'sess_alpha_0001',
      fetchImpl: (url) => {
        urls.push(url)
        return Promise.resolve(jsonResponse(BOARD_FIXTURE))
      },
    })
    const { Component } = registrationsFor(harness, 'conversation.composer.dock')[0]!
    const chipTree = await settle(harness, Component, {})
    ;(findAll(chipTree, (node) => node.props.className === 'dbte-chip')[0]!.props.onClick as () => void)()

    const opened = await settle(harness, Component, {})
    expect(urls[0]).toContain('/dsh-background-task/api/tasks')
    expect(urls[0]).toContain('session=sess_alpha_0001')
    const text = textOf(opened)
    expect(text).toContain('每周巡检')
    expect(text).toContain('活动中')
    expect(text).toContain('已完成')
  })

  it('opens a task detail with its steps and runs', async () => {
    const harness = mountClient(createForm(DEFAULTS), [ROW_ID], {
      session: 'sess_alpha_0001',
      fetchImpl: (url) => {
        if (url.includes('/task?')) {
          return Promise.resolve(
            jsonResponse({
              task: {
                taskId: 'tsk_alpha',
                title: '每周巡检',
                description: null,
                status: 'active',
                revision: 2,
                createdAt: '2026-11-20T00:00:00.000Z',
                updatedAt: '2026-11-26T10:00:00.000Z',
                steps: [
                  { stepId: 'stp_1', order: 1, title: '检查 Git 状态', required: true, retryPolicy: 'safe_retry' },
                  { stepId: 'stp_2', order: 2, title: '生成巡检报告', required: true, retryPolicy: null },
                ],
              },
              schedule: null,
              operations: [],
              runs: [
                {
                  runId: 'run_alpha',
                  taskId: 'tsk_alpha',
                  status: 'interrupted',
                  progress: 50,
                  requiredCompleted: 1,
                  requiredTotal: 2,
                  startedAt: '2026-11-26T09:00:00.000Z',
                  finishedAt: null,
                  health: 'interrupted',
                  healthLabel: '已中断',
                  needsUserConfirmation: true,
                  resumable: true,
                },
              ],
            }),
          )
        }
        return Promise.resolve(jsonResponse(BOARD_FIXTURE))
      },
    })
    const { Component } = registrationsFor(harness, 'conversation.composer.dock')[0]!
    const chipTree = await settle(harness, Component, {})
    ;(findAll(chipTree, (node) => node.props.className === 'dbte-chip')[0]!.props.onClick as () => void)()

    const listed = await settle(harness, Component, {})
    const row = findAll(listed, (node) => node.props['data-clickable'] === 'true')
    expect(row.length).toBeGreaterThan(0)
    ;(row[0]!.props.onClick as () => void)()

    const detail = await settle(harness, Component, {})
    const text = textOf(detail)

    expect(text).toContain('检查 Git 状态')
    expect(text).toContain('恢复策略 safe_retry')
    expect(text).toContain('已中断')
    expect(text).toContain('最近一次运行需要人工确认才能恢复')
  })

  it('shows the server error instead of an empty list', async () => {
    const harness = mountClient(createForm(DEFAULTS), [ROW_ID], {
      session: 'sess_alpha_0001',
      fetchImpl: () =>
        Promise.resolve(
          jsonResponse({ error: { code: 'TASK_PERMISSION_DENIED', message: '缺少会话信息' } }, 403),
        ),
    })
    const { Component } = registrationsFor(harness, 'conversation.composer.dock')[0]!
    const chipTree = await settle(harness, Component, {})
    ;(findAll(chipTree, (node) => node.props.className === 'dbte-chip')[0]!.props.onClick as () => void)()

    const opened = await settle(harness, Component, {})
    expect(textOf(opened)).toContain('缺少会话信息')
  })
})
