import type { AuthContext } from 'better-auth';
import { createCookieGetter } from 'better-auth/cookies';
import { createInternalContext, parseCookies, serializeSignedCookie } from 'better-call';

type AuthenticationCookie = 'session_token' | 'two_factor' | 'better-auth-passkey' | 'trust_device';
type CookieContext = Pick<AuthContext, 'createAuthCookie' | 'secret' | 'getPlugin' | 'options' | 'baseURL'>;

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
  const key = (cookie: AuthenticationCookie) => cookie === 'better-auth-passkey'
      ? passkey?.options?.advanced?.webAuthnChallengeCookie ?? 'better-auth-passkey'
      : cookie;
  const name = (cookie: AuthenticationCookie) => provider.createAuthCookie(key(cookie)).name;
  // Canonical selection always uses createAuthCookie above. Admission also
  // inventories credentials carried under either provider-derived security
  // variant: an inactive cookie cannot supply a second request subject.
  const variants = [false, true].map(useSecureCookies => createCookieGetter({ ...provider.options,
    baseURL: provider.baseURL, advanced: { ...provider.options.advanced, useSecureCookies } }));
  const context = await createInternalContext({ headers }, { options: { method: 'GET' } });
  const candidates = async (cookie: AuthenticationCookie) => {
    const names = new Set([name(cookie), ...variants.map(create => create(key(cookie)).name)]);
    const values = new Set<string>();
    for (const fragment of (headers.get('cookie') ?? '').split(';')) {
      const parsed = parseCookies(fragment);
      const reader = await createInternalContext({ headers: new Headers({ cookie: fragment }) },
        { options: { method: 'GET' } });
      for (const exact of names) {
        if (!parsed.has(exact)) continue;
        const value = await reader.getSignedCookie(exact, provider.secret);
        if (typeof value === 'string') values.add(value);
      }
    }
    return [...values];
  };
  return {
    name,
    signed: async (cookie: AuthenticationCookie): Promise<string | undefined> => {
      const value = await context.getSignedCookie(name(cookie), provider.secret);
      return typeof value === 'string' ? value : undefined;
    },
    /** Inventory repeated credentials without changing the provider's first
     * exact-name selection. Each fragment uses its public parser and verifier. */
    signedCandidates: candidates,
    candidateHeaders: async (cookie: AuthenticationCookie) => {
      const selections: { value: string; headers: Headers }[] = [];
      for (const value of await candidates(cookie)) {
        const selectedHeaders = new Headers(headers);
        // This value was verified by the provider's signed-cookie helper.
        // Re-present it under the active name to ask its session endpoint for
        // the credential's live subject; never infer that user from the token.
        selectedHeaders.set('cookie', await serializeSignedCookie(name(cookie), value, provider.secret));
        selections.push({ value, headers: selectedHeaders });
      }
      return selections;
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
