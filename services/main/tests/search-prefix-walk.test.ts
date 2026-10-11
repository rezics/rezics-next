import { expect, test } from 'bun:test';
import { fillPrefixWalkPage, prefixWalkCursor, prefixWalkDirectoryKey, prefixWalkExaminedLimit,
  prefixWalkRequest, validatePrefixWalkResponse, type PrefixWalkEntry,
  type PrefixWalkRequest, type PrefixWalkResponse } from '../src/modules/search/prefix-walk.ts';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { PublicQueryUnavailable } from '../src/modules/work/search-budget.ts';
import { SearchSnapshotMoved } from '../src/modules/work/search-readiness.ts';

const id = (number: number) => `https://rezics.com/id/00000000-0000-4000-8000-${number.toString(16).padStart(12, '0')}`;
function entry(main: number, unit = main, matchedField: 'title' | 'credit' = 'title', rejected = false): PrefixWalkEntry {
  const value = { mainVersion: id(main), matchUnit: id(unit), matchedField, rejected };
  return { ...value, key: prefixWalkDirectoryKey(value) };
}
function nativeWalk(entries: PrefixWalkEntry[]) {
  const calls: PrefixWalkRequest[] = [];
  return { calls, walk: async (request: PrefixWalkRequest): Promise<PrefixWalkResponse> => {
    calls.push(request);
    const after = request.cursor ? (JSON.parse(Buffer.from(request.cursor, 'base64url').toString()) as { after: string }).after : '';
    const remaining = entries.filter(value => value.key.localeCompare(after) > 0);
    const page = remaining.slice(0, request.pageSize);
    const more = page.length < remaining.length;
    return { entries: page, generation: '1', examined: page.length, rejected: page.filter(value => value.rejected).length,
      more, cursor: more ? prefixWalkCursor(request, '1', page.at(-1)!.key) : null };
  } };
}

test('prefix walk normalizes as current matching and rejected native/disclosure/muted/deduplicated entries advance', async () => {
  const native = nativeWalk([entry(1, 1, 'title', true), entry(2), entry(3), entry(4), entry(4, 5), entry(6)]);
  const offered: string[] = [];
  const page = await fillPrefixWalkPage({ prefix: '  BÓ\t  OK  ', language: 'EN', pageSize: 2 }, native.walk, async value => {
    offered.push(value.mainVersion);
    return [id(2), id(3)].includes(value.mainVersion) ? null : value.mainVersion;
  });
  expect(page).toEqual({ items: [id(4), id(6)], examined: 6, rejected: 4, hasMore: false, cursor: null });
  expect(offered).toEqual([id(2), id(3), id(4), id(6)]);
  expect(native.calls[0]).toMatchObject({ prefix: 'bó ok', language: 'en', pageSize: 2, cursor: null });
  expect(native.calls.slice(1).every(call => call.cursor !== null)).toBe(true);
});

test('all-rejected prefix walk stops at four examined entries per page item and resumes past the cap', async () => {
  const native = nativeWalk(Array.from({ length: 100 }, (_, index) => entry(index + 1)));
  const input = { prefix: 'b', language: null, pageSize: 10 };
  const first = await fillPrefixWalkPage(input, native.walk, async () => null);
  expect(first).toMatchObject({ items: [], examined: 40, rejected: 40, hasMore: true });
  expect(first.examined).toBe(prefixWalkExaminedLimit(input.pageSize));
  expect(native.calls).toHaveLength(4);
  const continued = await fillPrefixWalkPage({ ...input, cursor: first.cursor }, native.walk, async value => value.mainVersion);
  expect(continued.items).toEqual(Array.from({ length: 10 }, (_, index) => id(index + 41)));
  expect(continued.examined).toBe(10);
});

test('a nearly-full page remains bounded through repeated rejections and never skips an accepted entry', async () => {
  const native = nativeWalk(Array.from({ length: 100 }, (_, index) => entry(index + 1)));
  const first = await fillPrefixWalkPage({ prefix: 'bo', language: 'en', pageSize: 2 }, native.walk,
    async value => value.mainVersion === id(1) ? value.mainVersion : null);
  expect(first).toMatchObject({ items: [id(1)], examined: 8, rejected: 7, hasMore: true });
  const next = await fillPrefixWalkPage({ prefix: 'bo', language: 'en', pageSize: 2, cursor: first.cursor }, native.walk,
    async value => value.mainVersion);
  expect(next.items).toEqual([id(9), id(10)]);
  expect(next.examined).toBe(2);
});

test('directory byte order equals localeCompare of keys and title/Main/unit order for canonical identities', () => {
  const entries = [entry(16), entry(10, 2), entry(10, 1), entry(2), entry(1, 1, 'credit'), entry(15)];
  const identityOrder = [...entries].sort((a, b) => Number(a.matchedField === 'credit') - Number(b.matchedField === 'credit')
    || a.mainVersion.localeCompare(b.mainVersion) || a.matchUnit.localeCompare(b.matchUnit));
  expect([...entries].sort((a, b) => a.key.localeCompare(b.key))).toEqual(identityOrder);
  expect([...entries].sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)))).toEqual(identityOrder);
});

