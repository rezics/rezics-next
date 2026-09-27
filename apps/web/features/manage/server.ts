import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { localizedPath } from '../../i18n/locale.ts';
import type { UiLocale } from '../../i18n/define.ts';
import { mainApiWithToken } from '../api/main.ts';
import { ACCESS_COOKIE } from '../auth/cookies.ts';
import { signInPath } from '../auth/paths.ts';
import { readSession } from '../auth/session.ts';
import { parseRemembered, REMEMBERED_COOKIE } from './remembered.ts';

/**
 * Who manages. Management always acts as the session Agent, shown in every
 * page's header; without a session or a chosen Agent the page asks for one
 * first. Public reads (Realm names, profiles) go anonymously.
 */
export async function manager(locale: UiLocale, path: string) {
  const next = localizedPath(path, locale);
  const session = await readSession();
  if (!session) redirect(signInPath(next));
  if (session.agent.status !== 'selected') redirect(`${localizedPath('/identity', locale)}?next=${encodeURIComponent(next)}`);
  const token = (await cookies()).get(ACCESS_COOKIE)?.value;
  return { agent: session.agent.agent, actingSubject: session.agent.agent.iri, main: mainApiWithToken(token),
    anonymous: mainApiWithToken(undefined), signInHref: signInPath(next) };
}

export async function rememberedRealms(): Promise<string[]> {
  return parseRemembered((await cookies()).get(REMEMBERED_COOKIE)?.value);
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isRealmSegment = (value: string) => uuid.test(value);
