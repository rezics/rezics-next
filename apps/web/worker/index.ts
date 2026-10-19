import handler from 'vinext/server/fetch-handler';
import { addressFailureResponse, beforePathNormalization } from '../features/address/edge.ts';
import { addressPath } from '../features/address/path.ts';
import { pathLocale, resolveLocale } from '../i18n/locale.ts';
import { serverDocumentResponse, withServerRequest, serverReadObservation, serverReadObservationError } from '../features/api/server-read.ts';

export default {
  async fetch(request: Request, env: Parameters<typeof handler.fetch>[1],
    context: Parameters<typeof handler.fetch>[2]): Promise<Response> {
    return withServerRequest(request, async () => {
      const startedAt = Date.now();
      serverReadObservation('worker-ingress', { method: request.method, path: new URL(request.url).pathname });
      const redirected = await beforePathNormalization(request, (env as { MAIN_ORIGIN?: string }).MAIN_ORIGIN);
      serverReadObservation('address-admission-result', { redirectedStatus: redirected?.status ?? null, elapsedMs: Date.now() - startedAt });
      if (redirected) return redirected;
      const response = await (async () => {
      try {
        const response = await handler.fetch(request, env, context);
        serverReadObservation('handler-headers', { status: response.status, contentType: response.headers.get('content-type'), cacheControl: response.headers.get('cache-control'), retryAfter: response.headers.get('retry-after'), elapsedMs: Date.now() - startedAt });
        return response;
      } catch (error) {
        serverReadObservation('handler-error', { elapsedMs: Date.now() - startedAt, error: serverReadObservationError(error) });
        throw error;
      }
      })();
      const url = new URL(request.url);
      if (addressPath(url.pathname)?.lookup.scope !== 'resource') return response;
      try { return await serverDocumentResponse(request, response); }
      catch (error) {
        serverReadObservation('worker-document-fallback', { elapsedMs: Date.now() - startedAt, error: serverReadObservationError(error) });
        return addressFailureResponse(url,
          pathLocale(url.pathname) ?? resolveLocale(undefined, request.headers.get('accept-language')), 503);
      }
    });
  },
};
