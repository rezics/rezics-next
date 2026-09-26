# End-to-end implementation workflows

## Work, main version and two Realm views

1. Main admits CreateWork under a domain/continuity profile and Access context.
   One product-dataset transaction creates Work, MainVersion, their relationship,
   initial policy, receipt and event. Metadata-only creation needs no body.
2. Contributors create independent language/content identities. Edits use expected
   heads, stable block IDs and verified payloads. PostgreSQL commits body revision,
   draft head, receipt and outbox together. Ordinary body draft edits do not publish
   or rewrite the graph; semantic identity creation uses its own command. Prepare
   an exact retained revision before adoption.
3. Realms A and B adopt different contributions/revisions. Each validates exact
   review, compatibility, rights/disclosure and its own expected selection. Both
   retain the common Main Version identity and contributor ownership.
4. Statements bind the same explicit target grain to exact relation/interpretation
   definitions and selected semantic Context revisions. A accepts, B rejects;
   Global fallback cannot override B's local rejection or change the claim's
   meaning. Reusing a Context does not merge their decisions.
5. Ratings bind each Realm's question/scale/population. Imported scores do not
   create native ballots. A Work-level rating is not silently a release rating.
6. Zone routes resolve resource plus typed context. Body, media, graph, search
   and counts all use the same accepted selection and current disclosure.

The journey requires contextual composition, not only successful independent CRUD.

## Shared interpretation, personal speech and Realm adoption

1. Create one independently owned Context with sparse semantic entries and a
   separately versioned preference component; no Realm is required. Resolve
   ordinary specialist concepts through Global without allocating local copies.
2. Two Realms adopt its published semantic revision for an admitted scope under
   their own authority. An individual selects it privately through Access. A
   Context editor has no implicit right to perform these consumer selections.
3. Create or reuse a named concept such as `真後宮`, while retaining local
   interpretations of `後宮`. A member and a Realm can select different exact
   criteria for that original object. They retain personal versus institutional
   attribution; membership alone cannot authorize the Realm's voice.
4. Resolve explicit/speaker/entry/Global choices and pin actual DefinitionRefs,
   applicability and Context revisions in prepared intent and new Statements.
   Distinguish changed criteria, evidence disagreement and preference. Publication
   acceptance is a separate operation and preserves authored meaning.
5. Compare/search under explicit definitions and decision scopes. Same labels
   cannot merge criteria; shared definitions do not pool acceptance or voters.
   Language and ordering changes retain the semantic filter and exact citations.
6. Publish a new Context revision. Consumers and old Statements keep their pins
   until an authorized adoption transition. Exercise stale/concurrent writes,
   private dependencies, retirement, unavailable history and owner recovery.

This is the target [Context workflow](../contracts/context.md), pending owner
schemas and runtime qualification. It does not extend the installed v1 profile
by relabeling its Realm-bound acceptance identities.

## Edit, publish and exact comment

Create a revision anchor and receipt atomically with the component change. Resolve
its immutable manifest and exact payload through the stored anchor. A comment pins
that anchor and optional occurrence/block/selector, retaining its target after later edits. Publication
advances an eligible selection under CAS and emits an exact selection event.
The first Content paragraph-comment profile stores one immutable
[Web Annotation SpecificResource and TextQuoteSelector](https://www.w3.org/TR/annotation-model/):
the source is the exact Content revision, and the quote must equal one unique
whole paragraph in that revision. This keeps the selector unambiguous without
using offsets that can be reinterpreted after an edit. The Content owner records
the comment, receipt and outbox position together. A read verifies the retained
revision bytes and selector, then applies current Work disclosure; an erased or
unavailable source cannot resolve as current text. Block and occurrence selectors
remain for later profiles.
Ordinary chapters follow context-eligible publication; fixed releases stay pinned.
Restore creates a new validated current transition from the retained component;
it does not rewind the TDB2 dataset.

If Content storage or object preparation succeeds but publication fails, keep the
saved revision and reconcile its preparation pin against the terminal graph
outcome before cleanup. If publication commits but the response is lost, the same
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

Committed Content and semantic events enqueue bounded affected-root work. Fetch
exact PostgreSQL revisions in bounded batches, extract outside the graph writer,
and submit guarded RDF MatchUnit updates through the text wrapper. Projections update coherent
text units/dependencies under a model/analyzer generation. Advance an unchanged
watermark only after proving the source change cannot affect the projection.
Joined author/selection/classification changes use bounded reverse impact.

Bind context and authority before entering the admitted ARQ SPARQL/text plan.
Eligible graph candidates and readable text participate before final ranking/count
completion. Index lag yields wait/pending/stale outcomes with deadlines. Readers
bind the active index generation to a complete bounded result; later pages use
a materialized handle or require restart after a relevant generation change. Current restrictions apply even to retained historical index snapshots.
Retrieve requested exact bodies afterward with one fixed-size PostgreSQL batch;
do not hydrate or validate candidates one at a time. A stale response needs a
supported coherent older view, not mixed old text and current selection.

## Cross-owner recovery

Each owner records its own receipt. Provisioning/admission/publication workflows
remain pending until their required owner steps complete. Restriction establishes
deny/fence before cleanup and follows declared admission/drain semantics. Failed
compensation cannot implicitly reopen content.

After restart, reconcile operation state with receipts/source heads before resuming
under a new lease. After backup restoration, apply authority/erasure frontiers
before reopening reads or external effects. Test both orderings of concurrent
events, using producer-returned IDs and actual owner/storage boundaries.
