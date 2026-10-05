---
# Coarse areas other Goals' briefs may not claim (goalctl reads them at every dispatch). Migrations are not listed:
# each task reserves its own numbers. Shared files (media module, Work page, zone-sdk) are claimed per task.
areas:
  - apps/web/features/showcase/**
  - apps/web/features/zones/**
  - packages/ui/src/components/carousel*
  - services/main/src/modules/zone/**
  - services/main/src/modules/media-rendition/**
  - model/definitions/zone-presentation-*
---

# Media showcase

Status: started on 2026-10-05 by the maintainer, manager `rezics-next-f9` (was `rezics-next-01` until a session restart)
(manager worktree `.temp/worktrees/showcase-manager`). [state.md](state.md)
records where the work stands.

## Outcome

A Zone's hero is a media showcase as [decision 54](../../product/decisions.md#decision-54)
describes ([showcase carousel](../../contracts/presentation.md#showcase-carousel),
[showcase art](../../contracts/media.md#showcase-art)): the window sets the
stage, slides are layers, art belongs to the Work and banners never slide.
Readers on a phone, a tablet, a foldable and a desktop each see a stage that
fits their window, with art made for its shape, a title in their language and
no motion they did not ask for. Work maintainers upload showcase art once and
every Zone, the Work page and lists use it; Zone moderators choose and order
slides, schedule them and override art for a campaign.

## Basis

- The hero is `apps/web/features/zones/carousel.tsx` (a scroll-snap track that
  never advances) with `PickSlide` and `BannerSlide` in `modules.tsx`;
  `BannerSlide` crops one image to 1.9:1 from its centre. Official packages
  replace the hero through `HeroSlotProps` in `packages/zone-sdk`.
- `packages/ui/src/components/carousel.tsx` is SharkUI's Ark carousel. It
  renders every slide `aria-hidden` on the server, its autoplay does not pause
  on hover or focus, its track clips overflow and it forces `object-cover` on
  images.
- `zone-presentation-v1` banners hold one image id each; no web UI edits a
  Zone's presentation (`PUT /v1/zones/:id/configuration` only).
- Media selection slots allow only the `avatar` role; renditions are modelled
  (`transform_job`, `representation.kind = 'rendition'`) but nothing produces
  them, and no read returns a `srcset`.
- The Work page header shows no art. No Content-Security-Policy names
  `frame-src`.
- Research and measured references: `.temp/research/carousel-frames/` and
  `.temp/research/carousel-media/` (reports and screenshots, local only).

## Milestones

The manager revises them. A milestone counts when merged, its checks pass and
its journeys pass through the API and in a real browser against the local
stack, with screenshots reviewed at 390, 820, 1280 and 1920 px.

- **S1 Stage and slides.** The carousel primitive is accessible on the server
  and pauses as the decision requires; the showcase stage renders layered
  slides from a typed view model: stage table, `<picture>` sources and
  preload, cover-composed and art slides, title presets, ambient backdrop,
  cutout layer, parallax, rotation policy and the trailer facade. Stories cover
  the viewport, locale, RTL and reduced-motion matrix with fixture art.
- **S2 Renditions.** Main produces AVIF and WebP width renditions of a Use's
  crop and returns them as `srcset` candidates.
- **S3 Showcase art.** Work showcase art (backgrounds, logos by language and
  tone with anchors, cutout, trailer link) is selected, read and authorized
  like the Work's cover; Work and Zone reads carry it.
- **S4 Zone slides.** `zone-presentation-v2` replaces banners with slides
  (a Work or a link, kicker, title, campaign art, schedule); v1 documents read
  as v2.
- **S5 Editors and surfaces.** A showcase art editor for Works and a showcase
  editor in Realm management, both previewing the real stage shapes; the Zone
  hero and the Work page header use the art; the dev stack seeds examples.
- **S6 Acceptance.** Browser journeys for editing and viewing, screenshot
  review across the matrix, LCP of the first slide, decisions folded and the
  Goal closed.

Cut lines if time runs short: S1–S4 and the Zone hero must ship; the Work page
header, parallax and the filmstrip can follow.
