import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { workTitle } from '../../../../../features/seo/work.ts';
import { loadWork, resolveWork } from '../../../../../features/work-page/read.ts';
import { WorkFrameView } from '../../../../../features/work-page/work-views.tsx';
import { WorkUnavailable } from '../../../../../features/work-page/work-states.tsx';
import { getMessages, getTranslation, requestLocale } from '../../../../../i18n/server.ts';

type Params = { params: Promise<{ ref: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const locale = await requestLocale();
  const [work, { t }] = await Promise.all([resolveWork((await params).ref, locale), getTranslation('workPage', [locale])]);
  return { title: work.kind === 'work' ? await workTitle(work)
    : work.kind === 'missing' ? t.notFoundTitle : t.unavailableTitle };
}

// Reuse the proxy's admission before rendering the Work frame or its loading view.
export default async function WorkLayout({ params, children }: Params & { children: ReactNode }) {
  const { ref } = await params;
  const locale = await requestLocale();
  const [work, messages] = await Promise.all([loadWork(ref, locale), getMessages('workPage', locale)]);
  if (!work.ok) return <WorkUnavailable messages={messages} />;
  return <WorkFrameView workRef={ref} id={work.id} work={work.header} locale={locale} messages={messages}>
    {children}</WorkFrameView>;
}
