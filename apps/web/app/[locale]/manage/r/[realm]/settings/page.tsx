import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ManageFailure } from '../../../../../../features/manage/parts.tsx';
import { readSettings } from '../../../../../../features/manage/read.ts';
import { realmHref } from '../../../../../../features/manage/routes.ts';
import { managedAddress, manager } from '../../../../../../features/manage/server.ts';
import { SettingsView } from '../../../../../../features/manage/settings-view.tsx';
import { SettingsAccess } from '../../../../../../features/manage/settings-access.tsx';
import { readManagementAccess } from '../../../../../../features/manage/settings-api.ts';
import { uuidOf } from '../../../../../../features/manage/types.ts';
import { localizedPath } from '../../../../../../i18n/locale.ts';
import { getMessages, getTranslation, requestLocale } from '../../../../../../i18n/server.ts';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getTranslation('manage', [await requestLocale()]);
  return { title: t.tabSettings, robots: { index: false } };
}

export default async function RealmSettingsRoute({ params }: { params: Promise<{ realm: string }> }) {
  const target = await managedAddress((await params).realm);
  if (!target) notFound();
  const { id: realm, address } = target;
  const locale = await requestLocale();
  const { actingSubject, main, signInHref } = await manager(locale, realmHref(address, 'settings'));
  const [messages, access] = await Promise.all([getMessages('manage', locale), readManagementAccess(main, realm, actingSubject)]);
  if (!access.ok) return <ManageFailure failure={access.failure === 'stale' ? 'moved'
    : access.failure === 'conflict' || access.failure === 'pending' ? 'unavailable' : access.failure}
    locale={locale} messages={messages} signInHref={signInHref} retryHref={localizedPath(realmHref(address, 'settings'), locale)} />;
  const capability = uuidOf(access.data.realm);
  const settings = await readSettings(main, capability, actingSubject);
  if (!settings.ok) return <ManageFailure failure={settings.failure} locale={locale} messages={messages}
    signInHref={signInHref} retryHref={localizedPath(realmHref(address, 'settings'), locale)} />;
  return <div className="grid gap-8"><SettingsAccess key={`access:${capability}:${actingSubject}`} initial={access.data} actingSubject={actingSubject} locale={locale} />
    <SettingsView key={`rules:${capability}:${actingSubject}`} realm={capability}
      actingSubject={actingSubject} initial={settings.data} locale={locale} messages={messages} /></div>;
}
