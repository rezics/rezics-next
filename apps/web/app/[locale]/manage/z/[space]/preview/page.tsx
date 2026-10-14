import type { Metadata } from 'next';
import { cookies, headers } from 'next/headers';
import { declaredData } from '../../../../../../zones/official/declared.ts';
import { installedDigest, loadPackage } from '../../../../../../zones/official/index.ts';
import { manager } from '../../../../../../features/manage/server.ts';
import { readPresentation, readRealmHeader } from '../../../../../../features/realm/read.ts';
import type { RealmMessages } from '../../../../../../features/realm/messages.ts';
import { loadCompleteZoneNavigation } from '../../../../../../features/zone-editor/api.ts';
import { messages } from '../../../../../../features/zone-editor/messages.ts';
import { loadZoneAuthoring } from '../../../../../../features/zone-editor/read.ts';
import { loadSavedPreviewFrame } from '../../../../../../features/zone-editor/saved-preview-frame.ts';
import { zonePreviewPath } from '../../../../../../features/zone-editor/routes.ts';
import { ZONE_NONCE_HEADER } from '../../../../../../features/zones/csp.ts';
import { ZONE_LOOK_COOKIE, zoneLookEnabled } from '../../../../../../features/zones/execution.ts';
import { zonePreviewBody } from '../../../../../../features/zones/independent-zone-recorded-page-routes.tsx';
import { parseTheme, THEME_COOKIE } from '../../../../../../features/shell/preferences.ts';
import { getMessages, requestLocale } from '../../../../../../i18n/server.ts';

export { zonePreviewBody };

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
  return zonePreviewBody(loaded, {
    locale, readerTheme: parseTheme(jar.get(THEME_COOKIE)?.value),
    nonce: incoming.get(ZONE_NONCE_HEADER) ?? undefined, zoneMessages,
  });
}
