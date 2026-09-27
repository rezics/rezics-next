import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { MembersView } from '../../../../../../features/manage/members-view.tsx';
import { ManageFailure } from '../../../../../../features/manage/parts.tsx';
import { readAgents, readMembers, readRoles } from '../../../../../../features/manage/read.ts';
import { realmHref } from '../../../../../../features/manage/routes.ts';
import { managedAddress, manager } from '../../../../../../features/manage/server.ts';
import { localizedPath } from '../../../../../../i18n/locale.ts';
import { getMessages, getTranslation, requestLocale } from '../../../../../../i18n/server.ts';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getTranslation('manage', [await requestLocale()]);
  return { title: t.tabMembers, robots: { index: false } };
}

export default async function RealmMembersRoute({ params }: { params: Promise<{ realm: string }> }) {
  const target = await managedAddress((await params).realm);
  if (!target) notFound();
  const { id: realm, address } = target;
  const locale = await requestLocale();
  const { actingSubject, main, anonymous, signInHref } = await manager(locale, realmHref(address, 'members'));
  const [messages, page, roles] = await Promise.all([getMessages('manage', locale),
    readMembers(main, realm, { actingSubject }), readRoles(main, realm, actingSubject)]);
  if (!page.ok) return <ManageFailure failure={page.failure} locale={locale} messages={messages} signInHref={signInHref}
    retryHref={localizedPath(realmHref(address, 'members'), locale)} />;
  const agents = await readAgents(anonymous, page.data.items.map(item => item.member));
  return <MembersView realm={realm} actingSubject={actingSubject} first={page.data} agents={agents}
    roles={roles.ok ? roles.data.roles : null} now={Date.now()} locale={locale} messages={messages} />;
}
