import { afterAll, expect, test } from 'bun:test';
import { loadAccountDeletionPage } from '../src/account-deletion-page';
const original = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = original;
});

test('one closed same-origin page read rejects authority and unrecognized advice fields', async () => {
  const read = (body: unknown) => {
    globalThis.fetch = (async (path, init) => {
      expect(path).toBe('/account-management/deletion-page');
      expect(init).toMatchObject({
        method: 'POST',
        body: '{}',
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
      });
      return Response.json(body);
    }) as typeof fetch;
    return loadAccountDeletionPage(new AbortController().signal);
  };
  for (const body of [
    { kind: 'signed-out' },
    { kind: 'authentication-required', accountId: 'self' },
    { kind: 'review', accountId: 'self', email: null, action: 'refused', policy: 'personal-deletion' },
  ])
    expect(await read(body)).toEqual(body);
  for (const body of [
    { kind: 'available' },
    { kind: 'review', accountId: 'self', action: 'available' },
    { kind: 'authentication-required', accountId: 'self', token: 'secret' },
  ])
    expect(await read(body)).toEqual({ kind: 'unavailable' });
});
