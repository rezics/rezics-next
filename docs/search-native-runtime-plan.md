# Default public query and preparation runtime plan

Status: complete composition proposal, pending adoption by the affected owners.
This document specifies the missing default bindings and freezes future native outcomes.
It supplies no runtime, native feasibility, API, worker, growth or product-completion evidence.
Formatting acceptance checks only this artifact.

The reader's job is to obtain a useful public catalogue page, continue it safely, and recover
after preparation, privacy repair, worker loss or a generation change.
An admitted finite query must eventually fill its page or establish real exhaustion.
Readiness remains explicit while its necessary native evidence is unavailable.

## Authority and selected boundary

[Filtered lists](filtered-lists.md) owns meaning, useful pages, freshness and numerical budgets.
The [consumer contract](../services/kernel/src/search/public-filter-consumer-contract.md)
owns capture, execution, repair, status and the canonical queried observation.
The [Source contract](../services/kernel/src/semantic/public-filter-source-contract.md)
owns public projection, privacy append, native cuts and complete dependency routing.
[Custody](../services/kernel/src/search/public-filter-custody.md) owns immutable retained state.
[Search](../services/kernel/src/search/README.md) owns the native writer and generation lifecycle.
[Search conditions](search-conditions.md) owns confidential continuation and retained-query constraints.
Those authorities remain single-copy contracts; this proposal selects their composition.

Keep the existing consumer-mechanics writer and native Source-binding writer.
They implement their existing contracts and receive the joins selected below.
There is one consumer engine, one native Source binding and one custody store.
Do not replace these with a composition-local evaluator, acknowledgement table or query store.
An unlanded producer is a delivery prerequisite, not a reason to leave this design incomplete.

The default population is the adopted Global public subject catalogue for accepted meaning/type.
It includes relevant excluded originals and their foreign dependencies.
It is not a caller-selected Collection, Zone, owner library or arbitrary Source object.
Those consumers retain their owning admission and integration obligations.
No new authorization, disclosure, rights, deletion or account rule is selected here.
Existing native decisions are called and their failures preserved.

All new names and cross-owner changes in this document are **proposals pending owner adoption**.
The callable-versus-proposed distinctions below apply to every fenced signature and brief.
No example is an imported test module or a successful executable port.

## Callable declarations and producer handoff

The following distinctions are part of the implementation contract, not a source inventory.

| Surface | Present callable or declaration | Composition decision |
| --- | --- | --- |
| Search custody | `search/public-filter-custody.ts:createPublicFilterCustody(pool)` and `readPublicFilterConsumerCustody(pool, request, context)` are callable | Reuse their native records and keyed join. |
| Consumer mechanics | `PublicFilterConsumerOperationsFactory` is a declared type; `search/public-filter-consumer.ts:createPublicFilterConsumerOperations` is its selected future export | The existing mechanics writer implements it; the default wrapper supplies trusted inputs. |
| Public Source | `PublicFilterSourceFactory` declares `{pool, routeKey, access}`; `semantic/public-filter-source.ts:publicFilterSource` is the selected future export | Instantiate it in trusted composition, once per runtime configuration. |
| Native Source identity and population join | Reader-only `PublicFilterSource` does not declare these complete operations on this base | The Source-binding writer supplies the additive owner proposal below. |
| Cold subject keys | `SubjectSourceKeyPages` is the required producer surface named by this plan; no such callable declaration is present on this base | Adopt the explicit bounded shape below with Semantic; never guess a factory export. |
| Ordinary subject reads | `semantic/search-source.ts:subjectSource(pool, routeKey)` returns actual `SubjectSource` | Keep it for native disclosure and ordinary writer reads; never infer key paging from `read/count`. |
| Default indexing | `search/work.ts:searchWorkModule.register` calls actual `startSearchIndexing` | Install population and repair through that real starter. |
| Rebuild | `search/generations.ts:rebuildSubjects` is callable | Replace its count-only publication decision with the shared population/activation bridge. |

The requested `public-filter-custody-contract.md` spelling is absent on this base.
The actual adjacent authority is `public-filter-custody.md`, linked above; its TypeScript contract exists.
There is no import from the absent Markdown path and no substitute runtime inferred from it.

`PublicFilterQueriedObservation` remains exactly the consumer-contract export.
Semantic imports/re-exports that one type unchanged.
PIT and prepared branches do not acquire a second observation representation.
`PrivacyReductionStart` remains a native retained-cut locator.
It is not a transaction ID, timestamp, ordinary partition position or vector of heads.

The existing consumer factory inputs remain `pool`, `source`, `search`, `clock`, `context`,
`physicalTarget` and `meaning`, as declared in `public-filter-consumer-contract.ts`.
Do not add public caller arguments for incarnation, source identity, read definition or ACK.
The factory's initial context bounds construction; each later method receives its own deadline.
Domain time comes from `KernelClock`; actual request/worker deadlines use wall time.
The wrapper cannot turn a domain-clock adjustment into more execution time.

## Whole implementation slice: default request binding

Estimated implementation: 800–1,500 changed lines including native acceptance and wiring.
Deliver the default constructor, native request adapter, joined boundary and all call sites together.
The existing consumer-mechanics implementation remains a prerequisite owned by its writer.
Do not split this slice into a factory that no default request calls and a later wiring task.

### Trusted constructor and output

Select proposed module `services/kernel/src/search/public-filter-runtime.ts`.
Select proposed export `createDefaultPublicFilterRuntime` with the following trusted inputs.
The signature is a proposal, not an available export.

```ts
type DefaultPublicFilterRuntimeConfig = Readonly<{
  pool: Pool;
  routeKey: Uint8Array;
  access: Access;
  search: OpenSearch;
  prefix: string;
  clock: KernelClock;
}>;
```

The server supplies the actual pool, canonical 32-byte route key, public native Access,
configured OpenSearch client, validated prefix and installed domain clock.
The worker supplies the same configuration from `WorkContext` and its native Access composition.
`publicFilterSource({pool, routeKey, access})` is constructed inside this module.
No HTTP body, cursor, plugin or service caller supplies that Source.
Do not accept arbitrary `PublicFilterSource` injection in this default constructor.
Existing protocol fixtures may continue to construct the lower-level factory directly.

The Source instance owns its pool/routing/Access binding.
Matching JavaScript method shapes or object identity does not establish that native binding.
Source's existing native binding writer resolves current owner/configuration on each operation.
The wrapper does not cache permission results or manufacture Source identity strings.

Select this proposed internal output; it is never a public DTO.

```ts
type DefaultPublicFilterRuntime = Readonly<{
  bindRequest(
    request: Readonly<{
      plan: PublicFilterConsumerCaptureInput;
      snapshot: 'pit' | 'prepared';
    }>,
    context: PublicFilterConsumerContext,
  ): Promise<Readonly<{
    operations: PublicFilterConsumerOperations;
    capture: PublicFilterConsumerCapture;
  }>>;
  close(): Promise<void>;
}>;
```

`bindRequest` resolves the active physical generation through trusted lifecycle state.
It resolves accepted immutable release and type from the admitted shared semantic request.
For an untyped catalogue query, the native Source's configured population meaning supplies type scope;
do not invent one type from the first hit or expand a type union into independent unchecked reads.
It checks that lifecycle registration accepts the resolved meaning and physical target.
It constructs the declared consumer factory with those exact values and calls `capture`.
`operations` and `capture` belong to that one native binding and deadline.
The service closes request-owned resources in `finally` after disclosure or failure.

A configured release change during binding produces typed readiness or a fresh binding attempt
within the original deadline and charged work; no mixed-release success is possible.
Existing valid immutable meaning remains usable only where its native registration accepts it.
Changing meaning, expanded AST, text, order, size or keyset requires a new capture.
No caller passes a physical generation as authority; authenticated continuation only supplies a guard.
An actual generation change retains `409 search_restart_required` for an old continuation.

### Immutable definition resolution

Adopt this additive operation on the native Source-binding writer, with the proposed name
`resolvePublicFilterDefinition`; it is not an export observed on this base.
It belongs on the trusted Source returned by `publicFilterSource`, not on a new registry service.
Its exact public type must be adopted in `semantic/public-filter-source-contract.ts` before import.

```ts
resolvePublicFilterDefinition(
  request: Readonly<{
    meaning: PublicFilterProjectionMeaning;
    capture: PublicFilterConsumerCaptureInput;
  }>,
  context: PublicFilterConsumerContext,
): Promise<
  | Readonly<{ status: 'bound'; definition: CustodyDefinition;
      cost: PublicFilterCost }>
  | PublicFilterConsumerUnavailable
>;
```

This selects plumbing into the existing native Source binding, not a second identity writer.
The binding producer reads the actual registered public population and current configuration.
It verifies `meaning.digest` against the exact immutable release through existing release semantics.
It validates that the accepted read definition covers the actual admitted capture.
It derives complete dependency keys from shared compiler inputs and native order declarations.
It returns `CustodyDefinition` with actual source `id`, `partition`, `epoch`, `configuration`,
native `readDefinition`, exact `meaning`, copied `capture` and complete `dependencyKeys`.
No input supplies those outputs or a claim that they are valid.
Cost includes definition resolution and its registration maintenance; binding is not free metadata.

