# Private anchored journals and return state

This design defines ownership and semantics for private journals. Contracts,
operations, schemas, persona proofs and implementation follow after the wave
that changes Content ownership. The first cut has no sharing; anchors change
only through explicit reanchoring.

The missing job is to leave private context at a particular place and recover
it on return: a reader's edition passage, a player's attempt, or a member's
particular reply. The report rates this medium, high for note-heavy users.
Retaining an imported field, publishing a review and clearing inbox notifications
do not complete that job. This proposal does not change the launch cut lines.

## Evidence and existing owners

The staged competitor coverage report (2026-10-15, baseline `57b03b2435`), B06,
supplies the StoryGraph journal, Backloggd play-note and Discourse bookmark
comparison. [Backloggd's FAQ](https://backloggd.com/about/) explicitly includes
play-session notes among its formatted text fields.
[Discourse's bookmark announcement](https://meta.discourse.org/t/improved-bookmarks-with-reminders/144542/1)
describes an optional name, a bookmark list, editing and deletion, and a separate
reminder choice. Checked 2026-10-16, these vendor descriptions support the
return-context job; they do not prove demand, private custody in REZICS, or that
each competitor has the same privacy policy. Our proposed common boundary is a
person-owned annotation plus existing return-position state.

| Owner inspected | Reuse | Addition and reason |
| --- | --- | --- |
| [Projection identity and disclosure](../../services/main/src/modules/projection/README.md), [frame validation](../../services/main/src/modules/projection/validate.ts) and [semantic identities](../contracts/semantic-model.md#identities-variants-and-projections) | An existing Projection can be a target when the person means a subject in an admitted frame. | It is immutable, has no facts of its own and derives readability from subject and frames. Agent is not a frame dimension. A person coordinate cannot turn it into private custody, and an exact revision/session selector is not supplied by a frame. |
| [Content comments](../../services/content/src/comments.ts), [admission](../../services/main/src/modules/content-publication/comment.ts), [document bodies](../../services/content/src/document-body.ts) and [annotation vocabulary profile](../../model/definitions/semantic-annotation-v1.ttl) | Existing Annotation/SpecificResource meaning, immutable Content revisions, body/document validation, exact source checks, erasure behavior and owner receipts. | Extend Content's annotation capability with person-owned private annotations, mutable heads over immutable revisions, optional names and bookmarks. Existing comment admission/disclosure is not a private-journal grant. The current profile admits commenting but not bookmarking, and requires a quote selector for a SpecificResource; it cannot be silently repurposed or tightened. |
| [Shared locator protocol](../../packages/wiki-toolkit/protocol/locator.ts), [Content locator adapter](../../packages/model/src/locator.ts), [target resolver](../../services/main/src/modules/target/resolve.ts) and [Main Version continuity](../contracts/main-version.md) | Hosted revision/digest, external representation digest, block/range, quote, EPUB CFI and script locators; exact resource resolution and existing change/ambiguity outcomes. | An annotation associates the locator with the exact edition/release, session or occurrence it concerns. Schema-valid external locators are not proof that REZICS possesses or has resolved that representation. |
| [Consumption sessions](../../services/main/src/modules/session/contract.ts), [state transitions](../../services/main/src/modules/session/state.ts) and [store](../../services/main/src/modules/session/store.ts) | Private attempt identity, selected releases, current/furthest locators, versions and replay. `furthest` already takes the maximum within the selected target/unit. | Attach notes to the existing attempt; do not create a journal-specific play session. Opening a bookmark can move the current location backwards without reducing furthest progress. |
| [Structure progress](../../services/main/src/modules/progress/store.ts), [order lookup](../../services/main/src/modules/progress/order.ts) and [reading positions](../../services/main/src/modules/reading-position/contract.ts) | Principal-owned occurrence keys, selected revision, compare-and-set, replay, bounded order lookup and resumable order projection. | A monotonic reached marker over an exact admitted order belongs here. Existing completion is reversible and its free-form position is not an ordered high-water mark. Add that meaning to this owner rather than infer it from a bookmark or change completion semantics. |
| [Realm reply identity and custody](../../services/main/src/modules/realm-reply/README.md), [thread reads](../../services/main/src/modules/realm-reply/thread-contract.ts) | Exact reply/body revision, Realm placement and bounded branch/ancestor reads. | A reply bookmark references those identities. Best/Top and tree display order do not establish a stable linear read-through order; a thread marker needs an explicitly admitted order before it can claim monotonic reading coverage. |
| [Access](../contracts/identity-and-access.md), [native library exchange](../../services/main/src/modules/library-export/bundle.ts), [import application](../../services/main/src/modules/library-import/apply.ts) and [exact export readers](../../services/main/src/modules/export/readers.ts) | Verified principal/person selection, current authorization, exact snapshot selections, receipts and resumable exchange. Private imported reviews remain private. | Add native annotation selections and mapping into these owners. Retained private review text has no passage/occurrence identity and is not an editable native journal. Feed/inbox watermarks retain their existing notification/feed meaning. |

## Decision: private annotations, existing return owners

First consider personal projections as a read model over existing state. They
can assemble a person's sessions, progress and annotations under current
authority, but cannot be the custody of a new authored note: the source fact and
its receipts must already exist. The installed semantic Projection owner also
cannot supply private state for the reasons above. Reuse those read patterns
where useful; add the missing authored state to Content's annotation owner.
There is no separate journal service, per-vertical notebook or competing
progress ledger. A journal is a paged personal view of these annotations.

Propose private PostgreSQL custody in Content, alongside its annotation/body
and reader-state owners. An annotation has one stable identity and one private
person owner, an exact target, an optional name and optional Content body.
Multiple notes at one passage remain distinct; names and body text never decide
identity. A bookmark may have no note or name. One annotation command changes
one head and its bounded body/anchor and records its receipt in that same owner
transaction. Use the existing verified-principal/person relationship; an
Organization representation or a selected public author identity cannot select
another person's journal. Access continues to own authority.

Use [Web Annotation](https://www.w3.org/TR/annotation-model/) `oa:Annotation`,
`oa:hasTarget`, `oa:hasBody` and `oa:SpecificResource` with its source, selector
and state. Use [the existing motivations](https://www.w3.org/TR/annotation-vocab/)
`oa:commenting` for a note and `oa:bookmarking` for a saved return target, and
`dcterms:title` for its optional name. These standards, checked 2026-10-16,
describe annotation meaning, not privacy or concurrency. The future owner
profile must admit the required existing terms and exact locator forms without
changing the existing evidence profile's meaning. No local Journal, Bookmark
or selector vocabulary is proposed. Revision pins, CAS, receipt keys and
resolution dispositions reuse owner/protocol fields; any future RDF property
for a remaining gap needs its own vocabulary justification.

Saving a note/bookmark does not advance progress, finish an attempt, check a
cooking step, publish a reply or subscribe to a reminder. An explicit reached
command goes to Progress or Session. An optional reminder references the
annotation through the [Scheduled proposal](scheduled-plans.md); timer and
notification semantics stay there. The [Collection run decision](actionable-collections.md)
can supply exact run/entry targets once implemented; this proposal does not
implement or claim those pending capabilities.

| Configuration | Same capability, existing target meaning |
| --- | --- |
| Book journal | Exact realization/release plus passage locator, optionally the existing reading session and Structure occurrence. Another edition or reread is a different selection. |
| Game or VN notes | Existing play/read attempt and its selected release/platform; an admitted script locator may refine the target. Elapsed time remains Observation/session-duration work. |
| Cooking context | Exact Collection run and entry/source occurrence, when admitted by that owner. A private substitution note neither edits the recipe nor changes shared checks. |
| Discussion return | Exact reply revision and Realm placement, optionally a passage within its Content body. Moving or editing the reply cannot retarget the saved note. |

## Anchors, edits and reached state

Keep the selected resource, immutable revision or representation digest and
locator together. Where relevant also pin Structure/entry occurrence and
revision or session selection. A bare page number without its edition, a reply
ordinal, a title or today's Main Version head is insufficient. A session target
must belong to the caller; a shared resource target still needs current target
readability. Cross-owner pins are references, not one transaction or a new
grant. Selected disclosure witnesses must be rechecked before returning bytes;
an unavailable witness produces an unavailable outcome.

The old exact target remains authoritative after an edit. A lookup may report
that it still resolves there, that an external representation is not available
for resolution, or that the anchor is unresolved. It never searches the whole
Work, matches a similarly worded reply or substitutes today's edition. Mapping
to a new revision is an explicit command with the old expected annotation
version and a newly selected exact target; it preserves the prior annotation
revision. Ambiguous, changed or deleted block results remain explicit. The
locator protocol's in-memory snapshot comparison is linear in snapshot size;
it is usable only for two individually bounded documents, not as a whole-book
or branch reanchoring scan.

On source access loss, keep the person's own note/name and a non-disclosing
unavailable-target disposition available to that person, including export and
deletion. Suppress source labels, quotes, excerpts, selectors containing source
text and derived previews while unreadable. Source erasure clears retained
source-derived selector/quote material through the existing erasure mechanism;
an opaque tombstone can preserve the historical association. The person's
authored body has independent custody and is not automatically a source copy.
Old receipts, cached previews and exports must apply the same current checks.

Note/name/anchor edits and deletion use per-annotation versions. Stale competing
edits conflict instead of replacing an unseen note; omitted fields preserve
saved state and an explicit clear has its own declared meaning. Replaying a
key returns its original committed outcome without applying it again; different
input under that key conflicts. Recheck the person's authority and source
disclosure before replaying any payload. Deletion is terminal for that identity;
a late retry cannot resurrect it. Recovery fences and identity-merge/erasure
coverage must include new private state and receipts before release.

A reached marker is scoped to one person, attempt/continuity selection and
admitted ordered target. Within that exact order it advances by maximum, using
the existing owner CAS/replay discipline. A stale lower advance cannot move it
backwards; a concurrent higher advance must be reconciled or explicitly
conflicted, never lost. Current location and named bookmarks may move freely;
they do not assert that every intervening part was read. Neither does a furthest
marker certify contiguous coverage or completion. A reread starts/selects a
different attempt. Reset/correction is an explicit versioned owner action,
separate from ordinary monotonic advance.

Order revision, unit or edition changes are not comparable by ordinal or
percentage. Retain the old selection and report reconciliation needed; do not
walk history until a plausible maximum is found. Thread bookmarks work without
a marker. For a long branch, only an admitted stable owner order can support
reached state, and it still cannot claim all earlier replies were read. Best/Top
rank, notification sequence and inbox watermark cannot supply that order.

## Bounded neighbourhoods

The following are proposed admission budgets for review, not measured capacity
claims or installed contracts. Each bound is independent of total people,
notes, revisions, replies and elapsed time. Existing stricter owner budgets
still apply; selecting more data means continuation, never raising the bound.

| Read, command or sweep | Selected neighbourhood and stop condition |
| --- | --- |
| Create/edit/delete/replay | One person, one annotation head/receipt, one target, at most one session and one occurrence association. At most one Content document using its existing 65,536 text-unit, 196,608 text-byte and 1 MB document bounds; name at most 1,000 code points; locator envelope at most 16 KiB. No account, Work or branch enumeration. |
| Resolve/reanchor | One exact source revision/representation, plus at most one explicitly selected successor. Hydrate at most two bounded Content documents; use Structure's indexed occurrence lookup and existing depth bound. Larger external representations require an admitted bounded locator adapter or return unresolved; no fetching/scanning arbitrary books in a request. |
| Journal/bookmark/search page | Person-scoped indexed seek by stable `(changed time, identity)`, optionally exact target/session and motivation, with indexed name/body search. Inspect at most 50 candidates plus one lookahead, disclose at most 50 and hydrate at most 10 bodies per page under a 2 MiB response ceiling. Body details have their own exact read. No offsets, global count or fetch-until-full loop. |
| Progress/return read or advance | One exact marker and candidate, existing point order lookup and bounded ancestor path; Session keeps its existing selection ceiling. Resume uses the existing Progress candidate budget. Index unavailable means explicit unavailability, not a read-time rebuild. |
| Edit/revocation/erasure fan-out | Current source disclosure changes take effect at read/replay gates immediately. Reverse dependencies seek by exact source and annotation identity; background cleanup processes at most 50 dependents per transaction with a durable cursor. No synchronous rewrite of all annotations on a popular source. |
| Reindex, recovery, expiry and account deletion | Lease one owner queue partition; seek at most 50 rows after a durable checkpoint per transaction. Retry at the same checkpoint, fence old generations/erasures, and publish coverage only when complete. No periodic scan of all people or unbounded cascade in one command. |
| Export/import | Pin one selected snapshot and traverse at most 50 annotation/marker candidates per chunk within the same body/byte limits. Cross-chunk references use a durable indexed mapping; no in-memory account inventory. Validate/admit each bounded import chunk and retain progress/receipt coverage. |

Cursors bind the person, filters/order, snapshot or selected generation and
recovery epoch. Check current authority on each continuation. A page with hidden
source details can still contain the owner's note; any filtered candidates
advance the cursor even when no item is returned. Report page counts or honest
lower bounds, with a count unavailable when no bounded exact count exists.
Search indexes and snippets have the same person boundary as exact reads.
Search admits a bounded query (at most 200 code points); its plan must seek in
the selected person's index with the candidate ceiling before hydration. Sorting
or counting all matching documents before applying a limit does not meet it.
Deadline/byte exhaustion returns explicit partial coverage and continuation or
unavailability; it cannot label a prefix a complete journal or export. Storage
plans and counters must qualify these budgets before implementation is accepted.

## Per-persona authority as API observations

Private means person-owned, with no sharing/publication switch in this first
cut. Target access and journal access are independent. A source editor, household
shopper, moderator or platform operator receives no journal grant through their
other role. Access checks also cover search, counts, continuation, replay,
export selection and artifact download. A hidden private identity is concealed;
an authenticated person's inadequate client scope yields denial without private
payload. The table describes future observations, not today's installed routes.

| Persona and API exercise | Allowed observation | Refused/concealed observation |
| --- | --- | --- |
| Signed-out visitor reads public target, then reads/lists/changes the note or downloads its export. | Ordinary disclosed target remains readable. | Private identity/body/name/marker/existence/count concealed; commands require authentication. |
| Signed-in stranger creates their own note on the same passage and probes the first person's IDs, search and receipts. | Their own distinct private annotation, marker and export work. | No peer note, bookmark, marker, receipt or export access; knowing the source/ID grants nothing. |
| Realm/household member with explicit source or run read/check grant lists annotations and attempts peer progress. | Read the granted source/run; create private notes under their own person. | Membership, source-read and run-check expose no peer journal and permit no peer marker advance. |
| Journal owner creates, edits, bookmarks, advances, returns, deletes and exports using their current person. | Read/write their own authored state; see exact anchor or its explicit unresolved/unavailable disposition; deletion and native export remain possible after source loss. | Cannot read a revoked source through saved quotes, publish via journal editing, or select another person's attempt. |
| Source author/catalogue editor edits the edition or reply, then requests its annotations. | Existing source-edit authority works; they can keep their own journal. | No readers' notes, names, private marker values or annotation counts; editing cannot migrate another person's anchors. |
| Realm moderator without journal authority probes a member's bookmark on a moderated reply. | Existing jurisdiction permits the ordinary source moderation action. | No journal read/edit/export or member impersonation; source removal does not publish private context. |
| Platform operator without journal authority runs health/recovery and probes private APIs. | Bounded diagnostics and recovery under the existing narrow operational identity. | Platform status supplies no private content or peer progress authority; diagnostics omit notes, names and locators. |
| Delegated integrating client loses consent between pages or before retry/download. | Only the selected person's currently authorized scopes; a separate own-person import can create private native state. | Revocation denies further disclosure/commands, including receipt payloads and artifacts; an application credential alone cannot choose an owner. |

## Export, alternatives and proof for review

Extend native exchange with exact annotation identities/revisions, optional names,
Content documents and language/direction, motivations, private ownership intent,
target/locator resolution dispositions, attempt associations and current/furthest
markers with their order/unit pins. Reimport maps identities to the importing
person's state without granting anyone else access. Missing sources or attempts
remain explicit unresolved associations; a file cannot authorize source reads
or recreate another person's session. An own-person round trip preserves the
note, privacy and marker; reimport into existing state needs an explicit conflict
choice rather than silently lowering a later marker or replacing an edited note.
Retries reuse mapping receipts and do not duplicate annotations.

Snapshot changes require restart/reconciliation rather than mixed revisions.
Source-derived quotes/details are included only while currently eligible;
erasures and unavailable sources have an explicit loss/disposition record.
Downloads recheck authority. Already downloaded copies cannot be recalled.
Generic CSV, private XML residuals and public reviews are not lossless native
backups; adapters report unsupported fields instead of claiming completion.

Alternatives considered: a private Collection can save resource links but cannot
alone own exact passage selectors, annotation revisions and reached semantics.
A public review/comment route with a client-side private flag lacks a server
custody boundary. Adding arbitrary note fields to progress or sessions excludes
reply/passage notes and couples body edits to tracking. Personal read projections
remain useful over the selected owners but cannot create the missing authored
fact. A new journal backend would duplicate Content, Access, locators and replay.
The selected extension adds private annotation lifecycle and ordered reached
meaning only where current owners lack them.

The falsifier for the later contract/outcome step is an API observation table:

| Scenario / actor action | Required API observation; the proposal is falsified otherwise |
| --- | --- |
| Owner annotates one passage in edition E1 at revision R1 and a particular reply revision in Realm A; another edition has the same words. | Two exact private targets persist. Owner finds them by target/session and journal continuation; no substitution of E2, today's head, another reply or another Realm placement. Every unauthorized persona above gets no note or private metadata. |
| Editor inserts text before the passage, splits/deletes its block and edits the reply; owner returns. | Old readable R1 still resolves as R1, or resolution is explicitly unavailable/unresolved. New text/branch is never silently accepted; adopting a successor requires an owner command and preserves the old annotation revision. |
| Two owner devices edit the same note, lose responses and retry; delete races an old write. | One committed version per accepted edit, stale edits conflict, retry replays once, changed input under the key conflicts and a deletion is not resurrected. A body-only edit retains a saved advanced locator/name. |
| Devices advance an ordered marker to parts 12 and 9; owner bookmarks part 4, returns there, then starts a reread or selects a reordered revision. | Same-order furthest stays 12; current location/bookmark can be 4. Completion/contiguous-read coverage is not inferred. Reread has separate attempt state; changed order is explicitly incomparable until reconciled. |
| Member saves a reply in a deep branch, then changes Best/Top sort; notification inbox is marked read. | Exact bookmark still identifies the reply. Sorting/inbox actions do not change private reached state or claim branch coverage; an unsupported order refuses marker advance honestly. |
| Revoke source access, erase a source quote, revoke client consent and restore an older snapshot; probe exact reads, search, replay and export. | Owner's independently authored note survives source loss, source-derived bytes stay suppressed/erased, and revoked clients receive no private payload. Restore cannot reopen erased selectors or obsolete authority. Operator/moderator probes remain concealed. |
| Owner exports, interrupts/retries and reimports into their own person; concurrently edits a native note and advances a marker. | Complete snapshot or explicit restart, no duplicate notes, privacy and exact/unresolved targets preserved, no silent overwrite or marker regression. Unsupported adapter fields and source losses are explicit. No public publication or new grant occurs. |
| Populate many unrelated people/notes, a popular edited source, hidden dependencies and a long branch; exercise every row of the work-budget table. | Native storage plans/counters show indexed bounded candidate work and byte/deadline limits, progressing empty pages, durable fan-out checkpoints and complete/reconcilable exchange. No inventory scan, unbounded cascade or request-time repair appears. |

Program must accept or revise private custody, no-sharing scope, target-loss
behavior, ordered-marker meaning and admission budgets before contracts. Later
real-stack persona tests must observe allowed and refused APIs without owner
mocks, including cross-owner races and recovery; absent routes alone do not
prove authority. Retained large fixtures and storage plans must qualify cost.
The later UI must make privacy, exact/unresolved targets, conflicts and leaving
understandable while preserving richer saved state. This static review and
documentation check establish neither API behavior, human usability nor
competitor replacement parity.
