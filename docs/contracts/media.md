# Media assets, representations and uses

An Asset identifies maintained media, a Representation its exact bytes, and a Use
its role on another Resource. Separate identities permit reuse without sharing
authority, crop or rights. Delivery URLs never identify selections. Staged
processing keeps unverified uploads and stale transforms out of public media.

## Image presentation

Maintainer decision, 2026-10-02. NSFW, authored concealment and age assessment
are independent. NSFW and assessment describe exact image representations;
concealment belongs to an individual Use or document image occurrence. The
viewer combines those values with Account preferences when rendering. NSFW
defaults to a mask; an authored mask can also conceal an ordinary image.
Revealing it changes only the current viewing state.

Client classification is retained as versioned evidence for exact bytes and may
initialize an otherwise unknown NSFW value. Human decisions and protected fields
are not overwritten by later observations. The producer can later move to the
server without changing these meanings. Classification failures remain unknown
and do not decide media clearance. Privacy, binary validity, known-copy suppression
and actual platform enforcement remain separate delivery concerns.

The Media owner binds these fields to the existing editorial protection protocol;
whole-document saves also check protected image occurrences. Reads batch the
images actually referenced by the consumer and do not recursively classify a
content reference graph. The Asset never becomes a graph node; the existing
PostgreSQL media identity and object custody remain its owners, and images
enter the graph only as [image Works](#images-in-the-semantic-graph).

## Images in the semantic graph

Maintainer decision, 2026-10-04. Images have the same semantic standing as video
and audio; only their rollout is restricted. The direction is Pixiv and
Danbooru, as it is YouTube for video and Spotify for audio: hosted artwork and an
index of images by creator, source Work, depicted characters and Concepts.
Images are worth indexing, but betting early effort on them would be a major
waste, and they carry the highest moderation and rights cost per item. So the
capability ships late, and even then it requires an explicit platform grant, like other
restricted surfaces, never an ordinary Account default.

A person promotes a chosen image to a Work of type `schema:ImageObject`
(`schema:Photograph` and `schema:VisualArtwork` describe it further). Its Main
Version holds a `media-set-v1` publication that pins exact asset revisions and
Representations, so a gallery is the same Work kind with more items. Credits,
Concepts, relations, ratings, discussion and lists attach through the type as
for any Work. The graph holds Work facts and Representation identities; digests,
alternative text, private uploads, selection history and classifier scores stay
here, so erasing bytes leaves an explicitly unavailable realization and needs no
graph rebuild. NSFW and age assessment stay on Representations; Work suitability
is a separate judgment. Promotion is never automatic: an image without a claimed
creator or a credited source is not a Work. An index entry for someone else's
image follows [metadata-only](metadata-only.md) hosting and links its source
instead of rehosting the bytes.

Language belongs to the version, not the bytes, as it does for
[text](content-languages.md#language-belongs-to-the-content-version). Names and
descriptions are localized Work values; alternative text belongs to the
occurrence and follows its document's language. An image with linguistic
content, such as a typeset comic page, poster or infographic, has one language
contribution per language, each pinning its own Representation and its exact
source. A shared identity keeps ratings, credits, depicted characters, page
correspondence and translation state together, which separate Assets lose; a
post that uses an image once may still reference a different Asset per
language. Comic pages need a stable occurrence each, so a translated page can
pin its source page. The eventual form is `zxx` artwork with per-language text
annotations placed by media-fragment selectors, as Danbooru notes translate text
over an image and subtitles do for video. It needs text-free artwork, which
official sources rarely supply, so per-language bitmaps remain supported.

When the grant opens, the order is: type admission and promotion, with an
asset-to-Work index so existing Uses can show credits; image language
contributions; comic page occurrences; `depicts` region annotations; text
layers. Hosted video and audio reuse the same Work, contribution and
Representation path.

## Universal avatar selection

The shipped ResourceSummary returns image or stable fallback after Resource read
checks. The pending emoji/icon/image choice keeps Unicode, admitted icon ID or
exact Use without a fabricated Asset. Hidden images fall back without leaking
their basis. A saved square crop precedes the renderer's mask.

## Covers, banners and aspect ratios

The adopted CoverSet and BannerSet are independent optional maps by canonical
width:height ratio. Portrait 2:3, landscape 16:9 and banner 3:1 are initial
editor presets, not storage limits. A ratio names the display frame; the Use
retains its own source, crop, focal point and contain/cover fit. Exact selection
precedes an admitted role-local fallback. A missing banner leaves no banner
region, and no cover becomes a banner implicitly. These APIs remain pending.
A banner is one static image; the sliding hero is the
[showcase](presentation.md#showcase-carousel).

## Showcase art

Maintainer decision, 2026-10-05. Showcase art belongs to the Work, so every
Zone that features it, the Work page and lists reuse one upload; a Zone's slide
may override it for a campaign. Its roles are background landscape (16:9),
background portrait (3:4), logo and cutout. A logo is language-neutral (`zxx`)
or names its language, comes in a dark or light tone and carries an anchor;
logos and cutouts need an alpha channel. Each selection is a Use with its own
crop and focal area, and selections extend the avatar selection slots with
these roles rather than add a store, under the authority that selects the Work's
cover. A trailer is a link on the Work, not media.

Main derives width renditions (AVIF and WebP) of each selected showcase image
from its crop when it is selected, and reads return them as `srcset`
candidates. A rendition never adds a ratio or a selection. The reason is that
showcase art is the largest image a page loads, and the stage asks for it at
every width from a phone to a desktop.

## Post attachments and preview selection

Body attachments retain exact identity, original dimensions and authored order.
The pending card preview choices are auto, selected Use and none; they do not
rewrite body media. The Feed height candidate needs rendered validation across
ratios, item counts and viewports. Full-image and article views remain separate.

## Decision evidence and remaining validation

Independent compositions follow [art direction](https://developer.mozilla.org/en-US/docs/Web/HTML/Guides/Responsive_images),
while contextual crops follow [Sanity's image model](https://www.sanity.io/docs/studio/image-type).
Pending cases and the Feed candidate are typed in [presentation cases](../../scripts/qa/cases/presentation-and-addressing.ts).
