# Knowledge workspace delivery and acceptance

Owner: Content coordinates acceptance; each capability owner supplies native evidence. The
[product contract](knowledge-workspaces.md) owns model, limits and release priorities. This document owns the
cross-surface scenarios, implementation sequence and proof obligations. It adds no current runtime pass claims.

## Capability baseline

| Capability                                | Existing specification                                        | Backend evidence inspected                                                                                        | Interface evidence inspected                     | Acceptance still required                                                                                 |
| ----------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Canonical document snapshots              | Document profiles, block IDs, exact revision addressing       | `packages/document` and Content validator; 2 MiB canonical body ceiling                                           | Existing rich-text editor and renderers          | New document resource round-trip, private persistence, selected publication and exact-reference journey   |
| Subject identity and editorial statements | Semantic definitions, Context and original/canonical mappings | Semantic subject and relation modules                                                                             | Subject pages and catalogue editor               | Private attachments around the same public identity, merge/unmerge without document or structure mutation |
| Private knowledge resources               | Product contract adopted for this capability                  | Existing authored fields require subject/candidate binding; posts/reviews are not independent knowledge documents | No new notebook journey demonstrated             | Native notebook/document authority, revisions, indexes and ordinary generated API                         |
| Ordered nested documents                  | Product contract adopted for this capability                  | Collection occurrences are precedent, not a notebook implementation                                               | No integrated primary outline demonstrated       | Atomic moves, bounded height/order maintenance, keyboard navigation and subtree lifecycle                 |
| Public/private composition                | Existing Access plus this audience contract                   | Existing per-resource checks and page preparation                                                                 | Existing subject composition is a host           | Same-endpoint or coordinated reads under exact viewer, anonymous preview and cache isolation              |
| Public association discovery              | Existing filtered-list and source contracts                   | No accepted new knowledge-publication Source                                                                      | No accepted new contribution list                | Native source publication, delayed index removal, sparse useful pages, retained completion                |
| Local database/schema                     | Later-version requirement                                     | Context custom relation terms only                                                                                | Catalogue editor is not a local database builder | Scalar types, stable fields, schema migration, filter/index admission and views                           |
| Rich math/collaboration                   | Later-version requirements                                    | Snapshot/block format is a foundation                                                                             | No math/coediting completeness asserted          | Renderer/source fidelity, security/accessibility; separately CRDT/sync/erasure proof                      |

Existing files and unit tests establish implementation seams, not a passing end-to-end knowledge feature. Record
specified, backend implemented, interface exposed, native tested, browser tested and promoted revision separately
when work lands. No mock, screenshot, typecheck or successful enqueue alone advances all these states.

## First-release scenarios

Use ordinary API writes, generated clients and real Access identities. The personas are author A, unrelated signed-in
reader B, anonymous reader, and a moderator with the exact required grant. A suspended/revoked A is a separate state.
Each scenario includes native API observations first, then the browser where user interaction matters.

### Shared Character and private writing

1. A opens an existing public Character and creates a notebook with private Inspiration, Character arc and Scene
   notes. Arc contains two ordered subdocuments. A returns to the Character and finds their work alongside public
   facts; a direct document visit returns the same saved content. Another document can refer to a second subject.
2. B creates their own notes about the same Character. Neither author sees the other's private document metadata,
   attachment count, last-edit time, cursors, media or existence. Anonymous public output is unchanged after adding
   large numbers of never-published attachments to either owner.
3. A can rename, nest and reorder using keyboard controls and a narrow viewport. Stable links survive these edits.
   Opening one branch does not preload all siblings, descendants or referenced bodies. The empty notebook explains
   how to create content; a read failure preserves useful public information and offers a bounded retry.
4. A starts a private original-character dossier before any public Subject exists. Later they explicitly create or
   choose an admitted public Subject and attach the dossier; private text and structure remain private. The action
   does not silently create duplicate public subjects or publish a new type.

### Selected publication and reuse

1. A saves private revisions, then previews and publishes one selected analysis associated with the Character.
   The public URL and subject contribution directory lead to the selected revision. A private parent, alternate
   ending and future draft remain absent from public body, breadcrumbs, child indicators, metadata and export.
