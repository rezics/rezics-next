import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { signInPath } from '../../../features/auth/paths.ts';
import { readSession } from '../../../features/auth/session.ts';
import { studioHref } from '../../../features/studio/agent.ts';
import { getTranslation, requestLocale } from '../../../i18n/server.ts';
import { localizedPath } from '../../../i18n/locale.ts';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getTranslation('studio', [await requestLocale()]);
  return { title: t.studio };
}

/** Studio opens as the session Agent; with none chosen, the person chooses one first. */
export default async function StudioPage() {
  const locale = await requestLocale();
  const session = await readSession();
  if (!session) redirect(signInPath(localizedPath('/studio', locale)));
  if (session.agent.status === 'selected') redirect(localizedPath(studioHref(session.agent.agent), locale));
  redirect(`${localizedPath('/identity', locale)}?next=${encodeURIComponent(localizedPath('/studio', locale))}`);
}
