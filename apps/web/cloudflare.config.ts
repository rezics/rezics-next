export default {
  worker: {
    name: 'rezics-web',
    entrypoint: './src/server.ts',
    compatibilityDate: '2026-10-25',
    env: {
      MEDIA: { type: 'r2', name: 'rezics-media', dev: { remote: false } },
      KERNEL_ORIGIN: { type: 'text', value: process.env.KERNEL_ORIGIN ?? '' },
      AUTH_ISSUER: { type: 'text', value: process.env.AUTH_ISSUER ?? '' },
      MEDIA_CLIENT_ID: { type: 'text', value: process.env.MEDIA_CLIENT_ID ?? '' },
      // Only the declaration is built. The value is supplied locally by the plugin
      // from the dev environment, and in production by a Worker secret.
      MEDIA_CLIENT_KEY: { type: 'secret' },
    },
  },
};
