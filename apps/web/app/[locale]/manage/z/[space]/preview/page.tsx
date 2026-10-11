import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { ZoneContext } from '@rezics/zone-sdk';
import { addressKey } from '../../../../../../features/address/path.ts';
import { manager } from '../../../../../../features/manage/server.ts';
import { RealmFrame, loadRealmView } from '../../../../../../features/realm/realm-page.tsx';
import { readPresentation, resolveSite } from '../../../../../../features/realm/read.ts';
import { siteHref } from '../../../../../../features/realm/route.ts';
import type { RealmMessages } from '../../../../../../features/realm/messages.ts';
import { loadZoneNavigation } from '../../../../../../features/zone-editor/api.ts';
import { messages } from '../../../../../../features/zone-editor/messages.ts';
import { ZoneDraftPreview } from '../../../../../../features/zone-editor/preview.tsx';
import { ZoneHomeContent } from '../../../../../../features/zone-editor/home-content.tsx';
import { loadZoneAuthoring } from '../../../../../../features/zone-editor/read.ts';
import { zonePreviewPath } from '../../../../../../features/zone-editor/routes.ts';
import { ZoneAuthoringFailure } from '../../../../../../features/zone-editor/states.tsx';
import { StandaloneZoneSiteFrame } from '../../../../../../features/zones/site-route.tsx';
import { zoneContentText } from '../../../../../../features/language/untagged.ts';
import { PageContainer } from '../../../../../../features/shell/page.tsx';
import { getMessages, requestLocale } from '../../../../../../i18n/server.ts';

export async function generateMetadata(): Promise<Metadata> {
  return { title: messages[await requestLocale()].previewTitle };
}

/** The saved draft. People who cannot edit are refused; this route never falls back to the public page. */
export default async function ZoneDraftPreviewPage({ params }: { params: Promise<{ space: string }> }) {
  const { space } = await params;
  const locale = await requestLocale();
  const { actingSubject, main } = await manager(locale, zonePreviewPath(space));
  const loaded = await loadZoneAuthoring(main, space, locale, actingSubject);
  if (loaded.kind === 'missing') notFound();
  if (loaded.kind === 'failure') return <ZoneAuthoringFailure failure={loaded.failure} copy={messages[locale]} />;
  const { model, preview, editorPath, sitePath } = loaded;
  const [resolved, navigation] = await Promise.all([
    resolveSite(space, locale),
    loadZoneNavigation(main, model.zoneId, actingSubject),
  ]);
  if (!navigation.ok) return <ZoneAuthoringFailure failure={navigation.failure} copy={messages[locale]} />;
  const siteTokens = preview.presentation.tokens;
  const siteNavigation = preview.presentation.navigation;
  if (resolved.kind === 'missing') notFound();
  if (resolved.kind === 'unavailable') return <ZoneAuthoringFailure failure="unavailable" copy={messages[locale]} />;
  if (resolved.kind === 'join') return <ZoneAuthoringFailure failure="denied" copy={messages[locale]} />;
  const siteMounts = navigation.data.links.filter(mount => mount.disclosure === 'public')
    .map(mount => ({ segment: mount.segment, name: zoneContentText(mount.name, locale) }));
  const published = model.state.publishedRevisionId;
  const status = !published ? 'private' : model.state.basis?.revisionId === published ? 'live' : 'behind';
  const ref = addressKey(resolved.address.canonical);
  const mounts = new Map(navigation.data.links.map(mount => [mount.target, mount.segment]));
  if (resolved.realm) {
    const view = await loadRealmView(space, locale, {}, 'site');
    if (view.kind === 'unavailable') return <ZoneAuthoringFailure failure="unavailable" copy={messages[locale]} />;
    if (view.kind !== 'view') return <ZoneAuthoringFailure failure="unavailable" copy={messages[locale]} />;
    const zone = { ...view.zone, tokens: siteTokens };
    return <RealmFrame view={view} tab={null} locale={locale} search={{}} address={sitePath}
      structuralPreview siteMounts={siteMounts} siteTokens={siteTokens} siteNavigation={siteNavigation}>
      <PageContainer>
        <ZoneDraftPreview copy={messages[locale]} document={model.document} editorPath={editorPath}
          sitePath={sitePath} status={status} pageSurface={siteTokens.pageSurface}>
          {preview.page ? <ZoneHomeContent page={preview.page} presentation={preview.presentation}
            slideMedia={preview.slideMedia} context={{ ...view.context, mounts }} zone={zone}
            pkg={view.pkg} messages={view.zoneMessages} preview /> : null}
        </ZoneDraftPreview>
      </PageContainer>
    </RealmFrame>;
  }

  const presentation = await readPresentation(resolved.zone);
  if (!presentation.ok) return <ZoneAuthoringFailure failure="unavailable" copy={messages[locale]} />;
  const zone: ZoneContext = {
    slug: presentation.data.official,
    realm: null,
    name: zoneContentText(model.name, locale),
    description: null,
    icon: null,
    hero: null,
    tokens: siteTokens,
    locale,
    links: { home: siteHref(locale, ref, []), browse: siteHref(locale, ref, ['browse']),
      works: siteHref(locale, ref, ['browse']), discussions: '', decisions: '', about: '' },
  };
  const [realmMessages, zoneMessages] = await Promise.all([getMessages('realm', locale), getMessages('zones', locale)]);
  return <StandaloneZoneSiteFrame zone={zone} zoneId={resolved.zone} address={ref} locale={locale}
    messages={realmMessages as RealmMessages} presentation={presentation.data} siteMounts={siteMounts} siteTokens={siteTokens}
    siteNavigation={siteNavigation}>
    <PageContainer>
      <ZoneDraftPreview copy={messages[locale]} document={model.document} editorPath={editorPath}
        sitePath={sitePath} status={status} pageSurface={siteTokens.pageSurface}>
        {preview.page ? <ZoneHomeContent page={preview.page} presentation={preview.presentation}
          slideMedia={preview.slideMedia} context={{ locale, ref, realm: resolved.zone, zone: resolved.zone, mounts }}
          zone={zone} pkg={null} messages={zoneMessages} preview /> : null}
      </ZoneDraftPreview>
    </PageContainer>
  </StandaloneZoneSiteFrame>;
}
