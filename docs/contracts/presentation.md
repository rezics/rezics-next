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

Decision 22, product manager under maintainer delegation, 2026-09-29.
Use BlockNote's MPL-2.0 core/React packages, excluding GPL XL, behind a
REZICS-owned immutable block contract with stable IDs. Tiptap is the fallback.
One editor serves Studio, posts, wiki, reviews and notes; a pure static renderer
and block-anchored paragraph comments preserve reading and review independently
of the editing runtime.

The reason is to reuse editing mechanics without making library JSON the custody
contract. [BlockNote's licence split](https://github.com/TypeCellOS/BlockNote#license)
and [Tiptap's static renderer](https://tiptap.dev/docs/editor/api/utilities/static-renderer)
support that boundary. Admission still requires package licence review, a vinext
Workers build, real CJK IMEs on phones and lossless migration. This decision does
not assert those gates have passed or add a dependency.
