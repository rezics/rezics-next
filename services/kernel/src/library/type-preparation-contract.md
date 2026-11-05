# Source type preparation before entry creation

This owns preparation of an exact private type key before an ordinary Library entry create.
`createTypePreparationPorts` implements producer, metadata continuation, revalidation and native consumption;
`createTypePreparationContinuation` exposes only continuation to the existing Library WorkModule without an Actor or
Access substitute. Default source observation uses the delivered semantic identity reader and same-RR full reader.
Entry creation consumes these ports; durable pending rows are recovered by the registered bounded metadata workflow.
Native outcome, physical-cost and final maintenance activation proof remain with the integration checks.

The owning rules are [exact identity, entry writes and source stamps](shelf-contract.md), the account/gate barriers in
[shelf maintenance](../../../../docs/research/library-shelf-maintenance.md), and the adopted Recommendation in
[native long-value staging](../../../../docs/research/native-long-value-staging.md). The latter's immutable EXTERNAL
bytea copy and direct bounded byte slices are required for continuation; repeated full-text conversion/slicing is not
a bounded implementation. This contract adds no per-type limit.

## Observation and authority

The optional `typeSourceObserved` dependency receives the resolved source stamp after both initial source clients
are released and before the preparation command; it observes only entry preparation, never sync or verification work.

`entries.ts.putEntry` keeps its existing input parsing, state/CAS, owner receipt and response behavior. Prepare only
for a create that needs a type key; state updates use existing entry metadata. Perform initial real owner authorization
and `subject:read` Access before producing metadata, using the authenticated Actor, never fields in a request body.
`resolveSubject` is the existing authorization/resolution seam; its current general redirect traversal is not the
preparation proof. Preparation accepts at most one hop: observe the requested subject, authorize the survivor, then
observe that survivor separately. A second redirect requires fresh observation or normal unavailability within the
original deadline, never an unbounded traversal. Do not stamp survivor text with the original source position.

Initial observation reads partition ownership, full type and identity through the SAME authoritative repeatable-read
client. Capture `TypePreparationIdentity` alongside the full type once in that original RR: sourceId, partition, epoch,
latest create/identity revision, its recorded transactionId and current redirect. The semantic helper's writer audit
requires every type writer to append a create/identity revision; unrelated editorial revisions do not replace this
version. Retain the requested binding even when its visible type is absent after a merge, but require visible identity
and its one-hop redirect. A separately authorized and observed survivor must have visible identity, visible type and no
further redirect. Missing/nonvisible identity or missing resolved type fails closed, never supplying a default type or
proof of access. Release all source clients before an account/gate command or wait.

The default source adapter is `library/preparation-source.ts`: `observePreparationSource({pool}, id)`
returns `{stamp, identity, type}`; `observePreparationIdentity({pool}, id)` returns `{stamp, identity}` only.
Both validate ownership and use caller-coherent RR reads. Final composition binds those dependencies to the structural
`observe`/`observeIdentity` ports. The native adapter calls `readItemIdentityVersion` and `readPartition` on the same released source client. Preserve `observeShelfType` and its existing callers; its full observer is not a continuation port.

Preserve each initial partition position in the original source binding/stamp for projection ordering. Positions are
not item versions: new unrelated writes or partition position advancement alone must not cancel or restart a preparation.
Never compare positions across source partitions. Use bigint natively and canonical nonnegative decimals at durable
boundaries; neither source stamps nor identity metadata confer permission.

Every producer, continuation and publication enters the existing account shared lock then shared shelf gate in the
owning native command. Require active/non-tombstoned account, open gate, matching owner epoch and actual retained
source binding. The metadata continuation has narrowly derived cache authority from native evidence only. It cannot
invoke entry, state, status, follow or Collection effects. No `trustedAccount` user-effect bypass is permitted. User
effects still pass ordinary current authorization in `ownAccount`; source observation is also subject to current Access
before consumption. Authentication expiry or revocation after staging can leave a ready private dictionary key without
granting an entry write.

