import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import { localizedPath } from '../../i18n/locale.ts';
import type { UiLocale } from '../../i18n/define.ts';
import { mainApiWithToken } from '../api/main.ts';
import { ACCESS_COOKIE } from '../auth/cookies.ts';
import { signInPath } from '../auth/paths.ts';
import { readSession } from '../auth/session.ts';
import { readManagedRealms, readRealmHeader, settle } from './read.ts';
import { isUuid, type MainClient, uuidOf } from './types.ts';

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

/**
 * A Realm as Manage addresses it: `id` for Main's reads and commands, and
 * `address`, the segment its links keep using. `/manage/r/fiction` works as
 * `/r/fiction` does: an official Zone's route segment names its Realm.
 */
export interface ManagedAddress { id: string; address: string }

// Main's official route segment (`services/main/src/routes/zones.ts`).
const segment = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The Realm behind `/manage/r/{ref}`, or null when nothing has that address. Shared by a request's layout and page. */
export const managedAddress = cache(async (ref: string): Promise<ManagedAddress | null> => {
  if (isUuid(ref)) return { id: ref, address: ref };
  if (ref.length > 64 || !segment.test(ref)) return null;
  const zone = await settle(() => mainApiWithToken(undefined).v1.zones['by-segment']({ segment: ref }).get());
  if (!zone.ok) {
    if (zone.failure === 'missing') return null;
    throw new Error(`Official Zone ${ref} could not be resolved`);
  }
  const id = uuidOf(zone.data.realm);
  return isUuid(id) ? { id, address: ref } : null;
});

/** Main answers at most this many managed-Realm pages for one page render. */
const MANAGED_PAGES = 5;

/**
 * The permissions the acting Agent holds in one Realm, as Main lists them for
 * its managed Realms, or null when Main could not say (the page then offers
 * every choice and Main refuses what the Agent may not do).
 */
export async function permissionsIn(main: MainClient, actingSubject: string, realm: string):
  Promise<readonly string[] | null> {
  let after: string | null = null;
  for (let page = 0; page < MANAGED_PAGES; page++) {
    const read = await readManagedRealms(main, actingSubject, after);
    if (!read.ok) return null;
    const found = read.data.items.find(item => uuidOf(item.realm) === realm);
    if (found) return found.permissions;
    if (!read.data.nextCursor) return [];
    after = read.data.nextCursor;
  }
  return null;
}

/**
 * A Realm's public header in one language, read once per request: the
 * layout names the Realm with it, and the queue cites its published rules.
 */
export const realmHeader = cache((realm: string, language: string) =>
  readRealmHeader(mainApiWithToken(undefined), realm, language));