2. Editing the working draft changes the author's view only. Updating publication preserves previously selected
   revisions as exact citations in the current publication generation. An unselected intermediate revision remains
   unreadable to B even if its identifier is known.
3. A uses a public definition in an exact citation. B follows it, returns to the citing paragraph, and creates their
   own private note. This reuses identity/reference without cloning the public subject or mutating A's document.
4. Publish preview detects a never-public managed target, private resolver fallback, draft-only media and stale
   revision. The author can remove/replace the reference or independently publish the intended target. No operation
   recursively publishes linked resources. Literal text remains the author's explicit disclosure responsibility.
5. One source targets another document that later becomes unreadable. Source render, API and export withhold target
   attributes/IDs/snippets and show only the permitted unavailable citation marker. Exact-source provenance and
   public projection digests are not misrepresented as byte-identical.

### Mathematical learning as a structural example

1. Create a problem document, two different solution documents, a theorem statement with assumptions, and a
   definition. A solution step cites the exact statement/block it uses; another solution may cite a different theorem.
   The source of a uses-reference is the solution/step, not an automatically inferred prerequisite of every solution.
2. Follow a step to a theorem and then a definition through bounded previews or full visits; return to the original
   step without losing reading position. A private misunderstanding note is visible only to its author beside public
   explanations. No request expands the complete mathematics graph.
3. Revise a theorem's assumptions. The earlier solution retains its exact citation and can independently indicate
   that another revision exists. It does not silently adopt that revision or label itself machine-verified.
4. Ordinary reference cycles navigate safely. Stored TeX/source text round-trips and exports unchanged; first-release
   rendering makes no claim of mathematical layout or formal validation. The next-version math profile must later
   repeat this scenario with accessible inline/display rendering and precise statement vocabulary.

### Revocation, trash and terminal lifecycle

1. Pause derived indexing, then withdraw a published analysis. Its live/exact public body, previews, thumbnails,
   exports and managed-reference resolutions no longer disclose it. B receives the same concealment semantics as an
   unavailable resource. Source-owned public text in other resources is not silently rewritten.
2. Delayed events and replay from the old publication generation cannot restore public availability. Republish one
   revision in a new generation: only explicitly selected revisions are reauthorized, not every older private or
   previously withdrawn revision.
3. Trash an owned subtree. Descendant visits fail current lifecycle checks while unrelated branches remain readable.
   Referring documents and external targets survive. Restore makes bounded progress while the root stays hidden,
   clears old public selections, then restores private work. A move cannot bypass the trash/restore fence.
4. Race restore with expiry/purge, account erasure and an attempted descendant insertion. Native root/owner fences
   select one valid outcome; no partial restoration or erased revision is published. Cleanup resumes after restart
   without repeated whole-tree discovery or phantom successful completion.
5. Erase A's account. Private drafts, private paths and their copies in indexes/events/exports are erased under the
   existing disposition. Eligible selected public contributions retain only allowed content and de-identified
   attribution. They do not retain the private notebook identity or unselected revision history.
6. Exercise document and reference media through ordinary upload/claim authority, moderation and erasure. Publishing
   a document does not expose another private upload, and withdrawing it prevents source-gated derived downloads.

### Concurrency, identity and recovery

1. Two editors of A's account save from the same head. At most one stale-basis update commits; the other draft stays
   recoverable with comparison and retry. The interface never calls this automatic real-time merge.
2. Time out after a successful command. Retry its sealed idempotent intent and read back the one acknowledged
   effect; do not create duplicate documents, publications or associations. Session replacement cannot send the
   retained command under another identity. Rejected publication keeps the private draft intact.
3. Concurrently move placement A under B and B under A. Only an acyclic result commits. Test maximum destination
   depth plus moving-subtree height, same-parent reordering, root movement and order-key rebalance exhaustion.
4. Merge/unmerge the attached Subjects. Documents and primary trees keep their IDs, cardinality, working revisions
   and private provenance. The current subject destination can change only through the admitted Semantic resolver;
   unresolved mapping is unavailable, not guessed identity or a scan of all originals.
5. Copy one document: body content survives; document/block IDs are new; exact references and provenance preserve
   their explicit meaning. Changing the copy does not change its source. The copy starts private.

