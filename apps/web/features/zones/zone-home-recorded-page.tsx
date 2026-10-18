import { ResolvedMediaImages } from '@rezics/ui/media-image';
import type { ZoneContext, ZonePackage } from '@rezics/zone-sdk';
import type { ReactNode } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { surfaceText } from '../address/messages.ts';
import { addressKey, spaceHref } from '../address/path.ts';
import { browserMainApi } from '../api/browser.ts';
import { readShowcaseWorks } from '../api/showcase.ts';
import { zoneContentText } from '../language/untagged.ts';
import { zoneImage, zoneText, type AdaptContext } from '../realm/adapt.ts';
import { realmHref, siteHref } from '../realm/route.ts';
import type { MainClient } from '../discover/types.ts';
import type { ZonePresentationRead, ZoneRouteRead } from '../realm/types.ts';
import { publishedFrameModel, realmFrameReads, type RealmFrameRead, type RealmResolution, type SiteResolution } from '../realm/zone-presentation-read.ts';
import { parseTheme } from '../shell/preferences.ts';
import type { ZoneHomePage } from '../zone-editor/home-document.tsx';
import { loadDocumentHomeModules, localizedHomePresentation, type HomeSourceSelection } from '../zone-editor/home-modules.ts';
import { zoneLookEnabled } from './execution.ts';
import { enrichShowcaseModules, loadModules, moduleMoreHref, readHeroImages, showcaseContext } from '../realm/modules.ts';
import { zoneWork } from '../realm/adapt.ts';
import type { SiteLink } from './site-navigation.tsx';
import { savedSiteCuts } from './site-cuts.ts';
import { ZoneDocumentHome } from './site-pages.tsx';
import type { ZoneMessages } from './messages.ts';
import { zoneTheme, type ZoneTheme } from './theme.ts';
import { ZoneHome } from './zone-home.tsx';
import { mapZoneSiteHome, type ZoneSiteCredit } from './zone-site-recorded-page.ts';

const recordedOrigin = 'https://recorded.invalid';
type Site = Extract<SiteResolution, { kind: 'site' }>;
type Realm = Extract<RealmResolution, { kind: 'realm' }>;

/** Anonymous host client. A replaying fetcher strips the browser prefix this client adds. */
export function recordedZoneHomeClient(fetcher: typeof fetch) {
  return browserMainApi(recordedOrigin, { anonymous: true, fetcher });
}

export type ZoneHomeFrameLoad =
  | { kind: 'attached'; site: Site; realm: Realm; presentation: ZonePresentationRead }
  | { kind: 'standalone'; site: Site; presentation: ZonePresentationRead }
  | { kind: 'missing'; site: Site; realm: Realm; presentation: ZonePresentationRead; route: RealmFrameRead<ZoneRouteRead> }
  | { kind: 'missing-standalone'; site: Site; route: RealmFrameRead<ZoneRouteRead> };

function failed(kind: string, failure?: string): never {
  throw new Error(`Recorded zone home read failed: ${failure ?? kind}`);
}

/**
 * The visitor home, in the order `ZoneSiteRoute` reads it. A named Realm is the
 * attached frame; a null Realm is the standalone home. A missing path re-reads
 * the frame the not-found page shows.
 */