The consumer calls custody `register` with that definition, the trusted physical target and
actual consumer/projection generations resolved from the native lifecycle.
Custody observes the index UUID, stores the copied immutable definition and returns registration/consumer.
The Source binding independently validates the definition when joining it later.
Custody's structural validation is not native Source authorization or population coverage.
Same-name target recreation cannot inherit registration, observation, execution or covered cut.

The lower-level factory's existing `source` argument remains for its owner and fixtures.
The default wrapper's closure prevents default callers from selecting an alternative Source.
The consumer-mechanics writer consumes the adopted binding method instead of reconstructing it.
If binding is unready, capture returns the existing typed reason and actual cost.
No guessed `registerSource`, `getPublicCatalogue` or alternate factory import is permitted.

### Capture admission and dependency closure

`search/service.ts:validate` continues to parse with existing `parseFilter` and `parseText`.
`admitQuery` expands saved filters with the exact accepted release through `admitFilter`.
Retain the expanded `FilterDocument`, not the saved name or compiled DSL alone.
The consumer independently rejects remaining saved references and every OwnerLeaf before native I/O.
Use `walkFilter` across all NOT, OR, nested and qualifier branches.
No positive-only leaf list or caller-provided dependency array can narrow observation.

The native plan is derived with existing `compileFilter` and `compileText` settings.
Preserve `prefix: 'f'`, `relationOverflow: true`, `field: 'search_text'` and `prefix: 't'`.
Optional `SearchPlan` compiled fields are compatibility evidence and must match derivation.
`filterDocument` and `text` are required own input fields, each explicitly allowing undefined.
A JavaScript compiled-only object rejects before Source, custody or engine work.
Copy AST, text, sort, size, keyset, derived plan and accepted meaning before returning capture.
Mutation of caller-owned arrays or nested objects afterward has no effect.

Dependency closure includes every filter property, implicit type and same-statement qualifier property.
It includes text labels, aliases and descriptions according to the complete parsed grammar.
It includes native name/id tie breakers and all admitted functional-order inputs.
Rating order retains Global standard-question/population/prior metadata and its phase guards.
Collection-count order retains its actual public count dependencies.
No new functional order becomes admitted merely because a dependency-key type can name it.
The Source binding resolves native keys; the wrapper does not map labels to guessed properties.

Admission covers filter, actual Source and order together.
A supported bounded direct plan captures a PIT only after population and registration are complete.
A supported prepared plan returns a real persisted repair locator until its immutable output is complete.
An unsupported shape returns existing `422 unsupported_query` before enumeration.
Do not accept a direct shape solely because a LIMIT or timeout will stop expensive work.
Do not turn lack of an admitted retained definition into endless preparation.

#### Cost

- Touches: shared parse/admission, accepted release, native Source definition, lifecycle registration,
  custody capture and exact physical index metadata, including rejected binding attempts.
- Bound: all binding/capture work is inside the direct or ready page's existing totals: 12 statements
  per backend, one connection per backend, and the candidate/point/row/byte ceilings stated below.
  Initial population or definition maintenance uses separately charged preparation steps, never a request scan.
- Growth check: fix page size and expand definitions, history and population at 64/512/4096;
  capture raw statements, examined/removed rows, blocks, bytes and engine metadata requests across binding plus read.

### Joined start, execution and final observation

Extend the existing `readPrivacyReductionHeads` declaration with this proposed joined request branch.
Preserve the existing home and consumer/start branches for their declared diagnostic uses.
They cannot authorize the default queried read.
Do not add a parallel head-observation function or a second queried-observation type.

```ts
type JoinedPopulationRequest =
  | Readonly<{ kind: 'queried'; phase: 'start';
      queried: PublicFilterQueriedObservation }>
  | Readonly<{ kind: 'queried'; phase: 'final';
      queried: PublicFilterQueriedObservation; execution: string }>
  | Readonly<{ kind: 'queried'; phase: 'status';
      queried: PublicFilterQueriedObservation }>;
```

The joined branch receives the actual `PublicFilterConsumerContext` as its second argument.
The owning declaration supplies overloads so legacy diagnostic callers retain their existing shape.
Its result uses existing `PrivacyReductionObservation` and actual counted work.
The Source-binding writer resolves through actual `readPublicFilterConsumerCustody`.
At start it joins definition, queried tuple and observation's original covered cut.
It validates native source/configuration/meaning/read-definition ownership against its own binding.
It records the actual retained native start before engine execution and returns that start.
No current-live ACK can replace the observation's covered cut.

The consumer acquires a durable custody use before external execution.
It runs the retained native PIT/prepared query with complete-shard validation.
After execution, it appends one immutable `CustodyExecution` under that use.
That record contains actual execution `id`, returned start and actual original/terminal own-row pairs.
Append it only when the full own-row set for this native execution is known.
Do not append an empty placeholder and later mutate it into a different execution.
No caller-provided subject array enters the final join.
An empty engine result still creates a real execution with an empty own-row set.

At final, Source joins the exact observation and that exact execution in custody.
It revalidates retained start and covered cut using a fresh commit-visible native observation.
The native Source producer supplies indexed scoped behind/changed access and complete routing.
The wrapper neither chooses an XID algorithm nor installs a global serializer.
Lower allocated transactions committing after start must remain detectable.
Changed reductions remain detectable if repaired and ACKed before final.
A new execution on an unsafe old PIT/prepared observation also remains blocked.

`readStatus({queried, execution}, context)` is the consumer's final entry point.
It returns diagnostic `covered`, `pending`, `changed` and classified `blocking` from actual state.
`pending` may be empty while the old immutable observation remains unsafe.
`readStatus({queried}, context)` uses the status branch, never an invented execution/start.
An unknown execution, mismatched observation or lost native cut produces honest unavailable/readiness.
The public adapter accepts only the result joined to its own actual execution.

Filter/order narrowing uses the complete retained definition and actual foreign-to-source routing.
It covers excluded subjects and negative/disjunctive branches, even with zero returned rows.
Every returned original AND terminal independently receives all-key own-row checks.
An unrelated property on an excluded subject may be irrelevant after complete routing proves that fact.
An unrelated property reduction on a returned own row remains relevant to disclosure.
Unresolved routing, missing owners or a late incomplete registration blocks publication.
There is no caller allow flag, ACK setter, supplied refresh receipt or safety Boolean.

Current Source/Access/field/figure checks still run before public disclosure.
They do not replace population coverage, and population coverage does not replace them.
Request-level summaries are filled before the last disclosure boundary.
If a reduction lands during summary/field work, final revalidation sees it.
The adapter must not return a service page that the route later enriches after final validation.
Select a service-owned completion callback for the existing route `fill` work, described below.

#### Cost

- Touches: retained observation and execution joins, native start/final coverage, scoped routing,
  original/terminal checks, actual engine execution and final field/summary disclosure.
- Bound: privacy coverage shares at most two statements and `64 + 2*(behind homes + changed homes)`
  examined rows once per page across all reads; separate own-row work remains in whole-page totals.
  All capture, metadata, execution writes and repeated work remain inside 12 statements per backend for one read.
- Growth check: capture query plus `readStatus` inclusively at 64/512/4096, with zero-hit negative
  exclusions, reduce-then-ACK, old-observation reuse, foreign changes and exact role SQL attribution.

### Request envelope and route closure

`services/kernel/src/server.ts` owns default construction beside current `createSearchService`.
Pass the actual installed clock as well as pool/client/prefix/routeKey/native Access.
Do not silently use a separate clock or a test Source in server composition.
Select an internal `publicFilters` option on `createSearchService`, supplied by the new runtime.
An injected historical service can preserve its own existing test construction contract;
it must not be registered as the default public native runtime by a WeakMap side door.

The existing `search` method retains principal/request/domain-time arguments for cursor compatibility.
Add a trusted internal read context carrying actual `job.deadline` and completion work from the route.
Proposed name: `PublicSearchReadContext`, declared in `search/service.ts`.
Its fields are `deadline` and `complete`, where `complete(page)` runs current summary enrichment.
`complete` is installed by `search/http/routes.ts`; it is not body JSON or a permission callback.
It cannot approve publication, change query keys or supply a start/cut/ACK.
The service runs it before the final joined status and returns only after final disclosure succeeds.
If it fails, discard the whole public response and release observation resources.

Move the current outer `fill(await search.search(...))` into that completion phase.
Preserve its real `authorize`, released summary semantics and batch accounting.
Retain the route's native authentication, suspension, Global eligibility and admission checks.
Invalid credentials never downgrade to anonymous during binding or preparation.
Do not pass the request actor's private statement-reader context as public Source authority.
The public Source explicitly retains public audience inside an editor request.

