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
    triggers: [
      ...pageRoutes.map((path) => ({ type: 'fetch' as const, pattern: 'auth.rezics.com' + path })),
      { type: 'fetch' as const, pattern: 'auth.rezics.com/auth-assets/*' },
    ],
  },
};
