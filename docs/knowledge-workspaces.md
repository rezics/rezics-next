# Knowledge workspaces

Owner: Content coordinates this capability across Semantic, Accounts, Web, Search and Performance. This document
owns its product model and release priorities. [Acceptance](knowledge-workspaces-acceptance.md) owns scenario and
growth evidence; the [Goal](goals/knowledge-workspaces.md) is the implementation handoff. These are required
outcomes, not a claim of existing implementation. Existing module contracts remain authoritative for their primitives.

## Product decision

People organize private work around shared subjects, reuse precisely identified knowledge, and deliberately publish
selected work back into the public knowledge network. The public subject keeps independent identity across
authors, notebooks, communities and presentations; a private notebook is one consumer.

Launch completes the writer journey: from a Character subject, create an owned notebook with Inspiration, Character
arc and Scene notes; nest/reorder, reference public material and publish one analysis while other notes/drafts stay
private. An anonymous reader discovers it from the subject and reuses an exact citation; its author sees public and
own material in one visit.

The mathematical learning journey guides the reusable model: a problem refers to particular theorem statements and
definitions, with explanations of how they are used. References let a reader open prerequisites without copying an
entire knowledge base. A link is an authored claim of use, not machine verification of a proof. Mathematical notation
and specialist vocabulary have a later release gate; the structural journey must already work with ordinary text.

Notion-like organization is a direction, not launch parity. New domains configure shared capabilities; add behavior
only for a concrete missing outcome.

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

Decision: reload navigation pages owned notebooks through the owner index and immediate outline children through the
parent/order index. The first outline page selects the current structure revision; its encrypted continuation binds
the owner, notebook, parent and selection, and returns `409 stale_cursor` after a structure change. Each outline
request examines at most 128 indexed candidates and advances past sparse ineligible rows.

Decision: Web reopens owned notebooks at `/knowledge` and immediate outline children at
`/knowledge/notebooks/$notebookId`. Each active reader replaces one native page of at most 20 rows;
opening an exact notebook reads root. Root omits `parentPlacementId`, child reads use placement identity,
and opaque cursors preserve native order and sparse continuation. Open document resumes the existing private
editor; Explore children is separate because the DTO supplies no child count. Retain only visited breadcrumbs
(up to 32), with no inferred ancestry after reload. No tree download, refill, prefetch or row-level document reads.
A retry repeats its attempted cursor; a stale or changed structure requires explicit parent restart without cursor.
Editor return retains a single in-memory frontier for at most 15 minutes, then re-admits that exact
notebook/parent/page before displaying rows; expired returns require explicit restart. Session, CSRF, exposure,
locale, address and source replacement retire private rows and callbacks. These readings never enter SSR,
shared query caches, persistent storage or URL payloads. Native/browser/visual acceptance uses the seeded integration lane.

Decision: Private document history stays inline in the retained editor. One explicit history request reads one
replacing native page with `limit=20`, preserving order and opaque continuation; retry repeats the attempted cursor
and restart explicitly clears it. Empty with continuation remains sparse, not exhausted. Selection retains two
exact revision IDs across pages; explicit comparison reads one oriented `leftRevisionId`/`rightRevisionId` pair and
holds at most those two saved bodies. Canonical source is retained losslessly; the existing Document renderer
shows each side with block-identity difference labels and supplied references, without target hydration. Native
response admission rejects mismatched document/revision identities, digests and oversized metadata pages.
Conflict review can compare the saved base with the explicitly observed current head beside the retained local
writing, which is never labeled a saved revision. Reading changes neither publication selection nor save basis.
The existing adopt-current-head action admits that basis, followed by deliberate Save; uncertain retries keep their
original intent, key and sealed credential. Session, CSRF, exposure, locale, document and source retirement discard
history, selections, callbacks and late work. No history/body enters public SSR, shared caches, URLs or persistence.
Consumer work is O(P + B + R), for P ≤ 20 metadata rows, two bodies of at most 2 MiB each and at most 64 supplied
references per body; block comparison uses a linear identity map, not edit-distance alignment. Content owns native
query and authorization cost. Five History stories illustrate these states; native two-editor/history, accessibility and visual proof remain required.

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

