# Knowledge workspaces

Owner: Content coordinates this capability across Semantic, Accounts, Web, Search and Performance. This document
owns its product model and release priorities. [Acceptance](knowledge-workspaces-acceptance.md) owns scenario and
growth evidence; the [Goal](goals/knowledge-workspaces.md) is the implementation handoff. These are required
outcomes, not a claim of existing implementation. Existing module contracts remain authoritative for their primitives.

## Product decision

People organize private work around shared subjects, reuse precisely identified knowledge, and deliberately publish
selected work back into the public knowledge network. The public subject keeps its independent identity and value
across authors, notebooks, communities and presentations. A private notebook is one consumer of that subject.

The first public release must complete the writer journey: from a Character subject, create an owned notebook with
Inspiration, Character arc and Scene notes; nest and reorder documents; refer to public material; publish a selected
analysis; keep other notes and subsequent drafts private. An anonymous reader discovers that analysis from the
subject and can reuse an exact citation. The author sees public material and their own work in one coherent visit.

The mathematical learning journey guides the reusable model: a problem refers to particular theorem statements and
definitions, with explanations of how they are used. References let a reader open prerequisites without copying an
entire knowledge base. A link is an authored claim of use, not machine verification of a proof. Mathematical notation
and specialist vocabulary have a later release gate; the structural journey must already work with ordinary text.

Notion-like knowledge organization is a supported direction, not a promise of complete Notion feature parity at
launch. New domains configure shared capabilities. Add generic behavior only for a concrete missing outcome.

## Objects and authority

| Object                | Meaning and authority                                                                             | Important boundary                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Subject               | Semantic identity for a public or otherwise authorized topic, work, character or knowledge object | A subject is not owned by a notebook; attaching notes confers no editorial or publication authority over it |
| Notebook              | Content-owned routed authoring aggregate, initially owned by one account                          | A product workspace, not another Community Space, Realm, permission engine or private Semantic catalogue    |
| Document              | Stable authored resource in one notebook; private working head and explicit publication selection | Two documents about the same subject remain different documents                                             |
| Document revision     | Immutable canonical body, title, language, references, authorship and licence metadata            | Revision identity fixes content, not permanent permission to read it                                        |
| Placement             | Stable occurrence in the notebook's ordered primary tree, with parent and order                   | Moving a placement changes organization, not document ownership or visibility                               |
| Reference             | Source-owned, typed edge to a subject, document or exact document revision/block                  | A reference neither grants access nor duplicates the target                                                 |
| Publication selection | Explicitly selected revision of one document, with approved public associations                   | Saving a draft, publishing its parent, or adding a reference never publishes it                             |
| View                  | Configuration over an admitted source and presentation                                            | A view cannot widen source permission or invent indexing support                                            |

Notebook, document, revision and placement identities are permanent and distinct from Semantic canonical identity.
Use native routed IDs, commands, revisions, events, History, Work and Access. Keep document authority, revisions and
primary structure in the notebook's partition. At launch an account-owned notebook uses that account's native home,
so the private attachment directory and document writes can commit together without an asynchronous private index.
Referenced subjects and foreign documents can live elsewhere and are acquired through declared ports and bounded
full-key reads. One notebook may be large; it must never be fetched as a whole. A very busy account/home can become
a storage hotspot, and a busy notebook can contend on structure mutations; later sharding needs an explicit native
ownership migration that preserves routed resource identity. Realm-owned notebooks require their later-version
routing and membership contract before creation is offered.

### Native first-loop contract

The first native slice creates an account-owned notebook around one existing public Subject. The notebook, its
private attachment directory, stable document resources, immutable document revisions and primary placements use
the owner's account home and route. Each first-slice document inherits the notebook's Subject association; changing
that association is a separate admitted operation. Private reads and writes require the owning account's current
native account admission and a full placement-ancestor check. Admit at most 31 parent ancestors (32 placements on
one path); this bounds the path and Access work without borrowing the hosted-book occurrence or node-count limits. There is no notebook
document-count limit. Sibling pages and mutations use indexed positions and a structure revision rather than
loading or rewriting every sibling.

