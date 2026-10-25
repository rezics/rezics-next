/** Vite's build-time marker is replaced with the request nonce in development only. */
export const viteNonceMarker = '__REZICS_VITE_NONCE__';

// Puck 0.23's drag overlay and srcdoc preview styles, plus dnd-kit's root style, have no nonce hook.
const inlineStyleExceptionPaths = [
  '/en/curate/presentation',
  '/zh-Hant/curate/presentation',
  '/zh-Hans/curate/presentation',
  '/ja/curate/presentation',
  '/ko/curate/presentation',
  '/de/curate/presentation',
  '/fr/curate/presentation',
  '/es/curate/presentation',
] as const;

function allowsInlineStyles(pathname: string): boolean {
  return inlineStyleExceptionPaths.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

export function securityHeaders(request: Request, nonce: string, issuer: string, development = false): Headers {
  const url = new URL(request.url);
  const websocket = new URL(url.origin);
  websocket.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const authOrigin = issuer ? ` ${new URL(issuer).origin}` : '';
  const styleSource = allowsInlineStyles(url.pathname)
    ? "style-src 'self' 'unsafe-inline'"
    : `style-src 'self' 'nonce-${nonce}'`;
  const policy = [
    "default-src 'self'",
    `script-src 'nonce-${nonce}' 'strict-dynamic' https://challenges.cloudflare.com`,
    styleSource,
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' blob: data:",
    `connect-src 'self'${development ? ` ${websocket.origin}` : ''}`,
    'frame-src https://challenges.cloudflare.com',
    `form-action 'self'${authOrigin}`,
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    'upgrade-insecure-requests',
  ].join('; ');
  const headers = new Headers({
    'content-security-policy': policy,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'cross-origin-opener-policy': 'same-origin',
  });
  if (url.protocol === 'https:') headers.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
  return headers;
}
