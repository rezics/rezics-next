# Hosted Book reader

`HostedBookReader` is the Book reading profile of Content's shared Studio. The production route mounts the retained
native adapter and `PostReadingBody`, which owns readable measure, outline, spoilers, references and admitted media.
Semantic Work, Series and Edition bibliography stays with the [literary catalogue reader](../../features/catalogue/literary-reader/README.md).

Decision: mount the retained reader at the localized `/books/$id/read` route; resolve URL release/occurrence selections
through native public catalogue disclosure and the prepared session, retain bounded return coordinates in links,
and reread on browser return. The current literary Subject view links to the same route's bounded Subject catalogue
view. The reader uses Library's native hosted-reading checkpoint with explicit save/resume/clear and block-level
positions; no automatic write or ordinary Progress conversion occurs. Hosts use the declared `books/reader/route.tsx`
composition entry.

The entry's `hostedBookNavigationForRouter` owns the bounded contents/focus visit and its subscriptions. File routes
supply their existing Router and QueryClient. Search-only loader replacement retains that Router's visit; successful
session replacement and `pagehide` retire its coordinates and pending focus. A pathname departure also removes the
session, page and route subscriptions and the Router entry, so returning starts empty. Frozen release, occurrence,
contents return and Back/Forward rereads keep their existing meaning.

Existing [reader stories](../../stories/hosted-book-reader.stories.tsx) cover `MultipleContentsPages`,
`NestedLevelReturn`, `FailedPreviousRetry` and `RetiredReading`; these states need no additional variants for entry
composition changes. The production route and subscription retirement witnesses remain in
[hosted-book-reader.test.tsx](../../../tests/hosted-book-reader.test.tsx).

## Production admission and links

`routes/books.$id.read.tsx` follows the existing file-route generator and locale rewrite. It has no public cache,
preload cache or stale route payload: `staleTime: 0`, `gcTime: 0`, `shouldReload: true` and `sessionReread: true`.
The default catalogue visit is the current public publication's root contents. Subject discovery uses the same
route with `view=catalogues`; its path ID is then the Subject ID. It calls the generated
`subjects({id}).hostedCatalogues.get` once with `includeTitle=1`, `limit=20` and the original optional opaque cursor
on initial, continuation and Retry reads. Empty and sparse windows retain More when supplied, and Retry rereads
the same URL. Each row opens its disclosed publication and retains `subject` in subsequent exact chapter and
contents links. `readHostedBookVisit` prepares the native Web
session, reads the current publication with the installed generated catalogue operation, resolves any frozen
release and selected occurrence, and produces `NativeHostedBookAdmission` for this visit. An omitted or empty
catalogue title uses the localized Book title; it does not refuse an otherwise readable chapter. Credentials never enter URLs or
loader data. Missing native origin never falls back to Web's development fixtures.

Decision: Subject discovery opts into native list titles independently of point admission. Its strict HTTP decoder
accepts an optional string of at most 512 characters through the generated page type. Validated items omit an
undefined title while preserving every other field, matching the generated exact optional property. Each nonempty admitted title
is ordinary escaped link text describing the current admitted public opening, not a frozen historical title;
an omitted or empty title uses the existing localized numbered publication label. Supplied order, exact destinations
and 44px link targets stay unchanged. Every explicit page is one list request of at most 20 rows with no per-Book
metadata/body reads, refill or hydration. Native cursors bind the title opt-in; an incompatible cursor keeps changed-state
recovery with its original operands, rather than changing query mode or becoming an empty page.

Decision: the existing current-publication admission GET separately opts into `includeTitle: '1'`. Its strict point
response decoder accepts an optional string of at most 512 characters, matching Content; the private reader input
retains that bound. The admitted label describes the currently public opening even for a frozen historical
selection. Only that admission supplies the display label; omitted or empty labels use the current localized
fallback, with no inference from the URL, draft, chapter body or previous visit. Frozen coordinates, current-access
rechecks, header composition and request counts stay unchanged. Neither receiver infers titles from IDs, a draft,
previous visit, URL or chapter. Occurrence/page response shapes and 256-character occurrence titles stay unchanged.

URL values are HTTP selections, validated at the boundary in `address.ts`, not admission or expected credentials.
The host always asks for `kind: publication`; a private structure revision cannot turn into a public draft read.
The native target supplies the exact Post ID, body revision and SHA-256. Current catalogue and target disclosure
still authorize each source read. There is no new authorization protocol for internal callers.

