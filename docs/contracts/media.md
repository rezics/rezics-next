# Media assets, representations and uses

Status: Avatar, ratio-keyed covers/banners and Post media design adopted on
2026-09-27. The ratio-keyed design supersedes fixed portrait/landscape fields;
those names remain presentation presets.
This is a target contract. The existing backend supports image/fallback avatars
and ordered image publications; the structured avatar choices, cover/banner
selections and Post preview policy below await implementation. Frontend editing
and rendered acceptance are also pending. This decision authorizes documentation
only, not an implementation batch.

## Identities

An Asset identifies maintained media; an asset revision identifies content state;
a Representation identifies exact encoding/bytes; a Locator identifies a way to
obtain them; a Use attaches an asset to another Resource/context with roles.
Originals, thumbnails, posters and transcodes are representations, not additional
cover identities. Similar images or identical bytes do not prove the same rights
or referent. Deduplication stays inside compatible disclosure/retention domains.

Uses retain front/back/booklet/screenshot roles, applicability, order, crop and
source. A source's primary flag and its role label are separate from native cover
selection. One image can serve multiple compatible roles and several releases.
Image avatars, covers, banners and Post attachments use the same machinery with
bounded disclosable renditions and owner selection. Each use retains its own
crop, focal point, fit and alternative text where applicable; changing one use
must not change another use of the same asset. Original dimensions belong to the
exact image representation. Delivery URLs are resolved locators, not stored
selection identities.

## Universal avatar selection

