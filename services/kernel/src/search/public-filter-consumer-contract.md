# Immutable public filter consumer boundary

Search owns the canonical `PublicFilterQueriedObservation` in the adjacent type-only file. Semantic must import
and re-export that exact type when closing its population observation boundary. There is no second observation
type and no live/latest-ACK snapshot branch. This specification consumes only committed Source public types and
existing shared FilterDocument, parsed TextNode, SearchPlan/SearchResult, OpenSearch, Pool and KernelClock.
It does not import the preserved Semantic closure proposal. That proposal is context for owner review, not an
available runtime dependency.

The authority for disclosure, narrowing and budgets remains [Filtered lists](../../../../docs/filtered-lists.md).
The [Source contract](../semantic/public-filter-source-contract.md) owns native public projection, reduction append
and population observation. This specification adds no engine, ACK store, worker, production implementation,
permission certificate or simulated successful adapter. Native tests are deliberately red on missing producers.
A native protocol pass later will still be distinct from public API/default-worker capability acceptance.

## Exact exports and missing production entry point

The adjacent module exports `PublicFilterQueriedObservation`, `PublicFilterConsumerContext`,
`PublicFilterConsumerCaptureInput`, `PublicFilterConsumerRefill`, `PublicFilterConsumerWindow`,
`PublicFilterConsumerJob`, `PublicFilterConsumerUnavailable`, `PublicFilterConsumerCapture`,
`PublicFilterConsumerQuery`, `PublicFilterConsumerStatus`, `PublicFilterConsumerRepair`,
`PublicFilterConsumerOperations`, `PublicDiscoveryConsumerOperations` and `PublicFilterConsumerOperationsFactory`.

The factory returns the full mixed operations view on the same native consumer. Legacy Subject consumers may
retain the original operations view without implementing mixed methods. Both views share retained execution custody.

The production module exports `createPublicFilterConsumerOperations: PublicFilterConsumerOperationsFactory`.
Its canonical configuration requires the injected `source` and `binding: PublicFilterSourceBinding`, and optionally
accepts a fixed `DiscoveryRegistry`. The [implementation](public-filter-consumer.md) describes native composition.
This is an injected implementation, not default-provider readiness or native acceptance.

### Source bootstrap and retained native custody

Source's existing binding extends to `PublicFilterSourceBootstrapBinding`: begin before native PIT/prepared
capture, adopt the committed observation against the exact original cut, recover uncertainty without recapture,
and abort only after real receiving/physical custody closure. `repairPage` uses the retained bootstrap, queried
observation, execution and frontier. Native Source receipts and own-home advancement include LOCAL and FOREIGN
work. `settle` independently validates those owner records and real Search dispatch/visibility/copy custody for
that same old cut/execution. No caller receipt, callback Boolean, fourth reader or mirror Source is introduced.

The existing Search registration/observation/execution registry owns consumer work, immutable raw windows,
uncertain native effects and visible-winner records. Source definitions import Search's canonical legacy,
mixed and suggestion capture union. Derived batch size/frontier belong to executions and cannot change the root.
Mixed `captureDiscovery`/`queryDiscovery` methods share the same factory, physical custody and required windows;
Account own-row authority never derives from a Subject projection.

### Retained consumed windows

Capture accepts optional `pageSize` so useful-page callers can set the requested public size `s` and receive the
literal root allowance `min(600, 6s + 3)` over at most three rounds. Legacy callers without `pageSize` preserve
their existing legal size. `PublicFilterConsumerRefill` names an existing execution and an integer consumed prefix;
it never accepts engine keys or changes the retained root plan. Refill size is positive and bounded by the
remaining root allowance and the existing per-query limit.

Every queried result carries a required closed `PublicFilterConsumerWindow`. Its `positions` align with returned
hits and are strictly increasing zero-based ordinals less than `examined`. `examined` charges every raw candidate
for that execution, including canonical duplicates, rejects and any bounded lookahead. `exhausted` is true only
when a successful complete-shard, non-timeout, non-terminated native response has actual end evidence. A refill
consumes the first `consumed` raw positions of its named retained execution, derives the next native frontier from
retained raw keys, preserves unused suffix/lookahead, and persists the actual execution/start/own-row set for each
batch. Revalidation of reused rows and all reads remain charged. Refill does not reset the root allowance or alter
the captured AST/text/order/meaning/principal/physical incarnation.

