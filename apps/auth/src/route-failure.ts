export type RouteRetryState = 'ready' | 'pending' | 'failed';

export const authUiPagePaths = new Set([
  '/',
  '/login',
  '/signup',
  '/consent',
  '/recovery',
  '/security',
  '/step-up',
  '/account/delete',
  '/account/rename',
  '/organizations/new',
  '/automated/new',
  '/automated/open',
  '/organizations/delete',
  '/organizations/members',
  '/operators/transfer',
]);

export const authAssetPrefix = '/auth-assets/';

export type AuthRequestClass =
  | 'server-function'
  | 'ui-page'
  | 'asset'
  | 'native'
  | 'upstream'
  | 'browser-document'
  | 'other';

const nativePaths = new Set([
  '/.well-known',
  '/authorize',
  '/jwks',
  '/logout',
  '/logout/confirm',
  '/revoke',
  '/token',
  '/userinfo',
  '/introspect',
  '/signin',
  '/signin/page',
  '/signin/key',
  '/signin/passkey/options',
  '/signin/passkey',
  '/registration-page',
  '/sessions/revoke',
  '/passkeys/register/options',
  '/passkeys/register',
  '/_serverFn',
  '/api',
  '/oauth2',
]);

const nativePrefixes = [
  '/.well-known/',
  '/authorize/',
  '/logout/',
  '/signin/',
  '/sessions/',
  '/passkeys/',
  '/api/',
  '/oauth2/',
];

export function classifyAuthRequest(request: Request, pathname: string): AuthRequestClass {
  if (pathname.startsWith('/_serverFn/')) return 'server-function';
  if (pathname.startsWith(authAssetPrefix)) return 'asset';
  if (authUiPagePaths.has(pathname))
    return request.method === 'GET' || request.method === 'HEAD' ? 'ui-page' : 'upstream';
  if (nativePaths.has(pathname) || nativePrefixes.some((prefix) => pathname.startsWith(prefix))) return 'native';
  if (isBrowserDocumentRequest(request)) return 'browser-document';
  return 'other';
}

function isBrowserDocumentRequest(request: Request): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  const accept = request.headers.get('accept')?.toLowerCase() ?? '';
  const acceptsHtml = accept.split(',').some((value) => value.trim().split(';', 1)[0] === 'text/html');
  return (
    acceptsHtml &&
    request.headers.get('sec-fetch-mode') === 'navigate' &&
    request.headers.get('sec-fetch-dest') === 'document'
  );
}
