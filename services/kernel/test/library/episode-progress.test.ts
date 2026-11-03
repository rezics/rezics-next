import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';
import { createKernelClient } from '@rezics/client';
import { bundledRelease } from '@rezics/definitions/bundled';
import pg from 'pg';
import { createEpisodeProgressCommands, episodeIds, episodeIntent } from '../../src/library/episode-progress.ts';
import { testRouteKey } from '../support/test-kernel.ts';
import { linkProjection } from '../../src/semantic/links.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';

let native: NativeProfileFixture;
let owner: NativeProfileFixture['owner'];
const deniedOwnerChecks: unknown[] = [];
const statement = (property: string, content: string) => ({
  property: { id: property },
  value: { type: 'value', content },
});
async function send(method: string, path: string, body?: unknown, status = 200, key = entryKey(), as?: string) {
  const response = await native.send(as ?? owner.bearer, method, path, body, key);
  const result = await response.json();
  expect({ status: response.status, result }).toEqual({ status, result: expect.any(Object) });
  return result;
}
async function create(type: string, name: string, parent?: string, ordinal?: string) {
  const result = await send(
    'POST',
    '/v1/subjects',
    {
      type,
      labels: { en: name },
      statements: {
        ...(parent ? { 'schema:isPartOf': [statement('schema:isPartOf', parent)] } : {}),
        ...(ordinal ? { 'schema:episodeNumber': [statement('schema:episodeNumber', ordinal)] } : {}),
      },
    },
    201,
  );
  const projection = linkProjection(native.pool);
  for (let step = 0; step < 100; step++) {
    const resultProjection = await projection.run(partitionOf(routeOf(result.subject.id)!));
    if (resultProjection.status !== 'busy' && resultProjection.envelopes === 0) return result.subject;
  }
  throw new Error('Episode fixture link projection did not drain');
}
async function session(parent: string) {
  return (
    await send('POST', '/v1/progressSessions', { subjectId: parent, mode: 'scalar_amount', unit: 'episode' }, 201)
  ).progressSession;
}
const inspect = (sessionId: string, ids: string[]) =>
  send('GET', `/v1/progressSessions/${sessionId}/episodes?ids=${ids.join(',')}`);

beforeAll(async () => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  pool.on('connect', (client) => {
    client.query = new Proxy(client.query, {
      apply(query, receiver, args) {
        const result = Reflect.apply(query, receiver, args);
        if (!Array.isArray(args[1]) || !args[1].includes('progress_session:update') || !result?.then) return result;
        return result.then((value: pg.QueryResult) => {
          if (value.rows.some((row) => row.allowed === false))
            deniedOwnerChecks.push({ parameters: args[1], rows: value.rows });
          return value;
        });
      },
    });
  });
  native = await createProfileEntryFixture({ pool, singleConnection: true });
  owner = await native.identity([
    'subject:create',
    'subject:read',
    'statement:propose',
    'progress_session:create',
    'progress_session:read',
    'progress_session:update',
  ]);
  await native.activate(await native.publish(bundledRelease));
  await send('POST', '/v1/platform/exposure/reading_progress:open', undefined, 200, entryKey(), native.steward.bearer);
}, 120_000);
afterAll(async () => {
  await native?.close();
});

test('canonical intents reject ordinal tokens, duplicate/overlapping IDs and mixed clear', () => {
  expect(() => episodeIds(['1', '3'])).toThrow();
  expect(() => episodeIntent({ revision: 1, clear: true, add: [] })).toThrow();
  expect(() => episodeIntent({ revision: 1, add: [] })).toThrow();
  expect(() => episodeIntent({ revision: 1, add: null })).toThrow();
  expect(() => episodeIntent({ revision: 1, clear: false })).toThrow();
});

