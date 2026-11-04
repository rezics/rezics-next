import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';
import { createKernelClient } from '@rezics/client';
import { bundledRelease } from '@rezics/definitions/bundled';
import { createEpisodeProgressCommands, episodeIds, episodeIntent } from '../../src/library/episode-progress.ts';
import { testRouteKey } from '../support/test-kernel.ts';
import { linkProjection } from '../../src/semantic/links.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';

let native: NativeProfileFixture;
let owner: NativeProfileFixture['owner'];
let bundledDigest: string;
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
  native = await createProfileEntryFixture({ singleConnection: true });
  owner = await native.identity([
    'subject:create',
    'subject:read',
    'statement:propose',
    'progress_session:create',
    'progress_session:read',
    'progress_session:update',
  ]);
  bundledDigest = await native.publish(bundledRelease);
  await native.activate(bundledDigest);
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
  const unnumbered = await create('schema:Episode', 'Unnumbered', parent.id);
  const otherParent = await create('schema:TVSeries', 'Unrelated series');
  const foreign = await create('schema:Episode', 'Foreign', otherParent.id, '1');
  const first = await session(parent.id),
    reread = await session(parent.id);
  await send('POST', `/v1/progressSessions/${reread.id}:record`, { revision: 1, amount: '0' });
  const path = `/v1/progressSessions/${first.id}`;
  const body = { revision: 1, add: [one.id, three.id, special.id] };
  const retryKey = entryKey();
  let loseAcknowledgement = true;
  const client = createKernelClient('http://kernel.test', {
    headers: { authorization: `Bearer ${owner.bearer}` },
    fetch: Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init),
          url = new URL(request.url);
        const response = await native.sendWithHeaders(
          owner.bearer,
          request.method,
          url.pathname + url.search,
          request.method === 'GET' ? undefined : await request.json(),
          request.headers,
        );
        if (url.pathname.endsWith(':recordEpisodes') && loseAcknowledgement) {
          loseAcknowledgement = false;
          throw new Error('simulated lost acknowledgement');
        }
        return response;
      },
      { preconnect: fetch.preconnect },
    ),
  });
  const wire = client.progressSessions({ sessionId: first.id });
  await expect(
    wire.$recordEpisodes.post(body, { headers: { 'idempotency-key': JSON.stringify(retryKey) } }),
  ).rejects.toThrow('simulated lost acknowledgement');
  const written = await wire.$recordEpisodes.post(body, { headers: { 'idempotency-key': JSON.stringify(retryKey) } });
  expect(written.status).toBe(200);
  expect(written.data).toEqual({ revision: 2 });
  await send('POST', `${path}:recordEpisodes`, { revision: 1, add: [two.id] }, 409);
  await send('POST', `${path}:recordEpisodes`, { revision: 2, add: [foreign.id] }, 404);
  await send('POST', `${path}:recordEpisodes`, { revision: 2, add: [parent.id] }, 404);
  await send('POST', `${path}:recordEpisodes`, { revision: 2, add: [one.id, one.id] }, 400);
  await send('POST', `${path}:recordEpisodes`, { revision: 2, add: [one.id], remove: [one.id] }, 400);
  const parentView = await client.subjects({ id: parent.id }).get();
  expect(parentView.status).toBe(200);
  const membershipPage = (cursor?: string) =>
    client.subjects({ id: parent.id }).links.get({
      query: {
        property: 'schema:isPartOf',
        context: parentView.data!.subject.context,
        language: 'en',
        limit: 2,
        ...(cursor ? { cursor } : {}),
      },
    });
  const firstPage = await membershipPage();
  expect(firstPage.status).toBe(200);
  expect(firstPage.data!.links).toHaveLength(2);
  const middlePage = await membershipPage(firstPage.data!.next!);
  expect(middlePage.status).toBe(200);
  expect(middlePage.data!.links).toHaveLength(2);
  const endPage = await membershipPage(middlePage.data!.next!);
  expect(endPage.status).toBe(200);
  expect(endPage.data!.links).toHaveLength(1);
  expect(endPage.data!.next).toBeNull();
  const ids = [firstPage, middlePage, endPage].flatMap((page) => page.data!.links.map((link) => link.subject));
  expect(new Set(ids)).toEqual(new Set([one.id, two.id, three.id, special.id, unnumbered.id]));
  expect(ids.slice(2)).toContain(endPage.data!.links[0]!.subject);
  const viaClient = await wire.episodes.get({ query: { ids: ids.join(',') } });
  expect(viaClient.status).toBe(200);
  const shown = viaClient.data!;
  expect(shown.episodes.map((row) => row.episodeSubjectId)).toEqual(ids);
  const inspected = new Map(shown.episodes.map((row) => [row.episodeSubjectId, row]));
  expect(inspected.get(one.id)).toMatchObject({ completed: true, membership: 'member', ordinal: '1' });
  expect(inspected.get(two.id)).toMatchObject({ completed: false, membership: 'member', ordinal: '2' });
  expect(inspected.get(three.id)).toMatchObject({ completed: true, membership: 'member', ordinal: '3' });
  expect(inspected.get(special.id)).toMatchObject({ completed: true, membership: 'member', ordinal: '1' });
  expect(inspected.get(unnumbered.id)).toMatchObject({ completed: false, membership: 'member', ordinal: null });
  expect((await inspect(reread.id, ids)).episodes.every((row: { completed: boolean }) => row.completed === false)).toBe(
    true,
  );
  const manual = (await send('GET', path)).progressSession;
  expect(manual).toMatchObject({ amount: null, completedUnitCount: 0, revision: 2 });
  await send('POST', `${path}:record`, { revision: 2, amount: '9' });
  expect((await inspect(first.id, ids)).episodes).toEqual(shown.episodes);
  await send('POST', `${path}:recordEpisodes`, { revision: 3, remove: [three.id], add: [two.id] });
  expect((await inspect(first.id, ids)).episodes.map((row: { completed: boolean }) => row.completed)).toEqual([
    ...ids.map((id) => id === one.id || id === two.id || id === special.id),
  ]);
  expect((await inspect(first.id, [two.id])).episodes[0]).toMatchObject({ membership: 'member', completed: true });
  const twoParentStatement = two.statements['schema:isPartOf'][0]!.id;
  await send(
    'POST',
    `/v1/subjects/${two.id}/candidates/${twoParentStatement}:hide`,
    { reason: 'Episode membership withdrawn after inspection' },
    200,
    entryKey(),
    native.steward.bearer,
  );
  await send('POST', `${path}:recordEpisodes`, { revision: 4, add: [two.id] }, 404);
  const page = await send('GET', `${path}/episodes?limit=1`);
  expect(page.episodes).toHaveLength(1);
  expect(page.next).toBeString();
  const deep = await send('GET', `${path}/episodes?limit=1&cursor=${encodeURIComponent(page.next)}`);
  expect(deep.episodes).toHaveLength(1);
  expect(deep.next).toBeString();
  const end = await send('GET', `${path}/episodes?limit=1&cursor=${encodeURIComponent(deep.next)}`);
  expect(end.episodes).toHaveLength(1);
  expect(end.next).toBeNull();
  expect(
    new Set(
      [page, deep, end].flatMap((value) =>
        value.episodes.map((row: { episodeSubjectId: string }) => row.episodeSubjectId),
      ),
    ),
  ).toEqual(new Set([one.id, two.id, special.id]));
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
  const retainedKey = entryKey(),
    retained = { revision: 5, add: [one.id] };
  await send('POST', `${path}:recordEpisodes`, retained, 200, retainedKey);
  await send('POST', `${path}:complete`, { revision: 6 });
  await send('POST', `${path}:reopen`, { revision: 7 });
  expect((await inspect(first.id, [one.id])).episodes[0]).toMatchObject({ completed: true });
  await send('POST', `${path}:retire`, { revision: 8 });
  await send('GET', `${path}/episodes`, undefined, 404);
  await send('GET', `${path}/episodes?ids=${one.id}`, undefined, 404);
  expect((await send('GET', `${path}?presentation=FULL`)).progressSession).toMatchObject({
    state: 'retired',
    presentation: { meaning: 'known', recording: { state: 'supported' } },
  });
  await send('POST', `${path}:recordEpisodes`, { revision: 9, add: [two.id] }, 404);
  await send('POST', `${path}:recordEpisodes`, { revision: 9, clear: true }, 404);
  expect(await send('POST', `${path}:recordEpisodes`, retained, 200, retainedKey)).toEqual({ revision: 6 });
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
  expect((await send('GET', `${path}?presentation=FULL`)).progressSession).toMatchObject({
    state: 'active',
    presentation: { meaning: 'known', recording: { state: 'unsupported' } },
  });
  await send('POST', `${path}:recordEpisodes`, { revision: 2, add: [episode.id] }, 422);
  await send('POST', `${path}:recordEpisodes`, { revision: 2, remove: [episode.id] });
  expect((await send('GET', `${path}/episodes`)).episodes).toEqual([]);
});

test('concealed parent redacts retained Episode identity and refuses fresh completion', async () => {
  await native.activate(bundledDigest);
  const parent = await create('schema:TVSeries', 'Concealed parent');
  const episode = await create('schema:Episode', 'Private child', parent.id, '1');
  const current = await session(parent.id),
    path = `/v1/progressSessions/${current.id}`;
  await send('POST', `${path}:recordEpisodes`, { revision: 1, add: [episode.id] });
  await send(
    'POST',
    `/v1/subjects/${parent.id}:hide`,
    { reason: 'Concealed parent' },
    200,
    entryKey(),
    native.steward.bearer,
  );
  const concealed = await inspect(current.id, [episode.id]);
  expect(concealed.episodes).toEqual([
    { episodeSubjectId: null, completed: null, membership: 'unavailable', ordinal: null },
  ]);
  expect(JSON.stringify(concealed)).not.toContain(episode.id);
  await send('POST', `${path}:recordEpisodes`, { revision: 2, add: [episode.id] }, 404);
  expect((await send('GET', path)).progressSession.revision).toBe(2);
});
