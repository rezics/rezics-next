# Search identity writer custody

[The native identity contract](../semantic/identity-epoch-contract.md) owns publication. Search owns the sole
ordinary writer guard in `writer-guard.ts`. Canonical participant completion remains unavailable until the actual
Semantic support and receiving producers deliver their Search bindings. No Search or Library ACK is manufactured.

## Closed callables

`createSearchWriterGuard({pool,search,index,consumer,source,listing}): SearchWriterGuard` is trusted native
composition. The runner installs it for each live or rebuilding Subject generation. The indexer's historical
controlled-provider entry point remains for its existing provider-boundary acceptance; native runner/work writes
use this guard. The separate public-filter privacy-reduction continuation keeps its own owner protocol.

The guard exposes these operations (the exact exported types live beside the factory):

- `write(partition,ids,obligation): Promise<void>` enrolls one through 100 raw unique original keys, then reads
  fresh Source and actual Library listing counts. No saved document, permission bit or caller version is accepted.
- `fenceOriginal(job,original): Promise<SearchIdentityWriterFence>` uses real structural `admitHomeEffect` and
  serializes first absence with enrollment on the same native key. Its native gate, writer and settlement receipts
  bind transaction ID, partition, owner epoch and component. The lower-level `fenceSearchIdentityWriter` export is
  this same operation, with explicit trusted pool/index/search composition; it is not a second guard.
- `closeGeneration(partition): Promise<SearchWriterBarrier>` irreversibly closes the home-local generation gate,
  including first absence. It returns the retained token, consumer, physical name/UUID/allocation alias, physical
  generation, fence/enrollment generations and exact native close receipt. It does not establish population.
- `adoptGenerationPublicationBarrier({partition,token}): Promise<SearchWriterBarrier>` resolves that locator from
  retained native state and verifies current owner, consumer, generation gate, actual physical UUID/alias and
  indexed ordinary drain. The token is not a certificate, and caller diagnostic fields are never adopted.
- `readRetainedCopies(locator,after)` pages at most 100 native operational key/copy rows in primary-key order.
  The returned `next` is a single original or null. Exact last-visible and active enrollment native receipts and
  source component remain available across later cancelled attempts. No Source body or support fact is mirrored.
- `recoverInterrupted(locator,after)` examines at most 100 pending keys through a partition-leading partial index.
  It revokes only still-enrolled attempts under the same locks as native dispatch. A delayed continuation then
  loses its dispatch CAS before any mutation. Dispatched or ambiguous requests remain counted as uncertain.

The publication producer must consume the adoption callable, close every relevant home, and retain/revalidate
those native receipts with its complete Source/physical/prepared population evidence. `ordinary: drained` covers
only guard admissions. `firstApply: unavailable` and `prepared: unavailable` explicitly prevent treating this
partial integration as canonical completion, retained prepared closure or generation-publication permission.
No method returns a ready Boolean or substitutes `readStatus` for native adoption.

## Native ordering and non-resurrection

The existing Search schema holds operational writer keys and one consumer/incarnation gate per native home and
physical name. Enrollment increments the native generation under that gate's lock. Close cannot race first
absence. Native dispatch commits before the transport call, and recovery cannot revoke a dispatched attempt.
Each home is released before Source or engine work; no connection spans external I/O.

Each newly created physical Subject index receives a fresh opaque write alias in the same engine creation request.
The guard never installs or repairs an alias on an existing index. Missing legacy allocation metadata is unavailable.
Guarded bulk uses that alias with `require_alias`, all active shards, external versions and refresh visibility,
while validating the physical keyed receipt. A deleted name cannot be auto-created by a delayed guard request;
a replacement creation has a different allocation alias. UUID/alias are checked before and after mutation, and
an owner/incarnation mismatch cannot overwrite retained enrollment or copy custody.

A guarded 409 rejects. Refresh alone is not native current-winner/source proof. Any lost transport/shard/UUID or
local-settlement response after dispatch retains enrollment. No timeout, lease, GET of current hits or successful
function return drains it. Quiescent uncertain dispatched work still requires the actual receiving recovery/handoff
producer; this delivery does not claim that missing reconciliation. Native confirmed settlement retains the copy
locator and visible native receipt; a later pre-dispatch cancellation preserves them. Copy minimization/reopening
requires actual receiving custody and is deliberately unavailable here. Retained keys and closes are charged
operational copies, not free history, identity membership or an alternate authority.

