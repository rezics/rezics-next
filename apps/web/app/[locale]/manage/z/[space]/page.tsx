import type { Metadata } from 'next';
import { manager } from '../../../../../features/manage/server.ts';
import { messages } from '../../../../../features/zone-editor/messages.ts';
import { loadZoneAuthoring, loadZoneLifecycle } from '../../../../../features/zone-editor/read.ts';
import { zoneEditorPath } from '../../../../../features/zone-editor/routes.ts';
import { zoneHomeView } from '../../../../../features/zones/independent-zone-recorded-page-routes.tsx';
import { requestLocale } from '../../../../../i18n/server.ts';

export { zoneHomeView };

export async function generateMetadata(): Promise<Metadata> {
  return { title: messages[await requestLocale()].homeTitle };
}

export default async function ZoneHomePage({ params }: { params: Promise<{ space: string }> }) {
  const { space } = await params;
  const locale = await requestLocale();
  const { actingSubject, main, signInHref } = await manager(locale, zoneEditorPath(space));
  return zoneHomeView({
    space, locale, actingSubject, signInHref,
    loadLifecycle: () => loadZoneLifecycle(main, space, locale, actingSubject),
    loadAuthoring: () => loadZoneAuthoring(main, space, locale, actingSubject),
  });
}