The page layer can certify EOF only at `consumed === examined && window.exhausted`; otherwise the confidential
continuation retains the actual execution/consumed locator within its existing bound. Native exhaustion does not
replace final `readStatus` authorization. No raw frontier or new authority is public.

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

`capture({plan, snapshot}, context)` requires `PublicFilterConsumerCaptureInput`: the existing SearchPlan
order/size/keyset inputs plus REQUIRED `filterDocument: FilterDocument | undefined` and
`text: TextNode | undefined`. Explicit undefined means no filter/text. This is one small closed capture input,
not a second query-requirements ABI. A compiled-only object is invalid, including when passed from JavaScript.
There are no caller positive-leaf, dependency-key, read-definition or claimed-admission fields.

Expand saved filters with existing `admitFilter` against the configured accepted release before capture, retaining
the actual expanded shared tree. The native boundary revalidates that tree against the SAME factory meaning;
remaining saved references reject. Use `walkFilter` over ALL expanded nodes, including NOT and OR, to reject
OwnerLeaf before ANY native I/O. Admission of owner facts elsewhere, including a saved expansion, cannot authorize
this public consumer. Actual private-source observations remain Commerce's responsibility. No second Boolean
parser/interpreter or per-property whitelist is introduced.

The producer derives its physical plan with existing `compileFilter` (`prefix: 'f', relationOverflow: true`) and
`compileText` (`field: 'search_text', prefix: 't'`), retaining full compiler leaves rather than matched/positive
leaves. Preserve existing boost, overflow-property, functional order, size and keyset semantics. Optional inherited
SearchPlan query/filter/boost/overflowProperties/rating/generation metadata is compatibility evidence ONLY: if
supplied it must match the derived native plan and actual registered physical observation; mismatch rejects before
native I/O. Absence of compiled DSL does not omit semantic inputs. Do not recover a FilterDocument from arbitrary DSL.
Copy and retain the input trees, keyset, derived plan and factory meaning immutably before returning; later caller
mutation cannot alter them. Derive complete filter/text/name/type/id and functional-order dependency keys from
those retained shared inputs, including negative branches, same-statement qualifiers/units and tie breakers.

The Source here is precisely the public catalogue's adopted Global subject population for the configured release
and type, with native original/terminal eligibility and disclosure. It is not a Collection, mounted Zone, private
Source or evidence of those surfaces' readiness. Bind this population to the ACTUAL factory `source` object and its
pool/routing/Access configuration, native registered source/read-definition and physical observation. Caller-created
source/meaning identity strings are never evidence. Retain source identity/configuration with the expanded AST,
text, order, size and keyset in the immutable definition; validate digest against release and registration.
**Concrete runtime prerequisite:** the current `PublicFilterSource` has only projection/head/log readers; it has
no native registered public-catalogue source identity/read-definition resolution port. Source's producer must supply
that binding before this factory can run; it cannot be inferred from three reader functions or omitted from the
retained definition. This closure invents no substitute Source export. Semantic may re-export the ONE canonical
`PublicFilterQueriedObservation` unchanged, not a duplicate PublicFilterQueryRequirements type.

A read-definition identity is derived/resolved by native registration, never accepted as a caller-created string.
Any new semantic input requires another capture. Incomplete initial projection/registration returns `preparing`
with its real native repair job. No partial prepared generation can return `captured`.
Unknown coverage stays unknown under NOT.

`query` executes that retained plan through the existing native Search semantics, complete-shard checks,
source/population authorization and current disclosure machinery for that exact PIT/prepared generation. It
never reinterprets a filter or evaluates a caller list of repaired rows. Its `queried` result returns a validated
renewal when needed. The native `execution` record binds the actual immutable observation, query start cut,
supported filter/order inputs and actual returned original/terminal own-row set. Nothing caller-created replaces
that set, even when it is empty. `preparing` yields no public membership/absence/order evidence.

## Retained consumed windows

`PublicFilterConsumerCaptureInput.pageSize?: number` records public `s` in 1..100 separately
from native batch size. Useful-page callers always set it; legacy captures default to their
existing legal size. `query(queried, context, refill?)` preserves two-argument calls. The exact
optional refill type is `Readonly<{execution: string; consumed: number; size: number}>`.
A queried response requires `window: Readonly<{positions: readonly number[]; examined: number;
exhausted: boolean}>`.

