import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ManageFailure } from '../../../../../../features/manage/parts.tsx';
import { mapRealmRoles, readRealmRolesPage } from '../../../../../../features/manage/realm-team-recorded-page.ts';
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
  const { principal, actingSubject, main, anonymous, signInHref } = await manager(locale, realmHref(address, 'roles'));
  const [messages, loaded] = await Promise.all([getMessages('manage', locale),
    readRealmRolesPage({ main, anonymous }, { realm, actingSubject })]);
  const mapped = mapRealmRoles(loaded.roles);
  if (mapped.kind === 'refusal') return <ManageFailure failure={mapped.failure} locale={locale} messages={messages}
    signInHref={signInHref} retryHref={localizedPath(realmHref(address, 'roles'), locale)} />;
  return <RolesView key={`${principal}:${realm}:${actingSubject}`} principal={principal} realm={realm} address={address} actingSubject={actingSubject} list={mapped.list} agents={loaded.agents}
    locale={locale} messages={messages} />;
}
