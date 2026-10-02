import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ManageFailure } from '../../../../../../features/manage/parts.tsx';
import { RequestsView } from '../../../../../../features/manage/requests-view.tsx';
import { readRequestsAtAddress } from '../../../../../../features/manage/settings-api.ts';
import { accessMessages } from '../../../../../../features/manage/settings-messages.ts';
import { managedAddress, manager } from '../../../../../../features/manage/server.ts';
import { localizedPath } from '../../../../../../i18n/locale.ts';
import { getMessages, requestLocale } from '../../../../../../i18n/server.ts';

export async function generateMetadata(): Promise<Metadata> {
  return { title: accessMessages[await requestLocale()].requests, robots: { index: false } };
}
export default async function JoinRequestsRoute({ params }: { params: Promise<{ realm: string }> }) {
  const target = await managedAddress((await params).realm);
  if (!target) notFound();
  const locale = await requestLocale();
  const href = `/manage/r/${target.address}/requests`;
  const { main, actingSubject, signInHref } = await manager(locale, href);
  const [messages, requests] = await Promise.all([getMessages('manage', locale), readRequestsAtAddress(main, target.id, actingSubject)]);
  if (!requests.ok) {
    const failure = requests.failure;
    return <ManageFailure failure={failure === 'stale' ? 'moved' : failure === 'conflict' || failure === 'pending' ? 'unavailable' : failure}
      locale={locale} messages={messages} signInHref={signInHref} retryHref={localizedPath(href, locale)} />;
  }
  return <RequestsView initial={requests.data.page} space={requests.data.space} realm={requests.data.realm}
    actingSubject={actingSubject} locale={locale} />;
}
