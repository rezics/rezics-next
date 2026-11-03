# Saved Library views

Library presentation resolves explicit valid URL choices first, then the current account's native shelf defaults, then
the existing application defaults. Layouts use an exact absolute-IRI type scope when the address type is an IRI and
otherwise use `all`; Settings edits only `all`. Grid sizes map `small`/`medium`/`large` to the current `s`/`m`/`l`
controls. Only `last_activity`, `added` and `finished` map to the currently admitted native Library order operations.
Title, rating, release-date and progress orders remain saved and are described as unavailable. The table maps the
currently supplied cover, title, type, status, active progress, added, finished and last-activity fields. Unsupported
creator, rating and started columns remain in the native preference array and never appear as Library controls.

Changing a view changes its URL only. “Use saved view defaults” removes display and order overrides while keeping
type, state and label filters. A deliberate Settings save sends only changed shelf parts, so unrelated scopes and
unsupported saved choices survive. Reset sends `shelf: null`, which clears the complete native shelf preference;
reading and notification preferences are omitted. A stale version keeps the local draft for review. An uncertain
save can retry only with its original idempotency key; refreshing reads the current version and does not replace the
draft. A saved sort that changes the loaded order drops the old cursor. Table progress is the supplied active session
value, preserving its unit and mode; no row reads or local page sorting are added.

Decision: Settings edits the reversible `all` layout scope; the resolver uses an exact type scope only for absolute-IRI addresses and otherwise falls back to `all`.

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