Every saved document revision fixes its validated canonical document bytes, SHA-256 digest, title, language,
references, authorship and licence. A publication is an immutable record selecting one exact document revision and
the notebook Subject. The document's current-publication pointer is the only public availability authority. Saving
a later private revision does not change it. Publication and withdrawal use native receipts and compare-and-swap
against the expected document and publication revisions; withdrawal clears that pointer in the same transaction.
Public resolution checks the pointer and exact bytes again when returning a response, so delayed or paused indexing
cannot preserve access after withdrawal. Unknown or non-current revisions are concealed.

Search owns candidate ordering and its indexed association observations; Content owns exact publication bytes and
currentness. A Search-facing useful-page source accepts a bounded candidate observation, checks each candidate
against its current publication and Subject authority, and retains preparation over that fixed observation when
sparse stale candidates prevent a useful page or proved exhaustion. Candidate rows are never read authority, exact
totals are not returned, and missing Search or Subject authority is unavailable rather than an empty result or a
scan of account homes. Direct public resolution is available as soon as the Content publication commits and does
not wait for Search acknowledgement. The native first-loop proof selects and reads one exact publication, then
withdraws it while derived indexing is paused.

The current Search Content source port exposes review discovery but has no Knowledge candidate-page contract. The
first native loop therefore proves direct exact reads against current Content source authority; it does not claim
subject useful-page discovery. Search must add its own bounded Knowledge candidate observation and preparation API
before subject contribution pages are exposed.

At account-erasure time, private notebook structure, attachments, heads, unselected revisions and owner links are
erased. An eligible current publication retains only its selected immutable revision and permitted public fields as
a de-identified contribution, without its notebook ancestor chain or account identity. The existing publication
record remains the source; no second publication store or writer is introduced. A publication already withdrawn at
the erasure fence has no retained public selection. Moderation and later source withdrawal continue to govern the
retained contribution.

Decision: the native first loop uses account-home notebooks, a 32-placement ancestor bound and exact current Content
publication pointers for direct anonymous reads; Subject useful-page discovery waits for Search's bounded
candidate-preparation API, and erasure retains only eligible selected revisions in deidentified form.

Primary placements form a forest under one notebook root. A document has one primary placement there. Later reference
placements can show the same document elsewhere without moving or copying it; they do not recursively acquire its
children. Their placement IDs remain different. First-release reuse uses ordinary document references. A deep copy
creates new document and block identities and keeps explicit provenance; it is a later bulk operation. The first
release supports a one-document copy.

A not-yet-public character or idea can start as an ordinary private root document. Publishing a topic is an explicit
Semantic create/contribution journey followed by attaching the existing documents; it never turns all private
documents into public catalogue facts. Duplicate-topic advice and identity resolution retain their Semantic owner.

Definitions owns reusable vocabulary and schema validation. Content owns authored documents and local record state.
Library Collections continue to organize their contracted subjects and occurrences; a notebook is not a disguised
Collection with new membership semantics. Zones may present published documents through their existing composition
contracts after that source is admitted. They do not become the content or permission owner.

## Writer and reader experience

On a readable subject, the signed-in user can see public contributions and their authorized personal material in the
same page. A private area is labelled Only you; public contributions identify their author and publication state.
Creating a document defaults to private. Templates supply editable starting titles and structure; Inspiration and
Character arc are templates, not privileged database fields or new backend branches.

The subject API may compose both areas in one bounded viewer-aware response. This design requires no separate URL,
service or HTTP request for private content. The response identifies the audience and independent continuation of
each collection of results. Anonymous/public-only evaluation reads no private population. A personalized response
uses private, no-store caching; a public cache can receive only an explicitly anonymous projection. Viewer, source,
query and lifecycle changes retire affected results and cursors. A page that is also a public destination still
uses the public projection for SEO, metadata, share previews and anonymous exports, even for its author.

