import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ManageFailure } from '../../../../../../features/manage/parts.tsx';
import { readAgents, readRoles } from '../../../../../../features/manage/read.ts';
import { RolesView } from '../../../../../../features/manage/roles-view.tsx';
import { realmHref } from '../../../../../../features/manage/routes.ts';
import { managedAddress, manager } from '../../../../../../features/manage/server.ts';
import { localizedPath } from '../../../../../../i18n/locale.ts';
import { getMessages, getTranslation, requestLocale } from '../../../../../../i18n/server.ts';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getTranslation('manage', [await requestLocale()]);
  return { title: t.tabRoles, robots: { index: false } };
}

export default async function RealmRolesRoute({ params }: { params: Promise<{ realm: string }> }) {
  const target = await managedAddress((await params).realm);
  if (!target) notFound();
  const { id: realm, address } = target;
  const locale = await requestLocale();
  const { actingSubject, main, anonymous, signInHref } = await manager(locale, realmHref(address, 'roles'));
  const [messages, list] = await Promise.all([getMessages('manage', locale),
    readRoles(main, realm, actingSubject)]);
  if (!list.ok) return <ManageFailure failure={list.failure} locale={locale} messages={messages} signInHref={signInHref}
    retryHref={localizedPath(realmHref(address, 'roles'), locale)} />;
  // Each card names its first three holders. A Realm at the cap is 32 cards.
  const agents = await readAgents(anonymous, list.data.roles.flatMap(role => role.holders ?? []), undefined, 32 * 3);
  return <RolesView realm={realm} address={address} actingSubject={actingSubject} list={list.data} agents={agents}
    locale={locale} messages={messages} />;
}
