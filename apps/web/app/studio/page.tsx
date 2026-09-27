import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { PageContainer, PageHeader } from '../../features/shell/page.tsx';
import { createWork } from '../../features/studio/actions.ts';
import { CreateWorkForm } from '../../features/studio/create-work-form.tsx';
import { getMessages, getTranslation, requestLocale } from '../../i18n/server.ts';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getTranslation('studio', [await requestLocale()]);
  return { title: t.createHeading };
}

export default async function StudioPage() {
  const jar = await cookies();
  if (!jar.get('rezics_access')?.value) redirect('/sign-in?next=%2Fstudio');
  if (!jar.get('rezics_subject')?.value) redirect('/identity?next=%2Fstudio');
  const messages = await getMessages('studio', await requestLocale());
  return <PageContainer className="grid max-w-2xl gap-6">
    <PageHeader title={messages.createHeading} description={messages.createHelp} />
    <CreateWorkForm action={createWork} messages={messages} />
  </PageContainer>;
}
