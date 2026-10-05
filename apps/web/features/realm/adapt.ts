import type { ZoneBanner, ZoneDecision, ZoneImage, ZonePerson, ZoneShowcaseArt, ZoneShowcaseImage, ZoneShowcaseSlide, ZoneText, ZoneWork } from '@rezics/zone-sdk';
import type { ShowcaseImage, WorkShowcase } from '../api/showcase.ts';
import type { UiLocale } from '../../i18n/define.ts';
import type { CanonicalAddress } from '@rezics/model/address';
import { resourceHref, siteMemberTarget } from '../address/path.ts';
import { BFF_PREFIX } from '../api/browser.ts';
import { profileHref } from '../profile/route.ts';
import { authorHref } from '../author/route.ts';
import { zoneContentText } from '../language/untagged.ts';
import { coverKindOf } from '../catalogue/work.ts';
import { isoMoment, zoneWorkCards } from '../zones/adapt-cards.ts';
import type { FallbackReason, MainExecution, PresentationBanner, PresentationSlide } from '../zones/presentation.ts';
import { decisionHref, realmWorkHref, scopedWorkHref } from './route.ts';
import type {
  MainAvatar,
  MainName,
  RealmDecision,
  WorkCard,
  ZonePresentationRead,
} from './types.ts';

// Main's read shapes to the Zone SDK's public data. Every module and package
// sees only these, so Main detail (revisions, positions, basis flags) stays here.

export function zoneText(name: MainName): ZoneText;
export function zoneText(name: MainName | null): ZoneText | null;
export function zoneText(name: MainName | null): ZoneText | null {
  return name ? { value: name.value, lang: name.language, dir: name.direction } : null;
}

/**
 * An image Main serves, as a path through the BFF; a generated fallback is no
 * image. A signed-in reader's BFF sends their token, so Main also needs the
 * Agent they read as (`avatarQuery`).
 */
export function zoneImage(avatar: MainAvatar | null, avatarQuery = ''): ZoneImage | null {
  return avatar?.kind === 'image'
    ? {
        url: `${BFF_PREFIX}${avatar.url}${avatarQuery}`,
        width: avatar.width,
        height: avatar.height,
      }
    : null;
}

/** Main verifies the exact public media Use and supplies its real dimensions. */
export function bannerImage(
  banner: PresentationBanner,
  media: readonly { id: string; image: ZoneImage & { mediaType?: string } }[],
): ZoneImage | null {
  const image = media.find((item) => item.id === banner.id)?.image;
  return image
    ? { url: `${BFF_PREFIX}${image.url}`, width: image.width, height: image.height }
    : null;
}

/** A `xywh=percent:` fragment as fractions of its image; null for anything else. */
function percentArea(area: string | null | undefined) {
  if (!area?.startsWith('xywh=percent:')) return null;
  const values = area.slice(13).split(',').map(Number);
  if (values.length !== 4 || values.some(number => !Number.isFinite(number))) return null;
  const [x, y, width, height] = values as [number, number, number, number];
  return { x: x / 100, y: y / 100, width: width / 100, height: height / 100 };
}

/** Main's percent rectangle is normalized relative to the selected crop's image. */
export function showcaseFocal(value: string | null | undefined, crop?: string | null) {
  const focal = percentArea(value);
  if (!focal) return undefined;
  const selected = percentArea(crop) ?? { x: 0, y: 0, width: 1, height: 1 };
  return { x: (focal.x - selected.x) / selected.width, y: (focal.y - selected.y) / selected.height,
    width: focal.width / selected.width, height: focal.height / selected.height };
}

/** Showcase art is public and its batch reads are anonymous, so its URLs name no reader and every reader shares one cached copy. */
const showcaseUrl = (url: string) => (url.startsWith('/v1/') ? `${BFF_PREFIX}${url}` : url);

/**
 * Delivery candidates name their codec; a srcset cannot contain duplicate widths for two codecs.
 * Candidates already hold the authored crop. While they are pending the URL is the original, so the
 * crop travels as `view` for the stage to draw from it; the frame then never shows more or less
 * than the author chose.
 */
