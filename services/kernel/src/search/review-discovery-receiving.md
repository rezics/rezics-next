# Public review journal receiving

The installed caller is `searchWorkModule.register` → `startSearchIndexing` → `startDiscoveryIndexing`.
The worker composes Content's authentic `createReviewDiscoverySource` with its existing Access, pool and token
configuration. `search_review_discovery_receiving` consumes `com.rezics.content.review-discovery.changed.v1`
as a wakeup. Each supervisor step calls `createReviewDiscoveryReceiving.next` once per writable mixed target.
There is no additional executor, timer, population or Content producer. Missing Space/Collection producer
coverage continues to refuse complete mixed activation. Review population remains a separate obligation.

Decision: use a short durable claim before native refresh and validate it under the existing physical-target
writer lock, so a one-connection pool releases its checkout during native refresh and expired work cannot
apply after its successor. Recovery always refreshes current rows again instead of replaying a cached body.

Decision: name the migration with its creation UTC timestamp; the brief's future timestamp is rejected by migration admission.

## Durable state and recovery

`search.review_discovery_receiving` binds the prefix, generation, physical UUID, allocation incarnation,
`REVIEW_RECEIVING_MEANING` and receiving partition. `acknowledged` starts at zero. `through` retains the
current fixed journal cut; `completed_cut` records only a finished receiving pass. `requested` is a wakeup
hint in this same receiving partition. None is the original native event position or the current refresh's
`native_position`. Original tuples/identities are retained in the staged journal page and Content's append-only
journal; independent original partitions are never compared. Duplicate/reordered wakeups can only increase
`requested` in their receiving partition. A fair pending keyset and fixed 4096-partition sweep recover missed
wakeups and initialize new targets independently. Retained targets keep their own state.

Each step claims one partition for 30 seconds, releases the checkout, reads one native page with limit 1–100,
and persists its fixed cut and exact original identities. Nonempty pages call `refreshReviewDiscoveryChanges`
once. Missing/concealed rows become exact keyed removals. Failures retain unacknowledged progress and expose
`unavailable`. The native source owns all dependency/disclosure/hydration checks. Empty pages perform no native
refresh or index actions; they can acknowledge the final cut without changing `native_position`.

Under the existing target session lock the claim must still be current and unexpired before staging actions.
The single staged row atomically retains current upserts/removals and intended journal progress. The mixed writer
uses canonical Format2 IDs, bounded sort normalization, permanent copy high waters, exact writer aliases and
idempotent deletion. Native review validation receives Content's opaque `sourceVersion` unchanged; the independent
native position still orders mixed-writer effects. Review removals use the existing keyed copy inventory, never an
index scan. Bulk receipts and exact search-visible winners are observed before a PostgreSQL transaction commits copy settlement and the
receiving frontier together. A lost response or crash retains the old acknowledgement and repeats current native
refresh. A stolen/expired claimant cannot write after a newer application; target custody serializes effects and
the claim CAS refuses its acknowledgement. Retirement/UUID replacement refuses late target work.

`readReviewDiscoveryReceiving(pool,target,partition)` is the publication owner's installed frontier seam:
`{target,meaning,partition,status,acknowledged,requested,through,completedCut,nativePosition}`. An unseen row is
`preparing`. `ready` covers only that observed journal cut for that exact target and meaning. It never proves
original-effect dispatch drained, source-dependency coverage, complete initial population, whole-index
convergence or viewer authorization. Publication must capture/recheck its own fixed cuts and upstream obligations.
Final result hydration still uses the existing current Content/Accounts readers independently of index progress.

The focused lifecycle test drives the installed supervisor through lost-response recovery, restart, duplicate
wakeups, claim takeover, concealment, disappearance and replacement-generation catch-up. Direct receiver calls
retain control of the held claimant, dependency failure, empty-page observation and refused retired-target write.

## Cost: touches, bound and growth

For admitted batch b≤100: one native fixed-cut journal seek returns at most b+1 raw identities; deduplication
retains at most b. One current refresh accepts at most b IDs and performs at most 2b Content/Semantic owner reads,
with their existing finite disclosure/ancestry checks (Content owns those terms). Each identity produces at most
one Format2 action, one exact copy primary-key probe/upsert, at most one ICU normalization request and one keyed
visibility observation returning at most one hit. The receiver retains at most b identities/actions per stage.
No source query, copy inventory query or visibility query enumerates population/history. A step holds at most one
receiver checkout; native refresh releases that checkout before owner reads, so a max=1 pool is supported.

Per-step work is C_seek(b+1)+C_refresh(b)+C_stage(b)+C_visible(b)+C_commit, plus constant target/claim/cursor
metadata operations. Fair scheduling uses at most two pending index seeks over the fixed 4096 receiving partitions;
claimed rows can require examining that finite domain. Source size does not widen the admitted page. Catching up
N raw changes takes ceil(N/b) nonempty steps and at most one final cut step, independently per target/partition;
a complete missed-wakeup sweep adds 4096 empty partition visits. Retries add their actual finite refresh/write
work, without advancing acknowledgement before visible settlement. Sparse rejection and currentness invalidation
still consume their raw journal identities and keyed removals; there is no refill loop.

The connected three-scale native growth acceptance (1x,4x,16x with fixed page limits, statement/row/seek/action
and retained-candidate accounting) remains unmeasured until the controller runs it after integration. This is not
an admission claim for unresolved native owner terms. Performance must review any such term before admission.
