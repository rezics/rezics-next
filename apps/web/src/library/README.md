# Saved Library views

## My uploaded media

`/library/media` reads one native `GET /v1/media` page for the admitted account and its opaque cursor. Sparse empty
pages retain their continuation; each cursor replaces the current page instead of accumulating history. The page
shows only the native purpose, state, admitted type and sizes, timestamps, disclosed container kind and action
advice. It never fetches image bodies for inventory. A media destination appears only for a native-advised variant
and still passes through the Worker download authorization at use. Erasure uses the current `media.erase` owner
command; uncertain results keep the original same-key intent and current readback never turns it into a receipt.

Decision: inventory resume stays guidance unless the original browser composer still owns the matching reservation
identity and file; the Library never recreates or reuploads either one.

Decision: browser admission uses the existing `library_entry.list` personal-library group; native `media.own`
authorization remains decisive when reading the inventory.

## Saved shelf presentation

Library presentation resolves explicit valid URL choices first, then the current account's native shelf defaults, then
the existing application defaults. Layouts use an exact absolute-IRI type scope when the address type is an IRI and
otherwise use `all`. Settings edits `all` and individual admitted types. Grid sizes map `small`/`medium`/`large` to the current `s`/`m`/`l`
controls. `last_activity`, `added` and `finished` map to the currently admitted native Library date orders.
Saved `rating` maps losslessly to the `personalScore` address and direction for each state, including `all`.
This preserves intent only: the existing whole-shelf capability fence still reports score ordering unavailable,
with retry of the same intent or an explicit date-order recovery. Settings shows the retained score direction as a
disabled saved choice; it does not offer new unsupported orders. Title, release-date and progress orders remain
saved and are described as unavailable. The table maps the
currently supplied cover, title, type, status, active progress, added, finished and last-activity fields. Unsupported
creator, rating and started columns remain in the native preference array and never appear as Library controls.

Changing a view changes its URL only. “Use saved view defaults” removes display and order overrides while keeping
type, state and label filters. A deliberate Settings save sends only changed shelf parts, so unrelated scopes and
unsupported saved choices survive. Reset sends `shelf: null`, which clears the complete native shelf preference;
reading and notification preferences are omitted. A stale version keeps the local draft for review. An uncertain
save can retry only with its original idempotency key; refreshing reads the current version and does not replace the
draft. A saved sort that changes the loaded order drops the old cursor. Table progress is the supplied active session
value, preserving its unit and mode; no row reads or local page sorting are added.

Decision: saved rating is a score address intent, while native availability independently controls execution and offered choices.

Decision: type selection only inspects a local draft; Settings uses replacement pages from the private Library type index, keeps absent saved types removable, and clears a single override with a nullable map entry. Type navigation carries explicit URL layouts while implicit layouts resolve again for the destination type.

## Cost bounds

Preference resolution uses one bounded native snapshot (at most 32 layout scopes, six per-state sorts and eleven
column IDs), with no extra requests, row hydration or page-local ordering. Score defaults use the existing
unavailable reader and recovery without score preparation or vote reads; chronological paging keeps its existing
20-row default and 100-row maximum. Settings writes only dirty shelf fields through the existing versioned command.

# Copy reading context

Each FULL copy row carries its own bounded native context from the same page request. Commerce continues to own copy revisions, profile meaning, private source/location/acquisition-date/note fields and allowed actions. Web renders `available`, `unsupported`, `scope`, `withheld`, `missing` and `unavailable` as distinct states. It shows selected property-keyed facts for `unsupported`, but only `available` supplies Work links. Qualified `schema:datePublished` values retain their recorded calendar precision; `schema:author` remains an author fact, `acquiredOn` remains private acquisition metadata, and a profile release digest is never an edition fact. Context does not change copy readability or authority, and the page does not hydrate Subjects per row. Work destinations return to the same localized inventory address using only its subject filter and opaque cursor.

Decision: Render every native context state separately; only available Work identities are linked, while unsupported property-keyed facts remain visible without asserting a Work or edition association.

# Library selection review

The private shelf selects only the currently supplied rows, in visible selection order, up to the native UI cap of 100. The shared SelectionBar shows the exact count, keeps Review and Clear reachable, and places secondary actions in
its phone menu. The review lists each selected title and exact subject identity, explains unavailable status access,
and offers only status choices shared by the current selected profiles. Opening or returning from review retains the
still-current selection and returns focus to its live launcher; a changed row identity, state, selection, session or
route invalidates the review and suppresses focus restoration into a retired visit.

