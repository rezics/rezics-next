const pageRoutes = ['/login', '/signup', '/consent', '/recovery', '/security', '/step-up'];

export default {
  worker: {
    name: 'rezics-auth-pages',
    entrypoint: './src/server.ts',
    compatibilityDate: '2026-10-26',
    assets: {
      basePath: '/auth-assets',
      notFoundHandling: 'none',
    },
    env: {
      PRIVACY_CONTACT_URL: { type: 'text', value: process.env.PRIVACY_CONTACT_URL ?? '' },
      TURNSTILE_SITE_KEY: { type: 'text', value: process.env.TURNSTILE_SITE_KEY ?? '' },
      // Development can point the widget at a local script. Production ignores this value.
      TURNSTILE_SCRIPT_URL: { type: 'text', value: process.env.TURNSTILE_SCRIPT_URL ?? '' },
    },
    triggers: [
      ...pageRoutes.map((path) => ({ type: 'fetch' as const, pattern: 'auth.rezics.com' + path })),
      { type: 'fetch' as const, pattern: 'auth.rezics.com/auth-assets/*' },
    ],
  },
};