The `search` method passes expanded AST/text and the actual sort/size/keyset to capture.
It no longer executes a raw `searchSubjects` path around the public consumer for default requests.
The mechanics writer still owns native search/refill/disclosure behavior.
The adapter translates captured/preparing/unready/unavailable into existing public outcomes.
`preparing`, relevant blocking and ordinary lag over five minutes map to `503 index_not_ready`
with the existing Retry-After behavior; no successful empty placeholder page is returned.
Source-owner unavailability keeps the existing `semantic_not_ready` distinction where applicable.
Malformed request/cursor remains 400; authenticated stale continuation remains 409.
Unsupported combined execution remains 422 before enumeration.

Public success remains `{subjects, next, as_of}`.
Do not expose consumer, execution, observation, PIT, job, cuts or native Source metadata.
Keep unsafe internal `SearchResult.total` out of the public envelope.
Preserve omitted facet counts; a diagnostic clean status cannot authorize aggregates.
`as_of` reflects actual source-to-searchable freshness, not last request time or engine refresh time.

`suggest` and `facets` are existing public consumers, not permission to bypass the default binding.
Adapt suggestion's bounded native plan through the same trusted population/start/final machinery.
Preserve its at-most-ten results and at-most-twenty candidate native bound.
The existing facets producer keeps its own aggregate/population proof and disclosed-value checks.
Use the same final completion boundary for any labels or summaries it reads.
Do not pretend this hit-only composition establishes safe totals or new kind-count support.
If a facet plan lacks its required safe proof, retain explicit readiness and the frozen aggregate cases.
No successful old raw path is left enabled merely to make historical mocks pass.

Confidential cursors keep the actual existing codec and rating guards.
Do not add PIT/observation/job locators to `after`, including encrypted fields.
Decode/authenticate the original request and principal before native lookup.
Resolve a new request-bound observation for each continuation against current accepted binding.
The existing generation, comparator and rating guards decide restart compatibility.
Within one request, every refill remains on its captured immutable physical observation.
An unsafe old request observation is abandoned; do not silently replace it mid-execution.

### Request state and cleanup

| State | Entry evidence | Next transition | Public effect |
| --- | --- | --- | --- |
| Validated | Parsed request and authenticated route admission | Bound or rejected | No membership disclosed. |
| Bound | Native accepted Source/meaning/physical target | Captured or preparing | No Source metadata exposed. |
| Captured | Complete registration plus actual PIT/prepared observation | Started | Immutable request input retained. |
| Started | Native joined start and acquired use | Executed or failed | No candidate response yet. |
| Executed | Retained actual execution and own rows | Completed fields, then final | No unsafe partial response. |
| Final | Joined current evidence plus current disclosure | Served or preparing | Filled page or proved exhaustion only. |
| Closed | Uses drained and exact observation released | Terminal | Shared generation/build remains owned. |

Failures before registration leave no observation to close.
Failures after PIT creation but before custody commit release the actually opened PIT.
Ambiguous creation is resolved by the custody writer's owned-locator recovery, not an invented ID.
Every acquired use is released in `finally`, including engine or completion callback failures.
`closeObservation` affects only that exact tuple after in-flight operations drain.
Factory `close` drains its local work and owned transient observations, preserving durable shared repair.
Supplied pools, Source and OpenSearch belong to the host and remain open until host shutdown.

#### Cost

- Touches: native route admission, request-bound observation, engine refills, current disclosure,
  summaries, cursor guards and idempotent close/release, including all failed rounds.
- Bound: standalone `s` is 1–100; direct candidates `c <= min(600, 6s+3)`, at most three
  refills of `2*remaining+1`, six engine searches and two searches per round; ready reads use
  at most `2s+2` candidates and two index reads. Neither path has an extra composition allowance.
- Growth check: first/deep/sparse native API pages at 64/512/4096, authenticated and anonymous,
  with summary-time reductions, aborted requests, missing shards, cursor maxima and failed cleanup.

### Request-slice files and generated closure

Implement `search/public-filter-runtime.ts` and adopt its narrow trusted constructor/output.
Update `search/service.ts`, `search/http/routes.ts` and `server.ts` at the call sites above.
Update `search/public-filter-consumer-contract.ts/.md` only through their owner for adopted joins;
the mechanics writer remains the sole writer of `search/public-filter-consumer.ts` behavior.
Update `semantic/public-filter-source-contract.ts/.md` through Semantic for binding/join declarations.
The existing Source-binding writer implements them in `semantic/public-filter-source.ts`.
Use `public-filter-custody.ts` and its actual joined read; avoid copying retained-state SQL.

Reconcile `search/service-scope.ts:createSearchScopeForService` with the installed runtime ownership.
It remains an honest closed scope until its owning native scope producer is implemented.
Do not register an injected clone or make constructor ownership a readiness proof.
`search/scope-source.ts` retains its own declared scope budget and admission semantics.
Other Zone, TypeList and Collection consumers import the adopted capability when their owners bind it.
They do not gain default-catalogue evidence merely by sharing this service object.

Keep HTTP response shapes unchanged, including count omission and existing Problem variants.
Run `services/kernel/scripts/openapi.ts` only in the later implementation if route declarations change,
using the owning documented generation command; review the generated schema and client diff together.
Do not hand-edit generated client shapes or widen DTOs to carry internal locators.
The artifact-only change here generates no runtime/client/schema files.

Future acceptance files are `test/search/default-public-filter-runtime.test.ts` and
`test/search/default-public-filter-routes.test.ts`, under `services/kernel/`.
Keep existing `test/search/public-filter-consumer.test.ts` and custody cases unchanged.
Default binding acceptance must enter real `startKernelServer`/kernel routes, not a fixture-only factory.
The fixture may observe original starters and native traffic without replacing producers.

## Whole implementation slice: background initialization and activation

Estimated implementation: 800–1,500 changed lines including SQL, native tests and default wiring.
Deliver cold population, event replay, identified reconciliation and atomic activation together.
The ordinary indexer remains the only document writer; preparation invokes its owned apply path.
No population-only alternate serializer, direct bulk fixture or independent checkpoint store is selected.
The Source key-page writer supplies native enumeration, not a product list endpoint.

### Background-only key enumeration input

`SubjectSource.read(partition, ids)` requires known IDs and has a 256-ID native-call limit.
`count(partition)` cannot enumerate cold input or prove exact identity coverage.
Select the producer-declared `SubjectSourceKeyPages` boundary as the background input.
Because its callable shape is not in this base, adopt the following proposed shape in
`services/kernel/src/search/source.ts` with the Semantic producer before importing it.
Do not dynamically try several export names or assert a reader-only object has this method.

```ts
interface SubjectSourceKeyPages {
  readSubjectKeyPage(
    request: Readonly<{
      partition: number;
      epoch: number;
      after: string | null;
      through: bigint;
      inputLimit: number;
    }>,
    context: PublicFilterConsumerContext,
  ): Promise<
    | Readonly<{ status: 'progress' | 'complete'; partition: number;
        epoch: number; through: bigint; keys: readonly string[];
        after: string | null; cost: PublicFilterCost }>
    | Readonly<{ status: 'changed' | 'gap'; cost: PublicFilterCost }>
    | PublicFilterConsumerUnavailable
  >;
}
```

`readSubjectKeyPage` is an explicitly proposed method, not a landed callable assertion.
Semantic's existing key-page producer may adopt an equivalent declared name before consumption;
that adoption updates all references in this whole slice together, not runtime export guessing.
The selected construction is additive capability on the native `subjectSource(pool, routeKey)` result.
Do not add a separate public `keySource` factory or caller-selected population.
The worker receives the owner-adopted intersection `SubjectSource & SubjectSourceKeyPages`.
The default request runtime receives no key-page capability.

The native key access path is `(partition, subject key)` with a real bounded keyset frontier.
It includes originals that are currently hidden, redirected or otherwise ineligible for public output.
The ordinary Source decides whether each known key emits a terminal document or requires withdrawal.
The frontier advances on examined input, including rejects, not only on indexed output.
Lookahead is charged and is not consumed past an unprocessed key.
`through` is a source-log bridge boundary, not a claim that the entire snapshot was frozen at that position.
The producer must detect log retention gaps and epoch changes explicitly.
Unavailable or missing owner cannot be converted into a complete empty page.

### Capture, scan and replay bridge

Select proposed `search/public-filter-population.ts` for orchestration only.
It uses the current native generation lifecycle and durable work infrastructure.
Persist population/frontier state under the lifecycle writer's actual generation/incarnation control.
Extend that writer's retained frontier rather than creating another coverage store.
Do not revive `subject-coverage-v1`, home certificates or the superseded coverage-store ABI.
Existing unavailable coverage helpers are not a ready runtime to call around this gap.

The durable population input is a generation locator and exact native physical UUID.
It also retains consumer/projection generation, accepted meaning and current phase/frontier revision.
A work item carries only this locator, never copied facts, caller subject lists or claimed completion.
The lifecycle resolves its own retained input before every step.
Wrong incarnation, retired generation or changed accepted meaning rejects that attempt before writes.

