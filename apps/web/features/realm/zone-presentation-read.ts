import type { CanonicalAddress } from '@rezics/model/address';
import type { ZoneContext, ZoneMember, ZoneModule, ZoneTokens } from '@rezics/zone-sdk';
import type { UiLocale } from '../../i18n/define.ts';
import type { AddressRead, ResolvedAddress } from '../address/client.ts';
import { addressKey, type AddressScope } from '../address/path.ts';
import { resolvedAddress } from '../address/resolved-address.ts';
import type { SpacePage } from '../address/space-read.ts';
import type { MainClient } from '../discover/types.ts';
import { isOfflineError } from '../feed/types.ts';
import { zoneContentText } from '../language/untagged.ts';
import type { JoinPage } from '../manage/settings-api.ts';
import { presentationSlide, liveSlides, zoneText } from './adapt.ts';
import { settleRealmRead as settle } from './browse-page-read.ts';
import { completePublicNavigation } from './public-navigation.ts';
import { idOf, siteHref } from './route.ts';
import type { FacetList, Loaded, ReadFailure, RealmHeader, RealmZoneRead, ZonePresentationRead, ZoneRouteRead } from './types.ts';
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

export type RealmResolution =
  | {
      kind: 'realm';
      ref: string;
      realm: string;
      header: RealmHeader;
      zone: { id: string; segment: string | null } | null;
      /** The attached Zone may occupy a different Space from this Realm. */
      siteRef?: string;
    }
  | { kind: 'missing' }
  | { kind: 'join'; page: JoinPage }
  | { kind: 'unavailable'; failure?: ReadFailure; reference?: string };

export type SiteResolution =
  | { kind: 'site'; address: ResolvedAddress; zone: string; realm: string | null }
  | { kind: 'join'; page: JoinPage }
  | { kind: 'missing' }
  | { kind: 'unavailable'; failure?: ReadFailure; reference?: string };

/**
 * The shared frame reader. Public reads use main; member-readable presentation,
 * and routes use personal with the eligible acting subject.
 * Host address admission and private landing adapters retain their request caches,
 * language headers and conditional requests at the production boundary.
 */
