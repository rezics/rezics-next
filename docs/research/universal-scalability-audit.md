# Universal scalability audit intake

The audit pins source at `9bfbc355f93c38cff7aad61b761bfe49419c7449`. Intake compared its cited paths with dev at
`64655cfb72c163b1fdde5fc85253280f22a033ec`. The supplied archive's 45 manifest entries matched their byte lengths and SHA-256 hashes.
The archive SHA-256 is `9462b2a85ffbb7a96cc4a85672b79d3a76e27cfb4a267db152ce5ed46794adc9`.

The [finding index](universal-scalability-audit-index.jsonl) retains 121 unique families (31 P1, 63 P2, 27 P3)
and the pinned source locations. Of 288 cited paths, 16 changed by intake, affecting
18 findings, including
6 P1 findings.
These counts are a revalidation filter, not a count of open defects. Priority is a research ordering, not a
security rating. The archive contains source review and bounded portable probes. It did not establish native
HTTP, PostgreSQL or OpenSearch behavior, deployed capacity, or a safe hardware-dependent maximum. Archive scripts,
full inventory, duplicated registries and raw measurements remain outside the repository.

## How to use the findings

- Separate an arbitrary total cardinality ceiling from the finite resource limits of each page, batch, response,
  queue and attempt. Keep byte, work, concurrency, authorization, replay and payment invariants. Larger numeric
  constants do not repair repeated whole-state rewrites or an incomplete proof.
- Prove complete semantics and resource bounds independently. Partial evidence cannot establish the absence of a
  match. A derived or approximate accelerator must preserve the exact result contract, including rechecks.
- A logical scale plan does not predict physical capacity. Show how stored state, expanded representations,
  index documents, visibility evidence and hot-key serialization grow; then measure the native bottleneck.

See the [follow-up synthesis](universal-scalability-follow-up.md) for the later evidence, release
order and unresolved native gates.

## Initial disposition

| Finding family                                               | Intake decision                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M15, dense table map before admission                        | Current Document validation still calls the dense map before its work is bounded. Verify the exact current write path and add a structural preflight before allocation. Use small deterministic cases; do not derive a hardware capacity from the source probe. |
| O04, encoder and decoder size mismatch                       | Current legacy cursor encoder still delegates to a seal without the decoder's size bound. Align admission using the existing encoded-token limit, keep valid tokens and callers compatible, and distinguish codec behavior from a route-level incident.         |
| Q30–Q31, exact quantities and incomplete text                | Verify current native predicate and HTTP behavior with adversarial-but-small exactness cases. Pin coverage, proof and index migration semantics before a broader rewrite.                                                                                       |
| Q07, Q14 and R09, accumulated preparation and reconciliation | Work out durable rows, a bounded frontier, crash/replay and complete consumption. Checkout requires a separate money-safe staged proof; no decisions from partial provider evidence.                                                                            |
| M16, revision responses                                      | Determine metadata-first versus byte-budgeted body paging on the actual route; derive bytes and peak allocations rather than using item count as a response budget.                                                                                             |
| Q02–Q03 and R13, physical routing and hot authority          | Compare unchanged legacy IDs, search generation migration and real gate/transaction/fence throughput. Do not remove authority serialization based on shard counts.                                                                                              |

Treat other families as a queue for owner review. Adopt stable requirements in the appropriate architecture, product or
verification owner document and link back here for evidence. A passed portable probe does not close a native outcome.
