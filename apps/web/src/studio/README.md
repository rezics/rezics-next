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