## Exact foreign delivery boundary

`semantic/identity-source-support.ts:createIdentitySourceSupportReader` is present. It reads admitted originals and
mapped terminal projections with independent current original privacy and Source guards, using the exact
`PublicFilterSourceFactory` configuration `{pool, routeKey, access, clock}`. The adopted participant's trusted
constructor receives `{search,prefix,routeKey}`; its callable receives `(pool,job)`. No installed Source configuration
accessor supplies that reader's Access/clock configuration to this participant. Ordinary `SubjectSource.read`
omits redirected originals and cannot replace it.

Library's public receiving aliases accept only `library-private-follow-counts`. Search preparation, selection and
common native dispatch use the separate canonical native union. The
[Search native contract](identity-receiving-native-contract.ts) declares the Search source and six native operations
and extracts its binding/record from those canonical variants. `createSearchIdentityReceivingNative` derives its
trusted Source configuration and binds the actual Search consumer and physical index. The operational store implements immutable committed native
preparation, same-T hold/common acceptance verification, retained dispatch/visibility/application, original-copy
reconciliation, indexed native drain and applied-control release. That operational transaction core does not supply absent complete Source
admission. The [native receiving owner document](identity-receiving-native.md) records the remaining trusted
Source/writer installation boundaries. Existing ordinary drain and unavailable first-apply/prepared custody cannot
establish native preparation. No prepared array or receipt locator replaces complete original support or original
uncertain-copy settlement.

`createSearchIdentityEpochParticipant({search,prefix,routeKey}): IdentityEpochStep` preserves exactly
`(pool,job: IdentityJobRef) => Promise<IdentityStepProgress>`. It validates trusted deployment inputs and reads the
actual admitted job, rejecting unknown, nonpending and mapping-incomplete locators before engine work. An optional
trusted `receiving` composition supplies the same-Pool Access, clock, physical owner and original work declaration.
For an existing accepted scope it fuses actual native operation application, the common effect and fixed Search
`more` step in one transaction, then reconciles original custody. The operational
`identity_receiving_native_scope_pending` queue is inserted atomically with each common Search plan. Selection
uses its partition/job/epoch/effect primary key, so a settled first scope cannot starve later scopes and a newly
prepared lower-sorting effect cannot fall behind a scheduling cursor. After genuine common reconciliation and
post-control native release, a control command retires exactly that plan transaction/binding/applied receipt
and records the next fixed `more` step atomically. A crash before retirement preserves the key and resumes
accepted/applied/released replay. Empty queue state establishes no complete Source population.

A retained complete ACK is replayed only after resolving its original same-transaction native commit/step,
exact job scope, current owner and indexed pending absence. The frontier comparison uses structural equality
so PostgreSQL JSONB key order does not invalidate an original committed receipt. This replay does not mint
completion, release a hold or reuse a private release observation.

It refuses missing complete Source discovery; new whole-participant completion, cancellation and owner-handoff
handling still require the missing original Source disposition protocol. Specifically the empty-queue path lacks
a durable complete support/first-apply/predecessor and copy-directory closure witness; the cancelled-job path
lacks the original writer's dispatch/cancellation settlement; relocation lacks a committed current-owner handoff
for those same originals and copies. Local pending absence, a changed epoch and a previously applied scope cannot
substitute for those operands. No coordinator/default identity worker/Accounts binding is installed, no
receipt claims completion, and unchanged Store publication still requires real mapping, Search and ALL-Library
custody. Existing `subject-coverage-v1` storage is never consumed as support or an ACK.

## Cost and proof boundary

Writer input and recovery/copy pages retain raw100; the owner Source's existing 256-call ceiling is unchanged.
Enrollment, dispatch, settlement, close and recovery are separate native home transactions. Pending discovery uses
the partial writer index; copy discovery uses its partition/target/original primary key. Frontiers are scalar and
replays do not scan unrelated history. All metadata, rejected inputs, Source/listing reads, normalization, shards,
refresh, events, retained copies and transaction work remain charged to the original budgets; no numeric Cost
allowance or all-nine proof is claimed.

Focused database-free controls cover exact UUID/allocation alias metadata, atomic allocation and alias-required
bulk receipts. Native canonical/prepared/growth/custody acceptance remains deferred under the current minimal
verification policy. No existing acceptance test was changed.
