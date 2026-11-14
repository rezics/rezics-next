# Studio

`/studio` is the signed-in account workspace for private discussion drafts. It consumes the bounded Content
own-drafts inventory, opens only an explicitly selected discussion opening, and uses the existing Studio editor,
revision history and comparison. The inventory is account scoped; it does not imply project membership. Each page
contains at most 20 rows, keeps its opaque continuation, and retries the exact failed cursor.

Studio creates a private discussion with the selected board, nonempty body, title, licence, subjects and media IDs.
The generated `thread.create` operation receives draft visibility and one stable idempotency key. Acknowledged drafts
use the current exact-resume reader and the conditional revision writer for later edits. The editor retains one
selection and one working document; it does not add a second body store.

Before account publication, Studio freezes the acknowledged Post revision and digest, body, board, licence, subjects
and media IDs in a local review. Editing retires that review. Publication uses the installed conditional revision
command with the exact `If-Match`, captured session credential and original idempotency key. An uncertain outcome
retries that same intent; a new observation is a separate action. Studio reports publication only after an exact
current-post readback agrees with the acknowledged body and operands.

Hosted Books stay on `/studio?books=1`. Their selected-manifest review and hosted publish command remain independent
and atomic. The manifest freezes exact chapter bodies and required table-of-contents ancestors; later draft edits and
unselected drafts do not enter the release.

The route uses public Threads and Content entries and the installed generated operations. Native authorization,
session retirement, producer recordings and the mounted native/browser acceptance remain separate verification
responsibilities. `studio-native-drafts.stories.tsx` labels its supplied outcomes as illustrations, not native proof.

Decision: Studio owns one account-draft inventory and private creation flow, composes the existing exact-resume and
revision lifecycle, and keeps local acknowledged-revision publication separate from hosted Book publication. Studio
exact document operations use a focused Content public entry that exposes only those operations and required types;
implementation stays in Content and Studio remains the receiving owner.

Shared Studio puts the document first, with compact phone navigation and unframed wide navigation.
[Editing language](workspace-language.md) owns localized feedback and evidence.

## Writing workbench

Decision: one installed Book/column workbench presents the recognizable work title, ordered draft outline and
predominant document canvas. The compact document toolbar owns Save, Write, Preview and Versions. Draft maintenance,
exact identity, workspace help and publication occupy labelled secondary regions. Navigation precedes the canvas
on phones and sits beside it on wide screens. Column series context stays distinct from independent articles;
Book parts retain their nested native order. Missing document titles use existing localized untitled or unavailable
wording, while the editable title remains empty. Exact Post, revision and digest identity stays in labelled details.

Disclosure changes visibility, never controller or form lifetime. Editor undo/uploads, selected comparison and
replacement confirmation survive view changes. Dirty text and discard confirmation keep draft actions visible;
active publication review and receipt keep publication visible. Session failures, unknown results, same-intent retry,
read-only access and publication unavailability remain visible outside collapsed secondary content. Book-start
recovery stays outside the disabled document fieldset so its frozen same-intent retry remains actionable. Preparation and
legacy readiness links belong in the publication region, not above the work heading. Generated producer binding,
held activation consumer, exact operands, source permission and money rules retain their existing owners.

Source-first choice: implement and commit the workbench and focused regression sources; run the final brief's required
Web typecheck only. Acceptance execution, native/browser/keyboard/visual review, Storybook builds and captures are
deferred to the dev verifier. Existing standalone review IDs and scripted walks stay intact. Manual routed workbench
reviews use the same component and controller; they cover populated Book/column, dirty switching, selected comparison
and independently unavailable publication preparation without claiming native publication.

Sources read before design: this guide and [editing language](workspace-language.md), `workspace.tsx`, `contract.ts`,
controller entry points, workspace callers, `hosted-draft-picker-view.tsx`, `hosted-history-view.tsx`, `revisions.tsx`,
`hosted-release-preparation-view.tsx`, the existing preparation/native-draft stories and focused language regressions,
and the read-only main checkout's reference index. Installed Impeccable documents were absent from the permitted
skill/reference locations; no launcher, installation or PATH change is required for this local hierarchy repair.

Deferred acceptance: `bun run --cwd apps/web test tests/studio-workspace-language.test.tsx
 tests/studio-saved-version-language.test.tsx src/studio/workbench-region.test.tsx`. Existing autosave, frozen replay,
dirty-switch and publication-lock assertions stay in the shared language regression. Manual stories are review
fixtures; their supplied successful saves and unavailable publication do not establish native or promoted acceptance.

## Saved-version language

Decision: Book and column version comparison uses complete `studio_revision_*` messages in all eight launch locales,
reusing shared history and cancellation messages. Replacement review names the supplied title and precise saved
timestamp, with separate complete prompts for clean and dirty working text. Titles, exact IDs, digests and timestamps
remain intact; the saved timestamp retains its semantic `time` element. Comparison shows the selected exact version
beside the current saved draft, while unsaved working text stays in the editor. Copy remains a deliberate draft-only
action under the existing permissions, pending/upload and unresolved-command guards; publication stays separate.

