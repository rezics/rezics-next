# Members preparation reservation (specification only)

[The interface](members-preparation.ts) specifies private episode reservation, read touch and the exact step
admission boundary. Its factory constructs successfully; all three operations throw explicitly. Native cases
must fail at those operations, never accept their errors as satisfied behavior. This is neither native product
acceptance nor a freeze. No schema, SQL implementation, route, worker registration or ready member result is added.
The manager reviews this contract before commissioning the independent bounded producer.

The authorities are [owner predicates](../../../../docs/library-owner-queries.md), the [Members GET
exception](../../../../docs/dynamic-collections.md#model-and-identity), [filtered lists](../../../../docs/filtered-lists.md)
and [deletion](../../../../docs/deletion.md). Their numeric ceilings are authoritative; the numbers in acceptance
examples instantiate them rather than introduce tunable constants. Existing absence claims about shared grammar
or operational Core in those documents are stale: both actual producers are present. Owner execution, complete
canonical readiness and partitioned identity remain incomplete.

## Actual dependencies read

Core source is `5b5c3be17ea1c7c747d09cdcdcfa0ac89ca37cfe` (`dev5b5c3be17e` in the brief), with the same exact
`command/operational.ts` bytes in this checkout. The branch alias itself is not a local ref. SHA-256 evidence:

| Native source | SHA-256 |
| --- | --- |
| `command/operational.ts` | `0ad898f9765a23ce11680b9c140083c14602de599da696654d78f5b41c7ea3cc` |
| `command/README.md` | `d7bc1821cdfb375a26c5640a0201bd647930d9afda53a2b1ca99b1863e799566` |
| `test/command/operational-transaction.test.ts` | `022e9be87a43e1d800558f8d2f41f1e1150f283a713bae64507d391555730f17` |
| `test/command/operational-transaction-growth.test.ts` | `db5c2befd07f37ce46b3f485e3bcc465d29496820947f23054768111c811650c` |

Read surfaces also include `command/support/operational-fixture.ts` and `operational-runtime.ts` under tests;
`request/access.ts`, `access/account-share.ts`, `work/client.ts`, `work/queues.ts`, `work/registry.ts`, Library's
`work.ts`/`work-module.ts`, Collection commands/readers/routes and their HTTP/read/source/worker fixtures;
shared `test/support/personas.ts`, `test-kernel.ts`, `growth.ts`/`growth-capture.ts`, and
`test/access/native-account-bindings-fixture.ts`. Auth's actual workflow method is `deleteAccount`
(`services/auth/src/workflows.ts`), with fresh approval demonstrated by `native-workflow-refusals.test.ts`.
The test helper names the persona use case `deletePersona`; it calls that actual API. It does not invent an Auth port.
The actual shared `packages/filter/src/{filter,owner-filter,index}.ts` and README supply FilterDocument,
parseFilter and admitFilter, including owner leaves and saved expansion. Canonical JSON uses the existing
`canonicalize` dependency, as in native Collection command digests and Search cursor request binding.
No external reference project is named by these reservation source authorities or required for this slice.

## Local API and authority

`createMembersPreparation({pool, workClient, access, clock?})` accepts the real shared Pool, WorkClient and Access,
and optionally the trusted KernelClock. It returns:

- `reserve(verifiedActor, collectionId, definitions, {deadline?}?)`: deduplicated preparing episode metadata and
  the exact newly committed locator intent, or `intent:null` when every episode already exists.
- `touch(verifiedActor, locator, {deadline?}?)`: true only when this current authorized read can touch that exact
  live, unexpired episode. False means obsolete, never ready. It must not create a header.
- `admitStep(operationalTx, locator)`: a Boolean exact-episode check/lock inside the registered step's existing
  work-step operational transaction. No Actor, disclosure authorization or retained permission is accepted.
  True is usable only until that transaction ends. It is not permission for an apply in another transaction.

Definitions carry the actual FilterDocument, fixed `id` order and an immutable accepted release digest/value.
Validate and expand with shared parse/admit rules; no private interpreter or alternative DTO is selected.
The exact canonical basis is `canonicalize([1, principal.id, collectionId, expandedFilter, sort, releaseDigest])`.
Preserve its bytes alongside SHA-256. Digest equality alone never establishes definition equality. The indexed digest hit must compare
the retained exact bytes; unequal bytes fail closed with existing unsupported_query, never share an episode or
scan a collision bucket. This avoids putting potentially large canonical JSON in a PostgreSQL B-tree key. No semantic
commutativity rewrite is implied: shared expanded array order remains significant. Limits and cursors are absent
from this key; continuation and different page sizes share an episode. Release meaning changes do not share it.

The namespace is the current native `principalCommandIdentity(verifiedActor).principal.id`. Requested-by is
native attribution/delegation evidence, never an HTTP owner selector or an instruction to substitute the curator,
operator or an inferred human. The current API's account principal remains the verified Actor's account id;
Access revalidates its actual delegation evidence on each attempt. Anonymous private reservation is concealed
with native not_found. Foreign and insufficient-scope private Collection requests use that same existing shape;
pre-suspension bearers retain the current `403 account_suspended` authentication behavior. The older owner-query
prose's 401 sentence does not replace the actual shared authentication contract.

Initial scope is a same-owner curated Collection created through mounted production POST and admitted by current
`collection:read`, on the owner's route. The native fixture proves its mounted members GET succeeds and releases
its read snapshot before reservation. It proves no logical Everything/state or foreign-source admission.
A batch covers distinct definitions for that ONE Collection. This is sufficient to specify two reads and an intent
with multiple locators without claiming all common-page reads are supported. Cross-Collection/source batches
need the common-page owner's actual resource/page Access binding: Core accepts one authorization resource that
must belong to the operational partition. There is no invented synthetic resource, owner-account read action or
public source bypass here. Full cross-resource composition remains a named followup before common-page exposure.

Request implementation must use exactly `runOperationalTransaction(pool, options, body)`: request mode, native
principalCommandIdentity, accessCommandAuthorization for `collection:read` on `{route,id:collectionId}`, the same
partition, `accounts:[principal.id]`, the existing WorkClient and the shorter request/consumer deadline.
No authorization callback/permission flag is exposed by this interface. Core mints authoritative time without a
held connection, prepares Access, begins SERIALIZABLE, finalizes current authorization, takes active partition and
account SHARE fences, executes body, finalizes Access and commits. The implementation cannot rearrange these gates.
Work steps use Core mode `work-step` with exactly the locator's owner account and partition; retake active account
and partition fences before the episode lock. No step authorizes disclosure. Every later read still needs current
source/subject/foreign/tuple/identity safety checks, including exclusions and order.

## Episode, intent and quota lifecycle

The proposed native header relation is `library.members_preparation`. Its route-leading primary key is
`(route, owner_account_id, collection_id, episode_id)`. episode_id is a newly allocated routed native UUID on
insertion, an opaque generation identity, never a semantic epoch or time-derived reuse key. Header fields include
exact canonical_basis, basis_digest, state (`live` or `retired`), last_read_at and workflow_id. The live digest
unique key is `(route, owner_account_id, basis_digest) WHERE state='live'`, with exact-byte equality required
after the hit. A collision refuses admission rather than aliasing definitions. Expired headers are retired before
replacement. Retired payload remains retained cleanup work; it is not implicitly erased by changing state.

One indexed `library.members_preparation_owner` control row keyed by `(route,owner_account_id)`, with `live_count`, serializes live
quota and the LRU order. Its live count is maintained atomically, never reconstructed from all result/history rows.
Lock control before deciding admission. A bounded indexed LRU frontier orders live headers by
`(last_read_at ASC, episode_id ASC)`; UUID order breaks equal trusted timestamps. Insert increments count, retirement
or expiry decrements it exactly once; replacement retires then inserts in that same transaction. A committed
actual read's explicit touch moves last_read_at forward under trusted time. Repeated preparing reservations perform
the initial read plus one exact uniqueness probe, with no second enqueue, LRU rewrite or additional retirement.
An owner with unrelated retired history must have the same examined neighbourhood. Owners do not share quota locks.

Use the live-result quota and idle expiry from [Preparation cost](../../../../docs/filtered-lists.md#cost).
At equality with the idle deadline an episode is expired. Expiry/touch serialize against the same owner control;
a stale touch never extends or replaces an expired episode. The request retires only the required least-recently-read
HEADERS, deleting no result row and performing no arbitrary result/history cascade. Needed cleanup locators belong
to the SAME bounded batch intent as new admissions, with durable cleanup continuation if a page cannot drain them.
No permanent abandoned-history exception is created. Idle maintenance must eventually retire and drain untouched
expired episodes through the later bounded producer, even without another request.

The native body uses uniqueness `INSERT ... ON CONFLICT DO NOTHING RETURNING` to decide which episodes were CREATED.
Only the creating transaction may enqueue. A collision must recheck exact basis/current episode; transaction retry
reexecutes Core and cannot enqueue twice. For a mixed batch, return all distinct current episodes but enqueue only
new episode locators and newly retired cleanup locators. Keep the losing/duplicate path free of manufactured writes.
All created episodes in one batch name its single deterministic workflow id, based on the lexicographically least
new episode UUID: `library:members-preparation:${route}:${ownerAccountId}:${episodeId}`. Every created episode has
exactly one committed owning intent; batches may share one intent. Recreated episodes always allocate a new UUID and
therefore a new workflow id. A terminal old DBOS id can never suppress work or retain old inputs for its successor.

Call exactly `enqueueIntent(tx, {queue:'workflows',workflowName:'library.membersPreparation',workflowId,input})`
INSIDE that same body. `input` has exactly `{accounts:[owner],route,episodes:[{collectionId,episodeId}],
cleanup:[{collectionId,episodeId}]}`; deduplicate and sort both locator lists. Existing common-page read limits bound
the admission list; eviction cleanup is bounded by those new admissions. This intent contains no filter, title,
fact, result, cursor, bearer, pin payload or cached allow. All SQL, including both SDK enqueue statements, uses the
same actual client; no relay/intent table, SDK deduplication option or second held connection is permitted.
The new workflow name is reserved for the later producer; this specification does not register or launch it. The
native tests inspect real ENQUEUED status/input with the real WorkClient and existing workflows queue.
Auth's process-global runtime stays separate; there is no second Auth/kernel executor or fake actor.

A step locks only the exact selected header under its current active account fence. Missing, retired, expired,
replaced or wrong-owner episodes refuse before mutation. It never upserts an absent row and cannot borrow a
successor's definition or mutate it. Account terminal T prevents both fresh reservation and late apply; an old
committed intent is not permission. An already acquired native account SHARE completes before T; deletion waits
on that lock. Tests observe pg_blocking_pids and actual locks, never infer order from elapsed time.

## Erasure inventory

All private header canonical bases/digests, owner control/LRU, episode bindings and later result/frontier rows
belong to Library A5. Exact inventory is owner route/account, Collection and episode, then independent bounded
child keys. At T, refuse reads/touches/new headers/step applies immediately. Drain result/frontier children,
then headers and control, through indexed bounded work. No retention exception or permanent private tombstone is
adopted. Existing read/command/receipt/outbox/grant/write-basis/partition positions remain unchanged by reservation.
DBOS status/input/output/step/message copies belong to Accounts shared-history. Record exact workflow/payload
locators atomically with their actual durable copy; its registered minimizer erases owner attribution/locators
when required while preserving only permitted completion skeletons. Registration and final producer handoff are
required runtime dependencies, not implemented here. An enqueue alone is not the copy inventory or ACK. Library's
own drained inventory/ACK is not whole-role NoData, overall erasure completion or backup expiry.

## Cost and required native evidence

### First preparation admission and duplicate

- Touches: existing ready lookup/direct prepare decision and its released snapshot; then Core time, all Access
  preparation/finalization, SERIALIZABLE partition/account fences, owner control/LRU/uniqueness, retained intent and
  both DBOS enqueue statements on actual backends. No source input key is read by reservation.
- Bound: the existing preparation-step statement allowance per ATTEMPT, in addition to the existing one-read or
  composed read allowance, as adopted by Performance decision 29. This does not grant an extra allowance. Retry is
  bounded by the native request command deadline (5000ms ceiling; shorter request wins), not a count cap. No
  maxAttempts option, hidden rollback/control statement, local executor or subtraction. If the actual baseline
  exceeds the authority, send captures to Performance before freeze. Each backend has one total connection,
  released before the next phase; the separate contenders in the race are separate requests.
- Growth check: named native `first202`, `duplicate`, `quota-full retirement`, `forced-one-contention-retry`
  cases at 64/512/4096 independently against retired owner episodes/results and unrelated history. Count every
  Core/Access/control/rollback/DBOS statement; rows/statements constant and blocks logarithmic per backend. The
  forced retry's attempt must have the same neighbourhood/budget as first admission. Grow retired history without
  increasing live quota; do not relocate the hot owner. Read and intent captures remain separate.

### Retired header and late work

- Touches: exact owner/episode indexed point plus bounded cleanup frontier and active account fence.
- Bound: the [single kernel bounded-job authority](../../README.md#bounded-job-steps) plus any stricter filtered-list ceilings; retained cleanup must
  settle finite work. No request-time per-definition result/history scan, synchronous cascade or missing=ready.
- Growth check: independently grow expired/retired episodes, successors, queued stale intents and unrelated histories
  at the same three scales. Selected-episode work stays constant and every cleanup continuation is charged. Native
  negative header scheduling is allowed only after a real positive reservation. The result-payload population,
  indexed frontier/cleanup continuation and copy-minimizer bindings require the independent bounded producer;
  their absence is explicitly not numeric success. No full query/source maintenance claim follows from this slice.

Required native cases live in `test/library/members-preparation-intent.test.ts`, with real shared personas, native
Auth, mounted Collection create/read, actual Access, one owned PostgreSQL and WorkClient. They independently reach
reserve, touch and fenced admitStep. Body/enqueue faults use real PostgreSQL trigger failures. Quota and composed
cases inspect real headers and DBOS inputs and forbid result deletion SQL; populated retained-result nondeletion
still needs the later native result producer rather than fabricated ready members. The deletion schedules use
fresh Auth approval and actual row-lock observation. Fixture success, reached missing method, actual pass at a
revision and promotion are separate evidence. A red specification cannot certify the numeric bounds.

Remaining implementation dependencies: reservation schema/indexes and bounded native producer/registration;
Library A5 cleanup and Accounts actual-copy minimizer handoff; full Members adapter including unsupported-source
admission and HTTP 202 behavior; shared common-page cross-resource Access composition; full owner query/index,
logical Everything/state, Continue/Liked, publication, source eligibility, canonical identity and readiness.
This metadata contract closes none of those followups and guesses no pending epoch vector, control partition or P.