export async function loadZoneHomeFrame(main: MainClient, space: string, locale: UiLocale, routePath?: string): Promise<ZoneHomeFrameLoad> {
  const reads = realmFrameReads({ main, personal: main, keepProblem: false });
  const resolved = await reads.resolveSite(space, locale);
  if (resolved.kind !== 'site') failed(resolved.kind, resolved.kind === 'unavailable' ? resolved.failure : undefined);
  if (routePath) {
    const route = await reads.readZoneRoute(resolved.zone, routePath);
    if (route.ok || route.failure !== 'missing') {
      throw new Error(route.ok ? 'Recorded zone route resolved as a page' : `Recorded zone route failed: ${route.failure}`);
    }
    if (!resolved.realm) return { kind: 'missing-standalone', site: resolved, route };
    const again = await reads.resolveSite(space, locale);
    if (again.kind !== 'site' || !again.realm) throw new Error('Recorded missing page lost its Realm');
    const realm = await reads.resolveRealm(space, locale, 'site');
    if (realm.kind !== 'realm') failed(realm.kind, realm.kind === 'unavailable' ? realm.failure : undefined);
    const publication = await reads.readCompletePresentation(realm.zone?.id ?? again.zone);
    if (!publication.ok) failed(publication.failure, publication.reference);
    return { kind: 'missing', site: again, realm, presentation: publication.data, route };
  }
  if (!resolved.realm) {
    const publication = await reads.readCompletePresentation(resolved.zone);
    if (!publication.ok) failed(publication.failure, publication.reference);
    return { kind: 'standalone', site: resolved, presentation: publication.data };
  }
  const realm = await reads.resolveRealm(space, locale, 'site');
  if (realm.kind !== 'realm') failed(realm.kind, realm.kind === 'unavailable' ? realm.failure : undefined);
  const publication = await reads.readCompletePresentation(realm.zone?.id ?? resolved.zone);
  if (!publication.ok) failed(publication.failure, publication.reference);
  return { kind: 'attached', site: resolved, realm, presentation: publication.data };
}

interface ZoneHomeFrame {
  kind: 'attached' | 'standalone' | 'missing';
  zone: ZoneContext;
  dataZone: string;
  theme: ZoneTheme;
  links: SiteLink[];
  siteLabel: string;
  context: AdaptContext;
  presentation: ZonePresentationRead;
  page: ZoneHomePage | null;
  credit: ZoneSiteCredit | null;
  realmId: string | null;
  realmRef: string | null;
  backHref: string | null;
}

export type ZoneHomeShown = ZoneHomeFrame | { kind: 'missing-standalone'; backHref: string };

function visitorTheme(tokens: ZoneContext['tokens']): ZoneTheme {
  return zoneTheme(tokens, { reader: parseTheme(undefined), enabled: zoneLookEnabled(undefined) });
}

function homeOf(presentation: ZonePresentationRead, attached: boolean): { page: ZoneHomePage | null; credit: ZoneSiteCredit | null } {
  const mapped = mapZoneSiteHome(presentation);
  if (attached && mapped.kind !== 'published') throw new Error('Recorded attached Zone home has no published document');
  return mapped.kind === 'published' ? { page: mapped.page, credit: mapped.credit } : { page: null, credit: null };
}

function attachedFrame(realm: Realm, presentation: ZonePresentationRead, locale: UiLocale, homeName: string, requireDocument: boolean): ZoneHomeFrame {
  const siteRef = realm.siteRef ?? (realm.zone ? realm.ref : null);
  const ref = siteRef ?? realm.ref;
  const { page, credit } = homeOf(presentation, requireDocument);
  const zone: ZoneContext = {
    slug: presentation.official,
    realm: realm.header.id,
    name: zoneText(realm.header.name),
    description: zoneText(realm.header.description),
    icon: zoneImage(realm.header.icon, ''),
    hero: zoneImage(realm.header.banner, ''),
    tokens: presentation.presentation.tokens,
    locale,
    links: {
      home: siteRef ? siteHref(locale, siteRef, []) : '',
      browse: siteRef ? siteHref(locale, siteRef, ['browse']) : '',
      works: siteRef ? siteHref(locale, siteRef, ['browse']) : '',
      discussions: realmHref(locale, realm.ref, 'discussions'),
      decisions: realmHref(locale, realm.ref, 'decisions'),
      about: realmHref(locale, realm.ref, 'about'),
    },
  };
  const cuts = savedSiteCuts(
    { tokens: zone.tokens, navigation: presentation.presentation.navigation },
    presentation.navigation.map(mount => ({ segment: mount.segment, name: zoneText(mount.name) })),
    ref, locale, homeName);
  return {
    kind: 'attached',
    zone,
    dataZone: zone.slug ?? realm.realm,
    theme: visitorTheme(cuts.tokens),
    links: cuts.navigation,
    siteLabel: surfaceText.site[locale],
    context: {
      locale,
      ref,
      realm: realm.realm,
      avatarQuery: '',
      ...(realm.zone
        ? { zone: realm.zone.id, mounts: new Map(presentation.navigation.map(mount => [mount.target, mount.segment])) }
        : { unrouted: true }),
    },
    presentation,
    page,
    credit,
    realmId: realm.header.id,
    realmRef: realm.ref,
    backHref: null,
  };
}

