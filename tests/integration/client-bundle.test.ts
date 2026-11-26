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

/** Minimal function component runtime: enough for `useState` / `useEffect`. */
function createReact() {
  const states: unknown[] = []
  const effectDeps: Array<unknown[] | undefined> = []
  let cursor = 0
  let dirty = false
  let effects: Array<() => void> = []

  const React = {
    createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): TreeNode {
      const next: Record<string, unknown> = { ...(props ?? {}) }
      if (children.length > 0) next.children = children.length === 1 ? children[0] : children
      return { type, props: next }
    },
    useState(initial: unknown) {
      const index = cursor++
      if (!(index in states)) states[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial
      const set = (value: unknown) => {
        // React semantics: an updater function receives the previous value.
        const next = typeof value === 'function' ? (value as (prev: unknown) => unknown)(states[index]) : value
        // Object.is guard: an identical snapshot must not schedule a render, or a
        // subscribe-then-set effect would spin forever.
        if (Object.is(states[index], next)) return
        states[index] = next
        dirty = true
      }
      return [states[index], set]
    },
    useEffect(effect: () => unknown, deps?: unknown[]) {
      const index = cursor++
      const previous = effectDeps[index]
      const changed =
        deps === undefined ||
        previous === undefined ||
        previous.length !== deps.length ||
        deps.some((value, at) => !Object.is(value, previous[at]))
      effectDeps[index] = deps
      // Dependency tracking matters: without it the draft-sync effect would
      // rewrite state on every pass and never settle.
      if (changed) effects.push(effect as () => void)
    },
  }

  function render(component: (props: Record<string, unknown>) => TreeNode | null, props: Record<string, unknown>) {
    for (let guard = 0; guard < 50; guard += 1) {
      cursor = 0
      dirty = false
      effects = []
      let tree = component(props)
      // The published entry point is a thin wrapper (`ConfigCard`) that delegates
      // to the hook-using component; expand such function elements in place so
      // their hooks keep the same cursor as the rest of the pass.
      for (let depth = 0; depth < 8 && tree !== null && typeof tree === 'object' && !Array.isArray(tree); depth += 1) {
        const node = tree as TreeNode
        if (typeof node.type !== 'function') break
        tree = (node.type as (props: Record<string, unknown>) => TreeNode | null)(node.props as Record<string, unknown>)
      }
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

function mountClient(form: FakeForm, served: string[]): Harness {
  const source = readFileSync(CLIENT_ENTRY, 'utf8')
  const { React, render } = createReact()

  let definition: { id: string; factory: (require: (id: string) => unknown) => unknown } | undefined
  const windowStub = {
    __ModuleLoader__: {
      load(next: { id: string; factory: (require: (id: string) => unknown) => unknown }) {
        definition = next
      },
    },
  }
  // The bundle is a plain script (not a module): it installs itself on `window`.
  new Function('window', source)(windowStub)
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

  const forms = {
    get(namespace: string) {
      servedWith.push(namespace)
      return form
    },
    whileServed(namespaces: string[], register: (served: Set<string>) => unknown) {
      return register(new Set(served))
    },
    describe: () => ({ getSnapshot: () => ({ view: undefined }) }),
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

describe('client bundle registration', () => {
  it('loads itself under the package name', () => {
    const harness = mountClient(createForm(DEFAULTS), [ROW_ID])
    expect(Object.keys(harness.module)).toContain('load')
  })

  it('registers the bundle configuration card under the package name', () => {
    const harness = mountClient(createForm(DEFAULTS), [ROW_ID])
    expect(harness.registrations).toHaveLength(1)
    const options = harness.registrations[0]!.options
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

  it('stays out of the summary view', () => {
    const harness = mountClient(createForm(DEFAULTS), [ROW_ID])
    const { Component } = harness.registrations[0]!
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
