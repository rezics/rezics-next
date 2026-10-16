import { readAddress } from '../address/client.ts';
import { readSpacePage } from '../address/space-read.ts';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import type { RealmReadClient } from '../realm/read.ts';

const origin = 'https://recorded.invalid';

/** The production frame's existing public/address/private readers with a supplied transport. */
export function rulesPageClient(fetcher: typeof fetch, actingSubject?: string): RealmReadClient {
  return {
    main: browserMainApi(origin, { anonymous: true, fetcher }),
    personal: browserMainApi(origin, { anonymous: !actingSubject, fetcher }),
    signedIn: Boolean(actingSubject), actingSubject, fetch: fetcher,
    resolution: {
      resolveAddress: (scope, key, locale) => readAddress({ scope, key }, locale, origin,
        new Headers(), undefined, true, fetcher),
      readPrivateRealm: (ref, locale, address) => readSpacePage(ref, locale, {
        address, origin, ...(actingSubject ? { token: 'recorded', actingSubject } : {}),
        read: (path, personal) => fetcher(`${origin}${BFF_PREFIX}${path}`, {
          credentials: personal ? 'same-origin' : 'omit',
          headers: { 'accept-language': locale, 'x-rezics-display-languages': locale },
        }),
      }),
    },
  };
}