For each native home, retain the real ownership epoch and capture ordinary event-log start position A.
Arm replay/retention before the cold key walk so changes during scanning cannot fall into a gap.
The Source owner supplies the existing native creation/change path for every subject key.
The ordinary log must include new keys and withdrawals, not just currently positive indexed subjects.
Persist capture plus replay intent atomically in the existing home-local owner transaction.
No connection stays checked out while another owner or OpenSearch is contacted.

Walk the finite keyset using background-only `readSubjectKeyPage`.
Call ordinary native Source reads in chunks of at most 256 IDs, including every tail.
Use each chunk's actual `SubjectSnapshot.position` as its own external-version input.
Do not stamp all chunks with A, the last chunk's position or a foreign privacy head.
Use existing bounded name normalization and exact keyed sink result validation.
All local and dependent projection work is part of the charged step.

At keyset exhaustion, capture home log position B and replay `(A,B]` through the same writer.
Apply records idempotently with current native source reads and fenced external versions.
An insert behind the already-scanned key frontier is found through this replay.
A delete after the scan is likewise replayed as actual current withdrawal.
A key created after B belongs to ordinary catch-up before activation/freshness permits disclosure.
Do not infer a bridge from timestamps, counts or `max(subject_id)`.

Persist one atomic step completion after every sink operation required by that step is resolved.
The frontier never jumps beyond unexamined input or an unconfirmed sink effect.
An ambiguous HTTP response retains the actual attempted key range and unresolved native work.
Replay re-reads at most that one step's input; it does not restart all completed homes.
The ordinary 64-envelope relay limit remains separate from key/input and Source-call ceilings.
An event batch with many subjects still chunks all subject calls and settles every tail.

At an epoch move, retain the old frontier and resolve the new native owner.
If the owner's bridge preserves `(A,B]`, resume against that verified continuation.
If the bridge reports a gap, quarantine that home/build and establish a new complete bridge there.
Already settled unaffected homes remain settled; do not restart the entire generation.
No partial generation becomes public while any home has a gap, unknown ownership or unresolved intent.
The finite-progress claim assumes finite ready input and eventually stable required ownership/I/O.

#### Cost

- Touches: all finite native homes in background, keyed cold input, ordinary source/event replay,
  exact-version sink actions, retained step/intent and dependency registration, including failed work.
- Bound: each step reads at most 1,000 input candidates/keys, writes at most 1,000 result rows and
  one frontier, uses at most 16 statements/backend, four engine searches, one connection/backend,
  `64+16*input` examined rows, six blocks/budgeted row, eight points/input and 4 MiB response bytes.
  Source calls remain at most 256 IDs; ordinary event batches remain at most 64 envelopes.
- Growth check: 64/512/4096 keys, history and changed-key axes, with behind-frontier inserts,
  replay gaps, moved owners, each tail failure and crash at every sink/frontier handoff; total work is linear.

### Identified reconciliation and activation

The native lifecycle records completion only after cold scan, replay and dependency registration settle.
Reconcile actual expected source keys against actual target keys in bounded indexed pages.
Include missing and extra identities, redirects, hidden originals and canonical terminal uniqueness.
Equal per-home counts are a useful diagnostic and are insufficient publication evidence.
The actual generation UUID and accepted projection meaning participate in every retained completion check.
No caller boolean, external job status or successful `repairStep` alone marks the generation complete.

Select an activation bridge inside the existing `search/generations.ts` lifecycle writer.
Proposed internal operation name: `activatePublicSubjectGeneration`.
Its input is only the retained generation locator plus actual deadline.
It resolves retained completion, native target identity, all-home reconciliation and writer custody itself.
It returns active generation/previous generation only after observing the actual alias outcome.
It does not accept counts, covered heads, caller completion flags or an index name as evidence.

Before publication, the native writer establishes that all required local and foreign repairs are visible.
It validates consumer/projection/source binding and accepted meaning against the actual incarnation.
It verifies every dependent source's own anchored version advancement where foreign repair required it.
It verifies actual refresh and complete-shard success; a same-version 409 is insufficient.
It joins the existing writer/retained-copy custody barrier against delayed older requests.
Do not invent a token store, permanent soft tombstone or different engine to replace that barrier.
If the owning writer has unresolved custody, activation remains explicitly unavailable/preparing.

Switch the alias atomically only after the bridge has proved its native prerequisites.
Alias publication and SQL finalization cannot be one distributed transaction.
Persist activation intent before external alias I/O and observe actual alias state afterward.
Crash before alias effect resumes the same intent; crash after effect finalizes from native observation.
An ambiguous response never causes name reuse, blind inverse writes or a success receipt.
Concurrent publishers use the lifecycle's current control revision and physical identity checks.
A losing publisher reads the actual winner before deciding whether its own intent is superseded.

Retain the previous public generation for the existing retirement grace and cursor semantics.
The current native maximum remains three live subject generations per prefix.
Admission refuses another generation when the lifecycle cannot retire enough owned resources safely.
Do not increase that limit to hide slow cleanup or a stranded building generation.
Retirement fences new uses/writes, drains admitted old operations and releases actual owned references.
Delete only the exact owned physical target and retire its checkpoint/registration after real custody drains.
Prevent accidental late auto-creation through the existing subject auto-create restriction.
Never reuse a physical generation name whose uncertain writes have not been resolved.

The current runner creates and aliases an empty first generation during discovery.
Replace that path: creation enters populating, and the shared bridge alone may install the first alias.
Until then, default routes return explicit readiness.
This also applies to an existing empty target created before the new runtime starts.
Opening an index, installing mapping or reaching a relay checkpoint is not population completeness.
The bridge also gates rebuild publication; first start and rebuild cannot diverge here.

#### Cost

- Touches: bounded source/target key reconciliation, actual physical metadata, retained activation intent,
  alias publication/observation, native writer drain and owned-generation retirement.
- Bound: reconciliation, repair and cleanup remain separately resumable preparation steps under the
  exact 1,000-input/1,000-output/one-frontier and 16-statement ceilings; at most three live generations.
  Engine refresh, drain and delete work is counted native work, not constant-cost metadata permission.
- Growth check: 64/512/4096 expected/extra keys and retained writer attempts; equal-count wrong-key,
  empty-target, ambiguous alias, concurrent activation, actual pruning and late-write schedules discriminate safety.

### Default worker, rebuild and process closure

`work/modules.ts:KERNEL_WORK_MODULES` keeps the full original module list and order.
`worker.ts:startWorker` remains the default process owner; do not add a second DBOS launcher.
`composeWork` invokes each real register once and launches real service starters after DBOS launch.
The existing `searchWorkModule.register` reads `readSearchConfig(context.env)` and canonical route key.
It installs the shared Source, public-filter runtime and population/repair service in that original starter.
Native Access must come from the actual kernel worker Access composition, not `anonymousAccess` as an allow-all.
Any new trusted `WorkContext` input for that native Access is an owner-adopted composition change.
Do not read an Access implementation, actor or domain clock from environment strings.

Use the existing maintenance queue and its concurrency two for background durable continuations.
The real relay/indexing concurrency stays two as currently configured by `search/work.ts`.
Do not create a new queue, timer-only work registry or unlimited background pool.
Durable work carries generation/job locators and resolves native input on each continuation.
Use deterministic existing work identity/intent delivery so commit-versus-enqueue loss is recoverable.
A status response or request disappearance is not cancellation of persisted shared population work.

The runner's `refresh()` discovers/advances the shared lifecycle and schedules bounded work.
It does not synchronously enumerate all homes or block a request on a full rebuild.
`pause()` stops admitting Search work and drains all admitted Search work, including discovery replacements.
`resume()` restarts through the same original starter/runtime after that drain completes.
Semantic services, DBOS and unrelated workers remain active during Search-only pause.
`stop()` is idempotent and targets the current replacement runner, not a captured obsolete instance.
Worker shutdown drains services before closing WorkClient and pool as it does today.
Committed frontiers and shared observations survive process exit; local handles do not claim ownership forever.

`generations.ts:rebuildSubjects` keeps its real public rebuild result and failure envelope.
Replace readiness based on `readFreshness` plus quiet equal-count rounds with population bridge completion.
Retain native failure reasons and timeout/deadline behavior where their meaning remains valid.
Release database checkouts before waiting on Source, engine or another owner.
The existing session advisory-lock connection must not span the external rebuild loop;
move exclusion into the existing durable lifecycle control/intent ownership, without a new lock service.
Rebuild joins or resumes the actual building generation and its retained bridge.
It must not reset checkpoint rows to manufacture a replay.

`services/kernel/scripts/search.ts:rebuild` uses the same canonical key and shared runtime constructor.
The current no-op `runner.refresh()` is not evidence that population/activation work ran.
The CLI requests/joins the durable lifecycle and lets the default worker execute it.
Its wait observes real persisted progress/active alias until completion or its actual deadline.
A missing worker returns timeout/readiness with retained work; it never locally fakes activation.
No production admin HTTP route or private fixture-only rebuild implementation is needed.

