# Resource presentation and Blocks

## Content and view separation

A Resource has eligible content/representations; Zone routes and mounts select a
view and typed context. The same content can appear in several Spaces without
copying its body. Blocks are declarative documents with stable major-node identity,
registered types and versioned payload schemas. Document AST and semantic graph
reference each other through exact resource/revision/selector contracts.

## Resource summaries

Every resource exposed as an object summary has a stable reference, resolved
display name and non-null `avatar` descriptor. This applies to works,
characters, concepts, Contexts, roles, relation definitions and other admitted resource
types. It is a shared read contract, not a mandatory universal database record.

The target `ResourceSummary.avatar` is a discriminated emoji/icon/image/fallback
value. Emoji and icon identify authored choices; an image identifies the selected
currently disclosable Media Use and bounded rendition. A fallback identifies a
stable admitted default keyed by readable resource/type and display policy.
A resource without uploaded media still has a renderable avatar. A hidden image
must produce a safe fallback without revealing the hidden asset's identity or
the reason it was suppressed. The Media owner supplies
[selection and lifecycle rules](media.md#universal-avatar-selection).

The resource itself must first pass the normal readable/available-state checks.
Avatar fallback cannot fabricate a resource summary or reveal a private object's
existence when that read is denied or unavailable.

Summary reads take explicit context/language/disclosure policy and return actual
selection provenance where readable. Batch hydration shares the caller's budget;
lists and graph views do not make one owner request per avatar. Cached summaries
bind name/media selection and disclosure generations, and stale media URLs cannot
outlive the owning delivery policy.

Display groups such as Appearance are fields in existing view/Block descriptors,
with admitted relation/property membership and order. They allocate no compulsory
Facet, Path, Expression or Sense object. Referencing an Appearance concept for a
group's label does not make the concept identical to the group. Renaming or moving
a group changes presentation only. Results come from the shared
[statement aggregation contract](search.md#statement-aggregation), including its
count grain, supporting identities and completeness.

## Interpretation and preference selection

The API distinguishes the resource's shared identity, an authored statement's
exact interpretation, the Realm's own selected interpretation, and a viewer's
preferences. A resource or concept can be read under different Contexts without
changing the original claims. Expose meaningful differences through readable
criterion/Context labels and an inspectable definition/evidence basis; display
names such as `後宮` alone cannot identify the selected meaning.

Show whether speech is personal or on behalf of a Realm, and retain the selected
semantic revision when quoting or sharing. A Realm default is a selectable
starting point, not proof that every member uses it. Do not silently substitute
the viewer's current Context for the author's. A separately named concept and a
contextual interpretation of the original may coexist in the same view.

Language, detail level, property emphasis, name/avatar and ordering preferences
have independent effects. Editing them cannot change a semantic filter, the
author's meaning or content publication. Response descriptors and shared links
carry exact semantic selection where meaning depends on it; private selection
or Context metadata is disclosed only to the admitted audience. Missing required
meaning stays unavailable instead of being replaced by Global.

## Rendering

The [media presentation profiles](media.md#covers-banners-and-aspect-ratios)
define square avatars and independent optional `covers[ratio]` and `banners[ratio]`
selections. Portrait/landscape cover controls and the initial banner ratio are
presets over these maps; editors retain other saved ratios.
Avatar editing preserves a square crop and previews the circular mask so the
author can see which corners will be hidden. Circle or rounded-square rendering
does not rewrite the saved crop. Emoji/icon choices use the same display canvas.

Each cover/banner surface requests its display ratio and preserves the resolved
use's full-image or crop-to-fill setting. Do not distort the source to fit. Exact
ratio selection precedes an explicitly admitted fallback; numerical proximity
alone does not authorize cropping. A missing cover may use an admitted placeholder
or full-image display fallback without creating an authored selection. A missing
banner uses the page layout without a banner: no reserved empty image region and
no automatic cover substitution.
The banner editor previews actual title/avatar/control overlays where present;
resource names and controls remain interface content rather than baked-in image
requirements. The default banner frame is 3:1 on desktop and mobile; a surface
using another ratio declares it and previews the matching composition.

[Post media](media.md#post-attachments-and-preview-selection) keeps body media
and card preview selection independent. Prefer the original ratio for one image;
bound extremely tall feed previews and provide access to the full image. Multiple
images may use a grid or carousel while preserving authored order and original
media. A constrained viewport never rewrites the original or assigns a new cover.

Validate new writes strictly. Isolate malformed historical presentation nodes in
bounded render-safe fallbacks without rewriting authoritative content or allowing
executable HTML/URLs. Render only selected, currently readable dependencies.
Progressive disclosure exposes ordinary tasks directly and retains advanced
configuration, provenance, context and material consequences.

### Post Feed media height

Feed layouts bound the entire Post media region while retaining the original
attachments. A single ordinary image preserves its aspect ratio; when it exceeds
the region's height budget, it can scale down fully with surrounding space.
Extremely tall images may show a cropped preview with a visible full-image action
and an author-adjustable preview region. Multiple images share one bounded grid
or carousel region instead of accumulating one full-height region per attachment.
Keep order and full-image access; the composer previews the active Feed policy
and makes truncation visible before publication.

Candidate sizing policy for frontend validation, in CSS pixels:

```text
W = available media-region width
V = usable viewport height after persistent application chrome
Hmax = min(W * 4 / 3, V * 0.8)
```

The width term corresponds to the height of a 3:4 image at width W. The 0.8
viewport factor is a REZICS starting hypothesis, not an X specification or an
already-qualified default. For W=360 and V=800, the candidate height cap is 480.
Neither term requires stretching or filling the entire width when a complete
image is scaled down. The cap constrains a viewport, never mutates image data,
and is not stored as a pixel-height property on each Post. Full-image viewing
and article reading have independent layout policies.

Validate this candidate with ordinary portrait/landscape photos, panoramas,
long screenshots, mixed-ratio image sets and short desktop/mobile viewports.
Assess full-image readability, visible crop boundaries and access to the rest of
the Feed before adopting the numeric height budget. The confirmed external
behavior and its limits are recorded with the [media decision evidence](media.md#decision-evidence-and-remaining-validation).

## Query Blocks and themes

Search/Feed/Graph/Collection Blocks compile typed descriptors through the same
server query contract. Share request budgets and cache by descriptor/context/
selection/disclosure generations. Saved UI layout does not create facts or grants.
Unknown Block types yield an explicit unsupported placeholder/export residual.

Themes use controlled tokens/presets by default. External-live executable themes
have the separately admitted [execution contract](custom-theme-execution.md).
Presentation changes cannot confer query capabilities, read private data or hide
consent/security consequences. Accessible navigation and keyboard behavior are
part of the experience contract.

## Implementation and acceptance

Use shared React renderers and typed locale resources for product UI; content
languages remain independent. SDK/API editors preserve unknown-to-editor advanced
fields. Qualify exact selection, malformed nodes, private embeds, query budget
composition, responsive/accessibility behavior and exported representation fidelity.
The emoji/icon avatar, cover/banner and Post preview extensions above are
adopted designs (2026-09-27); verify their owner APIs before their frontend
consumers.

## Document editor choice

Maintainer decision, 2026-10-02, superseding decision 22's BlockNote preference.
Use Tiptap's maintained editing ecosystem with the independent Apache-2.0
[REZICS Document contract](../../packages/document/README.md). Core, Text and
Blocks share ProseMirror's JSON model and Tiptap node names; the package owns
the published schemas, stable unit IDs and preserved opaque component payloads.
It requires no REZICS account, service or semantic graph. Semantic Web models
are design references; no RDF projection is needed for editing.

The reason is to reuse mature text, list and table mechanics while keeping the
format implementable outside the application. The shared Tiptap editor serves
Studio and discussion writing; a pure React renderer reads saved documents
without loading the editing runtime. Explicit `document` writes retain the
snapshot and derive a plain projection for search, counts and existing reads.
Legacy plain text and Markdown remain readable, and editing imports them
without flattening new snapshots. JSON export preserves the complete document;
plain-text export is an explicit projection.

The [editor stories](../../packages/ui/src/components/rich-text-editor.stories.tsx)
and Studio stories exercise formatting, restore, conflicts and publication.
Browser tests do not substitute for physical CJK IME testing on phones.

Writing starts with contextual controls, chosen by the device's primary input
rather than the screen width. Every control is one entry in a shared command
table, so surfaces differ in layout and never in what they can do.

- **Pointer:** a compact selection panel over the selection's first line: block
  type, marks, link, ruby and emphasis as icons, and More, a labelled menu of
  what can be done to the blocks the selection touches (turn into, alignment,
  table, duplicate, move up or down, delete, each with its key) and how much is
  selected. More is not an overflow for icons that did not fit. Alt+F10 moves
  keyboard focus into the panel; the touch drawer carries the same block actions. Right-click stays the browser's, so
  spelling suggestions and paste behave as everywhere else; a second formatting
  menu there would split one set of commands across two surfaces. Typing `/`
  opens a filtered block menu; the caret inside a link shows a small card to
  open, edit or remove it, and Ctrl/⌘+K edits a link in place.
- **Images** open a small panel at the caret: upload a file where the surface
  provides storage, or embed a link; the description is optional. Dropped or
  pasted image files upload in place. Until a document can reference an uploaded
  media asset and its screening state, the web app keeps uploaded images in the
  page as blob addresses: they disappear on reload, the image itself never
  reaches Main, and a saved or published document keeps only an address no one
  else can open.
- **Touch:** no floating panel, because the system's selection handles and menu
  occupy that place. A bar rests on the keyboard with the most used formats; a
  drawer holds block types, the remaining marks and insertion. Its buttons keep
  the keyboard open.
- Changing a block's type keeps the block's identity, and inserting a block
  never replaces selected text.
- A keystroke costs the edit, not the document: unchanged blocks keep their
  identity and are not converted, checked or serialized again, so a long
  chapter types like a short reply on a slow device.

Discussion writing (forum posts and replies) follows chat apps such as Telegram:
nothing stands in view but an image button while writing, and selecting text
shows one row of formats (quote and spoiler, inline marks, link, clear). A phone
uses the same row, opened under the selection because the system's selection
menu sits above it. A keyboard-resting variant is kept, disabled, for comparison
on real phones. Block type,
block actions and the slash menu belong to long-form writing; Markdown shortcuts
still work. Studio opens with the complete toolbar on a pointer's screen and can
return to contextual controls, keeping file import/export beside it; a phone
keeps the keyboard toolbar, since every control in one row would wrap into many.
Switching never changes the saved document or recreates the editor. The reason is to keep writing and
replying direct while leaving specialist formatting discoverable, and to stop
the same command from being missing on one surface and present on another.
