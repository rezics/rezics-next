import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ManageFailure } from '../../../../../../features/manage/parts.tsx';
import { readAgents, readMembers, readRoles } from '../../../../../../features/manage/read.ts';
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
  const [messages, list, members] = await Promise.all([getMessages('manage', locale),
    readRoles(main, realm, actingSubject), readMembers(main, realm, { actingSubject })]);
  if (!list.ok) return <ManageFailure failure={list.failure} locale={locale} messages={messages} signInHref={signInHref}
    retryHref={localizedPath(realmHref(address, 'roles'), locale)} />;
  // Holders come from the roster the person may read; without it the cards point to Members.
  const holders: Record<string, string[]> = {};
  for (const member of members.ok ? members.data.items : []) {
    for (const role of member.roles) (holders[role.id] ??= []).push(member.member);
  }
  const agents = await readAgents(anonymous, Object.values(holders).flat());
  return <RolesView realm={realm} actingSubject={actingSubject} list={list.data} holders={holders} agents={agents}
    locale={locale} messages={messages} />;
}