`HostedBookReaderLink`, `hostedBookHref` and `hostedBookAddressHref` are exported by the declared public composition
entry. Catalogue can open current contents with its native catalogue ID; Studio can supply its published release.
For example, these are installed Web links, not hypothetical Content endpoints:

```tsx
import { HostedBookReaderLink } from '../reader/route';
// The existing catalogue/Studio observation supplies this ID and optional published release.
<HostedBookReaderLink catalogueId={catalogue.id} releaseRevisionId={catalogue.publishedRevisionId} />;
```

Canonical links use `/{locale}/books/{catalogueId}/read`. Their bounded search coordinates are:

| Field                          | Meaning                                                                            |
| ------------------------------ | ---------------------------------------------------------------------------------- |
| `release`                      | Frozen native publication revision; omitted only to select the current publication |
| `occurrence`                   | Stable native placement; exact target is resolved from that frozen publication     |
| `view`                         | `chapter`, `contents`, or Subject `catalogues`; no occurrence defaults to contents |
| `subject`                      | Subject associated with the discovery link; native Library validates every save    |
| `parent`, `cursor`             | One bounded contents level and its opaque continuation                             |
| `returnParent`, `returnCursor` | Originating bounded contents position retained by a chapter link                   |

No ordinal, current Post head, semantic relationship or scalar progress creates an occurrence selection. Reused
bodies have different occurrence links even when their exact Post/revision/digest is identical. A move changes
current ancestors while an old frozen link retains its original body. Modified activation opens an ordinary native
link. Normal activation uses the application Router; Back/Forward restores URL coordinates, prepares admission again
and rereads through the native source. Reader state never stores a previous body or rows in history.

## Source and retirement

`source.ts` defines the typed consumer projection. Each mounted explicit open, More, Retry or return makes one
`source.read({ address, locale, limit: 40, ancestorLimit: 24 }, signal)` observation. The route first makes one bounded
host observation: current publication, optionally frozen publication, optionally the selected occurrence. It does
not download contents or descendants. No prefetch, refill, per-row hydration or tree index is retained.

A publication identifies native catalogue, frozen source structure and separate publication release. A chapter
selects occurrence plus exact Post/revision/SHA-256. Contents preserves native order and container/body/unavailable
slots. Sparse or empty windows can continue. More and Previous replace the window; failure retries the same parent/cursor.
Pages separately report current release/structure, bounded ancestors and previous/next. Known ends and unavailable
navigation remain different states. Returning to contents retains the exact selection and focuses its row when
present, otherwise the heading; a moved selection retains an exact chapter return and current-location control.

`native-api.ts` calls the generated `KernelClient.hostedCatalogues` catalogue, children, occurrence and navigation
operations, including occurrence metadata. Response types derive from those operations; runtime schemas validate external responses. Canonical
bytes are decoded, digest-checked and passed to the existing Document validator. The [Content owner](../../../../../services/kernel/src/content/hosted-chapters.md)
owns release immutability, unavailable slots, cursor binding, target admission and native limits. Each private BFF
read prepares the real session and checks that it still matches the admitted anonymous/session subject.

Decision: occurrence, contents/navigation and checkpoint metadata receivers accept exact nonnegative safe-integer
positions through `Number.MAX_SAFE_INTEGER`, including 512. Each owner uses Valibot's `safeInteger` without a new
cross-owner codec. Studio's 0–511 full-replacement input bound and the reader's page, occurrence-title, body, exact-selector,
viewer/target, retirement and document-offset bounds stay unchanged. Focused decoder fixtures establish Web
compatibility only; native acceptance runs in the dev verifier. Library's server metadata response uses the same
safe-integer ceiling, independently of Studio's bounded replacement input.

The route supplies a fresh `NativeHostedBookAdmissionSource` for every loader observation; synchronous replacement
retires the former reader. Other hosts must likewise replace their snapshot and notify on publication, current
structure/target or prepared-viewer replacement, including equal-value and A/B/A replacements. Source, session,
route, locale and admission replacement remove body, rows, return state and pending focus. Advisory abort is backed
by visit/connection/request checks before dispatch, completion and focus. A pagehide retires the visit; deliberate
reopen refreshes its native host admission. Explicit source reads check current release/structure and target access;
there is no background access polling or claim of a native cross-request transaction.

