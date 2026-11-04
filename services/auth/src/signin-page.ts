export type SignInPageViewer =
  | { kind: 'signed-out' }
  | { kind: 'signed-in'; account_id: string; email: string | null };

export type SignInPage = {
  methods: { password: true; passkey: true };
  viewer: SignInPageViewer;
  continuation: { href: string; requires_sign_in: boolean };
};

export const SIGN_IN_PAGE_QUERY_LIMIT_BYTES = 4096;
export const SIGN_IN_PAGE_RESPONSE_LIMIT_BYTES = 16384;

const methods = Object.freeze({ password: true as const, passkey: true as const });
const authorizationDrop = ['sig', 'exp', 'prompt', 'return_to'] as const;
const stepUpReturnPaths = ['/security', '/account/delete', '/organizations/new'] as const;
const defaultReturnPath = '/security';
const encoder = new TextEncoder();

/** A read-only projection: methods mirror installed native handlers, viewer comes
 * from the current native session, and the return target remains a local hint.
 */
export function signInPage(query: string, origin: string, viewer: SignInPageViewer): SignInPage | null {
  if (encoder.encode(query).byteLength > SIGN_IN_PAGE_QUERY_LIMIT_BYTES) return null;
  const parameters = new URLSearchParams(query);
  const returnTo = parameters.get('return_to');
  const requiresSignIn =
    parameters.getAll('prompt').some((value) => {
      const prompts = value.trim().split(/\s+/u);
      return prompts.includes('login') || prompts.includes('select_account');
    }) || parameters.getAll('max_age').includes('0');

  for (const name of authorizationDrop) parameters.delete(name);
  parameters.delete('account_operation');

  let href: string;
  if (parameters.size) {
    const target = new URL('/authorize', origin);
    target.search = parameters.toString();
    href = `${target.pathname}${target.search}`;
  } else if (returnTo?.startsWith('/consent?') && !returnTo.includes('#')) {
    const request = new URLSearchParams(returnTo.slice('/consent?'.length));
    const clientId = request.get('client_id');
    if (request.size === 2 && clientId && request.has('scope')) {
      href = `/consent?${new URLSearchParams({ client_id: clientId, scope: request.get('scope')! })}`;
    } else {
      href = localReturnPath(returnTo);
    }
  } else {
    href = localReturnPath(returnTo ?? '');
  }

  const page: SignInPage = {
    methods,
    viewer,
    continuation: { href, requires_sign_in: requiresSignIn },
  };
  return encoder.encode(JSON.stringify(page)).byteLength <= SIGN_IN_PAGE_RESPONSE_LIMIT_BYTES ? page : null;
}

function localReturnPath(returnTo: string): string {
  return stepUpReturnPaths.find((path) => path === returnTo) ?? defaultReturnPath;
}
