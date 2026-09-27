import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ManageFailure } from '../../../../../features/manage/parts.tsx';
import { mentioned } from '../../../../../features/manage/queue-api.ts';
import { QueueView } from '../../../../../features/manage/queue-view.tsx';
import { readAgents, readQueue, readWorks } from '../../../../../features/manage/read.ts';
import { RememberRealm } from '../../../../../features/manage/remember.tsx';
import { parseQueueView, queueHref } from '../../../../../features/manage/routes.ts';
import { isRealmSegment, manager } from '../../../../../features/manage/server.ts';
import { localizedPath } from '../../../../../i18n/locale.ts';
import { getMessages, getTranslation, requestLocale } from '../../../../../i18n/server.ts';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getTranslation('manage', [await requestLocale()]);
  return { title: t.tabQueue, robots: { index: false } };
}

export default async function RealmQueueRoute({ params, searchParams }: {
  params: Promise<{ realm: string }>; searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ realm }, query] = await Promise.all([params, searchParams]);
  if (!isRealmSegment(realm)) notFound();
  const locale = await requestLocale();
  const view = parseQueueView(query);
  const { actingSubject, main, anonymous, signInHref } = await manager(locale, queueHref(realm, view));
  const [messages, page] = await Promise.all([getMessages('manage', locale),
    readQueue(main, realm, { actingSubject, ...view })]);
  if (!page.ok) {
    return <ManageFailure failure={page.failure} locale={locale} messages={messages} signInHref={signInHref}
      retryHref={localizedPath(queueHref(realm, view), locale)} />;
  }
  const names = mentioned(page.data.items);
  const [agents, works] = await Promise.all([readAgents(anonymous, names.agents),
    readWorks(main, names.works, { language: locale, actingSubject })]);
  return <>
    <RememberRealm realm={realm} />
    <QueueView key={`${view.state}:${view.type ?? ''}`} realm={realm} actingSubject={actingSubject} view={view}
      initial={page.data} agents={agents} works={works} now={Date.now()} locale={locale} messages={messages} />
  </>;
}