## Native evidence and identity

`typePreparationBinding` copies only account, original requested subject, request key, resolved source id, its partition,
epoch/position and owner gate epoch. It is stable internal identity, not a public token or a proof constructor. Its
readonly result is frozen. It deliberately omits entry body, type text and principal claims. Native stores additionally
bind the authenticated command principal/request namespace so two callers cannot reuse each other's evidence.

Persist an immutable preparation header scoped to the account: preparation UUID, binding, original source stamp and
one-hop survivor, `sourceIdentity` and `originIdentity`, reservation UUID if staged, exact native accepted input/equality
evidence, and immutable byte length. Capture both identities in their initial authoritative snapshots and store them
immutably beside the source binding. Compare original source and resolved survivor independently at their own partitions;
when original and resolved source are the same they may share one identity value. Evidence contains fixed metadata only,
never a repeated full type. The current native creator receipt commitment covers both identities as well as the binding.
Require sourceIdentity's sourceId/partition/epoch to match the resolved binding, and originIdentity's to match the
original binding. The origin redirect must match the retained one-hop survivor; the resolved source has no redirect.
The reservation owns full text and the matching EXTERNAL bytea made once from the same validated input. A bounded hash
may accelerate comparisons but is never exact evidence. Header and reservation association cannot change input under an
existing identity. Concurrent same-identity/same-input work converges; different exact input at the same binding aborts
as an internal invariant failure, without publishing either as the other's key. Never accept caller-supplied source
text or an independently supplied byte copy. Read progress and final key from separate mutable checkpoint/final rows;
do not rewrite the immutable header. The header may reference the reservation without duplicating its large payload.

The native checkpoint stores chunk ordinal, committed byte offset, node, state and deterministic receipt identity.
`TypePreparationIntent` carries only its bounded header reference/binding and chunk/offset. Validate all supplied
identifiers and checkpoint numbers against native rows before doing work. Missing evidence/reservation or mismatched
binding fails closed; never reconstruct a deleted reservation from workflow data. A cancelled generation remains
ineligible. A new owner epoch changes identity even for the same original request key, preventing old metadata receipts
from trapping a retry after rebuild. Changed item identity, partition epoch or redirect requires fresh observations and
a new preparation; position advancement alone does not change the retained binding. Do not permanently replay an old
reservation as the answer for that request key.

## Fast path, pages and recovery

After observation and account admission, use the owner-scoped composed `ShelfTypeKeys.lookup/reserve/continue` port.
Lookup never allocates. Reserve publishes an exact root hit/miss promptly or durably reserves a collision with at most
100 edges. The synchronous preflight performs one bounded reservation transaction and never loops through continuation
transactions. Full-value hashing/comparison/initialization remain O(input bytes), separate from dictionary population.
An exceptional collision returns pending metadata, not a public operation or partially created entry.
Initial native exact-value comparisons and final exact-value equality/publication are still required. Source metadata
proves an unchanged accepted source input; it is not hash equality or a substitute for dictionary collision handling.

Each continuation is one existing durable effect/native command, at most 100 point edges and one direct stored bytea
slice of at most 25,600 bytes. Offset and node advance atomically with those edges and the next enqueue intent. For a
successful traversal of L bytes, page payload totals L, edges are ceil(L/256) and pages ceil(L/25600), excluding retries
and separately measured initialization/final full-value publication. Final exact text/value/terminal publication and
ready receipt are atomic. UUID conflict retries are bounded per page and remain resumable; exhaustion of a page budget
is not a permanent invalid-type error. Prefixes and distinct equal-digest values retain distinct exact terminals.

