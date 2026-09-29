import { handleDynamic } from './dynamic.ts';
import type { AboutEnv } from './env.ts';

/** Static assets serve the site; this Worker runs first only for the paths in wrangler.jsonc. */
export default {
  async fetch(request: Request, env: AboutEnv): Promise<Response> {
    return (await handleDynamic(request, env)) ?? env.ASSETS.fetch(request);
  },
};
