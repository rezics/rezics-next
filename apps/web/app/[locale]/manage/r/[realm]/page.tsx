import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ManageFailure } from '../../../../../features/manage/parts.tsx';
import { readQueueNames } from '../../../../../features/manage/queue-api.ts';
import { authorityFrom } from '../../../../../features/manage/queue-state.ts';
import { QueueView } from '../../../../../features/manage/queue-view.tsx';
import { readQueue } from '../../../../../features/manage/read.ts';
import { parseQueueView, queueHref, realmHref } from '../../../../../features/manage/routes.ts';
import { managedAddress, manager, permissionsIn, realmHeader } from '../../../../../features/manage/server.ts';
import { localizedPath } from '../../../../../i18n/locale.ts';
import { getMessages, getTranslation, requestLocale } from '../../../../../i18n/server.ts';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getTranslation('manage', [await requestLocale()]);
  return { title: t.tabQueue, robots: { index: false } };
}

export default async function RealmQueueRoute({ params, searchParams }: {
  params: Promise<{ realm: string }>; searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [path, query] = await Promise.all([params, searchParams]);
  const target = await managedAddress(path.realm);
  if (!target) notFound();
  const { id: realm, address } = target;
  const locale = await requestLocale();
  const view = parseQueueView(query);
  const { actingSubject, main, anonymous, signInHref } = await manager(locale, queueHref(address, view));
  const [messages, page, permissions, header] = await Promise.all([getMessages('manage', locale),
    readQueue(main, realm, { actingSubject, ...view }), permissionsIn(main, actingSubject, realm),
    realmHeader(realm, locale)]);
  if (!page.ok) {
    return <ManageFailure failure={page.failure} locale={locale} messages={messages} signInHref={signInHref}
      retryHref={localizedPath(queueHref(address, view), locale)} />;
  }
  const names = await readQueueNames(main, realm, page.data.items, { language: locale, actingSubject }, undefined,
    anonymous);
  // Rules are published from Settings, which needs both permissions Main checks there.
  const publishesRules = permissions === null || permissions.includes('governance.rule.publish')
    && permissions.includes('realm.settings.manage');
  return <QueueView key={`${view.state}:${view.type ?? ''}:${view.reason ?? ''}`} realm={realm} address={address}
    actingSubject={actingSubject} view={view} initial={page.data} names={names}
    realmRules={header.ok ? header.data.rules ?? [] : []} authority={authorityFrom(permissions)}
    rulesHref={publishesRules ? realmHref(address, 'settings') : null} now={Date.now()} locale={locale}
    messages={messages} />;
}
