# Public discovery index

The mixed public index uses one generation and one ranking context for Subjects, Accounts and each admitted public
metadata kind. A candidate generation is identified by its generation number, database incarnation and physical index
UUID. Its registered kind set is frozen at allocation; replacement builds a new physical index and never reinterprets
an older generation or receipt.

**Decision:** A candidate missing any required native producer remains unallocated, and the current active physical
generation stays in service until a complete replacement can publish.

## Producer readiness

The second-scope public metadata kinds are `collection`, `review` and `space`. Their population producers supply
bounded raw-key pages, exact native observation positions and current keyed reads. Review population requires
Content's `pageWithCut` and retains its opaque continuation; the legacy key-only page cannot certify coverage. The
strict Format2 codec keeps review `source_version` through durable actions and current equality. Search uses the
common generation and writer lifecycle; it does not create a second eligibility or reduction store.

Registry ownership follows the current scope table: `collection` uses Commerce, while `review` and `space` use Content.

The default query registry binds Commerce with `createNativeCollectionDiscoveryAdapter`, reviews with
`createNativeReviewDiscoveryAdapter` (or the worker's supplied `ReviewDiscoverySource` through
`createReviewDiscoveryAdapter`), and Spaces with `nativeSpaceDiscoveryAdapter`. The actual query caller is
`createDefaultDiscoverySearch`; the worker caller is `searchWorkModule.register` → `startSearchIndexing` →
`startDiscoveryIndexing`. These adapters supply current owner reads; their registration alone is not generation
population evidence.

Decision: use the English labels “Collections”, “Reviews” and “Spaces” with the `library`, `message-square` and
`users` icons until the owner adapters supply localized kind metadata.

The retained generation runner now allocates five independent producer frontiers: Accounts, semantic Subjects,
Collections, reviews and Spaces. It requires all five population capabilities before allocating a replacement; missing kinds return
explicit `DiscoveryProducerCoverageError` readiness before a transaction, physical target or population row is
created. Each producer advances only after its exact actions are visible at the captured physical UUID. Existing active
generations and relays remain available while a replacement is incomplete. Native census or source-fence capability
remains typed unavailable; neither counts nor empty scans certify it.

Only owner-approved public metadata may enter these documents. Realm rating figures, private Collection membership
and Collection predicates remain outside the public index. Current summaries continue to hydrate from their owners.

## Build, catch-up and publication

Allocation first binds the replay consumer, registered kinds and physical incarnation. Each supported native owner
population is exhausted independently by bounded keyset pages ordered by full `(route, id)` keys. A page frontier is
stored only after the shared exact-version writer settles its actions against the captured physical target. Native
positions are observations, not a substitute for enumerating every eligible key.

Relays reread current owner truth for event keys and retain the actual source position as the external version. The
writer records a per-kind keyed deletion high-water, validates the target UUID and allocation incarnation, and writes
only to the target's write alias. A stale event cannot restore a deleted key at the same native position.

After population, the generation catches up its replay checkpoint and reconciles every indexed identity against
current owner truth. Reconciliation repeats when native positions or owner revisions move. Publication requires every
producer population to be complete, replay to be current, all reconciliation partitions to be certified and the
physical UUID to remain unchanged. Only then does an observed alias switch make the candidate active; the former
generation becomes retiring after that observation.

## Retirement

The old generation continues receiving relays until it is no longer active. Retirement stops its relays, verifies and
deletes the exact physical index incarnation, then reclaims bounded copy locators, population rows and checkpoints.
Account erasure retains its late-item acknowledgement protocol through retirement. Generation observations establish
index readiness only; current owner authorization and disclosure checks remain authoritative.

The actual default worker path is `searchWorkModule.register` → `startSearchIndexing` →
`startDiscoveryIndexing` → `advanceDiscovery`. It wires the Commerce Collection source, Content review source and
native Space source into the five independent population, relay and reconciliation frontiers. Publication requires
complete populations, caught-up replay, current keyed reconciliation, the strict expanded registry, the captured
physical UUID and durable native frontiers to agree. Current owner hydration alone does not make an incomplete
generation ready.
