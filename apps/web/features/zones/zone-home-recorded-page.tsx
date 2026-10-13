import { ResolvedMediaImages } from '@rezics/ui/media-image';
import type { ZoneContext, ZonePackage } from '@rezics/zone-sdk';
import type { ReactNode } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { browserMainApi } from '../api/browser.ts';
import { readShowcaseWorks } from '../api/showcase.ts';
import { zoneContentText } from '../language/untagged.ts';
import { zoneText, type AdaptContext } from '../realm/adapt.ts';
import { settleRealmRead } from '../realm/browse-page-read.ts';
import { enrichShowcaseModules, loadModules, moduleMoreHref, readHeroImages, showcaseContext,
  summaryWork } from '../realm/modules.ts';
import { completePublicNavigation } from '../realm/public-navigation.ts';
import { idOf, realmHref, siteHref } from '../realm/route.ts';
import type { Loaded, ZonePresentationRead, ZoneRouteRead } from '../realm/types.ts';
import { savedSiteCuts } from './site-cuts.ts';
import type { SiteLink } from './site-navigation.tsx';
import { ZoneDocumentHome } from './site-pages.tsx';
import type { ZoneMessages } from './messages.ts';
import { ZoneHome } from './zone-home.tsx';
import { zoneHomeDocument, type ZoneHomePage } from '../zone-editor/home-document.tsx';
import { loadDocumentHomeModules, localizedHomePresentation, type HomeSourceSelection } from '../zone-editor/home-modules.ts';

/** Public recorded reader. No eligible Agent, so the client stays anonymous and sends no acting Subject. */
const recordedOrigin = 'https://recorded.invalid';

/** Visitor reads omit an empty query: the recorded path has none, and an empty query object does not match it. */
export function readZonePresentationAnswer(fetcher: typeof fetch, zone: string, actingSubject?: string, after?: string): Promise<Loaded<ZonePresentationRead>> {
  const main = browserMainApi(recordedOrigin, { anonymous: true, fetcher });
  return settleRealmRead(() => {
    if (!actingSubject && !after) return main.v1.zones({ id: zone }).presentation.get();
    return main.v1.zones({ id: zone }).presentation.get({
      query: { ...(actingSubject ? { actingSubject } : {}), ...(after ? { after } : {}) },
    });
  }, after);
}

/** The same continuation walk the public frame uses, over the typed presentation read. */
export function readCompleteZonePresentation(fetcher: typeof fetch, zone: string, actingSubject?: string): Promise<Loaded<ZonePresentationRead>> {
  return completePublicNavigation(after => readZonePresentationAnswer(fetcher, zone, actingSubject, after));
}

/** A path under the Zone, with the same failure mapping as the public route read. */
export function readZoneRouteAnswer(fetcher: typeof fetch, zone: string, path: string, actingSubject?: string, cursor?: string): Promise<Loaded<ZoneRouteRead>> {
  const main = browserMainApi(recordedOrigin, { anonymous: true, fetcher });
  return settleRealmRead(() => main.v1.zones({ id: zone }).routes.get({
    query: { path, ...(actingSubject ? { actingSubject } : {}), ...(cursor ? { cursor } : {}) },
  }), cursor);
}

/** The published document's content revision. A visitor read has no acting subject. */
export function readContentRevisionAnswer(fetcher: typeof fetch, revision: string, actingSubject?: string) {
  const main = browserMainApi(recordedOrigin, { anonymous: true, fetcher });
  return settleRealmRead(() => actingSubject
    ? main.v1['content-revisions']({ revision }).get({ query: { actingSubject } })
    : main.v1['content-revisions']({ revision }).get());
}

/** The home document the publication carried, or none when that read has no document. */
export function zoneHomePage(home: ZonePresentationRead['home'] | null | undefined): ZoneHomePage | null {
  if (!home || !zoneHomeDocument(home)) return null;
  return home;
}

/**
 * Navigation, address and the published Zone name. A Realm-backed masthead
 * still takes its community name from the Realm header, which this read does not include.
 */
export function zoneHomeIdentity(presentation: ZonePresentationRead, locale: UiLocale, homeName: string): {
  zone: ZoneContext; links: SiteLink[]; context: AdaptContext;
} {
  const ref = presentation.address.key;
  const zoneId = idOf(presentation.zone) ?? presentation.zone;
  const mounts = new Map(presentation.navigation.map(mount => [mount.target, mount.segment]));
  const realm = presentation.realm;
  const cuts = savedSiteCuts(
    { tokens: presentation.presentation.tokens, navigation: presentation.presentation.navigation },
    presentation.navigation.map(mount => ({ segment: mount.segment, name: zoneText(mount.name) })),
    ref, locale, homeName);
  return {
    zone: {
      slug: presentation.official,
      realm,
      name: zoneContentText(presentation.name ?? presentation.address.suffixSource, presentation.language),
      description: null,
      icon: null,
      hero: null,
      tokens: cuts.tokens,
      locale,
      links: {
        home: siteHref(locale, ref, []),
        browse: siteHref(locale, ref, ['browse']),
        works: siteHref(locale, ref, ['browse']),
        discussions: realm ? realmHref(locale, ref, 'discussions') : '',
        decisions: realm ? realmHref(locale, ref, 'decisions') : '',
        about: realm ? realmHref(locale, ref, 'about') : '',
      },
    },
    links: cuts.navigation,
    context: { locale, ref, realm: realm ?? presentation.zone, zone: zoneId, mounts },
  };
}

/** Public and saved homes assemble modules through the same production readers. */
export function loadZoneHomeModules(page: ZoneHomePage | null, presentation: Parameters<typeof localizedHomePresentation>[0],
  selection: HomeSourceSelection, context: AdaptContext, defaultTitle: string) {
  return loadDocumentHomeModules(page, selection, localizedHomePresentation(presentation, context.locale), context, {
    publicModules: loadModules, summaries: readShowcaseWorks, work: summaryWork, context: showcaseContext,
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
