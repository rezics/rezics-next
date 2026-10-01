import type { Metadata } from 'next';
import { readSession } from '../../../../features/auth/session.ts';
import { CaseView } from '../../../../features/safety/case-view.tsx';
import { safetyText } from '../../../../features/safety/messages.ts';
import { PageContainer, PageHeader } from '../../../../features/shell/page.tsx';
import { requestLocale } from '../../../../i18n/server.ts';

export async function generateMetadata(): Promise<Metadata> {
  const locale = await requestLocale();
  return { title: safetyText.statusTitle[locale], robots: { index: false, follow: false }, referrer: 'no-referrer' };
}

/**
 * A report's private page. The credential is in the URL fragment, which the
 * browser never sends, so this server render knows only the case number and
 * `CaseView` reads the credential on the client.
 */
export default async function CaseRoute({ params }: { params: Promise<{ caseId: string }> }) {
  const [locale, { caseId }, session] = await Promise.all([requestLocale(), params, readSession()]);
  const actingSubject = session?.agent.status === 'selected' ? session.agent.agent.iri : null;
  return <PageContainer className="grid gap-8">
    <PageHeader title={safetyText.statusTitle[locale]} />
    <CaseView locale={locale} caseId={caseId} actingSubject={actingSubject} />
  </PageContainer>;
}