`test/search/support/outcome-worker.ts` observes the real default starter in place.
`test/search/outcome-driver.ts` and its adapter use real commands, Source and rebuild.
Keep Auth's SDK in its owning supervisor and kernel's SDK in its worker child.
Observe every original default registration without filtering or replacing it.
Search-only pause/resume/restart and real elapsed-time convergence enter those paths.
Do not manually start a dormant Semantic producer to make a default-worker test pass.

### Background-slice files and generated closure

Add orchestration in proposed `search/public-filter-population.ts`.
Update existing `search/runner.ts`, `search/work.ts` and `search/generations.ts` call sites.
Update `scripts/search.ts:rebuild` to join the same lifecycle.
Extend the existing lifecycle-owned migration/SQL files for bridge/frontier/intent fields as needed;
the owning writer selects their migration filename, not a guessed pre-existing table.
Declare `SubjectSourceKeyPages` in `search/source.ts` through the producer owner.
Implement the native key page in `semantic/search-source.ts` and its owning keyed SQL.
Do not import the superseded `coverage.ts` coordinator as a population implementation.

Reconcile `search/indexer.ts` only to expose/reuse its current bounded owned apply path.
Keep exact per-chunk source versions, current fences, normalization and keyed write outcomes.
Do not fork `write-actions.ts` behavior for cold population.
Any required typed SQL changes generate their owning `db/search` or `db/semantic` artifacts
through the kernel's existing SQL generation command and include generated imports in typechecking.
No new package dependency, external service or generated public API is selected.

Add `test/search/default-public-filter-population.test.ts` and
`test/search/default-public-filter-activation.test.ts` with the frozen scenarios below.
Extend the real-worker fixture lifecycle, not the existing frozen acceptance assertions.
Keep `rebuild-custody-native.test.ts`, source-batch and keyed-writer cases as regression acceptance.
An owner must reconcile any frozen obsolete protocol test separately; this slice cannot weaken it.
All call-site changes and generated output belong in the same native whole slice.

## Whole implementation slice: freshness and retained useful-page recovery

Estimated implementation: 800–1,500 changed lines including retained phases, native cases and wiring.
Deliver sparse-page preparation, dependency repair, freshness observation and crash cleanup together.
Reuse the consumer's persisted repair job and custody's prepared observation/reference store.
The runtime adapter schedules/resolves that work; it does not implement another matcher or result engine.

### Admission, retention and quota boundary

Separate three lifetimes: a transient request observation, a shared admitted prepared definition,
and one immutable prepared generation retained for current readers.
Default cursors carry no native observation locator, so a finished request does not pin its PIT for fifteen minutes.
Close transient request observations after final disclosure/failure, including every refill use.
The existing custody lease expires at the request deadline, at most five minutes.
Enforce that same actual deadline on engine calls; lease expiry does not cancel an unbounded native request.

Shared public preparation uses at most one current and one building generation per admitted read definition.
This is the existing public-result ceiling, not two generations per cursor or principal.
Changed keyset/size gets its own immutable capture; it cannot mutate an accepted definition.
A retained prepared build can be shared only where the native Source binding establishes
the exact definition/build relationship, including the capture's complete meaning and ordering.
Do not infer sharing from equal DSL or from the first page's returned rows.

Public-query retention needs native principal-class quota and a global admission cap before writes.
`docs/search-conditions.md` explicitly withholds a free public retained store.
No numeric public quota is declared by this proposal; copying the owner allowance would invent permission.
Select native definition admission from the existing configured/released read-definition registry.
Only definitions with a current retention grant may create or keep a shared prepared generation.
The grant is resolved internally with the actual definition; no request supplies it.

The grant must cover anonymous or authenticated principal class, global definition capacity and expiry.
The existing registration owner records reservation/use/release in its own custody-backed lifecycle.
It does not create an independent quota engine or a second result store.
Concurrent identical requests join the same admitted job and consume no duplicate building slot.
A new definition without a native grant performs no retained write.
If a direct plan is bounded it still runs transiently; if preparation is essential it rejects
`422 unsupported_query` at admission rather than accepting work that can never finish.
Temporary exhaustion of an existing grant returns the native overloaded/readiness outcome.

This is an adoption obligation on the native Source/definition owner, not a hidden runtime default.
The concrete implementation accepts only the owner's issued grant, not a caller-chosen numeric budget.
Tests install genuine native admitted definitions/grants through that owner's configuration path.
They do not mint a successful grant in a mock to bypass missing policy.
The existing HTTP normal admission of eight permits and queue of thirty-two is process request control;
it is not a cluster-wide retained-state quota and cannot be relabelled as one.

Owner preparation remains at most 32 live prepared owner results per owner, least-recently-read eviction.
Idle prepared results expire after 24 hours under Filtered lists.
The public current/building rule and the owner's 32-result rule remain separate.
Expiry never extends a grant, native observation TTL or source authority implicitly.
Read activity updates native last-read only after valid admission, without creating another generation.
Quota loss prevents new admission and initiates bounded retirement of owned disposable state.
It does not erase shared facts, cancel a domain command or issue an erasure-complete receipt.

#### Cost

- Touches: native definition/grant resolution, current/building slots, last-read/expiry index,
  transient observation leases and bounded admission/eviction/retirement work.
- Bound: public results retain one current plus one building generation per admitted definition;
  owner results retain at most 32 per owner and idle expiry is 24 hours. Request admission remains
  eight normal/two reserved permits with queue 32; none of those numbers grants extra retained public capacity.
- Growth check: 64/512/4096 unrelated definitions and expired entries with fixed admitted neighbourhood;
  test native quota refusal before writes, concurrent coalescing, crash after reservation and bounded expiry pages.

### Retained preparation and sparse-page recovery

The consumer returns `preparing` with its actual `PublicFilterConsumerJob`.
The default adapter persists/delivers locator-only durable intent through existing work infrastructure.
`repairStep(job, context)` resolves the actual retained plan, frontier, Source input and sink receipts.
The caller supplies neither candidate rows nor a head to acknowledge.
The worker does not treat `status: 'settled'` as permission to publish.
Only the native consumer/lifecycle writer commits its proven prepared generation and covered cut.

The retained build phases are admitted, collecting, projecting, ordering, reconciling,
catching-up, publishable, current, retiring and retired.
These are proposed persisted phase names in the existing consumer job, not a second runtime API.
Each phase records one durable frontier and settled effects before yielding.
Required native steps can subdivide a phase without resetting prior settled input.
The consumer uses its existing shared compiler/matcher/native index operations for membership and order.
No raw caller vector or final request-time full-fact replay becomes the prepared engine.

Collect relevant finite source input through the background bridge and admitted access path.
Project complete selected-public-facet pages with `readPublicFilterProjectionPage`.
`inputLimit` counts rejected, reread, duplicate and lookahead input as well as output.
Dependency-heavy inputs yield retained phases before exceeding their point/row budget.
An unknown dependency cannot be permanently skipped or converted to false under NOT.
Actual unready owners yield without advancing past the unresolved key.
Fair durable scheduling revisits it when native readiness changes.

Order and canonicalize through maintained native indexes, not an in-memory sort of every match per read.
Retain unique canonical subject rows per generation with original/terminal support ownership.
Prepare once over relevant finite input; total work is linear in that input, with native ordering work charged.
Do not allocate one witness mirror per built-in read or inspect every identity alias on each request.
Scoped identity publication uses the owning native source dependencies, including excluded/order-only inputs.
Continuous disjoint identity jobs cannot keep an unchanged finite source preparing forever.

Reconciliation establishes complete membership/ordering and source bridge completion.
Publish immutable prepared rows only after local/foreign repairs, routing and native visibility settle.
Use custody `retainPrepared` with actual registration, covered cut, build, bigint generation,
original/terminal row ownership and expiry; a partial row set cannot be retained as complete.
Do not create an unbounded SQL parameter containing the whole build to evade step limits.
If the current custody batch interface cannot retain a large native build in bounded pages,
extend that same custody writer with staged bounded input and atomic immutable finalization.
That owner-adopted extension must preserve existing exact-retry/different-row-set rejection.
Do not replace its immutable representation with a mutable cache in this adapter.

A read from current prepared output observes a new execution start and final join as for PIT.
It uses at most `2s+2` candidates and two native index reads to fill or prove exhaustion.
If disclosure changes cause more rejection, return readiness and enqueue targeted repair.
The client receives no advancing raw cursor through an empty/non-useful successful page.
After finite repair on finite ready input, repeat admission obtains a useful page or true exhaustion.
No repeated restart from zero is permitted for a retained admitted build.

#### Cost

- Touches: retained consumer job, complete projection pages, canonical ordered rows, dependency indexes,
  reconciliation, immutable prepared retention and sparse read/refill, including all replayed input.
- Bound: preparation is at most 1,000 inputs, 1,000 result writes, one frontier, eight points/input,
  `64+16*input` examined rows, six blocks/budgeted row, 16 statements/backend, four engine searches,
  one connection/backend and 4 MiB responses/step; replay rereads at most one step. Ready reads use existing ceilings.
