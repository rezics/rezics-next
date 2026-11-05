# Exercising the default worker from search outcomes

Research evidence, inspected 2026-10-27. This report proposes a test harness adaptation;
it does not change the worker contract or demonstrate a passing real-source outcome suite.
Repository observations refer to commit `b83e8ec43c3056755cc6593b35dafa2e52f2e7f0`.

## Recommendation

Give each SearchDriver factory invocation an isolated Bun fixture process and a separate
kernel-worker process, with one call to `startWorker` and one kernel DBOS launch in the latter.
The fixture process owns semantic provisioning, real Auth and kernel HTTP composition;
Auth already launches its own SDK and therefore cannot share the kernel-worker process.
Expose only existing SearchDriver operations over private test IPC. Decorate the actual
`KERNEL_WORK_MODULES` registrations in the worker process, preserving their order
and calling every original registration exactly once. Observe and wrap the search service
starter _where composeWork actually invokes it_, after SDK launch. Retain its real returned
runner and use a lifecycle slot so shutdown always stops the currently running instance.

Map indexing pause/running to the existing driver's stop/restart behavior: drain the
captured runner, then restart through that same production-registered starter when asked.
Restart only the search service, never DBOS, the default module registrations or the whole
worker. Run real `rebuildSubjects` against that child's database, real `subjectSource` and
OpenSearch client, passing the active runner's real `refresh`. Keep the existing connectivity
proxy, production kernel composition, token keys and real Auth/Access behavior.

This is a recommendation inferred from the evidence below, not an upstream DBOS testing
hook. It requires no production HTTP/admin endpoint, exported global worker controller,
SDK registry reset or production schedule changes. A small additional **test fixture
lifecycle seam** is necessary to give the default worker sole ownership of the semantic
link relay and to stop the worker before fixture database deletion.

## Repository constraints and existing behavior

These are local contracts/observations, separate from upstream recommendations:

