# Model and reference acceptance

This table is the completion contract. The QA acceptance artifact records which
parts have actually run. The model tier currently maps the 66-case native profile
matrix to MODEL17 and MODEL27 as partial coverage; the remaining scenarios still
need their own evidence. Run each at the applicable
[verification phase](../plan/execution-workflow.md), preserving actual owner
boundaries, source snapshots and positive/denied/partial outcomes.

The bounded Work profile is partial evidence for MODEL01 and MODEL08. Selected
real-owner integration `20260925t200223-bfeed7` exercised canonical multi-type
creation and replay, unsupported type rejection, exact revision reads, an Access
denial, and an authorized title edit that retained the types. Graph-loss recovery
`20260925t200335-f56474` rebuilt the retained Work type triples. These passes do
not qualify arbitrary Resource types or the general semantic-change operation;
neither ID has a complete-case declaration.

The [author-credit integration](../../tests/qa/integration/source-author-credit.test.ts)
passed selected run `20260926t074730-1831a8`: two repeated external author keys
produce two native credit/revision identities; source reorder/support and a native
Work title edit preserve the original exact credit. Native validation rejects
missing shapes/bindings, an Agent edge, mismatched keys, an out-of-range position
and attempts to overwrite either native subject. The command regression selection
passed model run `20260926t074739-acebf1`. Isolated held-graph recovery passed
`20260926t074730-20dab9`, requiring retained Source intent/conversion, sealed Access
admission and exact relay event before rebuilding the original revision. This is
partial MODEL05/MODEL06 evidence for one append-only relation and its pinned exact
history; semantic-definition retirement, editable credit history, arbitrary
participants and the general relation-change operation remain unqualified.

The bounded [Work scalar profile](../contracts/semantic-model.md#bounded-work-scalar-state-profile)
provides a MODEL02 case for one `rv:scalarValue` on a metadata Work. Selected
real Account/Access/Main/Jena integration `20260926t131838-6836e6` passed all
six states through writes, current and exact old-revision reads, RDF queries
and expanded JSON-LD export. It also passed denied and stale requests, same-key
replay, changed-intent conflict, title preservation and missing/corrupt exact
object handling. The initial one-state template passed
`20260926t130425-0fa17d`. Isolated held-graph replay
`20260926t131053-03fb93` rebuilt all six scalar states and a title edit from
sealed Access admissions, relay events and immutable objects; a changed Access
digest blocked recovery. These selected artifacts reported source stable and used the
local `rezics/fuseki:6.2.0-cmd0.5.29-scalar1` image, config ID
`sha256:7f20578694a47d3af2ee6fda6ceac3f2c162d7b6a3d85f88ff6741944e8c485a`.
The six reviewed Work shape candidates, including an IRI scalar, blank-node
rejection and multiple-value rejection, passed native command validation in
`20260926t131755-6d0a7c`; the prior shape evidence remains archived.
The current read uses one bounded Work graph lookup (`LIMIT 2`) and one exact
revision lookup; exact history uses the immutable revision anchor and objects.
These are path bounds, not a load or latency measurement. The profile does not
qualify arbitrary values/properties, the general semantic-change API, MODEL03
or MODEL04. The manager-owned QA case map and merged qualification remain
separate from these selected runs.

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

[Editorial-protection subcases](editorial-protection.md) refine the affected
MODEL requirements with additive revision mutation, predicate/link deletion
bypasses, content/protection races, explicit absence and exact approval bases.
Those cases require real command-module enforcement; existing SHACL conformance
or Work head tests do not qualify the general protection profile.

Record inputs, operation receipts, exact profiles/builds and failures. A mock-only
pass cannot qualify storage, cross-service behavior or capacity.
