# Immutable public filter consumer boundary

Search owns the canonical `PublicFilterQueriedObservation` in the adjacent type-only file. Semantic must import
and re-export that exact type when closing its population observation boundary. There is no second observation
type and no live/latest-ACK snapshot branch. This specification consumes only committed Source public types and
existing SearchPlan/SearchResult, OpenSearch, Pool and KernelClock. It does not import the preserved Semantic
closure proposal. That proposal is context for owner review, not an available runtime dependency.

The authority for disclosure, narrowing and budgets remains [Filtered lists](../../../../docs/filtered-lists.md).
The [Source contract](../semantic/public-filter-source-contract.md) owns native public projection, reduction append
and population observation. This specification adds no engine, ACK store, worker, production implementation,
permission certificate or simulated successful adapter. Native tests are deliberately red on missing producers.
A native protocol pass later will still be distinct from public API/default-worker capability acceptance.

## Exact exports and missing production entry point

The adjacent module exports `PublicFilterQueriedObservation`, `PublicFilterConsumerContext`,
`PublicFilterConsumerJob`, `PublicFilterConsumerUnavailable`, `PublicFilterConsumerCapture`,
`PublicFilterConsumerQuery`, `PublicFilterConsumerStatus`, `PublicFilterConsumerRepair`,
`PublicFilterConsumerOperations` and `PublicFilterConsumerOperationsFactory`.

The selected future production module is `services/kernel/src/search/public-filter-consumer.ts`; the selected
factory export is `createPublicFilterConsumerOperations: PublicFilterConsumerOperationsFactory`. Both are
**MISSING**. They are selected names for co-owner review, not current imports or delivered runtime exports.
No default composition is installed. Source's `semantic/public-filter-source.ts:publicFilterSource` and
`recordPrivacyReduction` are also missing. The test helper dynamically loads actual producer modules when run;
missing producers fail explicit assertions. It does not unconditionally throw in place of the integration cases.

The actual test-only export is
`services/kernel/test/search/support/public-filter-consumer.ts:createPublicFilterConsumerFixture`, with exported
return type `PublicFilterConsumerFixture`. `publicFilterConsumerModule` and `publicFilterConsumerFactoryExport`
identify the exact missing production entry point. Semantic can depend on this helper without importing a test.

## Native identity and immutable execution

The exact consumer identity is the existing Source `PublicFilterConsumer`: actual `physicalTarget`, actual
`incarnation`, `consumerGeneration`, `projectionGeneration`, `meaningDigest` and `readDefinition`. The latter two
remain nullable only where the existing Source contract permits it; the public filtered fixture requires both.
The engine index UUID from native settings is the incarnation, never a generated UUID, alias, generation number
or physical name alone. Recreating the same name produces a new registration and cannot inherit any old ACK.
Capture must resolve native physical index metadata, persisted consumer/projection registration, definition and
accepted meaning; neither caller spelling nor equality of two strings establishes this binding.

The snapshot is exactly one of:

- `{kind: 'pit', observation, pit}`: actual engine PIT, resolved against its native retained observation record,
  exact physical incarnation, registered meaning/read definition, immutable admitted plan and covered cut.
- `{kind: 'prepared', observation, build, generation}`: an actually immutable, retained prepared build/generation
  with its native observation record and the same exact binding. A mutable result cache/vector is insufficient.

The observation locator names retained native state. It is not synthetic epoch evidence or a serialized head
vector. A copied, invented, expired, closed, mismatched or unknown locator cannot establish safety. Native PIT
renewal may change only the validated engine PIT locator; it retains the SAME observation, physical incarnation,
meaning, query and covered cut. A prepared replacement has a new immutable generation/observation. Neither kind
can borrow a newer live-target ACK. Expiry or engine loss prepares/restarts; no recapture under an old identity.
Observation and execution identities, PIT IDs, native jobs, cuts and consumer metadata stay off public transport,
including cursor-visible fields. Internal SearchResult totals do not authorize public totals or facet counts.

