import { env } from 'cloudflare:workers';
import worker from '../../src/server.ts';
import { exportSitemaps, sitemapR2Store } from '../../src/sitemap/export.ts';
import { sitemapFeeds } from '../../src/sitemap/feeds.ts';
import type { SitemapEnv } from '../../src/sitemap/serve.ts';

export { SessionStore, SitemapExport } from '../../src/server.ts';

type FixtureEnv = Partial<
  SitemapEnv & { KERNEL_ORIGIN: string; PUBLIC_ORIGIN: string; NATIVE_WEB_SITEMAP_EXPORT_TOKEN: string }
>;

const sitemapExportPath = '/_native/sitemap-export';
const headers = { 'cache-control': 'no-store' };

export default {
  ...worker,
  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== sitemapExportPath) return worker.fetch(request);
    const {
      NATIVE_WEB_SITEMAP_EXPORT_TOKEN: token,
      KERNEL_ORIGIN: kernel,
      PUBLIC_ORIGIN: origin,
      SITEMAPS: bucket,
    } = env as FixtureEnv;
    if (!token || request.headers.get('x-native-sitemap-export-key') !== token)
      return new Response(null, { status: 404, headers });
    if (request.method !== 'POST') return new Response(null, { status: 405, headers: { ...headers, allow: 'POST' } });
    if (!kernel || !origin || !bucket)
      return new Response('Native sitemap export bindings are unavailable', { status: 503, headers });

    try {
      await exportSitemaps({
        runId: `native-${crypto.randomUUID()}`,
        origin,
        store: sitemapR2Store(bucket),
        runner: { do: (_name, run) => run() },
        feeds: sitemapFeeds(),
      });
      return new Response(null, { status: 204, headers });
    } catch (error) {
      return new Response(error instanceof Error ? error.message : String(error), { status: 503, headers });
    }
  },
};
