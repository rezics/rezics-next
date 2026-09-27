import type { ZoneDecision, ZoneImage, ZoneText, ZoneWork } from '@rezics/zone-sdk';
import type { UiLocale } from '../../i18n/define.ts';
import { BFF_PREFIX } from '../api/browser.ts';
import type { FallbackReason, MainExecution, PresentationBanner } from '../zones/presentation.ts';
import { decisionHref, idOf, realmWorkHref } from './route.ts';
import type { MainAvatar, MainName, RealmDecision, WorkCard, ZonePresentationRead } from './types.ts';

// Main's read shapes to the Zone SDK's public data. Every module and package
// sees only these, so Main detail (revisions, positions, basis flags) stays here.

export function zoneText(name: MainName): ZoneText;
export function zoneText(name: MainName | null): ZoneText | null;
export function zoneText(name: MainName | null): ZoneText | null {
  return name ? { value: name.value, lang: name.language, dir: name.direction } : null;
}

/** An image Main serves, as a path through the BFF; a generated fallback is no image. */
export function zoneImage(avatar: MainAvatar | null): ZoneImage | null {
  return avatar?.kind === 'image' ? { url: `${BFF_PREFIX}${avatar.url}`, width: avatar.width, height: avatar.height }
    : null;
}

/** A presentation banner's media resource, delivered through Main's public media use read. */
export function bannerImage(banner: PresentationBanner): ZoneImage | null {
  const id = idOf(banner.image);
  return id ? { url: `${BFF_PREFIX}/v1/media/uses/${id}`, width: 1200, height: 630 } : null;
}

const schema = 'https://schema.org/';

/** The object a generated cover imitates. */
export function workKind(types: readonly string[]): ZoneWork['kind'] {
  if (types.includes(`${schema}Recipe`)) return 'recipe';
  if (types.some(type => type === `${schema}SoftwareSourceCode` || type === `${schema}SoftwareApplication`)) {
    return 'package';
  }
  return types.includes(`${schema}Book`) ? 'book' : 'document';
}

export interface AdaptContext { locale: UiLocale; ref: string; realm: string }

/**
 * A Work card in this Zone. `decision` is the public Decision that placed
 * it here (the adoption's selection); Main's cards carry no author yet.
 */
export function zoneWork(card: WorkCard, context: AdaptContext, decision: string | null): ZoneWork {
  return { id: card.id, href: realmWorkHref(card.id, context.realm), title: zoneText(card.title),
    cover: zoneImage(card.cover), kind: workKind(card.types), author: null, tagline: zoneText(card.tagline),
    status: card.completionStatus, chapters: card.chapterCount, words: card.wordCount,
    updatedAt: card.lastUpdatedAt,
    decision: decision ? decisionHref(context.locale, context.ref, decision) : null };
}

/** A Decision in the Zone's words, titled from the Works this page already read. */
export function zoneDecision(decision: RealmDecision, context: AdaptContext,
  works: ReadonlyMap<string, ZoneWork>): ZoneDecision {
  const work = decision.work ? works.get(decision.work) ?? null : null;
  return { id: decision.id, kind: decision.kind, outcome: decision.outcome, sequence: decision.sequence,
    work: work ? { id: work.id, href: work.href, title: work.title } : null,
    href: decisionHref(context.locale, context.ref, decision.id) };
}

const mainReasons: Record<ZonePresentationRead['execution']['reason'], FallbackReason> = {
  safe_mode: 'safe-mode', viewer_opt_out: 'viewer-opt-out', none_approved: 'none-approved' };

/**
 * Main's execution report. Main does not approve Zone packages yet (the
 * theme lifecycle is G-290's next step), so its state is always `fallback`;
 * when approvals land, the approved digest comes from here.
 */
export function mainExecution(read: ZonePresentationRead): MainExecution {
  return { approved: null, reason: mainReasons[read.execution.reason] };
}

/** Banners whose schedule includes `now`. */
export function liveBanners(banners: readonly PresentationBanner[], now: number): PresentationBanner[] {
  return banners.filter(banner => (!banner.startsAt || Date.parse(banner.startsAt) <= now)
    && (!banner.endsAt || now < Date.parse(banner.endsAt)));
}
