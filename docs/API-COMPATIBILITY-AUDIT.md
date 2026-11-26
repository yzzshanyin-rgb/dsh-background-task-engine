# API Compatibility Audit

Deliverable for PRD chapter 3 and 16.1. Everything below was verified against the
**installed** DeepSeek Harness on this machine, not against `master` docs.

## 1. Host versions

| Component | Value | How verified |
|---|---|---|
| DSH distribution | Desktop app | `DSH_PROFILE=desktop`, install dir inside `app.asar` |
| `@deepseek-ai/dsh` | **0.2.2-rc.3** | `DSH_INSTALL_DIR/package.json` |
| `@deepseek-ai/cordis` | **~4.1.0** | dependency of the above |
| `@deepseek-ai/schemastery` | 3.18.5 (resolved) | profile `node_modules`, `Schema` is the **default export**; `schema.volatile()` present |
| Node runtime | 24.13.0 (requires 22+) | `node -v`; real-host scripts run on it |
| `@deepseek-ai/dsh-settings` | bundled with 0.2.2-rc.3 | `describe()` only serves entries whose schema has a `.volatile()` field |
| `@deepseek-ai/dsh-host-webserver` | bundled with 0.2.2-rc.3 | routes registered via `webServer.register({kind:'exact', path, handler})` |
| `zod` | 3.x (profile-resolved) | profile `node_modules` |
| Profile | `~/.dsh/profiles/desktop` | `$DSH_PROFILE_DIR` |

## 2. Module resolution constraint (decisive)

The plugin is loaded from the profile, where the host's own packages are **not**
resolvable:

```console
$ cd "$DSH_PROFILE_DIR" && node -e "require.resolve('@deepseek-ai/dsh-tools')"
Error: Cannot find module '@deepseek-ai/dsh-tools'    # code MODULE_NOT_FOUND
$ node -e "require.resolve('zod')"                    # ok
$ node -e "require.resolve('@deepseek-ai/schemastery')" # ok
```

Installed third-party plugins show the same pattern: across `dsh-mnemon`,
`dsh-context`, `dsh-better-sidebar` and `dshmarket`, the only host import is
`@deepseek-ai/schemastery`.

**Consequence.** The plugin cannot `import { defineTool } from
'@deepseek-ai/dsh-tools'` the way first-party packages do. It therefore:

- declares the host contract **structurally** in `src/host.ts` (interfaces only),
- builds plain tool-definition objects matching `ToolDefinition`,
- constructs the domain spec as a plain object (the facility accepts it),
- imports only `zod` and `@deepseek-ai/schemastery` at runtime.

This is a public-shape dependency, not a private-path dependency: every shape
below is a documented export, and all of them were exercised against the real
packages (§6).

## 3. `ctx.storageDomain` — required

Source: `@deepseek-ai/dsh-storage-domain/src/{index,spec,domain}.ts`.

| Fact | Detail |
|---|---|
| Service | `ctx.storageDomain: DomainFacility`, provided by the `storage-domain` plugin with `inject: ['storage']` |
| Open | `await ctx.storageDomain.open(spec)` → `Domain`; the caller owns `domain.close()` |
| Spec | `{ name, version, layout?, compatibleVersions?, invalidRecords?, global?, tables: {name: {valueSchema}} }` — record schemas are **zod** |
| Reads | `table.get(key)`, `table.entries()`, `table.keys()`, `table.size` — **synchronous**, from memory |
| Writes | `put`, `delete`, `deleteMany`, `update(key, fn)`, all `Promise`-returning, durable before resolve |
| Atomic RMW | `update`'s mutator runs inside the domain's per-key write chain |
| Missing key | `update` on an absent key rejects with `missing-key` |
| Records | shared immutables — never mutate in place |
| Validation | `valueSchema.parse` runs **only at open** (per record); writes are not re-validated |

**`UNIT_NAME_RE` is `/^[a-z][a-z0-9_]*$/`** (`dsh-storage/src/backend.ts:10`).

> This was the one finding that only a real host uncovered: with the domain named
> `dsh-background-task-engine`, `open()` failed with
> `invalid unit name 'dsh-background-task-engine'`. The storage unit is now
> `dsh_background_task_engine` (underscores), which is deliberately different from
> the npm package name (hyphens). `createDomainSpec()` is asserted against
> `UNIT_NAME_PATTERN` in tests, and the engine re-checks every unit/table name
> before opening.