The author can open, rename, nest and reorder documents with keyboard or pointer controls; breadcrumbs and the
outline load lazily. A child shows its own publication state. Publishing a parent does not change a child's state.
A public document can exist under a private notebook or private parent: its public visit starts at that document,
with no private ancestor breadcrumb, sibling name, hidden-child count, positional gap or notebook identifier.

Publication shows the exact selected revision as an anonymous reader will see it. The author selects the public
subject associations and any public navigation links, confirms attribution/licence, and resolves references that
cannot appear publicly. Confirmation binds this preview's revision and publication policy. A stale preview requires
refresh, preserving the draft. Publishing one document never recursively walks or publishes the private tree.
Public navigation is an explicit list of already-published targets in that document, not a filtered serialization of
its private primary tree. Each target is independently checked when read.

Later private edits leave the selected public revision unchanged. Update publication selects a new exact revision.
Withdraw removes public access immediately at the authoritative source; derived discovery may catch up later but
must never serve the withdrawn body. The owner retains drafts unless they delete them. Direct URLs remain stable.
Previously published revisions are citeable only while the document and that revision remain publicly available;
never expose an intermediate private revision by guessing its ID or incrementing a revision number.

Keep an indexed record of exactly which revisions were publicly selected in the document's current publication
generation. Updating publication preserves older selections in that generation for citations. Withdrawal advances
the generation and closes all old selections. Republishing authorizes only the explicitly selected revision in the
new generation; old citations remain unavailable until their revisions are explicitly reselected. Trash/restore
clears selections by the same generation mechanism. This state is separate from private working revision numbers.

Two authors may publish different analyses of the same character. They coexist with provenance; neither overwrites
the catalogue's selected facts. A public contribution may separately be proposed as a Semantic statement through
the ordinary editorial workflow. Publication does not automatically adopt it as catalogue truth.

## Reference and mathematical meaning

References have stable source-local identities and a discriminated target:

- `subject`: original routed Subject ID, resolved through current Semantic identity and disclosure;
- `document`: current readable publication or authorized working head, explicitly labelled as a live reference;
- `revision`: document ID, exact revision ID and digest, optionally a block ID within that revision.

An exact citation never silently follows a newer revision or falls back to the live head. A missing block produces an
unavailable citation, not a nearby guessed paragraph. Subject merging may change the displayed canonical destination;
it never rewrites original reference provenance, merges documents, combines placement trees or identifies theorem
versions. Unmerge must recover references to their original identities.

The authored body uses a versioned reference component carrying a source-local reference ID. Target locators,
selection mode and role live in that revision's typed reference manifest. Resolver-generated labels/previews are
read projections, not copied body attributes. An optional literal label is authored text and is reviewed as such
on publication. Use the existing opaque-extension facility with a registered, validated definition rather than
adding service imports or a second document format to the standalone Document package.

Content owns references made by an authored document. Semantic owns adopted subject-to-subject statements. Use the
same declared vocabulary where meanings agree, with an explicit promotion/contribution operation between them.
First-release reference roles are finite and versioned: about, cites, explains, uses and inspired-by. Definitions
owns their identifiers and descriptions. These are directed authored claims; none implies mathematical entailment,
causation, category membership, symmetry or transitivity. General references may contain cycles. Navigation expands
only on request and always has a finite depth and node limit.

A problem document can cite an exact theorem document and definition document today. The theorem's assumptions,
conclusion and chosen notation stay with that exact statement; another proof is a separate authored document. A
statement with changed assumptions must not replace an existing exact citation's meaning. Later mathematical
profiles can expose Definition, Statement, Problem, Proof and notation vocabulary, plus a distinction between
mathematical objects and authored formulations. They must not classify every theorem as an interchangeable Concept.

An explanation can attach a use-reference to a source block and say why a theorem applies there. The authored
explanation and source block are selected together in the source revision. Outgoing links and one-hop prerequisites
are first-release capabilities. Exhaustive prerequisite closure, minimal prerequisite sets, automatic proof checking
and pedagogical ordering are later capabilities with separate completeness semantics.

