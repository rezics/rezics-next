import type { Metadata } from 'next';
import type { UiLocale } from '../../../../../../i18n/define.ts';
import type { MainClient } from '../../../../../../features/manage/types.ts';
import type { AdminApi } from '../../../../../../features/manage/admin-api.ts';
import { notFound } from 'next/navigation';
import { MembersView } from '../../../../../../features/manage/members-view.tsx';
import { ManageFailure } from '../../../../../../features/manage/parts.tsx';
import { mapRealmMembers, readRealmMembersPage } from '../../../../../../features/manage/realm-team-recorded-page.ts';
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
  const [messages, loaded] = await Promise.all([getMessages('manage', locale),
    readRealmMembersPage({ main, anonymous }, { realm, actingSubject, role })]);
  const mapped = mapRealmMembers(loaded.page, loaded.roles, loaded.invitations, role);
  if (mapped.kind === 'refusal') return <ManageFailure failure={mapped.failure} locale={locale} messages={messages}
    signInHref={signInHref} retryHref={localizedPath(back, locale)} />;
  return <MembersView key={`${principal}:${realm}:${actingSubject}`} principal={principal} realm={realm} address={address} actingSubject={actingSubject} first={mapped.page} agents={loaded.agents}
    invitations={mapped.invitations} roles={mapped.roles} roleFilter={mapped.roleFilter}
    now={now ?? Date.now()} locale={locale} messages={messages} api={api} refresh={refresh} />;
}
