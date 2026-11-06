import { mock } from 'bun:test';
import { fileURLToPath } from 'node:url';

const runtime = fileURLToPath(new URL('./cloudflare-workers-runtime.ts', import.meta.url));

Bun.plugin({
  name: 'cloudflare-workers-test',
  setup(build) {
    build.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: runtime }));
  },
});

mock.module('cloudflare:workers', () => import('./cloudflare-workers-runtime.ts'));
