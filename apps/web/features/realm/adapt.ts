import type { ZoneDecision, ZoneImage, ZonePerson, ZoneText, ZoneWork } from '@rezics/zone-sdk';
import type { UiLocale } from '../../i18n/define.ts';
import { BFF_PREFIX } from '../api/browser.ts';
import { profileHref } from '../profile/route.ts';
import { authorHref } from '../author/route.ts';
import { zoneContentText } from '../language/untagged.ts';
import { coverKindOf } from '../catalogue/work.ts';
import { isoMoment, zoneWorkCards } from '../zones/adapt-cards.ts';
import type { FallbackReason, MainExecution, PresentationBanner } from '../zones/presentation.ts';
import { decisionHref, realmWorkHref } from './route.ts';
import type { MainAvatar, MainName, RealmDecision, WorkCard, ZonePresentationRead } from './types.ts';

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
    ? { url: `${BFF_PREFIX}${avatar.url}${avatarQuery}`, width: avatar.width, height: avatar.height } : null;
}

/** Main verifies the exact public media Use and supplies its real dimensions. */
export function bannerImage(banner: PresentationBanner,
  media: ZonePresentationRead['bannerMedia']): ZoneImage | null {
  const image = media.find(item => item.id === banner.id)?.image;
  return image ? { url: `${BFF_PREFIX}${image.url}`, width: image.width, height: image.height } : null;
}

export interface AdaptContext {
  locale: UiLocale; ref: string; realm: string;
  /** `?actingSubject=` for a signed-in reader's media reads, or empty. */
  avatarQuery?: string;
}

/**
 * A Work card in this Zone. `decision` is the public Decision that placed
 * it here (the adoption's selection).
 */
export function zoneWork(card: WorkCard & { primaryCredits?: ModuleCredit[] }
  & Parameters<typeof zoneWorkCards>[0],
  context: AdaptContext, decision: string | null): ZoneWork {
  const credit = card.primaryCredits?.find(item => item.displayName);
  const author = credit?.displayName;
  const href = credit?.handle ? authorHref({ kind: 'agent', handle: credit.handle })
    : credit?.provider === 'open-library' && credit.key
      ? authorHref({ kind: 'external', key: credit.key }) : null;
  return { id: card.id, href: realmWorkHref(card.id, context.realm), title: zoneText(card.title),
    cover: zoneImage(card.cover, context.avatarQuery), kind: coverKindOf(card.types),
    author: author ? zoneContentText(author) : null,
    authorHref: href,
    tagline: zoneText(card.tagline),
    status: card.completionStatus, chapters: card.chapterCount, words: card.wordCount,
    updatedAt: isoMoment(card.lastUpdatedAt),
    decision: decision ? decisionHref(context.locale, context.ref, decision) : null,
    ...zoneWorkCards(card) };
}

/** A Work's credited author as Main's module reads name them: a REZICS Agent, or a source such as Open Library. */
export interface ModuleCredit {
  agent: string | null; handle: string | null; displayName: string | null; provider: string | null; key: string | null;
}

/**
 * The people behind a feed's Works, as a people module shows them: each named
 * author once, in the order their Works arrived here, with those Works as the
 * note. Identified authors link to their REZICS page.
 */
export function zonePeople(works: readonly { title: MainName; primaryCredits?: readonly ModuleCredit[] }[],
  limit: number): ZonePerson[] {
  const found = new Map<string, { person: Omit<ZonePerson, 'note'>; titles: MainName[] }>();
  for (const work of works) {
    for (const credit of work.primaryCredits ?? []) {
      if (!credit.displayName) continue;
      const id = credit.agent ?? `${credit.provider}:${credit.key ?? credit.displayName}`;
      const entry = found.get(id);
      if (entry) { if (!entry.titles.some(title => title.value === work.title.value)) entry.titles.push(work.title); continue; }
      if (found.size >= limit) continue;
      found.set(id, { titles: [work.title], person: { id, name: zoneContentText(credit.displayName),
        href: credit.handle ? profileHref(credit.handle)
          : credit.provider === 'open-library' && credit.key
            ? authorHref({ kind: 'external', key: credit.key })
            : `/search?${new URLSearchParams({ q: credit.displayName })}`,
        avatar: null } });
    }
  }
  return [...found.values()].map(({ person, titles }) => {
    const lang = titles.every(title => title.language === titles[0]!.language) ? titles[0]!.language : '';
    const note = titles.map(title => title.value).join(' · ');
    return { ...person, note: zoneContentText(note, lang) };
  });
}

/** A Decision in the Zone's words, titled from the Works this page already read. */
export function zoneDecision(decision: RealmDecision, context: AdaptContext,
  works: ReadonlyMap<string, ZoneWork>): ZoneDecision {
  const work = decision.work ? works.get(decision.work) ?? null : null;
  return { id: decision.id, kind: decision.kind, outcome: decision.outcome, sequence: decision.sequence,
    work: work ? { id: work.id, href: work.href, title: work.title } : null,
    href: decisionHref(context.locale, context.ref, decision.id) };
}

const mainReasons: Record<Extract<ZonePresentationRead['execution'], { state: 'fallback' }>['reason'], FallbackReason> = {
  safe_mode: 'safe-mode', viewer_opt_out: 'viewer-opt-out', none_approved: 'none-approved',
  globally_disabled: 'global-disabled', revoked: 'revoked', expired: 'expired' };

/**
 * Main's execution report gates the installed package by its reviewed source digest.
 */
export function mainExecution(read: ZonePresentationRead): MainExecution {
  if (read.execution.state === 'package') return { approved: { digest: read.execution.packageDigest },
    reason: 'none-approved' };
  return { approved: null, reason: read.execution.state === 'fallback'
    ? mainReasons[read.execution.reason] : 'none-approved' };
}

/** Banners whose schedule includes `now`. */
export function liveBanners(banners: readonly PresentationBanner[], now: number): PresentationBanner[] {
  return banners.filter(banner => (!banner.startsAt || Date.parse(banner.startsAt) <= now)
    && (!banner.endsAt || now < Date.parse(banner.endsAt)));
}
