export default {
  worker: {
    name: 'rezics-web',
    entrypoint: './src/server.ts',
    compatibilityDate: '2026-10-25',
    env: {
      MEDIA: { type: 'r2', name: 'rezics-media', dev: { remote: false } },
      KERNEL_ORIGIN: { type: 'text', value: process.env.KERNEL_ORIGIN ?? '' },
    },
  },
};
