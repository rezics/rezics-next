# Public discovery index

The mixed public index uses one generation and one ranking context for Subjects, Accounts and each admitted public
metadata kind. A candidate generation is identified by its generation number, database incarnation and physical index
UUID. Its registered kind set is frozen at allocation; replacement builds a new physical index and never reinterprets
an older generation or receipt.

**Decision:** Missing or preparing owner population producers omit only their own kind; every admitted producer still
proves all native partitions, and hit and kind cursors bind the available and omitted kind sets.

## Producer readiness

The second-scope public metadata kinds are `collection`, `review` and `space`. Their population producers supply
bounded raw-key pages, exact native observation positions and current keyed reads. Review population requires
Content's `pageWithCut` and retains its opaque continuation; the legacy key-only page cannot certify coverage. The
strict Format2 codec keeps review `source_version` through durable actions and current equality. Search uses the
common generation and writer lifecycle; it does not create a second eligibility or reduction store.

Registry ownership follows the current scope table: `collection` uses Commerce, while `review` and `space` use Content.

The default query registry binds Commerce with `createNativeCollectionDiscoveryAdapter`, reviews with
Content's `createReviewDiscoverySource` and `createReviewDiscoveryAdapter` (or the worker's supplied
`ReviewDiscoverySource`), and Spaces with `nativeSpaceDiscoveryAdapter`. The actual query caller is
`createDefaultDiscoverySearch`; the worker caller is `searchWorkModule.register` → `startSearchIndexing` →
`startDiscoveryIndexing`. These adapters supply current owner reads; their registration alone is not generation
population evidence.

Decision: use the English labels “Collections”, “Reviews” and “Spaces” with the `library`, `message-square` and
`users` icons until the owner adapters supply localized kind metadata.

The retained generation runner now allocates up to five independent producer frontiers: Accounts, semantic Subjects,
Collections, reviews and Spaces. It snapshots metadata producer readiness before allocation. An absent producer or a
producer reporting `preparing` or `unavailable` is omitted from the candidate and its registered current-reader slot;
the omission is returned with the available kind directory. A present producer that becomes unready during native work
still invalidates that work, and wrong owners, duplicate registrations, changed witnesses and incomplete registered
coverage remain errors. Each admitted producer advances only after its exact actions are visible at the captured
physical UUID. Existing active generations and relays remain available while a replacement is incomplete. Native
census or source-fence capability remains typed unavailable; neither counts nor empty scans certify it.

Only owner-approved public metadata may enter these documents. Realm rating figures, private Collection membership
and Collection predicates remain outside the public index. Current summaries continue to hydrate from their owners.

## Build, catch-up and publication

Allocation first binds the replay consumer, registered kinds and physical incarnation. Each admitted native owner
population is exhausted independently by bounded keyset pages ordered by full `(route, id)` keys. A page frontier is
stored only after the shared exact-version writer settles its actions against the captured physical target. Native
positions are observations, not a substitute for enumerating every eligible key.

Relays reread current owner truth for event keys and retain the actual source position as the external version. The
writer records a per-kind keyed deletion high-water, validates the target UUID and allocation incarnation, and writes
only to the target's write alias. A stale event cannot restore a deleted key at the same native position.

After population, the generation catches up its replay checkpoint and replays every native metadata population before
reconciling indexed identities against current owner truth. Native replay finds newly eligible identities absent from
the target; the indexed pass removes withdrawals. Each advancement selects at most 128 durable owner/partition
frontiers and settles them in groups of at most eight. Every page remains bounded by its native producer and commits
its own cursor only after the exact target actions settle; a failed group is drained before its error is retried. This
amortizes registry and capability-witness setup without inferring completion or dropping any producer evidence.
Decision: Search discovery batches at most 128 durable owner/partition frontiers per advancement, with population concurrency 8 and final certification concurrency 16, preserving every producer evidence check and post-action cursor.
A changed observation restarts that producer's native pass. The durable `native_complete` flag distinguishes raw
completion from indexed-hit exhaustion; an admitted producer must complete every partition even when its population is
empty. Reconciliation repeats when native positions or owner revisions move. Publication requires every registered
producer population to be complete, replay to be current, all reconciliation partitions to be certified and the
physical UUID to remain unchanged. Only then does an observed alias switch make the candidate active; the former
generation becomes retiring after that observation. An empty partition is evidence only after its producer's actual
native terminal page and completion/certification have been observed.

