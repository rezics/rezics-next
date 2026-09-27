import { safeReturnPath, signedOAuthQuery } from '../api/oauth-query.ts';

/** What an auth page needs from its query: the signed OAuth request, where to
 * return afterwards, and the query to carry between sign-in, sign-up and
 * recovery so neither is lost. */
export function authQuery(query: URLSearchParams) {
  const oauthQuery = signedOAuthQuery(query.toString());
  const next = safeReturnPath(query.get('next'));
  const carry = oauthQuery ?? (next === '/' ? '' : new URLSearchParams({ next }).toString());
  const prompts = new URLSearchParams(oauthQuery ?? '').get('prompt')?.split(' ') ?? [];
  return { oauthQuery, next, carry, wantsSignUp: prompts.includes('create') };
}

/** After a verified new person signs in, start the same PKCE authorization
 * without the one-time create prompt. Signed provider metadata belongs only to
 * the previous request and must be left behind. */
export function authorizationAfterCreate(oauthQuery: string | undefined): string | undefined {
  if (!oauthQuery) return undefined;
  const query = new URLSearchParams(oauthQuery);
  const prompts = (query.get('prompt') ?? '').split(' ').filter(Boolean);
  if (!prompts.includes('create')) return undefined;
  const remaining = prompts.filter(prompt => prompt !== 'create');
  if (remaining.length) query.set('prompt', remaining.join(' '));
  else query.delete('prompt');
  for (const field of ['sig', 'ba_param', 'ba_iat', 'exp']) query.delete(field);
  return `/api/auth/oauth2/authorize?${query}`;
}
