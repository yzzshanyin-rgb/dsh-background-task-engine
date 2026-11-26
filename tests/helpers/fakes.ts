/**
 * Test doubles for the two host capabilities the plugin depends on.
 *
 * The fakes reproduce the documented StorageDomain semantics that the plugin
 * relies on (synchronous reads from memory, a per-key serialized write chain,
 * zod validation at the boundary, `missing-key` on update) rather than a
 * simplified map, so tests actually exercise the repository contracts.
 */

import type { DomainLike, KvTableLike, ScheduleRecordLike, ScheduleServiceLike } from '../src/host.js'

export interface FakeTableValue {
  schema?: { parse(value: unknown): unknown }
}

/** One in-memory table mirroring KvTable's API and semantics. */
export class FakeTable<V> implements KvTableLike<V> {
  private readonly records = new Map<string, V>()
  private chain: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly name: string,
    private readonly schema?: { parse(value: unknown): unknown },
    private readonly onWrite?: (write: { table: string; op: string; key: string }) => void,
  ) {}

  get(key: string): V | undefined {
    return this.records.get(key)
  }

  entries(): IterableIterator<[string, V]> {
    return [...this.records.entries()][Symbol.iterator]()
  }

  keys(): IterableIterator<string> {
    return [...this.records.keys()][Symbol.iterator]()
  }

  get size(): number {
    return this.records.size
  }

  private enqueue<T>(job: () => Promise<T> | T): Promise<T> {
    const next = this.chain.then(job, job)
    this.chain = next.then(
      () => undefined,
      () => undefined,
    )
    return next as Promise<T>
  }

  private validate(value: V): V {
    if (!this.schema) return value
    this.schema.parse(value)
    return value
  }

  put(key: string, value: V): Promise<void> {
    return this.enqueue(() => {
      this.validate(value)
      this.records.set(key, value)
      this.onWrite?.({ table: this.name, op: 'put', key })
    })
  }

  delete(key: string): Promise<boolean> {
    return this.enqueue(() => {
      const existed = this.records.delete(key)
      if (existed) this.onWrite?.({ table: this.name, op: 'delete', key })
      return existed
    })
  }

  deleteMany(keys: string[]): Promise<number> {
    return this.enqueue(() => {
      let removed = 0
      for (const key of new Set(keys)) {
        if (this.records.delete(key)) {
          removed += 1
          this.onWrite?.({ table: this.name, op: 'delete', key })
        }
      }
      return removed
    })
  }

  update(key: string, mutator: (current: V) => V): Promise<V> {
    return this.enqueue(() => {
      if (!this.records.has(key)) throw new Error(`missing-key: ${this.name}/${key}`)
      const next = this.validate(mutator(this.records.get(key) as V))
      this.records.set(key, next)
      this.onWrite?.({ table: this.name, op: 'update', key })
      return next
    })
  }

  /** Test helper: bypass the write chain (seed / simulate a crash). */
  seed(key: string, value: V): void {
    this.records.set(key, value)
  }

  snapshot(): Map<string, V> {
    return new Map(this.records)
  }
}

export class FakeDomain {
  private readonly tables = new Map<string, FakeTable<unknown>>()

  constructor(
    readonly spec: { name: string; version: number; tables: Record<string, { valueSchema?: { parse(value: unknown): unknown } }> },
    readonly writes: Array<{ table: string; op: string; key: string }> = [],
  ) {
    for (const [tableName, tableSpec] of Object.entries(spec.tables)) {
      this.tables.set(tableName, new FakeTable(tableName, tableSpec.valueSchema, (write) => this.writes.push(write)))
    }
  }

  get name(): string {
    return this.spec.name
  }

  table<V>(name: string): FakeTable<V> {
    const table = this.tables.get(name)
    if (!table) throw new Error(`domain '${this.spec.name}' declares no table '${name}'`)
    return table as FakeTable<V>
  }