Decision: route selection, Contents selection, parents, ancestors and historical currentness use the generated
occurrence metadata operation with strict response decoding and no body fallback. Only an opened chapter calls the
body resolver, once for its frozen exact selection, retaining canonical byte and digest verification. When that
response also proves the current release, it supplies currentness without duplicate occurrence metadata. Historical
and current releases may differ; current admission never replaces the frozen target.

The native mapper observes frozen and current releases, checks occurrence identity against each selected revision,
reads only its bounded ancestor path and at most one neighbour per direction, then rechecks both releases. Current context
uses the current public release, never a private Studio draft. Children/neighbours use the frozen release. A
current parent absent from the frozen release may be unavailable; no alternative body/tree is substituted.

## Presentation

Decision: use one restrained reading column, linked work/part breadcrumbs and bounded contents rows whose titles
open their chapter or nested level. Containers with a body retain separate Read and Contents destinations. Current
selection remains visible and focusable; sparse windows keep their exact More/Retry operands. The chapter uses
Content's existing multilingual prose measure, outline, wide blocks and anchor renderer. Compact chapter navigation
can be pinned or unpinned without changing the body, focus or saved position. Unpinned navigation shows full neighbour
titles; pinned navigation keeps their full accessible names. Checkpoint Save and Continue remain directly available;
saved-position review and Clear sit in a disclosure. Progress extensions follow the body and fail independently.

Decision: this frontend source-only refactor window defers tests, typing, builds, browser, capture and native
acceptance to the dev verifier, overriding generic worker verification instructions. Preserve existing regression
sources and exact-link/block-anchor repairs. Manual review stories use illustrative installed contracts; they do not
establish native publication acceptance. No new API, progress store, automatic save or authorization rule is introduced.

## Controls and progress

Keyboard navigation focuses the heading while its original focus intent remains. Pointer activation never schedules
a focus transfer. Contents return focuses the selected occurrence where present. Choosing
a shared search/header control during navigation or moving focus during a request cancels the transfer. Arrow
navigation stays inside the reading region, mirrors the document direction, and respects text selection, editable
and interactive controls, modifiers, held keys and input methods. Controls wrap with 44px targets and phone safe
area spacing; the document's language/direction is independent of the interface locale. Eight launch locales cover
controls and recovery: en, zh-Hant, zh-Hans, ja, ko, de, fr and es.

Decision: initial checkpoint observation and successful save/clear readback use the published
`libraryHostedReading.metadata.get` endpoint, one body-free private request per observation. The checkpoint UI never
uses the byte-bearing checkpoint get; opening a chapter keeps its existing Content admission and exact canonical-byte
verification.

`checkpoint.tsx` renders the native Library checkpoint within the admitted page lifetime. It makes one private
metadata request after the chapter or contents is ready, using the prepared session and expected viewer.
Anonymous and catalogue-only visits perform no private read. Subject discovery links supply the Subject; callers
may also pass it to `HostedBookReaderLink`. The native save validates the Subject/catalogue association, publication,
occurrence and exact target, so a URL Subject never creates authority.

Decision: explicit Save records the visible stable `data-block-id` within the admitted chapter article with offset
`0`; native nonzero offsets are preserved on read and resume at their containing block. The shared checkpoint
controls stay available while scrolling, and all eight locales label the block save. No character precision is
inferred from geometry. If no visible anchor exists, Save retains the exact chapter with a null position. The shared
renderer keeps authored IDs on code and table defaults or caller-output wrappers, so a code-only chapter can save
and restore its existing block identity together with its authored language and direction.

`checkpoint-position.ts` binds capture and restoration to one current page and its article ref. Save scans that
article once, below the sticky checkpoint controls, choosing the innermost block at the viewport's reading edge or
the first visible block below it. It does not scan the global document or retain an anchor index. The initial private
checkpoint observation may restore once, after the renderer mounts, only when the prepared viewer remains current,
resume is available, catalogue/publication/occurrence/revision/digest match the admitted body, and its anchor exists
and is rendered. Restoration scrolls instantly below the controls without focusing. User wheel, touch, pointer,
scroll-key input or a changed viewport cancels the pending restoration; ordinary initial navigation focus settles
before the restore frame. Missing/hidden anchors, old null positions and stale exact coordinates leave normal
chapter navigation usable. No observer waits for a missing anchor and later readback never moves the reader.

