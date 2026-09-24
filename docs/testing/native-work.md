# Work and Main Version acceptance

These are prospective tests, not executed results. Run at the applicable
[verification phase](../plan/execution-workflow.md), preserving actual owner
boundaries, source snapshots and positive/denied/partial outcomes.

| ID | Scenario | Required result |
| --- | --- | --- |
| WORK01 | Create metadata-only Work | Main Version entry exists without dummy body/release. |
| WORK02 | Add two same-language native variants, and separately published official/third-party translated Works | Native variants retain one version spine; separate publications retain Work/version identities and translation links. Record version-scoped provenance without recursive body copies. Personal choice works without a Realm override. |
| WORK03 | Switch adopted content in one Realm | Other selections and contributor control unchanged. |
| WORK04 | Create adaptation/recording/software fork | Continuity decision preserves explicit derivation. |
| WORK05 | Seal release then correct metadata | Pinned content stays exact. |
| WORK06 | Rate Main Version and exact release | Targets/populations are not silently pooled. |
| WORK07 | Use package Main Version as install request | Resolve to concrete eligible release/artifact before lock. |
| WORK08 | Import equal provider names/IDs at different grains | No automatic identity merge or fabricated parents. |
| WORK09 | Save competing PostgreSQL Content edits and retry after a lost response | One expected-head winner; revision/retained bytes/receipt/outbox agree in one SQL transaction. Draft saves do not require a graph mutation. Exact history and byte digests remain stable through both owner adapters. |
| WORK10 | Prepare Content, activate graph publication, then interrupt outcome delivery or run GC | An exact pinned revision survives ambiguous publication; duplicate reconciliation is idempotent. Rejected publication preserves the saved revision; pins release only after terminal proof. Erasure fences stale activation. |

Record inputs, operation receipts, exact profiles/builds and failures. A mock-only
pass cannot qualify storage, cross-service behavior or capacity.

WORK02 cases include English book A, official Chinese publication B and independent
third-party Chinese publication C, linked to A and exact source versions where
known. B/C bodies are not duplicated inside A. Separately exercise a native
multilingual Main Version with two Chinese variants, a personal preference and
an optional Realm recommendation. Verify that preference cannot override
disclosure or substantive rejection; metadata localization cannot change content
language; and a newer release does not silently inherit translation coverage or
official authorization. Source-version uncertainty stays explicit.