test('opaque continuation round trips without losing accepted entries and binds prefix/language/generation', async () => {
  const native = nativeWalk([entry(1), entry(2), entry(3), entry(4, 4, 'credit')]);
  const input = { prefix: 'BO', language: 'EN', pageSize: 2 };
  const first = await fillPrefixWalkPage(input, native.walk, async value => value.key);
  expect(first.hasMore).toBe(true);
  const roundTrip = JSON.parse(JSON.stringify(first)) as typeof first;
  const second = await fillPrefixWalkPage({ ...input, cursor: roundTrip.cursor }, native.walk, async value => value.key);
  expect([...first.items, ...second.items]).toEqual([entry(1), entry(2), entry(3), entry(4, 4, 'credit')].map(value => value.key));
  expect(second).toMatchObject({ examined: 2, hasMore: false, cursor: null });
  for (const changed of [{ prefix: 'b', language: 'en' }, { prefix: 'bo', language: null }]) {
    expect(() => prefixWalkRequest({ ...changed, pageSize: 2, cursor: first.cursor })).toThrow(PublicQueryUnavailable);
  }
});

test('empty and exhausted native walks return complete empty pages without invoking disclosure', async () => {
  const native = nativeWalk([]);
  let accepted = 0;
  expect(await fillPrefixWalkPage({ prefix: 'b', language: null, pageSize: 10 }, native.walk,
    async () => { accepted++; return 'unexpected'; }))
    .toEqual({ items: [], examined: 0, rejected: 0, hasMore: false, cursor: null });
  expect(accepted).toBe(0);
  expect(native.calls).toHaveLength(1);
});

test('malformed native counts, identities, order and nonadvancing or stale cursors are refused', () => {
  const request = prefixWalkRequest({ prefix: 'b', language: 'en', pageSize: 2 });
  const first = entry(1), second = entry(2);
  const good = { entries: [first, second], generation: '1', examined: 2, rejected: 0, more: true,
    cursor: prefixWalkCursor(request, '1', second.key) };
  expect(validatePrefixWalkResponse(good, request)).toEqual(good);
  const bad: unknown[] = [null, {}, { ...good, generation: undefined }, { ...good, generation: '2' },
    { ...good, examined: 3 }, { ...good, examined: -1 },
    { ...good, rejected: 1 }, { ...good, entries: [first, second, entry(3)], examined: 3 },
    { ...good, entries: [second, first] }, { ...good, entries: [first, first] },
    { ...good, entries: [{ ...first, key: second.key }, second] },
    { ...good, entries: [{ ...first, mainVersion: 'private-iri' }, second] },
    { ...good, entries: [{ ...first, rejected: undefined }, second] },
    { ...good, cursor: prefixWalkCursor(request, '1', first.key) }, { ...good, cursor: 'invalid' },
    { ...good, more: false }, { ...good, entries: [], examined: 0 },
  ];
  for (const value of bad) expect(() => validatePrefixWalkResponse(value, request)).toThrow(PublicQueryUnavailable);
  const continued = { ...request, cursor: good.cursor };
  const third = entry(3);
  expect(() => validatePrefixWalkResponse({ entries: [third], generation: '2', examined: 1, rejected: 0, more: true,
    cursor: prefixWalkCursor(request, '2', third.key) }, continued)).toThrow(PublicQueryUnavailable);
  expect(() => validatePrefixWalkResponse({ entries: [third], generation: '2', examined: 1, rejected: 0,
    more: false, cursor: null }, continued)).toThrow(PublicQueryUnavailable);
  expect(() => validatePrefixWalkResponse(good, continued)).toThrow(PublicQueryUnavailable);
});

test('prefix walk rejects invalid admission bounds and propagates unavailable or snapshot failures', async () => {
  for (const size of [0, -1, 11, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(() => prefixWalkExaminedLimit(size)).toThrow(RangeError);
  }
  expect(() => prefixWalkRequest({ prefix: ' \t ', language: null, pageSize: 1 })).toThrow(RangeError);
  const moved = new SearchSnapshotMoved('generation moved');
  const input = { prefix: 'b', language: null, pageSize: 2 };
  await expect(fillPrefixWalkPage(input, async () => { throw moved; }, async value => value)).rejects.toBe(moved);
  const native = nativeWalk([entry(1)]);
  await expect(fillPrefixWalkPage(input, native.walk, async () => { throw moved; })).rejects.toBe(moved);
});

test('command health defaults prefix walk capability to false and validates native advertisement', async () => {
  let flag: unknown;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json({
    moduleVersion: 'test', instanceId: '00000000-0000-4000-8000-000000000001', publicSearchWriteEpoch: '0',
    publicSearchWriteActive: false, profiles: {}, ...(flag === undefined ? {} : { prefixWalkAvailable: flag }),
  }) });
  try {
    const client = new FusekiClient(`http://127.0.0.1:${server.port}/rezics/`);
    expect((await client.commandHealth()).prefixWalkAvailable).toBe(false);
    flag = false;
    expect((await client.commandHealth()).prefixWalkAvailable).toBe(false);
    flag = true;
    expect((await client.commandHealth()).prefixWalkAvailable).toBe(true);
    for (flag of [null, 'true', 1, {}]) await expect(client.commandHealth()).rejects.toThrow('malformed Fuseki command health');
  } finally { await server.stop(true); }
});
