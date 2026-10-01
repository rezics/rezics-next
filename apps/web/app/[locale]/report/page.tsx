import type { Metadata } from 'next';
import { readSession } from '../../../features/auth/session.ts';
import { ReportForm } from '../../../features/safety/report-form.tsx';
import { ReportsList } from '../../../features/safety/reports-list.tsx';
import { safetyText } from '../../../features/safety/messages.ts';
import { PageContainer, PageHeader } from '../../../features/shell/page.tsx';
import { requestLocale } from '../../../i18n/server.ts';

export async function generateMetadata(): Promise<Metadata> {
  const locale = await requestLocale();
  // A report page names a target and, after it, a private case: nothing here is for a search index or a referrer.
  return { title: safetyText.title[locale], robots: { index: false, follow: false }, referrer: 'no-referrer' };
}

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? '';

/** `/report`: public, no account. `?target=` and `?realm=` come from the Report action on a page. */
export default async function ReportRoute({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [locale, query, session] = await Promise.all([requestLocale(), searchParams, readSession()]);
  const actingSubject = session?.agent.status === 'selected' ? session.agent.agent.iri : null;
  return <PageContainer className="grid gap-10">
    <PageHeader title={safetyText.title[locale]} description={safetyText.intro[locale]} />
    <ReportForm locale={locale} target={first(query.target)} realm={first(query.realm) || null}
      actingSubject={actingSubject} />
    {session ? <ReportsList locale={locale} /> : null}
  </PageContainer>;
}