Status and removal reviews remain presentation adapters over their existing native preview, confirmation, retry,
recovery and Undo owners. Results group each supplied per-item outcome as applied, no effect, conflict, denied,
cancelled, failed, pending or uncertain. Uncertain results remain distinct and retain the existing exact-key retry;
presentation does not resubmit, infer atomicity or call producers when a review or result is opened. Selection is
bounded by 100 loaded entries; it never enumerates matching rows or hydrates extra row details.

The shell's measured phone navigation clearance offsets the fixed selection bar. Its SSR fallback includes safe-area
inset once; the measured navigation height already includes that inset. Desktop and standalone modes use zero
clearance. See [the shell clearance contract](../shell/README.md#phone-navigation-clearance).

# Collection filters

A Collection page supplies its released supported facet roster to `CollectionFilters`. The property picker
searches that roster while the overlay keeps at most eight properties active at once. Its page-local
launcher opens a desktop Dialog with a 32rem maximum width and viewport-bounded scrolling, or the shared BottomSheet
on phones below 768px. The sheet supplies its heading, grab handle, localized Done action and safe-area padding.
Both surfaces return focus to the launcher. Phone controls have at least 44px targets. Shared shadcn sources stay
unchanged; forms use their supported Dialog composition rather than action Menu custom content.

Fields are drafts until Apply navigates. Dismissal discards edits; reopening starts from the supplied applied params.
Clear filters navigates to the same Collection and type with all filter values removed. Apply and Clear retain
unrelated route params, including layout, and a changed predicate drops the old member cursor. Repeated values keep
their route order. Applied values remain carried when they are outside the visible property or value page; editing a
visible selection changes only that property's values.

The existing `f.`, `r.` and `l.` address grammar, inclusive quantity bounds, filter admission and members query
adapter remain authoritative. Released range operators and units come from the definitions release. Decision: eight
active properties is a UI window, not a filter limit; applied fields and values outside the window remain in the
Collection predicate. The overlay introduces no member reads, writes or scans. The installed
`subjects:facets` client has no Collection resource scope, so this overlay reports unavailable until Search binds
that scope instead of requesting Global values.
Preparing, unsupported, unavailable and empty results retain their existing distinct feedback. Opening and editing
filters leave the current member projection and order intact; applying starts the existing filtered members read.

`ActualCombined` enters the generated Collection route through PageStory with the product reader, filter dialog and
common renderer. Pattern stories remain supporting apply/clear and no-match/preparing/unavailable interactions on
the same illustrative Collection fixture. Combined long property labels stay a pattern overlay because the Collection
reader takes property labels from the definitions release; Concept IDs, property IDs and the long range bound travel
in explicit `f.`/`l.`/`r.` route search. `Pages/Collections/Advanced facets` records the released property picker,
count-free paging, retained selections outside the window and honest unavailable scope seam. Its fixture pages are
illustrative, not native evidence. Inspect both reader contexts at `phone390`/`desktop1280`, with locale and theme
globals. The focused `collection-filter-route-story.test.ts` regression pins the routed composition; keyboard, 44px
and original screenshots remain unmeasured until admitted. Native query semantics stay with Commerce.

The launcher remains page-local. A future header filter region should open this same editor with the page's supplied
properties and applied params, without introducing another filter store or claiming unsupported backend scopes.

An admitted Collection filter document, or a Library type/label selection, can open `/library/rules/new` as a private
saved dynamic Collection. A Library state ID without profile and state set stays unsaved with correction. Built-in
Collections keep their immutable rules. Native member execution remains Commerce.

Ordinary saved dynamic Collections use this same Collection address and Dynamic Collection reader. See
[saved-query results](saved-query-results.md) for 202 preparing versus empty 200 versus 503, exact URL/cursor retry,
and the owner-only rule edit boundary. Built-in identities keep the fixed-rule copy; they are not relabelled as saved
membership.

Decision: saved-filter review opens only on owner request, interprets operands with their accepted release, and keeps exact IDs visible when exact-Collection labels are unavailable.

The review reads the private generated rule GET only after the mounted owner session is current. Its no-store response
keeps the rule's immutable release separate from current field metadata and shows every stored operand, including
fields outside the eight-property editor window. A missing current label or field does not remove or reinterpret a
saved condition. Return closes the review unchanged; clearing a condition opens the existing rule editor, whose
explicit edits use current native admission and retain an incompatible draft. Public readers never receive the
predicate.

Current value labels reuse the Collection-scoped count-free Search seam in collection-facet-values.ts. The installed
generated Search operation still lacks exact Collection scope, so review reports refused or unavailable metadata,
leaves exact operands inspectable, and offers a deliberate retry. It does not substitute Global values or hydrate
values one chip at a time. Search retains the missing native Collection-value binding; Commerce retains accepted
rule execution, admission and native outcome proof.

# Identifying work context

Personal and label shelves place supplied creator/release facts beneath the title in list, grid and table.
A creator keeps its released property label (for example Director); no item relation is renamed Author.
Only released list-presentation properties with item/time datatypes appear. Item names and localized destinations
come from the producer's disclosed item facts; empty labels have no destination. Gregorian year/month/day facts
use the shared precision-preserving date formatter. Missing facts, missing release metadata and unsupported facts
retain the existing type-only fallback. Context is distinct from Entry state, progress, dates and personal score;
it neither enables score sorting nor interprets a semantic fact as a vote.

Decision: keep identifying context beside the mandatory title, independent of optional personal columns, and show
only supplied facts admitted by the released list presentation.

The adapter binds context to the original subject key, disclosed subject identity, revision, incarnation and, on a
label shelf, exact assignment and label IDs. A changed binding or locale refuses old context. Reader/source
replacement remains owned by the existing private-page lifetimes; context follows their currentness and links
refuse activation from a retired visit. There is no delayed identifying-fact request that could revive an old Entry.
The table keeps unlinkable tombstones and does not turn its content-capable title fallback into a creator claim.

One existing FULL page supplies context: 20 personal rows by default, at most 100 raw rows, at most four released
properties and three values each per row, with at most four displayed values. Continuations repeat that bounded
page read. This adds no Subject requests, pagination, sorting, commands or private-context cache.

The named unavailable seam is `suppliedShelfFacts`. Kernel's personal FULL list already attaches bounded list facts
through `attachCollectionListFacts`, but the installed generated personal client has no facts field. The local
optional adapter consumes that existing producer payload using the generated Collection fact union. Commerce must
publish its existing personal facts schema in the generated client. FULL label assignments currently supply neither
facts nor an identifying-context schema: Commerce must add the same optional four-property/three-value facts field
to `/v1/libraryLabelAssignments?labelId=…&view=FULL`, using the existing bounded attachment with final assignment,
Entry and reader revalidation. Semantic retains role meaning, accepted source qualification and item disclosure.
Until those native fields arrive, no alternate endpoint fills the label shelf gap.

# Browser reader admission

History/current-origin and workspace admission execute in Web's [reader infrastructure](../session/README.md).
Library exports thin naming adapters for existing callers. Its operation episodes and retained grants keep draft
retention distinct from dispatch authority; healthy same-account credential rotation can retain native intent while
all prior callbacks retire. Copy and label reading require current read admission, not mutation credentials.
Library action adapters continue to own exact uncertain-command recovery and original operands, credential and key.

Presentation decision: the Library shows the source of its effective layout and sort, and flags saved sorts or table columns that current native reads cannot honor; navigation keeps inherited choices out of the URL.

Collection action vocabulary is derived from the installed root `KernelClient.viewerActions.post` callable used
by the production Collection read. Successful empty grants stay current. Decision: until the installed
`KernelClient.collections({ collectionId }).members.get` response publishes `viewerFacts.rows[].actions`, member
controls remain unavailable; undocumented object fields and visible Entry/vote facts never grant navigation or
dispatch. Preserve occurrence row keys and original Subjects while the producer delivers its typed closure.

# Progress return navigation

Decision: keep private Progress return context in router history state, re-read the native index before restoring row focus, and offer first-page/current-work recovery when the original address no longer admits the selected session; an explicit new session keeps its filters and removes only the Progress cursor.

Canonical session and Subject links remain ordinary shareable addresses. Same-tab Progress navigation carries the filtered index selectors and opaque cursor privately, then accepts focus only for the same admitted session ID, Subject ID and start time. A stale or changed source offers a safe restart instead of searching later pages. Subject return context is revalidated against the currently disclosed work before it is used.
