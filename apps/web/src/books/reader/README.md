# Hosted Book reader

`HostedBookReader` is the Book reading profile of Content's shared Studio. The production route mounts the retained
native adapter and `PostReadingBody`, which owns readable measure, outline, spoilers, references and admitted media.
Semantic Work, Series and Edition bibliography stays with the [literary catalogue reader](../../features/catalogue/literary-reader/README.md).

Decision: mount the retained reader at the localized `/books/$id/read` route; resolve URL release/occurrence selections
through native public catalogue disclosure and the prepared session, retain bounded return coordinates in links,
and reread on browser return. The current literary Subject view links to the same route's bounded Subject catalogue
view. The reader uses Library's native hosted-reading checkpoint with explicit save/resume/clear and chapter-level
positions; no automatic write or ordinary Progress conversion occurs. Hosts use the declared `books/reader/route.tsx`
composition entry.

## Production admission and links

`routes/books.$id.read.tsx` follows the existing file-route generator and locale rewrite. It has no public cache,
preload cache or stale route payload: `staleTime: 0`, `gcTime: 0`, `shouldReload: true` and `sessionReread: true`.
The default catalogue visit is the current public publication's root contents. Subject discovery uses the same
route with `view=catalogues`; its path ID is then the Subject ID. It calls the generated
`subjects({id}).hostedCatalogues.get` once with `limit=20` and the optional opaque cursor. Empty and sparse windows
retain More when supplied, and Retry rereads the same URL. Each row opens its disclosed publication and retains
`subject` in subsequent exact chapter and contents links. Discovery supplies no catalogue titles, so rows use a
localized numbered publication label without per-row hydration. `readHostedBookVisit` prepares the native Web
session, reads the current publication with the installed generated catalogue operation, resolves any frozen
release and selected occurrence, and produces `NativeHostedBookAdmission` for this visit. A missing catalogue title
uses the localized Book title; it does not refuse an otherwise readable chapter. Credentials never enter URLs or
loader data. Missing native origin never falls back to Web's development fixtures.

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
slots. Sparse or empty windows can continue. More replaces the window; failure retries the same parent/cursor.
Pages separately report current release/structure, bounded ancestors and previous/next. Known ends and unavailable
navigation remain different states. Returning to contents retains the exact selection and focuses its row when
present, otherwise the heading; a moved selection retains an exact chapter return and current-location control.

`native-api.ts` calls the generated `KernelClient.hostedCatalogues` catalogue, children, occurrence and navigation
operations. Response types derive from those operations; runtime schemas validate external responses. Canonical
bytes are decoded, digest-checked and passed to the existing Document validator. The [Content owner](../../../../../services/kernel/src/content/hosted-chapters.md)
owns release immutability, unavailable slots, cursor binding, target admission and native limits. Each private BFF
read prepares the real session and checks that it still matches the admitted anonymous/session subject.

The route supplies a fresh `NativeHostedBookAdmissionSource` for every loader observation; synchronous replacement
retires the former reader. Other hosts must likewise replace their snapshot and notify on publication, current
structure/target or prepared-viewer replacement, including equal-value and A/B/A replacements. Source, session,
route, locale and admission replacement remove body, rows, return state and pending focus. Advisory abort is backed
by visit/connection/request checks before dispatch, completion and focus. A pagehide retires the visit; deliberate
reopen refreshes its native host admission. Explicit source reads check current release/structure and target access;
there is no background access polling or claim of a native cross-request transaction.

The native mapper observes frozen and current releases, resolves exact selection/current occurrence, reads only
its bounded ancestor path and at most one neighbour per direction, then rechecks both releases. Current context
uses the current public release, never a private Studio draft. Children/neighbours use the frozen release. A
current parent absent from the frozen release may be unavailable; no alternative body/tree is substituted.

## Controls and progress

Explicit navigation focuses the heading; contents return focuses the selected occurrence where present. Choosing
a shared search/header control during navigation or moving focus during a request cancels the transfer. Arrow
navigation stays inside the reading region, mirrors the document direction, and respects text selection, editable
and interactive controls, modifiers, held keys and input methods. Controls wrap with 44px targets and phone safe
area spacing; the document's language/direction is independent of the interface locale. Eight launch locales cover
controls and recovery: en, zh-Hant, zh-Hans, ja, ko, de, fr and es.

