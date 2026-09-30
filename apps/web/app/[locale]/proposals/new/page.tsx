import type { Metadata } from 'next';
import { signInPath } from '../../../../features/auth/paths.ts';
import { readCorrectionBasis } from '../../../../features/proposals/basis.ts';
import { ProposeCorrectionPage } from '../../../../features/proposals/propose-correction.tsx';
import { PageContainer, PageHeader } from '../../../../features/shell/page.tsx';
import { shellReader } from '../../../../features/shell/communities-read.ts';
import { isUuid } from '../../../../features/proposals/types.ts';
import { ProposalsFailure } from '../../../../features/proposals/failure.tsx';
import { localizedPath } from '../../../../i18n/locale.ts';
import { getMessages, getTranslation, requestLocale } from '../../../../i18n/server.ts';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getTranslation('proposals', [await requestLocale()]);
  return { title: t.proposeTitle, robots: { index: false } };
}

/** `/proposals/new?work=<id>`: the correction form for a Work, a link every Work page can point at. */
export default async function NewProposalRoute({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [locale, query] = await Promise.all([requestLocale(), searchParams]);
  const [messages, { t }, reader] = await Promise.all([getMessages('proposals', locale),
    getTranslation('proposals', [locale]), shellReader()]);
  const work = typeof query.work === 'string' ? query.work : '';
  const path = `/proposals/new?work=${encodeURIComponent(work)}`;
  if (!isUuid(work)) return <PageContainer><ProposalsFailure failure="missing" signInHref={signInPath(localizedPath(path, locale))}
    retryHref={path} locale={locale} messages={messages} /></PageContainer>;
  const basis = await readCorrectionBasis(reader.main, work, reader.actingSubject);
  return <PageContainer className="grid max-w-3xl gap-6">
    <PageHeader title={t.proposeTitle} description={t.proposeDescription} />
    <ProposeCorrectionPage basis={basis} actingSubject={reader.actingSubject ?? null}
      signInHref={signInPath(localizedPath(path, locale))}
      languages={[locale]} locale={locale} messages={messages} /></PageContainer>;
}