Sources read before design: this owner document, `revisions.tsx`, `controller.ts`, `contract.ts`, the workspace caller,
`tests/studio-post-revision-headers.test.tsx`, the existing Studio mounted fixtures, Web's
[acceptance](../../../../docs/goals/web.md#acceptance), and Impeccable's Operate refinement and craft-floor guidance.
The native one-page header continuation and explicitly selected body reader already support this workflow.

Deferred acceptance: the dev verifier runs `bun run --cwd apps/web test tests/studio-saved-version-language.test.tsx`.
The focused mounted regression covers both profiles in every launch locale, sparse paging, translated comparison,
exact disclosure, clean/dirty replacement review, unchanged identities and draft-only copy. Native authoring, keyboard,
phone/desktop visual review, legacy parity and promoted-commit acceptance remain separate obligations. Source checks
are catalogue key/argument parity, the changed-UI detector, changed-file formatting and the affected Web typecheck.

## Native author outline window

Decision: keep a separate exact-revision, one-page author outline reader, now consumed by read-only Book history;
root append uses the separate bounded visit described below. `hostedOutlineWindowNative` uses the authenticated session BFF and the installed
generated outline route. Its request carries the admitted catalogue/kind/revision/source and an opaque cursor;
the acting private viewer comes from the prepared session. Both boundaries keep no-store and request cancellation.
The closed response admits at most 20 slots with nonnegative safe-integer sibling positions, including positions
beyond 511. Withheld slots retain only native addresses, kind and availability. Missing parents, labels and targets
are never synthesized, empty sparse pages keep their continuation, and each call makes exactly one native request.

`HostedOutlineWindow` is the page owner for the mounted history inspector. It keeps only the current page, retries
the failed cursor exactly, and permanently retires on session replacement (including the same account), aborting requests and discarding late
responses. A caller disposes it on departure or supplies the owning workspace's currentness predicate. Its page wire
is separate from `HostedBook`: no partial or withheld page becomes an editable whole tree. The existing complete-tree
reader still drains the exact stream, refuses unavailable slots or more than 512 placements, and retains the legacy
position, dense sibling, parent and depth checks. Replacement commands and the mounted editor keep those bounds.

Sources read before design: `hosted-contract.ts`, `hosted-native.ts`, `hosted-actions.ts`, this Book owner document,
the installed `hosted-chapters-routes.d.ts` outline declaration and `hosted-chapters-reads.d.ts`, Content's
[Book author outline contract](../../../../services/kernel/src/content/hosted-chapters.md#author-outline), and the
existing complete-tree fixture, inventory/history callers and session provenance source. The generated route is
already present on the base; no merge, cherry-pick, public-reader or Backend change is needed.

Deferred acceptance: the dev verifier runs `bun run --cwd apps/web test tests/studio-hosted-outline-window.test.ts
tests/studio-hosted-outline.test.ts`. The new source fixture pins exact URL/cursor, one request, positions beyond 511,
safe-integer and closed wire admission, withheld slots, sparse pages, exact revision matching, cancellation, native
failure categories, exact retry and credential retirement. Existing assertions remain unchanged. Source verification
formats changed files and runs one affected Web typecheck. Browser, native, Storybook and broad checks are deferred.

## Bounded saved-chapter root append

Decision: add a separate bounded root-append visit from each owned Book entry before complete-tree loading; reuse
`HostedDraftPicker` and `HostedOutlineWindow`, freeze exact reviewed intent for same-key replay, and keep
acknowledgement separate from readback. Stale refresh retains saved choice/title and requires fresh review; the
editor and publication engine remain unchanged.

The additional owned-Book link opens `/studio?catalogueId=…&append=1` with the existing native viewer comparison.
It reads only one exact owner-head outline page, never the Book Post, complete structure or publication. The author
explicitly opens the existing account picker and selects one saved own discussion opening. The exact Post port and
picker retain their existing owner, revision, body/digest and session admission; no second inventory or parser is added.
Review displays the saved body, timestamp, Post/revision/digest and editable chapter title. Preparing review freezes
catalogue, expected head, a fresh route-bound occurrence, exact target/title, original key, CSRF and session intent.
Editing retires review. Unknown results only replay that frozen command; stale results preserve selection and title
for an explicit owner-head refresh followed by a new review and fresh occurrence/key. There is no automatic rebase,
resubmission or publication.

The private CSRF/no-store BFF uses the installed `$appendRootChapter.post` and admits the closed HTTP200 receipt
without the complete-tree `command()` helper. Acknowledgement is final even when separate outline readback fails.
The returned revision binds a new bounded window; readback recovery retries only its exact failed cursor and cannot
submit another append. Each explicit page request replaces at most 20 rows, retaining sparse continuations and native
large sibling positions without refill, draining, per-row reads or synthetic labels. Partial, withheld and oversized
windows never enter `HostedBook` or its replacement editor. Existing 512-placement/depth limits, working drafts,
dirty-editor protection, Book/article publication and frozen public reading keep their contracts.

The route owns departure/locale/credential lifetime; source, account and session incarnation changes permanently
retire the visit, picker, selection and window, abort requests and fence late commands, reads and focus. All actions
use shared controls, wrapping 44px targets and distinct `studio_root_append_*` messages in all eight launch locales.
Review and recovery move keyboard focus to the relevant heading; editing returns it to the title field.

Sources read before design: this owner, the [native bounded-root contract](../../../../services/kernel/src/content/hosted-chapters.md#bounded-root-append),
[Web outcome and acceptance](../../../../docs/goals/web.md#acceptance), installed `hosted-chapters-routes.d.ts`,
`routes/studio.tsx`, `hosted-contract.ts`, `hosted-native.ts`, `hosted-actions.ts`, `hosted-inventory.ts`,
`hosted-draft-picker.ts` and its view, `hosted-outline-window.ts`, `post-document-port.ts`, `hosted-workspace.ts`,
workspace/structure callers, existing picker/outline regressions and Impeccable's craft floor. The base already has
the generated append operation and bounded readers; no generator, Client declaration or native changes are needed.

Deferred acceptance: the dev verifier runs `bun run --cwd apps/web test tests/studio-hosted-root-append.test.tsx
 tests/studio-hosted-draft-picker.test.tsx tests/studio-hosted-outline-window.test.ts tests/studio-hosted-outline.test.ts`.
The authored mounted regression covers the inventory entry, exact reviewed command and receipt, same-key replay,
stale refresh preserving choice/title, sparse/large-address paging and exact failed-cursor retry, acknowledged append
with failed readback, same-account replacement, departure/late results and retained complete-tree refusal bounds.
Source verification is changed-file formatting, message key/argument parity, one explicit changed-UI path detection
and one affected Web typecheck. Native, keyboard/phone/desktop, legacy parity, browser/Storybook, broad suites and
promoted-commit acceptance remain separate verifier obligations.

## Stable draft outline anchors

Decision: insert and move use the bounded point visit with one replacing page and explicitly observed
source/parent/before anchors; native owns cycle, depth and admission. Exact updates and single-chapter publication
keep their separate reviews. Switching between draft changes and publication retires the previous selection and
refreshes owner pointers; batch activation remains separate.

The owned Book inventory offers `/studio?catalogueId=…&points=1` with its native viewer comparison before any
complete-tree read. The separate point visit uses the existing picker and one replacing outline page of at most
20 body-free occurrences per explicit request. Opaque continuations, sparse pages, large sibling addresses and
same-cursor retry retain the bounded window contract. Only an available, displayed occurrence can become a move
source. Only an available, displayed part can become a parent; root is an explicit destination. An observed sibling
under that parent can become the before anchor, or the author chooses parent end. Selected anchors retain their
supplied human titles, stable IDs and exact draft revision across page replacement. Reobserving the same parent
preserves a retained before choice, which still requires its own current observation. Changing parent clears it.
The view shows the supplied parent ID, kind and zero-based sibling position without rounding, clamping or inferring
hidden ancestors or depth. It never scans descendants, enumerates destinations or refills a sparse page.

Move review freezes the catalogue, expected head, source occurrence, parent/before IDs, original sender,
idempotency key, CSRF and session/locale intent. A move preserves the occurrence identity and saved chapter versions;
it moves a part's subtree without loading its descendants. Native decides cycles, depth, admission and adjacent
no-op behavior. Removal separately reviews the chosen occurrence and explicitly removes its whole subtree from the
draft without inventing a count or erasing saved Posts and historical versions. Switching operations retains only
the active source and placement anchors, rather than accumulating selections from previous tasks.

The chapter picker reads only the deliberate selection through `post-document-port.ts`. The page displays its
saved body, timestamp, revision and SHA-256. Insert review freezes the fresh route-bound occurrence, title and exact
chapter target as well as the destination anchors. Unknown results replay the original command, sender and credential
with native current authorization. A stale result preserves the original identities, titles and observation revisions
but marks each anchor unconfirmed, even when owner refresh returns the same head. Explicit owner-head refresh,
current-page observations and fresh review precede any new intent/key. Insert/update chapters additionally require
an explicit reread of their original exact saved version; the latest chapter head is never substituted.
The private authenticated CSRF/no-store BFF validates the request union and calls the installed generated
`$insertDraftPoint.post`, `$moveDraftPoint.post`, `$updateDraftPoint.post` or `$removeDraftPoint.post`. External
receipts and pages retain HTTP validation; no Client declaration, complete-tree writer or native changes are needed.

`hosted-draft-point-lifecycle.ts` owns shared root-append/point replay, stale refresh, receipt and retirement.
An HTTP200 receipt acknowledges the write independently of observation. Its exact revision, including historical
replay, selects a new bounded window; failed readback retries only that exact page and never resubmits the command.
Account, session incarnation, source, credential, locale and departure retire selections, abort pending requests and
fence late results and focus. Shared wrapping 44px controls and eight-locale `studio_draft_point_*` messages retain
the existing Studio appearance. Review/recovery requests keyboard focus only while the initiating focus remains;
subsequent focus, pointer or Tab movement cancels that request. Legacy body editing, native recovery,
remove/update and publication keep their existing entry paths.

Sources read before design: this owner's Stable draft outline anchors and Native author outline window sections;
`hosted-draft-points.ts`, `hosted-draft-point-lifecycle.ts`, `hosted-draft-point-view.tsx`, `hosted-native.ts`,
`hosted-contract.ts` and `hosted-actions.ts`; Content's
[point-command contract](../../../../services/kernel/src/content/hosted-chapters.md#versioned-outline-adoption);
the installed `hosted-chapters-routes.d.ts` move declaration; entry/workspace/window/picker callers and existing point
and update acceptance; [Web acceptance](../../../../docs/goals/web.md#acceptance); and the read-only main checkout
`.reference/INDEX.md`. The base supplies the native move and bounded readers but lacks the move request/caller/UI.

Deferred acceptance: the verifier runs `bun run --cwd apps/web test tests/studio-hosted-draft-points.test.tsx
 tests/studio-hosted-draft-picker.test.tsx tests/studio-hosted-root-append.test.tsx tests/studio-hosted-outline-window.test.ts
 tests/studio-hosted-publication-point.test.tsx`. Point acceptance extends existing assertions with cross-page exact
moves, supplied large positions/hidden-parent addresses, explicit root/end, unconfirmed same-head stale recovery,
fresh review, original sender/key/credential replay, exact failed-readback retry and focus/session retirement.
Existing insert/remove/update assertions and story IDs stay intact. Named illustrative move review, stale recovery
and uncertain replay stories add three-page source/parent/before selection at phone390 and desktop1280, without
claiming native proof. Native insert/move/replay, >512/deep Books, phone/desktop/keyboard/locale visual review,
legacy parity, compilation and promoted-commit acceptance remain unverified, separate verifier obligations.

## Review and publish one exact chapter

Draft updates freeze expected draft revision, occurrence, title and explicit target (null for a part). Kind and target
Post identity remain permanent. The existing saved draft picker can select another saved version of that Post;
reading the current occurrence uses the exact revision reader, with saved body, timestamp, revision and digest.
Other Posts cannot satisfy update review. An update changes only the draft; publication is a separate task.

Point publication requires an existing non-null public pointer. It reads exact publication metadata and owns one
replacing draft window and one replacing public window, each capped at 20 body-free rows with explicit continuation
and retry. No complete-tree reader, manifest synthesis, scans, automatic refill or per-row request is involved.
Select the draft chapter and explicitly read its exact saved bytes. Add review freezes both expected pointers,
occurrence, target, public parent/before anchors and at most 15 explicitly included ancestor parts. The author
observes each required draft ancestor and either includes its title or confirms the corresponding public part.
Ancestor insertion anchors also come from the expected public snapshot. Newly included parts retain draft ancestry;
the chapter can use a reviewed new part or a public part as its parent. Replacement observes the matching public
chapter, keeps its public title/parent/order and freezes only the exact changed target.

A 412 retains choices but refresh invalidates every prior anchor observation and body review, even if pointers
happen to match. A fresh intent needs reobserved anchors and an explicit exact-version read. Unknown results lock
the original key, operands, CSRF and session/locale binding for replay after later heads. Current native catalogue
eligibility and exact-source consent remain authoritative; refusal guides the author to resolve the source with its
owner and deliberately rereview, without inventing a consent endpoint or publishing the source Post.

HTTP200 confirmation survives failed readback. Exact receipt metadata and a single outline window are read separately;
retry reading never reissues publication. A fresh matching owner pointer, nonempty bounded confirmed evidence and
anonymous admission of that exact release precede the shared published-Book link. Historical receipt replay can be
observed without presenting it as the current owner pointer. Account/session/source/credential/locale/departure
boundaries retire drafts, responses, links and focus effects. Controls retain Studio's wrapped 44px targets.

Sources read before design: generated `packages/client/src/kernel/content/hosted-chapters-routes.d.ts` point routes,
Content's [authoring, publication and consent contract](../../../../services/kernel/src/content/hosted-chapters.md),
this guide's stable draft anchors and published-Book action, [Web acceptance](../../../../docs/goals/web.md#acceptance),
the point entry/view/lifecycle and tests, picker, Post exact revision port, outline window and reader-link projection.
The installed generated routes supersede Content's historical “not installed” wording.

`tests/studio-hosted-publication-point.test.tsx` pins exact operands, public anchors, fresh review after 412, original
replay, bounded receipt readback and retirement. Its focused execution and the native mounted author-to-reader
journey belong to the dev verifier. Illustrative review, stale, readback and reader-link stories are presentation
examples, not native, visual or promoted acceptance.

## Book outline index

Decision: Book organization memoizes one index for the loaded structure revision, derived from the existing admitted
`bookTocRows` projection. Two linear passes retain preorder rows, occurrence lookup, ordered child rows and maximum
subtree depth. Rendering, stable sibling/parent moves and nested-removal confirmation use those lookups; release
review builds the same index once to resolve selected exact chapters and retains preorder when freezing the outline.
There are no per-row whole-outline scans. Admission, draft identities, exact revisions, depth/placement limits and
the shared placement fields retain their contracts.

Sources read before design: this owner document, `book-toc.ts`, `book-organizer.tsx`, `hosted-workspace.ts` `reviewFor`,
their exported contracts/callers, and the existing placement and hosted publication tests.

Deferred acceptance: the dev verifier runs `bun run --cwd apps/web test tests/studio-book-outline.test.ts
 tests/studio-book-placement.test.tsx tests/studio-hosted-publication.test.ts src/studio/publication-withdrawal.test.tsx`.
The focused outline fixture covers deep subtree limits, stable move operands, sibling order, empty outlines and
exact chapter versions; existing placement, focus and release assertions remain unchanged. Source verification is
changed-file formatting and one Web typecheck; ordinary acceptance, native, browser, Storybook and broader suites
are deferred.

## Book release selection

Decision: Book and part checkboxes share one atomic current-outline chapter selection operation. A mixed checkbox
selects all descendant chapters; a checked checkbox clears them. Empty parts and an empty Book stay unchecked and
disabled. Individual chapter selection remains available. Localized counts describe each part and the whole Book;
one reverse-preorder pass derives checked and mixed states without per-row outline scans.

The controller resolves current admitted chapter occurrences through the outline's child index, preserves selection
outside the chosen subtree, and emits once only when selection changes. Unknown or removed occurrences and empty
subtrees are no-ops; malformed outlines throw before any selection update. No-op clicks retain exact review, while
real changes retire it once. Selection never writes a draft or publication. Exact pinned targets, preorder, draft
revision and the current release remain unchanged; explicit review, publication CAS, withdrawal and repair retain
authority. Selection is unavailable without publication permission, during a command or after visit retirement.

Sources read before design: this owner document, `book-toc.ts`, `book-organizer.tsx`, `controller.ts`, `contract.ts`,
`hosted-workspace.ts` `reviewFor`, the outline/placement/hosted publication and withdrawal tests, and the shared UI
[choice controls](../../../../packages/ui/README.md#choice-controls), Checkbox and Field implementations. The named
direct-move dependency is already integrated in the base; no merge or cherry-pick is needed.

Deferred acceptance: the dev verifier runs `bun run --cwd apps/web test tests/studio-book-selection.test.tsx
 tests/studio-book-outline.test.ts tests/studio-book-placement.test.tsx tests/studio-hosted-publication.test.ts
 src/studio/publication-withdrawal.test.tsx`. New selection cases cover atomic nested/root selection, individual
selection, no-op review retention, current-outline resolution, exact preorder, empty and invalid outlines, current
release preservation, availability and checkbox states. Existing assertions stay unchanged. Source verification is
changed-file formatting and one Web typecheck; acceptance, mounted native, browser and broader suites are deferred.

## Direct Book moves

Decision: Each occurrence's organization disclosure offers Move to with shared labelled Selects for Book root or
an eligible part and an exact sibling insertion point, including a labelled end-of-list option. Values are stable
occurrence IDs; outline numbering distinguishes repeated titles. Options reuse the current outline index, exclude
the source and descendants, account for the deepest moved descendant, and omit invalid anchors and unchanged
positions. Destination enumeration happens only for an opened move form and visits the indexed child lists once.

Submission resolves the retained identities against the controller's current structure before issuing the existing
organize command. A removed or reparented destination/anchor, newly excessive subtree depth or already completed
move cannot submit a stale form. The form closes on acknowledgment or explicit cancellation and retains failed
choices. The controller and hosted adapter continue to own stale/uncertain recovery and conditional native revision
writes. Moving a chapter or whole part subtree makes one draft revision and keeps occurrence IDs, exact Post
versions, release selection and the current publication. Quick moves retain their existing behavior.

Sources read before design: this Studio owner document, `book-toc.ts`, `book-organizer.tsx`, `contract.ts`,
`controller.ts` `organize`, `hosted-adapter.ts` `change`, the placement/outline/hosted publication tests,
[UI form fields](../../../../packages/ui/README.md#form-fields) and Select implementation, and Content's
[authoring and release](../../../../services/kernel/src/content/hosted-chapters.md#authoring-and-release) contract.

Deferred acceptance: the dev verifier runs `bun run --cwd apps/web test tests/studio-book-outline.test.ts
 tests/studio-book-placement.test.tsx tests/studio-hosted-publication.test.ts`. Added cases cover exact destination
and sibling identities, repeated titles, root and empty parts, subtree depth/cycles, no-op exclusion, form retention,
current-structure rechecks and one native revision preserving pinned targets and selection. Existing assertions stay
unchanged. Source verification is changed-file formatting and one affected Web typecheck; acceptance, browser,
mounted native, Storybook and broad suites remain deferred.

## Native author outline

Decision: Book Studio reads the installed private author outline stream, with one bounded request per page,
including nested and empty parts. It first admits the requested current or exact draft/release revision, then sends
the same catalogue, kind, pinned revision and limit with every opaque continuation. The existing credential-bearing
client retains native session anchors and admission; public release disclosure does not grant author access.

The shared body-free occurrence decoder retains exact chapter targets, parent identities and sibling positions.
Only a completed stream enters `hostedBookStructure`, the common tree model for editing, preview, withdrawal and
publication. Its depth, parent and dense sibling checks also apply to outlines; the stream must match its preorder.
Duplicate identities, malformed or repeated cursors, empty continuing pages, withheld rows and failed later pages
reject the entire read. No prefix becomes an empty or editable tree. An empty terminal outline remains valid.
Command recovery reads the acknowledged exact revision through the same operation. Release verification stays
separate from the draft and still checks the source structure revision.

Sources read before design: this owner document, `hosted-native.ts`, `hosted-contract.ts`, `hosted-structure.ts`,
`book-toc.ts`, the adapter/workspace callers and hosted inventory/publication fixtures, the installed generated
outline declaration, and Content's [author outline](../../../../services/kernel/src/content/hosted-chapters.md#author-outline)
contract. The base includes the named native fix and generated operation; no merge or cherry-pick is required.

Deferred acceptance: the dev verifier runs `bun run --cwd apps/web test tests/studio-hosted-outline.test.ts`.
One transport fixture covers ordered pages, nested/empty parts, exact targets and write/readback, cursor and tree
corruption, partial denial and aborted reads. Existing publication assertions remain unchanged. Source checks are
changed-file formatting and one affected Web typecheck; acceptance, native, browser, Storybook and broad suites
remain deferred.

## Book placement fields

Decision: Book placement composes shared `Field`, `FieldLabel` and shadcn `Select` primitives, following Book catalogue
Search. Controlled `items` supply selected labels before opening; the trigger owns the field ID and saved-document
description. The shared widget owns keyboard navigation, opening and dismissal. Book root is an explicit `null`
choice; every other parent value remains the exact part occurrence ID, with the existing depth filter. Kind stays
`part | chapter`. Placement submission, saved-document checks and publication review retain their existing contracts.
Studio uses the component styles and has no raw-select overrides.

Sources read before design: this owner note, [UI form fields](../../../../packages/ui/README.md#form-fields), the shared
Select implementation and story, and [Book catalogue Search](../books/catalogue/page.tsx).

Later acceptance: the dev verifier runs `bun run --cwd apps/web test tests/studio-book-placement.test.tsx` for selected
labels, exact parent identity with duplicate titles, root selection, allowed parents/depth, dismissal, saved-document
checks and disabled controls. Source verification is changed-file formatting and one Web typecheck; native, browser,
Storybook and broader suites are deferred.

## Book outline language

Decision: Every Book organizer label and accessible name follows the current locale through Paraglide, including
placement, quick moves, rename, removal confirmation, pinned versions and structure details. Title-bearing names
and labels use complete messages with arguments; authored titles, occurrence IDs and exact revision operands stay
unchanged. Reuse existing release, direct-move, part and revision messages where their meanings match. Keep the
shared Selects, exact selection, focus, nested moves and explicit removal confirmation unchanged.

Sources read before design: this owner document, [Web Goal](../../../../docs/goals/web.md), `book-organizer.tsx`,
the existing related messages in all eight installed catalogues, and `studio-book-placement.test.tsx` /
`studio-book-selection.test.tsx`. The base localizes release selection and direct Move to fields; the remaining
outline controls need message-backed labels. No producer or generated-output change is required.

Deferred acceptance: the dev verifier runs `bun run --cwd apps/web test tests/studio-book-placement.test.tsx
 tests/studio-book-selection.test.tsx`. The mounted locale-switch case pins nested placement, complete quick-move
and destructive-confirmation names, leaf versus subtree removal, rename, saved-version operands, retained typed
input and unchanged authored titles. Existing English assertions remain unchanged. Source verification checks key
and argument consistency in all eight catalogues, formats changed files and runs one Web typecheck. Acceptance,
native, browser, Storybook and broader suites remain deferred.

## Post revision headers

Decision: Book chapter and column Studio enumerate saved versions with the installed native
`GET /v1/posts/{id}/revision-headers` operation, one metadata page per request. Rows contain only native
`recordedAt` and exact Post/revision/digest; the API has no historical title. Timestamp precision and opaque
continuations survive projection unchanged. An empty page with a continuation remains progress, with a next-page
control and a page-empty label rather than terminal absence. Selected comparison bodies still use the existing
exact `post.revision` reader. Public thread history and hosted-catalogue structure history keep their own readers.

The private no-store BFF prepares the actual session and binds each response to the viewer, mounted visit,
currentness generation, Post, locale, cursor and distinct `post-revision-headers` projection. The existing adapter
retires credentials permanently on session replacement, including replacement by the same account, and discards
late results. Native failures remain unavailable; no fallback or enrichment request supplies missing metadata.
Foreign Post identities and malformed digests are rejected before exposing selectable exact versions.

Sources read before design: this owner document, `post-document-port.ts`, `contract.ts`, `controller.ts`,
`revisions.tsx`, Threads' `reads.ts`, `historical-reader-provenance.ts`, `studio-document.ts`, the installed client's
revision-header operation and schema, and Content's [metadata-only revision headers](../../../../services/kernel/src/content/README.md#metadata-only-revision-headers).
The generated operation is present on the base; no merge or backend change is needed.

Later acceptance: the dev verifier runs `bun run --cwd apps/web test tests/studio-post-revision-headers.test.tsx`.
Cases pin metadata-only request count, native timestamp/cursor projection, sparse progress, exact comparison,
projection/reader mismatch, malformed external identities and credential retirement during reads. Existing exact
body assertions remain unchanged. Native, browser, Storybook and broader suites remain deferred; source verification
uses changed-file formatting and the affected Web typecheck.

## Hosted author inventory

Decision: Book Studio requests the installed owner list with `scope=all-homes` through the existing session-bound
BFF. It retains the native scope, account and authentication epoch. Only a native `same-home` response enables
same-home continuation; errors never trigger an inferred fallback. A page contains at most 20 visible books.
Coverage is shown independently of rows and pagination: `partial` means indexing can still reveal books,
`unavailable` means only the reported home is covered, and `complete` is a native census claim rather than an
inference from an empty page. Empty sparse pages retain their native continuation.

The mounted inventory owns its page and opaque continuation, with no global store. Paging keeps the native scope
and viewer binding, and retry repeats the failed cursor. A repeated continuation, changed scope/home, denied access
or changed native viewer cannot expose the previous page as current. Browser session replacement permanently retires
the visit, aborts its request and removes its rows, including replacement by the same account. Reopening starts a new
observation; it never silently replaces a rejected cursor with the first page.

Exact selection carries only the native catalogue ID and viewer comparison operands. The BFF derives the acting
account from the session; URL account/epoch values provide no authority. Owner get resolves the actual home. The
existing organizer opens the admitted exact structure head and current publication, then confirms the owner
metadata before exposing the workspace. Publication review keeps its selected manifest and uncertain-command
recovery. Neither catalogue IDs nor account IDs establish cross-home completeness or new authoring authority.

Sources read before design: this owner document, the installed client owner-list/get declarations, the current Studio
native/BFF/route/organizer callers, and Content’s [hosted author inventory](../../../../services/kernel/src/content/hosted-chapters.md#author-inventory)
contract. Native production is already present on the base; no merge, cherry-pick or backend query is needed.

Later acceptance: the dev verifier runs `bun run --cwd apps/web test tests/studio-hosted-inventory.test.ts tests/studio-hosted-inventory-view.test.tsx tests/studio-hosted-publication.test.ts`. Focused cases pin cross-home
and native same-home decoding, coverage versus empty pages, sparse continuation and exact retry, changed viewer or
scope/cursor/access, session replacement during reads, and exact organizer/publication opening. Existing publication
selection assertions remain unchanged. Mounted browser/native/Storybook and broader acceptance are deferred to the
dev verifier; implementation verification is changed-file formatting and the affected Web typecheck only.

### Native inventory titles

Decision: the shared owner list/exact-get decoder accepts the generated optional `title` as a string bounded to
512 UTF-16 units. The existing Book link displays that admitted title verbatim, wrapping long unbroken labels;
only an absent title uses the localized catalogue-ID label. Destination catalogue/account/epoch, opaque cursors,
session and coverage binding, creation date and visibility retain their existing behavior. Both native methods
already use the shared decoder, so no adapter change or enrichment request is needed.

Sources read before design: `hosted-contract.ts`, `hosted-native.ts`, `workspace.tsx`, this owner document,
the existing inventory fixtures and link builder, installed client owner-list/get declarations, and Content's
[author inventory](../../../../services/kernel/src/content/hosted-chapters.md#author-inventory) note.
The named native and generated-client dependencies are present on the base; no integration change is needed.

Deferred acceptance: the dev verifier runs `bun run --cwd apps/web test tests/studio-hosted-inventory.test.ts
 tests/studio-hosted-inventory-view.test.tsx`. Updated transport fixtures cover titles present/absent in both reads
and the native string bound; the view fixture pins the title, ID fallback, exact destination and unchanged date
and visibility. Existing assertions remain. This source pass formats changed files and runs one Web typecheck;
mounted native, browser, Storybook and broader acceptance remain deferred.

## Exact Book history

Decision: the existing Book organizer mounts author history only when requested, with an isolated read-only exact
outline beside the editable draft. Closing the disclosure destroys its visit. History never enters the draft adapter,
release selection, review or publication commands; the current draft remains usable throughout inspection.

The authenticated session-bound BFF calls `hosted_catalogue.history`, requesting at most 20 metadata rows per page.
It performs no detail reads while listing. Native timestamps retain their original precision and offset; current-draft
and current-release markers are native page observations, not comparisons with the loaded draft. Both revision kinds
share native ordering. An empty release is shown as a withdrawn release when its exact outline is opened.

Each mounted visit owns its opaque cursor and exact inspector. Retry repeats the failed cursor; stale continuation
requires an explicit restart. Empty first history, empty continuation pages, denied access and unavailable reads have
distinct presentation. Failed replacement pages remove old rows and outlines. Duplicate/repeated continuations cannot
loop. Browser account or session replacement, including replacement by the same account, permanently retires the visit,
aborts its reads and discards late responses. Book navigation and closing the panel dispose the same lifetime.

Decision: selecting a listed entry owns one `HostedOutlineWindow`, pinned to its catalogue, kind, revision, source
revision and viewer generation. Inspection makes one authenticated outline request per explicit page action and keeps
only that page; it never calls the complete-tree reader, hydrates metadata or traverses parents. Native preorder and
safe sibling positions survive pages beginning inside a part. The flat read-only list shows withheld slots using only
their admitted addresses and kind, without a title or target, and synthesizes no ancestry. The draft editor, organize
and publication command paths keep their complete-tree bounds; root append uses the separate bounded visit described below.

Next explicitly requests the opaque continuation; retry repeats the failed cursor, including rejected continuations.
Loading or failed replacement pages remove the prior outline. History-page replacement, another selection, closing
inspection/disclosure, Book departure and session replacement retire the old window and discard late results. Only an
empty initial terminal page means an empty structure or withdrawn release; empty continuable and terminal continuation
pages remain page observations. Current flags and history listing retain their native metadata behaviour. The native
author-history permission remains authoritative; public release access never grants history discovery.

Sources read before this receiving design: this owner document, `hosted-history.ts`, `hosted-history-view.tsx`,
`hosted-history.test.tsx`, `hosted-outline-window.ts`, its source fixture, `hosted-contract.ts`, `hosted-native.ts`,
`hosted-actions.ts`, the `hosted-workspace.ts` binding, `routes/studio.tsx` caller and historical reader provenance.
The base already supplies the authenticated one-page window; no merge, cherry-pick, Backend or inventory change is
required. The inspector lazily binds that existing BFF capability when its disclosure mounts.

Later acceptance: the dev verifier runs `bun run --cwd apps/web test src/studio/hosted-history.test.tsx
 tests/studio-hosted-inventory.test.ts tests/studio-hosted-publication.test.ts`. History cases cover metadata-only
paging and exact retry, native timestamps/markers, empty/denied/unavailable/stale states, exact identity and chapter
order, withdrawal, session replacement, late selections and disposal. The updated focused source fixture also pins
mid-part pages, safe positions, withheld slots, sparse continuations, exact page retry and browsing over 512 entries
without retaining earlier pages. Exact identity assertions now exercise the existing external page adapter, while
selection assertions use the page wire instead of a whole Book. Existing publication and inventory assertions
remain unchanged; their native doubles include history. Native, browser, Storybook and broader acceptance remain
deferred; this source pass uses changed-file formatting and the affected Web typecheck.

## Book history language

Decision: the mounted Book history and exact outline inspector use current-locale messages in all eight launch
locales, sharing existing Studio catalogue/retry/digest and Book part/chapter terms and using `studio_book_history_*`
for the remaining copy. Metadata has no Book title: title-bearing inspection names combine the localized saved
structure/release title with the exact revision ID. Supplied chapter labels, IDs, digests, native microseconds/offsets
and sibling positions stay intact. Error copy follows the existing safe failure kind instead of rendering native
English messages; unavailable reads never become empty outlines or invented chapters. Focus return, exact-cursor
retry, one-page bounds, withdrawal and session retirement keep the existing read-only lifecycle.

Sources read before design: this owner document, Web's [Goal](../../../../docs/goals/web.md#done-when),
`hosted-history-view.tsx`, the existing `hosted-history.test.tsx` fixture, `hosted-history.ts`,
`hosted-outline-window.ts`, the exported history/failure contracts and native error mapping, and the current-locale
handling in `revisions.tsx` and its existing saved-version language fixture.

Deferred acceptance: the dev verifier runs `bun run --cwd apps/web test src/studio/hosted-history.test.tsx`.
The focused locale fixture spans the list and an exact sparse/withheld outline, preserving focus, native identities,
retry cursors, escaped supplied labels and localized failures. Existing English assertions remain where meaning
matches; raw-error assertions now expect classified copy. Source checks are locale key/parameter parity,
changed-file formatting and one affected Web typecheck. Browser, native, Storybook and broader acceptance are deferred.

## Author Book withdrawal

Decision: Studio offers a separate withdrawal review only for an admitted currently published Book with a nonempty
current release. Ordinary publication still requires selected saved chapters. The review names the exact current
release and requires explicit confirmation: withdrawal removes the Book from current discovery, preserves drafts
and the editable outline, and leaves historical exact releases and chapters under their existing access rules.
Columns and article publication keep their existing flow.

Withdrawal uses the installed `hosted_catalogue.publish` command with an empty occurrence selection, the reviewed
structure revision and current publication revision. It retains the existing session, native authority, conditional
write and idempotency recovery. Success requires the acknowledged empty withdrawal revision, the matching owner
publication pointer and an admitted current empty release. The native discovery contract excludes that empty
release; Studio does not scan Subject pages to infer absence. A null pointer, unavailable read, mismatched current
release or nonempty receipt cannot confirm withdrawal. Uncertain recovery repeats the same command and key even
after review expiry; stale CAS requires a fresh review after reopening the current Book. Saved chapters can later
be selected and republished with the withdrawal release as the publication precondition.

Sources read before design: `hosted-workspace.ts` review/publication, `hosted-native.ts`, `hosted-adapter.ts`,
`controller.ts`, `contract.ts`, `publication.tsx`, the organizer/workspace callers, existing hosted publication and
inventory tests, and Content's [hosted catalogue contract](../../../../services/kernel/src/content/hosted-chapters.md)
(authoring/release, current discovery, exact reads and author history). The installed native API already supports
empty releases; no merge, cherry-pick or backend change is required.

Deferred acceptance: the dev verifier runs `bun run --cwd apps/web test src/studio/publication-withdrawal.test.tsx
 tests/studio-hosted-publication.test.ts tests/studio-hosted-inventory.test.ts`. Focused cases cover the exact review,
confirmation control, admission, empty-publish rejection, stale CAS, lost receipts, null/unavailable readback, review
expiry during retry, session replacement, preserved drafts and subsequent republish. Existing selection assertions
remain unchanged. Native acceptance verifies author withdrawal and subsequent republish, current discovery removal
and historical exact release/chapter reads with unchanged current Access checks. Native, browser, Storybook and
broader acceptance are deferred to the dev verifier; this source pass uses changed-file formatting and the affected
Web typecheck.

## Start a Book from a saved opening

Decision: the current account-draft visit offers Start a Book only for its admitted, saved, clean native opening.
The action freezes that Post/thread, empty placements and one idempotency key. An uncertain command retries those
same operands; a successful create or existing-catalogue conflict switches to exact owner-read recovery without
creating another draft. Document controls remain held during recovery. The exact owner response must match the
Post/thread and account/authn epoch before its existing owner href can open Book Studio. Session generation
replacement, including the same viewer, aborts requests and discards late responses. This creates a private outline;
the Post body, visibility and ordinary article publication lifecycle remain independent.

Sources read before design: this owner note, `routes/studio.tsx`, `account-port.ts`, `workspace.tsx`,
`hosted-actions.ts`, `hosted-contract.ts`, `hosted-native.ts`, `hosted-inventory.ts`, the native
[Hosted catalogue authoring contract](../../../../services/kernel/src/content/hosted-chapters.md#authoring-and-release),
`hosted-workspace.ts`, `hosted-adapter.ts`, and existing native-draft and hosted-publication fixtures. The native
create, saved opening admission and exact owner response are already installed on the base; no integration commit
or API change is needed. The read-only history inspector remains independent.

Deferred acceptance: the dev verifier runs `bun run --cwd apps/web test tests/studio-hosted-book-start.test.tsx`.
Focused cases cover clean saved-opening eligibility, start, duplicate clicks, exact uncertain retry, existing Book
reopen, owner-read retry, mismatched viewer/identity, session replacement and first exact chapter placement through
the installed replacement command. Mounted native/browser acceptance must also exercise the account draft visit →
Start a Book → Book Studio path, retained retry, existing Book reopen, stale viewer disposal, and first saved chapter
placement. Source fixtures do not claim native/browser proof. Existing assertions remain unchanged. Source validation
formats changed files and runs one affected Web typecheck; ordinary acceptance, native/browser, root and growth
suites remain deferred.

## Saved account draft picker for Books

Decision: an existing Book offers one explicitly opened account-draft picker, sharing the installed own-drafts
list/resume reader and the existing exact Post port. Selection opens the saved discussion opening in the shared
editor; only the organizer's separate chapter placement revises the outline, at Book root or an existing part.
The picker sends the Book's prepared account/authentication epoch on every page and resume, compares the exact
Post/thread/revision, body, media and native metadata, and relies on the Post port's existing owner and digest checks.
It changes neither native permissions nor publication.

One replacing page retains at most 20 metadata rows and one opaque continuation. No list/body is prefetched, no ID
entry is required, and no document body is stored by the picker. Sparse/preparing pages retain continuation; failed
pages retry their exact cursor. Replacement, close, stale/denied selection, session replacement (including the same
account) and departure retire former rows and abort or fence late results. Dirty, invalid, pending or uploading
editor work and unresolved commands hold selection. The shared controller opens only after its existing clean-editor
guard. Admission retains just the selected candidate identity, the Book opening and currently attached document
identities; picker-enabled Book document summaries drop former unplaced selections and removed attachments.

Sources read before design: this owner document, Web's launch scope and acceptance in `docs/goals/web.md`, mounted
Book and account visits in `routes/studio.tsx`, `account-port.ts`, `post-document-port.ts`, `hosted-workspace.ts`,
`threads/own-drafts/model.ts`, `native-reader.ts`, `visit.ts`, and the organizer/controller contracts and existing
placement, native-draft and hosted-publication fixtures. The installed list/resume and replacement revise contracts
already support this journey on the base. No integration or backend/API change is required.

Deferred acceptance: the dev verifier runs `bun run --cwd apps/web test tests/studio-hosted-draft-picker.test.tsx`.
Focused mounted source evidence covers an independently saved own opening selected and placed exactly under a part,
unchanged outline/publication before placement, sparse continuation and exact retry, page/selection retirement,
foreign/stale refusal, same-account replacement, late responses and dirty editor preservation. Existing assertions
remain unchanged. Source validation formats changed files and runs one affected Web typecheck; native, browser,
Storybook, ordinary acceptance, root and growth checks remain deferred.

## Shared release review language

Decision: Book and article release review uses distinct `studio_release_*` messages in all eight launch locales,
locale-selected plural chapter/article counts and complete messages around exact revisions and expiry timestamps.
Visible copy and accessible names share the mounted locale. Existing withdrawal and account approval messages,
review/confirm/withdraw lifecycle, user content, pinned outline, exact versions, current/empty meaning and unavailable
states retain their contracts. Shared controls and semantic publish/cancel messages remain in use.

Sources read before design: this owner document, Web's [outcome and acceptance](../../../../docs/goals/web.md),
`publication.tsx`, its withdrawal fixture, `revisions.tsx`, exported Studio contracts and controller review/publish
callers, and the existing hosted publication and mounted saved-version language tests. The base still contains
English release review copy; no merge or cherry-pick is needed.

Deferred acceptance: the dev verifier runs `bun run --cwd apps/web test tests/studio-publication-language.test.tsx
src/studio/publication-withdrawal.test.tsx tests/studio-hosted-publication.test.ts`. One focused mounted German
example covers exact review, accessible confirmation and outcome copy; existing assertions stay unchanged.
Source verification checks changed-file formatting, locale key/argument consistency and one affected Web typecheck.
Ordinary acceptance, native, browser, Storybook and broader suites remain deferred.

## Open the published Book

Decision: a dedicated action beside the publication panel uses the shared localized `HostedBookReaderLink` and
pins the current confirmed nonempty release in `release`. It never selects the draft or an implicit latest release.
The owner-only read is insufficient: the catalogue Post must be published and one anonymous native catalogue
metadata read must admit that exact publication. This read uses the existing generated operation without author
credentials, chapter bodies, outline hydration or per-entry requests. The destination performs normal current
reader admission again. Private/protected catalogues, denied/unavailable public reads, draft-only Books and empty
withdrawal manifests have no action.

The action is a visit-local projection bound by `hosted-workspace.ts`. Fresh owner observations reconfirm or remove
it; starting a publication command clears it. Only the verified release and matching owner pointer can restore it,
including recovery with the original idempotency key. Failed/uncertain commands and session retirement cannot
leave a stale action. The optional workspace binding occupies one slot after `StudioPublication`; the publication
panel, draft picker and history retain their owners. Following the link uses the existing reader and changes no
Studio draft, working document or chapter selection: it opens a new tab with `noopener`, leaving Studio mounted.
The shared link's optional new-tab target retains its default navigation elsewhere and supplies the existing
localized new-tab hint here.

Sources read before design: this owner document, [Web acceptance](../../../../docs/goals/web.md#acceptance),
`hosted-workspace.ts`, `hosted-adapter.ts` confirmation/readback, `controller.ts`, `contract.ts`, the mounted workspace
and route callers, `books/reader/link.tsx`, its address/native API contracts, and Content's
[hosted reading contract](../../../../services/kernel/src/content/hosted-chapters.md#reading).

Deferred acceptance: the dev verifier runs `bun run --cwd apps/web test tests/studio-hosted-release-reader-link.test.tsx
 src/studio/publication-withdrawal.test.tsx`. The focused fixture pins the real-shaped exact localized href, a single
anonymous metadata request, private/public refusal, draft-only and withdrawn states, replacement/recovery, unchanged
selection and structure, and session retirement during admission. The withdrawal fixture supplies the new public
admission dependency with existing assertions unchanged. Source verification uses changed-file formatting and one
affected Web typecheck after commit; ordinary acceptance, native, browser, Storybook and broader checks are deferred.

## Hosted Book author-to-reader witness

Decision: keep the private author and prepublished reader journals independent; compare and preview saved revisions,
organize and select exact draft occurrences through mounted Studio, recover and seal the selected candidate, record
initial activation as unreached with its immutable operands, and use supplied catalogue titles with the existing
fallback. Resume the author journal only after Content exposes activation through the mounted HTTP route and
generated KernelClient operation; the point-publication control remains a separate outcome.

The private author journal creates deterministic drafts through generated native setup, saves and compares exact
Post revisions in the mounted Studio, previews the saved chapter, and creates, reorders, moves and nests chapter
occurrences through current controls. It then confirms the current draft and absent release, selects one exact root
chapter, reloads through its selected-stage locator, freezes the single occurrence, advances and seals a private
candidate. The mounted route stops there: the producer `activateHostedPublicationCandidate` has no installed HTTP
route or generated KernelClient operation. The journal retains the catalogue, native owner and epoch, source head,
absent expected release, stage ID, selected occurrence and exact Post/revision/digest as immutable operands. It does
not call the old batch publication route or claim that the sealed candidate is public. A later private Post revision
and structure move verify that the current draft still names the candidate's original exact source. The private
author's anonymous release bytes, member progress and stable reader link remain unreached.

The independent control begins with its native one-chapter release, then uses mounted Studio to save another exact
version of that private Post, add a second draft occurrence, issue exact source permission during point review, and
explicitly publish that occurrence. The journal checks that permission alone leaves the current release unchanged,
then checks the exact published bytes and direct-Post privacy. A different member discovers the supplied Book title,
reads the original exact chapter, saves and resumes a Library checkpoint, and opens the old release/occurrence link
after a later move and withdrawal. This control demonstrates the installed point-consent and reader paths; it does
not complete the private author's missing initial activation.

Legacy parity comparison: at `legacy-final` revision `95167ceab7173dc1c5fb0ee70568c5c95f1dba8d`, chapter history
and comparison, ordered nested Book contents, reading progress and resume already existed. The mounted witness pins
those same user behaviors. Legacy reader links addressed a Book and node without explicit release and occurrence
coordinates; the current canonical reader carries both, and the independent control has an assertion for its frozen
old link after a move. That source comparison and assertion are recorded here; the current mounted result remains
unverified until the controller run.

The command and stage report are documented in the native test
[README](../../tests/native/README.md#hosted-book-author-to-reader-journey). The candidate controller runs the mounted
witness once after integration; it is deferred during the worker source pass.

## Private Book release preparation

Decision: Book Studio freezes the admitted catalogue, exact draft and known release (including proven absence) at
explicit review, prepares the whole draft or an explicit selection in bounded interruptible steps, and seals only
native candidate readiness.
The existing release stays current. Pause stops before another request; an ambiguous command retains its exact body,
step and key for replay. Remount reads native progress under current admission using only the catalogue/stage locator
in the private Studio URL. No placements, credentials or command bodies enter storage or URLs. Session or catalogue
replacement aborts the visit and discards late replies. Activation remains a separate outcome.

Sources read before design: Content's [Authoring and release and Prepared Book publication](../../../../services/kernel/src/content/hosted-chapters.md),
`hosted-publication-preparation-routes.ts`, `hosted-publication-preparation-schemas.ts`, the focused native HTTP test
`hosted-publication-preparation-http.test.ts`, architecture's [Release selection and retention](../../../../docs/architecture.md#release-selection-and-retention),
`routes/studio.tsx`, `hosted-legacy-baseline-native.ts`, and `hosted-publication-point.ts`.

Decision: one focused state/transport proof covers retry, remount and stale authority, with only the named interrupted
desktop and expired narrow stories. The mounted preparation methods are absent from generated KernelClient emission;
the existing typed proxy extension seam binds them locally. Deferred acceptance: `bun run --cwd apps/web test
tests/studio-hosted-release-preparation.test.tsx`; browser, native, ordinary acceptance and Storybook builds stay with
the dev verifier. Source verification uses changed-file formatting and the Web workspace typecheck.

### Selected release preparation

Decision: selected release preparation uses the same lifecycle with one exact draft outline window and one pending
page batch. Each batch keeps its routed ID, idempotency key and exact operands until acknowledged; an unknown append
must resolve before navigation, new choices or freeze. Only native counts describe retained input, including duplicate
settlement. Input must be nonempty and explicitly frozen before building; withdrawal remains the separate action.
Ancestors must be selected explicitly, and native incomplete, missing-ancestor and stale-source results require fresh
review and a new stage. Account, source, draft and visit replacement retire the window and discard late replies.
Decision: collecting progress returns only the stage's immutable source revision, expected draft and expected release
IDs. After reload, Studio reads the current owned Book, compares both current pointers, then opens one bounded outline
page at the retained source revision. A changed pointer requires fresh review; native append checks both pointers,
while an exact prior receipt still replays. Older receipts can omit these additive IDs; the client reads fresh
progress for the binding before opening a page. No current draft is substituted and no selected-ID listing is added.

Selection sources read before design: the [Prepared Book publication contract](../../../../services/kernel/src/content/hosted-chapters.md#prepared-book-publication),
`hosted-publication-preparation-routes.ts` and schemas, the existing preparation visit and transport,
`HostedOutlineWindow`, and the owner outline transport. Focused deferred acceptance adds
`tests/studio-hosted-release-selection.test.tsx`; the stories cover two-page desktop input, same-stage recovery after
reload and narrow lost-batch recovery with the existing published release unchanged.

## Exact source permission in point review

Decision: the exact saved-version point review offers an explicit source Post issue command for one version and
one Book, followed by explicit revoke of only the receipt acknowledged in that author visit. Initial native state
is unknown: there is no consent lookup, durable list or extra request for an already-public source. The selected
thread/Post/revision/digest and Book are frozen with a new key per deliberate command; uncertain replies replay
that same command and CSRF binding. Source, account, session or visit replacement clears receipts and fences late
replies. Raw receipts, locators and command keys stay in memory, outside rendered copy, URLs and storage.

Issue does not publish the source or Book, retry publication or confer client-side source authority. Native Post
admission decides issue/revoke and exposes denial independently of native Book publication and current Access.
Generic failures leave permission state unknown. HTTP receipt validation binds the Book, expected issued/revoked
state and, for revoke, the exact receipt ID. Whole-release preparation is unchanged.

Sources read before design: Content's [Private-to-public boundary](../../../../services/kernel/src/content/hosted-chapters.md#private-to-public-boundary),
`revision-disclosure-routes.ts`, `revision-disclosure-schemas.ts`, generated Post client operations, this owner,
`hosted-publication-point.ts`, `hosted-publication-point-view.tsx`, `hosted-draft-point-entry.tsx`,
`hosted-source-consent-view.tsx`, `hosted-release-preparation-actions.ts` and the existing point/preparation fixtures.
The point route and exact-version source permission controls are mounted. The journey uses them only on the
prepublished control, where point publication is available; they do not supply the missing initial activation route.

Deferred acceptance: `bun run --cwd apps/web test tests/studio-hosted-source-consent.test.tsx`. Focused coverage
pins explicit issue/revoke without publication, exact retry operands and key, denial, selection/session retirement
and response identity/state checks. Illustrative stories show same-author desktop review, issue and explicit
revoke, plus narrow denial and lost-reply replay. Source verification formats changed files and runs the Web
workspace typecheck after commit. Native, browser, ordinary acceptance, root and Storybook checks stay deferred.

## Prepared Book release activation

Decision: keep ordinary Studio preparation-only while Content's activation producer is unmounted; retain the existing
injectable consumer and resume its direct generated binding only after native currentness acceptance. Add no further
seam or inferred HTTP operation. Point publication stays independent. Deliver the generated transport binding and its
focused transport and ordinary-entry assertions together once that producer exists, retaining the injectable
assertions. One visit retains the exact catalogue, stage, source,
sealed candidate generation and previous release.
Each explicit check advances one native page of at most 20 targets; pause retains the candidate, and a native restart
uses explicit advance to reset authority without preparing or sealing again. Readiness never activates a release.
The final Activate action is separate. Progress, pass identity and decimal counts come from native replies.

An ambiguous command retains its original body, idempotency key, viewer comparison and CSRF credential in memory for
exact replay. Reading a current publication cannot settle that command. Once activation is acknowledged, current
owner publication and exact native publication metadata are reread before the existing anonymous exact-reader
admission can offer the shared reader link. The sealed candidate supplies nonempty chapter evidence for that exact
generation. Readback retry does not resend activation or discard its receipt. A changed current release, private
opening, absent public admission or empty candidate offers no link. Session, credential, source, catalogue, stage,
candidate or locale replacement retires the visit, aborts its requests and discards private effects and late replies.
Only the existing catalogue/stage locator remains in the private URL; no activation state enters URL or storage.

Sources read before design: [Web Book acceptance](../../../../docs/goals/web.md#acceptance), this guide's
[private preparation](#private-book-release-preparation), Content's
[Prepared Book publication](../../../../services/kernel/src/content/hosted-chapters.md#prepared-book-publication),
`services/kernel/src/content/hosted-publication-activation.ts` and its focused
`hosted-publication-activation-currentness.test.ts`, preparation contract/controller/entry/actions/native/view,
`hosted-release-reader-link.ts`, its anonymous admission/action, and the existing preparation tests and stories.

Content's [handoff](../../../../services/kernel/src/content/hosted-chapters.md#release-candidate-disposition-and-implementation-handoff)
requires native two-pool currentness acceptance before mounting `startHostedPublicationActivation`,
`advanceHostedPublicationActivationAuthority` and `activateHostedPublicationCandidate`. Preparation routes and
generated KernelClient lack these operations. Bind them to
`createHostedReleaseActivationTransport` through `HostedReleasePreparationEntry.activation` with current private
admission/no-store, existing owner/publication reads and anonymous exact-reader admission. No guessed endpoint,
handwritten Client method or Studio fixture supplies this producer.

Binding preflight reads that handoff, `services/kernel/src/content/hosted-publication-preparation-routes.ts`, generated
`packages/client/src/kernel/content/hosted-chapters-routes.d.ts`, the activation contract/native transport/entry,
preparation entry and `apps/web/tests/studio-hosted-release-activation.test.tsx` before choosing the integration.

Deferred acceptance: after integration, run `bun run --cwd apps/web test tests/studio-hosted-release-activation.test.tsx`.
Focused cases cover explicit checks/activation, pause/restart, same-intent replay, observations versus receipts,
readback retry and exact-reader admission, malformed external progress, replacement and late replies. Three stories
exercise the consumer with explicitly illustrative operations: desktop checks then activation, narrow authority
restart retaining the candidate, and lost-reply recovery. These are source/interaction evidence only. The verifier
must use the ordinary Studio preparation entry to activate a real sealed private candidate, receive the acknowledged
publication receipt, match that receipt to the current owner publication and pass anonymous exact-reader admission.
Injectable tests and illustrative stories cannot prove this journey. Native/browser/root/growth suites and promotion
acceptance remain unverified here.
Source validation formats changed files, runs the design detector once and submits one final affected Web typecheck.
