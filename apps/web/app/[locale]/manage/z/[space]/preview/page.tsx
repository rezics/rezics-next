import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { ZoneContext } from '@rezics/zone-sdk';
import { addressKey } from '../../../../../../features/address/path.ts';
import { manager } from '../../../../../../features/manage/server.ts';
import { settle } from '../../../../../../features/manage/read.ts';
import { RealmFrame, loadRealmView } from '../../../../../../features/realm/realm-page.tsx';
import { readPresentation, resolveSite } from '../../../../../../features/realm/read.ts';
import { siteHref } from '../../../../../../features/realm/route.ts';
import type { RealmMessages } from '../../../../../../features/realm/messages.ts';
import { loadZoneNavigation } from '../../../../../../features/zone-editor/api.ts';
import { messages } from '../../../../../../features/zone-editor/messages.ts';
import { readPresentation as readThemePresentation } from '../../../../../../features/zone-editor/theme.ts';
import { ZoneDraftPreview } from '../../../../../../features/zone-editor/preview.tsx';
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
  const { model, editorPath, sitePath } = loaded;
  const [resolved, navigation, configuration] = await Promise.all([
    resolveSite(space, locale),
    loadZoneNavigation(main, model.zoneId, actingSubject),
    settle(() => main.v1.zones({ id: model.zoneId }).configuration.get({ query: { actingSubject } }),
      { management: true }),
  ]);
  if (!navigation.ok) return <ZoneAuthoringFailure failure={navigation.failure} copy={messages[locale]} />;
  if (!configuration.ok) return <ZoneAuthoringFailure failure={configuration.failure} copy={messages[locale]} />;
  const savedPresentation = readThemePresentation(configuration.data.configuration);
  if (savedPresentation.kind !== 'ready') return <ZoneAuthoringFailure failure="unavailable" copy={messages[locale]} />;
  const siteTokens = savedPresentation.presentation.tokens;
  if (resolved.kind === 'missing') notFound();
  if (resolved.kind === 'unavailable') return <ZoneAuthoringFailure failure="unavailable" copy={messages[locale]} />;
  if (resolved.kind === 'join') return <ZoneAuthoringFailure failure="denied" copy={messages[locale]} />;
  const siteMounts = navigation.data.links.filter(mount => mount.disclosure === 'public')
    .map(mount => ({ segment: mount.segment, name: zoneContentText(mount.name, locale) }));
  const published = model.state.publishedRevisionId;
  const status = !published ? 'private' : model.state.basis?.revisionId === published ? 'live' : 'behind';
  if (resolved.realm) {
    const view = await loadRealmView(space, locale, {}, 'site');
    if (view.kind === 'unavailable') return <ZoneAuthoringFailure failure="unavailable" copy={messages[locale]} />;
    if (view.kind !== 'view') return <ZoneAuthoringFailure failure="unavailable" copy={messages[locale]} />;
    return <RealmFrame view={view} tab={null} locale={locale} search={{}} address={sitePath}
      structuralPreview siteMounts={siteMounts} siteTokens={siteTokens}>
      <PageContainer>
        <ZoneDraftPreview copy={messages[locale]} document={model.document} editorPath={editorPath}
          sitePath={sitePath} status={status} pageSurface={siteTokens.pageSurface} />
      </PageContainer>
    </RealmFrame>;
  }

  const presentation = await readPresentation(resolved.zone);
  if (!presentation.ok) return <ZoneAuthoringFailure failure="unavailable" copy={messages[locale]} />;
  const ref = addressKey(resolved.address.canonical);
  const zone: ZoneContext = {
    slug: presentation.data.official,
    realm: null,
    name: zoneContentText(model.name, locale),
    description: null,
    icon: null,
    hero: null,
    tokens: presentation.data.presentation.tokens,
    locale,
    links: { home: siteHref(locale, ref, []), browse: siteHref(locale, ref, ['browse']),
      works: siteHref(locale, ref, ['browse']), discussions: '', decisions: '', about: '' },
  };
  const realmMessages = await getMessages('realm', locale) as RealmMessages;
  return <StandaloneZoneSiteFrame zone={zone} zoneId={resolved.zone} address={ref} locale={locale}
    messages={realmMessages} presentation={presentation.data} siteMounts={siteMounts} siteTokens={siteTokens}>
    <PageContainer>
      <ZoneDraftPreview copy={messages[locale]} document={model.document} editorPath={editorPath}
        sitePath={sitePath} status={status} pageSurface={siteTokens.pageSurface} />
    </PageContainer>
  </StandaloneZoneSiteFrame>;
}
