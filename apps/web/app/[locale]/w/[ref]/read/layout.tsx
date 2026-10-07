import type { ReactNode } from 'react';
import { loadWork } from '../../../../../features/work-page/read.ts';
import { WorkUnavailable } from '../../../../../features/work-page/work-states.tsx';
import { getMessages, requestLocale } from '../../../../../i18n/server.ts';

// Keep a missing Work in the shared Work boundary, outside either reader's loading view.
export default async function ReadLayout({ params, children }: {
  params: Promise<{ ref: string }>; children: ReactNode;
}) {
  const [{ ref }, locale] = await Promise.all([params, requestLocale()]);
  const work = await loadWork(ref, locale);
  return work.ok ? children : <WorkUnavailable messages={await getMessages('workPage', locale)} />;
}
