# Collection filters

The public Collection page supplies up to eight released facet properties to `CollectionFilters`. Its page-local
launcher opens a desktop Dialog with a 32rem maximum width and viewport-bounded scrolling, or the shared BottomSheet
on phones below 768px. The sheet supplies its heading, grab handle, localized Done action and safe-area padding.
Both surfaces return focus to the launcher. Phone controls have at least 44px targets. Shared shadcn sources stay
unchanged; forms use their supported Dialog composition rather than action Menu custom content.

Fields are drafts until Apply navigates. Dismissal discards edits; reopening starts from the supplied applied params.
Clear filters navigates to the same Collection and type with all filter values removed. Apply and Clear retain
unrelated route params, including layout, and remove the old predicate's cursor. Repeated concept values keep their
order, and a supplied selection remains carried when its concept lookup or target metadata is unavailable. Editing
the visible concept replaces its first value; other applied values remain carried by the existing grammar.

The existing `f.`, `r.` and `l.` address grammar, inclusive quantity bounds, filter admission and members query
adapter remain authoritative. Only the provided properties and their existing targeted, eight-result, debounced
suggestion lookup are rendered. The overlay introduces no member reads, writes, scans or new scope capability.
Preparing, unsupported, unavailable and empty results retain their existing distinct feedback. Opening and editing
filters leave the current member projection and order intact; applying starts the existing filtered members read.

`ActualCombined` enters the generated Collection route through PageStory with the product reader, filter dialog and
common renderer. Pattern stories remain supporting apply/clear and no-match/preparing/unavailable interactions on
the same illustrative Collection fixture. Combined long property labels stay a pattern overlay because the Collection
reader takes property labels from the definitions release; Concept IDs, property IDs and the long range bound travel
in explicit `f.`/`l.`/`r.` route search. Inspect those same IDs with `phone390`/`desktop1280`, locale and theme
globals. The focused `collection-filter-route-story.test.ts` regression pins the routed composition; keyboard, 44px
and original screenshots remain unmeasured until admitted. Native query semantics stay with Commerce.

The launcher remains page-local. A future header filter region should open this same editor with the page's supplied
properties and applied params, without introducing another filter store or claiming unsupported backend scopes.
