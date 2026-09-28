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
export function safeReturnPath(value: string | null | undefined, fallback = '/'): string {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return fallback;
  // WHATWG URL parsing strips tabs/newlines and treats backslashes as slashes.
  // Reject them before parsing, including escaped forms received via cookies
  // or nested query strings. Never turn a rejected input into a different URL.
  if (/[\u0000-\u001f\u007f-\u009f\\]/u.test(value)
    || /%(?:0[0-9a-f]|1[0-9a-f]|7f|5c)|%c2%[89][0-9a-f]/i.test(value)) return fallback;
  const origin = 'https://return-path.invalid';
  try {
    const url = new URL(value, origin);
    const path = `${url.pathname}${url.search}${url.hash}`;
    // Dot-segment normalization can expose a leading double slash, which
    // would become a network-relative reference when the caller resolves it.
    if (url.origin !== origin || path.startsWith('//')) return fallback;
    return path;
  } catch { return fallback; }
}