- Growth check: finite sparse prefixes, statement degree, canonical support, page depth and history at
  64/512/4096; sum actual build work and replay input, then require filled or genuinely exhausted API output.

### Targeted privacy repair and acknowledgement

Reduction append remains in each authoritative native domain transaction under the Source contract.
This composition does not edit authorization, consent, rights, account or deletion decisions.
The Source log records real effects only; no synthetic reduction is injected to wake the worker.
Native restore/discovery also maintains dependency routing so formerly ineligible input can return safely.
Append and registration maintenance remain their owners' atomic obligations.

The consumer's repair job follows indexed affected source keys and retained definition dependencies.
Read only prepared results whose admitted leaves/order/source dependencies are affected.
Do not scan all prepared definitions or every foreign owner to discover work.
Subject-wide changes reach every applicable source key; selected ineligible input remains in internal routing.
A foreign target's changed property is not necessarily the affected source property.
Unresolved routing keeps that work blocked without declaring it irrelevant.

LOCAL repair rereads current complete native public projection and applies actual source version.
FOREIGN repair first causes/observes the dependent source's own anchored version advancement.
It then writes that source's repaired body to every required physical consumer generation.
Every chunk's actual source version is independent of privacy-log position.
Refresh waits/explicit refresh and complete-shard outcomes establish actual searchable winner visibility.
409, checkpoint CAS, returned `progress` or a diagnostic zero-pending result is insufficient evidence.

Advance a contiguous consumer-specific privacy prefix only after persisted native work settles.
The exact tuple includes physical UUID, consumer/projection generation, meaning and read definition.
Late dependency registration reopens required work through the native registration barrier.
An ambiguous or lost writer attempt remains owned until its actual effect is resolved.
The native writer's all-writer custody must prevent old resurrection after finite delete-version pruning.
No composition code publishes an assumed ACK or compensates with a permanent tombstone.

An old PIT/prepared observation cannot be repaired in place or borrow the live consumer's newer ACK.
Retire it and capture a new immutable observation after real repair/visibility is established.
Prepared recovery builds/reuses the current native replacement generation under the same admitted definition.
An old execution stays bound to its original covered cut/start until it closes.
Status after process recovery resolves that same retained tuple, not whatever live target is newest.

#### Cost

- Touches: indexed affected keys/definitions, native LOCAL and FOREIGN projection, source-own version
  advancement, keyed sink winner/refresh, persisted repair frontiers and contiguous ACK maintenance.
- Bound: every repair phase obeys the preparation ceilings; no background work is uncharged.
  Query privacy remains two statements and `64+2*(behind homes+changed homes)` rows shared once/page,
  inside whole-read limits. ACK/registration maintenance receives no new fanout or numerical allowance.
- Growth check: 64/512/4096 history/keys/definitions and increasing real reduction rate; measure native
  repair latency and served share, all-writer custody after actual pruning, late registration and automatic FOREIGN repair.

### End-to-end freshness and recovery state

Ordinary catalogue edits become filterable within 60 real seconds in healthy operation.
Actual source-to-searchable lag above five minutes returns readiness.
Measure ordinary source commit, relay/dependent projection, prepared publication and searchable visibility.
The existing `freshness.ts` outbox/checkpoint observation remains input, not the complete freshness proof.
A recent engine refresh or prepared row timestamp cannot hide a stalled dependency.
Privacy reductions have no grace period even when ordinary freshness is otherwise acceptable.

Select proposed `search/public-filter-freshness.ts` as the adapter over existing native observations.
Its input is retained definition/generation/job locators plus actual context, never caller timestamps.
Its result is internal current/preparing/unavailable state, actual `asOf` and counted work.
It derives freshness from the same source/bridge/projection/publication lineage used by activation.
Do not introduce a competing freshness store or infer complete coverage from `behind === 0`.
Request and worker resolve the same persisted state after restart.

| Condition | Retained action | Request result | Recovery end |
| --- | --- | --- | --- |
| Cold population incomplete | Resume actual phase/frontier | Index readiness | Identified activation. |
| Direct page hits work bound | Join admitted prepared job | Explicit readiness | Useful prepared page. |
| Current prepared output safely within ordinary lag | Keep current and repair building | Current disclosure still required | Replacement publishes. |
| Actual ordinary lag exceeds five minutes | Retain targeted catch-up | Readiness | Searchable lineage catches up. |
| Relevant privacy reduction | Block affected snapshot and repair | Readiness immediately | New covered immutable observation. |
| Irrelevant reduction with complete routing | Continue scoped read | Useful page permitted | Repair proceeds independently. |
| Engine PIT lost/expired | Close that tuple and recapture next request | Readiness/restart as applicable | New actual PIT. |
| Prepared build expired or grant revoked | Retire exact generation | Readiness or admission rejection | Re-admission or bounded cleanup. |
| Worker crash | Replay retained unfinished step | Honest persisted state | At most one step reread. |
| Source gap/epoch change | Quarantine affected bridge | Readiness | Re-established native bridge. |

Prepared replacement uses atomic generation publication in the existing job/custody writer.
The old current generation remains available only while disclosure, expiry and freshness all permit it.
Do not return old membership under an `as_of` label after a relevant reduction.
No ordinary freshness timeout permits disclosure of revoked facts, order or negative membership.
Continuous unrelated changes do not restart a finite unaffected build or invalidate its scoped basis.

#### Cost

- Touches: source commit/bridge/projection/preparation/searchable lineage, native current-generation
  control and scoped dependency readiness, including retry/failure observations.
- Bound: freshness observation shares existing request/page budgets; no full population scan or extra
  connection is allowed. Recovery phases use preparation ceilings; healthy ordinary convergence is 60 seconds,
  and lag over five minutes yields readiness, with no privacy grace period.
- Growth check: real-clock default-worker captures at 64/512/4096 with growing reduction rate,
  paused relay/dependency/preparation stages, fixed sparse neighbourhood and non-falling served share.

### Crash cleanup and resource ownership

Use existing custody state and indexed expiry/retirement frontiers to discover abandoned native resources.
No global SQL scan of every observation or a process-local timer as sole cleanup authority.
Close admission to an expired/retired observation, drain its actual durable uses, then release its owned PITs.
Renewal winners and losing PIT locators remain owned until their exact observation drains.
Factory disposal does not delete committed state needed by another process's recovery.

Cleanup is a durable bounded job on the existing maintenance queue.
Each step resolves its own registration/observation/generation locator and retained frontier.
Delete child execution/reference/PIT/prepared ownership rows in bounded indexed batches before parent roots.
Never rely on an unbounded cascade to satisfy a cleanup step budget.
An engine close/delete failure retains retryable ownership and cannot be marked closed by elapsed time alone.
Missing native PIT after a confirmed exact-tuple probe is treated by custody's existing loss semantics.
An unconfirmed network failure is not confirmed loss.

Recovery crashes are distinct: intent before enqueue, use before engine I/O, effect before receipt,
receipt before frontier, prepared finalize before publication and alias effect before SQL finalization.
Each has a retained native locator and idempotent next transition described in the owning slice.
No retry may expand its deadline, borrow a later covered cut or silently discard earlier partial work.
Replay visits only the unfinished bounded step; other settled phases stay settled.

The host closes runtime/services before supplied pool and engine client disposal.
Signal during launch waits for admitted startup work and drains any actual replacement runner.
Tests stop only processes/resources they own; default-worker supervision preserves SDK process ownership.
Cleanup failure is reported with the original failed operation and retained resource locator internally.
Never expose those native locators on the public route.

All retained definitions, executions, query text, source locators and prepared rows remain under
their existing all-role custody/minimization/erasure inventory obligations.
No unknown inventory is declared empty or erased by this proposal.
The runtime publishes its exact store-owned locators to the owning inventory integration.
This selects composition ownership only; it does not design a new account/deletion workflow.

#### Cost

- Touches: indexed expired/retiring resources, actual reference leases, owned native PITs,
  execution/prepared children, retained cleanup frontier and durable retry intent.
- Bound: cleanup obeys the same preparation step ceilings, including failed closes/repeated drains;
  one retained frontier/step and at most one replay step. Existing TTLs and native quota grants are not extended.
- Growth check: 64/512/4096 abandoned resources/history with fixed cleanup batch, crash at each
  child/parent boundary, concurrent renew/close, engine loss, stale owner and supplied-resource shutdown ordering.

### Recovery-slice files and generated closure

Add proposed `search/public-filter-freshness.ts` and reuse `public-filter-runtime.ts` adapters.
Update `search/work.ts` to schedule existing consumer repair and expiry through maintenance.
Update `search/freshness.ts` only to expose/use owning inputs without making outbox lag the whole proof.
Extend `search/public-filter-custody.ts` and its native SQL only through that owner for
bounded staged prepared retention, expiry traversal and cleanup where the current callable is insufficient.
Do not change its immutable definition/execution semantics to make recovery simpler.