| Evidence                                                                                                                                                                                                                                     | Consequence for the harness                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [SearchDriver](../../specs/search-driver.ts) requires an isolated migrated database, credentials, production runner and real index names per factory; actual kernel requests, real Access/Auth and production session-token retention.       | Keep provisioning and HTTP behavior; transport only actual results. Do not add source, authorization, fence or index algorithms to the fixture.                                                                                                                                                                                                                                     |
| [Kernel durable-work documentation](../../services/kernel/README.md#durable-work) specifies ordered module registration, one SDK launch, shared bounded pool, migration-owned DBOS schema, and draining on shutdown.                         | Do not launch a second worker for search or bypass module composition. Use `workerTestEnv` with fixture-specific overrides.                                                                                                                                                                                                                                                         |
| [worker.ts](../../services/kernel/src/worker.ts), `startWorker`                                                                                                                                                                              | Allocates its pool/client, composes and launches work, then starts effects and semantic-link relays. Returns only `stop`; no search controller exists on this result. Startup rejection calls cleanup.                                                                                                                                                                              |
| [registry.ts](../../services/kernel/src/work/registry.ts), `composeWork`                                                                                                                                                                     | A process-local `composed` flag is permanent, even after shutdown. It rejects a second composition. All registrations precede SDK launch; service starters execute serially only after launch. Shutdown stops services in reverse order, then drains DBOS and leaves pool/client closure to the worker.                                                                             |
| [modules.ts](../../services/kernel/src/work/modules.ts), `KERNEL_WORK_MODULES`                                                                                                                                                               | The inspected list contains accounts, rating, commerce, library, community, search, content and retention. Retain the entire imported list, including subsequent additions. Do not reproduce a hand-maintained list in the driver. Optional configuration still follows production rules.                                                                                           |
| [search/work.ts](../../services/kernel/src/search/work.ts), `searchWorkModule.register`                                                                                                                                                      | With search configured, adds one starter using real `subjectSource`, real library listing counts, real OpenSearch and production concurrency. Calling register and saving its factory alone does not run it.                                                                                                                                                                        |
| [Current search outcome driver](../../services/kernel/test/search/outcome-driver.ts)                                                                                                                                                         | Constructs a special WorkContext, captures a starter, invokes it directly and holds refresh/stop. It runs search but does not run `startWorker` or all default module services. Its pause currently stops the runner; running starts a replacement.                                                                                                                                 |
| [Semantic outcome driver](../../services/kernel/test/semantic/outcome-driver.ts), `createSemanticDriver` and `startDriver`                                                                                                                   | Owns a migrated database, real Auth provisioning, keys and kernel composition. Also starts `linkProjection` independently. Its process-global tracked-fixture set closes earlier fixtures on the next factory call. Merely adding a worker alongside it duplicates the link relay and leaves ownership ordering unresolved.                                                         |
| [Semantic Auth fixture](../../services/kernel/test/semantic/outcome-auth.ts), `sharedAuth`; [Auth host](../../services/auth/src/host.ts), `createAuthHost`; [Auth workflows](../../services/auth/src/workflows.ts), `createAccountWorkflows` | The shared host starts a real Auth DBOS runtime and has one mutable kernel binding per process. Its disposer is private; normal semantic driver close only releases the binding. Starting the kernel worker in this same process would collide with the initialized SDK. A fixture process per driver and a separate worker process isolate both SDKs and concurrent Auth bindings. |
| [worker-env.ts](../../services/kernel/test/support/worker-env.ts), [worker-env.test.ts](../../services/kernel/test/support/worker-env.test.ts)                                                                                               | Already supplies required default-worker configuration and demonstrates wrapping every default registration while forwarding the real context. Fixture-generated route/session keys and actual Auth issuer settings must override constants where shared identity matters.                                                                                                          |
| [Service lifecycle test](../../services/kernel/test/work/services.test.ts), [work support](../../services/kernel/test/work/support/runtime.ts), [process support](../../services/kernel/test/work/support/process.ts)                        | Already isolate registry tests in subprocesses and prove starter execution after launch, reverse stop order, launch/stop idempotence and rejection of recomposition. They do not expose production service controls.                                                                                                                                                                |
| [Library driver](../../services/kernel/test/library/support/outcome-driver.ts), `startExecutor`, `cleanup`, child entrypoint; [commerce driver](../../services/kernel/test/commerce/support/outcome-driver.ts), corresponding sections       | Established local examples launch the full default worker in another process and wait for IPC readiness, racing readiness with exit. Reuse the isolation/readiness pattern, not their signal-based holding, queue acceleration, clock manipulation, deleted schedules or hard-kill normal cleanup.                                                                                  |

The task describes additional semantic factories/default registration as dependencies of
the final claim. In this inspected revision there is a real semantic `subjectSource` factory
and the worker-owned `linkProjection` relay, but no separate semantic WorkModule entry in
`KERNEL_WORK_MODULES` and no `addService` registration under `src/semantic`. Treat newer
semantic service registrations as an integration prerequisite to verify on the manager's
landing revision, not as something this report can certify. The harness must automatically
forward those registrations once present and prove their starters run; it must not invent
stand-ins or silently append a private semantic module to compensate for an absent default.

## Version and source provenance

[Kernel package metadata](../../services/kernel/package.json) pins
`@dbos-inc/dbos-sdk` to **5.4.6-preview**, also resolved in [bun.lock](../../bun.lock).
The installed package's `package.json` agrees, declares MIT, Node `>=20`, and identifies
`https://github.com/dbos-inc/dbos-transact-ts` as upstream. Installed
`dist/src/dbos.js` and `dbos.d.ts` contain the shutdown/deregister/lifecycle APIs discussed here.
The [exact npm release metadata](https://registry.npmjs.org/@dbos-inc/dbos-sdk/5.4.6-preview)
reports gitHead `980dc55095f445b189aecb59e7f3334345179f65` and integrity
`sha512-91vg0zlcKYw33RB84ABeaBIxIcJ0ndVyggMMM0NRYfltTVsDr/BwDn5CJodTy3LFd3RBBXF+pI+DhRLYpdRHmw==`,
matching the lockfile. This is the release-to-source mapping, rather than assuming a version
tag exists: the attempted `5.4.6-preview` branch clone was unavailable; fetching the metadata
commit with depth one succeeded. Upstream source package metadata uses a release placeholder.

All reference repositories were shallow-cloned and read only as data. No reference
dependencies, scripts, builds or tests were installed or executed. The inspected checkouts
are retained at the reported commits under
`/home/edge/projects/rezics/rezics-next/.reference/search-worker-outcome-harness/<project>/`;
their verified licences are indexed in `/home/edge/projects/rezics/rezics-next/.reference/INDEX.md`.
The following pins make the evidence reproducible alongside the retained checkouts:

| Reference clone and commit                                     | Files inspected and licensing evidence                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dbos-transact-ts`, `980dc55095f445b189aecb59e7f3334345179f65` | `src/dbos.ts`, `src/decorators.ts`, `src/dbos-executor.ts`, `tests/shutdown_timeout.test.ts`, `tests/shutdown_db_outage.test.ts`, `tests/recovery.test.ts`, `tests/recoveryRecvWorker.ts`, `tests/eventreceiver_v3.test.ts`, `tests/helpers.ts`, `packages/kafkajs-receive/index.ts`. [MIT LICENSE][sdk-license], copyright DBOS, Inc. |
| `dbos-docs`, `5c118aacd4b07a8988c63041cf3e61482299403a`        | `docs/typescript/tutorials/testing.md`, `docs/typescript/reference/dbos-class.md`, `configuration.md`, `queues.md`, `package.json`. [Pinned tree][docs-tree] has no repository licence file or package licence field; no code-copy permission established.                                                                             |
| `dbos-demo-apps`, `5568fc9fdb61a91e6f7cb300ef6f1cd254d219a6`   | `typescript/widget-store/tests/shop-integration.test.ts` and its package metadata. [Pinned tree][demo-tree] contains no applicable repository/widget-store licence grant found; do not copy its code.                                                                                                                                  |
| `node`, `8587d711a140a4119ae784c56657c82401f884b1`             | `doc/api/child_process.md`; [LICENSE][node-license] starts with MIT terms covering Node software and associated documentation, followed by third-party notices.                                                                                                                                                                        |
| `bun`, `c643ea8c2a9da88cae7e3508d2dd95c8f5857926`              | `docs/runtime/child-process.mdx`, `docs/project/license.mdx`, [LICENSE.md][bun-license]. Bun itself is declared MIT; linked/embedded dependencies have separate licences. No third-party component code is needed here.                                                                                                                |

Patterns may be followed freely. Copy code only from MIT, Apache-2.0 or BSD sources with
attribution and the required notices. This report copies no reference implementation;
unlicensed documentation/examples remain evidence, not a source of copied fixture code.

## Upstream evidence

### Real integration and isolated lifecycle

The official [Testing & Mocking guide](https://docs.dbos.dev/typescript/tutorials/testing)
separates mocked unit tests from integration tests using real DBOS and PostgreSQL.
Its integration example shuts down before resetting the test database, configures and
launches DBOS, and shuts it down after each test. Persistent queues must be established
again after a database reset. The [pinned guide][dbos-testing] and [widget-store integration
example][demo-test] support real database lifecycle ownership, not mocked source answers.
The kernel already persists queues through its real WorkClient before SDK launch; retain
that ordering rather than grafting a second queue-registration loop from a generic example.

The pinned SDK [recovery test][sdk-recovery] uses `node:child_process.spawn` with a separate
[worker entrypoint][sdk-recovery-worker], real SDK launch and stdout readiness barriers.
It gathers stdout/stderr and awaits process close. Some worker modes intentionally exit
without shutdown to test crash recovery; that is evidence for isolation, not normal fixture
cleanup. This is stronger evidence than assuming test-runner module reloads reset DBOS.

The [SDK lifecycle implementation][sdk-runtime] uses `DBOSExecutor.globalInstance`, rejects
launch during shutdown, and makes launch on an initialized SDK a no-op. Consequently,
calling launch again does not create another independent worker. `shutdown({deregister:true})`
really exists for tests/development, clears in-process registries and invalidates old wrappers.
It does not reset the kernel's `composed` variable. `clearRegistry` is private in this release.
Neither resetting imported modules nor casting to a private reset API is a sound adaptation.

### Service controls and draining

[DBOS lifecycle documentation](https://docs.dbos.dev/typescript/reference/dbos-class)
and its [pinned source][dbos-lifecycle] document configurable workflow draining on shutdown;
without the completion timeout it does not wait. Deregistration clears in-process registrations,
not persisted schedules/queues. A caller-supplied database pool remains caller-owned
([configuration source][dbos-configuration]). The kernel already supplies its drain timeout
and closes its pool afterward; call `worker.stop()` instead of replacing this sequence.

In [SDK source][sdk-runtime], shutdown deactivates event receivers/queue dispatch, waits for
running workflows according to the timeout, then destroys the executor/database connections.
The [shutdown tests][sdk-shutdown] explicitly settle pending shutdown before another launch,
surface shutdown errors, and verify draining a child workflow started during the drain.
`isInitialized() === false` is not a completion barrier: it becomes false before draining.

`DBOS.registerLifecycleCallback` is a real API, but its [callback type][sdk-callbacks] only
has initialize, destroy and endpoint logging. [Executor source][sdk-executor] invokes those
callbacks and logs destroy errors; it does not offer per-kernel-service pause, resume,
refresh, starter enumeration or handle lookup. The [official KafkaJS receiver][sdk-kafka]
registers its own callback and settles in-flight rebuilds before disconnecting consumers.
That supports ownership of replacement resources and drain-before-close, not a hidden
search test controller. Kernel `WorkService` is a separate local lifecycle, owned by composeWork.

### Process/IPC mechanics

Official [Node child-process documentation](https://nodejs.org/api/child_process.html),
also [pinned here][node-process], says forked processes have separate memory and an IPC
channel. Message send completion is not command completion. Process `exit` can precede
stdio closure; `close` follows both. Handle spawn/send errors, exit and disconnect, and
consume output. A sent termination signal, or `killed`, does not prove the child has exited.

Official [Bun spawn documentation](https://bun.sh/docs/runtime/child-process), with
[pinned source][bun-process], provides `ipc`, `Subprocess.send`, child `process.send` /
`process.on('message')`, `exited` and `disconnect`. Bun-to-Bun IPC supports its default
advanced serialization; Bun-to-Node requires JSON serialization. Use explicit plain-data
messages here, serialize errors deliberately and await `exited` plus both output-reader
tasks. Disconnect IPC after graceful fixture closure so the channel cannot keep it alive.
No HTTP transport is necessary.

The shared pattern is an owned real runtime, explicit readiness/completion acknowledgments,
isolated durable state, and awaited teardown. None of these sources establishes an upstream
hook for controlling an arbitrary application service or authorizes bypassing default starters.

## Feasible options

| Option                                                                                                      | Assessment                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Current direct search registration/start                                                                    | Runs the real search runner, but never launches the default worker or its other services. Insufficient for the final claim.                                                                                                    |
| Same-process default worker, retain captured runner                                                         | Could cover one factory, but the permanent compose flag blocks another. SDK deregistration alone cannot fix it; concurrent fixture state and semantic fixture replacement are additional hazards. Reject.                      |
| Plain default worker child plus connectivity control only                                                   | Strong isolation and genuine defaults. Search-node down cannot mean indexing paused: it also breaks queries and causes retries. `startWorker` returns no refresh/control handle. Insufficient alone.                           |
| Stop/suspend the whole worker to pause search                                                               | Also suspends semantic/effects work and cannot provide selective refresh/rebuild control. Restarting composes/launches another runtime. Reject for indexing pause.                                                             |
| Isolated fixture process plus worker child with all-default decoration and controlled search starter        | Separates Auth's SDK from kernel's SDK and gives each factory its own Auth binding. Uses existing module injection seam, actual registrations/starters and lifecycle ownership. Recommended; no production interface addition. |
| Production worker service registry/admin endpoint, module factory dependency redesign, or new DBOS receiver | Larger production contract change without need demonstrated here. Do not adopt for this fixture.                                                                                                                               |

Use this process topology: test parent → per-driver fixture supervisor → kernel-worker child.
The supervisor's real Auth host owns its SDK; the worker child owns the kernel SDK. Never
call `startWorker` alongside `sharedAuth` in one process. A worker-only child with fixtures
in the test parent is feasible for sequential instances, but concurrent instances additionally
require refactoring the tracked-fixture set and single Auth binding. The extra supervisor
avoids that larger behavioral redesign. Requests in the supervisor still call the real
`createKernel(...).handle`; neither child starts the production HTTP server entrypoint.

## Minimal test-only adapter and operation mapping

The manager can adopt the following bounded design. These are proposed fixture changes,
not APIs that already exist, and none is implemented by this research task.

1. Start a dedicated fixture-supervisor entrypoint with Bun and IPC; it provisions Auth,
   database, proxy and kernel, then starts a distinct worker entrypoint with a unique fixture
   identity. Parent invokes SearchDriver operations in the supervisor; it forwards only worker
   controls to its child. Do not recursively spawn the entrypoint's factory. Install message/exit
   handlers before startup can finish. Keep registration-heavy worker imports in the worker
   entrypoint, separate from Auth startup. Require one SDK launch in each runtime-owning process.
2. Add a test-support lifecycle option to semantic provisioning: after setup, give the search
   fixture its actual database URL, route/session keys and Auth configuration; allow the
   separately spawned default worker to replace the helper-owned link relay; await an owned
   stop hook before releasing Auth bindings, closing pools or dropping the database. Expose
   explicit owned Auth-fixture disposal for this supervisor so host, listener, cleanup watcher
   and Auth database are also awaited before exit. The current private disposer suppresses
   errors and does not await watcher exit; strengthen the owned cleanup path for observable
   completion. Keep shared behavior for other callers. This is test support, not a kernel interface.
3. Build worker env using `workerTestEnv`, overriding database URL, shared fixture keys,
   real Auth endpoints, proxy URL and unique index prefix. Do not inherit unrelated optional
   integrations accidentally. Preserve configured production schedules and real clocks.
4. Map over the imported default module list without filtering or appending substitutes.
   Each wrapper calls the original `register` once with the original context, except for
   forwarding `addService`. Observe non-search starter completion and return its unchanged
   real service. The search wrapper
   forwards a starter to the original `addService` that awaits the real starter when launch
   invokes it, validates its control shape and captures the returned runner. Fail on zero
   or multiple expected search services; stop a newly created handle if validation fails.
5. Return a stable WorkService slot to composeWork. It delegates stop to its **current**
   runner, including a replacement after an indexing restart. Do not leave composeWork
   holding only the first runner while a newer runner can outlive worker shutdown.
   Serialize indexing transitions, rebuild and close; latch closing before enqueueing stop,
   reject later commands, make repeated close share its promise, and forbid restart after stop.
6. Send ready only after `startWorker` resolves and the expected real starter handles are
   observed. Include evidence of registration/start counts, never just imported function names.
   Readiness is lifecycle readiness, not proof that indexing has converged or OpenSearch is healthy.

The registration decoration has this shape (illustrative test-only pseudocode; slot/observation
helpers implement the validation, serialization and lifecycle rules above):

```ts
const observed = KERNEL_WORK_MODULES.map((module) => ({
  name: module.name,
  register(context) {
    return module.register({
      ...context,
      addService(start) {
        context.addService(async () => {
          const service = await start(); // Invoked by composeWork after DBOS.launch.
          recordStarted(module.name);
          return module.name === 'search' ? slot.adopt(service, start) : service;
        });
      },
    });
  },
}));
const worker = await startWorker(readWorkerConfig(env), observed, env);
```

There is no separate call to search registration or its starter before worker launch.
Every default workflow/effect/schedule registration still uses the original real context
dependencies; initial service startup occurs at exactly the production lifecycle point.
The slot changes only test-requested search stop/restart ownership, with the other returned
services untouched. Count initial starts separately from requested search restarts.

| Existing SearchDriver operation      | Test-only implementation                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `indexing('paused')`                 | Await stop of the slot's current runner and clear it only after draining. Acknowledge after completion. Preserve all other worker services/relays. Repeated pause does nothing.                                                                                                                                                                |
| `indexing('running')`                | If absent, await the captured original production starter and place its validated real runner in the slot. Do not register modules or launch SDK again. Repeated running does nothing. Propagate start rejection.                                                                                                                              |
| `searchNode('down'/'up')`            | Close/reopen the existing forwarding listener, including keep-alive connections, shared by kernel/indexer/rebuild clients. Never stop the shared OpenSearch container or fabricate search responses.                                                                                                                                           |
| `rebuild()`                          | Require a running slot; call real `rebuildSubjects` with the actual source, pool, client, prefix and runner.refresh in the worker child. Return its generation; serialize genuine RebuildError fields/rejections. No fixture generation arithmetic, source counts or no-op refresh.                                                            |
| `request`, `remove`, `globalContext` | Delegate to the existing real kernel/semantic fixture. Encode actual status/body/Headers over IPC, retaining repeated Set-Cookie values and session-token behavior. No separate authorization implementation.                                                                                                                                  |
| `close()`                            | Seal commands, settle prior operations, await worker.stop (including replacement runner) and worker-child exit, then remove only owned indices while proxy is up; close proxy and semantic/Auth/database fixtures; acknowledge completion and disconnect IPC. Parent awaits supervisor exit and diagnostics before declaring cleanup complete. |

Stop/restart retains the current driver's pause semantics and a single active search indexer.
The runner also exports `pause`/`resume`, but those leave generation discovery/retirement
active. Its discovery can replace relays while pause awaits the previous relay; it is not an
obvious discovery-quiescence barrier. Prefer the already-used drained stop/restart for this
fixture, rather than claiming it freezes discovery. Test the replacement slot explicitly.

Do not confuse runner `refresh` (generation discovery) with OpenSearch document visibility.
[runner.ts](../../services/kernel/src/search/runner.ts) serializes discovery; [indexer.ts](../../services/kernel/src/search/indexer.ts)
uses bulk `refresh=wait_for`. [generations.ts](../../services/kernel/src/search/generations.ts)
owns rebuild locks, replay freshness, per-partition reconciliation, failure reasons and atomic
alias switch. [service.ts](../../services/kernel/src/search/service.ts) and
[cursor.ts](../../services/kernel/src/search/cursor.ts) retain real signed cursor binding,
generation checks, alias caching and `as_of`. Preserve the original key ring and real elapsed
time; do not rewrite cursor payloads, force cache expiry or accelerate retirement.

## Errors, cleanup and missing decisions

Use a small request-id IPC protocol: command, completion/result, operation error and startup
error. A send acknowledgment never resolves the operation. Preserve name/message/stack,
cause/aggregate failures and rebuild reason/generation/partitions in explicit error envelopes.
Reject pending calls on child spawn/send failure, exit, disconnect or a bounded command
deadline; include retained diagnostic output. Never turn any of these into a successful empty
answer. Startup failure before ready must run owned teardown and reject the factory.

There is an existing limitation to respect: discovery and relay loops log/retry certain errors
instead of rejecting (`runner.ts`, `events/relays.ts`). Neither a resolved starter nor refresh
therefore certifies successful indexing. Keep those production retry semantics; retain logs,
propagate errors that do reject, and fail bounded real witness checks with the diagnostics.
An expected search outage may produce retry logs and must not poison a later successful resume.
If a future contract requires immediate structured reporting of every background failure,
that needs a separate explicit health/error interface decision; no such hook was found.

Attempt all owned cleanup stages and return AggregateError on failure, retaining the original
setup/operation failure. Do not drop database/index state while the child is still running.
If graceful close exceeds its test deadline, report failed cleanup, terminate only that owned
child as a fallback, await confirmed exit, then attempt state removal. A forced termination
must never count as proof that services drained. Parent disconnect should initiate owned
child cleanup; the supervisor must also stop/await its worker if its parent disconnects.
Parent-side fallback needs both owned process identities and database names/index prefix
recorded before readiness so startup failures do not make partial resources unidentifiable.

The adoption decisions are limited to the test-support lifecycle seam, all-default decoration,
and stop/restart slot semantics. Existing `startWorker(config, modules, env)` permits the
decoration; it does not guarantee service identity/control shape, so the adapter must assert
it and fail loudly on module changes. Decide this fixture seam in the final owning contract;
there is no demonstrated need to change a kernel-wide contract. Verify the additional semantic
registrations on the integrated revision before certifying their presence. Keep research
evidence here; adopted behavior belongs in the owning document.

## Exact verification to require after adoption

- **Default presence and execution:** in a fresh child, compare original registration names,
  order and counts to the imported default list, assert one SDK launch, and observe actual
  post-launch starter completions. Explicitly require search and the integrated semantic
  services, not just equality with a list that could omit them. Execute real semantic commands
  and observe a tuple/link-dependent search witness; imports and captured factories do not pass.
- **Startup failure:** invalid required worker config must reject before ready, leave no
  child/services/pools behind, and preserve the real error. Separately exercise a rejecting
  starter after an earlier service starts in a lifecycle test: earlier services stop in reverse
  order, SDK shuts down and parent rejects. This negative lifecycle fixture is not outcome evidence.
  OpenSearch down alone is not a guaranteed startup rejection because discovery catches errors.
- **Pause/resume/restart:** repeated running creates no duplicate runner; pause waits for in-flight
  batches/discovery; a committed semantic edit remains absent from the index while paused, yet
  semantic/link services continue. Running starts one replacement from the observed production
  starter and the positive witness converges. Repeat the cycle and close while paused and running.
- **Real node failure and recovery:** use the proxy, assert the actual API's specified unavailable
  responses, restore connectivity and observe genuine catch-up. Never synthesize an availability
  response in the adapter or treat a logged transient outage as permanent worker failure.
- **Rebuild and signed cursor behavior:** obtain a real cursor, rebuild with real replay/count
  reconciliation and runner refresh, assert the alias/generation changed, old cursor yields
  `409 search_restart_required`, and a fresh page succeeds. Preserve existing tampering,
  principal/query binding and pagination tests. Exercise genuine rebuild failure paths and keep
  the old alias on failure; transport reason/generation/partition diagnostics intact.
- **Finite witness convergence:** use one explicit real-time deadline per positive/negative
  observation sequence (the existing new-subject outcome uses fifteen seconds). First prove the
  positive witness is indexed; then commit edits/removal and poll actual API results for the
  specified change. Fail unexpected statuses immediately; on expiry include last real response,
  worker diagnostics and pending operation identity. Do not use endless retries, fake source
  reads, direct document writes or sleeps as evidence. Run the existing outcome and relation-facet
  suites unchanged, including paused moderation/refill, real Auth and current `as_of` checks.
- **Cleanup and multiple factories:** create/close twice sequentially in one parent, then keep
  two driver children alive together with separate databases/prefixes. Both must continue serving
  real requests; closing one must not affect the other. Exercise close during indexing pause,
  rebuild/start in flight, proxy outage, startup failure, child exit and a service-stop failure.
  Assert worker stop completes before index/DB deletion, replacement runner stop is included,
  repeated close shares completion, and no owned processes/listeners/pools/indices/databases remain.

For this documentation-only task the acceptance is solely
`test -s docs/research/search-worker-outcome-harness.md`; no runtime gate or passing real-source
claim is asserted. No production files or acceptance tests are changed.

[sdk-license]: https://github.com/dbos-inc/dbos-transact-ts/blob/980dc55095f445b189aecb59e7f3334345179f65/LICENSE
[sdk-runtime]: https://github.com/dbos-inc/dbos-transact-ts/blob/980dc55095f445b189aecb59e7f3334345179f65/src/dbos.ts
[sdk-callbacks]: https://github.com/dbos-inc/dbos-transact-ts/blob/980dc55095f445b189aecb59e7f3334345179f65/src/decorators.ts
[sdk-executor]: https://github.com/dbos-inc/dbos-transact-ts/blob/980dc55095f445b189aecb59e7f3334345179f65/src/dbos-executor.ts
[sdk-shutdown]: https://github.com/dbos-inc/dbos-transact-ts/blob/980dc55095f445b189aecb59e7f3334345179f65/tests/shutdown_timeout.test.ts
[sdk-recovery]: https://github.com/dbos-inc/dbos-transact-ts/blob/980dc55095f445b189aecb59e7f3334345179f65/tests/recovery.test.ts
[sdk-recovery-worker]: https://github.com/dbos-inc/dbos-transact-ts/blob/980dc55095f445b189aecb59e7f3334345179f65/tests/recoveryRecvWorker.ts
[sdk-kafka]: https://github.com/dbos-inc/dbos-transact-ts/blob/980dc55095f445b189aecb59e7f3334345179f65/packages/kafkajs-receive/index.ts
[docs-tree]: https://github.com/dbos-inc/dbos-docs/tree/5c118aacd4b07a8988c63041cf3e61482299403a
[dbos-testing]: https://github.com/dbos-inc/dbos-docs/blob/5c118aacd4b07a8988c63041cf3e61482299403a/docs/typescript/tutorials/testing.md
[dbos-lifecycle]: https://github.com/dbos-inc/dbos-docs/blob/5c118aacd4b07a8988c63041cf3e61482299403a/docs/typescript/reference/dbos-class.md
[dbos-configuration]: https://github.com/dbos-inc/dbos-docs/blob/5c118aacd4b07a8988c63041cf3e61482299403a/docs/typescript/reference/configuration.md
[demo-tree]: https://github.com/dbos-inc/dbos-demo-apps/tree/5568fc9fdb61a91e6f7cb300ef6f1cd254d219a6
[demo-test]: https://github.com/dbos-inc/dbos-demo-apps/blob/5568fc9fdb61a91e6f7cb300ef6f1cd254d219a6/typescript/widget-store/tests/shop-integration.test.ts
[node-process]: https://github.com/nodejs/node/blob/8587d711a140a4119ae784c56657c82401f884b1/doc/api/child_process.md
[node-license]: https://github.com/nodejs/node/blob/8587d711a140a4119ae784c56657c82401f884b1/LICENSE
[bun-process]: https://github.com/oven-sh/bun/blob/c643ea8c2a9da88cae7e3508d2dd95c8f5857926/docs/runtime/child-process.mdx
[bun-license]: https://github.com/oven-sh/bun/blob/c643ea8c2a9da88cae7e3508d2dd95c8f5857926/LICENSE.md
