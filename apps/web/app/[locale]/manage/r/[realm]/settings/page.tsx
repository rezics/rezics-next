import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ManageFailure } from '../../../../../../features/manage/parts.tsx';
import { readSettings } from '../../../../../../features/manage/read.ts';
import { realmHref } from '../../../../../../features/manage/routes.ts';
import { managedAddress, manager } from '../../../../../../features/manage/server.ts';
import { SettingsView } from '../../../../../../features/manage/settings-view.tsx';
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
  const [messages, settings] = await Promise.all([getMessages('manage', locale), readSettings(main, realm, actingSubject)]);
  if (!settings.ok) return <ManageFailure failure={settings.failure} locale={locale} messages={messages}
    signInHref={signInHref} retryHref={localizedPath(realmHref(address, 'settings'), locale)} />;
  return <SettingsView realm={realm}
    actingSubject={actingSubject} initial={settings.data} locale={locale} messages={messages} />;
}
