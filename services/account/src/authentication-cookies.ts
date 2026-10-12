import type { AuthContext } from 'better-auth';
import { createInternalContext, parseCookies } from 'better-call';

type AuthenticationCookie = 'session_token' | 'two_factor' | 'better-auth-passkey' | 'trust_device';
type CookieContext = Pick<AuthContext, 'createAuthCookie' | 'secret' | 'getPlugin'>;

/** Use the provider's issuer name and actual signed-cookie reader. Its request
 * parser selects the first exact name; the cookies package's parser does not.
 * Transport URLs and a competing secure/plain cookie never select an owner. */
export async function authenticationCookies(
  headers: Headers,
  provider: CookieContext,
) {
  const passkey = provider.getPlugin('passkey') as { options?: {
    advanced?: { webAuthnChallengeCookie?: string };
  } } | undefined;
  const name = (cookie: AuthenticationCookie) => provider.createAuthCookie(
    cookie === 'better-auth-passkey'
      ? passkey?.options?.advanced?.webAuthnChallengeCookie ?? 'better-auth-passkey'
      : cookie,
  ).name;
  const context = await createInternalContext({ headers }, { options: { method: 'GET' } });
  return {
    name,
    signed: async (cookie: AuthenticationCookie): Promise<string | undefined> => {
      const value = await context.getSignedCookie(name(cookie), provider.secret);
      return typeof value === 'string' ? value : undefined;
    },
    /** Inventory repeated credentials without changing the provider's first
     * exact-name selection. Each fragment uses its public parser and verifier. */
    signedCandidates: async (cookie: AuthenticationCookie): Promise<string[]> => {
      const values: string[] = [];
      for (const fragment of (headers.get('cookie') ?? '').split(';')) {
        if (!parseCookies(fragment).has(name(cookie))) continue;
        const reader = await createInternalContext({ headers: new Headers({ cookie: fragment }) },
          { options: { method: 'GET' } });
        const value = await reader.getSignedCookie(name(cookie), provider.secret);
        if (typeof value === 'string') values.push(value);
      }
      return [...new Set(values)];
    },
    candidateHeaders: async (cookie: AuthenticationCookie) => {
      const candidates: { value: string; headers: Headers }[] = [];
      for (const fragment of (headers.get('cookie') ?? '').split(';')) {
        if (!parseCookies(fragment).has(name(cookie))) continue;
        const selectedHeaders = new Headers(headers);
        selectedHeaders.set('cookie', fragment.trim());
        const reader = await createInternalContext({ headers: selectedHeaders }, { options: { method: 'GET' } });
        const value = await reader.getSignedCookie(name(cookie), provider.secret);
        if (typeof value === 'string') candidates.push({ value, headers: selectedHeaders });
      }
      return candidates;
    },
    remove: (cookie: AuthenticationCookie) => {
      // Drop every occurrence of the selected name so an old duplicate cannot
      // become effective. Preserve other names with the same provider parser.
      const cookies = parseCookies(headers.get('cookie') ?? '');
      cookies.delete(name(cookie));
      headers.set(
        'cookie',
        [...cookies].map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('; '),
      );
    },
  };
}