### Audience, lists and cache equivalence

One endpoint may return public facts, public contributions and A's private attachments. Prove audience handling for
anonymous, A and B against the same route and parameters. A public cache key must never reuse A's combined body.
SSR payloads, hydration data, API errors, exports, SEO, notification previews and client-retained state are part of
the evidence. On sign-out/account switch, clear private results before showing the next audience.

A failed private section may report unavailable while independently authorized public facts remain useful; it may
not be replaced with empty success or another owner's rows. Do not make public-only reads depend on the availability
or population of private attachment stores. Public equivalence tests compare data, membership, count fields and
pagination semantics for states differing only in never-public private resources; they do not promise constant
network timing under shared server load.

Stage more than the foreground candidate limit of withdrawn public associations before a readable one, with the
indexer paused. A native retained plan eventually returns a useful page or proved exhaustion for its captured
association observation after finite source mutation stops. A capped sample is never an exact total or exhaustive
empty response. Preparation failure stays failure/unavailable, not permanent successful preparing with no progress.
Unacknowledged publication indexing may delay discovery but cannot delay source withdrawal.

Web transfer acceptance uses `knowledge-transfer-wire.test.ts`, `knowledge-transfer.test.ts` and
`knowledge-transfer-mounted.test.tsx` alongside the existing reader/private/navigation suites. Verify exact
public/authoring export requests, unchanged native envelope bytes and local save retry, independent copied
identity/provenance from a separate exact read, replacing 20-row destination pages, conflict refresh/review,
immutable uncertain retry and complete retirement. The six illustrative `Pages/Knowledge/Transfer` stories are
PublicExport, OwnExport, CopyReview, Copied, StructureChanged and Unavailable; inspect 390/1280px, both themes and
eight locales. These authored fixtures do not substitute for native authorization/source-withdrawal, mounted
return, visual/accessibility or promoted-revision proof.

## Native cost evidence

Use the constants in the product contract rather than repeating new numeric authorities. Measure returned and
examined rows, full-key probes, SQL statements, decoded/copied/serialized bytes, validation, Access operands,
durable effects and cleanup. Capture query plans/buffer work, elapsed-time distributions, peak memory and contention
for the ordinary unforced planner. Include failure, concealed and retry branches. Database maintenance costs retain
the existing architectural treatment.

| Axis                          | Fixture and expected relationship                                                                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unrelated population/history  | Three increasing scales, initially 1,000 / 10,000 / 100,000; fixed document/read page remains bounded in rows/bytes, indexed physical work may grow logarithmically            |
| Notebook size                 | 1,000 / 10,000 / 100,000 documents, plus one million metadata-only sibling placements for the order/list stress case; listing and reordering must not scan or rewrite siblings |
| Body and references           | Small/medium/maximum admitted body; zero/typical/maximum references; snapshot work follows body bytes and selected references, not total corpus                                |
| Tree depth and move           | Root, midpoint and admitted maximum depth; small and large moved subtrees at equal heights; mutation touches only bounded ancestor/height paths                                |
| Private population            | Add 1 / 1,000 / 100,000 never-public attachments elsewhere; public candidates/serialization remain independent of them                                                         |
| Public stale candidates       | Dense, sparse and wholly withdrawn candidate observations; foreground work stays bounded and retained work reaches its finite end                                              |
| Revision and deletion history | Grow revisions, media claims and prior publication generations; point reads use keyed current state, cleanup alone follows retained finite input                               |
| Parallel writers              | Measure structure-lock contention separately from document saves; document body saves must not serialize all unrelated notebook editing                                        |
| Cross-home references         | Spread target keys over admitted homes; record batches, ancestor lifecycle probes and end-to-end latency, not just local SQL cost                                              |

Large fixtures belong to Performance's existing check placement and seed tools, not ordinary unit suites. Record
hardware, database versions, cache condition, concurrency, payload distribution and baseline before adopting an
absolute latency SLO. No millisecond claim is established by this design. A failing cost bound changes the owning
access path or the explicit release capability; it must not be hidden behind a small output LIMIT.

## Implementation order and handoffs