Every object can participate in avatar selection, including concepts, characters,
works, shared Contexts and relation definitions. The required
[`ResourceSummary.avatar`](presentation.md#resource-summaries) result is a typed
emoji, icon, image or stable fallback. This guarantee does not require an uploaded
Asset or a separately stored default image for every resource.

The authored choice is a discriminated value:

- `emoji`: the complete selected Unicode emoji sequence, preserving modifiers
  and joined sequences, with an optional admitted background color token.
- `icon`: a stable ID from the application-managed icon registry, with an
  optional admitted background color token. Store the identity rather than
  executable markup or a renderer-specific component name.
- `image`: an exact Media Use with the avatar role and asset/representation
  basis. Uploading is one way to obtain the image; choosing an existing eligible
  asset uses the same selection contract.

Emoji and icon choices are authored selections, not fallbacks. They need no
fabricated image Asset. Reuse Asset, Use and Representation identities for
images; do not introduce an Avatar asset family. Selection follows an explicit
versioned owner/context policy. Never choose the first available image, inherit
a cover/banner, or follow a related object's image without an admitted rule and
readable basis.

An image avatar's effective crop is square in oriented source-image pixels
(1:1). Preserve the original and the square crop; round masking belongs to the
renderer. Equal normalized width/height values do not imply a square when the
source itself is rectangular. Emoji and icons occupy the same square display
canvas without becoming uploaded images.

Selection/replacement/removal commands require resource authority, expected
selection revision, idempotency and a durable outcome. Resource creation does
not wait for media upload. An absent selection resolves to the admitted fallback;
private, suppressed, erased or undeliverable media resolves safely without leaking
the asset reference. A fallback is presentation output and never changes the
resource's semantic types, statements or acceptance. An unsupported or retired
icon also resolves safely while retaining its authored choice for capable editors.

Image responses retain the eligible use/rendition and actual selection source.
Rendition size, delivery lifetime, revocation and erasure follow the existing
media policy. Name/type defaults and image selection are generation-bound so a
cached object list cannot retain a revoked avatar. Read descriptors and mutation
inputs are separate contracts: the read-only `fallback` result is not an authored
emoji/icon/image selection.

## Covers, banners and aspect ratios

CoverSet and BannerSet expose separate `covers` and `banners` maps keyed by target
aspect ratio in the admitted owner/context. Each selected entry references an
exact Media Use. Entries can coexist, reference different assets, or reuse an
asset with independent crop/focal/fit settings. These are reusable capabilities
for resource owners, not compulsory images or records on every object.

Conceptual shape; example Use IDs are illustrative, not a shipped API schema:

```json
{
  "covers": {
    "2:3": { "useId": "cover-a" },
    "16:9": { "useId": "cover-b" },
    "1:1": { "useId": "cover-c" }
  },
  "banners": {
    "3:1": { "useId": "banner-a" },
    "16:9": { "useId": "banner-b" }
  }
}
```

Cover and Banner remain separate roles even at the same ratio: a cover may carry
the work's title while a banner leaves space for page controls. Each role/ratio
has its own selection in the owner/context; the map is a logical/API shape, not
a requirement to replace the existing Media Use and selection owners with a JSON
blob. Neither role creates assets for absent entries.

### Ratio keys and presets

Keys use `width:height` with positive integers reduced to lowest terms by their
greatest common divisor: `1920:1080` and `32:18` normalize to `16:9`. Reject zero, negative,
non-finite or malformed components, and reject duplicate keys after normalization
instead of overwriting a selection. Floating-point strings such as `1.77778` and
hyphenated aliases such as `16-9` are not canonical keys. Preserve exact distinct
ratios; numerical closeness does not establish equality.

A key describes the intended display frame, not the source image's dimensions.
For example, a 3:4 original can be fully contained in a `2:3` cover frame. Crops,
fit and original dimensions remain independent data. Different resolutions of
one composition, such as 800x450 and 1600x900, are representations of the same
`16:9` selection, not additional cover entries.

The following width:height ratios are initial UI presets. Cover/Banner maps admit
other validated ratios within owner capacity limits; the presets are not a closed
storage enum, mandatory uploads or an industry standard. Editors preserve entries
whose ratios they do not expose in their ordinary controls.

| Use | Initial preset | Meaning |
| --- | --- | --- |
| Avatar | 1:1 | Square image crop; the renderer applies its mask. |
| Portrait cover | 2:3 | Standard portrait card/library frame. |
| Landscape cover | 16:9 | Standard landscape card/list frame. |
| Banner | 3:1 | Default resource page-header frame on desktop and mobile; other ratios may be selected explicitly. |
| Post attachment | Original aspect ratio | Each item retains its own dimensions; feed layout may constrain its viewport. |

Avatar remains one typed choice with a 1:1 image crop; it does not become a ratio
map. Portrait/landscape are editor labels and layout presets rather than stored
selection keys. Front/back/booklet describe content roles independently of ratios.

### Composition, selection and updates

Asset aspect ratio, authored crop and display-frame aspect ratio are distinct.
Cover uses support `contain` (show the selected image fully with background space)
and `cover` (fill the frame using an authored crop/focal point). Prefer full-image
display for book/album covers carrying titles; allow explicit crop-to-fill for
photographs and illustrations.

Banner editing previews the selected ratio, initially 3:1, and retains the
original, crop and focal point. The default desktop/mobile frame scales at 3:1
with container width; a surface requesting another ratio declares that display
profile and resolves the corresponding entry. It cannot stretch the image or
silently replace the authored composition. Pixel/byte limits and generated
rendition sizes belong to the processing policy.

Resolve an eligible exact ratio in the requested role first. If no entry is
available, use an explicitly admitted, role-local fallback policy with full-image
containment or return no image. A mathematically nearest ratio alone is not
permission to crop: it may cut title text or other content. A fallback must report
its actual readable source and fit without writing a new ratio entry. Never
implicitly cross between Cover and Banner roles. Resolved missing or
undisclosable selections return null without hidden asset references; public
reads must not expose ratio keys solely to reveal undisclosable selections.

Cover and Banner selection changes use current resource authority, expected
selection revision, idempotency and durable outcomes, as avatar selection does.
Changing/removing one role/ratio entry preserves the others, including unfamiliar
ratios. In a partial update, an omitted role or key is unchanged; null at a ratio
key clears that selection only. An empty map patch changes no entries and does
not mean clear-all. Absence and explicit clearing remain distinguishable where
context inheritance is admitted; explicit clearing cannot be silently undone by
inheritance or display fallback. Whole-set replacement/clearing requires explicit
operation semantics rather than treating a partial editor's map as exhaustive.

## Post attachments and preview selection

Posts retain an ordered list of exact Media Uses, with stable item identity and
each image's original dimensions/aspect ratio. Reordering preserves the identities
and bytes. A pure-text Post needs no image, and a normal short Post need not
provide any cover. Article-like Posts may additionally use the optional CoverSet
and BannerSet capabilities.

A Post's card/search/quote preview is a separate authored policy:

- `auto`: resolve the first currently eligible attachment in authored order
  under an explicit versioned policy; return no preview when none is eligible.
- `selected`: resolve the explicitly chosen attachment or separately attached
  preview image by exact Use identity, not array index. This never reorders the
  attachments. If that selection becomes undisclosable, return no preview without
  leaking its reference or silently choosing another attachment.
- `none`: intentionally render no preview, even when attachments exist.

Preview selection uses the same authority, revision and lifecycle guarantees as
other selections. Attachment removal must not leave an invalid authored reference;
the owning edit must resolve an affected preview choice explicitly. A preview
does not impose its card ratio on the original or on the Post body. Future video
attachments may select an eligible poster representation through the same media
model; this design does not claim an implemented video upload/transcode path.

Feed media height is a [presentation policy](presentation.md#post-feed-media-height).
It limits the displayed media region, not uploaded image dimensions or the exact
attachment data. Backend size/pixel/processing budgets remain separate. Full-image
viewing and article reading need not use the Feed's viewport crop or height cap.

## Upload and processing

Reserve upload intent, upload into quarantine, verify size/format/digest, perform
admitted scanning/transformation, then activate an asset representation through an
owner command. Object storage and graph publication form a staged workflow, not
one transaction. Orphans have expiry; published references pin required objects.

Transformation jobs bind exact input digest, profile, authority and erasure epoch.
Stale or cancelled workers cannot activate outputs. Do not fetch arbitrary URLs
with trusted network credentials; source acquisition enforces URL/redirect budgets.
Metadata-only external assets may keep locators without a fabricated byte digest.

## Delivery and lifecycle

Check current disclosure and selected use before signed delivery. Bound URL lifetime
and include revocation/erasure policy for cache/CDN and all derivatives. Changing
a remote URL's bytes creates a new observation, never mutates an exact reference.
Retraction, moderation suppression, deletion and physical erasure are separate.

Gallery reads page by owner/context/order with bounded hydration. Media role and
language fallback disclose their actual source selection. Qualify upload failure,
stale transformation, private thumbnails, conflicting cover selection, timed
subtitle references and erasure/recovery across every representation.

## Decision evidence and remaining validation

Primary references reviewed for the 2026-09-27 decision:

- [Notion Page API](https://developers.notion.com/reference/page) models typed
  emoji, icon and file choices. This supports structured avatar values without
  prescribing REZICS storage or fallback policy.
- [Steamworks Library Assets](https://partner.steamgames.com/doc/store/assets/libraryassets)
  separates a 600x900 Library Capsule, 920x430 Header and 3840x1240 Hero. Independent
  compositions inform the separate slots; REZICS's 16:9 landscape cover is its
  own choice, not Steam's Header specification.
- [X profile/header guidance](https://help.x.com/en/managing-your-account/common-issues-when-uploading-profile-photo)
  recommends a 1500x500 header and describes possible display cropping. REZICS
  uses 3:1 as its initial banner preset while allowing other ratio-keyed entries.
- [TYPO3 image manipulation](https://docs.typo3.org/m/typo3/reference-tca/main/en-us/ColumnsConfig/Type/ImageManipulation/Index.html)
  uses ratio keys such as `16:9` and separately named crop variants. It is a
  precedent for explicit ratio identifiers and contextual compositions, not the
  source of REZICS's canonicalization or role/ratio selection contract.
- [MDN responsive images](https://developer.mozilla.org/en-US/docs/Web/HTML/Guides/Responsive_images)
  distinguishes art direction from resolution switching: different compositions
  and multiple resolutions of a composition address different display needs.
- [X media data model](https://docs.x.com/x-api/fundamentals/data-dictionary)
  associates Post attachments with media identities and dimensions. It does not
  prescribe REZICS's preview policy or feed layout.
- [X photo posting guidance](https://help.x.com/en/using-x/posting-gifs-and-pictures)
  says single photos between 3:4 and 2:1 display in full, with a matching composer
  preview, and documents 1-4 photos with reordering. It gives no universal fixed
  pixel height or precise cross-client multi-photo layout. REZICS's Feed height
  formula is a proposed UI policy, not a claim about X's implementation or an
  adoption of its attachment count limit.
- [Sanity image model](https://www.sanity.io/docs/studio/image-type) separates
  asset references from contextual crop, hotspot and caption data, supporting
  reuse of one original with independently edited uses.

Before implementation acceptance, prove selection round trips, ratio-key
normalization, square crop validation, independent entries, concurrency and
disclosure through real owner APIs. Before rendered acceptance, inspect representative title-bearing covers,
square album art, very tall/wide Post images, multi-image Posts and banner
overlays on desktop/mobile, including the candidate Feed height budget. These
defaults remain unverified in REZICS UI; prospective checks belong to
[presentation acceptance](../testing/presentation-and-addressing.md).
