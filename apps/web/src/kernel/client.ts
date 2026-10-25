import { createKernelClient } from '@rezics/client';
import { env } from 'cloudflare:workers';

export function kernelClient() {
  const origin = (env as { KERNEL_ORIGIN?: string }).KERNEL_ORIGIN;
  if (origin) return createKernelClient(origin);
  if (import.meta.env.DEV) {
    return createKernelClient('http://kernel.local', {
      fetch: (async (input, init) => {
        const [{ createFakeKernelFetch }, { default: fixtures }] = await Promise.all([
          import('./fake.ts'), import('./fixtures.json'),
        ]);
        return createFakeKernelFetch(fixtures as unknown as Parameters<typeof createFakeKernelFetch>[0])(input, init);
      }) as typeof fetch,
    });
  }
  throw new Error('KERNEL_ORIGIN is required to read subjects');
}