Backend routing on this profile: the base bundle configures `storage-domain` with
`backend: json`, so records land in `<DSH_HOME>/storages/<unit>.json`. The plugin
never names a backend and never touches a file.

## 4. `ctx.schedule` — optional

Source: `@deepseek-ai/dsh-schedule/src/{index,types}.ts`.

| Fact | Detail |
|---|---|
| Service | `ctx.schedule: ScheduleService` (`static inject = ['agents','sessions','storageDomain','sessionPersistence']`) |
| Create | `create({ title, prompt, timing, target? }, actorSessionId?, signal?)` → `ScheduleCatalogEntry` |
| Edit | `edit({ id, action:'update', patch:{title?,prompt?,timing?,target?,active?}, expectedUpdatedAt? })` |
| Delete | `edit({ id, action:'delete' })` → `{deleted:true}` or `{code:'schedule_not_found'}` |
| View / Run | `view({id})`, `run({id})` |
| Timing kinds | `at` / `after` / `every` / `daily` / `weekly` / `cron` / `rrule` |
| Targets | `session` / `new_once` / `new` |
| Delivery text | one-shot: `[SCHEDULE REMINDER]` + `schedule_id_json`, `occurrence_at`, `reminder_prompt_json`; batch: `[SCHEDULE REMINDER BATCH]` + `reminders_json[]` |
| Delivery ≠ completion | acknowledgements prove inbox persistence only |

**Optional-service hazard.** Cordis only exposes an injected service as a context
property. Reading `ctx.schedule` without listing it in `inject` throws
`cannot get property "schedule" without inject` — which made the first install
report `1 entry did not activate`.

The plugin therefore declares `inject: ['tools', 'storageDomain']` (both
mandatory) and resolves Schedule through `optionalService(ctx, 'schedule')`, which
tries `ctx.get('schedule')` and treats absence as "not mounted". PRD FR-012 is
honoured: manual runs work, `task_schedule` reports
`TASK_SCHEDULE_UNAVAILABLE`. Tests reproduce the throwing-property behaviour.

## 5. `ctx.tools` — required

Source: `@deepseek-ai/dsh-tools/src/{index,contracts,schema,json-schema}.ts`.

| Fact | Detail |
|---|---|
| Service | `ctx.tools: ToolsService` (`static inject = ['systemPrompt']`) |
| Register | `register(definition, options?)` → disposer; registrations die with the scope |
| Definition | `{ name, description, parameters, output:{schema, render(args,value)}, execute(args,exec) }` |
| Required at register | `output` exists, `output.render` is a function, `output.schema` passes `assertSupportedJsonSchema` |
| Output check | `validateJsonSchemaValue(tool.output.schema, value)` then `tool.output.render(...)` |
| `exec` | carries `agent` (`agent.session.id` = SessionId), `signal`, `callId` |
| `ToolSchema.parameters` | `Record<string, unknown>` — plain JSON Schema |

**Supported JSON Schema subset** (anything else throws at registration):

`type` (object/array/string/number/integer/boolean/null), `oneOf`, `properties`,
`required`, `additionalProperties`, `items`, `enum`, `const`, `description`,
`title`, `default`, `examples`.

`minLength`, `pattern`, `maximum`, `format`, `minimum`, `maxItems` are **not**
supported — all length/range/count limits are enforced in code (zod + service
guards) instead.

**Verified against the real validator**, not our own copy:

```console
$ ELECTRON_RUN_AS_NODE=1 "$DSH_NODE_EXECUTABLE" /tmp/verify-host-contract.mjs
registered: 12
schema-valid: 12/12
```

## 6. Real-host integration run

Both scripts boot the **actual** host packages
(`cordis` + `dsh-storage` + `dsh-storage-json` + `dsh-storage-domain` +
`dsh-system-prompt` + `dsh-tools`) out of the installed `app.asar` and mount this
plugin into them.

Mount + full manual loop:

```console
tools visible to model: 12
task_archive, task_create, task_get, task_list, task_resume, task_run,
task_run_begin, task_run_finish, task_run_history, task_schedule,
task_step_report, task_update
missing: none
task_create: {"success":true,"taskId":"tsk_e3daa7j8mbprgcq33tjv",...}
task_run: true running | steps: 2
  step 1: completed progress=50%
  step 2: completed progress=100%
task_run_finish: succeeded 100% | required 2/2
task_run_history: 1 run(s), first = succeeded
schedule dedupe: true | trigger: schedule | deduplicated: true
domain file: true
unit version: 1 | tables: tasks,task_runs,task_run_steps,meta
task rows: 2
meta: {"global":{"schemaVersion":1,"appliedMigrations":{}}}
```

