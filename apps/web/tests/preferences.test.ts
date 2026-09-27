import { expect, test } from 'bun:test';
import { forwardDisplayPreferences, saveDisplayPreference } from '../features/api/preferences.ts';

test('G311 BFF: a signed-in read and CAS write round-trip without leaking browser headers', async () => {
  let revision = 0;
  const calls: Request[] = [];
  const upstream = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    calls.push(request);
    if (request.method === 'PUT') {
      const body = await request.json() as { expectedRevision: number; displayMode: string; showZoneThemes: boolean };
      if (body.expectedRevision !== revision) return Response.json({ error: 'conflict' }, { status: 409 });
      revision++;
      return Response.json({ revision, displayMode: body.displayMode, showZoneThemes: body.showZoneThemes });
    }
    return Response.json({ revision, displayMode: revision ? 'dark' : 'system', showZoneThemes: revision === 0 });
  }) as typeof fetch;
  const input = { accountOrigin: 'https://account.test', accessToken: 'server-token', fetch: upstream };
  const call = (method: string, body?: unknown, headers: Record<string, string> = {}) =>
    forwardDisplayPreferences(new Request('https://web.test/api/preferences', { method, headers: {
      cookie: 'private=secret', authorization: 'Bearer forged', origin: 'https://web.test', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body) }), input);
  expect(await (await call('GET')).json()).toEqual({ revision: 0, displayMode: 'system', showZoneThemes: true });
  expect(await (await call('PUT', { expectedRevision: 0, displayMode: 'dark', showZoneThemes: false })).json())
    .toEqual({ revision: 1, displayMode: 'dark', showZoneThemes: false });
  expect(await (await call('GET')).json()).toEqual({ revision: 1, displayMode: 'dark', showZoneThemes: false });
  expect((await call('PUT', { expectedRevision: 0, displayMode: 'light', showZoneThemes: true })).status).toBe(409);
  expect(calls.map(call => call.url)).toEqual(Array(4).fill('https://account.test/api/account/display-preferences'));
  expect(calls[1]!.headers.get('origin')).toBe('https://account.test');
  expect(calls[1]!.headers.get('authorization')).toBe('Bearer server-token');
  expect(calls[1]!.headers.get('cookie')).toBeNull();
  expect((await call('PUT', {}, { origin: 'https://evil.test' })).status).toBe(403);
  expect((await forwardDisplayPreferences(new Request('https://web.test/api/preferences'),
    { ...input, accessToken: undefined })).status).toBe(401);
});

test('G311 browser update retries CAS with the other preference from the new account value', async () => {
  let reads = 0;
  const writes: unknown[] = [];
  const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      writes.push(JSON.parse(String(init.body)));
      return writes.length === 1 ? Response.json({ error: 'conflict' }, { status: 409 })
        : Response.json({ revision: 2, displayMode: 'dark', showZoneThemes: false });
    }
    reads++;
    return Response.json(reads === 1
      ? { revision: 0, displayMode: 'system', showZoneThemes: true }
      : { revision: 1, displayMode: 'dark', showZoneThemes: true });
  }) as typeof fetch;
  expect(await saveDisplayPreference({ showZoneThemes: false }, fetcher)).toBe('saved');
  expect(writes).toEqual([
    { expectedRevision: 0, displayMode: 'system', showZoneThemes: false },
    { expectedRevision: 1, displayMode: 'dark', showZoneThemes: false },
  ]);
});
