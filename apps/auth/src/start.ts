import { createMiddleware, createStart } from '@tanstack/react-start';
import { securityHeaders, viteNonceMarker } from './security/headers.ts';
import { createNonce } from './security/nonce.ts';

// Only GET/HEAD page requests enter Start; assets and issuer traffic keep their own responses.
const pageSecurity = createMiddleware().server(async ({ request, next }) => {
  const nonce = createNonce(request);
  const result = await next();
  const headers = new Headers(result.response.headers);
  securityHeaders(request, nonce, import.meta.env.DEV).forEach((value, name) => headers.set(name, value));
  let response = new Response(result.response.body, {
    status: result.response.status,
    statusText: result.response.statusText,
    headers,
  });
  if (import.meta.env.DEV) {
    // Only Vite's explicitly marked assets are trusted; never bless unnonced content.
    response = new HTMLRewriter()
      .on('script, style, link, meta[property="csp-nonce"]', {
        element(element) {
          if (
            element.getAttribute('nonce') === viteNonceMarker ||
            (element.tagName === 'meta' && element.getAttribute('content') === nonce)
          )
            element.setAttribute('nonce', nonce);
        },
      })
      .transform(response);
  }
  return { ...result, response };
});

export const startInstance = createStart(() => ({ requestMiddleware: [pageSecurity] }));
