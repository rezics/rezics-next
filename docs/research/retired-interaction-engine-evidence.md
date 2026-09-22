# Retired Fluree interaction evidence

Historical evidence, retained 2026-09-23. The engine reviewed and measured here
was Fluree 4.2.1, which is retired from the active REZICS architecture. None of
these results validates Fuseki, TDB2, jena-text/Lucene, the new application sequence
or receipt/outbox protocol. The selected implementation is the
[Jena interaction blueprint](../implementation/interactions-and-cache.md).

The following source review and bounded observations retain their original scope.
Reproducing the archived script is separate research work, not a Jena launch step
and not authorized by the documentation-only architecture reconciliation.

## Fluree mechanisms checked

The reviewed release is **v4.2.1**, tag commit
`82dbcec3e435d6ed1d45bc0ed929432323b6b201` (released 2026-09-18).

| Requirement | Evidence and limitation |
| --- | --- |
| Create once, change, withdraw | JSON-LD WHERE/DELETE/INSERT supports conditional creation and compare-and-swap. Zero matching rows make the whole update a no-op, including literal INSERT templates. [Conditional updates](https://raw.githubusercontent.com/fluree/db/v4.2.1/docs/transactions/conditional-updates.md), [upstream tests](https://github.com/fluree/db/blob/82dbcec3e435d6ed1d45bc0ed929432323b6b201/fluree-db-api/tests/it_transact_conditional.rs). |
| Concurrent writes | The HTTP path serializes writes per ledger. Different ledger writes may proceed in parallel. This supports one effective writer's guarded creation but also defines a throughput boundary; more Main replicas do not remove it. [HTTP transaction contract](https://raw.githubusercontent.com/fluree/db/v4.2.1/docs/api/endpoints.md). |
| Joined reads and counts | Native queries can join interaction subjects to content and apply filtering, grouping, ordering and limits. Anchored queries and bounded work remain necessary. [JSON-LD query interface](https://raw.githubusercontent.com/fluree/db/v4.2.1/docs/query/jsonld-query.md). |
| Read after a write | The HTTP `Fluree-Min-T` header can require observation of a minimum transaction position. Keep the ledger/branch with that position; it is not a global ordering across stores. [Query contract](https://raw.githubusercontent.com/fluree/db/v4.2.1/docs/api/endpoints.md). |
| Background indexes | Commits enter novelty before incremental indexing; queries merge indexed data with that overlay. High churn can increase query work and trigger indexing backpressure. [Performance design](https://raw.githubusercontent.com/fluree/db/v4.2.1/docs/design/performance.md). |
| Cache event recovery | SSE publishes nameservice changes and may skip broadcasts when a receiver lags. It is a wakeup hint, not a complete business change log. [Event handler](https://github.com/fluree/db/blob/82dbcec3e435d6ed1d45bc0ed929432323b6b201/fluree-db-server/src/routes/events.rs). |

Source examples need interpretation: the conditional-update guide's comparison
with an earlier ledger `t` cannot identify our successful operation if an unrelated
write intervenes. Check our guarded operation receipt. Similarly, ledger-qualified
positions remain essential despite broad wording in some receipt documentation.

## Executed historical probe

On 2026-09-22, the official Linux x86-64 Fluree 4.2.1 CLI archive was verified
against its published SHA-256:
`01ca654e354db61caf28f362eef2a5868ddf9173c2bb1261d988007c4aaa5a5c`.
The [reproducible probe](../../scripts/research/fluree_interactions_probe.py) uses
a new temporary directory, a loopback HTTP server and file-backed storage, then
stops its own server and builds/reloads the index.

Eleven assertions passed: minimum-fence read; create; duplicate-create suppression;
no receipt on a rejected guard; unlike with stale replay; no stale event; re-like
with retained identity; favorite/content join before ordering/limit; active-edge
count; twelve concurrent HTTP attempts creating one logical edge; and the joined
read after indexing/reload. This verifies those small mechanisms only. It does not
test the full operation-key protocol, production schema, authorization/privacy,
power-loss durability, Redis, capacity or end-to-end product acceptance.

Reproduce with a locally obtained, verified release binary:

```sh
python -B scripts/research/fluree_interactions_probe.py --fluree /path/to/fluree
```

Current Jena qualification must independently cover guarded updates, repeated
operation identity, concurrent creation, data fences, private disclosure and crash/
restart. Engine-specific Fluree headers, ledger positions and history APIs are
not target requirements. See [interaction blueprint](../implementation/interactions-and-cache.md)
and [backend acceptance](../testing/backend-integration.md).
