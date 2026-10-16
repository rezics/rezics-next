import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { readRealmRulesSettings } from '../../../../../../features/manage/realm-rules-recorded-page.ts';
import { RealmRulesSettings } from '../../../../../../features/manage/realm-rules-recorded-page-settings.tsx';
import { realmHref } from '../../../../../../features/manage/routes.ts';
import { managedAddress, manager } from '../../../../../../features/manage/server.ts';
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
  const { principal, actingSubject, main, signInHref } = await manager(locale, realmHref(address, 'settings'));
  const [messages, loaded] = await Promise.all([getMessages('manage', locale), readRealmRulesSettings(main, realm, actingSubject)]);
  return <RealmRulesSettings loaded={loaded} principal={principal} actingSubject={actingSubject} address={address}
    locale={locale} messages={messages} signInHref={signInHref} />;
}
