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
| MODEL11 | Anchor resolver crashes after the source transaction commits | Rebuild locator from retained anchor metadata and immutable objects; missing committed payload is unavailable, never guessed HEAD. |
| MODEL12 | Garbage collection or relocation sees a retained exact anchor | Preserve its required history/payload or complete the explicit retirement contract first. |
| MODEL13 | Use a standard Annotation/Label/ListItem with admitted local fields | Profile preserves target/lexical/occurrence meaning without requiring a duplicate local class. |
| MODEL14 | Add an unrelated admitted semantic type/property | Open resource shapes preserve multi-type data; closed component shapes apply only to their owned projection. |
| MODEL15 | Remove type/profile/target predicate during an invalid edit | Owning command still selects its required validation; no vacuous pass bypasses lifecycle rules. |
| MODEL16 | Edit a referenced child's state/type without editing its parent | Validate the complete affected dependency footprint or reject/stage the transition; no invalid parent is silently retained. |
| MODEL17 | Supply unsupported shape terms, no shapes, or no expected focus | Activation fails with explicit unsupported/coverage outcome, even if a generic validator reports conformance. |
| MODEL18 | Two new states each pass SHACL but race the same expected head | Only one admitted mutation commits with its own receipt; no losing success event. |
| MODEL19 | OWL functional/key inference encounters distinct native IDs | No automatic native merge or authority pooling; reject inappropriate identity axioms in the selected reasoning profile. |
| MODEL20 | Source/Realm union or partial rule closure appears to yield an answer | No unqualified accepted fact, silent fallback, exact count or authorization is derived. |
| MODEL21 | Bulk import or validation-mode override attempts to reach native state | Owner-controlled staging/activation and fixed reject posture preserve the active profile. |
| MODEL22 | Model/rule generation changes during a prepared command | Commit guards reject or revalidate the command; old exact interpretations remain resolvable. |
| MODEL23 | Prepare candidate, then insert a previously absent dependent/slot | Complete dependency/absence guards reject stale validation; no phantom admission. |
| MODEL24 | Configure a Fuseki SHACL report endpoint, then attempt raw native writes | Product ingress blocks the bypass; endpoint availability is never treated as automatic update validation. |
| MODEL25 | Edit current state and compact TDB2, then resolve an old revision | Immutable manifest/payload still reproduces exact state; no internal MVCC generation is required. |
| MODEL26 | Missing/corrupt revision object or mutable context dependency | Typed unavailable/corrupt outcome and recovery; never current-head substitution or guessed lexical values. |
| MODEL27 | Main helper times out, sees no expected focus, or validates only part of the candidate | No activation receipt; report completion and required coverage are enforced. |

The [profile implementation](../implementation/model-profile-validation.md) links
bounded historical probes separately; they do not qualify Jena or this full
acceptance matrix.

Record inputs, operation receipts, exact profiles/builds and failures. A mock-only
pass cannot qualify storage, cross-service behavior or capacity.