Managed references resolve current target metadata only through target authority. Private references can target
public or otherwise readable material; public publication cannot expose a never-public target, private title,
target ID, excerpt or fallback copied by the resolver. The preview requires replacing/removing that managed
reference or separately publishing the target. It does not make the target public as a side effect.

If a target later becomes unreadable, the source reader preserves an unavailable citation marker and withholds
resolved target metadata and content. Public APIs and exports serialize the disclosure projection, not an unchecked
canonical authoring snapshot containing hidden reference attributes. The projection has its own representation
digest; it must not claim byte identity with the source revision digest. Source-owned text already deliberately
published by its author is distinct from resolver-fetched text. Legally permitted quotations are explicit authored
content with attribution, not a hidden target cache. Current erasure and moderation policy still governs retained
copies. Access control cannot retract bytes a recipient already downloaded or prevent deliberate manual disclosure.

## Copy and portable export

Launch export is one selected document, with an optional separately requested Markdown rendering. The primary
artifact is a versioned `knowledge-document-export-v1` JSON envelope containing the existing Document version/profile
and snapshot, selected document/revision identity, language, licence, permitted provenance and a typed reference
manifest preserving target kinds, exact revision/digest/block selections and relation roles. Serialize with the
existing canonical JSON rules; validate the envelope and the contained Document independently. This wrapper is an
exchange artifact, not another native body format. It carries no recursively fetched targets or sibling documents.

An authorized owner can select an exact own working revision and export its authoring representation and owned
reference manifest. A public reader can export only a currently eligible publication's disclosure projection and
permitted manifest. The envelope declares `authoring` or `public` representation and its own digest; a redacted
public export is not described as a byte-identical original. Current source/target erasure and media authority apply.
Opaque extension payloads and mathematical source text must round-trip where permitted; Markdown is explicitly a
potentially lossy convenience. Import is a later feature, so a valid export is not evidence of an implemented importer.

Single-document copy uses the same permitted selected representation, creates new document/block/reference IDs,
remaps source-local anchors, and retains exact external references and provenance. It never clones hidden revisions,
target content, public grants or child documents. The copy starts private in the destination owner's notebook.

## Access and lifecycle

Access owns all grants and decisions. Notebook and document modules supply native resource facts and lifecycle
operands. At launch there are two content audiences: the owning account's private working material, and deliberately
published content readable under the public policy. Administrative actions retain the existing narrowly declared
platform reach. No new universal administrator shortcut is introduced.

The relevant decision is compositional: the requester must be allowed to read the source representation; each
resolved target must separately be readable for that representation's audience. A public representation resolves
targets as public, including when its author is signed in. The private composition may use the viewer's own rights.
The authenticated owner may therefore see a private reference beside a public analysis, with an explicit audience
label, without changing the anonymous representation.

Notebook membership and public subject access never imply access to each other. No per-block ACL is introduced at
launch. A user who needs a private paragraph inside an otherwise public presentation stores that material in a private
child document. The interface can compose it for its authorized viewer; the public projection omits it entirely.
Spoiler concealment is presentation, not private access control.

Account-owned subject attachment indexes use an owner anchor plus original Subject ID. Never insert a private
attachment, private document count or owner locator into the global subject discovery directory. Public associations
are created only from explicit publication selection. Owner-local lookup and public discovery remain distinct
indexed populations even when one API composes their results. Avoid traversing every notebook or every account on a
subject visit. Canonical identity aggregation consumes Semantic's admitted mapping/source capability; an unavailable
mapping cannot be approximated by scanning all originals.

Trash, restoration, erasure, legal holds, moderation and account termination follow [Deletion](deletion.md). The
explicit Trash subtree action hides owned documents beneath that primary placement through a bounded ancestor-chain
check; it does not synchronously rewrite every descendant. It never follows references into other documents.
Deleting a later reference placement removes that occurrence only. Unrelated notebook branches stay available.