Positions align one-to-one with result hits and are strictly increasing zero-based raw ordinals
in THIS execution, each less than examined. Examined includes canonical duplicates, rejects and
lookahead, even when no public hit survives. Exhausted requires complete-shard, non-timeout,
non-terminated native end evidence after examined. An extra bounded seek is charged to the same
original allowance. No length, total, repair result or elapsed time establishes exhaustion.

Refill validates the named execution's exact root AST/text/sort/meaning/principal, physical
incarnation and Source registration. It consumes an integer prefix in 0..examined and derives
its native frontier from retained raw keys. Unconsumed suffix/lookahead cannot be skipped.
Derived size/frontier never mutate the root capture or create a new observation. Persist actual
execution/start/own rows and lineage for every batch. Reused and currently revalidated rows cost
normally. Reject foreign/stale executions and invalid prefixes. Size is positive, at most the
existing per-query ceiling and remaining root allowance; refill never reserves a fresh budget.
The root's three rounds and `min(600, 6s+3)` combined raw allowance and all lower native/SQL/point/
byte ceilings remain literal. Ready-result reads retain their tighter two-read/`2s+2` ceilings.

Useful pages consume through the last used raw ordinal plus one when filled, otherwise through
examined after processing all hits. EOF requires both consumed==examined and exhausted. All other
continuations retain the execution/consumed locator confidentially. Sparse work-bound exhaustion
transitions to actual finite native preparation, never an advancing empty success or a locally
fabricated job. Exact-execution final `readStatus` remains mandatory after response work.

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

Search requests native Source repair pages with the fixed `inputLimit: 64`, and reuses that exact size when a
dispatch or response is replayed. Before the call it reserves 768 of the existing 1000 input keys for the bounded
producer and independent receipt-verification reads. Source uses this limit for repair-page empty-home batches;
initial Account-home enrollment is a separate capture step and receives Search's live remaining input allowance.
The first nonempty raw key or captured event still enters ordinary retained owner work.

Initial Source preparation may commit a bounded contiguous batch of at most 16 per-home Account receipts within
its existing `preparing` capture state. Search passes the remaining input allowance from its live 1000-input meter,
minus 128 inputs for capture handoff and persistence; Semantic also reserves measured producer work and applies a
conservative per-home estimate before admitting each receipt. Search retains the same registration/bootstrap
identity across that continuation; it does not open a replacement Source cut. Access contention leaves the failed
home at the durable cursor for an exact retry. Search counts this native preparation's actual input keys as the
dependency/row denominator even before the query has produced candidates; its global input, byte, deadline and
native-point limits still apply.

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
writes or explicit `_refresh` before send, or hold the genuine bulk `refresh=wait_for` response AFTER native
completion and BEFORE delivery to the producer. Both `bulk(lines, options)` and request-path bulk query options
are recognized. No bulk option/request/response is changed and no redundant explicit refresh is required.
`arm('refresh').reached` reports `{kind, stage}` to distinguish dispatch from completed native visibility;
`nativeReceipts()` retains actual returned responses (including bulk item errors), never a fabricated shard/refresh
success or ACK.
A bare bulk response is a write receipt only and cannot consume the refresh gate; native errors/shard failures
remain producer publication barriers. A wait_for `disconnect_before` gate stops dispatch before any native effect;
its ordinary hold and lost-response gates run after genuine completion. The helper also disconnects writes and
explicit refresh before send/after actual engine effect; none supplies successful receipts or ACK booleans. Recreate
deletes/creates only its own index with the same name. Close releases gates, drains
the actual producer and deletes only that index, leaving the supplied Semantic resources to their owner.

The focused suite uses migrated native fixtures, real editorial/consent/moderation/source-fence commands, Source
projection and native engine responses. It freezes physical UUID/PIT and immutable prepared identity, caller-plan
mutation, same-name recreation, local and foreign repair, dependent own-home version advancement, reduction AFTER
start with ACK BEFORE final, zero-candidate negative/name-order exclusions, unrelated-key narrowing and own-row
subject-wide protection. Transport gates retain pending barriers for delayed/failed/ambiguous writes and refresh;
changed dependent versions, late registration and competing native repair exercise the actual publication race.
Tuple and consent cases require dependent SOURCE keys to disappear before a fresh observation is clean.

