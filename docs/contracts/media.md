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
content reference graph. A semantic graph profile for the Asset is deferred;
the existing PostgreSQL media identity and object custody remain its owners.

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

## Post attachments and preview selection

Body attachments retain exact identity, original dimensions and authored order.
The pending card preview choices are auto, selected Use and none; they do not
rewrite body media. The Feed height candidate needs rendered validation across
ratios, item counts and viewports. Full-image and article views remain separate.

## Decision evidence and remaining validation

Independent compositions follow [art direction](https://developer.mozilla.org/en-US/docs/Web/HTML/Guides/Responsive_images),
while contextual crops follow [Sanity's image model](https://www.sanity.io/docs/studio/image-type).
Pending cases and the Feed candidate are typed in [presentation cases](../../scripts/qa/cases/presentation-and-addressing.ts).