Restoration never republishes the subtree. Keep its root hidden while bounded retained work advances publication
generations for the selected root and every owned primary descendant, closing both current and historical public
selections. Atomically reactivate the selected root only after consuming complete durable traversal under the same
structure/restore fence. Independently trashed nested roots remain trashed. The retained restoration
fence prevents edits, insertions and moves into/out of that subtree while preserving unrelated work. Its cursor
therefore covers a stable finite structure. A failed or cancelled restore leaves the root hidden and resumes safely;
the UI shows progress and the existing restore deadline. Purge/expiry and restore race through the same root fence.
Single-document restore completes in one bounded command when it fits. Re-publication is always explicit.

Publication withdrawal of one document changes only that document's public state. Physical subtree cleanup pages
through its retained structure with a durable frontier. Moving a document out of trash requires completing restore
first; moving a placement cannot bypass a hidden ancestor or revive an old public selection. Native lifecycle checks
inspect the bounded ancestor chain as boolean eligibility, without disclosing private ancestor metadata.

For account erasure, private drafts and never-published revisions are erased. Eligible published contributions may
remain under the existing de-identified public-contribution policy. The retained publication must be independent of
the erased private outline, working title, unselected revisions and account links. This disposition must be recorded
for every new table, index, outbox payload, export and media claim before opening the capability. Media keeps Content's
ordinary ownership/claim lifecycle; publishing a document does not implicitly publish unrelated uploader inventory.

Content's existing document authority must support a minimized retained-public lifecycle state for eligible public
contributions after account erasure. That state resolves the retained publication directly, without a now-erased
notebook ancestor chain or author-account permission. It retains only permitted published selections and source
lifecycle evidence; it creates no second publication store or writer. Moderation remains effective. Native account
erasure acceptance must prove this transition before the capability opens.

## Structure, storage and concurrency

Reuse the [Document contract](../packages/document/README.md) and Content's canonical byte/digest/licence handling.
The first release saves bounded whole-document snapshots, not every keystroke as a new immutable revision. The
editor keeps local changes and debounces autosave; explicit Save and navigation expose acknowledged state. A stale
revision returns the ordinary conflict result with the draft preserved and a readable comparison. Never claim that
CAS is simultaneous collaborative editing. A later collaboration adapter may use a mature CRDT after proving
authority, compaction, reconnect, schema migration and erasure; published snapshots remain exact artifacts.

All primary tree mutations serialize through one notebook structure revision/lock inside its native partition.
Check ancestor identities before inserting or moving a placement; reject self-parenting and cycles. Maintain exact
subtree height with an indexed maximum over direct children's heights. New depth is obtained from the bounded
ancestor chain, not stored on every descendant. On reparenting, check destination depth plus subtree height, then
update heights on the two affected ancestor paths. This avoids relabelling every descendant or enumerating every
sibling. The lock covers both the check and mutation, so concurrent opposite moves cannot both commit.

Use mature sibling ordering. Do not put the full sibling list in the parent's JSON. Order-key exhaustion requires a
bounded resumable rebalance with a new order generation and atomic activation; never renumber a million siblings in
one command. A cursor binds the notebook/parent, audience, order generation and query. A cross-notebook move is a
later explicit copy/transfer workflow, not an atomic write across partitions.

Reference cycles are allowed; containment cycles are not. A semantic DAG flag, union of Context overlays or quotient
by canonical identity does not prove containment validity. Formula dependency DAGs belong to the later computation
capability and have their own cycle and evaluation contract. One logical graph does not imply one untyped edge table
or a common ownership/transaction boundary for every kind of edge.

## Search, discovery and public value

At launch the subject visit composes its ordinary public facts, a bounded page of published contributions and a
bounded page of the current owner's attached documents. Direct document URLs, notebook outline, recent documents
and normalized-title prefix lookup give complete, indexed ways to navigate owned work. Prefix lookup's scope and
matching are stated in the UI; it is not advertised as full-text or semantic search.

