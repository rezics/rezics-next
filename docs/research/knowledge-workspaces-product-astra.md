# Knowledge workspaces: product evidence and release design

Independent design research, inspected 11 November 2026, against checkout
`6d33d64618ffdbf7f9067a73e9dd2ea8a989852f`. This report recommends a product contract;
it is not an adopted specification or evidence of native acceptance. The other new
knowledge-workspace investigation was not read. No reference application was installed
or executed, and no REZICS product code was changed.

## Recommendation

Build **subject-connected documents** first: independently owned notes, an ordered
outline, reusable references and explicit publication around shared Subjects. A writer
can keep private Inspiration and Character arc documents beside a public Character,
publish one essay, and let other readers discover it and create their own private notes
about the same Character. The notebook never owns that shared identity.

Launch needs complete privacy/lifecycle, Subject/document references, publication
preview, child-document organization, recovery and export. Local databases, live
transclusion, real-time co-editing and computation can follow. Mathematics can start
with precise links among independent definitions/theorems/explanations; formal checking
and automatic dependency extraction remain separate capabilities.

Confidence is high in the identity/privacy boundaries and medium in the release cut.
Native feasibility and physical costs require implementation evidence.

## Decision to enable

Deliver the writer's public/private Subject journey as a complete first slice, with
reusable precise references for later mathematical authoring. Choose publication,
ownership and query semantics before promising database or collaboration parity.

## Repository fit and limits

The [architecture](../architecture.md) separates vocabulary, generic behavior and
authorities, and requires bounded neighborhoods. It does not require every note to be a
Semantic Subject or every edge to be a catalogue statement.

| Foundation | Present contract | Not established |
| --- | --- | --- |
| [Document](../../packages/document/README.md) | Versioned text/blocks, snapshot block IDs, exact revision references. | Independent block resources, synchronization, arbitrary math or collaboration. |
| [Subject pages](../subject-pages.md) | Shared subject hub, composition and disclosure. | Private working-document directory. |
| [Library/Collections](../library-and-collections.md) | Independent personal facts and ordered occurrences. | General nested document ownership; existing subject membership cannot silently change. |
| [Zones](../zones.md) | Routed views grant no source rights; source readiness remains explicit. | Publication of private sources. |
| [Scope](../scope.md) | Articles/hosted works and some Search/Zone capabilities remain closed. | Delivery or public exposure of this proposal. |

Content should own authored document/workspace lifecycle; Semantic keeps Subject
identity/vocabulary, Access authorization, Search admitted discovery, and Web composition.
Extend existing owners rather than introduce a new service or universal graph store.

## Primary-source survey

The survey includes 21 product/reference systems. All links below were retrieved on
the inspection date, as a full page or a search-index excerpt of the named primary
source. The evidence column states only what that source establishes. The implications
are independent recommendations. This is a behavior/documentation survey, not a visual
audit of authenticated applications or a license to reproduce their interfaces.

