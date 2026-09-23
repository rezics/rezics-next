# End-to-end implementation workflows

## Work, main version and two Realm views

1. Main admits CreateWork under a domain/continuity profile and Access context.
   One product-dataset transaction creates Work, MainVersion, their relationship,
   initial policy, receipt and event. Metadata-only creation needs no body.
2. Contributors create independent language/content identities. Edits use expected
   heads, stable block IDs and verified payloads. Draft edits do not publish.
3. Realms A and B adopt different contributions/revisions. Each validates exact
   review, compatibility, rights/disclosure and its own expected selection. Both
   retain the common Main Version identity and contributor ownership.
4. Classification applications bind the same explicit target grain to Expressions.
   A accepts, B rejects; Global fallback cannot override B's local rejection.
5. Ratings bind each Realm's question/scale/population. Imported scores do not
   create native ballots. A Work-level rating is not silently a release rating.
6. Zone routes resolve resource plus typed context. Body, media, graph, search
   and counts all use the same accepted selection and current disclosure.

The journey requires contextual composition, not only successful independent CRUD.

## Edit, publish and exact comment

Create a revision anchor and receipt atomically with the component change. Resolve
its immutable manifest and exact payload through the stored anchor. A comment pins
that anchor and optional occurrence/block/selector, retaining its target after later edits. Publication
advances an eligible selection under CAS and emits an exact selection event.
Ordinary chapters follow context-eligible publication; fixed releases stay pinned.
Restore creates a new validated current transition from the retained component;
it does not rewind the TDB2 dataset.

If object upload succeeds but publication fails, keep it staged for retry or
bounded orphan cleanup. If publication commits but the response is lost, the same
receipt resolves the outcome. A report on old content retains exact evidence and
separately observes the current target; it cannot silently condemn another version.

## Source refresh without native overwrite

Capture source bytes, coverage and revision under the
[intake and complaint policy](../contracts/source-lifecycle.md#basis-for-acquisition-and-reuse).
Preserve available rights evidence and unknowns; recheck active material/use
restrictions so refresh cannot restore suppressed content. Parse to a source graph,
map fields/children, and compare source/base/native state. The plan binds mapping, binding,
target and human-control epochs. Same-value human confirmation advances control;
a staged refresh cannot overwrite or compensate it. Repeated children use exact
occurrence correspondence rather than target-ID or array-position equality.

Stage large updates, record conflicts, and recheck coverage, authority, epochs
and leases at activation. Commit adopted native state with receipt/outbox. Source
withdrawal removes only its support; independent native decisions survive. A
source redirect proposes identity correction rather than transferring rights.

## Search update and query

Accepted changes enqueue bounded affected-root work. Projections update coherent
text units/dependencies under a model/analyzer generation. Advance an unchanged
watermark only after proving the source change cannot affect the projection.
Joined author/selection/classification changes use bounded reverse impact.

Bind context and authority before entering the admitted ARQ SPARQL/text plan.
Eligible graph candidates and readable text participate before final ranking/count
completion. Index lag yields wait/pending/stale outcomes with deadlines. Readers
bind the active index generation to a complete bounded result; later pages use
a materialized handle or require restart after a relevant generation change. Current restrictions apply even to retained historical index snapshots.

## Cross-owner recovery

Each owner records its own receipt. Provisioning/admission/publication workflows
remain pending until their required owner steps complete. Restriction establishes
deny/fence before cleanup and follows declared admission/drain semantics. Failed
compensation cannot implicitly reopen content.

After restart, reconcile operation state with receipts/source heads before resuming
under a new lease. After backup restoration, apply authority/erasure frontiers
before reopening reads or external effects. Test both orderings of concurrent
events, using producer-returned IDs and actual owner/storage boundaries.