Use the existing core command receipt and outbox plus `events/effects.ts` relay. A metadata event contains only the
intent. Each committed logical chunk emits its successor once under a deterministic native receipt keyed by preparation,
owner/source epochs and chunk/offset; the final chunk has its own stable final receipt. The existing effect workflow id
binds committed envelope epoch/partition/position/event sequence and effect name. Receipt input includes the immutable
bounded binding, source/origin identities and checkpoint, never source text. A replay returns its committed result
without applying a second page.
Record the successor event in the SAME commit as progress. Relay checkpoints advance only after durable enqueue, so
commit-before-enqueue, enqueue-before-ack and ack-before-next-dispatch crashes all recover through the existing log.
A crash around final publication/receipt likewise sees either a complete ready mapping or the previous checkpoint.
Use bounded page workflows; no new worker process, request-held loop, scanner over full account history, or lock across
pages is required. A page may stop on transient dependency failure and retry with current native evidence.

Before every bounded owner page, publication and consumption, revalidate source and origin using
`semantic/item-identity.readItemIdentityVersion(client, id)` and `readPartition` in the SAME new RR per independently
anchored partition. The identity helper reads no full type, follows no redirect and opens no transaction of its own.
Compare exact sourceId, partition, epoch, revision, transactionId and redirect against each immutable header identity.
For the same source and epoch this exact metadata equality proves the accepted input unchanged under the type-writer
revision rule. Missing/nonvisible identity, changed revision/transaction/redirect/partition epoch, ownership failure or a
second redirect requires refresh/cancellation, failing closed. Do not call `readItemTypes`, the full observer or full type
equality again per page, publication or consumption. Keep the initial source positions; ignore unrelated partition
progress when checking identity. Release all source clients before the account/gate command. Validate
the native association and gate inside the writing transaction. Changes after that released observation are handled by
the existing source projection/verifier; no cross-partition lock or globally atomic source claim is implied. Missing
source, closed account/gate, old epoch, stale binding or absent evidence cancels/fails closed. Retry can restart only
from fresh native owner/source observations. Purge orders against the same account/gate locks, advances the epoch and
fences late publication. Cleanup erases reservation text/bytes and evidence in bounded dependency order. Delayed events
and ready receipts cannot restore erased payloads or reopen the namespace.

If cancelled/missing evidence leaves the same pure binding on a fresh observation, only the admitted native producer
may allocate a new preparation UUID under the locked active-binding slot. Include that UUID in metadata receipts;
old cancelled receipts cannot trap fresh work. Live equal bindings still converge and compare exact native input.

## Entry consumption and retry

Use the original finite request deadline (`deadlineFor`/request context), including preflight, source revalidation and
`ownAccount`. Do not renew it per page, poll while holding a connection, or use domain clock time for wait budgets.
If metadata is pending or time is insufficient, return the existing retryable 503 before the entry effect; its committed
metadata intent survives independently. No 202, new operation/status endpoint, new timing/header format or partial entry.
The worker finishes metadata only. The caller retries the original entry request key after readiness.
Retries with retained native evidence use identity-only revalidation rather than recapturing the full source input.
Only a required refresh starts a new initial observation/preparation.

Immediately before the ordinary entry command, `revalidate` reloads native evidence and checks current owner/subject
Access plus both source identities using metadata-only RR reads. It returns refresh on change. Inside the ordinarily
authorized command, `consume` checks native readiness, exact binding and current account/gate epoch again before using
the key. Return the retained initial source stamp for projection ordering; a metadata-only check does not replace it
with a newer partition position. A reference or caller constructed `PreparedType` cannot bypass those checks.
Revalidation grants no subsequent user effect authorization.
An expired budget/refresh aborts before entry writes; later source changes use current type projection/verifier.

Preparation fields never enter the public user-command receipt digest or replace its original canonical user input.
Same-key changed body continues to conflict with the original digest; readiness/reobservation cannot create a new user
receipt namespace. A transient 503 before user effect writes no successful entry receipt. A successful retry creates one
ordinary entry, one revision and ordinary head/counter/activity/follow/event changes. Exact receipt replay returns its
original HTTP status/body without mutation; normal update CAS is unchanged. READ filters never invoke preparation or
allocate roots, reservations, evidence, receipts or events for an unknown type.