The consumer-mechanics writer owns retained job phases and real PIT/prepared replacement.
The Source-binding writer owns native grant/definition validation and narrowed routing inputs.
The native lifecycle writer owns activation and all-writer/retained-copy drain.
This slice wires their actual outputs rather than adding independent completion/ACK flags.
Changes to their adopted declarations and generated SQL travel with each coherent implementation.

Add `test/search/default-public-filter-recovery.test.ts` and
`test/search/default-public-filter-growth.test.ts` with all frozen scenarios below.
Keep existing source, disclosure, identity, rating, cursor and custody acceptance unchanged.
Update `test/search/support/outcome-worker.ts` and outcome-driver lifecycle support as needed.
No browser stories, UI component or new public preparation polling endpoint belongs in this slice.
Existing callers retry the original request under existing readiness/retry semantics.

## Literal page budget and capture contract

Every operation above has a Cost subsection; these shared literal ceilings are authoritative inputs.
Let `s` be requested slots and `c` be actual candidates examined, including rejects/lookahead/duplicates.
Direct catalogue reads allow at most `min(600, 6s+3)` candidates and six searches.
Ready prepared reads allow at most `2s+2` candidates and two index reads.
Both retain at most `16+8c` Access/dependency points and `64+16c` examined SQL rows.
Blocks are at most six per budgeted examined row.
Response bytes across SQL/engine are at most `16 KiB + 4 KiB*c`.
Request bytes across SQL/engine are at most `64 KiB + 1 KiB*c`.
One read uses at most twelve statements/backend and one connection/backend for the whole page.

Composed admission is at most sixteen reads and 128 total slots.
It shares fixed page work rather than repeating start/final or summary batches per read.
Its statement ceiling is `8+4R` per backend, at most 72 at sixteen reads.
At the maximal all-direct page: 816 candidates, 6,784 points, 14,080 rows and 96 engine searches.
The fixed privacy subset remains two statements and `64+2*(behind homes+changed homes)` rows.
Its logical coverage is all 4,096 homes through indexed scoped access, never a 4,096-head scan.

Use exact leading SQL role comments `/* semantic.privacy-start */` and
`/* semantic.privacy-final */`; separate own-row SQL starts `/* semantic.own-rows */`.
A merged final/own-row query charges its full plan to coverage.
Missing attribution/native plans fails capture; it is not zero measured work.
Match every occurrence of statements/plans/backend IDs, including repeated and nested work.
Count connections, SQL/parameter/result bytes, engine requests and failed/replayed operations.
Engine iterator work sums actual `next_doc_count` plus `advance_count` over all query nodes/shards.
For fixed page neighbourhood, it must be constant/logarithmic in population and matches.
Do not subtract capture/registration/cleanup scheduling to make a read fit.

Preparation's literal per-step ceilings apply to initialization, replay, repair and cleanup alike.
Input at most 1,000; result writes at most 1,000; frontier writes at most one.
Points at most eight/input; rows at most `64+16*input`; blocks six/budgeted row.
Statements at most sixteen/backend; searches at most four; connections at most one/backend.
Response bytes at most 4 MiB; total relevant input linear and replay at most one step.
No unlimited engine scan, sort, aggregation or refresh becomes free because SQL uses a keyset.

## Frozen future native acceptance scenarios

These are complete frozen scenario contracts to materialize in the exact test files above.
They are fenced specifications in this artifact, not executed acceptance or placeholder imports.
Use real native producers and ordinary semantic commands through the default worker/API.
Missing actual producers fail explicit assertions before success claims; no skip/todo fallback.
Primitive property fixtures prove protocol mechanics only; released product fixtures keep their owner acceptance.

### Default binding and immutable request cases

```text
File: test/search/default-public-filter-runtime.test.ts
Case: default factory binds its actual native Source
Given the actual pool, canonical route key, native public Access, prefix, engine and clock,
construct the real default runtime and admit an ordinary public catalogue query.
Observe publicFilterSource construction with those exact trusted objects/configuration.
Attempt an alternate Source/physicalTarget/consumer/ACK in JavaScript request input.
Require input rejection or ignored transport-unknown fields before native capture, never source selection.
Require custody's immutable source/configuration/meaning/read-definition to match the native binding.
Require native physical settings UUID, not alias/name equality, to identify the consumer.

Case: complete semantic capture and immutable input
Install a valid public saved filter through the ordinary release path and expand it with admitFilter.
Include NOT, OR, same-statement qualifiers/units, text, implicit type and functional-order dependencies.
Capture; mutate caller AST/text/keyset/release objects; require unchanged retained definition and execution.
Change size/keyset/text/order in another request; require a distinct immutable capture binding.
Pass compiled-only input or mismatching compiled DSL; require rejection before native I/O.
Put OwnerLeaf under NOT, OR and saved expansion; require the same early rejection in every position.

Case: native Source revalidates custody ownership
Attempt a copied fixture definition with another source ID/configuration/release/type.
Require Source binding rejection despite structurally valid custody records.
Move/unavailable native owner and change actual configuration; require typed readiness/unavailable.
Do not infer success from matching readDefinition strings or function identities.
```

```text
File: test/search/default-public-filter-routes.test.ts
Case: default request reaches native capture/start/final
Start the real kernel server and full default worker; use ordinary API commands for fixture edits.
Request anonymous and account pages through POST /v1/subjects:search.
Observe actual factory, immutable observation, joined start, native execution and joined final.
Require filled requested slots or native proven exhaustion and no internal locators in response/cursor.
Require unchanged {subjects,next,as_of}, current labels/facts/figures and omitted unsafe totals/counts.
Reject expired/revoked/suspended credentials according to native Auth before public binding.

Case: final includes route summary work
Pause the response after real summary/field reads begin but before disclosure completes.
Commit a native relevant privacy reduction, allow real repair/ACK, then release final observation.
Require readiness or safely recomputed new request, never disclosure from the old observation.
Repeat with a hidden original and independently hidden terminal; neither can pass via the other.

Case: complete public entry-point closure
Exercise search, suggest and existing facets through their actual registered routes.
Require native population/current-disclosure barriers and each route's own bounded plan/proof.
No legacy raw-engine bypass, totals substitution or mocked native Source can satisfy the case.
Malformed/tampered/mismatched cursors remain 400; authenticated expired/changed guards restart with 409.
Preserve rating phase/question/population/prior and maximal existing cursor capacity cases unchanged.
```

### Capture/start/final race cases

```text
File: test/search/default-public-filter-runtime.test.ts
Case: reduce then ACK before final is still changed
Capture a real PIT and start execution; pause before its final joined observation.
Commit a relevant excluded-subject reduction, complete actual LOCAL/FOREIGN repair and native ACK.
Require final blocking despite current pending being empty; returned set may be empty.
Start another execution on that same old PIT; require the same immutable covered-cut protection.
Repeat on a real immutable prepared build/generation, not a supplied array adapter.

Case: commit visibility differs from allocation order
Allocate native transaction T1 before query start but withhold its relevant reduction commit.
Commit a later allocated T2 and allow any legal repair/ACK; then commit T1 before final.
Require final to detect T1 without using position allocation, UUID order or wall time as commit order.
Require actual retained start/final plan attribution and full inclusive capture.

Case: full narrowing and independent own rows
For a query with a complete OR/NOT/qualifier/order closure, change a nonmatched relevant branch.
Require blocking even when no result candidate comes from the changed subject/home.
Change an unrelated property on an excluded subject with complete routing; require useful serving.
Change that property on a returned original or terminal; require independent own-row blocking.
Withhold foreign reverse routing or late registration completion; require preparation, never irrelevance.

Case: exact observation/execution ownership and loss
Substitute another execution, copied PIT, prepared build/generation or physical UUID; require rejection.
Renew a real PIT; require the same immutable observation/covered cut and only validated locator renewal.
Expire/close/lose that PIT; require exact-tuple loss and no recapture under its old identity.
Recreate the same physical name with a new native UUID; require fresh registration and no inherited ACK.
```

### Cold population, replay and activation cases

```text
File: test/search/default-public-filter-population.test.ts
Case: default empty startup does not publish empty population
Create ordinary native subjects before starting the real default worker with no search generation.
Require readiness until all native key pages, replay and identified reconciliation complete.
Then require every eligible terminal, no extra key and no duplicate terminal through the public API.
Require SubjectSourceKeyPages only from real background work; make any request use fail the case.

Case: creation/change bridge closes behind-frontier holes
Capture A, walk past a key, then create/change a subject whose key sorts behind the frontier.
Delete/hide another scanned subject and restore a selected ineligible dependency before B/replay ends.
Require ordinary log replay through B to produce exact current native membership and routing.
Hold a required event or owner unavailable; no complete/empty/active fallback is allowed.

Case: chunk tails, gaps and home moves
Populate 257 keys and separately an event batch with a tail after 256-ID native Source calls.
Fail the later chunk after earlier effects; require no premature frontier/checkpoint and exact replay.
Move a native home during scan; require verified new-owner continuation or explicit changed/gap.
Remove required retained history in the native fixture; require quarantine and bounded affected-home recovery.
Do not restart settled unrelated homes or infer completion from count/position alone.
```