Public association rows contain only explicitly selected public data. They are derived from Content publication
events and route to the authoritative source. Public reads order by publication association time plus stable ID,
not by hidden draft edits, hidden reference counts or private popularity. They expose no total count. Every candidate
is rechecked against current source publication, selected revision, ancestor lifecycle, target disclosure, moderation
and the account-retention policy before serialization. Unsupported or unavailable source evidence is unavailable,
not an empty successful result.

Publication acknowledgements establish source state, not immediate discovery in every inverse index. Return the
direct public URL as soon as that source can be read; the interface can separately show discovery being prepared.
There is no distributed transaction covering all referenced Subjects. Native durable effects provide idempotent
addition and removal. A delayed add from an old publication generation cannot resurrect a withdrawn association.

The [filtered-list contract](filtered-lists.md) owns useful pages, preparation and complete observations. Do not add
arbitrary negative predicates, target-derived sorting or exact counts to this bounded publication-time listing.
If stale candidates exhaust the foreground budget, retain preparation over a fixed indexed association observation;
resume from its cursor and produce a useful page or proved exhaustion. Source eligibility is rechecked at disclosure.
This observation proves coverage only for that subject's published association index, not all documents everywhere.
Private attachments never enter that observation. Convergence is required for finite input under quiescent sources;
continuous mutation may require restart and must be represented honestly.

Public document search, notebook full-text search, semantic search, cross-notebook views and arbitrary filters belong
to later stages and use Search's existing compiler/index authorities. The existing general Search exposure gate is
not silently opened by releasing these direct document and subject-attachment capabilities.

## Launch operation bounds

These are initial design limits, owned here until native module contracts adopt the exact bound in implementation.
They are acceptance inputs, not measured runtime performance. Performance may propose a justified revision in this
owner document before dependent work; a lower arbitrary cap must not silently remove an accepted scenario.

| Dimension                         | Launch bound                                                                                         |
| --------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Canonical body                    | Existing Content maximum, 2 MiB per document revision                                                |
| Primary containment depth         | 32 placements below notebook root                                                                    |
| Ordinary list page                | 50 items plus one lookahead                                                                          |
| References in one revision        | 64 distinct managed references, including at most 16 about-Subject associations                      |
| Reference resolution per response | 64 distinct targets; nested target expansion is zero                                                 |
| Body loading                      | One full body; referenced previews load separately, at most 8 excerpts of 4 KiB in a preview request |
| Public subject contributions      | 20 results; at most 128 examined association candidates per foreground step                          |
| Structure mutation                | One source/destination placement pair; at most two depth-32 ancestor paths                           |
| Cleanup/preparation               | At most 100 local rows or 128 publication candidates per retained step, respectively                 |

Let N be indexed population, B the selected body bytes, P a page limit, H the depth cap, R selected references and
W a retained-step limit. Page reads seek a full route/owner/parent or subject key and cost O(log N + P) for the local
index, plus the explicitly bounded native checks. Saving/validating a whole snapshot costs O(B + R), so the 2 MiB cap
does not make large-document writes constant-time. Structure mutations use O(H) indexed ancestor/height operations,
O(H log N) index work, and no subtree scan. A retained job may have O(total input) total work, with O(W) rows per step.
Cross-home target reads require at most R full-key probes, grouped per database as architecture requires; their
latency is not equivalent to one local join. Count bytes, validation, media claims, Access, history, events and
cleanup as well as returned rows.

Lifecycle checks contribute up to H ancestor points for each distinct document. A document read adds O(H); a
50-document list may add 50H; the 128-candidate public listing may add 128H, or 4,096 ancestor points before
deduplication. Resolving R document targets may add RH. These are ceilings to measure, not a low-latency guarantee.
Do not load their bodies during metadata listing. If this cost misses the measured latency target, adopt an
owner-maintained lifecycle access path with a proved invalidation bound or reduce foreground work with retained
preparation. A cache of ancestor permissions or a stale subtree flag is not equivalent.

