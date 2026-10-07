import { expect, spyOn, test } from 'bun:test';
import { browserAccountApi } from '../features/api/client.ts';
import type { Result } from '../features/api/errors.ts';

for (const revoked of [0, 2, null]) {
  test(`session revoke consumers accept revoked=${revoked} as completion and expose void`, async () => {
    const calls: unknown[] = [];
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async (
      _input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1],
    ) => {
      calls.push(JSON.parse(String(init?.body)));
      return Response.json({ revoked });
    }, { preconnect: globalThis.fetch.preconnect }));
    try {
      const results: Result<void>[] = await Promise.all([
        browserAccountApi.revokeSession('selected'),
        browserAccountApi.revokeSessions(['first', 'second']),
        browserAccountApi.revokeOtherSessions(),
      ]);
      expect(results).toEqual(Array.from({ length: 3 }, () => ({ ok: true, data: undefined })));
      expect(calls).toEqual([{ sessionId: 'selected' }, { sessionIds: ['first', 'second'] }, { others: true }]);
    } finally { fetchSpy.mockRestore(); }
  });
}

test('session revoke consumer preserves authorization failures rather than reporting completion', async () => {
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async () =>
    Response.json({ error: 'unauthenticated' }, { status: 401 }), { preconnect: globalThis.fetch.preconnect }));
  try {
    const response: Result<void> = await browserAccountApi.revokeOtherSessions();
    expect(response).toMatchObject({ ok: false, status: 401 });
  } finally { fetchSpy.mockRestore(); }
});
