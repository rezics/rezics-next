# Media assets, representations and uses

Status: Avatar, CoverSet, Banner and Post media design adopted on 2026-09-27.
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

CoverSet provides independent nullable `portrait` and `landscape` selections in
the admitted owner/context. Both can exist simultaneously, reference different
assets, or reuse an asset with different Media Uses. Banner is a separate nullable
selection for the resource's page header. These are reusable capabilities for
resource owners, not compulsory images or records on every object.

The following ratios are width:height. They define REZICS presentation profiles,
not required dimensions of uploaded originals or claims of an industry standard.

| Use | Adopted profile | Meaning |
| --- | --- | --- |
| Avatar | 1:1 | Square image crop; the renderer applies its mask. |
| Portrait cover | 2:3 | Standard portrait card/library frame. |
| Landscape cover | 16:9 | Standard landscape card/list frame. |
| Banner | 3:1 | Standard resource page-header frame on desktop and mobile. |
| Post attachment | Original aspect ratio | Each item retains its own dimensions; feed layout may constrain its viewport. |

Asset aspect ratio, authored crop and display-frame aspect ratio are distinct.
Cover uses support `contain` (show the selected image fully with background space)
and `cover` (fill the frame using an authored crop/focal point). Prefer full-image
display for book/album covers carrying titles; allow explicit crop-to-fill for
photographs and illustrations. Portrait/landscape identify presentation slots;
front/back/booklet identify content roles and remain independent metadata.

Banner editing uses a 3:1 composition preview and retains the original, crop and
focal point. Its initial desktop/mobile frame scales at 3:1 with container width.
1500x500 and 1800x600 are examples of the same ratio, not two profiles or mandatory
upload sizes. Pixel/byte limits and generated rendition sizes belong to the
processing policy. A later surface needing a different frame ratio must declare
that profile and preview its focal-point crop; it cannot stretch the image or
silently replace the authored composition.

Cover and Banner selection changes use current resource authority, expected
selection revision, idempotency and durable outcomes, as avatar selection does.
Changing/removing one slot preserves the others. In a partial update, an omitted
slot is unchanged; explicit null clears that slot. Absence and explicit clearing
must remain distinguishable where context inheritance is admitted. No implicit
cover-to-banner, banner-to-cover or cross-orientation selection is authored.
Resolved absent or undisclosable cover/banner slots return null without hidden
asset references. An explicitly admitted display fallback can reuse a readable
image without persisting a new selection and must identify its actual basis.

## Post attachments and preview selection

Posts retain an ordered list of exact Media Uses, with stable item identity and
each image's original dimensions/aspect ratio. Reordering preserves the identities
and bytes. A pure-text Post needs no image, and a normal short Post need not
provide portrait and landscape covers. Article-like Posts may additionally use
the optional CoverSet and Banner capabilities.

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
  selects 3:1 as its initial shared profile, with explicit later profile changes.
- [X media data model](https://docs.x.com/x-api/fundamentals/data-dictionary)
  associates Post attachments with media identities and dimensions. It does not
  prescribe REZICS's preview policy or feed layout.
- [Sanity image model](https://www.sanity.io/docs/studio/image-type) separates
  asset references from contextual crop, hotspot and caption data, supporting
  reuse of one original with independently edited uses.

Before implementation acceptance, prove selection round trips, square crop
validation, independent slots, concurrency and disclosure through real owner
APIs. Before rendered acceptance, inspect representative title-bearing covers,
square album art, very tall/wide Post images, multi-image Posts and banner
overlays on desktop/mobile. These defaults remain unverified in REZICS UI;
prospective checks belong to [presentation acceptance](../testing/presentation-and-addressing.md).
