// constructed exposure responses exercise the real current-viewer BFF.
// Native authorization and browser acceptance remain separate obligations.
import { expect, mock, spyOn, test } from 'bun:test';
import * as start from '../.storybook/react-start';

const responseHeaders = new Headers();
const currentRequest = new Request('https://site.test/en/creator/sales', {
  headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` },
});
mock.module('cloudflare:workers', () => ({
  env: {
    KERNEL_ORIGIN: 'https://kernel.test',
    AUTH_ISSUER: 'https://auth.test',
    API_RESOURCE: 'https://kernel.test',
    WEBSITE_SCOPES: 'openid commerce_sale:list',
    WEBSITE_CLIENT_ID: 'web',
    WEBSITE_CLIENT_KEY: '{}',
    SESSIONS: {
      idFromName: (id: string) => id,
      get: () => ({
        credential: async () => ({
          status: 'active',
          subject: 'creator',
          accessToken: 'current-creator',
          csrfToken: 'private-csrf',
        }),
      }),
    },
  },
}));
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => ({
  getRequest: () => currentRequest,
  setResponseHeader: (name: string, value: string) => responseHeaders.set(name, value),
}));
const { readCreatorSalesCurrent } = await import('../src/checkout/creator-sales');

test('current sales preserves a genuine exposure denial or failure without requesting sales', async () => {
  let status = 401;
  const calls: Request[] = [];
  const fetcher = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const call = new Request(input, init);
    calls.push(call);
    return Response.json(null, { status, headers: { location: 'https://elsewhere.test/private' } });
  });
  try {
    for (const [nativeStatus, kind] of [
      [401, 'denied'],
      [403, 'denied'],
      [404, 'denied'],
      [400, 'error'],
      [409, 'stale'],
      [503, 'unavailable'],
      [302, 'unavailable'],
      [200, 'unavailable'],
    ] as const) {
      status = nativeStatus;
      const before = calls.length;
      expect(await readCreatorSalesCurrent({ data: { cursor: 'signed-current-address' } })).toEqual({
        sessionSubject: 'creator',
        requested: { cursor: 'signed-current-address' },
        selling: false,
        page: { kind },
      });
      expect(calls.length - before).toBe(1);
      const call = calls.at(-1)!;
      expect(new URL(call.url).pathname).toBe('/v1/platform/exposure');
      expect(call.headers.get('authorization')).toBe('Bearer current-creator');
      expect(call.cache).toBe('no-store');
      expect(call.redirect).toBe('manual');
      expect(responseHeaders.get('cache-control')).toBe('private, no-store');
      expect(responseHeaders.get('x-robots-tag')).toBe('noindex, nofollow');
    }
  } finally {
    fetcher.mockRestore();
  }
});