Decision: `GET /v1/subjects/:id/knowledgeDocuments` (`knowledge_document.discover`) supplies the native
Subject candidate page under `gate:search`. Search indexes only explicit current publication identities through
Content's native publication effect, with existing selected publications seeded at installation. Publication time
(descending), document ID and publication ID fix ordering. A committed per-Subject receiving cut fixes membership
for the visit. Post-cut rows spend the same bounded scan budget and are omitted; there is no SQL filter that can
scan an unbounded newer population. This is coverage of the indexed association cut, not all native publications.

Each step examines at most 128 candidates, retaining only nomination identities and its frontier until 20 permitted
rows or exhaustion. Sparse steps return `202` and a confidential Search continuation bound to viewer, Subject and
limit. No short successful intermediate page or total is returned. Prepared candidates are checked again through
Content's metadata-only exact-current-publication seam and anonymous Subject authority on every continuation and
before disclosure. Withdrawal/replacement closes an old row while receiving is paused. Missing source/index
installation is unavailable; changed, expired or concurrently consumed progress restarts explicitly. Retention is
15 minutes from initial capture, at most 256 active preparations per Subject; expiry cleanup is bounded to 100 rows
per new retained chain. The index/preparation retain no body, account locator, private ancestry or permission result.

At account-erasure time, private notebook structure, attachments, heads, unselected revisions and owner links are
erased. An eligible current publication retains only its selected immutable revision and permitted public fields as
a de-identified contribution, without its notebook ancestor chain or account identity. The existing publication
record remains the source; no second publication store or writer is introduced. A publication already withdrawn at
the erasure fence has no retained public selection. Moderation and later source withdrawal continue to govern the
retained contribution.

Decision: Knowledge create, revise, select and withdrawal commands commit registered domain events with native
receipts; event data carries resource and revision identities only, and withdrawal without a current selection is a
receipted no-effect command.

Decision: Knowledge route metadata comes from the public Content adapter; imported schemas are memoized when routes mount.

Decision: Web’s first public consumer is the localized `/knowledge/documents/$id` reader, with optional `revisionId`, over `knowledge_document.public_read`. Live and exact addresses stay distinct; null `authorId` is deidentified attribution; the primary Subject link uses the supplied id without a label lookup. Acceptance includes live/exact states, malformed HTTP, one-read/no-store, retry, replacement and copy feedback.

Decision: Web creates a private notebook only after the writer reviews and submits its title, then holds the acknowledged notebook receipt separately while creating a root document. Private bodies, drafts, command intents and receipts live only in the current page visit; exact private heads are read directly by the prepared viewer and revision writes compare against that observed head.

Decision: Web reviews only a captured saved current head before explicit single-document publication or update;
withdrawal reviews the observed current publication identity. Confirmation freezes the document, expected head,
expected publication, selected revision and prepared-session credential with one idempotency key. A changed private
observation retires confirmation; conflict requires reread and fresh review while retaining the draft. Uncertain
commands permit explicit exact replay only, and a matching read never acknowledges them. Native receipts, private
current-head readback and independently admitted public reading remain separate. Acknowledged live and exact links
retain the selected revision through later private saves and retire on withdrawal or changed publication identity.
Acceptance retains publish A, save B privately, update B, withdrawal, conflict, immutable replay and visit retirement.

