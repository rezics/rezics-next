import { websiteWorkerScopes } from './scripts/website-configuration.ts';
import { releaseWebOutput } from './scripts/bundled-web-startup.ts';

const releaseOutput = releaseWebOutput(process.env);
const stagedRelease = releaseOutput && releaseOutput === process.env.NATIVE_WEB_PREVIEW_ROOT;
// Cloudflare preview takes secret binding values from the local environment at startup.
// The release fixtures allocate their endpoints and credentials after the production bundle has been emitted.
const fixtureBinding = (value: string) =>
  stagedRelease ? ({ type: 'secret' } as const) : ({ type: 'text', value } as const);

const nativeSitemapExportToken =
  process.env.REZICS_TEST_RUNTIME === '1' && process.env.WEB_TEST_STATE_INSTANCE_DIR
    ? process.env.NATIVE_WEB_SITEMAP_EXPORT_TOKEN
    : undefined;

export default {
  worker: {
    name: 'rezics-web',
    entrypoint: nativeSitemapExportToken ? './tests/native/sitemap-export-worker.ts' : './src/server.ts',
    compatibilityDate: '2026-10-25',
    triggers: [{ type: 'scheduled', schedule: '0 3 * * *' }],
    // Declaring the class with SQLite storage provisions its initial migration.
    exports: { SessionStore: { type: 'durable-object', storage: 'sqlite' } },
    env: {
      SESSIONS: { type: 'durable-object', worker: 'rezics-web', exportName: 'SessionStore' },
      AUTH_ISSUER: fixtureBinding(process.env.AUTH_ISSUER ?? ''),
      ...(process.env.AUTH_TEST_LOOPBACK_ORIGIN
        ? { AUTH_TEST_LOOPBACK_ORIGIN: { type: 'text', value: process.env.AUTH_TEST_LOOPBACK_ORIGIN } }
        : {}),
      ...(nativeSitemapExportToken
        ? { NATIVE_WEB_SITEMAP_EXPORT_TOKEN: { type: 'text', value: nativeSitemapExportToken } }
        : {}),
      BUILD_ID: { type: 'text', value: process.env.BUILD_ID ?? process.env.GITHUB_SHA ?? 'development' },
      PUBLIC_ORIGIN: fixtureBinding(process.env.PUBLIC_ORIGIN ?? ''),
      SITE_ORIGINS: fixtureBinding(process.env.SITE_ORIGINS ?? ''),
      API_RESOURCE: fixtureBinding(process.env.API_RESOURCE ?? ''),
      WEBSITE_SCOPES: stagedRelease ? { type: 'secret' } : { type: 'text', value: websiteWorkerScopes(process.env) },
      WEBSITE_CLIENT_ID: fixtureBinding(process.env.WEBSITE_CLIENT_ID ?? ''),
      NATIVE_MEDIA_STORAGE_TOKEN: fixtureBinding(
        process.env.WEB_TEST_STATE_DIR ? (process.env.NATIVE_MEDIA_STORAGE_TOKEN ?? '') : '',
      ),
      WEBSITE_CLIENT_KEY: { type: 'secret' },
      READS_10S: { type: 'rate-limit', namespace: '1001', simple: { limit: 100, period: 10 } },
      READS_60S: { type: 'rate-limit', namespace: '1002', simple: { limit: 300, period: 60 } },
      ...(process.env.LOCAL_MEDIA_ORIGIN && process.env.LOCAL_MEDIA_TOKEN
        ? {
            LOCAL_MEDIA_ORIGIN: { type: 'text', value: process.env.LOCAL_MEDIA_ORIGIN },
            LOCAL_MEDIA_TOKEN: { type: 'secret' },
          }
        : { MEDIA: { type: 'r2', name: 'rezics-media', dev: { remote: false } } }),
      SITEMAPS: { type: 'r2', name: 'rezics-sitemaps', dev: { remote: false } },
      SITEMAP_EXPORT: {
        type: 'workflow',
        name: 'rezics-web-sitemaps',
        worker: 'rezics-web',
        exportName: 'SitemapExport',
      },
      KERNEL_ORIGIN: fixtureBinding(process.env.KERNEL_ORIGIN ?? ''),
      TURNSTILE_SITE_KEY: { type: 'text', value: process.env.TURNSTILE_SITE_KEY ?? '' },
      TURNSTILE_SCRIPT_URL: { type: 'text', value: process.env.TURNSTILE_SCRIPT_URL ?? '' },
    },
  },
};
