import { redirect } from 'next/navigation';
import { signInPath } from '../../../features/auth/paths.ts';
import { readSession } from '../../../features/auth/session.ts';
import { profileHref } from '../../../features/profile/route.ts';
import { localizedPath } from '../../../i18n/locale.ts';
import { requestLocale } from '../../../i18n/server.ts';

/**
 * Library, until it has a page of its own: the reader's shelves on their
 * profile (reading, read, want to read), which already exist. Signed out it
 * asks for sign-in first; without a chosen Agent, which Agent's shelves.
 */
export default async function LibraryRoute() {
  const locale = await requestLocale();
  const here = localizedPath('/library', locale);
  const session = await readSession();
  if (!session) redirect(signInPath(here));
  if (session.agent.status !== 'selected') redirect(`${localizedPath('/identity', locale)}?next=${encodeURIComponent(here)}`);
  const { handle, iri } = session.agent.agent;
  redirect(`${localizedPath(profileHref(handle ?? `agent-${iri.slice(-36)}`), locale)}#profile-shelves`);
}