| System and inspected primary source | Observed pattern | Implication or limit for REZICS |
| --- | --- | --- |
| Notion — [sharing](https://www.notion.com/en-gb/help/sharing-and-permissions?nxtPslug=sharing-and-permissions), [synced blocks](https://www.notion.com/en-gb/help/synced-blocks?nxtPslug=synced-blocks), [database introduction](https://www.notion.com/help/intro-to-databases) | Database entries are pages with properties. Source permissions apply to linked views; editing a synchronized copy requires access to the original. Permissions can combine to broader access. | Separate membership/view configuration from authority. Reuse content by reference without transferring its ownership. Do not import Notion's grant-combination rule into Access. |
| Obsidian — [internal links](https://obsidian.md/help/links), [publishing](https://obsidian.md/help/publish/publish) | Notes support heading/block links. Publishing has a selected change set and optional linked-content selection; exclusions need review. | Precise links and an explicit public selection are useful. A local-vault link graph does not prove multi-user privacy or cross-workspace identity. |
| Logseq — [database-version documentation](https://github.com/logseq/docs/blob/master/db-version.md), [page embeds](https://github.com/logseq/docs/blob/master/pages/page_embed.md) | Nodes can be embedded, and page publication is a distinct action. The documented page embed edits the referenced content. Published-page search excludes password-protected pages. | Reference, embed, and publication are distinct operations. These docs cover different Logseq generations; do not combine them into one assumed storage contract. |
| SiYuan — [official interactive guide](https://b3log.org/siyuan/static/feature0.html), [API documentation](https://github.com/siyuan-community/siyuan/blob/master/docs/API.md) | Block-oriented navigation, references, custom attributes and querying support granular reuse. API guidance distinguishes source-document edits from writes to the derived SQL index. | Source bodies and reference/search indexes need separate authorities. A block-oriented editor is useful without making every block a public Subject. |
| AFFiNE — [getting started](https://affine.pro/blog/getting-started-with-affine) | Documents and whiteboards coexist; workspace membership and document permission are distinct; linked documents can have different access rules. | A visual canvas is a later presentation over shared resources, not a launch data model requirement. |
| Tana — [supertags](https://outliner.tana.inc/learn/features/supertags), [fields](https://outliner.tana.inc/learn/features/fields), [publication](https://outliner.tana.inc/docs/tana-publish) | A node can have a reusable type/field template. Initialization differs from live inheritance. Publication separately controls visibility of referenced content. | Local schema and template initialization should not require public ontology changes. A field default is not a permanently maintained dependency. |
| Capacities — [sharing](https://docs.capacities.io/tutorials/sharing), [collections](https://docs.capacities.io/reference/collections), [object properties](https://docs.capacities.io/reference/object-properties) | Typed objects can appear in several manual collections. Sharing presents a graph selection and, by default, includes referenced objects recursively. Collections have product-specific type restrictions. | Multiple placements need not copy an object. REZICS should choose explicit publication rather than recursive disclosure by default; its existing heterogeneous Collections retain their own meaning. |
| Coda — [connected views](https://help.coda.io/hc/en-us/articles/39555897467021-Create-connected-table-views), [relation columns](https://help.coda.io/hc/en-us/articles/39555878926861-Connect-tables-with-relation-columns) | Views share a base table. Relation columns refer to rich rows, and related columns can be formulas. | Separate data, membership, view configuration and computation. A table-like appearance does not provide the missing computation engine. |
| Airtable — [linked records](https://support.airtable.com/articles/3370222027-linking-records-in-airtable), [interface sharing](https://support.airtable.com/articles/4255096925-managing-and-sharing-airtable-interfaces) | Linked rows and configurable record detail are reusable. Public interfaces impose specific limits on linked-record expansion and available actions. | Source authority must be enforced on every exposed surface. Bounded public navigation is a defensible product choice; it should be visible rather than silently incomplete. |
| Lark/Feishu — [Docs permissions](https://www.larksuite.com/hc/en-US/articles/360024166434-lark-Docs-permissions-overview?from=product_creation) | The retrieved official search excerpt distinguishes direct collaborators, group/wiki membership and documents with independent parent inheritance. | Folder/page location and effective permission need explicit UI explanation. The complete page could not be retrieved, so details beyond that excerpt are not used. |
| Wolai — [official product page](https://www.wolai.com/product) | The official search excerpt lists block references and public sharing. The page itself rendered no readable text. | Confirms a relevant Chinese-language authoring comparison only; no precise inheritance, synchronization or privacy rule is inferred. |
| BookStack — [includes](https://www.bookstackapp.com/docs/user/reusing-page-content/), [roles and permissions](https://github.com/BookStackApp/website/blob/main/content/docs/user/roles-and-permissions.md) | Includes check the viewer's permission and cap nesting at three levels. Shelf membership does not automatically cascade permission to books. Includes are excluded from host search snippets/indexed text. | Strong precedent for viewer-authorized reuse, separate placement authority, finite expansion and avoiding duplicated private search content. |
| Zotero — [notes](https://www.zotero.org/support/notes), [collections](https://www.zotero.org/support/collections_and_tags) | An item can have several child notes; standalone notes are also possible. One item can appear in several collections. Public sharing selects notes and files explicitly. | This is close to subject-attached authoring. Preserve identity independently of its private research organization. |
| Scrivener — [character management](https://www.literatureandlatte.com/blog/how-to-manage-your-characters-in-scrivener) | A project's Binder contains character sketches alongside writing and research material. | Provide familiar writer entry points such as Inspiration and Character arc templates. They are configuration, not new character-specific backend tables. |
| World Anvil — [secrets](https://www.worldanvil.com/learn/secrets/secrets), [article states](https://www.worldanvil.com/learn/article-guides/articles), [subscriber groups](https://www.worldanvil.com/learn/access-rights/subscribers) | Reusable secrets can be attached to several articles and selectively revealed. Draft/publication and private/public are distinct dimensions. A Secrets tab can remain visible to everyone. | Direct evidence for the proposed writer job. REZICS should avoid revealing hidden attachment existence through conditional tabs/counts. Publication should not be confused with authoring state. |
| RemNote — [portals](https://help.remnote.com/en/articles/6030742-portals), [reference/tag/portal comparison](https://help.remnote.com/en/articles/6634227-what-s-the-difference-between-references-tags-and-portals), [sharing](https://help.remnote.com/en/articles/6030805-sharing-your-notes) | References navigate, portals expose reusable content, and both have backlinks. The interface marks portal content separately from its surroundings. | Learning benefits from seeing a definition next to its use and from knowing its source. Adopt a clear distinction between a link, a live view and an authored quotation. |
| Stacks Project — [stable tags](https://stacks.math.columbia.edu/tags) | Mathematical items retain identifiers when moved; a removed result retains an explanatory tag. | Stable knowledge identity and retirement are essential. A stable identity alone does not pin the exact wording used by an older solution. |
| Mathlib — [project introduction](https://mathlib.org/), [documentation overview](https://leanprover-community.github.io/documentation.html), [mathematics coverage](https://leanprover-community.github.io/mathlib-overview) | A shared library of formalized mathematics has definitions, theorem declarations, documentation and topic navigation. Its overview explicitly cautions that it may be incomplete/outdated. | Formal verification is a distinct evidence class. REZICS can link formal declarations later; ordinary editorial links must never acquire a verified-proof badge automatically. |
| Wikidata — [statement model](https://www.wikidata.org/wiki/Help:Statements) | Public identities connect through typed statements with qualifiers, references and ranks; multiple source perspectives remain representable. | A public Subject can be valuable beyond any one notebook. A note's link to a theorem is not automatically an accepted public assertion about it. |
| Wiki.js — [permissions](https://docs.js.wiki/admin/permissions) | Groups combine action permissions and page rules; path/site/locale matching has explicit precedence. | Navigation rules can have surprising authorization effects. REZICS should use its existing Access owner rather than recreate path-based permissions in the document tree. |
| Trilium — [cloning](https://docs.triliumnotes.org/user-guide/concepts/notes/cloning), [relations](https://docs.triliumnotes.org/user-guide/advanced-usage/attributes/relations), [sharing](https://docs.triliumnotes.org/user-guide/advanced-usage/sharing) | One note can occur beneath several parents; these are shared references, not independent copies. Removing a placement and deleting the note are distinct decisions. | Model occurrence identity explicitly and make removal actions unambiguous. Multi-parent navigation does not justify multi-parent ownership or permission inheritance. |

Additional standard: the [W3C Web Annotation Data Model](https://www.w3.org/TR/annotation-model/)
distinguishes annotation body, target, selected segment and source state. It supports
the separation of a note from what it is about, including revision/segment selectors.
It is an interchange reference, not a requirement to use JSON-LD as the native store,
nor a permission system.

Coverage gaps: Yuque's official help URL returned HTTP 403 and the attempted Anytype
documentation URL was inaccessible. No claims about their current private/public
semantics are used. The survey inspected no account-only UI, mobile behavior or paid
plan controls. Chinese-language coverage is strongest for SiYuan's source/API and the
Lark permission excerpt; Wolai is a discovery-level reference only. These gaps matter
for later interface design, but do not overturn the model decisions supported by the
other sources. Product documentation is not licensed implementation source; it was
used as behavioral evidence without copying text or interface assets.

## Source inspection at pinned revisions

### BookStack: resolving an include is a permission-aware read

Repository [BookStackApp/BookStack](https://github.com/BookStackApp/BookStack), inspected
revision `0b6b667e0d84ebb3406de6de9fadbf4230c29c0b`. The retrieved
[LICENSE](https://github.com/BookStackApp/BookStack/blob/0b6b667e0d84ebb3406de6de9fadbf4230c29c0b/LICENSE)
is MIT. No source was copied or adapted.

[PageContent.php](https://github.com/BookStackApp/BookStack/blob/0b6b667e0d84ebb3406de6de9fadbf4230c29c0b/app/Entities/Tools/PageContent.php)
constructs a content provider for includes, resolves each page through
`findVisibleById`, and stops repeated include parsing after three passes.
[PageIncludeParser.php](https://github.com/BookStackApp/BookStack/blob/0b6b667e0d84ebb3406de6de9fadbf4230c29c0b/app/Entities/Tools/PageIncludeParser.php)
handles DOM placement independently of that content provider. This is direct source
evidence for separating composition from source authorization and for bounding nested
rendering. It does not prove that three passes bound every possible byte volume or
number of source queries; REZICS also needs per-page reference and response-byte caps.

### SiYuan: reference indexes are a separate read structure

Repository [siyuan-note/siyuan](https://github.com/siyuan-note/siyuan), inspected revision
`be17ed1e0510bb6371cb8a162e16898a697fa118`. The retrieved
[LICENSE](https://github.com/siyuan-note/siyuan/blob/be17ed1e0510bb6371cb8a162e16898a697fa118/LICENSE)
is AGPL v3, and the inspected files declare `AGPL-3.0-or-later`. This investigation is
behavior/source reading only; no implementation, comment or test was copied/adapted.

[backlink_ref_defs.go](https://github.com/siyuan-note/siyuan/blob/be17ed1e0510bb6371cb8a162e16898a697fa118/kernel/sql/backlink_ref_defs.go)
batches selected block IDs and reads reference pairs in a selected notebook database.
[backlink_reference.go](https://github.com/siyuan-note/siyuan/blob/be17ed1e0510bb6371cb8a162e16898a697fa118/kernel/model/backlink_reference.go)
distinguishes reference-only source blocks from surrounding useful content for display.
These observations support a dedicated inverse reference projection and deliberate
backlink context. They do not establish multi-user ACL isolation or a global graph
query bound. Neither repository was built or executed.

## Convergence and disagreement

Stable resource references, multiple placements, explicit publication and contextual
navigation recur across the survey. Sharing rules differ materially: Capacities can
select referenced objects recursively; Tana offers explicit reference visibility;
BookStack checks the current viewer; World Anvil has reusable selective secrets.
REZICS should choose explicit publication. Publishing a character essay must neither
publish linked research nor reveal that a private character arc exists.

Hierarchy also differs: Trilium has multi-parent notes, Scrivener a Binder, and
Capacities discourages deeply nested collections. A tree of occurrences over independent
documents plus ordinary references supports both ordered writing and reusable knowledge.
Database products add calculation, but a table appearance does not establish safe
query/dependency maintenance. These require separate native capability and cost proof.

## Competing designs

| Candidate | Tradeoff | Recommendation |
| --- | --- | --- |
| Every note is a public Subject | Reuses Semantic structure but burdens private writing with public identity/editorial semantics. | Reject as default; a work's Subject and its drafts/body remain distinct. |
| Isolated notebook, later public-copy export | Easy private application, but public/private copies drift and shared Subjects add little value. | Reject as primary integration; retain export for portability. |
| Universal mutable block graph with ACL inheritance on every edge | Uniform shape obscures different ownership, placement, reference and computation invariants; fanout is hard to bound. | Reject the undifferentiated form. |
| Content documents plus placements, references, Subject anchors and selected publications | Requires genuine lifecycle/index work but directly serves both examples with existing owners. | Recommend; add schemas, collaboration and computation over these stable identities. |

## Proposed objects and invariants

Names express responsibilities rather than a frozen SQL/HTTP ABI.

| Object | Invariant |
| --- | --- |
| Subject | Shared semantic identity; notebooks do not own it. Merges preserve original references, not merge documents/placements. |
| Workspace | Indexed authoring boundary, initially account-owned; no replacement for Realm/Space/Zone. |
| Document | Independently owned, revisioned authored resource. Two notes about one Subject stay distinct. |
| Revision | Immutable body/provenance/reference intent; current permission still governs reads. |
| Placement | Stable ordered occurrence with one parent; moving/removing does not edit/delete its target. A shortcut does not recursively adopt the target's children. |
| Reference | Source revision/block, target selection and definition-owned role. Linking is not accepted public truth or proof. |
| Publication | Explicitly selected revision and public metadata under current eligibility; later drafts stay private. |
| Local schema, later | Namespaced stable field IDs, versioned meaning and typed values; labels do not establish identity, templates do not rewrite existing values. |

The outline is a tree of occurrences; document references form a graph that may cycle.
Containment, formula dependencies and permissions each need their own rules. Subject
identity operations must not silently alter their integrity. Source documents own their
references; inverse discovery is derived and rechecks current source eligibility.

## Publication and mixed visibility

The central rule is **composition does not grant access**. A private document may
refer to public Subjects and publications. A public document may contain a reference
whose target is not readable by a particular viewer, but its public response must not
reveal target metadata, hidden link targets, private path names or source snippets.

Recommended first-release behavior:

1. New documents are private. Publish previews the exact revision, title, attribution,
   media and visible references as anonymous before confirming that selection.
2. Publication selects only this document. It grants no rights to descendants,
   siblings, sources or workspace. Future batch publication uses an explicit manifest.
3. A published document beneath a private outline opens independently, without private
   breadcrumbs, sibling metadata or project names.
4. One bounded viewer-aware Subject read may combine public writing and authorized
   private attachments marked Only you. Authority/index predicates remain distinct;
   separate endpoints are not required. Other people's private counts stay hidden.
5. The owner's combined response is private, never shared HTML/CDN/SEO/export content.
   Public preview runs with anonymous authority, not CSS-hidden private bodies.
6. A static Notes entry can exist for every Subject; conditional tabs/badges must not
   announce invisible attachments.
7. Public linking does not publish targets. Generated labels need viewer authorization.
   Publication preview also covers literal author-written text: software cannot infer
   and erase every secret an author deliberately quotes.
8. Unpublish closes current disclosure immediately; derived cleanup is bounded.
   Old revisions/exact links still need current eligibility. Public history excludes
   earlier private revisions.
9. Publication does not imply community adoption of the document as canonical truth.

Separate small documents express private Inspiration beside public Character analysis
without introducing paragraph ACLs at launch.

For source reuse, distinguish three operations in both model and UI:

- **Link:** navigate to an independently authorized target. No copied target body.
- **View here:** a later live or exact-revision inclusion whose source is authorized
  at read time, visibly identified, and expanded within finite limits.
- **Quote/copy:** newly authored bytes with citation and applicable reuse rights.
  They have their own lifecycle and do not pretend that revoking the source deletes
  independently retained copies. This operation needs explicit user intent.

## Writer journey

From a public Character, Add a document shows that Subject and defaults to Only you.
Optional Inspiration, Character arc, Scene ideas and Research templates configure the
shared editor. Empty creation does not publish a catalogue entry. The writer creates
and reorders children, and adds a shortcut to one research document in another outline.
Remove from outline preserves the document; Move document to trash affects its lifecycle.

The Subject frame shows the viewer's working documents beside eligible public writing.
A public essay can be referenced from a workspace without copying it; a response is a
new authored document about the same Subject. Neither action transfers Subject control.

An unpublished original character can start as a private working document/local record.
Later linking to an admitted Subject or proposing one uses the ordinary Semantic flow;
it does not publish the working notes or reinterpret their references. A native private
Subject capability must be confirmed before replacing this explicit local-record seam.

Single-owner writing with CAS conflict recovery is sufficient for launch. If coauthors
are advanced into launch, include shared directory, revocation, body/media and draft
history acceptance together; a share button over owner-only storage is incomplete.

## Mathematics journey and semantic precision

A solution to an inequality problem links Cauchy–Schwarz, the definition of inner
product and the positive-definite assumption. Each theorem/definition can have a shared
Subject, several explanations and an exact statement revision. Failed attempts stay
private. Preserve the concept identity, statement with hypotheses, explanation/proof,
source revision/block and the author's claim that it is used at this step.

Similar names do not establish equivalent statements: real and complex spaces differ;
a missing nonzero or compactness assumption changes a claim. Uses, proves, explains,
formal-declaration dependency and recommended prerequisite have different meanings.
A learning route can be cyclic even when a particular proof dependency cannot be.

Launch provides document links with optional exact revision/block selections and
bounded authorized previews. Readers can visit the current Subject while retaining
the cited statement. A newer source revision does not silently rewrite the solution's
basis. A hidden target stays concealed; retirement details require disclosure authority.
Explicit links are author claims, not proof that every dependency was found.

Later mathematical authoring needs a versioned formula node, lossless source notation,
accessible rendering, safe renderer configuration, unsupported fallback and export.
Formal integration separately records tool/library versions, environment and checking
result. Editorial approval, formula rendering and machine-checked proof are distinct.
The thought experiment is supported by the model; launch prose/reference support must
not be advertised as completed equation-heavy authoring or automatic theorem extraction.

## Performance and physical access

Let `P` be a page cap, `D` the structural depth cap, `R` the references expanded in one
response and `B` its byte cap. Owners instantiate and measure these finite limits;
they are not a new runtime quota protocol.

| Operation | Proposed bounded access | Proof obligation |
| --- | --- | --- |
| Open/save a document | Exact routed head/revision; body at most `B`; revision/head CAS in one home. | Unrelated history stays out; whole-snapshot cost follows body bytes, not changed characters. |
| Outline level | Cursor seek by workspace, parent, order and ID; `P+1` rows. | No full subtree read, global sort or hidden refill scan. |
| Move occurrence | Same-home CAS; at most `D` ancestor checks under structural mutation fence. | Concurrent opposing moves preserve acyclicity; sibling renumbering is not constant-cost. |
| Subject writing | Indexed public-publication and viewer-owned Subject anchors; current disclosure. | Millions of others' private notes neither increase candidate scans nor affect counts. |
| Reference preview | At most `R` exact target reads, batched by kind/home; finite excerpts. | No recursive expansion of all cited theorems or pages. |
| Publish/withdraw | Local selected-revision/publication state; bounded derived-index effects. | Current withdrawal closes stale-index disclosure without synchronous backlink fanout. |
| Export | Paged manifest over selected authorized resources; resumable work. | Total work follows input; each step stays bounded and rechecks disclosure. |

An indexed child page targets `O(log N + P)` index/output work, plus bounded authority
and hydration; each additional parent expansion adds a seek. This is an algorithmic
target, not measured latency. One Subject may have millions of attachments. No header
or counter may enumerate them all. Public and own-personal populations require
separate indexed predicates, but may be composed into one bounded viewer-aware API
response. URLs need not be separate. Shared-with-me discovery later needs an admitted
candidate population rather than scanning every group or filtering an arbitrary prefix.

An arbitrary stored field does not immediately support arbitrary indexed combinations,
joins, sorts or exact counts. A rollup over `m` unmaintained relations reads those
relations; eager updates affecting `f` derived values cost work proportional to that
fanout. Incremental maintenance and preparation move work across time, not eliminate it.
Declare dependency cycles, freshness and privacy before exposing computation.

Reference indexes should retain source/target identity rather than copy private target
bodies into public source documents. Rich search consumes authorized publications
through Search; private full-text needs its own current-disclosure/population contract.

## Priority and release sequence

Launch means the first public delivery of this capability. Adoption must reconcile
first-public scope and closed capabilities; these rows do not declare readiness.

| Priority | Complete observable slice | Dependency/evidence |
| --- | --- | --- |
| Launch | Private documents about shared Subjects, stable links, outline/shortcuts, CAS recovery, trash/restore and export. | Content lifecycle, Semantic identity, bounded placement mutations and native readback. |
| Launch | Public knowledge and Only you material in one viewer-aware Subject experience; public writing discoverable at its Subject. | Access disclosure, indexed public/own populations, media/cache/search isolation and growth. |
| Launch | Anonymous preview and selected-revision publication; later drafts stay private; unpublish closes current disclosure. | Native publication transitions, history separation and stale-index withdrawal. |
| Next | Invited readers/coauthors; authorized live or pinned source inclusions; exact/current version comparison. | Membership/revocation, conflict policy, finite expansion, export semantics. |
| Next | Workspace-local schemas/templates, typed local records and admitted table/list/filter/sort views. | Stable field IDs, schema versions/migrations and indexed all-surface query behavior. |
| Next | Mathematical formula authoring and problem/theorem/definition/explanation templates. | Lossless notation/accessibility, exact statement/hypothesis citations and source-change scenarios. |
| Later | Formulas/rollups, dependency impact, real-time/offline collaboration, canvases and study workflows. | Independent consistency designs and measured costs. |
| Later | Formal checking and external knowledge/annotation interchange. | Versioned external evidence, rights, mapping conflicts and failure semantics. |

Do not postpone public Subject attachment indefinitely after shipping private notes:
that would deliver a different product. Launch need not have every Notion database or
collaboration feature; it must complete the distinctive shared-knowledge journey.

## Acceptance scenarios for the implementation brief

These specify observable outcomes, not passing-test claims.

1. **Writer privacy:** A creates private Inspiration and Character arc documents
   about public Character C. A sees both beside C. Anonymous, stranger B and unrelated
   members see no private titles, counts, snippets, activity, paths or attachment IDs.
2. **Selective publication:** A publishes Character analysis; siblings, newer drafts
   and prepublication revision history remain private. Public media matches the preview.
3. **Shared Subject value:** B discovers the analysis through C and writes a private
   response. No Subject copy/ownership transfer occurs, and A cannot read B's response.
4. **Reuse/lifecycle:** One source appears in two outlines. Remove one placement
   preserves the other and body. Trash/restore has explicit reference effects; foreign
   references grant no deletion rights.
5. **Independent publication:** A public document beneath a private project exposes
   no private breadcrumbs/siblings. Publishing a parent does not publish its children.
6. **Withdrawal:** Unpublish/revoke closes disclosure through stale search, backlink,
   preview, download, composed-cache and exact-revision paths. Cleanup resumes boundedly.
7. **Preview/export:** Public preview/export executes as anonymous; personal export
   is separately labeled and authorized. Cached target text never fills unavailable data.
8. **Concurrent recovery:** Two tabs save one base. Conflict retains the second draft
   for comparison/reapply. Uncertain retry preserves the original intent and identity.
9. **Precise mathematics:** Two solutions cite different revisions of one theorem.
   Updating its current explanation changes neither basis; names and link edges do not
   imply equivalent hypotheses or verified proof.
10. **Private draft identity:** Linking/proposing a public Subject for an unpublished
    character/problem preserves private records and references without publishing them.
11. **Growth:** Scale unrelated documents, histories, hidden attachments, backlinks and
    siblings around a fixed visible page. Measure examined rows, index work, statements,
    bytes and latency; output caps alone do not pass. Include sparse readable populations.
12. **Accessibility:** Keyboard navigation/reorder avoids drag-only actions. Source
    reuse and visibility are understandable without color. Later math has source/text
    alternatives and preserves unsupported notation.

## Remaining evidence and what could change the recommendation

Confirm existing Content lifecycle and native private-Subject support before creating
new stores or replacing the private-record seam; this bounded investigation did not
inspect all implementation/tests. Ready measured Search sources could advance private
full-text into launch. Coauthor demand could advance collaboration only as a complete
membership/disclosure slice. Observed writing above snapshot limits could advance
block-delta/chunked editing. Native adversarial/growth failures may narrow publication
or reference expansion; such changes belong explicitly in owner contracts.

Yuque/Anytype access gaps and the absence of authenticated visual/mobile testing remain
interface-research limitations. No competitor material proves REZICS's physical costs.

The strongest evidence supports a small, complete public/private document product
around shared Subjects. The evidence does not support promising a faster universal
Notion replacement, a complete theorem graph, or automatic correctness of authored
knowledge.
