import type { Metadata } from 'next';
import { settle } from '../../../../../../features/manage/read.ts';
import { manager } from '../../../../../../features/manage/server.ts';
import { messages } from '../../../../../../features/zone-editor/messages.ts';
import { zoneRealmAttachmentView } from '../../../../../../features/communities/realm-site-creation-attachment.tsx';
export { zoneRealmAttachmentView } from '../../../../../../features/communities/realm-site-creation-attachment.tsx';
import { loadZoneAuthoring } from '../../../../../../features/zone-editor/read.ts';
import { zoneRealmPath } from '../../../../../../features/zone-editor/routes.ts';
import { requestLocale } from '../../../../../../i18n/server.ts';

export async function generateMetadata(): Promise<Metadata> {
  return { title: messages[await requestLocale()].realmTitle };
}

export default async function ZoneRealmPage({ params }: { params: Promise<{ space: string }> }) {
  const { space } = await params;
  const locale = await requestLocale();
  const { actingSubject, main, anonymous, signInHref } = await manager(locale, zoneRealmPath(space));
  return zoneRealmAttachmentView({ main, actingSubject, locale, signInHref,
    readRealm: realm => settle(() => anonymous.v1.realms({ realm: realm.slice(-36) }).get({ query: {} })),
    loadAuthoring: () => loadZoneAuthoring(main, space, locale, actingSubject) });
}
