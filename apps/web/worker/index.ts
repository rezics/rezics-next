import handler from 'vinext/server/fetch-handler';
import { beforePathNormalization } from '../features/address/edge.ts';
import { withServerRequest } from '../features/api/server-read.ts';

export default {
  async fetch(request: Request, env: Parameters<typeof handler.fetch>[1],
    context: Parameters<typeof handler.fetch>[2]): Promise<Response> {
    return withServerRequest(request, async () => {
      const redirected = await beforePathNormalization(request, (env as { MAIN_ORIGIN?: string }).MAIN_ORIGIN);
      return redirected ?? handler.fetch(request, env, context);
    });
  },
};
