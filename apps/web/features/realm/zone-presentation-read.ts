import type { CanonicalAddress } from '@rezics/model/address';
import type { ZoneContext, ZoneMember, ZoneModule, ZoneTokens } from '@rezics/zone-sdk';
import type { UiLocale } from '../../i18n/define.ts';
import { addressKey } from '../address/path.ts';
import type { MainClient } from '../discover/types.ts';
import { zoneContentText } from '../language/untagged.ts';
import { presentationSlide, liveSlides, zoneText } from './adapt.ts';
import { settleRealmRead as settle } from './browse-page-read.ts';
import { completePublicNavigation } from './public-navigation.ts';
import { idOf, siteHref } from './route.ts';
import type { Loaded, ZonePresentationRead, ZoneRouteRead } from './types.ts';
import { savedSiteCuts, type SiteMountCut, type SitePresentationCut } from '../zones/site-cuts.ts';
import { zoneTheme, type ReaderTheme, type ZoneTheme } from '../zones/theme.ts';
import { placedModule } from '../zones/presentation.ts';
import type { PlacedModule } from '../zones/zone-home.tsx';

/** A frame keeps Main's complete HTTP problem beside its existing display category. */
export type RealmFrameRead<T> = Loaded<T> & { status?: number; problem?: unknown };

type FrameAnswer<T> = {
  data: T | null;
  error: { status: number; value?: unknown } | null;
  headers?: unknown;
  response?: { headers?: unknown };
};

// Replay omissions are evidence gaps, never a replacement unavailable frame.
export function recordedReplayGap(error: unknown): boolean {
  return error instanceof Error
    && /Unmatched recorded request|Recorded sample|Ambiguous recorded request|cannot supply/.test(error.message);
}

export async function settleFrame<T>(call: () => Promise<FrameAnswer<T>>, cursor?: string, keepProblem = true): Promise<RealmFrameRead<T>> {
  const recorded: { problem: FrameAnswer<T>['error']; gap?: unknown } = { problem: null };
  const result = await settle(async () => {
    try {
      recorded.problem = null;
      const answer = await call();
      recorded.problem = answer.error;
      if (recordedReplayGap(answer.error?.value)) recorded.gap = answer.error?.value;
      return answer;
    } catch (error) {
      if (recordedReplayGap(error)) recorded.gap = error;
      throw error;
    }
  }, cursor);
  if (recorded.gap) throw recorded.gap;
  const { problem } = recorded;
  return !result.ok && problem && keepProblem ? { ...result, status: problem.status,
    ...(problem.value !== undefined ? { problem: problem.value } : {}) } : result;
}

/** Client-supplied reads; the host retains session selection and request caches. */
export function zonePresentationReads(main: MainClient, actingSubject?: string, keepProblem = true) {
  const readPresentation = (zone: string, after?: string): Promise<RealmFrameRead<ZonePresentationRead>> =>
    settleFrame(() => main.v1.zones({ id: zone }).presentation.get({ query: { actingSubject, after } }), after, keepProblem);
  return {
    readPresentation,
    readCompletePresentation: (zone: string, readPage = readPresentation): Promise<RealmFrameRead<ZonePresentationRead>> =>
      completePublicNavigation(after => readPage(zone, after)),
    readZoneRoute: (zone: string, path: string, cursor?: string): Promise<RealmFrameRead<ZoneRouteRead>> =>
      settleFrame(() => main.v1.zones({ id: zone }).routes.get({ query: { actingSubject, path, cursor } }), cursor, keepProblem),
  };
}

export interface PublishedFrameModel {
  zoneId: string;
  ref: string;
  zone: ZoneContext;
  cuts: ReturnType<typeof savedSiteCuts>;
  theme: ZoneTheme;
  home: ZonePresentationRead['home'];
  hero: PlacedModule | null;
  mounts: readonly ZoneMember[];
  navigationNext: ZonePresentationRead['navigationNext'];
  navigationComplete: ZonePresentationRead['navigationComplete'];
}

/** The published frame: the same site cut the public site renders, plus the home document it was given. */
export function publishedFrameModel(answer: ZonePresentationRead, zoneId: string, locale: UiLocale,
  homeName: string, heroTitle: string, options: {
    reader?: ReaderTheme;
    ref?: string;
    zone?: ZoneContext;
    mounts?: readonly SiteMountCut[];
    tokens?: ZoneTokens;
    navigation?: SitePresentationCut['navigation'];
  } = {}): PublishedFrameModel {
  const ref = options.ref ?? addressKey(siteAddress(answer.address));
  const tokens = options.tokens ?? answer.presentation.tokens;
  const cuts = savedSiteCuts(
    { tokens, navigation: options.navigation ?? answer.presentation.navigation },
    options.mounts ?? answer.navigation.map(mount => ({ segment: mount.segment, name: zoneText(mount.name) })),
    ref, locale, homeName);
  const zone: ZoneContext = options.zone ? (options.tokens ? { ...options.zone, tokens } : options.zone) : {
    slug: answer.official,
    realm: null,
    name: zoneContentText(answer.name ?? siteAddress(answer.address).suffixSource, answer.language ?? ''),
    description: null,
    icon: null,
    hero: null,
    tokens,
    locale,
    links: {
      home: siteHref(locale, ref, []),
      browse: siteHref(locale, ref, ['browse']),
      works: siteHref(locale, ref, ['browse']),
      discussions: '',
      decisions: '',
      about: '',
    },
  };
  return {
    zoneId: idOf(answer.zone) ?? zoneId,
    ref,
    zone,
    cuts,
    theme: zoneTheme(cuts.tokens, { reader: options.reader ?? 'light', enabled: true }),
    home: answer.home,
    hero: highlightHero(answer, { locale, ref, realm: answer.zone }, heroTitle),
    mounts: answer.navigation.map(mount => ({
      id: mount.target,
      href: siteHref(locale, ref, [mount.segment]),
      name: zoneText(mount.name),
      kind: null,
    })),
    navigationNext: answer.navigationNext,
    navigationComplete: answer.navigationComplete,
  };
}

export async function loadPublishedFrame(main: MainClient, zoneId: string, locale: UiLocale, homeName: string,
  heroTitle: string): Promise<RealmFrameRead<PublishedFrameModel>> {
  const read = await zonePresentationReads(main).readCompletePresentation(zoneId);
  if (!read.ok) return read;
  return { ok: true, data: publishedFrameModel(read.data, zoneId, locale, homeName, heroTitle) };
}

function highlightHero(answer: ZonePresentationRead, context: { locale: UiLocale; ref: string; realm: string },
  heroTitle: string): PlacedModule | null {
  const slides = liveSlides(answer.presentation.slides, Date.now()).slice(0, 5).flatMap(slide => {
    const adapted = presentationSlide(slide, null, context, answer.slideMedia);
    return adapted ? [adapted] : [];
  });
  if (!slides.length) return null;
  // placedModule returns the wide module union; the literal type keeps the hero data paired with it.
  const module: ZoneModule<'hero-carousel'> = {
    ...placedModule({
      id: slides[0]!.id,
      type: 'hero-carousel',
      title: heroTitle,
      source: { kind: 'query-block', block: 'document-default' },
    }, null),
    type: 'hero-carousel',
  };
  return { module, state: { state: 'ready', data: { slides } } };
}

function siteAddress(address: ZonePresentationRead['address']): CanonicalAddress {
  if (!isRecord(address) || typeof address.key !== 'string' || typeof address.suffixSource !== 'string'
    || typeof address.prefix !== 'string') {
    throw new Error('Zone presentation has no site address');
  }
  return address as CanonicalAddress;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