`checkpoint.tsx` renders the native Library checkpoint within the admitted page lifetime. It makes one private
`libraryHostedReading.get` after the chapter or contents is ready, using the prepared session and expected viewer.
Anonymous and catalogue-only visits perform no private read. Subject discovery links supply the Subject; callers
may also pass it to `HostedBookReaderLink`. The native save validates the Subject/catalogue association, publication,
occurrence and exact target, so a URL Subject never creates authority.

Save stores the current exact chapter with `documentPosition: null`. Resume opens the saved publication and
occurrence at the chapter beginning and reads through the ordinary current Content admission again. It never
substitutes the current head or another occurrence. Existing checkpoints with a document position retain that fact
on read; this UI offers chapter-level resume. A withheld resume keeps the exact saved address and clear action,
without an actionable resume link. The browser receives availability and title, never the checkpoint operation's
extra disclosed document bytes. The external-response boundary rejects a mismatched occurrence, target revision
or digest rather than linking to a different saved chapter.

Save and clear use native CAS revisions, idempotency keys and the installed POST BFF's session/CSRF checks. Each
successful command is followed by one current native get before showing the result. An uncertain delivery keeps
its exact command and key for Retry. A conflict or changed selection requires a fresh visit; there is no optimistic
checkpoint success. Reading retirement aborts private requests and fences completion and controls. Ordinary Library
Progress, page units and Continue remain independent, as owned by [Library](../../../../../services/kernel/src/library/README.md).

The independent `renderProgress(page, isCurrent)` extension remains available for an admitted Commerce region;
rendering failure cannot remove the chapter. It does not supply or replace the Library checkpoint.

## Bounds and evidence

One reader retains at most 40 consumer rows (native maximum 20), one chapter, 24 ancestors, two neighbours and one
contents return. Each catalogue host observation makes at most three native operations; Subject discovery makes one. Each source observation makes at
most 32: chapter `7 + ancestors + changedRelease`, contents `5 + parentProbe + ancestors + selectedResolves`.
Each operation retains Content's own bounds. Body bytes are at most 2 MiB per resolution; frozen/current resolution
can read two bodies. Consumer cursors allow 8,192 characters; native/route cursors allow 4,096. There is no growing
page cache, cursor chain, hydrated tree or new progress store.

`illustrative-source.ts` supplies labelled native-format examples through the actual mapper, exclusively for tests
and stories. It is never a production source. Story IDs remain `interfaces-hosted-book-reader` with named states
`nested-contents`, `exact-chapter`, `sparse-continuation`, `failed-page-recovery`, `moved-occurrence`,
`unavailable-navigation` and `retired-reading`. Review at 390px/1280px in light/dark and all eight locale globals.
The incumbent refinement keeps the existing reading measure, wrapping controls, focus rings and safe area spacing.

`tests/hosted-book-reader.test.tsx` retains original bounds, exact operands, reuse, sparse retry, move, focus,
keyboard/RTL, locale/viewer/session/source retirement and independent progress assertions. Extensions cover native
host observations, public-only selectors, canonical links in eight locales, the actual default file route and
bounded return through browser Back/Forward. New assertions pin sparse Subject discovery, exact CAS save/get/clear,
withheld resume, response target mismatch, uncertain same-key retry, and retirement of late checkpoint reads. Assertions use explicitly illustrative native-format responses;
source assertions do not establish native admission or growth acceptance.

Worker acceptance is final-source Web typing and formatting/diff inspection. The dev verifier executes the Web
owning isolated runner: `bun run --cwd apps/web test tests/hosted-book-reader.test.tsx`. Integration then uses the
existing Root seeded page-data/capture lane for native nested reading, moved exact links, draft privacy,
progress/Continue and return. Served revision, native seed and actual phone/desktop light/dark evidence are
unverified here; source, typing, native execution, visual review and promotion remain separate.

Current source orientation: the six retained commits `80ea75c339`, `285f8bb0d2`, `f654556965`, `a5ac14b08e`,
`6b2ce753d2`, `55fbc8304d`, and the installed `5fb0d0b754` contract and generated client. Before this binding design,
the owner sources read were this README, [Content hosted chapters](../../../../../services/kernel/src/content/hosted-chapters.md),
[Library](../../../../../services/kernel/src/library/README.md), its hosted-reading contract and routes,
[Book catalogue](../catalogue/README.md), the literary reader above, and the reader's exported types, callers and
acceptance tests. The retained implementation's legacy behavior comparison remains valid for its original revision.
