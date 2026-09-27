import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { signInPath } from '../../../features/auth/paths.ts';
import { readSession } from '../../../features/auth/session.ts';
import { PageContainer, PageHeader } from '../../../features/shell/page.tsx';
import { createWork } from '../../../features/studio/actions.ts';
import { CreateWorkForm } from '../../../features/studio/create-work-form.tsx';
import { getMessages, getTranslation, requestLocale } from '../../../i18n/server.ts';
import { localizedPath } from '../../../i18n/locale.ts';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getTranslation('studio', [await requestLocale()]);
  return { title: t.createHeading };
}

export default async function StudioPage() {
  const locale = await requestLocale();
  const session = await readSession();
  if (!session) redirect(signInPath(localizedPath('/studio', locale)));
  if (session.agent.status !== 'selected') redirect(`${localizedPath('/identity', locale)}?next=${encodeURIComponent(localizedPath('/studio', locale))}`);
  const messages = await getMessages('studio', locale);
  return <PageContainer className="grid max-w-2xl gap-6">
    <PageHeader title={messages.createHeading} description={messages.createHelp} />
    <CreateWorkForm action={createWork} messages={messages} />
  </PageContainer>;
}