Restart / persistence / resume (§ PRD 14.4), second process over the same file:

```console
before restart: task tsk_z98awts11jmd4w5csjhr | run run_p9yfwjfsqbszhf3cjagw
after restart: task found = true | steps = 2
after restart: runs = 1 | status = interrupted
after restart: step1 carried = completed
resume: true running | resumesRunId = true | carried = 1 | pending = 1
```

## 7. Services deliberately **not** used

| Service | Why not |
|---|---|
| `ctx.jobs` | process-level, Session-owned, not a cross-restart ledger (PRD 16.3). TaskRun lives in StorageDomain. |
| `ctx.agents` / `followup()` | A `followup` MessageId is an enqueue receipt, not a completion handle (PRD FR-005). The calling Agent executes in-line. |
| Goal / Workflow | Out of V1.0 scope; no reimplementation. |
| Private APIs | None used. No `src/` deep imports, no internal symbols. |

## 8. Profile installation

`plugin_manager install_bundle` on this workspace directory:

- manifest must nest the patch: `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`
  (a bare string is rejected with *"dsh.bundle.patch must be a file path or a list of file paths"*);
- result after the two fixes above: **`application: applied`, `warnings: []`**;
- profile row: `dsh-background-task-engine` in `dependencies` (link) **and** in
  `dsh.profile.bundles`.

## 9. Remaining known limits

1. **Schedule end-to-end delivery** could not be exercised in-process: the real
   `ScheduleService` requires `agents`, `sessions`, `sessionPersistence` and a
   session controller, which only the full application composes. Its adapter is
   covered by unit/integration tests against a double with the documented
   contract, and every host failure path is mapped to `TASK_SCHEDULE_FAILED`.
   The delivery-envelope parser is tested against the documented
   `[SCHEDULE REMINDER]` payload.
2. **`JSON` backend single-unit layout**: the whole domain is one document, so
   write cost grows with retained runs. Mitigated by the 90-day retention prune.
3. **`domain/changed` is in-process only**; a second host process sees writes
   after reopening the domain, not live.

## 10. V1.2.0 re-verification (1.2.0)

Only additive surface was used; nothing from the 1.0.0 audit changed its meaning.

| Interface | Used by 1.2.0 | Evidence |
|---|---|---|
| `ctx.storageDomain.open(spec)` with new tables | `idempotency`, `active_runs`, `run_index`, `schedule_ops` | `tests/storage/repository.test.ts` (8 tables), real-host JSON file grows to 8 units |
| `ctx.storageDomain` reopen + migrations on restart | `MIGRATIONS` ledger in `meta` | `tests/integration/reliability.test.ts` v1→v2 migration case; `docs/TEST-REPORT.md` |
| `ctx.schedule.create/edit/view/list` | schedule ledger + reconcile | `tests/integration/tools.test.ts` schedule cases |
| `ctx.webServer.register({kind:'exact', path, handler})` | `/dsh-background-task/api/*` | `tests/integration/http-routes.test.ts` (fake webServer, 5 routes) |
| `ctx.tools.register` | 14 tools | real-host script: "tools visible to model: 14" |
| `ctx.slots.register('conversation.composer.dock', …)` | task board entry | `tests/integration/client-bundle.test.ts` registers slot with id `background-task-board` |
| `configForms` + `volatile` config | config card unchanged | `tests/domain/config.test.ts`, client card tests |
| `Intl.DateTimeFormat` with IANA zones | `schedule-time.ts` | `tests/services/schedule-time.test.ts` (13 cases incl. DST) |

Two host behaviours worth recording, both discovered while building 1.2.0:

- `StorageDomain` validates unit names with `/^[a-z][a-z0-9_]*$/`, so the domain is
  `dsh_background_task_engine` (unchanged) and every new table name is snake_case.
- `slots.register` only passes what the slot renders: `conversation.composer.dock` renders
  with `{}`, so the board cannot read the session from props and must resolve it from the
  page (`__DSH_BOOT__`, URL, or a one-time prompt). It never guesses.