export function deliveredShowcaseImage(
  image: {
    url: string;
    width: number;
    height: number;
    focalArea?: string | null;
    crop?: string | null;
    cropWidth?: number;
    cropHeight?: number;
    srcset: readonly { url: string; width: number; type: string }[];
  },
): ZoneShowcaseImage {
  const codec = image.srcset.some((candidate) => candidate.type === 'image/webp')
    ? 'image/webp'
    : 'image/avif';
  const crop = percentArea(image.crop);
  const cropped = crop && (crop.x > 0 || crop.y > 0 || crop.width < 1 || crop.height < 1);
  // Match Main's oriented pixel rounding, including subpixel crops at the edge.
  const pixels = (fraction: number, dimension: number) => Math.round(fraction * 100_000) * dimension / 100_000;
  const left = crop ? Math.floor(pixels(crop.x, image.width)) : 0;
  const top = crop ? Math.floor(pixels(crop.y, image.height)) : 0;
  const width = crop
    ? Math.min(image.width - left, Math.ceil(pixels(crop.width, image.width)))
    : image.width;
  const height = crop
    ? Math.min(image.height - top, Math.ceil(pixels(crop.height, image.height)))
    : image.height;
  return {
    url: showcaseUrl(image.url),
    width: image.cropWidth ?? image.width,
    height: image.cropHeight ?? image.height,
    framed: true,
    focal: showcaseFocal(image.focalArea, image.crop),
    ...(!image.srcset.length && cropped
      ? {
          view: {
            x: left / image.width,
            y: top / image.height,
            width: width / image.width,
            height: height / image.height,
          },
        }
      : {}),
    avifCandidates: image.srcset
      .filter((candidate) => candidate.type === 'image/avif')
      .map((candidate) => ({ url: showcaseUrl(candidate.url), width: candidate.width })),
    candidates: image.srcset
      .filter((candidate) => candidate.type === codec)
      .map((candidate) => ({ url: showcaseUrl(candidate.url), width: candidate.width })),
  };
}

/** A logo keyed `zxx` (no linguistic content, as Main keys language-neutral logos) or `und` serves every title language. */
const logoLanguage = (language: string | undefined) => !language || language === 'zxx' || language === 'und' ? '' : language;

export function workShowcaseArt(item: WorkShowcase): ZoneShowcaseArt {
  const role = (name: ShowcaseImage['role']) => {
    const image = item.images.find(image => image.role === name);
    return image ? deliveredShowcaseImage(image) : null;
  };
  return { landscape: role('background-landscape'), portrait: role('background-portrait'), cutout: role('cutout'),
    logos: item.images.flatMap(image => image.role === 'logo' && image.tone && image.anchor
      ? [{ ...deliveredShowcaseImage(image), tone: image.tone, anchor: image.anchor,
        language: logoLanguage(image.language) }] : []) };
}

export function campaignShowcaseArt(slideId: string, media: ZonePresentationRead['slideMedia']): ZoneShowcaseArt | null {
  const art = media.find(item => item.id === slideId)?.art;
  if (!art) return null;
  // Art is framed for the stage when its selected crop, not its original, has the stage's ratio.
  const background = (image: NonNullable<typeof art.landscape> | null, ratio: number) => {
    const delivered = image ? deliveredShowcaseImage(image) : null;
    return delivered ? { ...delivered, framed: Math.abs(delivered.width / delivered.height - ratio) < .001 } : null;
  };
  return { landscape: background(art.landscape, 16 / 9),
    portrait: background(art.portrait, 3 / 4),
    cutout: art.cutout ? deliveredShowcaseImage(art.cutout) : null,
    logos: art.logos.map(image => ({ ...deliveredShowcaseImage(image), tone: image.tone,
      anchor: image.anchor, language: logoLanguage(image.language) })) };
}

