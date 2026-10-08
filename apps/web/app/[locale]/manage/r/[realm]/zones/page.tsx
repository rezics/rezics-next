import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ManageFailure } from '../../../../../../features/manage/parts.tsx';
import { settle } from '../../../../../../features/manage/read.ts';
import { realmHref } from '../../../../../../features/manage/routes.ts';
import { managedAddress, manager } from '../../../../../../features/manage/server.ts';
import { ZoneAttachments, type ZoneAttachmentItem } from '../../../../../../features/manage/zone-attachments.tsx';
import { localizedPath } from '../../../../../../i18n/locale.ts';
import { getMessages, getTranslation, requestLocale } from '../../../../../../i18n/server.ts';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getTranslation('manage', [await requestLocale()]);
  return { title: t.zonesTitle, robots: { index: false } };
}

export default async function RealmZonesPage({ params }: { params: Promise<{ realm: string }> }) {
  const target = await managedAddress((await params).realm);
  if (!target) notFound();
  const { id: realm, address } = target;
  const locale = await requestLocale();
  const href = realmHref(address, 'zones');
  const { actingSubject, main, signInHref } = await manager(locale, href);
  const [messages, page] = await Promise.all([getMessages('manage', locale),
    settle(() => main.v1.realms({ realm })['zone-attachments'].get({ query: { actingSubject, limit: 24 } }),
      { management: true })]);
  if (!page.ok) return <ManageFailure failure={page.failure} locale={locale} messages={messages} signInHref={signInHref}
    retryHref={localizedPath(href, locale)} />;
  const items: ZoneAttachmentItem[] = page.data.items.map(item => ({
    zone: item.zone, name: item.name, language: item.language, direction: item.direction,
    address: { prefix: item.address.prefix, key: item.address.key }, attachedAt: item.attachedAt,
    // Formatted once on the server. A browser-local clock disagrees with this
    // render, and that hydration mismatch drops the withdraw click.
    when: item.attachedAt
      ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(item.attachedAt))
      : null,
  }));
  return <ZoneAttachments realm={realm} actingSubject={actingSubject} locale={locale} messages={messages}
    items={items} nextCursor={page.data.nextCursor} />;
}