Decision: Web pins the first-public Knowledge loop with one native mounted witness through the existing private,
publication, public reader and reuse pages. Content native first-loop and focused Web tests remain the source
owners. Invoke `bun apps/web/scripts/check.ts --host tests/native/knowledge-journey.host.test.ts` after
integration.

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
Creating a document defaults to private. Templates supply editable starting titles and structure; Inspiration,
Character arc and Scene are templates, not privileged database fields or new backend branches. An owner continues an
existing notebook from the private creation visit: explicit inventory selection retains the native notebook row, one
Open/More/Retry reads one replacing outline page at root or a chosen parent, and at most 32 visited breadcrumbs are
kept without reconstructing ancestry. Creation sends the observed structure revision and an explicit parent placement.
Move and reorder use the existing Content commands through the owned notebook organization consumer below.
Typed readers and React components use distinct basenames for unique compiled JavaScript output.

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

Decision: exact availability maps each document, lifecycle generation and revision to its immutable publication record; migration seeds only live pointers, publication updates append within a generation, and withdrawal advances the generation atomically.

Two authors may publish different analyses of the same character. They coexist with provenance; neither overwrites
the catalogue's selected facts. Public contributions may enter the ordinary Semantic editorial workflow; publication adopts no catalogue truth.

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

Decision: The Web editor retains each admitted reference manifest beside its compatible body and freezes both in
create/revise intents, including exact uncertain retries. Inline reference editing requires explicit Apply or Cancel;
body/manifest inconsistencies require explicit component restoration, unavailable-entry retention, duplicate removal,
or source-anchor detachment before Save. Existing source block IDs stay stable. Literal labels remain authored
component fallback text. Reference review distinguishes Subject, live document and exact revision/digest/block;
selected inspection uses one native public read or an explicitly addressed authorized private read, with no fallback
between them. Public rendering uses only the native source disclosure manifest. Consumer cost is O(B + R), with
manifest64/selected1: at most 64 source entries and one retained inspected target body, no background target reads
or recursive expansion. Three Reference stories illustrate this behavior; native save/reopen/publish/exact-read and browser/visual proof remain required.

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

Decision: native export uses canonical JSON only; Document currently provides Markdown import but no permitted
Markdown exporter. Owner export requires an explicit revision ID; public export and copy use the same current
publication disclosure as the public reader, even for the author. Copy requests pin an exact revision and use the
destination notebook's existing account authority, structure CAS and receipt transaction. The versioned reference
component is `rezics.knowledge.reference` version `1`, with only `{referenceId}` in its opaque payload; the revision
stores the finite-role typed manifest separately. Missing targets become unavailable markers without target IDs.
Block IDs, component IDs, reference IDs, manifest source anchors and local `#block` links are regenerated on copy;
external exact locators and unrelated opaque payloads are preserved. Provenance retains the original permitted
source selection, and public output withholds authoring-origin provenance. Knowledge has no media claim destination;
public media nodes become unavailable markers and copy creates no media claims. Managed media and lifecycle
acceptance remain with their owner integrations before opening the capability.

The export digest is SHA-256 over RFC 8785 JSON of all envelope fields except `sha256`; `selection.sha256` hashes
only the selected representation's canonical Document bytes. Both can be checked independently of storage. There
is no timestamp or generated export identity to make repeated exports differ. `references` on create/revise is
optional for existing clients; when supplied it is limited to 64 entries and must match the registered components
one to one. Each entry has a local ID, finite role, optional source block and a subject, live document or exact
revision/digest/optional-block target; `null` retains an unavailable citation. Target disclosure performs bounded
metadata-only one-hop checks, never fetches target bodies and never follows their outgoing references. A stored
block-ID projection derived from canonical Document child nodes checks exact block selections; a missing block is
unavailable and never falls back to a nearby block.

Decision: Web transfer pins the admitted public or saved authoring revision. An unsaved editor must save first;
public actions retain the public representation even for the author. Export captures the native canonical JSON
response unchanged, keeps bytes and a revocable download URL only in this visit, and distinguishes another local
save from a fresh admitted export. Private copy reviews one owned notebook and a current root/parent outline;
each explicit request replaces at most 20 rows in native order. A structure conflict keeps the choices but needs
refresh, review and confirmation. An unknown result keeps the exact source, destination, key and prepared
credential for explicit replay. A separate exact copied-revision readback precedes editor resume. Source loss,
session/CSRF/exposure replacement, locale/address change and departure retire callbacks, selections and bytes.
Illustrative Transfer stories cover the six named states.

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

