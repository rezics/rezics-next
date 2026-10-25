/** Vite's build-time marker is replaced with the request nonce in development only. */
export const viteNonceMarker = '__REZICS_AUTH_VITE_NONCE__';

export function securityHeaders(request: Request, nonce: string, development = false): Headers {
  const url = new URL(request.url);
  const websocket = new URL(url.origin);
  websocket.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const policy = [
    "default-src 'self'",
    `script-src 'nonce-${nonce}' 'strict-dynamic' https://challenges.cloudflare.com`,
    `style-src 'self' 'nonce-${nonce}'`,
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data:",
    `connect-src 'self'${development ? ` ${websocket.origin}` : ''}`,
    'frame-src https://challenges.cloudflare.com',
    "form-action 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    'upgrade-insecure-requests',
  ].join('; ');
  const headers = new Headers({
    'content-security-policy': policy,
    'cache-control': 'private, no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'cross-origin-opener-policy': 'same-origin',
    'permissions-policy':
      'camera=(), microphone=(), geolocation=(), payment=(), usb=(), publickey-credentials-get=(self), publickey-credentials-create=(self)',
  });
  if (url.protocol === 'https:') headers.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
  return headers;
}
