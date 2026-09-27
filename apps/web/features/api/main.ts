import { treaty } from '@elysia/eden';
import type { MainApp } from '@rezics/main/app';
import { cookies } from 'next/headers';
import { ACCESS_COOKIE } from '../auth/cookies.ts';
import { serviceOrigin } from './origins.ts';

/** Eden client for Main acting with an explicit bearer token, or anonymously. */
export function mainApiWithToken(accessToken: string | undefined) {
  return treaty<MainApp>(serviceOrigin('MAIN_ORIGIN'), {
    headers: accessToken ? { authorization: `Bearer ${accessToken}` } : undefined,
    fetch: { cache: 'no-store' },
  });
}

/** Server-side Eden client for Main with the session's bearer token, for
 * Server Components, Server Actions and route handlers. `proxy.ts` has already
 * refreshed the token for this request, so callers never handle refresh. */
export async function mainApi() {
  return mainApiWithToken((await cookies()).get(ACCESS_COOKIE)?.value);
}
