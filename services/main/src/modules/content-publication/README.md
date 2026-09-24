# Content publication boundary

`publishPinnedContent` requires a trusted `content.publish` admission, a current
PostgreSQL Content draft head and the exact Content revision/digest/owner epoch.
Before pinning, it requires the reviewed `content-publication-v1` variant and
decision shapes in both generated model artifacts and Fuseki command health.
This fail-closed gate prevents an unvalidated graph write.

The guarded graph command records the exact Content revision, digest, preparation
ID and Content owner position with the variant publication head, graph receipt and
outbox in one Jena transaction. No SQL or body fetch runs inside that transaction.
`reconcilePinnedContentPublication` reads the exact graph receipt, verifies its
admission, source reference and both owner epochs, then settles the Content pin.
A missing or ambiguous graph receipt leaves the pin pending. A graph cancellation
with a guarded stale-head receipt can release it; a timer cannot.

The bounded Content projection relay consumes one contiguous Content outbox
position at a time. It acknowledges draft/preparation events, verifies terminal
publication positions against the settled Content pin and exact graph receipt.
An active pin alone has no public search authority: projection also requires a
separate current public eligibility decision for that exact publication. It then
plans a guarded public MatchUnit from an exact revision body. The planned
graph command carries its own deterministic receipt, source position and zero-event
outbox batch. Search over Content variants checks the Content checkpoint, graph
publication inventory and jena-text generation before returning a complete result.
It is a distinct lane from Main Version and Realm-effective Contribution search.

The relay currently stops before an active publication because the reviewed
`content-match-unit-v1` projection profile, native Jena binding and reviewed
public eligibility decision have not landed.
It does not claim a live MatchUnit write or index-ready publication. The current
integration test proves durable progress through nonpublic events and fail-closed
behavior against isolated PostgreSQL and pinned Fuseki. Content erasure/GC,
rebuild, runtime worker wiring and a successful live projection are later work.
