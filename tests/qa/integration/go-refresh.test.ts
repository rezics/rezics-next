import { createHash, randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import { idOf, runHarness, type RunHarness } from './source-run-harness.ts';

type GoRun = { run: string; state: string; provider: string; acquisitionProfile: string;
  completion: { outcome: string } | null; surfaces: Array<{ surface: string; captureLimit: number;
    outcome: { outcome: string; captureCount: number } | null;
    captures: Array<{ requestKey: string; byteLength: number | null; byteDigest: string | null }> }> };
type GoResult = { run: GoRun; replayed: boolean; resolution: null | { status: string; cost: {
  fetches: number; bytes: number }; missing: string[]; buildList: Array<{ path: string; version: string;
    update: string | null }> } };

const mainModule = `module example.com/main

go 1.21

require example.com/mod v1.0.0
`;
const body = (source = mainModule) => ({ profile: 'go-proxy-live-run-v1', mainModule: source });
const path = (suffix: string) => `example.com/mod/@v/${suffix}`;
const bytes = (value: string) => new TextEncoder().encode(value);
const modFile = (extra = '') => `module example.com/mod\n\ngo 1.21\n${extra}`;

function seed(h: RunHarness, versions: string[], latest: string): void {
  h.provider.goProxyResponses.set(path('v1.0.0.mod'), bytes(modFile()));
  h.provider.goProxyResponses.set(path('list'), bytes(`${versions.join('\n')}\n`));
  h.provider.goProxyResponses.set(path(`${latest}.mod`), bytes(modFile('\nretract v1.0.0 // withdrawn upstream\n')));
}

const acquire = (h: RunHarness, key = `go-live-${randomUUID()}`, source = mainModule) =>
  h.post('/v1/sources/acquisitions', 'owner', body(source), key);

test('PKG20: the next Go source run admits new proxy versions with the same main-module intent', async () => {
  const h = await runHarness();
  try {
    seed(h, ['v1.0.0', 'v1.1.0'], 'v1.1.0');
    const key = `go-base-${randomUUID()}`;
    const firstResponse = await acquire(h, key);
    expect(firstResponse.status).toBe(201);
    const first = await firstResponse.json() as GoResult;
    expect(first).toMatchObject({ replayed: false, run: { provider: 'proxy.golang.org',
      acquisitionProfile: 'go-proxy-live-run-v1', state: 'completed',
      completion: { outcome: 'completed' } }, resolution: { status: 'solved',
        buildList: [{ path: 'example.com/mod', version: 'v1.0.0', update: 'v1.1.0' }] } });
    const frozenFirst = first.run;
    const countAfterFirst = h.provider.goProxyRequests.length;
    expect(countAfterFirst).toBe(3);
    expect(first.resolution!.cost.fetches).toBeLessThanOrEqual(2_048);
    expect(first.resolution!.cost.bytes).toBeLessThanOrEqual(32 * 1024 * 1024);
    expect(first.run.surfaces[0]).toMatchObject({ surface: 'proxy-metadata', captureLimit: 2_048,
      outcome: { outcome: 'qualified', captureCount: 3 } });
    expect(first.run.surfaces[0]!.captures.every(capture => capture.byteLength! <= 65_536
      && /^[0-9a-f]{64}$/.test(capture.byteDigest!))).toBe(true);

    // Same key reuses the exact source run and performs no proxy call.
    const replay = await (await acquire(h, key)).json() as GoResult;
    expect(replay).toEqual({ ...first, replayed: true });
    expect(h.provider.goProxyRequests).toHaveLength(countAfterFirst);

    // The caller's unchanged go.mod now sees a newly published version from a fresh run.
    seed(h, ['v1.0.0', 'v1.1.0', 'v1.2.0'], 'v1.2.0');
    const nextKey = `go-refresh-${randomUUID()}`;
    const beforeConcurrent = h.provider.goProxyRequests.length;
    const concurrent = await Promise.all([acquire(h, nextKey), acquire(h, nextKey)]);
    expect(concurrent.map(response => response.status)).toEqual(expect.arrayContaining([201]));
    expect(concurrent.every(response => [200, 201, 409].includes(response.status))).toBe(true);
    const nextResponse = await acquire(h, nextKey);
    expect(nextResponse.status).toBe(200);
    const next = await nextResponse.json() as GoResult;
    expect(next).toMatchObject({ replayed: true, run: { state: 'completed' },
      resolution: { status: 'solved', buildList: [{ path: 'example.com/mod', version: 'v1.0.0',
        update: 'v1.2.0' }] } });
    expect(h.provider.goProxyRequests.length - beforeConcurrent).toBe(3);
    const beforeStale = h.provider.goProxyRequests.length;
    expect((await acquire(h, key, `${mainModule}\n// changed intent\n`)).status).toBe(409);
    expect(h.provider.goProxyRequests).toHaveLength(beforeStale);

    // Earlier source evidence and its semantic result remain frozen after refresh.
    expect((await (await h.get(`/v1/sources/runs/${idOf(frozenFirst.run)}`, 'reader')).json()))
      .toEqual(frozenFirst);
  } finally { await h.close(); }
}, 60_000);

test('PKG20: proxy misses stay explicit and a later run recovers from refreshed source data', async () => {
  const h = await runHarness();
  try {
    const missingMain = `module example.com/main\n\ngo 1.21\n\nrequire example.com/missing v1.0.0\n`;
    const missKey = `go-miss-${randomUUID()}`;
    h.provider.goProxyOverrides.set('example.com/missing/@v/v1.0.0.mod',
      () => new Response('gone', { status: 410 }));
    const miss = await (await acquire(h, missKey, missingMain)).json() as GoResult;
    expect(miss).toMatchObject({ run: { state: 'completed', completion: { outcome: 'completed' } },
      resolution: { status: 'incomplete-source-data', missing: ['example.com/missing/@v/v1.0.0.mod'] } });
    const id = idOf(miss.run.run);
    const stored = await h.contentPool.query<{ status: string; byte_length: number; byte_digest: string }>(
      `SELECT o.capture ->> 'status' AS status, octet_length(o.raw_bytes)::int AS byte_length,
        o.byte_digest FROM source.run_capture c JOIN source.observation o ON o.id = c.observation_id
       WHERE c.run_id = $1`, [id]);
    expect(stored.rows).toEqual([{ status: '410', byte_length: 0,
      byte_digest: createHash('sha256').update(Buffer.alloc(0)).digest('hex') }]);

    // A replay continues to use the captured miss even after the proxy later has that file.
    h.provider.goProxyResponses.set('example.com/missing/@v/v1.0.0.mod',
      bytes('module example.com/missing\n\ngo 1.21\n'));
    const requests = h.provider.goProxyRequests.length;
    const replay = await (await acquire(h, missKey, missingMain)).json() as GoResult;
    expect(replay.resolution?.status).toBe('incomplete-source-data');
    expect(h.provider.goProxyRequests).toHaveLength(requests);

    // A new run sees the now available response without changing the main go.mod.
    h.provider.goProxyOverrides.clear();
    h.provider.goProxyResponses.set('example.com/missing/@v/list', bytes('v1.0.0\n'));
    const fresh = await (await acquire(h, `go-recovered-${randomUUID()}`, missingMain)).json() as GoResult;
    expect(fresh.resolution?.status).toBe('solved');
    expect(fresh.run.run).not.toBe(miss.run.run);

    const beforeDenied = h.provider.goProxyRequests.length;
    expect((await h.post('/v1/sources/acquisitions', 'reader', body(missingMain),
      `denied-${randomUUID()}`)).status).toBe(401);
    expect(h.provider.goProxyRequests).toHaveLength(beforeDenied);
    expect((await h.get(`/v1/sources/runs/${id}`, 'other')).status).toBe(404);
    await h.accessPool.query('UPDATE access.principal SET active = false WHERE id = $1', [h.ownerId]);
    const before = h.provider.goProxyRequests.length;
    expect((await h.post('/v1/sources/acquisitions', 'owner', body(missingMain), `inactive-${randomUUID()}`)).status)
      .toBe(403);
    expect(h.provider.goProxyRequests).toHaveLength(before);
    expect((await h.get(`/v1/sources/runs/${id}`, 'reader')).status).toBe(403);
  } finally { await h.close(); }
}, 60_000);

test('PKG20: failed proxy acquisition is recorded incomplete and a fresh run can recover', async () => {
  const h = await runHarness();
  try {
    seed(h, ['v1.0.0', 'v1.1.0'], 'v1.1.0');
    h.provider.goProxyOverrides.set(path('v1.0.0.mod'), () => new Response('unavailable', { status: 503 }));
    const failed = await (await acquire(h)).json() as GoResult;
    expect(failed).toMatchObject({ run: { state: 'incomplete', completion: { outcome: 'incomplete' } },
      resolution: null });
    expect(failed.run.surfaces[0]?.outcome).toMatchObject({ outcome: 'failed', reason: 'http-status',
      captureCount: 0 });

    h.provider.goProxyOverrides.clear();
    const recovered = await (await acquire(h, `go-after-failure-${randomUUID()}`)).json() as GoResult;
    expect(recovered).toMatchObject({ run: { state: 'completed' }, resolution: { status: 'solved' } });
  } finally { await h.close(); }
}, 60_000);

test('PKG20: oversized proxy responses fail before they enter a source run capture', async () => {
  const h = await runHarness();
  try {
    seed(h, ['v1.0.0', 'v1.1.0'], 'v1.1.0');
    h.provider.goProxyOverrides.set(path('v1.0.0.mod'), () => new Response('x'.repeat(65_537)));
    const failed = await (await acquire(h)).json() as GoResult;
    expect(failed).toMatchObject({ run: { state: 'incomplete' }, resolution: null });
    expect(failed.run.surfaces[0]?.outcome).toMatchObject({ outcome: 'failed', reason: 'oversized',
      captureCount: 0 });
    expect(failed.run.surfaces[0]?.captures).toEqual([]);
  } finally { await h.close(); }
}, 60_000);
