import { afterEach, expect, spyOn, test } from 'bun:test';
import { workAsyncStorage, type WorkStore } from 'next/dist/server/app-render/work-async-storage.external.js';
import { workUnitAsyncStorage, type RequestStore } from 'next/dist/server/app-render/work-unit-async-storage.external.js';
import { mainApiWithToken } from '../features/api/main.ts';
import { readAddress, type ResolvedAddress } from '../features/address/client.ts';
import { readSpacePage } from '../features/address/space-read.ts';
import { readAgentProfile } from '../features/auth/agent-profile.ts';
import { forgetServedTypes, readTypes } from '../features/catalogue/types-read.ts';
import { servedTypes } from '../features/catalogue/type-fixtures.ts';
import { changeHandle } from '../features/onboarding/change-handle.ts';
import { readFollowed } from '../features/shell/communities-read.ts';
import { uuidToSid } from '@rezics/model/address';

const uuid = 'dfc1030e-efa0-4041-a686-bebce31f645c';
const holder = `https://rezics.com/id/${uuid}`;
const key = '99800000-0000-4000-8000-000000000001';
const sessionKey = '99800000-0000-4000-8000-000000000002';
const canonical = { prefix: '/a/' as const, key: uuidToSid(uuid), slugSource: 'Reader' };
const address: ResolvedAddress = { profile: 'address-resolution-v1', status: 'resolved',
  scope: 'agent', key: uuid, holder, state: 'current', canonical };
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; forgetServedTypes(); });

/** Give the actual next/headers and next/cookies adapters a render request,
 * without replacing either module or leaking mocks into the other suites. */
async function pageRequest(run: () => Promise<void>) {
  const headers = new Headers({ 'cf-connecting-ip': '203.0.113.17',
    'x-rezics-client-ip': '192.0.2.99', 'x-forwarded-for': '192.0.2.98',
    'x-rezics-page-url': 'https://rezics.test/en/discover' });
  const cookies = { get: (name: string) => name === 'rezics_session_key' ? { value: sessionKey }
    : name === 'rezics_access' ? { value: 'reader-token' } : undefined };
  const work = spyOn(workAsyncStorage, 'getStore').mockReturnValue({ route: '/en/discover' } as WorkStore);
  const request = spyOn(workUnitAsyncStorage, 'getStore').mockReturnValue({
    type: 'request', phase: 'render', headers, cookies,
  } as RequestStore);
  try { await run(); } finally { work.mockRestore(); request.mockRestore(); }
}

test('G998: page-context readers forward the ingress client through every raw Main read and Eden', async () => {
  const paths: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    paths.push(url.pathname);
    if (!init?.method || init.method === 'GET' || init.method === 'HEAD')
      expect(headers.get('x-rezics-client-ip'), url.pathname).toBe('203.0.113.17');
    expect(headers.has('cookie')).toBe(false);
    expect(headers.has('x-forwarded-for')).toBe(false);
    if (url.pathname === '/v1/me/session-agent')
      return Response.json({ sessionAgent: { eligible: true, actingSubject: holder } });
    if (url.pathname === '/v1/me/person-preferences') return Response.json({ contentLanguages: ['sv'] });
    if (url.pathname === '/v1/me/follows') return Response.json({ items: [], complete: true });
    if (url.pathname === '/v1/addresses/resolve') {
      expect(headers.has('authorization')).toBe(false);
      return Response.json(address);
    }
    if (url.pathname === `/v1/agents/${uuid}`)
      return Response.json({ id: holder, revision: key, displayName: 'Reader' });
    if (url.pathname === '/v1/types') return Response.json(servedTypes);
    if (url.pathname === '/v1/addresses/current')
      return Response.json({ holder, key: 'reader', revision: key });
    if (url.pathname === '/v1/addresses/renames') return new Response(null, { status: 200 });
    if (url.pathname === `/v1/realms/${uuid}`) return new Response(null, { status: 404 });
    if (url.pathname === `/v1/realms/${uuid}/join-page`)
      return Response.json({ profile: 'realm-join-page-v1', id: holder, action: { kind: 'request' } });
    throw new Error(`Unexpected Main request: ${url.pathname}`);
  }) as typeof fetch;
  await pageRequest(async () => {
    expect((await readAddress({ scope: 'agent', key: uuid }, 'en')).kind).toBe('resolved');
    expect((await readAgentProfile(holder, 'reader-token'))?.id).toBe(holder);
    expect((await readTypes())?.digest).toBe(servedTypes.digest);
    expect(await changeHandle('reader-token', holder, 'reader-new', 'reader', key)).toBe('changed');
    expect((await readSpacePage(uuid, 'en')).kind).toBe('join');
    const result = await mainApiWithToken('reader-token').v1.types.get();
    expect(result.status).toBe(200);
    expect(await readFollowed('realm')).toEqual({ items: [], complete: true });
  });
  for (const path of ['/v1/me/session-agent', '/v1/me/person-preferences', '/v1/addresses/resolve',
    `/v1/agents/${uuid}`, '/v1/types', '/v1/addresses/current', `/v1/realms/${uuid}`,
    `/v1/realms/${uuid}/join-page`, '/v1/me/follows']) expect(paths).toContain(path);
});

test('G998: Eden reads preserve a caller abort instead of waiting indefinitely for Main', async () => {
  const controller = new AbortController();
  globalThis.fetch = (async (_input, init) => {
    expect(init?.signal).toBeDefined();
    return new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
      controller.abort(new DOMException('Cancelled read', 'AbortError'));
    });
  }) as typeof fetch;
  const read = await mainApiWithToken(undefined).v1.types.get({ fetch: { signal: controller.signal } });
  expect(read.status).toBe(503);
});
