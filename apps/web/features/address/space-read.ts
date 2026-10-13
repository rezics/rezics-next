import type { Discovery } from '../manage/settings-api.ts';
import type { RealmHeader } from '../realm/types.ts';
import { serviceOrigin } from '../api/origins.ts';
import { mainReadHeaders } from '../api/main-read.ts';
import { serverRead, serverDeadline } from '../api/server-read.ts';
import type { ResolvedAddress } from './client.ts';
import { parseAddressSegment } from './path.ts';
import { type ClassifiedSpacePage, classifyRealmSpacePage, privateDiscovery } from './space-page.ts';

export { privateDiscovery };

export type SpacePage = ClassifiedSpacePage;

/** Main's limited landing read is the only exception to a denied header.
 * Legacy Realm identities remain usable until the address resolver admits
 * private Space identities and returns their capability mapping. */
export async function readSpacePage(
  key: string,
  languages: string,
  options: {
    address?: ResolvedAddress;
    token?: string;
    actingSubject?: string;
    origin?: string;
    incoming?: Headers;
    /** Story replay. Production omits this and keeps the request-cached server read. */
    read?: (path: string, personal?: boolean) => Promise<Response>;
  } = {},
): Promise<SpacePage> {
  const origin = options.origin ?? serviceOrigin('MAIN_ORIGIN');
  const headers = { 'accept-language': languages, 'x-rezics-display-languages': languages };
  const read = options.read ?? (async (path: string, personal = false) =>
    serverRead(
      `${origin}${path}`,
      {
        headers: await mainReadHeaders(
          {
            ...headers,
            ...(personal && options.token ? { authorization: `Bearer ${options.token}` } : {}),
          },
          options.incoming,
        ),
        redirect: 'manual',
        cache: 'no-store',
      },
      { deadlineAt: await serverDeadline(options.incoming) },
    ));
  try {
    let realm = options.address?.capabilities?.realm?.slice(-36);
    if (options.address && !realm) return { kind: 'missing' };
    if (!realm) {
      const parsed = parseAddressSegment(key);
      // The merged API has one alias resolver and no per-Realm handle lookup.
      // A denied alias cannot be mapped to a Realm through a second resolver.
      if (!parsed || parsed.kind === 'alias') return { kind: 'missing' };
      realm = parsed.id;
    }
    const query =
      options.token && options.actingSubject
        ? `?${new URLSearchParams({ actingSubject: options.actingSubject })}`
        : '';
    const header = await read(`/v1/realms/${realm}${query}`, Boolean(query));
    const headerBody = header.ok ? await header.json() : null;
    const denied = !header.ok && [401, 403, 404].includes(header.status);
    const landing = denied ? await read(`/v1/realms/${realm}/join-page`, false) : null;
    const landingBody = landing?.ok ? await landing.json() : null;
    return classifyRealmSpacePage(realm, { ok: header.ok, status: header.status, body: headerBody },
      landing ? { ok: landing.ok, status: landing.status, body: landingBody } : null);
  } catch {
    return { kind: 'unavailable' };
  }
}

export function realmDiscovery(
  header: Pick<RealmHeader, 'visibility' | 'listing' | 'discovery'>,
): Discovery | null {
  return header.visibility === 'private' || header.listing === 'unlisted'
    ? privateDiscovery(header.discovery)
    : (header.discovery ?? null);
}