  async close(): Promise<void> {}
}

/** Domain facility that hands out the same domain instance on every open. */
export class FakeDomainFacility {
  domain?: FakeDomain
  openCalls = 0

  constructor(private readonly failWith?: Error) {}

  async open(spec: { name: string; version: number; tables: Record<string, { valueSchema?: { parse(value: unknown): unknown } }> }): Promise<FakeDomain> {
    this.openCalls += 1
    if (this.failWith) throw this.failWith
    if (!this.domain) this.domain = new FakeDomain(spec)
    return this.domain
  }

  get(name: string): FakeDomain | undefined {
    return this.domain?.name === name ? this.domain : undefined
  }
}

export interface FakeScheduleOptions {
  /** Force create/edit to reject (acceptance 14.3: no false success). */
  failCreate?: boolean
  failEdit?: boolean
}

/** Minimal native-Schedule double: persists entries, honours active/timing edits. */
export class FakeSchedule implements ScheduleServiceLike {
  readonly entries = new Map<string, ScheduleRecordLike>()
  private sequence = 0
  readonly calls: Array<{ op: string; request: unknown }> = []

  constructor(private readonly options: FakeScheduleOptions = {}) {}

  async create(request: unknown): Promise<ScheduleRecordLike> {
    this.calls.push({ op: 'create', request })
    if (this.options.failCreate) throw new Error('schedule/input-invalid')
    const typed = request as { title: string; prompt: string; timing: Record<string, unknown>; target?: unknown }
    this.sequence += 1
    const id = `sch_${String(this.sequence).padStart(4, '0')}`
    const entry: ScheduleRecordLike = {
      id,
      title: typed.title,
      prompt: typed.prompt,
      status: 'active',
      scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
      target: typed.target as Record<string, unknown>,
      timing: typed.timing,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    this.entries.set(id, entry)
    return entry
  }

  async edit(request: unknown): Promise<{ id: string; deleted?: boolean; code?: string }> {
    this.calls.push({ op: 'edit', request })
    if (this.options.failEdit) throw new Error('schedule/input-invalid')
    const typed = request as { id: string; action: 'update' | 'delete'; patch?: Record<string, unknown> }
    const entry = this.entries.get(typed.id)
    if (!entry) return { id: typed.id, code: 'schedule_not_found' }
    if (typed.action === 'delete') {
      this.entries.delete(typed.id)
      return { id: typed.id, deleted: true }
    }
    const patch = typed.patch ?? {}
    if (typeof patch.active === 'boolean') entry.status = patch.active ? 'active' : 'paused'
    if (patch.title) entry.title = String(patch.title)
    if (patch.prompt) entry.prompt = String(patch.prompt)
    if (patch.timing) entry.timing = patch.timing as Record<string, unknown>
    entry.updatedAt = new Date().toISOString()
    return { id: typed.id, ...entry }
  }

  async view(request: unknown): Promise<ScheduleRecordLike | { id: string; code: string }> {
    const typed = request as { id: string }
    const entry = this.entries.get(typed.id)
    return entry ?? { id: typed.id, code: 'schedule_not_found' }
  }

  async run(request: unknown): Promise<{ id: string; code?: string }> {
    this.calls.push({ op: 'run', request })
    const typed = request as { id: string }
    if (!this.entries.has(typed.id)) return { id: typed.id, code: 'schedule_not_found' }
    return { id: typed.id }
  }

  async list(): Promise<{ items: ScheduleRecordLike[] }> {
    return { items: [...this.entries.values()] }
  }
}

/** Collects audit events emitted on the fake context bus. */
export class FakeBus {
  readonly events: Array<{ name: string; payload: unknown }> = []

  on = undefined as unknown

  emit(name: string, payload: unknown): void {
    this.events.push({ name, payload })
  }

  of(name: string): unknown[] {
    return this.events.filter((event) => event.name === name).map((event) => event.payload)
  }
}
