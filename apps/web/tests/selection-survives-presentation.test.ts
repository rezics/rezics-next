import { afterEach, expect, spyOn, test } from 'bun:test';
import { workAsyncStorage, type WorkStore } from 'next/dist/server/app-render/work-async-storage.external.js';
import { workUnitAsyncStorage, type RequestStore } from 'next/dist/server/app-render/work-unit-async-storage.external.js';
import { SERVER_DEADLINE_HEADER } from '../features/api/server-fetch.ts';
import { positionOf } from '../features/wiki/state.ts';
import { declaringSlug, decideExecution } from '../features/zones/execution.ts';
import type { ZonePackage } from '@rezics/zone-sdk';

const nativeFetch = globalThis.fetch;
const mainOrigin = process.env.MAIN_ORIGIN;
afterEach(() => {
  globalThis.fetch = nativeFetch;
  if (mainOrigin === undefined) delete process.env.MAIN_ORIGIN;
  else process.env.MAIN_ORIGIN = mainOrigin;
});

const person = 'https://rezics.com/id/019a5c00-0000-7000-8000-0000000000aa';
const franchise = 'https://rezics.com/id/019a5c00-0000-7000-8000-000000000001';
const chapter = '019a5c00-0000-7000-8000-0000000000c3';
const zone = '019a5c00-0000-7000-8000-0000000000e1';

const approved = { approved: { digest: 'sha256:abc' }, reason: 'none-approved' as const };
const approval = { main: approved, slug: 'franchise-wiki', installedDigest: 'sha256:abc' };

test('selection: safe mode and the standard look turn presentation off but keep the package that declares positions', () => {
  expect(decideExecution({ ...approval, safeMode: true, lookEnabled: true })).toEqual({ mode: 'fallback', reason: 'safe-mode' });
  expect(decideExecution({ ...approval, safeMode: false, lookEnabled: false }))
    .toEqual({ mode: 'fallback', reason: 'viewer-opt-out' });
  expect(declaringSlug(approval)).toBe('franchise-wiki');
});

test('selection: a package Main has not approved, or this build does not carry, declares nothing to follow', () => {
  expect(declaringSlug({ ...approval, installedDigest: 'sha256:other' })).toBeNull();
  expect(declaringSlug({ ...approval, installedDigest: null })).toBeNull();
  expect(declaringSlug({ ...approval, main: { approved: null, reason: 'revoked' } })).toBeNull();
  expect(declaringSlug({ ...approval, main: null })).toBeNull();
  expect(declaringSlug({ ...approval, slug: null })).toBeNull();
});

/** A render of a signed-in reader whose reads Main answers from `answer`; returns every Main URL asked. */
async function signedInRender<T>(answer: (url: URL) => unknown, run: () => Promise<T>) {
  process.env.MAIN_ORIGIN = 'http://main.test';
  const asked: URL[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    asked.push(url);
    const body = answer(url);
    return body === undefined ? Response.json({ error: 'not_found' }, { status: 404 }) : Response.json(body);
  }) as unknown as typeof fetch;
  const headers = new Headers({ [SERVER_DEADLINE_HEADER]: String(Date.now() + 5000),
    'x-rezics-page-url': 'https://web.test/en' });
  const cookies = { get: (name: string) => name === 'rezics_access' ? { value: 'reader-token' }
    : name === 'rezics_session_key' ? { value: '10280000-0000-4000-8000-000000000001' } : undefined };
  const work = spyOn(workAsyncStorage, 'getStore').mockReturnValue({ route: '/en' } as WorkStore);
  const request = spyOn(workUnitAsyncStorage, 'getStore').mockReturnValue(
    { type: 'request', phase: 'render', headers, cookies } as RequestStore);
  try { return { result: await run(), asked }; } finally { work.mockRestore(); request.mockRestore(); }
}

test('selection: with safe mode on, the reader\'s chosen position still reaches every read', async () => {
  const decided = decideExecution({ ...approval, safeMode: true, lookEnabled: true });
  expect(decided).toEqual({ mode: 'fallback', reason: 'safe-mode' });
  // The Zone page reads the approved package for what it declares (the mount its positions are in), and does not run it.
  expect(declaringSlug(approval)).toBe('franchise-wiki');
  const declared = { slug: 'franchise-wiki', positions: { mount: 'franchise' } } as unknown as ZonePackage;
  const { result, asked } = await signedInRender(url => {
    if (url.pathname === '/v1/me/session-agent') return { sessionAgent: { eligible: true, actingSubject: person } };
    if (url.pathname === `/v1/zones/${zone}/routes`) return { kind: 'index', items: [{ id: franchise, title: { value: 'Franchise' } }] };
    if (url.pathname.startsWith('/v1/reading-positions/'))
      return { resolved: `https://rezics.com/id/${chapter}`, items: [], complete: true, nextCursor: null };
    return undefined;
  }, () => positionOf(declared, zone, { kind: 'at', occurrence: chapter }));
  expect(result).toMatchObject({ mode: 'chosen', main: `https://rezics.com/id/${chapter}`, choice: { kind: 'at', occurrence: chapter } });
  const chooser = asked.find(url => url.pathname.startsWith('/v1/reading-positions/'))!;
  expect(chooser.searchParams.get('position')).toBe(`https://rezics.com/id/${chapter}`);
  expect(chooser.searchParams.get('actingSubject')).toBe(person);
});

test('selection: a Zone page that drops the package for presentation has no position to keep', async () => {
  const { result, asked } = await signedInRender(() => undefined, () => positionOf(null, zone, { kind: 'at', occurrence: chapter }));
  expect(result).toBeNull();
  expect(asked).toEqual([]);
});
