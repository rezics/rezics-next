import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { resolveWork } from '../../../../features/work-page/read.ts';
import { WorkFrameView } from '../../../../features/work-page/work-views.tsx';
import { WorkUnavailable } from '../../../../features/work-page/work-states.tsx';
import { getMessages, getTranslation, requestLocale } from '../../../../i18n/server.ts';

type Params = { params: Promise<{ ref: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const locale = await requestLocale();
  const [work, { t }] = await Promise.all([resolveWork((await params).ref, locale), getTranslation('workPage', [locale])]);
  return { title: work.kind === 'work' ? work.header.title.value
    : work.kind === 'missing' ? t.notFoundTitle : t.unavailableTitle };
}

// A missing Work or a renamed slug is left to the view, which throws notFound()
// or redirects: vinext renders not-found boundaries for pages, not layouts.
export default async function WorkLayout({ params, children }: Params & { children: ReactNode }) {
  const { ref } = await params;
  const locale = await requestLocale();
  const [work, messages] = await Promise.all([resolveWork(ref, locale), getMessages('workPage', locale)]);
  if (work.kind === 'unavailable') return <WorkUnavailable messages={messages} />;
  if (work.kind !== 'work') return children;
  return <WorkFrameView workRef={ref} id={work.id} work={work.header} locale={locale} messages={messages}>
    {children}</WorkFrameView>;
}
