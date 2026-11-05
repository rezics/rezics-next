# Public Collection listing freshness

This owns ordering for the existing public membership projection. The ports in
`listing-freshness-contract.ts` are throwing proposals, except for the pure stamp comparison and public-history
predicate. No migration, route, command or workflow is installed by this specification. Product acceptance stays red
until the native driver passes `specs/library-listing-freshness-outcomes.test.ts`.

## Defect and boundary

`listing.ts` reads `listing-source.sql`, releases the source connection, then enters the subject command using
`listing-apply.sql`. The digest includes the Collection transaction UUID and multiplicity. That distinguishes receipts
but does not order their first applications. Pause a positive observation after source release, make the Collection
private or deleted, apply its newer zero, then release the old observation: the current target SQL restores the pair
and count. Existing `test/library/listing.test.ts` reverses notifications that reread current truth; it does not pause
an already captured observation. Its fixture store mutations also do not advance `core.partition.position` through
`runCommand`. Preserve those tests; the new native fixtures must use actual Collection/member commands.

This is an existing Library Privacy defect, independent of account contribution retention. Evidence is steps 4–5 of
the [account-retention report](https://github.com/rezics/rezics-next/blob/a1d0b76e4975daa2cbdbd5f172d0f72039d91252/docs/research/library-account-retention.md).
That report is evidence, not another authority for this contract. No private entry, session, copy, follow, member note,
curator identity or private subject-holder directory is added to a subject partition or public event.

## Source truth and public-history provenance

A Collection's route and source partition are immutable. Node relocation changes routing/epoch, not that partition.
Use the shelf contract's source protocol: obtain current ownership, open one `REPEATABLE READ READ ONLY` transaction,
and call `readPartition` and the Collection/member truth reader on the SAME client. Capture partition, epoch and
position together with active/public eligibility, multiplicity and provenance. Read even an absent Collection with a
partition stamp. An absent/moved/fenced partition, failed query or unresolved owner is normal routing/unavailability,
never a successful zero. Commit/release this client before any target command; never hold both partitions.

Position is native bigint, stored as bigint and compared without Number conversion. At JSON/durable boundaries use
canonical nonnegative decimal strings and restore bigint before comparison. Within one source partition compare
epoch first, then position. Cross-partition comparison throws; it cannot select a winner. UUIDs, command timestamps,
delivery sequence, receipts and workflow IDs are not ordering keys. A higher epoch at the same immutable partition
dominates older epochs. Routing must fence old owners before admitting that epoch.

Add source-owned monotonic `listing_ever_public` provenance. In the guarded era, every Collection create/update/delete
records `old active/public OR new active/public OR existing provenance` in the SAME source transaction. Member commands
retain it. Install a database OLD/NEW transition guard as well as the command hook so an old prepared public-to-private
or delete writer cannot erase the evidence. Retain the bit with the Collection tombstone; physical source removal needs
a minimal source fence, not disappearance interpreted as proof that it was never public. Every successful real source
command advances the core position atomically with these changes through the existing command fence/outbox pattern.

Legacy history is learned exactly, not guessed: current active/public rows and existing public target pairs are positive
evidence. Backfill those only, in indexed keyset pages. An observer treats current-public truth as evidence even before
backfill, without mutating its read-only snapshot; the transition guard persists that evidence on withdrawal. A legacy private
row with no evidence is not asserted to have been private for its entire lifetime. Its false bit means no learned
public exposure in the protected era. This is sufficient only because cutover rejects ALL pre-guard unversioned
observations. Before permitting any new stamped observation, the source transition guard must already be active;
thus a first public observation necessarily leaves durable provenance before a later withdrawal, even if no target
pair has ever been committed. No whole-population transaction or reconstruction of unknowable legacy history is claimed.

`mayRetainListingVersion` permits state only for current public truth, learned source public history, or an existing
public pair. A fresh zero for a never-public private/unlisted Collection creates NO target pair, version, Collection
fence, listing aggregate, receipt, outbox row or holder hint. It may perform bounded reads to establish absence, then
exit before opening a committing target command. Existing pairs are sufficient evidence even during source backfill.
Only public-history identities can appear in zero versions or Collection fences. Provenance is internal, not an API field.

## Native monotonic target transaction

Propose `subject_collection_version`, keyed by `(route,subject_id,collection_id)`, carrying immutable Collection route,
source partition, non-null epoch/position and projected multiplicity including zero. Positive `subject_collection`
rows carry the same non-null stamp. Retain a zero version when the last pair disappears, including when the newer
zero is the FIRST target application. An unknown pair is not a license to discard its public-history zero fence.

Inside the subject's serializable `runCommand`, lock/read the version and any Collection fence, including concurrent
first insert via unique-key conflict/retry. Read the existing pair as public-history evidence. Then:

- A never-public zero with no known pair is unretained and has no committed target effects.
- An older stamp is stale and changes neither version nor pair/count/event. Receipt replay alone is insufficient.
- An equal stamp with identical projected payload is duplicate and has no effects. Different multiplicity or immutable
  source binding at an equal stamp is an invariant failure: abort the whole transaction, not an arbitrary winner or
  a repair based on arrival order. Comparison includes zero; internal time/transaction IDs are not projected payload.
- A newer stamp replaces the version, even if multiplicity is unchanged. A zero deletes the positive pair. A positive
  creates/updates exactly one pair regardless of duplicate member occurrences. Different source partition/Collection
  route is an invariant failure, never a source switch.

Compute count delta as `positive(new) - positive(old pair)`, not multiplicity difference. Count is nonnegative and
counts distinct active/public Collections. Version, pair, aggregate revision/time/transaction and outbox commit or
roll back together using the native command envelope. A changed multiplicity keeps the existing listed-event behavior,
even if the count is unchanged. A stamp-only advance or unknown-pair zero changes no public aggregate/revision/event.
Zero fences must survive that no-public-change path; do not throw the existing `Unchanged` rollback after writing them.
Listed events retain exactly `{subjectId}` with subject id as event subject. No Collection metadata, provenance or
private fields are emitted. Public count and private/unlisted access checks retain their existing semantics.

For bounded terminal cleanup, propose `subject_collection_source_fence`, keyed by target partition and Collection id,
carrying Collection route and a source stamp proving whole-Collection ineligibility. Only public-history Collections
qualify. All applies consult it BEFORE creating a version or pair: lower stamps are stale and an equal positive is an
invariant failure. Equal zero continues through per-pair comparison, allowing cleanup of an older positive version;
it is duplicate only once that pair is already fenced. This supplements ordering for obsolete or not-yet-applied pairs;
ordinary private-to-public transitions may supersede a nonterminal zero with a newer observation. A terminal purge
must preserve permanent source rejection or a permanent terminal fence, not allow that transition.

## Cutover and prepared writers

Schema creation is not activation. Install the source provenance hook/transition guard first. Stop listing dispatch,
drain its owned in-flight target transactions, and invalidate old source captures/workflow inputs. During rollout,
unversioned durable notifications can request a NEW observation; they cannot supply their saved positive payload.
Backfill existing positive target pairs in bounded pages from released authoritative source snapshots, preserving
public-history evidence before removal. Reconcile counts through native apply, not guessed UUID order. Persist native
page checkpoints and retry ownership moves. Keep listing writes disabled until this preparation is complete.

The target schema owner must enforce compatibility at the database boundary, including old prepared `listing-apply.sql`:
positive pair stamps have no defaults and cannot be null; a pair INSERT/UPDATE must match its locked version's exact
stamp and multiplicity; a pair DELETE requires its version to be zero. Database row guards enforce these conditions,
and the version guard rejects regressions, equal-stamp payload changes and source changes. Only the stamped native
apply path updates versions/fences. The current old SQL never writes a version: its insert fails required stamps,
its changed-multiplicity update fails version equality, and its withdrawal delete fails the zero-version guard.
Its aggregate CTE rolls back with that failure. No permissive legacy fallback or default stamp exists.

Enable these guards under DDL locks that wait for existing target writes, then restart only stamped producers and
appliers. Backfill work is paged; enabling constraints/guards is a schema boundary, not a whole-population mutation
transaction. An old process or prepared statement arriving after this boundary must fail closed, including UPDATE
and DELETE, not merely INSERT. Native acceptance must actually execute the old SQL against a guarded existing pair
and zero tombstone. Do not claim rollout complete from deployment version labels or dispatch flags alone.

## Bounded storage, purge and delivery

Keep subject-leading pair/version keys for pages and point apply. Add Collection-leading reverse indexes over positive
pairs AND versions with the FULL immutable continuation `(collection_route,collection_id,route,subject_id)`. Use
partition-bounded seeks, raw-row pages at most 100 and no OFFSET or full-table materialization. Subject public pages
remain bounded and never expose zero versions. Apply has constant row/statement work plus B-tree depth independent
of unrelated/current/obsolete pairs; source counting is bounded by the existing 5000-member Collection limit.
Total history can grow with public pairs, not with never-public private membership.

Later account purge must keep source public-history/tombstone evidence until source eligibility is terminal, install
and acknowledge target Collection fences, seek both current and obsolete public pair/version history and remove their
count contributions before losing member evidence. Visit existing target partitions in bounded steps to cover pending
first positives with no pair yet; reconcile newly discovered partitions/in-flight work before exhaustion. Keep native
page effect/checkpoint/ack/continuation atomic. Fence GC requires a proved replay horizon or permanent terminal source
rejection; arbitrary observation delay means age alone is insufficient. This contract chooses no contribution-retention
policy, account deletion deadline or right to erase retained public Collections. Retained-public final-source fencing
and erased-Collection terminal fencing must be bound separately by that owner.

## Implementation owners and executable verification

Each implementation is at most 400 lines / eight files; split further rather than growing a combined rewrite.
Dependencies here are code prerequisites, not unrelated product policy:

| Owner                        | Scope                                                                       | Code prerequisites           | Required native acceptance                                                                          |
| ---------------------------- | --------------------------------------------------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------- |
| Schema                       | Provenance, pair/version/source-fence schema, reverse indexes, DB guards    | Existing library/core schema | Required stamps, old prepared INSERT/UPDATE/DELETE rejection, paged legacy bootstrap                |
| Source producer/observer     | Collection command hooks, same-client RR observation, ownership retry       | Schema                       | Atomic position/provenance, snapshot consistency, first-public withdrawal, move/unavailable, bigint |
| Monotonic apply              | Version/fence locking, zero retention, pair/count/outbox native transaction | Schema, observer             | Old first apply, equal mismatch rollback, duplicate/cycles, unknown pair zero, reverse arrival      |
| Native fixtures/races/growth | Bind future driver, real command fixtures and SQL instrumentation           | Source and apply             | Every outcome below, obsolete/current pair growth, bounded reverse pages, rollout guards            |

`specs/library-listing-freshness-driver.ts` defines a real-driver binding, not an adapter implementation. The suite
loads `LIBRARY_LISTING_FRESHNESS_DRIVER`; missing it fails every scenario with exactly
`Library listing freshness outcome driver is required`. No skipped tests or successful fake adapter substitutes.
Hooks pause an actual observation AFTER its RR client is released and BEFORE target apply, or fault real boundaries.
Fixtures use real production commands/core positions, not the old raw-store fixture pattern. Inspection reads native
rows, counts, guards, receipts and outbox; it does not calculate product outcomes in the driver.

Run frozen pure acceptance with `bun test specs/library-listing-freshness-contract.test.ts`. Verify the intentionally
red suite with `bun specs/support/verify-outcome-suite.ts specs/library-listing-freshness-outcomes.test.ts
LIBRARY_LISTING_FRESHNESS_DRIVER "Library listing freshness outcome driver is required"`, and run root typechecking
with `bun scripts/typecheck.ts`. A green red-suite verifier proves only specification execution, not a fixed product.
