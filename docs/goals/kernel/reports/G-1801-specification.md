# Content document recovery: existing proof and remaining slices

Read-only investigation of `902d8eac6afac082532e8b0f789b2ea36bedd9f9`,
2026-10-11. Only this report changes. Line numbers below describe that commit
and must be relocated after rebasing. The scope is author recovery of existing
Content documents, not operator backup restoration or a new document model.

**Bad-edit recovery already works for ordinary Content text. Propose no new
rollback command.** The existing API integration proof passed. Zone retirement
and recovery also have an existing owner and a test that retains the published
document bundle. The remaining functional gaps are author access to reply
history, deliberate recovery from a reply tombstone, and usable history controls
on open editors. One existing Zone recovery test fails because its final step
appears to publish a superseded draft directly; repair its proof using the
existing save-then-publish flow before calling Zone document recovery proven.

The finish line is [Program's functionally complete first public
scope](../../program/GOAL.md#completion), with [Launch's
scope](../../launch/GOAL.md#outcome). External conditions listed in
[external-conditions.md](../../../operations/external-conditions.md) are not
implementation dependencies. No slice provisions hosts, providers, legal facts
or named operators.

## 1. Answers from implementation and tests

### Earlier revision after a bad edit

The Content owner has immutable revisions and predecessor links, not mutable
historical bodies: `services/content/migrations/001_core.sql:25–48,121–135`.
`services/content/src/core.ts:753–852` saves a new revision through the existing
receipt, operation lock, variant lock, expected-head CAS and outbox. Exact
historical reads verify bytes and digest at `core.ts:966–1008`.

`tests/qa/integration/content-document-recovery.test.ts:54`, **“an author restores
a published Content document from an earlier revision”**, proves the complete
ordinary text recovery flow:

1. Save and publish good and bad documents; read both exact retained snapshots
   (`:224–230`).
2. Submit the earlier `DocumentSnapshot` to `POST /v1/content-drafts`, using the
   bad current draft as `expectedHead` and a fresh key (`:233–245`). This creates
   a different revision, retains the bad head as predecessor, restores the good
   byte digest, and replays the same command without a second revision.
3. Publish that new revision against the current publication decision
   (`:247–269`). The good and bad originals remain immutable.
4. Refuse a stale head and its retry with the same 409 outcome (`:271–293`).

This test **passed** through `goalctl`, run `20261011t132050-90ead0`. It is a
generic Work Content document proof, not a chapter placement, Zone bundle,
Realm review or search-eligibility proof. Restoring bytes grants none of those
additional authorities. In particular, do not copy an old search-eligibility
decision onto the new revision.

Works' chapter read path is `services/main/src/routes/work-contents.ts:26` and
`modules/work-contents/read.ts:398–438`; it requires current placement and exact
current publication. Author head discovery is `routes/studio.ts:116–175`.
Ordinary draft and exact revision operations are `routes/content.ts:69,404–469`.
The existing save/publication owners are sufficient; there is no reason to add
a second chapter rollback mechanism.

Zone pages use the same Content draft CAS and exact reads, with live `zone.edit`
authority rather than Work authority (`modules/content-publication/draft.ts:
104–176,237–289`). Their public selection is a Zone site bundle, not the Work
publication head. `routes/zones.ts:382–445` supplies the current editor draft;
`:645–652` publishes a bundle. The complete Zone earlier-body recovery proof
needs the repair in slice 1 below. Do not infer its passing result from the
generic Work test.

For Realm replies, ordinary nondeleted edits use that same Content owner, but
there is **no author historical-body API** today. The reply current-reader
joins `v.draft_head` and excludes deleted heads
(`modules/realm-reply/content-store.ts:428–438`, `store.ts:446–455`). Generic
`GET /v1/content-revisions/:revision` resolves admitted current graph resource
types (`routes/content.ts:420`, `content-publication/draft.ts:71–132`); SQL reply
identities are not admitted graph Content targets. A retained SQL predecessor
therefore does not establish a usable reply restore flow.

### Author deletion or withdrawal; permanent erasure

These operations have different owners and consequences:

| User action | Implemented behavior and evidence | Recovery conclusion |
| --- | --- | --- |
| Delete/withdraw a reply draft with `body: null` | `routes/member-replies.ts:31–51`; `content-publication/reply-draft.ts:29–53,86–92` saves an empty `deleted:true` tombstone revision. `core.ts:775–784` retains author, variant, root and origin. | **Incomplete:** `core.ts:803–806` rejects every later edit of a deleted reply head. A deliberate restore needs a narrow exception with verified recovery intent; ordinary replay must remain unable to resurrect it. |
| Remove a chapter from a book's contents | Composition owns membership independently of Content bytes. `routes/compositions.ts:547–564` already restores an exact earlier composition through its owner. `tests/qa/integration/structure-composition.test.ts:24`, **“BOOK02/COMP01/COMP02/COMP05/COMP06: admitted Book composition keeps occurrence identity and exact heads”**, covers removal at `:185–194` and restoration at `:296–329`. | Existing composition recovery must be reused. This is not a Content body rollback; do not claim BOOK08 as proof of restored document bytes. No new composition mechanism is proposed. |
| Retire and recover a Zone | Public owner routes exist at `routes/zones.ts:654,703`; `modules/zone/configuration.ts:430–433,532–534` advances the owner head from active to retired and back. | Existing proof, no new backend work: `tests/qa/integration/zone-document-home.test.ts:911`, **“configuration, retirement and recovery retain the bundle; revoked publication and stale cuts do not switch it”**, asserts anonymous absence during retirement and the same published page revision after recovery (`:926–942`). This test was inspected, not run here. |
| Replace a published Zone page selection | Current public bundle membership moves; exact old bytes remain privately available to a currently authorized editor (`tests/qa/integration/content-zone-revision-delivery.test.ts:101–129`). | Resave the retained body as a new current draft, then publish through the existing bundle owner. The test's final direct old-head publication currently fails; slice 1 repairs the proof, not the owner guard. |
| Lose Zone editor/controller authority | Exact private reads recheck authority immediately before responding (`routes/content.ts:449–456`). The Zone delivery test reinstalls fresh controller authority or returns ownership and checks unchanged exact bytes (`:131–176`). | Recovery is restoration of legitimate owner authority. The former editor cannot recover bytes by bypassing it. This is distinct from document withdrawal. |
| Erase an exact revision | `modules/erasure/content.ts:118–138,184–224` applies the retained journal, suppression and preservation fence, locks the exact revision, inserts its tombstone and nulls body/serialized bytes. `content/migrations/120_revision_erasure.sql:6–26` retains the immutable erasure identity. | **Permanent:** no undo, read fallback or replacement at the erased reference. A still-available different revision can be used only through its own current authority; copying an older selection must not defeat current erasure suppression. |

There is no generic Content `withdrawn` state: the availability enum is
`available`, `erased`, `unavailable` (`001_core.sql:38`). Inspection of the Work,
Post and Content routes did not establish a separate whole-document soft-delete
operation for ordinary chapter bodies. Do not invent one merely to give it an
undo operation. A reported “deleted chapter” needs the exact operation/ref
before it can be classified as a placement removal, empty body or erasure.

Existing reply tests prove deletion and anti-resurrection, **not undelete**:
`tests/qa/integration/member-reply-api.test.ts:5`, **“G265: members and pen names
author exact contribution comments, edit/delete their own replies, and replay
without resurrection”**, and `:106`, **“G265: member replies still require exact
Realm review and placement; edits do not inherit approval and deletion suppresses
placement”**. Both passed in this investigation. A new recovered revision must
use normal current review/placement; old approval cannot silently move to it.

Erasure already has a proving test:
`tests/qa/integration/erasure-api.test.ts:57`, **“OPS10/OPS11: Content erasure
journals exact targets with receipts, denial, stale and recovery outcomes and
explicit per-store retention”**. It preserves publication proof while refusing
republication of erased bytes (`:180–233`) and explicitly reports retained or
unverified physical destruction (`:239–265`). It was inspected, not run here.
`tests/qa/fault-recovery/erasure-restore.test.ts:75`, **“OPS11/OPS12/IAM11/SEARCH20:
restored backups keep erased payloads and credentials offline until the retained
erasure journal reconciles”**, is the existing backup nonresurrection proof, not
a user document recovery mechanism.

[Content governance](../../../contracts/content-governance.md#remaining-work) separates
reversal from recreation of erased bytes and preserves other authors' replies
when a thread root is removed. Its existing owners remain authoritative.
`tests/qa/integration/governance-report.test.ts:427`, **“GOV02/GOV03: stale target
or rule never applies; reversals have one effect and Realm contexts stay
independent”**, proves governance reversal/replay, not author revision recovery.
Do not let a document restore reverse a restriction, reuse a revoked benefit,
or resurrect other authors' removed placements.

### What an editor can see and do through the API

| Surface | Revision list / comparison / restore today |
| --- | --- |
| Work/chapter Content | Authorized head discovery plus exact reads returning `reference.predecessor`, `serializedJson`, digest and body (`core.ts:47,459–464`; `routes/content.ts:458`). A caller can walk readable predecessors, compare two snapshots locally and restore through ordinary save/publication. There is no bounded history-page operation. An erased/unreadable intermediate revision stops this client traversal. |
| Zone page | Current editor head and the same exact predecessor reads under live Zone authority. Anonymous exact reads are limited to current public bundle membership. Comparison needs two authorized exact reads, not a new diff service. Restore is ordinary draft save plus separately chosen site publication. |
| Realm reply | Public current reply/list only (`routes/member-replies.ts:51–77`), excluding tombstones and requiring root/Realm visibility. No author revision-list, historical exact-body read, or deleted-draft inventory was found. |

The existing UI does not provide saved-history recovery. Studio opens the current
chapter head and ignores `_revision` (`apps/web/features/studio/read.ts:673–703`);
its conflict comparison is unsaved mine versus the current winner
(`conflict-view.tsx:36–60`), and `local-draft.ts:87–93` restores device typing.
Neither proves historical restore. Zone's client offers save, publish and current
draft/head reads (`zone-editor/api.ts:36–69`); its actions are Publish, Save,
Preview and View site (`editor-actions.tsx:24–38`). Realm's composer creates,
retries and withdraws replies (`feed/thread-api.ts:60–85,93–142`), without an
author history/recovery view.

## 2. Acceptance and shared boundaries

No dedicated document-recovery acceptance ID exists in the inspected inventory.
WORK09 is the existing CAS/exact-history/digest requirement
(`scripts/qa/cases/native-work.ts:48–51`); WORK10 covers exact publication pins and
erasure (`:54–58`). SUB05/SUB06 and SUB08 retain exact review and nonrevival rules
(`scripts/qa/cases/subscriptions-and-pro.ts:25–43`). BOOK05 and BOOK10 cover
concurrency and offline replay, not saved-revision recovery.

**DR01–DR06 below are proposed acceptance labels for Program to register or map,
not assigned repository IDs and not a claim that an existing whole ID is green.**
Their observable requirements are:

| Proposed label | Required result |
| --- | --- |
| DR01 | Earlier ordinary Content body restores as a new current revision; originals and their digests remain immutable; stale save/publish and duplicate command behave correctly. Existing generic Work proof already passes. |
| DR02 | Current authorized editor can page retained history and compare available exact snapshots, including history beyond an erased intermediate revision, without revealing hidden metadata or bytes. |
| DR03 | Current reply author can discover their recoverable deleted drafts and read same-reply historical snapshots; other viewers and revoked/root-hidden authors see the same absence as unknown targets. |
| DR04 | Explicit author tombstone recovery creates one new reply revision with immutable identity, source-bound intent, CAS, retry safety, erasure refusal and no inherited Realm publication. |
| DR05 | An open Zone page editor discovers, compares, restores and deliberately republishes an earlier document; anonymous reading confirms it, while stale input survives. |
| DR06 | An open ordinary reply author discovers a deleted reply, restores its earlier draft, completes normal current review/placement and returns to see it; another viewer cannot discover deleted/history data. |

Across slices, hidden equals absent applies to **metadata, counts, locators,
cursors and bytes**, not just body filtering. Read APIs return private/no-store
responses, recheck current authority and delivery fences before response, and
never expose arbitrary provenance/controller identity. Historical reads remain
possible after an author's own recoverable tombstone, while currently hidden or
erased roots and current restrictions still deny them. A tombstone is not an
Access grant. Owner outage/corruption remains unavailable rather than fabricated
absence or a head fallback.

## 3. Ordered implementation slices

Each numbered slice is one bounded Luna/max session, with focused tests and its
affected typechecks. No slice introduces a registry, compatibility layer, new
document model or history engine. The A chain is intended to fit the ten-hour
window; estimates are planning bounds, not measured execution times. If a slice
does not stand within its session, retain its evidence and split the remaining
work rather than relax the invariant.

### 1. Repair and qualify the existing Zone recovery proof — A; 30–45 minutes

**Reason:** an open Zone publication function cannot be called proven while its
existing recovery test fails. **Files/current lines:**
`tests/qa/integration/content-zone-revision-delivery.test.ts:101–179`; existing
guards at `services/content/src/core.ts:895–897` and
`services/main/src/modules/content-publication/publish.ts:464–465` are evidence,
not edit targets.

**Change:** retain the assertion that fresh publication of the superseded first
revision refuses. Then save `firstDocument` against the later current draft,
publish the newly saved revision, and assert the restored body/digest, a new
revision identity and unchanged old exact bytes. Keep public membership tied to
the new selected revision: the old reference stays anonymously unavailable.
Add an opaque Blocks payload to the retained source so this is a real document
proof rather than a plain-text-only shortcut. Preserve the controller/owner
withdrawal interleavings.

**Proof:** extend the existing test **“exact Zone delivery refuses actual bundle,
controller and owner withdrawal after paused deliverability; recovery keeps
exact bytes”** with a named subcase **“Zone earlier document resave restores
bytes without publishing a stale draft head”**. Run that file through `goalctl`;
do not rerun the already-passing generic recovery test just to add a new command.
**Turns green:** DR01's Zone subcase and this currently failing test; WORK09/10
remain affected regression, not whole-ID certification.

**Mechanisms: none.** Reuses Content CAS/exact bytes and existing Zone bundle
publication. **Migrations:** Content no, Access no. **Native build:** no.
**Waits:** none; route/test ownership must be claimed by the dispatching manager.

### 2. Bounded retained revision metadata in Content — A; 45–60 minutes

**Reason:** open editors need discoverable history, and predecessor GET traversal
cannot pass an erased intermediate revision. **Files/current lines:**
`services/content/src/core.ts:557–613,966–1008`;
`services/content/tests/core.integration.test.ts:13,114–125,220–242`;
existing index `services/content/migrations/001_core.sql:48`.

**Change:** add one internal, bounded history metadata page for an exact resource
and variant. Walk `content.revision.predecessor` from a selected immutable head,
with a fixed hop budget per page and indexed exact-ID lookups. Do not load all
bodies, count the entire history or scan until enough visible items happen to
appear. Retain traversal through erased anchors internally without delivering
their IDs/metadata. A page may be empty with a continuation. Bind continuation
to resource/variant, the selected head and owner epoch; concurrent saves must
not duplicate or lose entries inside that selected history. Return only fields
the Main editor read needs. Main remains responsible for current authorization
and graph erasure/disclosure before exposing them. The existing creation-time
index remains available, but timestamps are not substituted for predecessor
order in the committed revision chain.

**Proof:** extend `core.integration.test.ts` with **“retained revision pages are
bounded and stable across same-time saves, new heads and erased intermediates”**
and **“history pages never return body bytes or cross a foreign variant”**.
Exercise more revisions than a page and an empty terminal/continuing page.
**Turns green:** DR02's owner-page subcase; WORK09 regression.

**Mechanisms: none.** Existing immutable revision anchors/index and owner read
budgets. **Migrations:** Content no, Access no. **Native build:** no.
**Waits:** none; slice 1 need not serialize this
independent owner read work.

### 3. Current-authority history API for Work and Zone — A; 60–75 minutes

**Reason:** the open Zone editor needs the owner page, and existing exact-read
authority must apply to all historical selections. **Files/current lines:**
new `services/main/src/routes/content-history.ts` and
`services/main/src/modules/content-publication/history.ts`;
reuse `routes/content.ts:404–469`, `content-publication/draft.ts:104–176` and
`routes/studio.ts:116–175`; registration is add-only at
`services/main/src/app.ts:37,164`. Existing `api-document.ts`/authored response
schemas should carry the route contract; no generated file is committed.

**Change:** expose the slice-2 metadata page as an authenticated editor history
operation. Resolve the resource's actual owner; for Work use current Studio
variant/edit authority, and for Zone use the live Zone editor bridge. Do not
infer edit permission from the weaker ability to read an exact Work revision.
Filter denied/erased metadata before constructing exposed pages and keep
continuation private and bound to the current read identity. Reuse the existing
exact GET for comparison and the existing draft/publication commands for
restore. There is no new compare or generic restore endpoint.

**Proof:** new `services/main/tests/content-history.test.ts` cases **“editor
history denies foreign variants, hidden resources and revoked owner proof as
missing”** and **“history delivery rechecks erasure, owner transfer and recovery
hold”**; new `tests/qa/integration/content-editor-history.test.ts` case **“Work
and Zone history pages deliver exact authorized comparison inputs beyond an
erased revision”**. Preserve regressions in
`services/main/tests/content-revision-read.integration.test.ts:28` (**“WORK09:
partial Content exact history requires current Work disclosure and reports byte
damage”**) and `services/main/tests/content-zone-revision-delivery.test.ts:142`.
Regenerate contracts and run `task web:typecheck` after adding the route.
**Turns green:** DR02's API subcase; WORK09/IAM read boundaries affected.

**Mechanisms: none.** Existing owner resolution, Access authority and exact
Content read. **Migrations:** Content no, Access no. **Native build:** no.
**Waits:** slice 2; Trust-ops review of the new public-exposure operation and
Program registration/mapping of DR02. No new capability opening is inferred.

### 4. Discoverable author reply inventory and history — A; 75–90 minutes

**Reason:** an author cannot recover a deleted reply that every public inventory
omits. Knowing an old UUID is insufficient for the complete recovery job.
**Files/current lines:** `services/main/src/routes/member-replies.ts:18–77`;
`modules/realm-reply/content-store.ts:94,428–438`, `store.ts:446–455`,
`root.ts:35–53`; reuse slice-2 Content page;
`modules/access/admission.ts:919–934` for live, nonretained authority probing.
Content schema evidence is `services/content/migrations/340_reply_authorship.sql:
3–13`; typed mirror is `services/main/src/modules/realm-reply/schema.ts:9`.

**Change:** add author-only draft inventory including recoverable tombstones,
and exact same-reply history reads. Query `content.reply_author`, which exists
even for a saved draft that never received `content.reply` identity/placement.
The existing `reply_author_page` index at migration 440 targets public
`content.reply` and excludes some unplaced drafts; it is not this inventory.
Add the minimal `(author, reply)` seek index on `content.reply_author`, with its
number assigned at dispatch. Page a bounded candidate window, then disclose
current readable roots/origins; no hidden IDs in continuation or counts.
Use ordinary current principal/acting-subject authority and retained-root/Realm
checks, not a new grant kind, graph type or author registry. Recheck authority
before returning bytes; tombstones do not bypass current Realm history rules,
root erasure, suppression or Account revocation. Exact source reads bind reply,
variant, author and model before exposing the snapshot.

**Proof:** new `tests/qa/integration/member-reply-history.test.ts` cases **“author
inventory finds deleted and never-placed drafts without exposing another
author's replies”**, **“author exact reply history crosses tombstones but refuses
hidden or erased roots and lost authority”**, and **“same-reply comparison
preserves structured and opaque document bytes”**. Include more than one page,
denied candidates, wrong variant/source and authority changes during delivery.
Retain the existing reply deletion and hidden-current-read tests.
**Turns green:** DR03; WORK09 and SUB05/06/08 are affected regression only.

**Mechanisms: none.** Existing immutable reply authorship, Content history,
Access policy and target/Realm disclosure. **Migrations:** Content **yes**, one
index-only migration, number assigned at dispatch; Access no. **Native build:**
no. **Waits:** slice 2 and Launch ownership of `realm-reply`/member reply routes;
Trust-ops must review author-history read policy and exposure, including the
origin Realm's admission-history boundary.

### 5. Deliberate reply recovery through the existing draft command — A; 75–90 minutes

**Reason:** tombstone recovery is explicitly impossible today. **Files/current
lines:** `services/main/src/routes/member-replies.ts:23–51`;
`modules/content-publication/reply-draft.ts:29–53,74–98,122–165`;
`services/content/src/core.ts:51–58,202–211,715–728,775–852`;
`services/content/tests/core.integration.test.ts:13` and
`tests/qa/integration/member-reply-api.test.ts:5,106`.

**Change:** extend the existing draft request with an explicit restore-from-exact
revision alternative, mutually exclusive with arbitrary body/document input.
The server obtains that same reply/variant's available nondeleted source body,
preserves document, root, origin, language and spoiler declaration, and binds
source revision/digest, author and expected deleted head into both the admission
intent and owner request digest. Recheck source availability/digest under the
same Content transaction locks used by erasure; a pretransaction read alone is
not sufficient. Copy no old Access admission or publication approval.

Keep the ordinary deleted-head edit fence. Only this owner-validated restore
intent may cross it, using current `content.draft` admission and a fresh
`draft.save` receipt. Its CAS creates a new revision whose predecessor is the
current tombstone. Never reset `draft_head` to an old revision or change retained
bytes. Keep operation replay ahead of new effects, preserving old-create replay
without resurrection. Stale/concurrent recovery must report the current conflict
without silently overwriting a newer head. The restored draft needs ordinary
current review/placement; it does not activate an old approved placement.

**Proof:** add **“explicit author reply recovery creates one new revision while
ordinary tombstone edits and old replay stay refused”**, **“concurrent and stale
reply recovery has one winner and stable retry”**, and **“reply recovery refuses
foreign, erased or unavailable sources and serializes with erasure”** to the
owner/API tests. Extend the existing exact-review test with **“a recovered reply
gets no old Realm approval or revoked entitlement”**. Include a lost Access
settlement response and retry, using the existing fixture pattern at
`member-reply-api.test.ts:56`.
**Turns green:** DR04; WORK09, SUB05/06/08 and OPS10/11 invariants affected.

**Mechanisms: none.** Existing admission/CAS/receipt/event and exact review
owners, with source-bound command intent. **Migrations:** Content no, Access no:
retain existing `draft.save` and `content.draft`, not a new action family.
**Native build:** no. **Waits:** slice 4 for discoverable author reads and
Trust-ops review of the narrow recovery authority. Kernel owns Content's fence;
Launch owns the reply adapter. Dispatch must claim both owners' needed paths.

### 6. Zone history, comparison and restore controls — A; 60–75 minutes

**Reason:** open Site pages need a usable recovery journey, not just known-ID
API composition. **Files/current lines:**
`apps/web/features/zone-editor/api.ts:36–69`, `editor.tsx:104–135`,
`editor-actions.tsx:24–38`, `model.ts`, messages and
`zone-editor.stories.tsx:136–186`; existing
`zone-editor/authoring.test.ts:46–86,128–157` and
`apps/web/tests/zone-site-authoring.e2e.ts:135`.

**Change:** consume slice 3's bounded history, display selected and current
snapshots, and restore the selected full document through existing expected-head
save. A selected historical revision is separate from the current save basis.
Keep unknown Blocks payloads/fallbacks; comparison may render two snapshots and
does not need a new semantic diff engine. Publication stays an explicit existing
action after save. Preserve unsaved input on stale, denied or unavailable
responses, and retry a dropped response with the same command key.

**Proof:** extend authoring tests with **“restoring an earlier page preserves
current publication until republished”** and stale/input preservation. Add a
story for keyboard history selection/compare/restore and extend the existing
browser journey with **“a Zone author restores an earlier document and an
anonymous reader sees only its deliberate publication”**, phone and desktop.
Run changed stories/screens through Launch's Storybook screenshot review.
**Turns green:** DR05; Launch Site pages/Publication evidence entries at
`scripts/qa/cases/launch-coverage.ts:294–318`.

**Mechanisms: none.** Existing owner history/CAS and Zone publication.
**Migrations:** Content no, Access no. **Native build:** no. **Waits:** slices 1
and 3; Launch owns UI/localization and the open Site pages flow.

### 7. Ordinary reply author recovery journey — A for the open reply surface; 60–75 minutes

**Reason:** public reads omit deleted replies; the author needs a private path
to find and recover them. **Files/current lines:**
`apps/web/features/feed/thread-api.ts:42–45,60–85,93–142`, `reply-tree.tsx`,
`reply-composer.tsx:303`, `features/realm/thread-view.tsx` and corresponding
messages/stories; existing `apps/web/tests/document-replies.test.ts:50,63`.

**Change:** expose the author inventory/history from slice 4 in an authenticated
author view, including drafts no longer present in the thread. Compare selected
and current snapshots; use slice 5 for a tombstone restore and ordinary draft
save for bad edits. State draft restoration separately from Realm publication
and proceed through the existing current review/placement result. Do not use
public thread/list data to reveal deleted targets, and do not promise automatic
reactivation. Keep unsaved input and the exact operation key across failures.

**Proof:** new `apps/web/tests/reply-recovery.e2e.ts` case **“an author finds a
deleted reply, restores its draft and completes current Realm placement”**;
another viewer cannot discover deleted history. Unit/story cases cover stale
head, lost response, denied root and keyboard comparison/restore. Keep rich
snapshot and refused-composer-withdrawal tests. Review changed screens in
Storybook at phone/desktop widths.
**Turns green:** DR06; SUB05/06/08 safety subcases remain regression.

**Mechanisms: none.** Existing author draft, Content history and exact Realm
review/placement. **Migrations:** Content no, Access no. **Native build:** no.
**Waits:** slices 4–5; Launch confirms the ordinary reply editing/deletion
surface is open, and Trust-ops/Launch settle its private recovery entry and
publication policy without transferring old approval to a new revision.

### 8. Studio saved-history controls — B while the editor stays gated; 60–90 minutes

**Reason:** Launch explicitly lists “the editor” and serial drafting among
closed-until-later items (`docs/goals/launch/GOAL.md:69–78`). A public book library
does not by itself decide that Studio is open. **Files/current lines:**
`apps/web/features/studio/read.ts:607–629,673–703`,
`content-api.ts:112–127`, `manuscript-editor.tsx:153–164,374–385`,
`diff.ts:13–51`, `conflict-view.tsx:36–60` and related messages/stories.

**Change:** when Launch opens chapter editing, reuse slice 3 and existing
Content save/publication. Keep historical preview separate from current
expected-head authority. Reuse the bounded existing comparison renderer where
applicable; do not reinterpret device-cache recovery as historical recovery.
Contribution text is a different existing owner API and is outside this
Content-specific slice; widening to it needs a separate brief.

**Proof:** new `apps/web/tests/studio-history.test.ts`, **“historical preview does
not replace the current chapter save basis”**, and a chapter earlier-body
restore browser subcase in `apps/web/tests/studio.e2e.ts`. Retain
`studio-autosave.test.ts:103,128,241,257,354` and `studio-chapters.test.ts:338`
for conflict/cache/authority regression.
**Turns green:** DR01/DR02's Studio browser subcases only when Program elects
to include them. **Mechanisms: none.** **Migrations:** Content no, Access no.
**Native build:** no. **Waits:** slice 3 and Launch's editor opening decision.
Do not put this B slice on the A ten-hour chain without that decision.

### C exclusions

Dedicated server compare/rollback engines, generic Content soft deletion,
replacement bytes at erased references, a recycle-bin registry, recovery of
revoked benefits, automatic reuse of historical review, bulk history export,
backup restore UX and new Jena commands are **C**: none is needed for the
identified first-scope recovery functions, and several would violate an
existing owner boundary. No implementation slice is proposed for them.

## 4. Reproduction, limits and decisions to retain

Executed, without product/test edits:

| Command | Evidence |
| --- | --- |
| `bun scripts/goal/goalctl.ts test tests/qa/integration/content-document-recovery.test.ts` | **Pass**, QA `20261011t132050-90ead0`, integration 13.1 s. Existing generic bad-edit recovery proof. |
| `bun scripts/goal/goalctl.ts test tests/qa/integration/member-reply-api.test.ts tests/qa/integration/content-zone-revision-delivery.test.ts` | **Fail**, QA `20261011t132408-79470b`: all four member reply tests passed; Zone delivery test failed with expected 201 / received 409 `content_conflict`. Automatic isolated retry also failed. No source changed and no test was weakened. |

The Zone failure reached 24 assertions before the final publication call. Source
inspection identifies the stale-source candidate at
`content-zone-revision-delivery.test.ts:176`: it republishes `f.first` after saving
`later`. A fresh
site pin requires the current draft head (`core.ts:895–897`;
`publish.ts:464–465`). This attribution is an inference from the reached
assertions and code, not an instrumented trace of the thrown owner message.
Slice 1 must establish the corrected positive and stale negative separately;
if it reveals a different owner defect, retain that evidence and give the manager
the smallest failing operation rather than loosening the guard.

Both QA summaries report **zero registered acceptance IDs passed** because the
selected test names are not registered recovery evidence. They prove their
named test outcomes, not full Goal or ID qualification. Other tests cited above
were inspected only. No dev server, whole tier, physical-destruction drill or
browser journey ran. The brief requires no checks beyond read-only reproduction;
this report alone does not qualify the future routes or UI. The manager should
link it from the kernel records when merging; that owner file is outside this
brief's sole write path.

Questions retained for owners, rather than answered by this worker:

- **Program:** register/map DR01–DR06 and the existing successful generic
  recovery test. Which exact recovery subcases are required for first public
  scope? WORK09/10 alone do not register a deleted-reply/UI recovery outcome.
- **Launch:** does the “editor” cut line include current Studio chapters? Keep
  slice 8 B unless it is explicitly opened. Confirm the ordinary Realm author
  editing/deletion and private deleted-draft recovery entry in slices 4–7.
- **Trust-ops:** review new history operations' exposure, read policy and erasure
  guards, especially author access across Realm admission-history changes.
  Recovery must preserve current restrictions and exact review semantics.
- **Launch/Trust-ops:** a newly restored reply is currently a new unapproved
  revision. Any request for automatic restoration of historic placement or
  review is a policy change requiring its own decision and proof; this plan
  uses ordinary current review/placement only.

Not established: a separate generic chapter-body deletion API; a passing complete
Zone bad-edit recovery test; usable author-only deleted-reply history/recovery;
physical destruction of every retained copy; browser success for any proposed
control. The exact deletion operation would settle the first, slice 1's passing
proof the second, slices 4–7's owner/API/browser tests the third, and Trust-ops'
existing per-store destruction evidence the fourth. None is silently treated as
already working.