These are outcome slices for supermanager scheduling, not task IDs or a second control plane. Each row includes the
whole native path, failure cases and its smallest usable interface. Do not deliver the editor first against a mock
that bypasses the unresolved publication/read authority.

| Order  | Outcome and owner                                             | Dependencies and completion                                                                                                                                                                                                                                                       |
| ------ | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First  | Content + Accounts + Performance: native vertical feasibility | One notebook, two private documents about one public Subject, one selected publication, exact read, withdrawal with indexer paused; measure full ancestor/Access costs. Resolve the new Source's useful-page preparation and public erasure disposition before broad feature work |
| Second | Content + Web: private writing and organization               | Adopt resource/operation descriptors and erasure locators, then create/read/save/history, primary tree, bounded height/order, title/recent lookup, draft recovery and one-document export                                                                                         |
| Third  | Semantic + Content + Web: subject-connected reading           | Shared Subject identity, owner-local attachment source and one viewer-aware composition; both accounts and anonymous acceptance; no global private directory                                                                                                                      |
| Fourth | Content + Search + Accounts + Web: selected public reuse      | Anonymous preview, exact selected revision, public association Source, useful pages, update/withdraw generations, moderation/media/lifecycle and precise reference projection                                                                                                     |
| Fifth  | Web + Content + Performance: complete both personas           | Writer and text-based learning journeys, narrow screens, keyboard accessibility, ordinary generated-client/native data parity, concurrency/erasure/growth on the integrated candidate                                                                                             |

The first slice is deliberately a feasibility gate: if source currentness, lifecycle and prepared discovery cannot
be made native within the model, repair that shared capability before building the remaining surfaces. It is not
permission to drop the public/private loop from launch or mark a private-only notebook complete.

Conceptual operations include notebook create/read, child/document list, document create/read/save/copy/export,
placement move, reference resolve, publication preview/select/withdraw, and trash/restore. They use existing
command/idempotency/CAS and code-first transport conventions. Actual route layout can extend existing page reads;
no mandatory split into public/private endpoints or new service is prescribed. Batch reads have one composed bound
and independent audience/source continuations, with explicit ready/preparing/unavailable states where applicable.

The implementation owner must register exact module public surfaces and operation metadata, generate normal client
contracts, add native resource/lifecycle/index migrations, and bind producers through the existing composition root.
No hand-written replacement OpenAPI, ad hoc permission check, direct importer SQL writer or second task scheduler.

## Later-version release gates

| Capability                        | Evidence needed before that version opens                                                                                                                                                                                                                                                        |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Local typed database              | Rename preserves field identity; type migration preserves old values/meaning; null/unknown differ; table/list/board share one population; each filter/sort/group has an admitted complete indexed plan; private fields do not enter public queries                                               |
| Rich mathematical authoring       | Versioned source-preserving inline/display nodes; safe bounded renderer/macros; keyboard edit and accessible text/MathML output; export/import keeps notation; selected statement assumptions and exact proof-step references remain stable                                                      |
| Sharing and collaboration         | Realm/direct-grant authority and revocation; conflict-free text convergence under selected adapter; reconnect rejects unauthorized old updates; same document supports authorized peers with separate publication; structure moves remain cycle-free; compaction and erasure include sync stores |
| Live reused content               | Explicit live versus pinned selection, finite expansion, source-version feedback, current per-target authority and no private transclusion in a shared cache; removing a placement does not remove the source                                                                                    |
| Multi-document publication/import | Reviewed finite manifest, per-document licences/permissions, retained bounded job and explicit visibility cut; no recursive accidental sharing; unsupported imported fields are preserved or visibly reported                                                                                    |
| Formula/rollup                    | Closed typed evaluator, stated precision/unit/null/error rules, dependency cycles, measured invalidation fanout, admitted indexed/materialized sorting and no information flow from unreadable inputs                                                                                            |
| Formal proof adapter              | Exact theorem statement and tool/library revision, reproducible artifact checking, trusted-boundary description and separate status from an ordinary authored explanation                                                                                                                        |

Later gates are concrete extension points, not launch requirements. Their implementation may revise physical storage
while keeping existing document identity, exact citations, audiences, publication and exports meaningful.
