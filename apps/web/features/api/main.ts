import { treaty } from '@elysia/eden';
import type { MainApp } from '@rezics/main/app';
import { cookies, headers } from 'next/headers';
import { cache } from 'react';
import { ACCESS_COOKIE, SESSION_KEY_COOKIE } from '../auth/cookies.ts';
import { CONTENT_LANGUAGES_COOKIE, displayLanguageHeaders } from '../../i18n/display-languages.ts';
import { serviceOrigin } from './origins.ts';
import { mainReadHeaders } from './main-read.ts';
import { serverRead } from './server-read.ts';
import { SERVER_READ_LIMITS } from './server-fetch.ts';
import { mainBodyRead } from './main-read-operation.ts';

const profileContentLanguages = cache(
  async (token: string, sessionKey: string): Promise<string[]> => {
    if (!sessionKey) return [];
    try {
      const origin = serviceOrigin('MAIN_ORIGIN');
      const session = await serverRead(
        `${origin}/v1/me/session-agent`,
        {
          headers: await mainReadHeaders({
            authorization: `Bearer ${token}`,
            'x-session-key': sessionKey,
          }),
          cache: 'no-store',
        },
        { timeoutMs: SERVER_READ_LIMITS.metadata },
      );
      if (!session.ok) return [];
      const state = (await session.json()) as {
        sessionAgent?: { actingSubject?: string; eligible?: boolean };
      };
      const actor = state.sessionAgent?.eligible ? state.sessionAgent.actingSubject : null;
      if (!actor) return [];
      const preferences = await serverRead(
        `${origin}/v1/me/person-preferences?actingSubject=${encodeURIComponent(actor)}`,
        { headers: await mainReadHeaders({ authorization: `Bearer ${token}` }), cache: 'no-store' },
        { timeoutMs: SERVER_READ_LIMITS.metadata },
      );
      if (!preferences.ok) return [];
      const value = (await preferences.json()) as { contentLanguages?: unknown };
      return Array.isArray(value.contentLanguages)
        ? value.contentLanguages.filter(
            (language): language is string => typeof language === 'string',
          )
        : [];
    } catch {
      return [];
    }
  },
);

/**
 * Eden client for Main acting with an explicit bearer token, or anonymously. Without a token the request's
 * session is not consulted: no private language preference is read, so a render meant for anonymous readers
 * and crawlers is the anonymous representation.
 */
export function mainApiWithToken(accessToken: string | undefined) {
  return treaty<MainApp>(serviceOrigin('MAIN_ORIGIN'), {
    headers: async (_path: string) => {
      const result: Record<string, string> = {};
      if (accessToken) result.authorization = `Bearer ${accessToken}`;
      try {
        const [jar, incoming] = await Promise.all([cookies(), headers()]);
        Object.assign(result, Object.fromEntries(await mainReadHeaders(undefined, incoming)));
        const signedIn = Boolean(accessToken);
        const profile = accessToken
          ? await profileContentLanguages(accessToken, jar.get(SESSION_KEY_COOKIE)?.value ?? '')
          : null;
        Object.assign(
          result,
          displayLanguageHeaders({
            signedIn,
            profile,
            cookie: jar.get(CONTENT_LANGUAGES_COOKIE)?.value,
            pageUrl: incoming.get('x-rezics-page-url'),
            browser: incoming.get('accept-language'),
          }),
        );
      } catch {
        /* API clients also run outside a page request. */
      }
      return result;
    },
    fetch: { cache: 'no-store' },
    fetcher: ((input, init) =>
      serverRead(input, init, {
        idempotentRead: mainBodyRead(
          new URL(input instanceof Request ? input.url : String(input)).pathname,
          init?.method,
        ),
      })) as typeof fetch,
  });
}

/** Server-side Eden client for Main with the session's bearer token, for
 * Server Components, Server Actions and route handlers. `proxy.ts` has already
 * refreshed the token for this request, so callers never handle refresh. */
export async function mainApi() {
  return mainApiWithToken((await cookies()).get(ACCESS_COOKIE)?.value);
}