Required access paths include notebook primary children `(route, notebook, parent, order, placement)`, height maximum
`(route, notebook, parent, height DESC, placement)`, documents/revisions by full routed key, owner attachments
`(owner route, owner, original subject, notebook, document)`, normalized-title prefix and recent-document directories,
source-owned revision references, and subject publication associations. Index maintenance and erasure locators are
part of each writer's bounded command/effect design. At launch the owner attachment directory is maintained in the
same account-home transaction as the document/reference change. Its reads still validate source lifecycle. Later
cross-home team discovery needs an explicit derived-source currentness contract; it is not another document authority.

Do not claim all arbitrary formulas/relations, immediate exact global results, immediate revocation and constant
small work simultaneously. Aggregation over m unmaterialized related records needs work following m. Eagerly updating
f distinct dependent outputs requires work following f. Moving that work to incremental maintenance or a job changes
where and when it is paid; it does not remove it.

## Release priorities

| Stage                              | Required outcomes                                                                                                                                                                                                                                                                                                                                                                                | Reason for this boundary                                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| First public release               | Private notebooks; nested/reordered documents; public Subject attachments; same-page public/private composition; exact/live references; text-based problem/definition/theorem reuse; one-document copy/export; explicit revision publication/update/withdrawal; subject public contribution discovery; history/conflict recovery; deletion/erasure/moderation; accessibility and growth evidence | Completes the distinctive shared-subject/private-authoring/public-reuse loop                                   |
| Next version: structured knowledge | Notebook-local schema definitions and records; typed fields; table/list/board views; indexed filters and grouping; safe inline/display math; mathematical profiles; owner full-text search; reference-place navigation and richer backlink views                                                                                                                                                 | Adds Notion-style databases and fluent mathematical learning without changing existing identities or citations |
| Following version: shared work     | Realm-backed notebook authority; explicit collaborators and role policies; incremental edits and realtime/offline collaboration; reusable synced content; multi-document publication manifests; import and bulk transfer                                                                                                                                                                         | Requires synchronization, authority-boundary and lifecycle proofs beyond single-author snapshots               |
| Later, evidence-driven             | Restricted formulas and rollups with bounded plans; dependency-driven recomputation; learner paths; formal proof adapters; semantic/AI-assisted linking; large-scale cross-workspace search                                                                                                                                                                                                      | No correctness, completeness or constant-cost claims before execution and provenance contracts exist           |

First release may use source text or code blocks for mathematical expressions. They must survive round-trip and
export losslessly, and the UI must describe them as source text. Rich math rendering is not simulated by losing
LaTeX, silently interpreting dollar signs, or pretending an opaque component is an implemented math editor.

Local schemas in the next version use notebook-scoped stable field IDs and immutable schema revisions. Cross-notebook reuse selects an explicit schema reference or creates an independently identified copy; it never merges namespaces by matching labels. User labels
are not field identity. Missing, explicit null and unknown remain distinct. Type changes need declared conversion,
retained old interpretation and bounded migration. Definition validation and filter meaning are shared; publication
of a private schema into public vocabulary is separate and explicit. Current Context relation extensions are
insufficient for this capability; extending their unrelated format by optional fields is not the design.

Computed fields are deferred independently of typed fields. A future formula language must state finite operations,
dependency tracking, cycles, null/unknown/error semantics, numeric precision/units, query materialization, update
fanout and disclosure behavior. A formula result cannot launder an unreadable input into a visible aggregate.

## Research adoption

The evidence and alternatives are recorded in the independent [model investigation](research/knowledge-workspaces-model-astra.md)
and [product investigation](research/knowledge-workspaces-product-astra.md). This document adopts shared subject
identity plus separately owned authored documents, explicit publication, exact references, viewer-aware composition
and bounded navigation. It chooses the writer/public-reuse loop for launch and defers full database, collaboration
and computational parity. The source code and native proof gaps in those reports remain implementation work.

The architectural extension is an authored knowledge capability over existing owners. It does not adopt a separate
graph database, another permissions framework, a workspace-wide CRDT, automatic recursive publication or private
facts in public search. Cross-domain APIs are installed through existing module contracts and composition roots.
