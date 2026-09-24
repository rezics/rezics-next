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

`selectPublicContentSearch` is an internal release primitive. Its caller must
pass the fresh claimed, dispatch-eligible Access registration for the exact
reviewer, variant, request digest and `content.search-eligibility` scope. The
reviewer explicitly attests public disclosure and an original-contribution
rights basis; this primitive does not independently verify provenance or expose
an HTTP route. It requires the exact active Content publication and the expected
prior eligibility head. A native validated graph command writes the current
eligibility head, immutable decision, receipt, one typed outbox event and next
graph sequence together. Exact graph receipts resolve same-key replay and lost
responses; stale heads receive a terminal cancellation receipt.

The bounded Content projection relay consumes one contiguous Content outbox
position at a time. It acknowledges draft/preparation events, verifies terminal
publication positions against the settled Content pin and exact graph receipt.
An active pin alone has no public search authority: projection also requires a
separate current public eligibility decision for that exact publication. It then
writes a guarded public MatchUnit from an exact revision body, validating both
the projection anchor and MatchUnit native shapes. The graph command carries its
own deterministic receipt, source position and typed outbox event. Search over
Content variants checks the Content checkpoint, graph publication inventory and
jena-text generation before returning a complete result. It is a distinct lane
from Main Version and Realm-effective Contribution search.

The relay still stops before active publication when the reviewed native
`content-match-unit-v1` or `content-search-eligibility-v1` profile is absent.
The isolated integration test proves durable progress through nonpublic events
and fail-closed behavior. A successful live eligibility decision and MatchUnit
projection, Content erasure/GC, rebuild and runtime worker wiring remain to be
qualified after the native profiles are merged.