function standaloneFrame(site: Site, presentation: ZonePresentationRead, locale: UiLocale, homeName: string): ZoneHomeFrame {
  const ref = addressKey(site.address.canonical);
  const { page, credit } = homeOf(presentation, false);
  const zone: ZoneContext = {
    slug: presentation.official,
    realm: null,
    name: zoneContentText(presentation.name ?? site.address.canonical.suffixSource, presentation.language),
    description: null,
    icon: null,
    hero: null,
    tokens: presentation.presentation.tokens,
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
  const model = publishedFrameModel(presentation, site.zone, locale, homeName, '', {
    reader: parseTheme(undefined), ref, zone,
  });
  return {
    kind: 'standalone',
    zone: model.zone,
    dataZone: site.zone,
    theme: model.theme,
    links: model.cuts.navigation,
    siteLabel: model.zone.name.value,
    context: {
      locale,
      ref,
      realm: site.zone,
      zone: site.zone,
      mounts: new Map(presentation.navigation.map(mount => [mount.target, mount.segment])),
    },
    presentation,
    page,
    credit,
    realmId: null,
    realmRef: null,
    backHref: null,
  };
}

/** The frame `RealmFrame` or `StandaloneZoneSiteFrame` builds for a visitor with no theme cookie. */
export function zoneHomeFrameModel(loaded: ZoneHomeFrameLoad, locale: UiLocale, homeName: string): ZoneHomeShown {
  if (loaded.kind === 'missing-standalone') return { kind: 'missing-standalone', backHref: spaceHref(loaded.site.address.canonical, 'site') };
  const frame = loaded.kind === 'standalone'
    ? standaloneFrame(loaded.site, loaded.presentation, locale, homeName)
    : attachedFrame(loaded.realm, loaded.presentation, locale, homeName, loaded.kind === 'attached');
  if (loaded.kind === 'attached') return frame;
  return { ...frame, kind: loaded.kind, backHref: loaded.kind === 'missing' ? spaceHref(loaded.site.address.canonical, 'site') : null };
}

/** Public and saved homes assemble modules through the same production readers. */
export function loadZoneHomeModules(page: ZoneHomePage | null, presentation: Parameters<typeof localizedHomePresentation>[0],
  selection: HomeSourceSelection, context: AdaptContext, defaultTitle: string) {
  return loadDocumentHomeModules(page, selection, localizedHomePresentation(presentation, context.locale), context, {
    publicModules: loadModules, summaries: readShowcaseWorks, work: zoneWork, context: showcaseContext,
    more: moduleMoreHref, enrich: enrichShowcaseModules, images: readHeroImages,
  }, defaultTitle);
}

/** The published home: its modules, then the document, with each resolved showcase shown once. */
export function ZonePublishedHome({ page, modules, images, representedShowcases, zone, pkg, locale, messages,
  avatarQuery, empty }: {
  page: ZoneHomePage | null;
  modules: Awaited<ReturnType<typeof loadZoneHomeModules>>['modules'];
  images: Awaited<ReturnType<typeof loadZoneHomeModules>>['images'];
  representedShowcases: Awaited<ReturnType<typeof loadZoneHomeModules>>['representedShowcases'];
  zone: ZoneContext; pkg: ZonePackage | null; locale: UiLocale; messages: ZoneMessages;
  avatarQuery?: string; empty?: ReactNode;
}) {
  return <ResolvedMediaImages images={images}>
    {page ? <ZoneDocumentHome page={page} modules={modules} zone={zone} pkg={pkg} locale={locale}
      messages={messages} avatarQuery={avatarQuery} representedShowcases={representedShowcases} />
      : <ZoneHome modules={modules} zone={zone} pkg={pkg} locale={locale}
        messages={messages} avatarQuery={avatarQuery} empty={empty ?? null} />}
  </ResolvedMediaImages>;
}