One inclusive native capture surrounds the entire `query` and its final `readStatus`, including engine execution,
immutable definition/execution/start/result bookkeeping, metadata, current own rows and every backend operation.
In the ACK-before-final race, a bounded barrier exposes the actual original query execution to the fixture
controller, waits for its concurrent reduction/repair/refresh/ACK and fresh observation, then runs final status
inside that SAME capture. Fixture work runs outside the page operation's async scope and retains its separate
preparation costs/background evidence. No query or status work moves there, and all concurrent work drains in
`finally`; neither native deadlines nor retained-observation TTLs are extended.

Only the actual all-home privacy START/FINAL coverage subset shares the ceiling of two statements and
`64 + 2*(distinct behind homes + distinct changed homes)` examined rows, once per page across its reads. The native
producer must annotate each such SQL statement, after optional whitespace, with exactly one leading operation
comment: `/* semantic.privacy-start */` or `/* semantic.privacy-final */`. Separate keyed own-row checks use
`/* semantic.own-rows */` and remain in the whole read, outside that coverage subset. Own-row work merged into final
carries `/* semantic.privacy-final */` and its WHOLE native plan counts as coverage. These closed annotations
identify operations, not a selected runtime SQL layout. Untagged/relabelled coverage violates attribution; missing
recognized START or FINAL statements/plans never proves clean or zero work. A third coverage statement fails even
when the whole read fits its budget. No relation-name inference, supplied counters, manufactured plans or subtraction
of own-row/nested work is permitted.

Derive the subset from actual `Capture.statements` and native plans' `Query Text`, matching backend and every call
occurrence, including duplicate SQL; retain parallel byte/backend/error arrays. Keep the raw subset and whole
capture together, preserving the whole evidence even when attribution fails. Require a native plan for each
non-control statement occurrence; unmatched plans or statements fail rather than disappearing from the budget.
Unclassified operations stay charged to the whole read; only the existing shared catalog-only
classification applies. The same whole capture independently meets the one-read ceiling of 12 statements and one
connection per PostgreSQL backend, with the existing direct candidate/point/row/block/byte budgets. Composed pages
retain `8 + 4R` statements per backend. Count actual candidates including rejected/duplicate/lookahead work, not
returned hits; this zero-returned-candidate scenario grants no hypothetical exemption. Metadata, capture, engine
iteration/bytes, retained execution writes and every backend remain charged within the public read budgets. No
full 4096-head scan, packed-vector/JSON aggregation, permission cache or uncounted ACK/registration read is admitted.
The helper's lifecycle is not ACK evidence. Missing producers fail before protocol assertions today; every case
retains its full assertions, without skips, fake sources, unconditional missing-port bodies or stub success.

All existing native user cases remain required unchanged. Caught-up 4096-home native indexed captures, actual
64/512/4096 served-share under rising reduction rate/real repair latency, default/API wiring and the complete
direct/prepared/composed growth matrix remain separate required evidence after runtime exists. Primitive fixture
data is no released-word/recipe claim. No feasibility, runtime availability or public capability pass follows from
committing these four specification/helper files or from a later isolated protocol pass.

The two executable input/transport controls use the same actual producer lookup as all native races. Missing
`semantic/public-filter-source.ts` fails before engine execution; it is not a pass for immutability, dependency
keys, PIT/prepared identity, visibility or ACK. Once producers exist, the controls install a valid public saved filter
through the ordinary release API before
constructing Source/the consumer. Public expansion uses that exact configured release; an owner-context saved
expansion is deliberately untrusted input, never installed as a public release. The controls exercise the expanded AST,
OwnerLeaf under NOT/OR/saved expansion, compiled mismatch/compiled-only rejection, caller AST/text/keyset mutation,
definition changes for text/order/size/keyset, full OR
narrowing, explicit refresh and real wait_for visibility while its native response remains withheld. Transport
control documents are owned fixture inputs, never a synthetic privacy event or repair receipt. The existing tuple
case still requires automatic FOREIGN repair with no unrelated subject edit, injected event or checkpoint advance.

## Native feasibility evidence and conditional growth measurement