Trash, restoration, erasure, legal holds, moderation and account termination follow [Deletion](deletion.md).
Decision: trash commits the selected root fence synchronously, so shared ancestor eligibility immediately conceals
all primary descendants while references and unrelated branches remain intact. Leaf restore stays synchronous;
nonleaf restore keeps the root trashed while Content Work advances a durable placement-keyset frontier, retires each
live descendant's lifecycle/publication generation in bounded commands, skips independently trashed roots, and opens
the root privately only in the final command. The owner lifecycle read recovers processed/pending counts without
document content. Restore never republishes; publication selection remains explicit.

`POST /v1/knowledge/documents/{id}:trash` and `:restore` require current owner `account:update`,
`expectedStructureRevisionId` and exact decimal `expectedGeneration`. Both use native receipts. Notebook structure
locking orders moves, insertions and lifecycle changes; current ownership, retained data and ancestor eligibility
are checked before receipt replay. The owner-only document `/lifecycle` address returns IDs, structure/generation, state and restore deadline, never
bytes or titles. Restore requires trash within 30 days and no purge start. Legal holds do not extend that deadline.
Transitions advance generation and clear publication. Identity and private revisions survive; republication is
explicit and creates a fresh publication.

Shared eligibility checks at most 32 primary placements, rejecting hidden/purging ancestors and incomplete chains.
It fences private/history/compare, current/historical outlines, public selection, lagged discovery, copy/export and
writers. Moves cannot bypass trash; historical pages advance over hidden candidates without exposing titles or locators.
The restore frontier persists its child keyset cursor and discovered primary placements, so a restarted worker resumes
without rediscovering the tree. Existing notebook locks and current eligibility fence subtree edits, insertion and
moves while the root is hidden; unrelated branches remain writable. Independently trashed nested roots remain hidden.
Purge/expiry must share those fences, preserve holds and use the erasure disposition below.

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
Save bounded whole-document snapshots with debounced autosave, local draft retention and acknowledged Save/navigation.
Stale revisions preserve drafts for comparison. CAS is not coediting; a later CRDT adapter needs authority, compaction,
reconnect, schema migration and erasure proof. Published snapshots stay exact.

### Shared versioned outline primitive

Implementation decision: the shared core uses stable-ID implicit AVL nodes with `treeParentId` distinct from
containment, bigint count/chapter aggregates, root-checked rank/select, and one selected-snapshot/read-set plus
transaction write overlay for split, arbitrary-height join, splice and range move.