/** The configured target and localized copy survive media fallback; unavailable Works stay absent. */
export function presentationSlide(slide: PresentationSlide, work: ZoneWork | null,
  context: AdaptContext, media: ZonePresentationRead['slideMedia']): ZoneShowcaseSlide | null {
  if ('work' in slide && !work) return null;
  const title = slide.titles?.[context.locale];
  const kicker = slide.kickers?.[context.locale];
  return { id: slide.id, href: 'href' in slide ? slide.href : work!.href, work,
    title: title !== undefined ? zoneContentText(title, context.locale)
      : slide.title ? zoneContentText(slide.title) : work?.title ?? zoneContentText(''),
    kicker: kicker !== undefined ? zoneContentText(kicker, context.locale)
      : slide.kicker ? zoneContentText(slide.kicker) : null,
    tagline: work?.tagline, art: campaignShowcaseArt(slide.id, media) };
}

/** Legacy uploads were not authored for a showcase frame, so the renderer must preserve the whole image. */
export function bannerSlide(banner: ZoneBanner): ZoneShowcaseSlide {
  return { id: banner.id, href: banner.href, title: banner.title, kicker: banner.kicker, work: banner.work,
    art: banner.image ? { landscape: { ...banner.image, framed: false } } : null,
    tagline: banner.work?.tagline };
}

export interface AdaptContext {
  locale: UiLocale;
  ref: string;
  realm: string;
  /** The Zone UUID whose mounted Collection routes supply home shelves. */
  zone?: string;
  /** A Realm with no Zone has no site to open a Work in; its Works open on their own pages. */
  unrouted?: boolean;
  /** The Zone's mounted Collections by their IRI, to the route segment their members open under. */
  mounts?: ReadonlyMap<string, string>;
  /** `?actingSubject=` for a signed-in reader's cover reads, or empty; showcase art names no reader. */
  avatarQuery?: string;
}

/**
 * Where a Work opens from this Zone: its site, through the mount it came from when it did. Main marks a Work
 * `inZone: false` when it is not in the Zone's population (a discussion about a Work that lost its adoption, a
 * list member removed since): the Zone's site has no page for it, so it opens on its canonical page. Membership
 * is never decided here.
 */
export function workLink(
  context: AdaptContext,
  work: string,
  mount: string | null = null,
  tab?: 'discussion',
  inZone?: boolean,
  address?: CanonicalAddress,
) {
  if (inZone === false) return resourceHref('/w/', address ?? work);
  return context.unrouted
    ? scopedWorkHref(address ?? work, context.realm)
    : realmWorkHref(
        context.ref,
        // /w inside a site always uses identity; a mounted route may select names.
        mount ? siteMemberTarget(work, address) : work,
        mount,
        tab,
      );
}

/**
 * A Work card in this Zone. `decision` is the public Decision that placed
 * it here (the adoption's selection); `mount` is the mounted Collection it came from, if any.
 * Main marks a card `inZone: false` when the Work is not in this Zone's population: it then opens on its
 * canonical page, since the Zone's site has no page for it. Membership is never decided here.
 */
export function zoneWork(
  card: WorkCard & {
    primaryCredits?: ModuleCredit[];
    inZone?: boolean;
    address?: CanonicalAddress;
  } & Parameters<typeof zoneWorkCards>[0],
  context: AdaptContext,
  decision: string | null,
  mount: string | null = null,
): ZoneWork {
  const credit = card.primaryCredits?.find((item) => item.displayName);
  const author = credit?.displayName;
  const href = credit?.agent
    ? authorHref({ kind: 'agent', handle: credit.handle, agent: credit.agent })
    : credit?.provider === 'open-library' && credit.key
      ? authorHref({ kind: 'external', key: credit.key })
      : null;
  return {
    id: card.id,
    href: workLink(context, card.id, mount, undefined, card.inZone, card.address),
    title: zoneText(card.title),
    cover: zoneImage(card.cover, context.avatarQuery),
    kind: coverKindOf(card.types),
    author: author ? zoneContentText(author) : null,
    authorHref: href,
    tagline: zoneText(card.tagline),
    status: card.completionStatus,
    chapters: card.chapterCount,
    words: card.wordCount,
    updatedAt: isoMoment(card.lastUpdatedAt),
    decision: decision ? decisionHref(context.locale, context.ref, decision) : null,
    ...zoneWorkCards(card),
  };
}

