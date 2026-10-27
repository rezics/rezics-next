export default {
  worker: {
    name: 'rezics-web',
    entrypoint: './src/server.ts',
    compatibilityDate: '2026-10-25',
    // Declaring the class with SQLite storage provisions its initial migration.
    exports: { SessionStore: { type: 'durable-object', storage: 'sqlite' } },
    env: {
      SESSIONS: { type: 'durable-object', worker: 'rezics-web', exportName: 'SessionStore' },
      AUTH_ISSUER: { type: 'text', value: process.env.AUTH_ISSUER ?? '' },
      PUBLIC_ORIGIN: { type: 'text', value: process.env.PUBLIC_ORIGIN ?? '' },
      SITE_ORIGINS: { type: 'text', value: process.env.SITE_ORIGINS ?? '' },
      API_RESOURCE: { type: 'text', value: process.env.API_RESOURCE ?? '' },
      WEBSITE_SCOPES: { type: 'text', value: process.env.WEBSITE_SCOPES ?? '' },
      WEBSITE_CLIENT_ID: { type: 'text', value: process.env.WEBSITE_CLIENT_ID ?? '' },
      WEBSITE_CLIENT_KEY: { type: 'secret' },
      READS_10S: { type: 'rate-limit', namespace: '1001', simple: { limit: 100, period: 10 } },
      READS_60S: { type: 'rate-limit', namespace: '1002', simple: { limit: 300, period: 60 } },
      MEDIA: { type: 'r2', name: 'rezics-media', dev: { remote: false } },
      SITEMAPS: { type: 'r2', name: 'rezics-sitemaps', dev: { remote: false } },
      KERNEL_ORIGIN: { type: 'text', value: process.env.KERNEL_ORIGIN ?? '' },
      TURNSTILE_SITE_KEY: { type: 'text', value: process.env.TURNSTILE_SITE_KEY ?? '' },
      TURNSTILE_SCRIPT_URL: { type: 'text', value: process.env.TURNSTILE_SCRIPT_URL ?? '' },
    },
  },
};
