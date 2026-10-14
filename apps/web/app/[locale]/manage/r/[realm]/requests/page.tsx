import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import type { UiLocale } from '../../../../../../i18n/define.ts';
import { ManageFailure } from '../../../../../../features/manage/parts.tsx';
import { RequestsView } from '../../../../../../features/manage/requests-view.tsx';
import { readRequestsAtAddress, type SpaceAccessApi } from '../../../../../../features/manage/settings-api.ts';
import { accessMessages } from '../../../../../../features/manage/settings-messages.ts';
import { managedAddress, manager } from '../../../../../../features/manage/server.ts';
import type { MainClient } from '../../../../../../features/manage/types.ts';
import { localizedPath } from '../../../../../../i18n/locale.ts';
import { getMessages, requestLocale } from '../../../../../../i18n/server.ts';

/** The request route after the manager has admitted the acting Person. */
export async function joinRequestsBody({ main, realm, actingSubject, locale, signInHref, href, apiFor }: {
  main: MainClient; realm: string; actingSubject: string; locale: UiLocale; signInHref: string; href: string;
  /** Story replay for the inbox's names and search. Production omits it and uses the browser session. */
  apiFor?: (space: string, realm: string) => SpaceAccessApi;
}): Promise<ReactNode> {
  const [messages, requests] = await Promise.all([
    getMessages('manage', locale), readRequestsAtAddress(main, realm, actingSubject),
  ]);
  if (!requests.ok) {
    const failure = requests.failure;
    return <ManageFailure failure={failure === 'stale' ? 'moved' : failure === 'conflict' || failure === 'pending' ? 'unavailable' : failure}
      locale={locale} messages={messages} signInHref={signInHref} retryHref={localizedPath(href, locale)} />;
  }
  return <RequestsView key={`${requests.data.realm}:${actingSubject}`} initial={requests.data.page} space={requests.data.space}
    realm={requests.data.realm} actingSubject={actingSubject} locale={locale} api={apiFor?.(requests.data.space, requests.data.realm)} />;
}

export async function generateMetadata(): Promise<Metadata> {
  return { title: accessMessages[await requestLocale()].requests, robots: { index: false } };
}
export default async function JoinRequestsRoute({ params }: { params: Promise<{ realm: string }> }) {
  const target = await managedAddress((await params).realm);
  if (!target) notFound();
  const locale = await requestLocale();
  const href = `/manage/r/${target.address}/requests`;
  const { main, actingSubject, signInHref } = await manager(locale, href);
  return joinRequestsBody({ main, realm: target.id, actingSubject, locale, signInHref, href });
}
