import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { pageIds, pageSlug } from './src/pages.ts';
import { handleDynamic } from './worker/dynamic.ts';
import type { AboutEnv } from './worker/env.ts';

/**
 * Serves what the production Worker serves besides assets (locale negotiation
 * at `/`, `/api/notify`) from the Astro dev server, with the Worker's D1
 * binding emulated by Wrangler and persisted in `.wrangler/state`. Apply the
 * migrations first with `task about:dev`.
 */
export function aboutDevServer(): Plugin {
  let env: Promise<AboutEnv> | undefined;
  // Wrangler is imported natively: this file is loaded by Vite's module runner, which is closed
  // by the time a request arrives and would refuse a runner-transformed import().
  const nativeImport = new Function('specifier', 'return import(specifier)') as (
    specifier: string,
  ) => Promise<typeof import('wrangler')>;
  const bindings = () =>
    (env ??= nativeImport('wrangler').then(async ({ getPlatformProxy }) => {
      const proxy = await getPlatformProxy<{ DB: AboutEnv['DB'] }>({
        configPath: new URL('./wrangler.jsonc', import.meta.url).pathname,
      });
      return {
        DB: proxy.env.DB,
        ASSETS: { fetch: () => Promise.resolve(new Response(null, { status: 404 })) },
      };
    }));
  return {
    name: 'rezics:about-dev-server',
    apply: 'serve',
    configureServer(server) {
      const answer = async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
        const path = (req.url ?? '/').split('?')[0]!;
        if (path !== '/' && !path.startsWith('/api/') && !unprefixedPage.test(path)) return false;
        const response = await handleDynamic(await toRequest(req), await bindings());
        if (!response) return false;
        res.statusCode = response.status;
        response.headers.forEach((value, key) => res.setHeader(key, value));
        res.end(Buffer.from(await response.arrayBuffer()));
        return true;
      };
      server.middlewares.use((req, res, next) => {
        answer(req, res).then((handled) => {
          if (!handled) next();
        }, next);
      });
    },
  };
}

const unprefixedPage = new RegExp(
  `^/(${pageIds
    .filter((id) => id !== 'home')
    .map(pageSlug)
    .join('|')})/?$`,
);

async function toRequest(req: IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers))
    if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  const method = req.method ?? 'GET';
  const body = method === 'GET' || method === 'HEAD' ? undefined : Buffer.concat(chunks);
  return new Request(`http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`, {
    method,
    headers,
    body,
  });
}
