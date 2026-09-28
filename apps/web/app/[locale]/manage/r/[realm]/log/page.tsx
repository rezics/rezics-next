import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { LogView } from '../../../../../../features/manage/log-view.tsx';
import { ManageFailure } from '../../../../../../features/manage/parts.tsx';
import { readAgents, readAudit, readPublicDecisions, readWorks } from '../../../../../../features/manage/read.ts';
import { logHref, parseLogView } from '../../../../../../features/manage/routes.ts';
import { managedAddress, manager } from '../../../../../../features/manage/server.ts';
import { localizedPath } from '../../../../../../i18n/locale.ts';
import { getMessages, getTranslation, requestLocale } from '../../../../../../i18n/server.ts';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getTranslation('manage', [await requestLocale()]);
  return { title: t.tabLog, robots: { index: false } };
}

export default async function RealmLogRoute({ params, searchParams }: {
  params: Promise<{ realm: string }>; searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [path, query] = await Promise.all([params, searchParams]);
  const target = await managedAddress(path.realm);
  if (!target) notFound();
  const { id: realm, address } = target;
  const locale = await requestLocale();
  const view = parseLogView(query);
  const { actingSubject, main, anonymous, signInHref } = await manager(locale, logHref(address, view));
  const messages = await getMessages('manage', locale);
  const retryHref = localizedPath(logHref(address, view), locale);
  if (view.view === 'audit') {
    const page = await readAudit(main, realm, { actingSubject, kind: view.kind });
    if (!page.ok) return <ManageFailure failure={page.failure} locale={locale} messages={messages}
      signInHref={signInHref} retryHref={retryHref} />;
    const agents = await readAgents(anonymous, page.data.items.flatMap(item => [item.actingSubject,
      ...(item.detail?.member ? [item.detail.member] : []),
      ...(item.detail?.changes.map(change => change.member) ?? [])]));
    return <LogView realm={realm} address={address} actingSubject={actingSubject} view={view} first={{ kind: 'audit', page: page.data }}
      agents={agents} works={{}} now={Date.now()} locale={locale} messages={messages} />;
  }
  const page = await readPublicDecisions(anonymous, realm);
  if (!page.ok) return <ManageFailure failure={page.failure} locale={locale} messages={messages}
    signInHref={signInHref} retryHref={retryHref} />;
  const works = await readWorks(main, page.data.items.flatMap(item => item.work ? [item.work] : []),
    { language: locale, actingSubject });
  return <LogView realm={realm} address={address} actingSubject={actingSubject} view={view} first={{ kind: 'public', page: page.data }}
    agents={{}} works={works} now={Date.now()} locale={locale} messages={messages} />;
}
