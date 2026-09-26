import { expect, test } from 'bun:test';
import { windowRanges } from '../../../services/main/src/modules/source/acquisition-feed.ts';
import { fetchOpenLibraryJson } from '../../../services/main/src/modules/source/open-library.ts';

const ids = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, n) => BigInt(to - n));

test('LIVE12: newest-first change pages derive overlap, contiguous and gap ranges from the floor', () => {
  expect(windowRanges([{ ids: ids(96, 105) }], 100n)).toEqual([{ index: 0, from: 96n, to: 105n, continuity: 'overlap' }]);
  expect(windowRanges([{ ids: ids(121, 130) }, { ids: ids(111, 120) }], 105n).map(range => range.continuity))
    .toEqual(['gap', 'contiguous']);
  // Non-contiguous provider ids between adjacent pages are not a gap; offset shifts are overlap.
  expect(windowRanges([{ ids: [140n, 139n] }, { ids: [120n, 101n] }], 100n).map(range => [range.continuity, range.from]))
    .toEqual([['contiguous', 101n], ['contiguous', 121n]]);
  expect(windowRanges([{ ids: [131n, 130n] }, { ids: [130n, 99n] }], 100n).map(range => range.continuity))
    .toEqual(['overlap', 'overlap']);
  expect(windowRanges([{ ids: [] }], 7n)).toEqual([{ index: 0, from: 7n, to: 7n, continuity: 'overlap' }]);
});

test('LIVE02/LIVE11: fixed-origin run fetches classify access limits and failures without bytes', async () => {
  const respond = (response: () => Response) => (async () => response()) as unknown as typeof fetch;
  const json = (body: string, headers: Record<string, string> = {}) => new Response(body,
    { headers: { 'content-type': 'application/json', ...headers } });
  const cases: Array<[() => Response, string, string]> = [
    [() => new Response('', { status: 401 }), 'unqualified', 'authentication-required'],
    [() => new Response('', { status: 403 }), 'unqualified', 'authorization-denied'],
    [() => new Response('', { status: 429 }), 'failed', 'rate-limited'],
    [() => new Response(null, { status: 301 }), 'failed', 'redirect-refused'],
    [() => new Response('', { status: 500 }), 'failed', 'http-status'],
    [() => new Response('{}', { headers: { 'content-type': 'text/html' } }), 'failed', 'malformed'],
    [() => json('{"a":'), 'failed', 'malformed'],
    [() => json('{}', { 'content-length': '70000' }), 'failed', 'oversized'],
  ];
  for (const [response, outcome, reason] of cases) {
    expect(await fetchOpenLibraryJson('/works/OL1W.json', respond(response))).toMatchObject({ ok: false, outcome, reason });
  }
  const failing = (async () => { throw new TypeError('reset'); }) as unknown as typeof fetch;
  expect(await fetchOpenLibraryJson('/works/OL1W.json', failing)).toMatchObject({ ok: false, reason: 'network' });
  await expect(fetchOpenLibraryJson('https://evil.test/x', respond(() => json('{}')))).rejects.toThrow('path');
  await expect(fetchOpenLibraryJson('/works/../x', respond(() => json('{}')))).rejects.toThrow('path');
  expect(await fetchOpenLibraryJson('/works/OL1W.json', respond(() => json('{"key":"/works/OL1W"}', { etag: '"7"' }))))
    .toMatchObject({ ok: true, url: 'https://openlibrary.org/works/OL1W.json', etag: '"7"' });
});
