# Creation and reading acceptance

These are prospective tests, not executed results. Run at the applicable
[verification phase](../plan/execution-workflow.md), preserving actual owner
boundaries, source snapshots and positive/denied/partial outcomes.

| ID | Scenario | Required result |
| --- | --- | --- |
| BOOK01 | Create/edit/publish/read a native book without sources | Complete ordinary journey through Main Version. |
| BOOK02 | Reuse one Post as two chapter occurrences | Distinct progress/position, shared content identity. |
| BOOK03 | Publish new chapter revision | Ordinary context follows publication; fixed release stays pinned. |
| BOOK04 | Comment on old paragraph then edit/remove it | Original revision/selector remains exact. |
| BOOK05 | Edit from two concurrent heads | Conflict/explicit merge; no lost update. |
| BOOK06 | Publish private transitive embed | Reject or explicitly authorize before activation. |
| BOOK07 | Import/refresh after local edits | Three-way correspondence preserves or reports conflict. |
| BOOK08 | Restore old composition | New state; no recursive overwrite of referenced content. |
| BOOK09 | Use image-only or poll-only publication | No fabricated text document. |
| BOOK10 | Offline edit reconnects after remote edit/revocation | Preserve input and exact command identity; current authority/CAS controls replay. |

Record inputs, operation receipts, exact profiles/builds and failures. A mock-only
pass cannot qualify storage, cross-service behavior or capacity.
