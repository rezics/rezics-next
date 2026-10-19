import handler from 'vinext/server/fetch-handler';
import { addressFailureResponse, beforePathNormalization } from '../features/address/edge.ts';
import { addressPath } from '../features/address/path.ts';
import { isZonePage } from '../features/zones/csp.ts';
import { pathLocale, resolveLocale } from '../i18n/locale.ts';
import { serverDocumentResponse, withServerRequest } from '../features/api/server-read.ts';

export default {
  async fetch(request: Request, env: Parameters<typeof handler.fetch>[1],
    context: Parameters<typeof handler.fetch>[2]): Promise<Response> {
    return withServerRequest(request, async () => {
      const redirected = await beforePathNormalization(request, (env as { MAIN_ORIGIN?: string }).MAIN_ORIGIN);
      if (redirected) return redirected;
      const response = await handler.fetch(request, env, context);
      const url = new URL(request.url);
      if (addressPath(url.pathname)?.lookup.scope !== 'resource' && !isZonePage(url.pathname)) return response;
      try { return await serverDocumentResponse(request, response); }
      catch {
        return addressFailureResponse(url,
          pathLocale(url.pathname) ?? resolveLocale(undefined, request.headers.get('accept-language')), 503);
      }
    });
  },
};
