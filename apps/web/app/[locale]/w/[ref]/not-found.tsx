import type { Metadata } from 'next';
import { WorkNotFound } from '../../../../features/work-page/work-states.tsx';
import { getMessages, getTranslation, requestLocale } from '../../../../i18n/server.ts';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getTranslation('workPage', [await requestLocale()]);
  return { title: t.notFoundTitle, robots: { index: false } };
}

export default async function WorkNotFoundPage() {
  return <WorkNotFound messages={await getMessages('workPage', await requestLocale())} />;
}