`capture` receives the trusted admitted native SearchPlan, rather than a second Boolean language. It validates
that plan against supported native admission and meaning, creates/resolves the persisted immutable read definition,
copies/retains it before returning, and
establishes the actual immutable snapshot and persisted registration. A caller mutation cannot alter execution.
A read-definition identity is derived/resolved by native registration, never accepted as a caller-created string.
Any new plan requires another capture. Incomplete initial projection/registration returns `preparing` with its
real native repair job, allowing finite initialization without pretending there is already an immutable snapshot.
No partial prepared generation can return `captured`. Unknown coverage stays unknown under NOT.

`query` executes that retained plan through the existing native Search semantics, complete-shard checks,
source/population authorization and current disclosure machinery for that exact PIT/prepared generation. It
never reinterprets a filter or evaluates a caller list of repaired rows. Its `queried` result returns a validated
renewal when needed. The native `execution` record binds the actual immutable observation, query start cut,
supported filter/order inputs and actual returned original/terminal own-row set. Nothing caller-created replaces
that set, even when it is empty. `preparing` yields no public membership/absence/order evidence.

## Start, final observation and narrowed Source joining

Start occurs before native engine execution; final revalidation is `readStatus({queried, execution}, context)`
against that exact retained execution. `readStatus({queried}, context)` resolves persisted observation/repair state
without inventing an execution/start. No caller may supply heads, candidate sets, routing completeness, refresh
success, dependency completion or an allow bit. Status is diagnostic; the real public producer must still perform
current Source/Access/field checks and enforce the final boundary before disclosure.

`covered` is the actual native retained cut locator for the immutable queried observation, using the existing
`PrivacyReductionStart` shape. It resolves native retained coverage; it is never a 4096-head vector or a synthetic
certificate. `pending` diagnoses the current registered
live consumer's persisted unacknowledged heads. These differ deliberately: pending can become empty after repair
while an older observation remains unsafe. `changed` retains committed reductions since this execution's start,
including reductions already ACKed now. `blocking` classifies relevant pending/changed effects using actual native
routing and that observation's covered cut. A new query on an old unsafe snapshot must prepare even when live
pending is zero. Returning a diagnostic result does not itself grant publication or acknowledge anything.

The Source population observation must join and validate this exact retained observation and execution, not
merely the latest registration. The committed Source population request presently accepts only consumer/start;
its types do NOT yet provide the complete executable narrowed input/join. The following remain missing before
runtime approval: that join, trusted admitted key extraction, native commit-visible retained start/change cut,
indexed scoped behind/changed access, atomic reduction/registration/ACK maintenance and owner availability.
This document deliberately does not manufacture SQL or claim that a token proves feasibility. Per-home sequence
allocation before COMMIT, wall-clock T, transaction UUID order, a cross-table partial index or packed head JSON
cannot substitute for the missing native access path.

Trusted key closure comes from the actual expanded shared filter, full text grammar and native sort declarations
retained with the registered definition/plan. Include every NOT/OR/saved/qualifier branch, labels, aliases,
descriptions, implicit type/name/id and tie breakers, public rating and Collection-count functional inputs.
Matched queries and returned subjects are insufficient. A foreign reduction maps to affected SOURCE keys,
including selected but currently ineligible inputs. Unresolved routing blocks. Subject-wide reductions cover
every key of that original/terminal subject; every returned row also checks its own reductions independently of
filter/order narrowing. Thus irrelevant property changes on excluded subjects can serve, relevant exclusions
with zero returned candidates remain protected, and an own-row change on an unrelated key still blocks.

## Bounded repair, status and ownership

`repairStep` accepts ONLY `{consumer, job}` and fresh context. Resolve the actual persisted native job and read
its OWN retained input, frontier, Source log window/projection/dependency routing and receipts. There is no caller
head/global maximum, completion/refresh/dependency Boolean, supplied repaired row, ACK setter or success callback.
Each step examines at most 1000 inputs, writes at most 1000 result rows and one frontier, uses at most 16 statements
per backend and four engine searches. Charge rejected/reread/lookahead inputs, all dependency phases and failures.
Keep retained finite progress; quiescent finite input finishes and replay rereads at most one step. The remaining
Source preparation ceilings apply: `64 + 16*input` rows, six blocks per budgeted row, eight Access/dependency
points per input, one connection per backend and 4 MiB response bytes.

