import type { Metadata } from 'next';
import { cookies, headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { declaredData } from '../../../../../../zones/official/declared.ts';
import { installedDigest, loadPackage } from '../../../../../../zones/official/index.ts';
import { manager } from '../../../../../../features/manage/server.ts';
import { readPresentation, readRealmHeader } from '../../../../../../features/realm/read.ts';
import type { RealmMessages } from '../../../../../../features/realm/messages.ts';
import { loadCompleteZoneNavigation } from '../../../../../../features/zone-editor/api.ts';
import { messages } from '../../../../../../features/zone-editor/messages.ts';
import { ZoneDraftPreview } from '../../../../../../features/zone-editor/preview.tsx';
import { ZoneSavedHomeContent } from '../../../../../../features/zone-editor/home-content.tsx';
import { loadZoneAuthoring } from '../../../../../../features/zone-editor/read.ts';
import { loadSavedPreviewFrame } from '../../../../../../features/zone-editor/saved-preview-frame.ts';
import { ZoneSavedPreviewFrame } from '../../../../../../features/zone-editor/saved-preview-frame.tsx';
import { zonePreviewPath } from '../../../../../../features/zone-editor/routes.ts';
import { ZoneAuthoringFailure } from '../../../../../../features/zone-editor/states.tsx';
import { ZONE_NONCE_HEADER } from '../../../../../../features/zones/csp.ts';
import { ZONE_LOOK_COOKIE, zoneLookEnabled } from '../../../../../../features/zones/execution.ts';
import { PageContainer } from '../../../../../../features/shell/page.tsx';
import { parseTheme, THEME_COOKIE } from '../../../../../../features/shell/preferences.ts';
import { getMessages, requestLocale } from '../../../../../../i18n/server.ts';

export async function generateMetadata(): Promise<Metadata> {
  return { title: messages[await requestLocale()].previewTitle };
}

/** The saved draft. People who cannot edit are refused; this route never falls back to the public page. */
export default async function ZoneDraftPreviewPage({ params }: { params: Promise<{ space: string }> }) {
  const { space } = await params;
  const locale = await requestLocale();
  const { actingSubject, main } = await manager(locale, zonePreviewPath(space));
  const [realmMessages, zoneMessages, jar, incoming] = await Promise.all([
    getMessages('realm', locale), getMessages('zones', locale), cookies(), headers(),
  ]);
  const loaded = await loadSavedPreviewFrame({
    authoring: () => loadZoneAuthoring(main, space, locale, actingSubject),
    navigation: saved => loadCompleteZoneNavigation(main, saved.model.zoneId, actingSubject, saved.model.state),
    presentation: readPresentation,
    realmHeader: realm => readRealmHeader(realm, locale),
    installedDigest,
    packages: { load: loadPackage, declarations: declaredData },
  }, { locale, homeName: (realmMessages as RealmMessages).home,
    lookEnabled: zoneLookEnabled(jar.get(ZONE_LOOK_COOKIE)?.value) });
  if (loaded.kind === 'missing') notFound();
  if (loaded.kind === 'failure') return <ZoneAuthoringFailure failure={loaded.failure} copy={messages[locale]} />;
  const { frame } = loaded;
  const { model, preview, editorPath, sitePath } = frame.saved;
  return <ZoneSavedPreviewFrame frame={frame} readerTheme={parseTheme(jar.get(THEME_COOKIE)?.value)}
    nonce={incoming.get(ZONE_NONCE_HEADER) ?? undefined}>
    <PageContainer>
      <ZoneDraftPreview copy={messages[locale]} document={model.document} editorPath={editorPath}
        sitePath={sitePath} status={preview.publicationStatus} pageSurface={frame.cuts.tokens.pageSurface}>
        <ZoneSavedHomeContent preview={preview} context={frame.context} zone={frame.zone}
          pkg={frame.pkg} messages={zoneMessages} copy={messages[locale]} />
      </ZoneDraftPreview>
    </PageContainer>
  </ZoneSavedPreviewFrame>;
}
