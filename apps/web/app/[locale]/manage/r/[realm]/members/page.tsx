import type { Metadata } from 'next';
import type { UiLocale } from '../../../../../../i18n/define.ts';
import type { MainClient } from '../../../../../../features/manage/types.ts';
import type { AdminApi } from '../../../../../../features/manage/admin-api.ts';
import { notFound } from 'next/navigation';
import { MembersView } from '../../../../../../features/manage/members-view.tsx';
import { ManageFailure } from '../../../../../../features/manage/parts.tsx';
import { readAgents, readMembers, readOutgoingInvitations, readRoles } from '../../../../../../features/manage/read.ts';
import { membersHref, parseMemberRole } from '../../../../../../features/manage/routes.ts';
import { managedAddress, manager } from '../../../../../../features/manage/server.ts';
import { localizedPath } from '../../../../../../i18n/locale.ts';
import { getMessages, getTranslation, requestLocale } from '../../../../../../i18n/server.ts';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getTranslation('manage', [await requestLocale()]);
  return { title: t.tabMembers, robots: { index: false } };
}

export default async function RealmMembersRoute({ params, searchParams }: { params: Promise<{ realm: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const target = await managedAddress((await params).realm);
  if (!target) notFound();
  const { id: realm, address } = target;
  const role = parseMemberRole(await searchParams);
  const locale = await requestLocale();
  const back = membersHref(address, role);
  const { principal, actingSubject, main, anonymous, signInHref } = await manager(locale, back);
  return realmMembersBody({ main, anonymous, principal, realm, address, actingSubject, role, locale, signInHref });
}

/** The members route after its manager admits the acting Person. */
export async function realmMembersBody({ main, anonymous, principal, realm, address = realm, actingSubject, role = null,
  locale, signInHref, api, refresh, now }: {
  main: MainClient; anonymous: MainClient; principal: string; realm: string; address?: string; actingSubject: string;
  role?: string | null; locale: UiLocale; signInHref: string; api?: AdminApi; refresh?: () => void; now?: number;
}) {
  const back = membersHref(address, role);
  const [messages, page, roles, invitations] = await Promise.all([getMessages('manage', locale),
    readMembers(main, realm, { actingSubject, role }), readRoles(main, realm, actingSubject),
    readOutgoingInvitations(main, realm, actingSubject)]);
  if (!page.ok) return <ManageFailure failure={page.failure} locale={locale} messages={messages} signInHref={signInHref}
    retryHref={localizedPath(back, locale)} />;
  const agents = await readAgents(anonymous, [...page.data.items.map(item => item.member),
    ...(invitations.ok ? invitations.data.items.map(item => item.member) : [])]);
  const named = role && roles.ok ? roles.data.roles.find(item => item.id === role)?.name ?? null : null;
  return <MembersView key={`${principal}:${realm}:${actingSubject}`} principal={principal} realm={realm} address={address} actingSubject={actingSubject} first={page.data} agents={agents}
    invitations={invitations} roles={roles.ok ? roles.data.roles : null}
    roleFilter={role ? { id: role, name: named } : null}
    now={now ?? Date.now()} locale={locale} messages={messages} api={api} refresh={refresh} />;
}
