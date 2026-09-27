// The OAuth provider sends /sign-in and /consent a signed copy of the pending
// /oauth2/authorize request. Posting it back as `oauth_query` lets Better Auth
// resume that request after sign-in, sign-up or consent. This mirrors the
// pinned provider's client plugin (@better-auth/oauth-provider 1.7.5): keep
// `sig`, `ba_param` and exactly the parameters `ba_param` names, so extra ones
// such as `hl` never break the signature.
const signedNames = 'ba_param';

export function signedOAuthQuery(search: string): string | undefined {
  const params = new URLSearchParams(search);
  const names = new Set(params.getAll(signedNames));
  if (!params.has('sig') || !names.size) return undefined;
  const signed = new URLSearchParams();
  for (const [key, value] of params) {
    if (key === 'sig' || key === signedNames || names.has(key)) signed.append(key, value);
  }
  return signed.toString();
}

/** The parameters of a pending authorization request, for display only. */
export function pendingAuthorization(search: string): { clientId: string; scopes: string[] } | undefined {
  const query = signedOAuthQuery(search);
  if (!query) return undefined;
  const params = new URLSearchParams(query);
  const clientId = params.get('client_id');
  if (!clientId) return undefined;
  return { clientId, scopes: (params.get('scope') ?? '').split(' ').filter(Boolean) };
}

/** A same-origin path to continue to after sign-in; anything else goes home. */
export function safeReturnPath(value: string | null | undefined): string {
  if (!value || !/^\/(?!\/)[^\\\r\n]*$/.test(value)) return '/';
  return value;
}
