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