Decision: share an owner-neutral **versioned ordered forest** with linear generations: stable placement handles,
containment, balanced sibling/preorder/chapter sequences, generation/as-of node and occurrence lookup, current
membership proof, and head CAS. Book and Knowledge keep distinct storage adapters, tables, permissions, publication
and lifecycle. Book owns [point and staged publication](../services/kernel/src/content/hosted-chapters.md#book-publication-contract).
`10cec8a9ed` delivered keyed copy-on-write balancing only in
[`versioned-outline-order.ts`](../services/kernel/src/content/versioned-outline-order.ts); it does not implement
rank/select, split/join, as-of occurrence lookup, chapter indexes or membership proof. No total placement, sibling,
chapter or publication-selection count defines supported structure. The installed 512-row request bounds remain
compatibility bounds. This decision names the shared port and initial adapter; it changes no installed route, schema
or production setting.

A generation is one forward-only sequence of committed snapshots. Draft and publication are independent generations.
A snapshot names generation, sequence and the sibling, preorder and chapter-only roots. Facts contain membership,
containment parent, owner value reference and subtree size. Sequence-tree parent links are distinct from containment.
Identity bindings survive removal. Historical lookup seeks the last node/occurrence row at `sequence <= snapshot`
through a complete equality prefix, then proves membership by walking inverse sequence parents to the selected root;
it never replays an unbounded history chain or a per-edit full copy. An old whole-tree root is readable; continuing
writes on it in the same generation is unsupported and starts a new generation. Commit changed node versions, roots,
head CAS, receipt and identity-only event in one owner transaction. Versions freeze structure, not permission.

The structural port is `point(snapshot,id)`, `children(snapshot,parent,cursor,limit,direction)`,
`outline(snapshot,cursor,limit)`, `projected(snapshot,origin,direction,cursor,limit)` for chapter-only pages,
`rank(snapshot,index,id)`, `select(snapshot,index,rank)`, `insert(expectedHead,freshId,parent,before)`,
`move(expectedHead,id,parent,before)` and `remove(expectedHead,id)`. `apply` computes the local split/join/rotation
write set; owners authorize and CAS. `before` is a stable sibling handle; null means end. Resolve source, destination
and anchor against the same snapshot, excluding source from neighbors. Reject self, missing, foreign and wrong-parent
anchors. Never reinterpret a stale rank or deleted handle as end. Same-position movement is a no-effect; cross-forest
transfer is a separate operation. `point` and `children` fail closed unless membership to the selected root is proved;
a residual sibling root must not disclose a detached subtree.

Choose **stable handles and count/rank/select**, not persisted numeric ranks or global key relabel. Insert, remove,
reorder and subtree cut/splice change O(log N) sequence nodes plus O(H) containment ancestors, without relabeling
unaffected siblings or rewriting descendants. Book chapter-count summaries skip empty parts. Dense Book
position/preorder and Knowledge decimal position are compatibility projections, never mutation addresses.

Knowledge's current `(numeric(38,0) position, placementId)` comparator and 64-neighbor/side repair remain a keyed
compatibility adapter. 130 consecutive integer keys around a middle gap can exhaust its repair window; that bound is
a step budget, not a permanent total capacity. Do not copy Knowledge's notebook/document columns into a shared schema.

Serialize structural writers and lifecycle fences on one forest head. Under that lock check owner admission,
complete source/destination ancestor paths, self-parent/cycles and destination depth plus exact moved height.
Update exact height/size/chapter summaries only along those paths, using indexed child maxima/sequence aggregates.
Keep Book depth 16 and Knowledge's 31 ancestors/32 placements as per-operation resource bounds, not total counts.
References may cycle. Opposite moves against one head have at most one winner. Current admission precedes receipt
replay; authorized replay precedes head CAS and returns the original immutable result.

### Historical reads and implementation boundary

Historical point selects placement facts plus its member-ancestor chain: detaching a root hides its descendants
in that version without touching each descendant. Children seek the selected parent's sequence root. Cursors bind
owner/forest, version, representation/generation, parent/mode/direction, traversal frontier, viewer/session and
partition epoch with owner expiry. Concealed raw candidates advance the frontier. Keep Knowledge current-outline
`409 stale_cursor`; historical membership/order is exact but titles use currently eligible working values.
Book freezes selected titles/target revision/digest and uses current disclosure, never current-head bytes.

A preorder cursor retains the per-level AVL traversal stacks, bounded by H times tree height; it does not reseek
from the root for every emitted row. Chapter summaries select previous/next without scanning
empty parts; parts remain origins and unavailable chapters consume slots. Stack traversal and rank/select derive
legacy ordinal views without materializing a whole outline. Keep Book page 20/no refill and Knowledge's own page/
scan bounds. Metadata paths read zero bodies; exact opening remains each owner's native byte/digest reader.

[`versioned-outline-order.ts`](../services/kernel/src/content/versioned-outline-order.ts) supplies keyed copy-on-write
AVL insert/remove and bounded seek behind node/value/summary ports. Count/rank/select, split/join, generation/as-of
lookup, sibling/preorder/chapter indexes and membership proof are additional port operations, not that extract.
[`knowledge-order.ts`](../services/kernel/src/content/knowledge-order.ts) keeps the keyed native adapter.
[`knowledge-commands.ts`](../services/kernel/src/content/knowledge-commands.ts) supplies head locking, stable anchors,
ancestor/cycle checks and exact heights. Its parent-root predecessor rows and
[`knowledge-reads.ts`](../services/kernel/src/content/knowledge-reads.ts) prove historical children, not historical
placement-ID lookup, sequence handle lookup or Book preorder/chapter navigation. Those are new access paths.
Knowledge still publishes individual documents; Book release membership never becomes Knowledge policy.

### Cost, storage choice and retention

Let N be placements, S sibling width, H bounded owner depth, P raw page size and T retained edits. Count **logical
probes** (node/occurrence/membership visits) separately from **physical SQL/I/O**. Logical point membership is
O(log N) sequence probes plus the containment path; children are O(log S + P); preorder and chapter navigation are
O(log N + P) once the cursor carries the traversal stack. Native disclosure adds per-raw-candidate checks, never body
loads. A move or point publish copies O(log N) sibling, preorder and chapter index nodes plus O(H) containment facts.
H is bounded independently of N. A million-descendant move has the leaf move's bound at equal ancestor paths and
sibling widths: no descendant rewrite, global key relabel, history-chain replay or per-edit full copy.

A hot gap costs the same O(log S) path/rotation changes on every insertion; there is no spacing generation to scan.
T edits retain O(N + T (log N + H)) logical node versions. Whole input/release build costs O(N log N) with incremental
insertion (or O(N) with an ordered builder), in bounded resumable steps. Never rescan the committed prefix on resume
or rebuild the full selection on every batch. Structural withdrawal changes one pointer; reclamation costs O(retained
storage) total in bounded steps. Finite address/counter widths, bytes, deadlines, depth and page/batch limits are
architectural resources, not a business count cap. There is no permanent total structure cap.

Decision: the initial persistence adapter is **row-per-node PostgreSQL temporal storage**, hidden behind the sequence
port: `(owner, generation, index, nodeId, sequence DESC)` for as-of node lookup and the matching occurrence-state
index. One logical probe is one historical B-tree seek; if history rows are V, conservative physical work is
O((logical probes) · log_B V), plus WAL and round trips. Do not treat O(log N + P) logical as already-proved
O(log_B N + P/B) I/O. A later **fixed-page** adapter may replace the row layout only after native evidence on the
same 1k/10k/100k fixtures (hot-gap inserts, large unchanged subtree moves, historical point/children/preorder/
chapter pages, complete Book publish/withdrawal, interrupted batches and reclamation) recording buffers, EXPLAIN
rows/loops, WAL and retained bytes. Predecessor-history versus radix-directory comparison is not the remaining
choice. Algorithm, point-publication and durable-preparation work start against the port; staged Book activation
still waits for the owner proofs in the Book contract.

The independent [model](research/knowledge-workspaces-model-astra.md#physical-model-and-operation-costs) supports
stable identities, serialized moves and bounded sequence maintenance; the [audit](research/universal-scalability-audit.md)
and [follow-up](research/universal-scalability-follow-up.md#adopted-boundaries) separate total coverage from paging
and reject whole-snapshot costs as the serial path. They remain the prior independent evidence; this decision supplies
the missing generation/as-of, three-index and physical-accounting contract.

Removal tombstones membership/detaches one root; targets and old exact membership survive under current lifecycle.
Book withdrawal does not erase retained releases; Knowledge restore never republishes. Erasure/moderation governs
old disclosure. Transactional holds cover heads, exact revisions/receipts/releases, preparation/migration roots,
unexpired cursors and legal holds. Bounded durable mark/sweep fences new holds and includes abandoned/rotation nodes;
retire reader holds before sweep. Opaque value references let owners redact private payloads separately from shared
structural nodes. Book's [sealed-prefix lifecycle](../services/kernel/src/content/hosted-append-lifecycle.md) still
protects old bases/prefixes; Knowledge's [lifecycle](#access-and-lifecycle) owns trash/restore/erasure.

### Owned notebook organization consumer

Decision: the existing notebook route offers explicit source selection, lazy destination-parent browsing, and a
before-sibling/end review from observed placement identities. One native structure revision binds both observations;
labels and order keys confer no authority. Native Content resolves cycles, depth and order maintenance. A conflict
preserves the prior choice for comparison, requires fresh source and destination selection, and creates a new command
only on deliberate review. An uncertain retry retains the exact operands, key and captured credential. The native
receipt remains visible while a separate explicit fresh outline establishes current placement. Document IDs and
existing editor/exact addresses survive movement; organization reads no bodies and changes no publication.

History uses one explicit twenty-row native history page and one selected-revision/parent historical outline page.
Unavailable history is labelled, never rendered as an empty historical tree. Historical rows cannot select a move;
returning to current root or the prior current parent admits a fresh reading first. More and Retry replace one page,
retain opaque continuation and retry the attempted cursor; stale traversal offers an explicit parent restart.
Session, account, CSRF, exposure, source, locale and address replacement retire pages, choices, late work and focus.

Consumer cost: **Touches** one generated read per Open/More/Retry/history selection or one move per confirmation/retry,
with the existing private-session preparation for a new review. **Bound** one twenty-row page, at most 32 visited
breadcrumbs, one selected source and one sealed intent/receipt; history changes retain the native 129-per-revision
ceiling. **Growth** O(page + depth) retained data, no tree scans, prefetch, refill, body reads or per-row hydration.
Content owns native mutation/history costs; consumer bounds do not claim native cost proof.

### Public contribution discovery consumer

Decision: a readable Subject mounts one named Knowledge contribution region. The first page loads on that default
mount; each later More, preparation Continue, Retry or Restart is explicit. One generated
`subjects({id}).knowledgeDocuments.get` call carries `limit=20` and the attempted opaque cursor, replacing one
retained page. Ready-empty, sparse ready continuation, preparing-202 with its native frontier, denial, unavailable
and restart-required 409 stay distinct. Preparation continuation is a deliberate Continue, never polling or refill.
Operational retry repeats the failed cursor; explicit restart omits it. Rows keep native order, titles and exact
revision destinations, with no per-row body, author, permission or Subject hydration. Missing author identity is not
invented. Public destinations reauthorize at the installed live/exact reader and never receive a private ancestor
path from this list. Return carries only a bounded same-origin Subject visit path, then the Subject remount rereads
current admission. Subject, viewer/session/CSRF, locale, source or access replacement retires rows, cursors and late
work. Missing discovery stays in this region and does not break the rest of the Subject. Personal notebooks keep
their independent entry.

Consumer cost: **Touches** one generated public page per default mount, More, Continue, Retry or Restart, through
the existing Web transport. **Bound** one twenty-row page, one opaque cursor and one bounded same-origin return
path; no bodies, totals or private notebook paths. **Growth** O(page) retained public rows, no prefetch, refill,
per-row hydration or private inventory. Search owns native physical proof; these bounds do not claim it.

Discovery wire/mounted acceptance retains native order, exact links/return, one-request bounds, sparse/preparing
continuation, identical retry/restart and late-result retirement. Stories: populated, preparing, sparse, empty and
unavailable. Native/browser/visual proof remains separate.

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

These design limits remain here until native owners adopt them. They require measurement; Performance may propose
revisions here, but an arbitrary lower cap must not remove accepted scenarios.

| Dimension                         | Launch bound                                                                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Canonical body                    | Existing Content maximum, 2 MiB per document revision                                                                                 |
| Primary containment depth         | 32 placements below notebook root                                                                                                     |
| Ordinary list page                | 50 items plus one lookahead                                                                                                           |
| References in one revision        | 64 distinct managed references, including at most 16 about-Subject associations                                                       |
| Reference resolution per response | 64 distinct targets; nested target expansion is zero                                                                                  |
| Body loading                      | One working/read body; explicit saved-revision comparison reads two; referenced previews load separately, at most 8 excerpts of 4 KiB |
| Public subject contributions      | 20 results; at most 128 examined association candidates per foreground step                                                           |
| Structure mutation                | One source/destination placement pair; at most two depth-32 ancestor paths                                                            |
| Cleanup/preparation               | At most 100 local rows or 128 publication candidates per retained step, respectively                                                  |

Local pages seek full route/owner/parent or Subject keys: O(log N+P) plus native checks. Saves validate O(B+R)
body/reference work; retained steps bound rows by W, not total job size. The shared [outline cost](#cost-storage-choice-and-retention)
includes versioned indexes, summaries and repair; no subtree scan is permitted. Cross-home references use at most
R full-key probes grouped per database, not one imaginary local join. Charge bytes, validation, media claims, Access,
history, events and cleanup.

Current lifecycle adds up to H ancestor points per document: 50H for a 50-row list, 128H (4,096) for public candidates,
and RH for references before deduplication. Metadata loads no bodies. Measure these ceilings; if too slow, adopt an
owner-maintained lifecycle index with proved invalidation or retained preparation, never cached ancestor permission.
Required indexes: `(route,notebook,parent,order,placement)`, child height maximum, routed document/revision keys,
owner/original-Subject/notebook/document attachments, normalized-title prefix, recent documents, revision references
and public associations. Maintain indexes/erasure locators with each writer. Owner attachments commit in the same
account-home transaction and still check source lifecycle. Later cross-home discovery needs a derived-source
currentness contract. Aggregates and dependent output updates pay for their input/fanout under
[architecture's bounded-work rule](architecture.md); jobs relocate that cost rather than remove it.

## Release priorities

| Stage                              | Required outcomes                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| First public release               | Private notebooks; nested/reordered documents; public Subject attachments; same-page public/private composition; exact/live references; text-based problem/definition/theorem reuse; one-document copy/export; explicit revision publication/update/withdrawal; subject public contribution discovery; history/conflict recovery; deletion/erasure/moderation; accessibility and growth evidence |
| Next version: structured knowledge | Notebook-local schema definitions and records; typed fields; table/list/board views; indexed filters and grouping; safe inline/display math; mathematical profiles; owner full-text search; reference-place navigation and richer backlink views                                                                                                                                                 |
| Following version: shared work     | Realm-backed notebook authority; explicit collaborators and role policies; incremental edits and realtime/offline collaboration; reusable synced content; multi-document publication manifests; import and bulk transfer                                                                                                                                                                         |
| Later, evidence-driven             | Restricted formulas and rollups with bounded plans; dependency-driven recomputation; learner paths; formal proof adapters; semantic/AI-assisted linking; large-scale cross-workspace search                                                                                                                                                                                                      |

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

The independent [model](research/knowledge-workspaces-model-astra.md) and
[product](research/knowledge-workspaces-product-astra.md) investigations support separately owned authored documents,
explicit publication, exact references, viewer-aware composition and bounded navigation. Adopt the writer/public-reuse
loop; database, collaboration and computation parity remain deferred. Cross-domain APIs use existing module contracts
and composition roots, without a separate graph database, permissions engine, workspace CRDT, recursive publication
or private search inputs. Their native proof gaps remain implementation work.

Decision: ordered structure uses generation/as-of indexes, stable handles, rank/select and split/join behind a
row-per-node temporal port, with distinct Book and Knowledge adapters. Book exact-source consent and staged
activation-currentness stay in the [Book publication contract](../services/kernel/src/content/hosted-chapters.md#book-publication-contract).
