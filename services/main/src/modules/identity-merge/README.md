# Identity merge reconciliation kernel

This owner contains the bounded reconciliation kernel and Access task/item
journal for G-836. **The public `merge` editorial adapter is not installed.**
Native owner commands, current human review admission and identity reservation
must be bound before any public merge can execute. These primitives alone do
not qualify the SAO API journey or the complete catalogue reference inventory.

`contract.ts` admits an evidenced, exact source/survivor pair and a compensating
unmerge naming a completed original task. Split, self-merge, different grains,
Account-controlled Agents, stale heads and cyclic/chained identity corrections
are refused by the checked plan/preflight. Multilingual headers retain individual
language values. Owner counts distinguish an exact count from a lower bound.

`runMergeTask` processes at most 32 items per run. Each owner's indexed page is
retained in Access before delivery. The owner must commit the effect and its
native receipt together, resolve that receipt before checking a stale head on
retry, and use the supplied command key. Access records the exact owner outcome
after delivery. A killed process can resume either gap with a new runtime/journal.
Completion requires every owner inventory to be exhausted and every retained
item to have an outcome. Final identity projection has its own replayable receipt.

Unmerge pages only the original `moved` and `history` outcomes. Each retained
compensation item references immutable original snapshots and receipt digests;
it does not duplicate their payloads or rediscover survivor contents. Owners
compare their exact post-merge head in the compensation transaction and retain
later edits as `ambiguous` without overwriting them. Ambiguity rows are retained
under an indexed Access key for a future authorized status/read binding.

The runtime must reserve both identity heads and fence new source references
while processing. It must enforce G-865's current two independent human
approvals through Access; the kernel supplies no approval implementation.
Native owner commands must independently validate this authority when committing
their effects. A session advisory lock serializes one task while short SQL
transactions save checkpoints; no SQL transaction remains open across owner
network calls. Handler versions and the data epoch are pinned across retries.

These choices follow the existing owner receipt pattern and
[PostgreSQL advisory lock semantics](https://www.postgresql.org/docs/current/explicit-locking.html#ADVISORY-LOCKS).
[Compensating transactions](https://learn.microsoft.com/en-us/azure/architecture/patterns/compensating-transaction)
explain why later work needs an owner-specific inverse and idempotent retry,
instead of restoring an old database image. Neither source qualifies this
implementation's native planner costs or production concurrency.

Handlers are discovered as `modules/<owner>/merge-handler.ts`, exporting
`mergeHandlerModule`. Each declares exact table-column/graph-predicate coverage,
a version and per-page/item cost. `reference-discovery.ts` conservatively finds
SQL native-reference candidates (including empty JSON columns) and current graph
predicates. `assertMergeCoverage` refuses missing owners and empty, overlapping
exclusions. The offline graph scan qualifies only its tested corpus. A complete
production coverage manifest remains necessary; no wildcard exclusion is supplied.

Remaining owner bindings:

- Library and rating: survivor value wins each person's conflict; the other
  value remains history. Rating graph slots/manifests and Access completeness
  witnesses must agree, preserving one Account-principal vote.
- Session/progress and owned copies: preserve independent attempts and copies
  and their exact historical target/locator semantics. The session identity
  trigger currently forbids changing `state.target` and `work`. Current session
  indices begin with the private principal, so source-wide merge inventory also
  needs a Content migration for an indexed incidence path. This brief reserves
  Access 970–971 only; no Content migration number is assigned.
- Realization: add an identity correction command. `assertRealizationCorrection`
  forbids changing Work, and its retained source continuity requires a deliberate
  correction instead of an incoming `rv:work` rewrite.
- Composition and Collection: use selected-generation structure commands and
  retain occurrence identities, order and qualifiers.
- Statement/relation: a changed Statement meaning requires a replacement
  Statement and new meaning/decision keys, preserving speakers, supports and
  alternatives. Relation participation remains owner-validated; creator rights
  and authority bindings never move.
- Review/follows: reconcile person slots and maintain revision history, counts,
  collection/discovery fences and later-edit ambiguity.
- Editorial runtime: install the discovered `merge` adapter and its shared
  conformance fixture after the owners above exist. Current recovery is
  receipt-only and cannot redispatch an unfinished multi-owner task; add an
  authorized task-resume binding without turning a public read into delivery.
- Identity/read owners: commit/remove `mergedInto` with a native receipt and
  retain source IDs, slugs and exact revisions; wire the exported bounded
  resolver into G-506's hook and the ID/slug/exact read envelopes. The exported
  resolver alone does not wire those consumers.

`services/main/tests/g-836-merge.test.ts` exercises the kernel with deterministic
owner ports. `tests/qa/integration/g-836-journal.test.ts` exercises the actual
Access migrations and transaction/receipt recovery with a disposable probe
owner. It does not substitute for the public catalogue owner acceptance test.
