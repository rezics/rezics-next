import type { Metadata } from 'next';
import { signInPath } from '../../../features/auth/paths.ts';
import { ProposalsFailure } from '../../../features/proposals/failure.tsx';
import { listHref, ProposalList, parseListView } from '../../../features/proposals/proposal-list.tsx';
import { readProposals, readTargetNames } from '../../../features/proposals/read.ts';
import { PageContainer, PageHeader } from '../../../features/shell/page.tsx';
import { shellReader } from '../../../features/shell/communities-read.ts';
import { localizedPath } from '../../../i18n/locale.ts';
import { getMessages, getTranslation, requestLocale } from '../../../i18n/server.ts';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getTranslation('proposals', [await requestLocale()]);
  return { title: t.title, robots: { index: false } };
}

export default async function ProposalsRoute({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [locale, query] = await Promise.all([requestLocale(), searchParams]);
  const view = parseListView(typeof query.view === 'string' ? query.view : undefined);
  const href = listHref(view);
  const [messages, reader] = await Promise.all([getMessages('proposals', locale), shellReader()]);
  const { t } = await getTranslation('proposals', [locale]);
  const top = <PageHeader title={t.listTitle} description={t.description} />;
  if (!reader.actingSubject) {
    return <PageContainer className="grid gap-6">{top}
      <ProposalsFailure failure="signed-out" signInHref={signInPath(localizedPath(href, locale))}
        retryHref={href} locale={locale} messages={messages} /></PageContainer>;
  }
  const page = await readProposals(reader.main, view, reader.actingSubject, null);
  const names = page.ok ? await readTargetNames(reader.main, reader.actingSubject,
    page.data.items.map(item => item.target.resource), locale) : {};
  return <PageContainer className="grid gap-6">{top}
    <ProposalList key={view} view={view} initial={page} names={names} actingSubject={reader.actingSubject}
      locale={locale} messages={messages} /></PageContainer>;
}
