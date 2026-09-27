import { buttonVariants } from '@rezics/ui/button';
import { BookXIcon, TriangleAlertIcon } from 'lucide-react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { EmptyState } from '../../../../../../features/shell/empty-state.tsx';
import Link from '../../../../../../features/shell/localized-link.tsx';
import { PageContainer } from '../../../../../../features/shell/page.tsx';
import { RetryButton } from '../../../../../../features/work-page/retry-button.tsx';
import { studioHref } from '../../../../../../features/studio/agent.ts';
import type { DetailsState } from '../../../../../../features/studio/details-form.tsx';
import { readStudioWork } from '../../../../../../features/studio/read.ts';
import { studioAgent } from '../../../../../../features/studio/route.ts';
import { StudioWork } from '../../../../../../features/studio/studio-work.tsx';
import type { WorkMetadata } from '../../../../../../features/studio/types.ts';
import { getMessages, getTranslation, requestLocale } from '../../../../../../i18n/server.ts';

type Params = { params: Promise<{ agent: string; work: string }> };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function load({ params }: Params) {
  const { agent: segment, work } = await params;
  if (!uuid.test(work)) notFound();
  const agent = await studioAgent(segment);
  if (!agent) return null;
  const locale = await requestLocale();
  return { agent, locale, loaded: await readStudioWork(agent.iri, work, locale) };
}

export async function generateMetadata(props: Params): Promise<Metadata> {
  const context = await load(props);
  const { t } = await getTranslation('studio', [await requestLocale()]);
  return { title: context?.loaded.ok ? context.loaded.data.header.title.value : t.studio, robots: { index: false } };
}

/** Details as the form edits them: one row per language (the Work's own language first), the original title apart. */
function detailsOf(metadata: WorkMetadata | null, language: string): DetailsState {
  const entries = metadata?.localized.map(entry => ({ language: entry.language, title: entry.title ?? '',
    description: entry.description ?? '' })) ?? [];
  return { status: 'idle', head: metadata?.revision ?? null, values: {
    originalTitle: metadata?.originalTitle?.value ?? '', originalLanguage: metadata?.originalTitle?.language ?? '',
    entries: entries.length ? entries : [{ language, title: '', description: '' }] } };
}

export default async function StudioWorkPage(props: Params) {
  const context = await load(props);
  if (!context) return null;
  const { agent, locale, loaded } = context;
  const messages = await getMessages('studio', locale);
  const { t } = await getTranslation('studio', [locale]);
  if (!loaded.ok) {
    return <PageContainer className="max-w-2xl">
      {loaded.failure === 'unavailable'
        ? <EmptyState icon={TriangleAlertIcon} tone="destructive" role="alert" headingLevel={1} title={t.workFailed}>
          <RetryButton label={t.retry} pendingLabel={t.retry} /></EmptyState>
        : <EmptyState icon={BookXIcon} headingLevel={1} title={t.workMissing}>
          <Link href={studioHref(agent)} className={buttonVariants({ variant: 'outline' })}>{t.backToStudio}</Link>
        </EmptyState>}
    </PageContainer>;
  }
  const { metadata } = loaded.data;
  return <StudioWork agent={agent} work={loaded.data}
    details={detailsOf(metadata.ok ? metadata.data : null, loaded.data.header.selectedLanguage ?? locale)}
    locale={locale} messages={messages} />;
}