/** A Work's credited author as Main's module reads name them: a REZICS Agent, or a source such as Open Library. */
export interface ModuleCredit {
  agent: string | null;
  handle: string | null;
  displayName: string | null;
  provider: string | null;
  key: string | null;
}

/**
 * The people behind a feed's Works, as a people module shows them: each named
 * author once, in the order their Works arrived here, with those Works as the
 * note. Identified authors link to their REZICS page.
 */
export function zonePeople(
  works: readonly { title: MainName; primaryCredits?: readonly ModuleCredit[] }[],
  limit: number,
): ZonePerson[] {
  const found = new Map<string, { person: Omit<ZonePerson, 'note'>; titles: MainName[] }>();
  for (const work of works) {
    for (const credit of work.primaryCredits ?? []) {
      if (!credit.displayName) continue;
      const id = credit.agent ?? `${credit.provider}:${credit.key ?? credit.displayName}`;
      const entry = found.get(id);
      if (entry) {
        if (!entry.titles.some((title) => title.value === work.title.value))
          entry.titles.push(work.title);
        continue;
      }
      if (found.size >= limit) continue;
      found.set(id, {
        titles: [work.title],
        person: {
          id,
          name: zoneContentText(credit.displayName),
          href: credit.agent
            ? profileHref({ handle: credit.handle, id: credit.agent })
            : credit.provider === 'open-library' && credit.key
              ? authorHref({ kind: 'external', key: credit.key })
              : `/search?${new URLSearchParams({ q: credit.displayName })}`,
          avatar: null,
        },
      });
    }
  }
  return [...found.values()].map(({ person, titles }) => {
    const lang = titles.every((title) => title.language === titles[0]!.language)
      ? titles[0]!.language
      : '';
    const note = titles.map((title) => title.value).join(' · ');
    return { ...person, note: zoneContentText(note, lang) };
  });
}

/** A Decision in the Zone's words, titled from the Works this page already read. */
export function zoneDecision(
  decision: RealmDecision,
  context: AdaptContext,
  works: ReadonlyMap<string, ZoneWork>,
): ZoneDecision {
  const work = decision.work ? (works.get(decision.work) ?? null) : null;
  return {
    id: decision.id,
    kind: decision.kind,
    outcome: decision.outcome,
    sequence: decision.sequence,
    work: work ? { id: work.id, href: work.href, title: work.title } : null,
    href: decisionHref(context.locale, context.ref, decision.id),
  };
}

const mainReasons: Record<
  Extract<ZonePresentationRead['execution'], { state: 'fallback' }>['reason'],
  FallbackReason
> = {
  safe_mode: 'safe-mode',
  viewer_opt_out: 'viewer-opt-out',
  none_approved: 'none-approved',
  globally_disabled: 'global-disabled',
  revoked: 'revoked',
  expired: 'expired',
};

/**
 * Main's execution report gates the installed package by its reviewed source digest.
 */
export function mainExecution(read: ZonePresentationRead): MainExecution {
  if (read.execution.state === 'package')
    return { approved: { digest: read.execution.packageDigest }, reason: 'none-approved' };
  return {
    approved: null,
    reason:
      read.execution.state === 'fallback' ? mainReasons[read.execution.reason] : 'none-approved',
  };
}

/** Banners whose schedule includes `now`. */
export function liveBanners(
  banners: readonly PresentationBanner[],
  now: number,
): PresentationBanner[] {
  return liveSlides(banners, now);
}

export function liveSlides<Slide extends { startsAt?: string; endsAt?: string }>(slides: readonly Slide[], now: number): Slide[] {
  return slides.filter(
    (banner) =>
      (!banner.startsAt || Date.parse(banner.startsAt) <= now) &&
      (!banner.endsAt || now < Date.parse(banner.endsAt)),
  );
}
