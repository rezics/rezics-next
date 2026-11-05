const pageRoutes = [
  '/login',
  '/signup',
  '/consent',
  '/recovery',
  '/security',
  '/step-up',
  '/account/delete',
  '/organizations/new',
  '/automated/new',
  '/automated/open',
  '/organizations/delete',
  '/account/rename',
  '/organizations/members',
  '/operators/transfer',
];

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
      KERNEL_ORIGIN: { type: 'text', value: process.env.KERNEL_ORIGIN ?? '' },
      AUTH_SECURITY_SCOPE_CONFIGURATION: {
        type: 'text',
        value: process.env.AUTH_SECURITY_SCOPE_CONFIGURATION ?? '',
      },
      PRIVACY_CONTACT_URL: { type: 'text', value: process.env.PRIVACY_CONTACT_URL ?? '' },
      TURNSTILE_SITE_KEY: { type: 'text', value: process.env.TURNSTILE_SITE_KEY ?? '' },
      // Development can point the widget at a local script. Production ignores this value.
      TURNSTILE_SCRIPT_URL: { type: 'text', value: process.env.TURNSTILE_SCRIPT_URL ?? '' },
    },
    triggers: [
      ...pageRoutes.map((path) => ({ type: 'fetch' as const, pattern: 'auth.rezics.com' + path })),
      { type: 'fetch' as const, pattern: 'auth.rezics.com/_serverFn/*' },
      { type: 'fetch' as const, pattern: 'auth.rezics.com/auth-assets/*' },
    ],
  },
};