export function realmFrameReads({ main, personal = main, actingSubject, resolution, keepProblem = true }: {
  main: MainClient;
  personal?: MainClient;
  actingSubject?: string;
  /** Production keeps its existing Loaded contract; recorded frames retain the HTTP problem. */
  keepProblem?: boolean;
  resolution?: {
    resolveAddress?: (scope: AddressScope, key: string, locale: UiLocale, fresh?: boolean) => Promise<AddressRead>;
    readPrivateRealm?: (ref: string, locale: UiLocale, address?: ResolvedAddress) => Promise<SpacePage>;
    readRealmHeader?: (realm: string, locale: UiLocale) => Promise<RealmFrameRead<RealmHeader>>;
    readCompletePresentation?: (
      zone: string,
      readPage?: (zone: string, after?: string) => Promise<RealmFrameRead<ZonePresentationRead>>,
    ) => Promise<RealmFrameRead<ZonePresentationRead>>;
  };
}) {
  const presentation = zonePresentationReads(personal, actingSubject, keepProblem);
  const readRealmHeader = (realm: string): Promise<RealmFrameRead<RealmHeader>> =>
    settleFrame(() => main.v1.realms({ realm }).get({ query: {} }), undefined, keepProblem);
  const readHeader = resolution?.readRealmHeader ?? ((realm: string, _locale: UiLocale) => readRealmHeader(realm));
  const readPublication = resolution?.readCompletePresentation
    ?? presentation.readCompletePresentation;
  const resolve = resolution?.resolveAddress ?? (async (_scope: 'space', key: string, _locale: UiLocale, _fresh = false): Promise<AddressRead> => {
    try {
      const answer = await main.v1.addresses.resolve.get({ query: { scope: 'space', key } });
      if (answer.error) {
        if (!answer.response && answer.error.value instanceof Error) throw answer.error.value;
        const status = Number(answer.error.status);
        if ([400, 404, 422].includes(status)) return { kind: 'missing' };
        if (status === 410) return { kind: 'retired' };
        if (status === 429) {
          const seconds = Number(answer.response.headers.get('retry-after'));
          return { kind: 'unavailable', status: 429,
            retryAfter: String(Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : 60) };
        }
        return { kind: 'unavailable' };
      }
      const data = resolvedAddress(answer.data);
      return data?.scope === 'space' ? { kind: 'resolved', data } : { kind: 'unavailable' };
    } catch (error) {
      if (recordedReplayGap(error)) throw error;
      return isOfflineError(error) ? { kind: 'unavailable', failure: 'offline' } : { kind: 'unavailable' };
    }
  });
  // Private landing belongs to the existing address reader. Replay must supply
  // its supporting read explicitly rather than enter the host's session boundary.
  const privateRealm = resolution?.readPrivateRealm ?? (async (ref: string) => {
    throw new Error(`Missing supporting Realm frame private-resolution reader: ${ref}`);
  });
  return {
    readRealmHeader,
    readRealmZone: (realm: string): Promise<RealmFrameRead<RealmZoneRead>> =>
      settleFrame(() => personal.v1.realms({ realm }).zone.get({ query: { actingSubject } }), undefined, keepProblem),
    readFacets: (): Promise<RealmFrameRead<FacetList>> => settleFrame(() => main.v1.facets.get(), undefined, keepProblem),
    readAddress: (ref: string, locale: UiLocale, fresh = false) => resolve('space', ref, locale, fresh),
    ...presentation,
    readZoneRoute: (zone: string, path: string, cursor?: string): Promise<RealmFrameRead<ZoneRouteRead>> =>
      settleFrame(() => personal.v1.zones({ id: zone }).routes.get({ query: { actingSubject, path, cursor } }), cursor),
    resolveRealm: async (ref: string, locale: UiLocale, surface: 'community' | 'site' = 'community'): Promise<RealmResolution> => {
      const resolved = await resolve('space', ref, locale);
      if (resolved.kind !== 'resolved') {
        if (resolved.kind !== 'missing')
          return resolved.kind === 'unavailable'
            ? { kind: 'unavailable', ...(resolved.failure ? { failure: resolved.failure } : {}) }
            : { kind: 'missing' };
        const fallback = await privateRealm(ref, locale);
        if (fallback.kind !== 'realm') return fallback;
        // Keep an admitted legacy identity when no public landing address exists;
        // never guess a Zone or Space name from a private header.
        return {
          kind: 'realm',
          ref,
          realm: idOf(fallback.header.id)!,
          header: fallback.header,
          zone: null,
        };
      }
      const zoneId = idOf(resolved.data.capabilities?.zone ?? '');
      let realm = idOf(resolved.data.capabilities?.realm ?? '');
      const attached = zoneId && (surface === 'site' || !realm);
      if (attached) {
        const publication = await readPublication(zoneId);
        if (!publication.ok) return publication.failure === 'missing' ? { kind: 'missing' }
          : { kind: 'unavailable', failure: publication.failure, ...(publication.reference ? { reference: publication.reference } : {}) };
        realm = idOf(publication.data.realm ?? '');
      }
      if (!realm) return { kind: 'missing' };
      const header = await readHeader(realm, locale);
      const page = header.ok
        ? { kind: 'realm' as const, header: header.data }
        : header.failure === 'missing'
          ? await privateRealm(attached ? realm : ref, locale, attached ? undefined : resolved.data)
          : { kind: 'unavailable' as const, failure: header.failure, ...(header.reference ? { reference: header.reference } : {}) };
      if (page.kind !== 'realm') return page;
      return {
        kind: 'realm',
        ref: attached ? idOf(page.header.space)! : addressKey(resolved.data.canonical),
        ...(surface === 'site' ? { siteRef: addressKey(resolved.data.canonical) } : {}),
        realm,
        header: page.header,
        zone: zoneId ? { id: zoneId, segment: null } : null,
      };
    },
    resolveSite: async (ref: string, locale: UiLocale, fresh = false): Promise<SiteResolution> => {
      const resolved = await resolve('space', ref, locale, fresh);
      if (resolved.kind !== 'resolved') {
        if (resolved.kind !== 'missing')
          return resolved.kind === 'unavailable'
            ? { kind: 'unavailable', ...(resolved.failure ? { failure: resolved.failure } : {}) }
            : { kind: 'missing' };
        const fallback = await privateRealm(ref, locale);
        return fallback.kind === 'realm' ? { kind: 'missing' } : fallback;
      }
      const zone = idOf(resolved.data.capabilities?.zone ?? '');
      if (!zone) {
        const fallback = await privateRealm(ref, locale, resolved.data);
        return fallback.kind === 'realm' ? { kind: 'missing' } : fallback;
      }
      const publication = await readPublication(zone);
      if (!publication.ok) return publication.failure === 'missing' ? { kind: 'missing' }
        : { kind: 'unavailable', failure: publication.failure, ...(publication.reference ? { reference: publication.reference } : {}) };
      return { kind: 'site', address: resolved.data, zone,
        realm: idOf(publication.data.realm ?? '') };
    },
  };
}
