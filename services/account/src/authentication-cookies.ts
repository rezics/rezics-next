import type { BetterAuthOptions } from 'better-auth';
import { createCookieGetter } from 'better-auth/cookies';
import { createInternalContext, parseCookies } from 'better-call';

type AuthenticationCookie = 'session_token' | 'two_factor' | 'better-auth-passkey' | 'trust_device';
export type AuthenticationCookieOptions = Pick<
  BetterAuthOptions,
  'baseURL' | 'advanced' | 'secret'
>;

/** Use the provider's issuer name and actual signed-cookie reader. Its request
 * parser selects the first exact name; the cookies package's parser does not.
 * Transport URLs and a competing secure/plain cookie never select an owner. */
export async function authenticationCookies(
  headers: Headers,
  options: AuthenticationCookieOptions,
) {
  const name = createCookieGetter(options);
  const context = await createInternalContext({ headers }, { options: { method: 'GET' } });
  return {
    signed: async (cookie: AuthenticationCookie): Promise<string | undefined> => {
      if (!options.secret) return undefined;
      const value = await context.getSignedCookie(name(cookie).name, options.secret);
      return typeof value === 'string' ? value : undefined;
    },
    remove: (cookie: AuthenticationCookie) => {
      // Drop every occurrence of the selected name so an old duplicate cannot
      // become effective. Preserve other names with the same provider parser.
      const cookies = parseCookies(headers.get('cookie') ?? '');
      cookies.delete(name(cookie).name);
      headers.set(
        'cookie',
        [...cookies].map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('; '),
      );
    },
  };
}
