# Knowledge workspaces: identity, disclosure and bounded composition

Independent architecture investigation, 11 November 2026. Inspected baseline: `6d33d64618ffdbf7f9067a73e9dd2ea8a989852f`. This report proposes a design; it is not an adopted contract or native performance acceptance. No other new knowledge-workspace investigation was read. Conclusions below stand on linked native sources and explicit counterexamples.

## Recommendation

Make authored knowledge documents independently owned resources that can refer to public Subjects. Compose a Subject's public knowledge with the current reader's authorized working documents. Preserve separate identities for the Subject, document, immutable document revision, and ordered placement. A private character arc is about a shared Character; it is neither a private copy of that Character nor a new canonical fact about it.

Deliver this composition, exact references, private nested documents, deliberate publication and readable reusable explanations in the launch slice. Support bounded document snapshots with optimistic concurrency first. Add custom structured databases, formulas, live transclusion, real-time collaboration and formal mathematics in later slices, without changing the identity or disclosure model. Ordinary rich text and source-preserving mathematical notation are compatible with the foundation; a proof checker is a separate capability.

Inclusion means preserving observable creation, editing, publication, revocation, reference and deletion behavior with plausible execution costs; merely encoding state in a graph proves little.

## Evidence from the present repository

| Source | Established boundary |
| --- | --- |
| [Architecture](../architecture.md) | Single-partition commands, route-first exact reads and bounded/resumable work; no general cross-home join |
| [Document](../../packages/document/README.md), [types](../../packages/document/src/types.ts) | Versioned ProseMirror snapshots and document-local block IDs; no independently owned live blocks or collaboration protocol |
| [Content validation](../../services/kernel/src/content/document.ts), [revision SQL](../../services/kernel/src/content/create-revision.sql) | Whole canonical revision bytes, current 2 MiB ceiling, hash/licence/search projection; small edits need not have small persistence cost |
| [Authored fields](../../services/kernel/src/content/README.md#authored-field-documents), [document route](../../services/kernel/src/content/document-routes.ts) | Subject/candidate-associated content with `subject:read`; not a standalone private-note authorization contract |
| [Fixed editions](../../services/kernel/src/content/README.md#fixed-authored-paid-editions) | Exact post-revision publication; no generic multi-document workspace |
| [Term extensions](../../packages/definitions/README.md#term-extensions) | Namespaced immutable relation terms, up to 64 including deprecated terms; not arbitrary scalar/database fields |
| [Semantic identity](../../services/kernel/src/semantic/README.md#canonical-identity-boundary) | Permanent Subjects and canonical mappings; no identity equivalence between note and topic |
| [Access pages](../../services/kernel/src/access/README.md#resource-pages) | Current checks for 1–100 same-route resources; no arbitrary document-tree permission inheritance |
| [Private drafts](../../services/kernel/src/content/README.md#private-acknowledged-drafts) | Owner-local return/discovery path; resources remain native posts/reviews |

Source-backed findings only; no API, browser or native growth suite was run.

## User outcomes that define the model

A writer opens a public Character, creates private “Inspiration,” “Arc,” “Dialogue,” and “Alternate ending” subdocuments in a project, and shares selected documents with collaborators. Anonymous visitors see no private title, count, activity or backlink. Publishing one analysis revision leaves its parent, siblings and future edits private. A second writer can reuse the same Character and analysis without copying identity. An unreleased original Character can begin as a private project document; public catalogue creation/association is a separate explicit action.

A learner opens a problem, follows a solution step to a stated theorem formulation and then to its definitions, while retaining private confusion notes alongside public explanations. Two solutions may use different theorems: the “uses” assertion belongs to one solution/step revision, not an inferred universal prerequisite list for the problem. Curated learning prerequisites, proof dependencies and machine-checked evidence are distinct. Bounded preview, on-demand expansion and return-to-step navigation are more useful than rendering the whole mathematics graph.

## Candidate models

| Candidate | Consequence | Decision |
| --- | --- | --- |
| Every note/block/placement is a catalogue Subject | Couples working state to identity merging, editorial selection and publication; paragraph edits become semantic commands | Reject as universal representation |
| Entire workspace in one JSON blob | Small edits touch all bytes; audiences cannot share one downloadable private/public blob | Use bounded snapshots per document instead |
| Separate knowledge graph, access system and editor format | Duplicates authorities and creates permanent translation work | Reject |
| Content-owned documents and structure over existing identity, Access and Document | Requires new lifecycle/reference operations but preserves useful shared authority and bounded units | Prefer |

“One graph” means composable identities and typed relationships, not one table or one invariant for every edge. A document may itself be catalogued as an authored work; that never makes it identical to its topic.

## Proposed objects and invariants

Reuse existing compatible resource owners for these conceptual objects.

| Object | Authority and invariant |
| --- | --- |
| Subject | Existing Semantic identity; reusable outside every workspace and independent of private attachments |
| Knowledge document | Content ID, owner, title, working head, audience and lifecycle; rename/move/edit preserve identity |
| Revision | Immutable snapshot ID/hash, language, licence and authorship; exact addressing never bypasses current erasure/withdrawal |
| Placement | Stable occurrence in an owned structure, one parent, sibling order, target; repeated targets remain separate occurrences |
| Workspace/structure | Account- or Realm-owned navigation aggregate; not a new principal or permission system |
| Subject association | Document-owned typed link; private discovery stays under owner/workspace authority |
| Reference | Source revision/block and typed target with live/exact selection; conveys neither access nor copying |
| Publication | Explicit selected revision and metadata; working head remains distinct from public selection |

Reference addresses discriminate Subject, document and exact revision. Exact block citations pin the document revision and local block ID. A live block removed or split can become unavailable; no silent retargeting by similar heading. Two analyses of one Character remain separate documents. One analysis about two Characters stays one document. Copy creates new document/block identities with provenance; another placement only reuses the target.

## Permission and publication design

The Subject reading is `public subject + public publications + my authorized attachments`. All may compose in one bounded response; separate URLs or services are not required. Authenticated composition needs a private cache identity. A private component failure must not substitute another user's results or remove independently available public content.

Use existing Access for every resource. Prefer explicit document audiences and bounded account/Realm grants at launch. A new child is private unless an explicit team-creation action selected its audience. Moving a placement does not change audience. Arbitrary ancestor-derived permissions would add revocation/movement complexity and are deferred. Public/private mixing happens between separately authorized documents; hidden paragraphs in downloadable JSON are not private. Link a private subdocument when only part of a work should be private.

Disclosure covers titles, previews, breadcrumbs, counts, thumbnails, snippets, export, notifications and selectors. A readable document need not expose its private ancestors. An explicitly authored visible link may show a neutral unavailable destination; automatically discovered private attachments leave no placeholder. If two states differ only in never-disclosed private resources, public response contents, membership, counts and pagination semantics should be equivalent. This is not a constant-network-timing promise.

Private attachment directories belong under owner/workspace anchors. Never insert private rows in global backlink candidate lists and rely on final filtering: work and cursors could disclose private activity. Explicit publication creates public-discovery inputs through existing Content/Search owners. Projection maintenance is asynchronous and idempotent; candidates receive a current publication/lifecycle check before metadata disclosure. A delayed inverse removal may cause absence or preparation, never delivery from a withdrawn source.

A capped candidate sample with many withdrawn rows cannot prove an exact count or exhaustive empty result. Omit exact totals at launch. If the common filtered-list contract requires useful complete pages, use its retained preparation; do not invent conflicting sparse-success semantics. Exact negatives, global ordering and complete counts need a complete privacy-safe observation. This is a cross-owner acceptance dependency. Previously public information cannot be retracted from recipients' downloads, but withdrawal must stop future platform delivery.

Publish a concrete revision and bounded dependency list, showing its public title, body, licence, media and reference behavior. The operation never recursively publishes all reachable documents. Later draft changes remain private. Live embeds, when added, resolve current viewer authority rather than copying private source bytes into a public body. An independently published quotation is explicit licensed content with provenance; it is not a source-controlled live reference.

Enroll the new resources in existing moderation, trash/restore, account erasure, media and index-retirement owners. A knowledge publication does not become a paid Content Edition unless it actually uses that separate contract.

## Structural and mathematical correctness

### Tree ownership and concurrent moves

Structure vertices are placement IDs, never canonical Subject representatives. Define a finite maximum structural depth D. A move checks the destination ancestor chain and the moving occurrence in one structure's native partition under a structure mutation fence; concurrent opposite moves cannot both pass an obsolete check. Ordinary document-body edits do not acquire that structure fence.

This gives O(D) examined structural keys independent of total workspace size. Do not validate a move by scanning every descendant. Store subtree-derived metadata asynchronously or avoid promising it. Same-workspace movement is the first operation; a cross-workspace action creates a placement reference or performs an explicit resumable copy, and does not pretend to atomically move ownership between partitions.

Sibling order is an indexed ordered sequence. Repeated insertion must not trigger a synchronous rewrite of all siblings. Adopt an existing bounded ordering mechanism or a paged sequence with localized splits; if keys need rebalance, make it resumable and specify reads during rebalance. “Fractional order key” alone does not prove finite key size or bounded maintenance.

Concurrent offline tree moves require more than a text CRDT. Published research demonstrates special algorithms and correctness proofs for cycle-free replicated moves. Defer offline structure mutation until that behavior is deliberately selected. [Replicated-tree research](https://martin.kleppmann.com/2021/10/07/crdt-tree-move-operation.html)

### Semantic relations are not all DAGs

Ordinary reference and comparison graphs can be cyclic. A learning route can be a chosen acyclic traversal through a cyclic knowledge graph. Proof dependencies, navigational containment and editorial taxonomies have different validity conditions. No global `acyclic` bit should be treated as proving all their composites valid.

For example, an acyclic `A → B → C` graph becomes cyclic when an identity mapping equates A and C. Likewise, two individually valid Context graphs can form a cycle when overlaid. A private document's tree therefore cannot be computed by quotienting its topic Subjects. Hard DAG constraints need a selected scope, relation family, identity grain and concurrency boundary. The [native relation contract](../../services/kernel/src/semantic/README.md#relation-properties) declares acyclicity; declarations alone do not prove enforcement across these operations.

### What mathematical knowledge means

Model a definition, proposition/theorem, problem, proof/solution and explanation as distinct semantic roles. A named theorem can have several formulations or explanations; hypotheses and mathematical domain belong to the selected formulation. “Same title,” “same printed equation,” “same examples” and “same theorem” are not interchangeable identity tests. Keep relation vocabulary explicit: `explains`, `uses`, `exampleOf`, `counterexampleTo`, `variantOf` and curated `learningPrerequisite` have different meanings. Avoid a universal `dependsOn` that implies all of them.

A solution's statement that a step uses a theorem is an authored assertion with a source location and selected target version. It does not prove that the theorem applies, that every assumption holds, or that the solution is correct. Machine-checked status later binds an exact formal artifact, tool/version/environment, assumptions and proof result. Lean's propositions-as-types treatment demonstrates why a checked proof is more specific than a graph of citations. [Lean documentation](https://lean-lang.org/theorem_proving_in_lean4/Propositions-and-Proofs/)

A prerequisite map is a navigation aid, not an automatically generated universal syllabus. Depth, returned nodes and edge count are bounded; repeated nodes are deduplicated by the relevant resource identity; cycles appear as already-visited links. Unknown and unavailable prerequisites remain unknown. Do not mark an explanation complete after truncating its dependencies.

SKOS is useful for concept classification and named schemes, but does not itself establish theorem entailment or a proof calculus. Its immediate hierarchical relation and transitive closure are distinct. [SKOS Reference](https://www.w3.org/TR/skos-reference/)

## Physical model and operation costs

Use a structure's native route for its placement mutations. Content document heads, revisions, author grants, current publication state and directly owned association metadata should commit within one document home. A document may reside at a different home from its navigation structure. Reads batch full target keys according to the architecture; no cross-partition SQL join or distributed atomic editing is presumed.

The tradeoff is intentional: a placement can temporarily point to an unavailable document, and deleting a document does not synchronously rewrite every workspace that references it. Such pointers resolve through current lifecycle. Strong uniqueness or foreign-key invariants across homes require an explicit existing owner protocol, not an imaginary global transaction.

Let P be a page limit, D the structural depth cap, B the per-document byte cap, R the maximum external references examined in one document operation, H the bounded number of distinct target homes, A the existing per-resource authorization cost, and N the anchored population size. Owners should adopt concrete maxima once and reuse them. Current B is 2 MiB for the existing Content snapshot validator. This report introduces no new runtime funding or pricing protocol.

| Operation | Indexed anchors and examined work | Invalidation/lifecycle cost |
| --- | --- | --- |
| Open a document | One exact head, one exact selected revision, current Access/lifecycle; O(B + A) bytes/work plus indexed seeks | No hierarchy scan; private ancestors not needed for explicit-grant authorization |
| Save a document snapshot | One document home, CAS head revision, body validation/hash/projection O(B), bounded R reference/media checks | Append revision and native events; no synchronous dependent-document rewrites |
| List children | `(structure, parent, order, occurrence)` seek, at most P placements plus lookahead; at most P bounded summaries | O(log N + P) structural rows; target hydration/Access adds at most P × A and bounded H seeks |
| Move placement | One structure fence, at most D ancestor keys, fixed source/destination sequence edits | O(D) plus bounded ordering maintenance; no descendant rewrite |
| Show my documents about a Subject | `(owner/workspace, originalSubject, order, id)` seek, P rows; authorized current mapping lookup | Mapping must not scan all originals in a canonical class. Launch may expose exact-original association plus a separately admitted canonical projection |
| Resolve references | At most R deduplicated exact keys, batched by home and row kind; explicit read byte ceiling | Every live target checks current access; exact revision still checks withdrawal/erasure |
| Publish or withdraw | One exact document state; selected revision and at most R owned dependencies/association metadata | Bounded native commit; outgoing projection jobs paginate inverse fanout; no recursive target publication |
| List public related publications | Subject-anchored public-only candidate index, finite candidate window and fresh publication checks | No never-public private rows; useful complete pages/negative queries require the shared prepared observation mechanism |
| Delete a document | Tombstone one document resource immediately; cleanup via owned cursor | Total cleanup proportional to retained revisions/media/index rows; each step bounded. Foreign references are not synchronously rewritten |
| Delete structure subtree | Tombstone the selected placement subtree root, bounded ancestor check on descendant navigation; resumable occurrence cleanup | Removing navigation does not erase separately owned target content; batch document erasure is a different explicit operation |

A target-byte sum is required for reference previews. R references times B bytes can be a very large response even when R is capped. Use metadata-only references or a smaller total preview-byte allowance; expanding one referenced explanation is an explicit subsequent visit.

### Where constant-cost promises fail

An unmaintained exact aggregate over m arbitrary related values must inspect those values. Materialization shifts work to updates and repair. Eagerly updating f dependent results costs at least proportional to f writes; a background worker makes steps bounded, not total work constant. Sorting a whole database by a new arbitrary computed expression requires either a valid maintained order or preparation. Returning 50 rows does not bound the work used to find them.

Exact results over freshly revoked cross-home permissions are also not produced by a stale search index plus a small positive sample. The system must choose compatible population placement, a complete current observation, or explicit preparing/unavailable behavior. Positive target checks do not prove that an undisclosed row could not alter a negative predicate, aggregate or global rank.

Notion's own guidance lists row count, visible property count and formula/rollup chains as performance factors. Its current limits are evidence that a general document/database product still imposes bounds; they are not a performance target for REZICS. [Notion performance guidance](https://www.notion.com/help/optimize-database-load-times-and-performance)

## Editing, local schemas and later extensibility

Launch can use snapshots, stable block IDs, immutable revisions and optimistic concurrency. Stale saves preserve drafts and offer reconciliation. Debounce autosave; do not persist a full revision per keystroke. This is not real-time coediting.

Later evaluate a mature engine against the current document format. Yjs provides shared types, distributed updates and ProseMirror/Tiptap bindings, but not REZICS permissions, publication, schema validation or structural invariants. Revoked clients' old updates remain unauthorized even if mergeable. [Yjs documentation](https://docs.yjs.dev/)

A local database needs stable field IDs, immutable schema versions, typed values and admitted indexes. Renaming preserves identity; type changes require migration or a new field. A record is independent of its optional Subject link. Private `arcStage` is workspace state, not a public selected Character fact. Reuse Definitions vocabulary and typed/query contracts where meanings match; do not stretch relation-only Context extensions into scalar schemas or duplicate the global catalogue. A database population is distinct from a Collection view.

Formulas need a typed closed language, defined null/unknown/error behavior, dependency bounds and materialization. Start with row-local pure expressions; admit relational aggregates separately. No unrestricted server-side user JavaScript. Cycle rules apply to the selected computation graph, not ordinary links.

Preserve inline/display mathematical source and fallback. A versioned Document extension can precede a dedicated compatible node/profile. KaTeX exposes macro-expansion, output-size and trusted-command controls; adopt explicit source bounds and safe settings. Renderer output is presentation, not canonical mathematical meaning. [KaTeX guidance](https://katex.org/docs/security.html)

## Priority and migration plan

| Stage | Required outcome |
| --- | --- |
| Launch foundation | Independently owned private documents; named subdocuments; stable placements; exact Subject/document references; history, save conflict recovery and lifecycle |
| Launch defining feature | Public Subject plus authorized private attachments; explicit revision publication/withdrawal; public-only discovery inputs and no recursive publication |
| Launch learning example | Problem/solution/explanation; source-preserving notation; exact step-to-definition/theorem references; bounded expansion and return navigation |
| Next structured-workspace release | Local typed fields, database sources and selected views, broader team-sharing workflows, stable-reference export/import |
| Next collaboration/reuse release | Measured incremental persistence, real-time editing, live transclusion, collaborative moves and schema/index migrations |
| Later computation/education release | Typed formulas, admitted rollups, learning routes, proof-assistant artifacts, advanced formula authoring, offline synchronization |

Public/private composition is the defining value and cannot be deferred behind a generic private notebook. Launch does not promise a complete mathematics corpus or formal verification. Include selected-document export with a reference manifest if ownership portability is a launch promise. A Notion importer and arbitrary subtree/offline sync can wait; flattening into text is not lossless import.

## Acceptance that can falsify the proposal

1. Add a thousand private documents to a public Character. Anonymous/other-account Subject responses, search, backlinks, counts and notifications remain unchanged, including with repair paused.
2. Publish one selected revision beside a private alternate ending. Public navigation/export/media reveal neither sibling nor private ancestors. Later draft edits stay unpublished.
3. Withdraw with public indexing paused. Point/revision/preview/media reads check current state. No withdrawn bytes appear; sparse/preparing behavior follows the shared list contract.
4. Delete one of two placements: target and other placement survive. Delete a workspace: external documents survive. Restore cannot restore revoked grants or erased content.
5. Concurrently move A below B and B below A: no committed cycle. Topic identity merging cannot mutate the placement tree.
6. Two problem solutions cite different exact theorem formulations. An updated explanation does not silently change an exact citation. A citation graph alone never yields machine-verified status.
7. Conflicting saves preserve drafts. Session replacement, uncertain command delivery and retry never revive old permissions or silently lose text.
8. Grow unrelated data/history at three scales; exact reads/moves/list pages retain their examined-row/key/byte bounds. Separately grow permitted depth, body, page and reference fanout and measure predicted scaling, SQL plans, physical work, latency and contention.
9. Many withdrawn public candidates precede a visible one. Preparation or honest continuation reaches it; a capped sample never becomes exhaustive empty success.
10. Export/import preserves opaque components, formula source and exact references; unsupported rendering never executes payloads or silently substitutes new content.

## Primary external evidence and interpretation

Retrieved 11 November 2026. Mutable product documentation has no inspected immutable revision; this is behavioral evidence, not benchmarking. No external code was copied or adapted.

- [Notion synced blocks](https://www.notion.com/help/synced-blocks): reused content still requires access to its original source.
- [Obsidian links](https://obsidian.md/help/links): note, heading and block addresses have distinct granularity.
- [Obsidian publishing](https://obsidian.md/help/publish/publish): selective publication, deliberate updates and separate local retention after withdrawal.
- [Web Annotation](https://www.w3.org/TR/annotation-model/): body, target and selectors are distinct. This supplies interchange vocabulary, not Access.
- [PROV-O](https://www.w3.org/TR/prov-o/): entities, activities and agents distinguish provenance from correctness.
- SKOS, Lean, replicated-tree research, Yjs, KaTeX and Notion performance guidance are linked at the relevant analysis above.

Check exact dependency revisions/licences before implementation or adaptation; this report makes no code-reuse claim. The attempted OpenMath URL was unavailable, so no OpenMath-specific encoding is selected. Obsidian's first publication URL failed; the official current page above was retrieved.

## Confidence and what would change the recommendation

High confidence: Subjects, authored documents and placements need separate identities; references do not grant access; private attachment discovery cannot populate global candidate lists; exact references need current disclosure; citation graphs are not checked proofs; current snapshots and relation-only extensions do not establish Notion runtime equivalence.

Medium confidence: explicit document audiences and server-serialized same-structure moves are the best launch tradeoff. Required inherited subtree access, very high structure contention or offline editing would change execution choices, not identity/disclosure boundaries.

Unmeasured: head contention, save bandwidth, Source preparation completion, revocation behavior and editing usability. Run both scenarios through native access with stale indexes before broad UI delivery. Reuse an existing compatible Content resource if one emerges. If complete backlink pages prove infeasible, narrow launch discovery honestly rather than weakening private-content protection.
