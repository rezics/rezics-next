import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { ACCESS_COOKIE } from '../../../../../features/auth/cookies.ts';
import { realmEditSite } from '../../../../../features/manage/realm-site.ts';
import { RealmFrame } from '../../../../../features/manage/realm-frame.tsx';
import { settle } from '../../../../../features/manage/read.ts';
import { managedAddress, manager, realmHeader } from '../../../../../features/manage/server.ts';
import { showcaseEditorOpen } from '../../../../../features/zone-editor/edit-link.tsx';
import { getMessages, requestLocale } from '../../../../../i18n/server.ts';

export default async function RealmManagementLayout({ children, params }: {
  children: ReactNode; params: Promise<{ realm: string }>;
}) {
  const target = await managedAddress((await params).realm);
  if (!target) notFound();
  const locale = await requestLocale();
  const { agent, actingSubject, main } = await manager(locale, `/manage/r/${target.address}`);
  const token = (await cookies()).get(ACCESS_COOKIE)?.value;
  const [messages, header, siteHref] = await Promise.all([
    getMessages('manage', locale),
    realmHeader(target.id, locale),
    realmEditSite({
      zone: () => settle(() => main.v1.realms({ realm: target.id }).zone.get({ query: { actingSubject } })),
      editor: zoneId => showcaseEditorOpen(zoneId, actingSubject, token),
    }),
  ]);
  return <RealmFrame realm={target.id} address={target.address} header={header.ok ? header.data : null} agent={agent}
    locale={locale} messages={messages} siteHref={siteHref}>{children}</RealmFrame>;
}