`progress`/`settled`, status and their costs are diagnostics, NEVER persisted ACK/publication authority. Only the
native producer can advance a contiguous prefix after persisted effect/frontier/receipt state proves ALL LOCAL
and dependent FOREIGN repair refresh-visible for the exact physical incarnation, consumer/projection generations,
meaning and read definition. Foreign homes require actual dependent own-home anchored version advancement;
stamping the foreign privacy position as an external version, or treating unchanged-version 409 as repaired, is
invalid. Check actual engine winner, refresh and shard success. Delayed/failed writes, changed versions, late
dependency registrations, lost CAS, ambiguous HTTP and delete-version pruning remain barriers until genuinely
resolved. An old writer cannot resurrect unsafe data after ACK. A losing attempt never publishes its assumed cut;
a verified competing winner can settle actual work. No transaction/checkout spans engine or another owner's I/O.

`readStatus` uses bounded scoped native reads of persisted state, including after factory recovery. It cannot
read a 4096-head vector or use cached allow. `closeObservation` drains use of that observation then releases its
retained PIT/build reference; it is idempotent and never closes a newer observation. Factory `close` drains its
work and observation resources without closing supplied pools, Source or OpenSearch. Shared registration/repair
state is governed by its native ownership/reference lifecycle, never deleted because one observer closes.

Context is the native caller's absolute wall-time deadline. The trusted factory receives KernelClock once and
the initialization context; requests cannot select a clock, actor, AuthoritativeTime or TTL extension. Use actual
Access/command T and existing deadline preparation, fresh after waits and for every native retry. Engine PIT
renewal stays inside the caller budget and native retained-cut lifetime. Expired evidence fails closed.

## Native fixture and frozen evidence

The fixture receives the EXISTING Semantic pool, actual Source, configured OpenSearch, shared clock, context,
and meaning. It provisions only its owned physical engine index and uses the real future Search
factory. It creates no DB, Auth, release or fixture registry, copies no facts directly into the index and starts
no second engine. Random resource names are not identity evidence; settings/PIT responses are native evidence.
Its returned `operations` are the actual typed producer operations, without an adapter. Its controls hold native
writes/refresh or disconnect transport before send/after actual engine effect; none supplies successful receipts
or ACK booleans. Recreate deletes/creates only its own index with the same name. Close releases gates, drains
the actual producer and deletes only that index, leaving the supplied Semantic resources to their owner.

The focused suite uses migrated native fixtures, real editorial/consent/moderation/source-fence commands, Source
projection and native engine responses. It freezes physical UUID/PIT and immutable prepared identity, caller-plan
mutation, same-name recreation, local and foreign repair, dependent own-home version advancement, reduction AFTER
start with ACK BEFORE final, zero-candidate negative/name-order exclusions, unrelated-key narrowing and own-row
subject-wide protection. Transport gates retain pending barriers for delayed/failed/ambiguous writes and refresh;
changed dependent versions, late registration and competing native repair exercise the actual publication race.
Tuple and consent cases require dependent SOURCE keys to disappear before a fresh observation is clean.

The start/final physical capture shares at most two statements and
`64 + 2*(behind homes + changed homes)` examined rows. Metadata, capture, engine iteration/bytes and every backend
are charged within the existing public read budgets; no full-head scan disguised as hashing/aggregation is free.
The helper's lifecycle is not ACK evidence. Missing producers fail before protocol assertions today; every case
retains its full assertions, without skips, fake sources, unconditional missing-port bodies or stub success.

All existing native user cases remain required unchanged. Caught-up 4096-home native indexed captures, actual
64/512/4096 served-share under rising reduction rate/real repair latency, default/API wiring and the complete
direct/prepared/composed growth matrix remain separate required evidence after runtime exists. Primitive fixture
data is no released-word/recipe claim. No feasibility, runtime availability or public capability pass follows from
committing these four specification/helper files or from a later isolated protocol pass.
