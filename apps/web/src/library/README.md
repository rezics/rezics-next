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
