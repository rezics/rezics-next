import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { readRealmHeader } from '../../../../../features/manage/read.ts';
import { RealmFrame } from '../../../../../features/manage/realm-frame.tsx';
import { managedAddress, manager } from '../../../../../features/manage/server.ts';
import { getMessages, requestLocale } from '../../../../../i18n/server.ts';

export default async function RealmManagementLayout({ children, params }: {
  children: ReactNode; params: Promise<{ realm: string }>;
}) {
  const target = await managedAddress((await params).realm);
  if (!target) notFound();
  const locale = await requestLocale();
  const { agent, anonymous } = await manager(locale, `/manage/r/${target.address}`);
  const [messages, header] = await Promise.all([getMessages('manage', locale),
    readRealmHeader(anonymous, target.id, locale)]);
  return <RealmFrame realm={target.id} address={target.address} header={header.ok ? header.data : null} agent={agent}
    locale={locale} messages={messages}>{children}</RealmFrame>;
}