Resume opens the same saved publication and occurrence through ordinary current Content admission. Library and
Resume links contain only their existing public coordinates; private block IDs and offsets never enter a URL,
history or a separate reading store. A withheld resume keeps the exact saved address and clear action without an
actionable resume link. The browser receives availability and title, never the checkpoint operation's extra disclosed
document bytes. The external-response boundary rejects a mismatched occurrence, target revision or digest rather
than linking to a different saved chapter.

Save and clear use native CAS revisions, idempotency keys and the installed POST BFF's session/CSRF checks. Each
successful command is followed by one current body-free metadata read before showing the result.

Decision: uncertain save/clear replay retains the original command, CAS, key, viewer, locale, CSRF header, sender and
owning abort signal. Each effect incarnation and request has its own completion fence; even an equal-value replacement
reading cannot inherit its intent. A separate observation never confirms an uncertain command. Acknowledged readback
confirms the action only when its exact catalogue/release/occurrence/body revision/digest/position matches (or Clear
reads back native none); a differing current value keeps changed-reading recovery. Replay, failed checkpoint read
retry and explicit current-reading recovery are distinct actions. Original action context and supplied saved chapter
context remain visible beside uncertainty. New writes stay unavailable until the original outcome is resolved, and
conflict/changed recovery requires a fresh visit. These choices add no read, polling, persistence or private snapshot.
Reading retirement aborts private requests and fences completion and controls. Ordinary Library
Progress, page units and Continue remain independent, as owned by [Library](../../../../../services/kernel/src/library/README.md).

Keyboard checkpoint actions focus their result only while the initiating control still owns focus; moving focus or
choosing another control cancels the transfer. Pointer actions retain pointer focus. Read retry preserves the original
observation operands and the existing once-only position restoration. Within a visit the controls keep their live
section through loading/readback, preserving the restore frame's control inset; replacement discards pending result
focus. An unavailable checkpoint observation is labelled separately from Library progress. Clearing affects only the native checkpoint;
Library progress and membership remain unchanged.

The independent `renderProgress(page, isCurrent)` extension remains available for an admitted Commerce region;
rendering failure cannot remove the chapter. It does not supply or replace the Library checkpoint.

## Bounds and evidence

Decision: retain at most eight observed predecessor contents coordinates plus current/staged coordinates in
route-owned memory for one mounted publication/viewer/credential/locale visit. Coordinates contain only exact
public parent/cursor operands, never rows, titles, bodies, credentials or private checkpoints. Only successful,
current contents observations advance this window. Previous uses an observed predecessor in the same parent;
level links restore that parent's most recent retained coordinate. An evicted or direct-entry predecessor stays
unknown; First page explicitly restarts the level. Failed movements retain their exact target for Retry, including
failed Previous. No refill, tree scan or predecessor inference is permitted. Chapter return rereads its original
bounded address and focuses the admitted selected occurrence, or the heading if it is missing. Source retirement,
publication/viewer/credential/locale replacement and leaving the route discard the window and late effects;
ordinary same-publication route/chapter movement may retain it. Reload/direct entry starts without predecessors.
Back/Forward keeps its exact public URL and performs the existing fresh admission/source observation.

One reader retains at most 40 consumer rows (native maximum 20), one chapter, 24 ancestors, two neighbours and one
contents return, in addition to this bounded coordinate window. Each catalogue host observation makes at most three
native operations; Subject discovery makes one. Each source observation makes at most 32: chapter `7 + ancestors + changedRelease`, contents `5 + parentProbe + ancestors + selectedResolves`.
Each operation retains Content's own bounds. Body bytes are at most 2 MiB per resolution; frozen/current resolution
can read two bodies. Consumer cursors allow 8,192 characters; native/route cursors allow 4,096. There is no growing
page/body cache, unbounded cursor chain, hydrated tree or new progress store.

Checkpoint transport costs one body-free metadata request on initial observation and one after each successful
save or clear. A later chapter open still performs its existing exact-body admission and canonical-byte verification.