Empty native partitions register replay with the Core checkpoint sentinel `(epoch NULL, position 0)`. Nonempty
partitions retain their actual epoch and position; subsequent relay advances use the ordinary checkpoint CAS.

## Retirement

The old generation continues receiving relays until it is no longer active. Retirement stops its relays, verifies and
deletes the exact physical index incarnation, then reclaims bounded copy locators, population rows and checkpoints.
Account erasure retains its late-item acknowledgement protocol through retirement. Generation observations establish
index readiness only; current owner authorization and disclosure checks remain authoritative.

The actual default worker path is `searchWorkModule.register` → `startSearchIndexing` →
`startDiscoveryIndexing` → `advanceDiscovery`. Each step resolves the Commerce Collection source, Content review
source and native Space source into an availability snapshot, then wires only ready producers into the independent
population, relay and reconciliation frontiers. Publication requires complete populations for every registered
producer, caught-up replay, current keyed reconciliation, the strict available registry, the captured physical UUID
and durable native frontiers to agree. Current owner hydration alone does not make an incomplete generation ready.

Content's native `spaceDiscoverySource` returns the complete `SpaceDiscoveryDependencyReadiness` through
`nativeSpaceDiscoveryAdapter.source.dependencies`. Search retains the entire ready result, including opaque
`generation`, `cut` and capability fields, in `discovery_generation.capability` with the observed physical UUID and
allocation incarnation. Population, relay, reconciliation, activation and final disclosure recheck each admitted
witness binding. If a Space witness is not ready before a request, Space is omitted and no Space hit is admitted; if it
changes during a retained read, the final native guard still refuses that assembly.
Collection pages also retain their native partition epoch; Review caps each request at Content's native `REVIEW_DISCOVERY_PAGE_LIMIT`, retains the signed `pageWithCut` continuation and
rejects a changed cut instead of retrying it indefinitely. Installed machinery and matching counts confer no coverage.

Decision: replace the physical candidate on a native capability or epoch change, retaining the active target while the
replacement prepares; never reuse external-version or deletion evidence across epochs, even at equal positions.
Abandoned candidates retire immediately; a previously active target retains the ordinary retirement interval.
Collection, Review and Space reconciliation positions are compared only to their respective native readers. Core
partition heads continue to certify Accounts/Subjects and relay checkpoints, not metadata domains.

Each default worker step performs at most one bounded readiness probe per configured metadata producer. A request
resolves the same availability before opening its retained reader; available producers are rechecked by current
capability guards. Omitted producers have no population or final-certification calls in that generation, and their
omission state is included in the response's kind metadata and cursor digest. A newly ready producer remains visibly
`preparing` until the active generation contains its kind. Availability changes allocate a new namespace-local
physical generation through ordinary worker advancement; requests do not rebuild or drain it.

For admitted producer i, complete preparation costs `sum(P_i * C_i(B_i))` plus actual action bytes, writes and durable state;
the 128-frontier selection and eight-page concurrency change elapsed time, not that sum. A reconciliation restart adds
another native raw pass and indexed cleanup; an epoch replacement adds a fresh physical population. Neither term is
absorbed into a retained-count cap. Final certification still examines all 4096 partitions: it reads Account witnesses
in bounded groups of 100 and, for each partition, performs an actual empty-key current-position read for every admitted
metadata producer, with at most 16 partitions in flight. Empty native reads and empty terminal pages still count;
readiness probes add a fixed per-step cost even when a producer is omitted.
Unchanged keyed replay verifies the exact visible winner before advancing.

Review's `C_i` includes five Content snapshots, two ancestry walks (`d <= 33`, `2d+25` local statements), Semantic
reference transactions, nested Access/preparation/citation and optional question work, and full admitted body bytes
before excerpting. Route-range plus ANY requires examined-row and physical-prefix measurements. Native all-pool
1x/4x/16x measurements, including unrelated growth, sparse/all-rejected candidates, maximum bodies, nonstandard
citations and replay, remain unmeasured until controller acceptance executes them; source counts and output limits
are not execution evidence.