```text
File: test/search/default-public-filter-activation.test.ts
Case: equal counts with wrong identities cannot activate
Use real source/target fixtures with one missing expected key and one extra key in the same home.
Require identified reconciliation to reject publication despite equal counts and caught-up checkpoints.
Repair through the actual writer; require activation only after real keys and dependencies settle.

Case: shared default/rebuild/CLI activation
Run first startup, production rebuildSubjects and scripts/search.ts rebuild against the real worker.
Require the same native population/activation bridge and actual runner refresh/durable progress.
Require no empty-first-alias shortcut, no-op progress receipt or count-only readiness path.
Withhold worker progress; timeout retains resumable work and never fabricates active generation.

Case: activation and retirement crash custody
Crash before alias effect, after actual alias effect and before SQL finalization.
Restart the actual worker; require observation of exact native alias/UUID and idempotent finalization.
Race competing activations and physical same-name replacement; only actual valid winner is current.
At three live generations refuse another until real retirement drains the exact owned old resources.
Hold a delayed old write through actual native delete-version pruning and resume it after repair.
Require the existing native writer custody to prevent unsafe resurrection; no fake elapsed-time proof.
```

### Retained repair, freshness and cleanup cases

```text
File: test/search/default-public-filter-recovery.test.ts
Case: finite sparse source yields a useful retained page
Install a genuine native admitted read definition/retention grant and ordinary public input.
Put s+1 matches after growing nonmatches; direct bounded execution must return readiness if needed.
Run real durable repair to completion; retry the original request and require s hits plus continuation,
or a genuinely exhausted final page. Never allow a chain of short/empty successful raw pages.
Crash after committed steps; retain settled work and reread at most one step's input on restart.

Case: actual LOCAL and automatic FOREIGN repair
Use actual subject/candidate/selection, tuple, target/qualifier, consent and Collection reductions
through their existing native command paths, with ordinary indexing paused where the scenario needs lag.
Require targeted persisted repair without unrelated source edit, injected event or checkpoint advance.
Require dependent source-own anchored version advancement and actual repaired winner refresh/shard success.
Withhold the transport response after real wait_for/refresh visibility; resolve actual outcome on replay.
A 409 or progress/settled status cannot substitute for the native effect or ACK proof.

Case: ordinary freshness measures every required stage
In healthy real time require ordinary source edits filterable within 60 seconds.
Pause relay, dependent projection and prepared publication separately with recent engine refreshes.
After actual source-to-searchable lag exceeds five minutes require readiness and honest as_of.
Resume the same default worker; require finite useful-page recovery from retained phase/frontier.
Relevant privacy reductions block immediately at every ordinary-lag age.

Case: retention grant, expiry and crash cleanup
Use actual native configured principal-class/global grants, including anonymous admission.
Exhaust/refuse a grant before retained writes; identical requests join one real job/building slot.
Require public one-current/one-building, owner 32-result LRU and 24-hour idle expiry as applicable.
Crash after reservation/use/PIT effect/receipt/frontier/finalize; require retained exact-resource recovery.
Race renew/close and expiry; losing PIT locators stay owned until drain and no supplied pool closes early.
Cleanup failure retains retryable ownership; unknown all-role custody never becomes erased/none.
```

### Discriminatory native scales and raw evidence

```text
File: test/search/default-public-filter-growth.test.ts
Run independent 64, 512 and 4096 scales, ratio eight, with fixed s and fixed page neighbourhood.
Vary catalogue population, matching population, sparse prefix, unrelated history, definition/affected-key
history, aliases/duplicates, deep page, abandoned resources and real privacy-reduction arrival rate.
Use production-shaped rows and existing Performance capture, not returned-row estimates.
Cover direct public and prepared public first/deep/sparse pages plus the actual 16-read/128-slot page.
Commerce/composed owners retain their native driver obligations; no Search-only fake proves those plans.

Capture entire binding/capture/query/completion/readStatus/cleanup scheduling for a page.
Retain actual SQL occurrences, Query Text/native plans, backend IDs, errors, removed/examined rows,
shared blocks, nested statements, connection peaks, parameter/result/request/response bytes,
engine requests, next_doc_count/advance_count and every candidate/point/output/write/frontier counter.
Report exact privacy-start/final subset together with whole-page capture; missing attribution fails.
If the native layout reads/probes active XIDs, independently hold 1, 8 and 64 allocated native
transactions across the measured read at fixed data scale; growth fails because there is no XID allowance.

Every scale meets literal direct/ready/composed/preparation ceilings with no slack.
Fixed-neighbourhood examined rows and statements remain constant, blocks logarithmic and bytes constant.
Engine work is constant/logarithmic in population/matches; full-match sort/count is not a direct plan.
Total finite preparation is linear and replay rereads at most one step, including rejects/lookahead.
Measure actual repair/ACK latency and public served share under increasing real reduction rate.
Served share cannot fall between scales; global blocking/permanent preparation fails even if safe.
Require useful sparse output and unchanged finite-source progress under continuous disjoint identity jobs.
```

## Future acceptance commands and delivery conditions

The following are actual existing command entry points with proposed future test-file arguments.
They run only after owner adoption and runtime integration; none was executed for this artifact.
They do not authorize a worker to change frozen acceptance or substitute fixture success.

```sh
bun run --cwd services/kernel typecheck
bun run --cwd services/kernel check test/search/default-public-filter-runtime.test.ts test/search/default-public-filter-routes.test.ts test/search/public-filter-consumer.test.ts test/search/public-filter-custody.test.ts
bun run --cwd services/kernel check test/search/default-public-filter-population.test.ts test/search/default-public-filter-activation.test.ts test/search/rebuild-custody-native.test.ts test/search/indexer-source-batches.test.ts
bun run --cwd services/kernel check test/search/default-public-filter-recovery.test.ts test/search/default-public-filter-growth.test.ts
bun run --cwd services/kernel check test/search/outcomes.test.ts test/search/relation-facet-outcomes.test.ts
```

Each whole slice includes its affected existing cursor/rating/disclosure/default-worker regression cases
through the kernel's owning check runner and keeps original frozen tests intact.
Do not mark a missing runtime producer, fixture lookup failure or skipped case as accepted evidence.
Retain native raw capture and real-worker lifecycle proof with the tested integrated revision.
Promoted evidence and public capability completion remain separate from a local native protocol pass.

No unnecessary sequencing edges are required between the three whole slices.
Request binding consumes adopted consumer/Source declarations; background activation consumes adopted
key pages and native lifecycle custody; recovery consumes their declared retained locators and repair operations.
Those are real callable/data prerequisites, not a requirement to wait for another slice's prose or receipts.
Owner adoption sequences overlapping declaration writers; it does not create a second implementation round.
Do not independently re-prove foreign receipts, compute hash evidence or run native probes during specification.

## Decisions, inspected evidence and artifact handoff

Choose a trusted default constructor rather than allowing the caller to select Source/physical identity.
Choose additive native binding/join declarations on the existing Source writer and actual custody join.
Choose background-only complete key traversal plus retained event bridge and identified reconciliation.
Choose the existing native lifecycle as the only first-start/rebuild/CLI activation publisher.
Choose request-local observations with existing confidential keyset cursors and shared admitted preparation.
Choose native retention grants before public retained writes; no public numeric allowance is invented.
Choose targeted finite repair and replacement observations instead of mutating old PIT/prepared coverage.
Every new cross-owner choice remains a proposal pending adoption; none claims a landed export.

The contract/source inspection included consumer TypeScript/Markdown, Source TypeScript/Markdown,
custody TypeScript/Markdown/implementation, shared filtered lists, search service/query/source,
runner/work/worker composition, lifecycle/rebuild CLI, freshness, HTTP routes and native fixture declarations.
Existing native-cut reports supply the accepted counterexamples and remaining evidence obligations;
they are not a second research round or proof that the missing runtime is impossible.

Reference reading used the read-only reference index and OpenSearch 3.9.0 source via `git show`
at the index's pinned revision in `.reference/search-rating-populations/opensearch`:
`server/src/main/java/org/opensearch/action/search/CreatePitController.java` and
`server/src/main/java/org/opensearch/search/profile/query/QueryTimingType.java`.
The upstream repository is [OpenSearch](https://github.com/opensearch-project/OpenSearch), Apache-2.0.
The inspected revision is the one already recorded by the Source/native-cut authorities;
no clone, fetch, build, experiment, SHA computation or foreign receipt verification was performed here.
PIT creation/cleanup and native iterator measurement are consumed through existing owners, not reimplemented.

This document is the complete bounded handoff: three whole native implementation briefs,
their callable/adoption boundary, operation costs, call sites and frozen future native scenarios.
Its delivery changes only this specification file.
No compiler is required for a documentation-only change, and minimal-mode acceptance/native checks are deferred.