The [current native-cut report](../../../../docs/research/public-filter-native-cut-current.md) and
[deep native-cut report](../../../../docs/research/public-filter-native-cut-deep.md) are integrated evidence for
this boundary. Both inspected pinned source and ran **no native experiment**. Source-inspected behavior is
proven only at that scope; candidate layouts/schedules are proposed, and native plans, maintenance costs and
runtime feasibility remain unknown. The deep report's table-whitespace formatting adds no substantive finding.
The reports reject specific shortcuts, not every native representation. Native producer, registration, cut and
custody runtime remain **missing**, not impossible; this adoption runs no existing native case.

Snapshot membership can distinguish a lower allocated XID committing after start when final uses a fresh
statement snapshot. The demonstrated indexed split still enumerates/probes active XIDs. A snapshot token,
packed array or server retention does not erase that native work. Latest-key-only state loses an earlier relevant
change followed by an irrelevant one. Key/history indexes must account for multiplicity and retained history;
per-definition/home summaries must account for atomic registration maintenance and fanout. Neither report
delivers a complete native narrowed changed/behind path or bounded maintenance.

A same-row global transactional stamp is a conditional one-database serialization proposal: its common lock must
survive to commit. It is not adopted command placement or an approved shortcut. No new serializer, quota,
service, storage or engine is selected. It does not independently close narrowing, registration or custody.

Current pending/ACK cannot protect reduce-then-ACK before final or a new query on an old observation. The actual
canonical PIT or immutable prepared observation, its covered cut and execution start, full admitted AST/key
closure and native registration remain required. No latest-live branch, caller keys/returned-ID permission or
revival of `subject-coverage-v1` follows. Returned original/terminal own-row checks remain independent of narrowing.

Native write-block verification drains admitted shard operations while blocked, not delayed requests arriving
after unblock. Finite `gc_deletes` and checkpoint CAS cannot prevent late resurrection. All-writer/retained-copy
custody, dependent source-own anchored advancement and actual LOCAL plus all FOREIGN refresh remain missing
prerequisites. A refreshed same-version conflict winner alone cannot establish the required repaired body.

Cold internal subject-key traversal still needs its actual creation/change bridge and retained-log gap/epoch
handling before publication. All-role erasure locators and minimized-source completion remain owner obligations;
`accountAgentId` identifies a stable node, not erasure truth. Unknown custody cannot become none/erased.
No unbounded scan, cached permission, universal 256-list budget, old certificate/witness/replay ABI, permanent
soft tombstone, new export/factory/table name or permanent preparing is authorized here.

Alongside the existing native growth requirements, **if the chosen future layout reads/probes per active XID**,
hold **1, 8 and 64 open native transactions**, each with allocated `pg_current_xact_id()`, across the measured
read at fixed data scale. Judge actual examined rows, blocks and statements by the series. A quiet data-only
fixture cannot detect that cost. The existing ceiling contains **no active-XID term**, so growth on this axis
**fails**. This is no new allowance or test harness, and requires no artificial transactions for an unrelated
layout. No Performance policy decision is pending; the numbers remain decided.

The existing 64/512/4096 data, keys, history, aliases, depth, privacy-rate and served-share growth requirements
and whole-page checks remain required. Preserve exact Decision17 attribution: role SQL starts with
`/* semantic.privacy-start */` or `/* semantic.privacy-final */`; separate keyed own-row SQL starts with
`/* semantic.own-rows */`. A merged own-row final charges its full population coverage work. Native capture is
inclusive across `query` plus `readStatus`, with capture/metadata and all other page work also charged; isolating
final/status alone cannot establish the budget. The privacy subset remains at most **2 statements** and
`64 + 2*(behind homes + changed homes)` examined rows, shared once per page. Separate own-row work stays inside
whole-page limits and cannot replace population coverage, including for zero returned rows.

Whole-read statements remain at most **12 per backend**, composed-page statements **8 + 4R**. Native
plan/backend/byte evidence must include actual examined/removed rows, blocks, nested statements, connections,
request/response bytes and engine iterator work, including failed/replayed work and registration maintenance.
All direct/prepared/composed limits and actual repair latency/served-share checks above remain unchanged.
No native feasibility, budget or public capability pass follows from this owner-text adoption.
