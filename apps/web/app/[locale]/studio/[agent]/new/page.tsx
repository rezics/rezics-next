import type { Metadata } from 'next';
import { PageContainer, PageHeader } from '../../../../../features/shell/page.tsx';
import { createWork } from '../../../../../features/studio/actions.ts';
import { NewWorkForm } from '../../../../../features/studio/new-work-form.tsx';
import { studioAgent } from '../../../../../features/studio/route.ts';
import { getMessages, getTranslation, requestLocale } from '../../../../../i18n/server.ts';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getTranslation('studio', [await requestLocale()]);
  return { title: t.newHeading, robots: { index: false } };
}

export default async function NewWorkPage({ params }: { params: Promise<{ agent: string }> }) {
  const agent = await studioAgent((await params).agent);
  if (!agent) return null;
  const locale = await requestLocale();
  const messages = await getMessages('studio', locale);
  const { t } = await getTranslation('studio', [locale]);
  return <PageContainer className="grid max-w-2xl gap-8">
    <PageHeader title={t.newHeading} description={t.newHelp} />
    <NewWorkForm agent={agent} action={createWork} initialState={{ status: 'idle', key: crypto.randomUUID() }}
      locale={locale} messages={messages} />
  </PageContainer>;
}
