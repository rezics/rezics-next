# Content item

`ContentItem` is the shared presentation family for supplied item summaries. Its row root remains a semantic `li` and
keeps the existing visual, context, title, metadata, preview, state, action and trailing slots. Use it inside the owning
`ul` or `ol`; the shared row link and control layer keep one primary destination separate from independent links and
buttons.

`ContentItemFrame` provides the same rounded hover, focus and press surface for a tile root. A tile may choose
`article` semantics and compose the shared `ContentItemHeading` and `ContentItemTitleLink` parts without adding a
wrapper `li`. The primary title stays a real anchor, and controls use the `ListRowControl` layer above its stretched
target.

`CoverCard` is the compatibility adapter for `CoverGrid` and `CoverRow`. It keeps the existing cover presentation,
ratio and density contexts, title and router-link props, metadata, status and progress, selection, menu, and supplied
essential-credit content. A linked title is a level-three heading containing the original primary link. A missing
destination leaves the title as plain heading text. Essential credits remain opaque caller content with their existing
roles, qualifiers and independent links; the adapter does not reinterpret or hydrate them. Unknown progress keeps its
label and does not render a bar.

Selection remains controlled by the caller. `selectable` makes the tile itself a persistent pressed action, while
`onSelect` can provide an independent selection checkbox. Optional selection and overflow controls keep separate
focus targets and preferred 44 px hit areas, including on touch. The adapter does not change caller data, routing,
layout containers or collection semantics.
