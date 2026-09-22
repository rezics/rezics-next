# Model and reference acceptance

These are prospective tests, not executed results. Run at the applicable
[verification phase](../plan/execution-workflow.md), preserving actual owner
boundaries, source snapshots and positive/denied/partial outcomes.

| ID | Scenario | Required result |
| --- | --- | --- |
| MODEL01 | Create multiple semantic types on one Resource | Stable identity; capability admission remains independent. |
| MODEL02 | Round-trip zero/false/empty/absent/unknown/no-value | No conflation in storage/query/API/export. |
| MODEL03 | Use huge integer/exact fractional quantity | No loss through JSON numeric conversion. |
| MODEL04 | Store temporal offset/precision/calendar and language direction | Original meaning survives engine normalization. |
| MODEL05 | Repeat same participants in two associations | Role predicates bind one identified occurrence. |
| MODEL06 | Retire/change a semantic definition | Old exact interpretation remains resolvable. |
| MODEL07 | Move physical placement | Native identity and retained revision references remain valid. |
| MODEL08 | Classify a resource as privileged/executable | No permission/capability is granted. |
| MODEL09 | Ingest source reification without adoption | No alleged base edge becomes accepted native truth. |
| MODEL10 | Use missing private/external reference | Typed unavailable state without identity fabrication or disclosure. |
| MODEL11 | Anchor resolver crashes after the source transaction commits | Rebuild from committed operation evidence or return pending; never guess HEAD. |
| MODEL12 | Garbage collection or relocation sees a retained exact anchor | Preserve its required history/payload or complete the explicit retirement contract first. |

Record inputs, operation receipts, exact profiles/builds and failures. A mock-only
pass cannot qualify storage, cross-service behavior or capacity.
