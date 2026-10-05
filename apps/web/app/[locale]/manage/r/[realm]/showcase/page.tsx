import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { realmHref } from '../../../../../../features/manage/routes.ts';
import { managedAddress, manager } from '../../../../../../features/manage/server.ts';
import { RealmShowcasePage } from '../../../../../../features/showcase-zone-editor/showcase-page.tsx';
import { getTranslation, requestLocale } from '../../../../../../i18n/server.ts';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getTranslation('manage', [await requestLocale()]);
  return { title: t.tabShowcase, robots: { index: false } };
}

export default async function RealmShowcaseRoute({ params }: { params: Promise<{ realm: string }> }) {
  const target = await managedAddress((await params).realm);
  if (!target) notFound();
  const locale = await requestLocale();
  const { actingSubject, main, signInHref } = await manager(locale, realmHref(target.address, 'showcase'));
  return <RealmShowcasePage address={target.address} locale={locale} main={main} actingSubject={actingSubject} signInHref={signInHref} />;
}