The entry writer first enters its ordinary authorized command and checks its receipt. Only a fresh, valid create
unwinds that checkout to request preparation; it then retries the same unchanged command input after identity-only
revalidation. This also keeps replay after deletion from producing new metadata. The original request deadline covers
both attempts and the intervening preparation; no owner connection remains checked out across preparation.

## Implementation ownership and acceptance

Each row below is an independently reviewable code slice of at most 400 changed lines / 8 files; split further by native
store/SQL versus adapter if needed. Dependencies are code imports only, never a wait for this readable document.

| Owner                 | Concrete scope                                                                                                | Code prerequisites                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Schema/interface      | Native immutable evidence/checkpoint and enqueue data, storage/erasure constraints; retain these ports        | Existing shelf reservation/gate schema                                     |
| Producer              | Authorize, observe one hop, bounded reserve, native evidence and initial outbox                               | Schema and concrete `preparation-source.ts`, composed `shelf-type-keys.ts` |
| Bounded effect runner | One native continuation, receipt/event recovery, final readiness, cancellation                                | Schema and composed key port; no entry hook dependency                     |
| Entry-hook consumer   | Current Access/revalidation, consume readiness before ordinary entry effects and retryable 503                | Producer, runner, ordinary entry store/hooks                               |
| Final wiring          | Sole owner of `work.ts`, `work-module.ts`, kernel composition and shared-stub re-exports; real outcome driver | All concrete modules above and entry hooks                                 |

The driver uses real production commands, Access and fixtures, observes actual SQL/source/commit/enqueue boundaries and
pauses actual effects. It must not model rules, normalize failures, fabricate keys or counters, or mutate source truth
with raw SQL. Fault injection may remove evidence or corrupt a binding only at the native persistence seam under test.
Root paths, forced digest collisions, byte/transaction bounds, every crash gap, deadline retry, source/owner/deletion
races, concurrent conflicting input, absent evidence and current user authorization are executable outcomes. Use
`bun specs/support/verify-outcome-suite.ts specs/library-type-preparation-outcomes.test.ts LIBRARY_TYPE_PREPARATION_DRIVER
"Library type preparation outcome driver is required"` to prove every scenario red without a driver, the frozen binding
test for the helper, and `bun scripts/typecheck.ts` for repository type compatibility.

The frozen `specs/library-type-metadata-outcomes.test.ts` adds an unrelated real semantic identity write in the same
source partition while a collision is staged. The original preparation must finish through actual repeated pages
without re-reading full source types. `advanceUnrelatedSource` uses the real semantic command, never raw SQL or a model
position increment. Inspection `sourceReads` records initial/page/publication/consume phases from actual SQL/protocol,
with the ownership and identity client IDs equal; subsequent reads have null typeClient and zero typeBytes. Measure
before returned JS maps discard any columns, including retries and separately anchored origins/survivors. Initial full
type observations remain available in `observations`. The metadata suite's no-driver verifier uses the same driver
variable and missing-driver message as the outcome suite. Acquire its stack slot outside the verifier's short child
timeout so queued admission can finish normally. Passing that verifier claims no native integration or outcome.

## Cost

### Source revalidation

- Touches: each independently anchored origin/survivor partition's ownership, indexed identity and redirect points.
- Bound: fixed rows, statements and result bytes per page, independent of source input length or unrelated revisions;
  initial accepted input and final exact native publication remain O(input bytes). No input cap, full type identifier in
  DBOS, per-type source lock, global lock or new authority is introduced. Existing Access rechecks remain required.
- Growth check: `specs/library-type-metadata-outcomes.test.ts`, “native continuation verifies identity without
  retransferring staged source text”, requires actual repeated-page typeBytes=0 and same-client metadata. The source
  adapter and semantic helper own native statement/byte and population measurements; this contract reports no costs
  as measured until those native checks run.
