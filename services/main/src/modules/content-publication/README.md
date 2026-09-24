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

This module does not project MatchUnits, certify Lucene readiness or perform
Content erasure/GC. The integration test exercises real PostgreSQL pin/settlement
transactions with simulated graph receipts. Native Jena command execution and
profile validation require the `content-publication-v1` model/Jena binding.
