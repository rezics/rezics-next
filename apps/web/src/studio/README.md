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

Decision: The shared book/article Studio puts the active document first, collapses outline and drafts into a compact
phone disclosure, and separates its wide navigation without an outer frame.

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

Selecting a listed entry uses the existing native exact reader with catalogue, kind and revision ID. Its admitted
source structure must also match the entry. The inspector presents native chapter order and pinned versions without
editor, placement or publication controls. An unavailable exact tree stays unavailable rather than showing a partial
or empty outline. The native author-history permission remains authoritative; public release access never grants
history discovery.

Sources read before design: this owner document, `book-organizer.tsx`, `hosted-actions.ts`, `hosted-native.ts`,
`hosted-contract.ts`, their workspace and inventory callers, and Content's `hosted-chapters-routes.ts`,
`hosted-chapters-schemas.ts` and [author-history contract](../../../../services/kernel/src/content/hosted-chapters.md#author-history).
The base already includes the generated history client; no backend or inventory change is required.

Later acceptance: the dev verifier runs `bun run --cwd apps/web test src/studio/hosted-history.test.tsx
 tests/studio-hosted-inventory.test.ts tests/studio-hosted-publication.test.ts`. History cases cover metadata-only
paging and exact retry, native timestamps/markers, empty/denied/unavailable/stale states, exact identity and chapter
order, withdrawal, session replacement, late selections and disposal. Existing publication and inventory assertions
remain unchanged; their native doubles include history. Native, browser, Storybook and broader acceptance remain
deferred; this source pass uses changed-file formatting and the affected Web typecheck.

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