test('mounted native journey retains holes, specials, independent sessions, retry identity and manual progress', async () => {
  const parent = await create('schema:TVSeries', 'Canonical episode journey');
  const one = await create('schema:Episode', 'First', parent.id, '1');
  const two = await create('schema:Episode', 'Second', parent.id, '2');
  const three = await create('schema:Episode', 'Third', parent.id, '3');
  const special = await create('schema:Episode', 'Special', parent.id, '1');
  const otherParent = await create('schema:TVSeries', 'Unrelated series');
  const foreign = await create('schema:Episode', 'Foreign', otherParent.id, '1');
  const first = await session(parent.id),
    reread = await session(parent.id);
  await send('POST', `/v1/progressSessions/${reread.id}:record`, { revision: 1, amount: '0' });
  const path = `/v1/progressSessions/${first.id}`;
  const body = { revision: 1, add: [one.id, three.id, special.id] };
  const retryKey = entryKey();
  const client = createKernelClient('http://kernel.test', {
    headers: { authorization: `Bearer ${owner.bearer}` },
    fetch: Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init),
          url = new URL(request.url);
        return native.sendWithHeaders(
          owner.bearer,
          request.method,
          url.pathname + url.search,
          request.method === 'GET' ? undefined : await request.json(),
          request.headers,
        );
      },
      { preconnect: fetch.preconnect },
    ),
  });
  const wire = client.progressSessions({ sessionId: first.id });
  const written = await wire.$recordEpisodes.post(body, { headers: { 'idempotency-key': JSON.stringify(retryKey) } });
  expect({ status: written.status, deniedOwnerChecks }).toEqual({ status: 200, deniedOwnerChecks: [] });
  expect(written.data).toEqual({ revision: 2 });
  expect(await send('POST', `${path}:recordEpisodes`, body, 200, retryKey)).toEqual({ revision: 2 });
  await send('POST', `${path}:recordEpisodes`, { revision: 1, add: [two.id] }, 409);
  await send('POST', `${path}:recordEpisodes`, { revision: 2, add: [foreign.id] }, 404);
  await send('POST', `${path}:recordEpisodes`, { revision: 2, add: [parent.id] }, 404);
  await send('POST', `${path}:recordEpisodes`, { revision: 2, add: [one.id, one.id] }, 400);
  await send('POST', `${path}:recordEpisodes`, { revision: 2, add: [one.id], remove: [one.id] }, 400);
  const ids = [one.id, two.id, three.id, special.id];
  const viaClient = await wire.episodes.get({ query: { ids: ids.join(',') } });
  expect(viaClient.status).toBe(200);
  const shown = viaClient.data!;
  expect(shown.episodes).toEqual(
    ids.map((id, index) => ({
      episodeSubjectId: id,
      completed: index !== 1,
      membership: 'member',
      ordinal: ['1', '2', '3', '1'][index]!,
    })),
  );
  expect((await inspect(reread.id, ids)).episodes.every((row: { completed: boolean }) => row.completed === false)).toBe(
    true,
  );
  const manual = (await send('GET', path)).progressSession;
  expect(manual).toMatchObject({ amount: null, completedUnitCount: 0, revision: 2 });
  await send('POST', `${path}:record`, { revision: 2, amount: '9' });
  expect((await inspect(first.id, ids)).episodes).toEqual(shown.episodes);
  await send('POST', `${path}:recordEpisodes`, { revision: 3, remove: [three.id], add: [two.id] });
  expect((await inspect(first.id, ids)).episodes.map((row: { completed: boolean }) => row.completed)).toEqual([
    true,
    true,
    false,
    true,
  ]);
  const page = await send('GET', `${path}/episodes?limit=1`);
  expect(page.episodes).toHaveLength(1);
  expect(page.next).toBeString();
  await send(
    'GET',
    `/v1/progressSessions/${reread.id}/episodes?cursor=${encodeURIComponent(page.next)}`,
    undefined,
    400,
  );
  const alien = await native.identity(['progress_session:read', 'progress_session:update']);
  await send('GET', `${path}/episodes`, undefined, 404, entryKey(), alien.bearer);
  await send('POST', `${path}:recordEpisodes`, { revision: 4, clear: true }, 404, entryKey(), alien.bearer);
  await send('POST', `${path}:recordEpisodes`, { revision: 4, clear: true });
  await send('GET', `${path}/episodes?cursor=${encodeURIComponent(page.next)}`, undefined, 409);
  expect((await send('GET', `${path}/episodes`)).episodes).toEqual([]);
  expect((await send('GET', path)).progressSession).toMatchObject({ amount: '9', completedUnitCount: 0, revision: 5 });
});

test('catalogue withdrawal and concealment retain facts while correction and exact replay remain available', async () => {
  const parent = await create('schema:TVSeries', 'Lifecycle');
  const episode = await create('schema:Episode', 'Lifecycle episode', parent.id, 'SP');
  const first = await session(parent.id),
    path = `/v1/progressSessions/${first.id}`;
  const retryKey = entryKey(),
    body = { revision: 1, add: [episode.id] };
  const commands = createEpisodeProgressCommands({
    pool: native.pool,
    access: native.access,
    tokens: native.tokens,
    routeKey: testRouteKey(),
  });
  expect((await commands.recordEpisodes(owner.actor, first.id, body, retryKey)).value).toEqual({ revision: 2 });
  // Removing the admitted parent statement changes current membership, never the personal fact.
  const relation = episode.statements['schema:isPartOf'][0].id;
  await send(
    'POST',
    `/v1/subjects/${episode.id}/candidates/${relation}:hide`,
    { reason: 'Episode membership withdrawn' },
    200,
    entryKey(),
    native.steward.bearer,
  );
  expect((await inspect(first.id, [episode.id])).episodes).toEqual([
    { episodeSubjectId: episode.id, completed: true, membership: 'detached', ordinal: 'SP' },
  ]);
  await send('POST', `${path}:recordEpisodes`, { revision: 2, add: [episode.id] }, 404);
  await send(
    'POST',
    `/v1/subjects/${episode.id}:hide`,
    { reason: 'Concealed episode' },
    200,
    entryKey(),
    native.steward.bearer,
  );
  const concealed = await send('GET', `${path}/episodes`);
  expect(concealed.episodes).toEqual([
    { episodeSubjectId: null, completed: null, membership: 'unavailable', ordinal: null },
  ]);
  expect(JSON.stringify(concealed)).not.toContain(episode.id);
  expect(await send('POST', `${path}:recordEpisodes`, body, 200, retryKey)).toEqual({ revision: 2 });
  // Rollback to a release without this current profile cannot rewrite or prevent clearing.
  await native.activate(native.replacementDigest);
  await send('POST', `${path}:recordEpisodes`, { revision: 2, remove: [episode.id] });
  expect((await send('GET', `${path}/episodes`)).episodes).toEqual([]);
});
