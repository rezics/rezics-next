# Content item

`ContentItem` is the shared presentation family for supplied item summaries. Its row root remains a semantic `li` and
keeps the existing visual, context, title, metadata, preview, state, action and trailing slots. Use it inside the owning
`ul` or `ol`; the shared row link and control layer keep one primary destination separate from independent links and
buttons. Titles and supplied context wrap at narrow widths. The control rail moves beside the text only when the
row has at least 40 rem of width; its width stays bounded so actions cannot consume the title column.

The primary link uses the visible title as its accessible name by default. A caller may supply `primaryLinkLabel` when
the destination needs additional, noninteractive summary context; a nonblank value becomes the link's exact accessible
name while the visible heading remains unchanged. The supplied name must include the visible title verbatim and must
not add secrets, action labels or fabricated facts. Empty or whitespace-only values use the default title name. Without
`href`, no primary link or hidden announcement is rendered.

## Independent controls in content slots

`visual`, `context`, `metadata` and `preview` stay in ordinary flow. When they contain a native link, button, disclosure summary or
form control, the shared row raises that control above its stretched primary link and gives it a visible keyboard-focus
outline. A form label is raised with its input so its text remains a usable target. Plain preview text stays under the
primary hit area; do not wrap an entire preview in `ListRowControl` just to raise a disclosure or form field.

```tsx
<ContentItem
  href="/works/stars"
  title="A journey through the city of stars"
  visual={
    <a href="/people/artist" aria-label="Open the artist profile">
      Artist credit
    </a>
  }
  context={
    <>
      <a href="/series/stars">The Stars series</a>
      <button type="button" aria-label="Follow the series">
        Follow
      </button>
    </>
  }
  preview={
    <>
      <p>A short summary of the work.</p>
      <details>
        <summary>Read the complete note</summary>
        <p>The rest of the supplied note appears here.</p>
        <label>
          <input type="checkbox" name="keep-private" /> Keep this note private
        </label>
        <select aria-label="Note visibility">
          <option>Private</option>
          <option>Shared</option>
        </select>
        <textarea aria-label="Add a personal note" />
      </details>
    </>
  }
  metadata={<a href="/people/editor">Editor</a>}
  actions={<button type="button">Save</button>}
/>
```

The row raises each supported control and label individually; it does not raise the whole preview slot. The existing
`state`, `actions` and `trailing` slots continue to use `ListRowControl` above the primary link. Keep controls
as siblings of the primary anchor in the supplied slot content, use their native keyboard behavior and accessible
names, and retain visible focus styling for any custom control components.

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
focus targets and 44 px hit areas, including on touch. The adapter does not change caller data, routing,
layout containers or collection semantics.
