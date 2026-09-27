import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { AGENT_COOKIE } from '../../features/auth/cookies.ts';
import { signInPath } from '../../features/auth/paths.ts';
import { readSession } from '../../features/auth/session.ts';
import { PageContainer, PageHeader } from '../../features/shell/page.tsx';
import { createWork } from '../../features/studio/actions.ts';
import { CreateWorkForm } from '../../features/studio/create-work-form.tsx';
import { getMessages, getTranslation, requestLocale } from '../../i18n/server.ts';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getTranslation('studio', [await requestLocale()]);
  return { title: t.createHeading };
}

export default async function StudioPage() {
  if (!await readSession()) redirect(signInPath('/studio'));
  if (!(await cookies()).get(AGENT_COOKIE)?.value) redirect('/identity?next=%2Fstudio');
  const messages = await getMessages('studio', await requestLocale());
  return <PageContainer className="grid max-w-2xl gap-6">
    <PageHeader title={messages.createHeading} description={messages.createHelp} />
    <CreateWorkForm action={createWork} messages={messages} />
  </PageContainer>;
}
