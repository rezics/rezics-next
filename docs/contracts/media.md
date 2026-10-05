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

`PUT /v1/resources/{work}/showcase/art` selects or removes one role with the
observed `expectedSelection` and an `Idempotency-Key`. It uses the same
`media:avatar:{work}` scope and `media.avatar` action as the Work's avatar.
Logo keys use canonical BCP 47 language and tone; changing an anchor replaces
that key's selection. A Work keeps logos in at most eight languages, counting
languages whose logo was removed; a ninth is refused with 422
`showcase_logo_limit`. Anchors are `start-bottom`, `center-top`, `center-middle`
and `center-bottom`. Crops and optional focal areas use `xywh=percent:` on
oriented source pixels; a focal area lies within the selected crop. Landscape
crops must be exactly 16:9 and at least 1280×720; portrait crops must be exactly
3:4 and at least 960×1280. Logos and cutouts require an alpha channel, including
an entirely opaque alpha channel. Invalid crop, wrong ratio, insufficient
resolution and missing alpha return distinct problem codes.

`PUT /v1/resources/{work}/showcase/trailer` uses the same expected-head,
authority, replay and explicit-null removal rules. YouTube watch, short,
embed, live and shorts links normalize to `https://www.youtube.com/watch?v=…`;
Bilibili BV/av and player links normalize to `https://www.bilibili.com/video/…/`,
retaining a multipart `p` parameter. Tracking parameters are discarded for
these providers. Other HTTPS URLs remain plain links. Main does not fetch
links or resolve short-link redirects; credentials and non-HTTPS URLs are
refused. Equivalent canonical watch URLs bind the same retry intent.

Main derives width renditions (AVIF and WebP) of each selected showcase image
from its crop when it is selected, and reads return them as `srcset`
candidates. A rendition never adds a ratio or a selection. The reason is that
showcase art is the largest image a page loads, and the stage asks for it at
every width from a phone to a desktop.

A rendition shows its source representation's NSFW and age assessment,
marked as derived from that source, until it is labelled itself (manager
decision, 2026-10-05). Main makes the rendition from the same pixels, so it
is the same image; leaving it unknown masked every showcase image whose
original was labelled. Labels still never pass between uploads, Assets or
representations that Main did not derive from one another.

`POST /v1/resources/showcase` reads up to 64 Work targets together, preserving
request order. For each readable Work it returns selected images, their crop,
focal area and width candidates, each logo's language, tone and anchor, and its
trailer. Each requested context's role/key wins over the default, including
explicit removal and hidden art. Hidden or erased art is absent; an unreadable
Work has only an unavailable descriptor. The batch uses one media query after
the existing batched target disclosure and Access read, with at most twelve
candidates per selected image; all selected logo languages (at most eight) are retained.
Responses revalidate on every read. Selection replacement and removal also
invalidate the preceding Use's delivery URLs. Pending renditions leave an
empty candidate list while the admitted original remains available with its
authored crop. An image's `width`/`height` describe the oriented original URL;
`cropWidth`/`cropHeight` describe the selected frame. Candidate URLs already
contain the authored crop and report their own dimensions.

Public art and covers share one cached copy across readers, including requests
with a bearer or an acting Agent: identical public bytes are `public, no-cache`,
with their digest as ETag. A byte read naming no Agent is decided as the
anonymous reader first, so public delivery costs no Account introspection.
Private or draft targets are `private, no-store`, so private bytes never rest in a
shared device's browser cache (VIEW07); an Asset's public disclosure
does not make its target or context public. Every conditional read repeats
the current disclosure, selection and clearance checks before answering 304,
so replacement, removal or revoked access cannot reuse an earlier response.
Private downloads governed by an Access read lease remain `private, no-store`:
each transfer requires a fresh lease and accounts for the delivered bytes.
These cache directives follow [RFC 9111](https://www.rfc-editor.org/rfc/rfc9111.html#section-5.2.2).
Pages read the labels of the art they draw first with the page, so the first
slide and the Work header are images, or masks, in the server's HTML and are
preloaded only when shown.

## Post attachments and preview selection

Body attachments retain exact identity, original dimensions and authored order.
The pending card preview choices are auto, selected Use and none; they do not
rewrite body media. The Feed height candidate needs rendered validation across
ratios, item counts and viewports. Full-image and article views remain separate.

## Decision evidence and remaining validation

Independent compositions follow [art direction](https://developer.mozilla.org/en-US/docs/Web/HTML/Guides/Responsive_images),
while contextual crops follow [Sanity's image model](https://www.sanity.io/docs/studio/image-type).
Pending cases and the Feed candidate are typed in [presentation cases](../../scripts/qa/cases/presentation-and-addressing.ts).