`illustrative-source.ts` supplies labelled native-format examples through the actual mapper, exclusively for tests
and stories. It is never a production source. Story IDs remain `interfaces-hosted-book-reader` with named states
`nested-contents`, `exact-chapter`, `sparse-continuation`, `failed-page-recovery`, `moved-occurrence`,
`unavailable-navigation` and `retired-reading`. `multiple-contents-pages`, `nested-level-return` and
`failed-previous-retry` cover bounded contents traversal, independent parent restoration, frozen chapter return
and exact failed-Previous recovery; `saved-continue` and `independent-checkpoint-failure` cover checkpoint
presentation independently of the body. Review at 390px/1280px in light/dark and all eight locale globals.
The reading column keeps the shared reading measure, wrapping controls, focus rings and safe area spacing.

Review stories opt into two parts and distinct multilingual chapters, including long titles, prose, a table and a
code block through the actual mapper and shared renderer. Regression fixtures retain their original small default.
The saved Continue example opens its exact saved occurrence. The checkpoint-unavailable example keeps an independent
unsaved progress edit under Review reading progress; Retry does not reset that edit. Checkpoint controls are the
same presentation used by the native owner, with explicitly local illustrative state. Main review stories remain
manual and stable; set the Storybook `readerJourney` parameter to `true` to run the retained interaction assertions.
Only their destination selectors change from buttons to canonical links; their outcome assertions stay unchanged.

`book-checkpoint-recovery.stories.tsx` mounts the actual checkpoint component inside the shared Book reader with
installed native response shapes. Its named states are `saved`, `unknown-save`, `unknown-clear`, `failed-read` and
`replaced-visit`; all use locale globals and wrapping 44px controls. These fixtures and interaction sources do not
claim native save/Continue, keyboard, phone/desktop visual or retirement acceptance; those remain verifier-owned.

`tests/hosted-book-reader.test.tsx` retains original bounds, exact operands, reuse, sparse retry, move, focus,
keyboard/RTL, locale/viewer/session/source retirement and independent progress assertions. Extensions cover native
host observations, public-only selectors, canonical links in eight locales, the actual default file route and
bounded return through browser Back/Forward. The existing sparse Subject discovery case also pins exact title opt-in
operands on initial/continued/retried reads, one list request without point reads, escaped supplied titles,
absent/empty localized fallbacks, the HTTP title bound and unchanged link coordinates and cursor failures.
New assertions pin exact CAS save/get/clear,
withheld resume, response target mismatch, uncertain same-key retry, and retirement of late checkpoint reads.
Block-position assertions cover explicit visible-block save, exact retry/readback, nonzero native offsets, article
scoping, every exact coordinate, null/missing anchors, withheld targets, viewer retirement, user scrolling, once-only
restoration and the unchanged public resume URL. Assertions use explicitly illustrative native-format responses;
source assertions do not establish native admission or growth acceptance.

`tests/hosted-book-checkpoint.test.tsx` adds original-envelope/sender replay, exact CAS/body/position preservation,
separate read and changed-reading recovery, independent observed values, clear scope, focus and late read/write
retirement cases, including equal-value replacement and Strict Mode setup. The retained code-only reader regression
uses the action-specific save replay label; its original exact-anchor and native result assertions remain intact.

Worker source review is formatting/diff inspection. Web typing and runtime acceptance are deferred in this
source-only window. The dev verifier executes Web typing and the owning isolated runner: `bun run --cwd apps/web test tests/hosted-book-reader.test.tsx`.
The checkpoint recovery source has its separate focused command: `bun run --cwd apps/web test tests/hosted-book-checkpoint.test.tsx`. Mounted acceptance remains
deferred for explicit block save, reload and Library/Resume reopening in the exact
chapter, stale revision/digest/publication/occurrence, missing anchor and old null positions, a changed viewer during
the private read or restore frame, a withheld target, and scrolling while that read is pending. Verify that the
containing block is visible, focus stays unchanged during restoration, nonzero offsets survive readback, and no
private position appears in links. No browser, native, Storybook or broad suite runs in this source pass.
Integration then uses the existing Root seeded page-data/capture lane for native nested reading, moved exact links,
draft privacy,
progress/Continue and return. Served revision, native seed and actual phone/desktop light/dark evidence are
unverified here; source, typing, native execution, visual review and promotion remain separate.

Deferred transport acceptance: `hosted-book-reader.test.tsx` must prove zero body requests for Contents (including
selected and moved chapters) and route admission, and one exact body request per opened chapter with unchanged
byte/digest validation. Mounted native, browser, Storybook and broad checks run later in the dev verifier.
