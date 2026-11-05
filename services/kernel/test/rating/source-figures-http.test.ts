import { afterAll, beforeAll, expect, test } from 'bun:test';
import { sourceObservation } from '../../src/rating/source-provider.ts';
import { createSourceStatisticIsolationFixture } from './source-statistic-isolation-fixture.ts';

let fixture: Awaited<ReturnType<typeof createSourceStatisticIsolationFixture>>;
beforeAll(async () => {
  fixture = await createSourceStatisticIsolationFixture();
  await fixture.grantImporter(fixture.actors.importer);
  await fixture.grantImporter(fixture.actors.secondImporter);
}, 180_000);
afterAll(async () => {
  await fixture?.close();
});
const path = (id: string) => `/v1/subjects/${id}/source-statistics`;
const figures = () =>
  ({
    schemaVersion: 1,
    distribution: {
      unit: 'ratings',
      completeness: 'complete',
      bins: Array.from({ length: 10 }, (_, i) => ({ score: i + 1, count: i === 9 ? 17 : 0 })),
    },
    rank: { unit: 'subjects', position: 3, population: 100 },
  }) as const;
const value = () => ({
  sourceRecordId: '123',
  sourceAlias: 'permitted-bangumi',
  scale: { min: 0, max: 10 },
  mean: 10,
  count: 17,
  asOf: '2026-11-01',
  licence: 'LicenseRef-Authorized-Test',
  attribution: 'Bangumi users',
});
async function json(response: Response, status = 200): Promise<any> {
  const body = await response.text();
  if (response.status !== status) throw new Error(`Expected ${status}, received ${response.status}: ${body}`);
  return body ? JSON.parse(body) : null;
}
const write = (id: string, body: unknown, key = crypto.randomUUID(), actor = fixture.actors.importer) =>
  fixture.request('PUT', `${path(id)}/bangumi`, { actor, body, key });
const read = async (id: string) => json(await fixture.request('GET', path(id), { actor: null }));

test('one admitted provider row carries original bins, independent rank units and immutable provenance', async () => {
  const id = await fixture.createSubject();
  const body = { ...value(), figures: figures() };
  const key = crypto.randomUUID();
  const stored = await json(await write(id, body, key));
  expect(stored).toEqual({
    source: 'bangumi',
    ...body,
    observation: { kind: 'unversioned', digest: sourceObservation(id, 'bangumi', body).digest },
  });
  expect(await read(id)).toEqual([stored]);
  expect(await json(await write(id, body, key))).toEqual(stored);
  // A scalar-only provider remains byte-shape compatible and independent.
  const scalar = { ...value(), sourceRecordId: 'v123', sourceAlias: 'vndb', scale: { min: 1, max: 100 }, mean: 85 };
  const native = await json(
    await fixture.request('PUT', `${path(id)}/vndb`, {
      actor: fixture.actors.importer,
      key: crypto.randomUUID(),
      body: scalar,
    }),
  );
  expect(native.figures).toBeUndefined();
  expect((await read(id)).length).toBe(2);
  const partial = {
    ...body,
    asOf: '2026-11-02',
    figures: {
      schemaVersion: 1,
      distribution: { unit: 'ratings', completeness: 'partial', bins: [{ score: 10, count: 0 }] },
      rank: { unit: 'subjects', position: 3 },
    },
  };
  const updated = await json(await write(id, partial));
  expect(updated.figures).toEqual(partial.figures);
  expect(updated.figures.rank.population).toBeUndefined();
  expect(updated.observation.digest).not.toBe(stored.observation.digest);
  expect((await read(id))[0]).toEqual(updated);
  const scalarOnly = await json(await write(id, { ...value(), asOf: '2026-11-03' }));
  expect(scalarOnly.figures).toBeUndefined();
  const retained = await fixture.database.admin.query(
    'SELECT payload FROM rating.source_statistic_observation WHERE subject_id=$1 AND digest=$2',
    [id, stored.observation.digest],
  );
  expect(retained.rows[0].payload.figures).toEqual(body.figures);
});

test('invalid bins, counts, ranks, versions and provider figures cannot be published', async () => {
  const id = await fixture.createSubject();
  const complete = figures();
  for (const invalid of [
    { ...complete, schemaVersion: 2 },
    { ...complete, extra: 1 },
    { ...complete, distribution: { ...complete.distribution, bins: complete.distribution.bins.slice(1) } },
    {
      ...complete,
      distribution: { ...complete.distribution, bins: [...complete.distribution.bins, { score: 10, count: 0 }] },
    },
    { ...complete, distribution: { unit: 'ratings', completeness: 'partial', bins: [{ score: 0, count: 0 }] } },
    { ...complete, distribution: { unit: 'ratings', completeness: 'partial', bins: [{ score: 1, count: -1 }] } },
    { ...complete, distribution: { unit: 'ratings', completeness: 'partial', bins: [{ score: 1, count: 18 }] } },
    {
      ...complete,
      distribution: { ...complete.distribution, bins: complete.distribution.bins.map(() => ({ score: 1, count: 0 })) },
    },
    { ...complete, rank: { unit: 'subjects', position: 0 } },
    { ...complete, rank: { unit: 'subjects', position: 101, population: 100 } },
    { ...complete, rank: { unit: 'subjects', position: 1.5 } },
    { ...complete, rank: { unit: 'subjects', position: Number.MAX_SAFE_INTEGER + 1 } },
    { ...complete, rank: { unit: 'ratings', position: 3 } },
    { schemaVersion: 1 },
  ])
    await json(await write(id, { ...value(), figures: invalid }), 400);
  await json(await write(id, { ...value(), count: 18, figures: complete }), 400);
  await json(
    await fixture.request('PUT', `${path(id)}/vndb`, {
      actor: fixture.actors.importer,
      key: crypto.randomUUID(),
      body: { ...value(), figures: complete },
    }),
    400,
  );
  expect(await read(id)).toEqual([]);
});

test('same-time figure CAS, tombstones and current permission govern retries', async () => {
  const id = await fixture.createSubject();
  const body = { ...value(), figures: figures() };
  const first = await json(await write(id, body));
  const corrected = {
    ...body,
    figures: { ...body.figures, rank: { unit: 'subjects', position: 2 } },
    expectedObservation: first.observation.digest,
  };
  const competing = await Promise.all([
    write(id, corrected),
    write(
      id,
      { ...corrected, figures: { ...body.figures, rank: { unit: 'subjects', position: 4 } } },
      crypto.randomUUID(),
      fixture.actors.secondImporter,
    ),
  ]);
  expect(competing.map((r) => r.status).sort()).toEqual([200, 409]);
  const [current] = await read(id);
  const clear = {
    sourceAlias: body.sourceAlias,
    sourceRecordId: body.sourceRecordId,
    count: 0,
    asOf: '2026-11-02',
    expectedObservation: current.observation.digest,
  };
  await json(
    await fixture.request('POST', `${path(id)}/bangumi:clear`, {
      actor: fixture.actors.importer,
      key: crypto.randomUUID(),
      body: clear,
    }),
    204,
  );
  expect(await read(id)).toEqual([]);
  await json(await write(id, body), 409);
  const key = crypto.randomUUID();
  const fresh = { ...body, asOf: '2026-11-03' };
  await json(await write(id, fresh, key));
  await json(await write(id, fresh, crypto.randomUUID(), fixture.actors.author), 403);
  await fixture.revokeImporter(fixture.actors.importer);
  try {
    await json(await write(id, fresh, key), 403);
  } finally {
    await fixture.grantImporter(fixture.actors.importer);
  }
});
