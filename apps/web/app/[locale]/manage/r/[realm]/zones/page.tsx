import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { readZoneAttachments } from '../../../../../../features/manage/read.ts';
import { realmHref } from '../../../../../../features/manage/routes.ts';
import { managedAddress, manager } from '../../../../../../features/manage/server.ts';
import { ZoneAttachmentsPage } from '../../../../../../features/manage/zone-attachments-page.tsx';
import type { MainClient } from '../../../../../../features/manage/types.ts';
import type { UiLocale } from '../../../../../../i18n/define.ts';
import { localizedPath } from '../../../../../../i18n/locale.ts';
import { getMessages, getTranslation, requestLocale } from '../../../../../../i18n/server.ts';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getTranslation('manage', [await requestLocale()]);
  return { title: t.zonesTitle, robots: { index: false } };
}

/** The route body, with the request-cached host client supplied by its manager. */
export async function realmZonesBody({ principal, realm, address = realm, actingSubject, main, locale, signInHref, client }: {
  principal: string; realm: string; address?: string; actingSubject: string; main: MainClient; locale: UiLocale;
  signInHref: string; client?: () => MainClient;
}) {
  const href = realmHref(address, 'zones');
  const [messages, page] = await Promise.all([getMessages('manage', locale),
    readZoneAttachments(main, realm, actingSubject)]);
  return <ZoneAttachmentsPage key={`${principal}:${realm}:${actingSubject}`} principal={principal} page={page} realm={realm} actingSubject={actingSubject} locale={locale} messages={messages}
    signInHref={signInHref} retryHref={localizedPath(href, locale)} client={client} />;
}

export default async function RealmZonesPage({ params }: { params: Promise<{ realm: string }> }) {
  const target = await managedAddress((await params).realm);
  if (!target) notFound();
  const { id: realm, address } = target;
  const locale = await requestLocale();
  const href = realmHref(address, 'zones');
  const { principal, actingSubject, main, signInHref } = await manager(locale, href);
  return realmZonesBody({ principal, realm, address, actingSubject, main, locale, signInHref });
}
