import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { createPool } from '../../src/database/pool.ts';
import { createCollectionRulesFixture, type CollectionRulesFixture } from './support/collection-rules-fixture.ts';
import { createReleasedLibraryPopulation } from './support/released-library-population.ts';
import { discoveryKey, discoveryStatement } from '../support/released-discovery.ts';

let f: CollectionRulesFixture;
beforeAll(async () => {
  f = await createCollectionRulesFixture();
}, 120_000);
afterAll(async () => {
  await f?.close();
});

const draft = {
  membershipKind: 'dynamic',
  title: 'A private definition',
  visibility: 'private',
  rule: { filter: { owner: { presence: true } }, sort: 'id' },
};

test('saving a supported native rule admits the definition without claiming a completed result', async () => {
  const key = randomUUID();
  const created = await f.send('POST', '/v1/collections', draft, f.owner, key);
  expect(created.status).toBe(201);
  const body = await created.json();
  expect(body.collection).toMatchObject({ membershipKind: 'dynamic', visibility: 'private', revision: 1 });
  for (const field of ['members', 'next', 'preparing', 'publication', 'rule', 'filter', 'pins', 'memberCount'])
    expect(body).not.toHaveProperty(field);
  const definition = await f.send('GET', `/v1/collections/${body.collection.id}/rule`);
  expect(definition.status).toBe(200);
  expect((await definition.json()).rule).toMatchObject(draft.rule);
  expect((await f.send('POST', '/v1/collections', draft, f.reduced, key)).status).toBe(403);
  expect((await f.send('POST', '/v1/collections', { ...draft, rule: { ...draft.rule, sort: 'ordinal' } })).status).toBe(
    422,
  );
}, 120_000);

test('a catalogue source is retained and executes through current Search membership without Library facts', async () => {
  const source = { kind: 'catalogue' } as const;
  const catalogueBook = await f.subject('Catalogue book without a Library entry');
  const libraryMovie = await f.subject('Nonmatching Library movie', 'schema:Movie');
  await f.entry(libraryMovie, 'schema:Movie');
  const created = await f.send('POST', '/v1/collections', {
    ...draft,
    rule: { filter: { type: { in: ['schema:Book'] } }, sort: 'id', source },
  });
  expect(created.status).toBe(201);
  const { collection } = await created.json();
  const saved = await f.send('GET', `/v1/collections/${collection.id}/rule`);
  expect(saved.status).toBe(200);
  expect(await saved.json()).toMatchObject({
    rule: { filter: { type: { in: ['schema:Book'] } }, sort: 'id', source, revision: 1 },
  });

  const members = await f.send('GET', `/v1/collections/${collection.id}/members`);
  expect(members.status).toBe(200);
  const firstPage = await members.json();
  expect(firstPage.members).toContainEqual({ kind: 'dynamic', subjectId: catalogueBook });
  expect(firstPage.members).not.toContainEqual({ kind: 'dynamic', subjectId: libraryMovie });

  const update = {
    revision: collection.revision,
    filter: { not: { type: { in: ['schema:Book'] } } },
    sort: 'id',
    source,
  };
  const key = randomUUID();
  const edited = await f.send('PUT', `/v1/collections/${collection.id}/rule`, update, f.owner, key);
  expect(edited.status).toBe(200);
  expect((await edited.json()).collection.revision).toBe(2);
  expect((await f.send('PUT', `/v1/collections/${collection.id}/rule`, update, f.owner, key)).status).toBe(200);
  const reopened = await f.send('GET', `/v1/collections/${collection.id}/rule`);
  expect(await reopened.json()).toMatchObject({
    rule: { filter: { not: { type: { in: ['schema:Book'] } } }, source, revision: 2, collectionRevision: 2 },
  });

  const notBooks = await f.send('GET', `/v1/collections/${collection.id}/members`);
  expect(notBooks.status).toBe(200);
  const secondPage = await notBooks.json();
  expect(secondPage.members).toContainEqual({ kind: 'dynamic', subjectId: libraryMovie });
  expect(secondPage.members).not.toContainEqual({ kind: 'dynamic', subjectId: catalogueBook });
}, 120_000);

test('catalogue selected publication uses pinned Search membership and activates only the explicitly selected current result', async () => {
  let runtimePool: ReturnType<typeof createPool> | undefined;
  const population = await createReleasedLibraryPopulation({
    version: 1,
    search: 'native',
    kernelPool: (url) => (runtimePool = createPool(url)),
  });
  try {
    const { base, request } = population;
    const books = await base.books();
    const catalogueMatch = books.subjects['B-long'];
    const libraryOnlyBeforeMatch = await base.createSubject('schema:Book', 'Library Subject before catalogue property');
    await base.catchUp([libraryOnlyBeforeMatch]);
    const active = population
      .profile('schema:Book')
      .profile.entryStateSet?.states.find((state) => state.role === 'active');
    if (!active) throw new Error('Released Book active Library state is required');
    const entry = await request(
      'alice',
      'PUT',
      `/v1/libraryEntries/${libraryOnlyBeforeMatch.id}`,
      { state: active.id },
      discoveryKey(),
    );
    expect(entry.status).toBe(201);

    const filter = {
      and: [
        { type: { in: ['schema:Book'] } },
        { statement: { property: 'schema:wordCount', range: { gte: 1000001, unit: '1' } } },
      ],
    };
    const create = await request(
      'alice',
      'POST',
      '/v1/collections',
      {
        membershipKind: 'dynamic',
        visibility: 'private',
        title: 'Pinned catalogue selection',
        rule: { filter, sort: 'id', source: { kind: 'catalogue' } },
      },
      discoveryKey(),
    );
    expect(create.status).toBe(201);
    const collection = (create.body as { collection: { id: string; revision: number } }).collection;
    const reopened = await request('alice', 'GET', `/v1/collections/${collection.id}/rule`);
    expect(reopened.status).toBe(200);
    expect(reopened.body).toMatchObject({
      rule: { filter, sort: 'id', source: { kind: 'catalogue' }, revision: 1 },
    });

    const privateBefore = await request('alice', 'GET', `/v1/collections/${collection.id}/members`);
    expect(privateBefore.status).toBe(200);
    expect((privateBefore.body as { members: { subjectId: string }[] }).members.map(({ subjectId }) => subjectId)).toEqual(
      [catalogueMatch.id],
    );

    const originalInput = { revision: collection.revision, subjectIds: [catalogueMatch.id] };
    const originalKey = discoveryKey();
    const first = await request(
      'alice',
      'POST',
      `/v1/collections/${collection.id}:publishSelected`,
      originalInput,
      originalKey,
    );
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ publication: { state: 'complete', itemCount: 1 } });
    const exactReplay = await request(
      'alice',
      'POST',
      `/v1/collections/${collection.id}:publishSelected`,
      originalInput,
      originalKey,
    );
    expect(exactReplay.status).toBe(200);
    expect(exactReplay.body).toEqual(first.body);
    expect(
      (
        await request(
          'bob',
          'POST',
          `/v1/collections/${collection.id}:publishSelected`,
          originalInput,
          originalKey,
        )
      ).status,
    ).toBe(404);

    const publicBeforeChange = await request('anonymous', 'GET', `/v1/collections/${collection.id}/members`);
    expect(publicBeforeChange.status).toBe(200);
    expect((publicBeforeChange.body as { members: { subjectId: string }[] }).members.map(({ subjectId }) => subjectId)).toEqual(
      [catalogueMatch.id],
    );

    await base.adopt(
      libraryOnlyBeforeMatch,
      discoveryStatement('schema:wordCount', { amount: '+1200001', unit: '1' }),
    );
    await base.catchUp([libraryOnlyBeforeMatch]);
    const currentViewQuery = new URLSearchParams({ filter: JSON.stringify(filter), sort: 'id', limit: '100' });
    const privateAfter = await request(
      'alice',
      'GET',
      `/v1/collections/${collection.id}/members?${currentViewQuery}`,
    );
    expect(privateAfter.status).toBe(200);
    expect((privateAfter.body as { members: { subjectId: string }[] }).members.map(({ subjectId }) => subjectId)).toEqual(
      [catalogueMatch.id, libraryOnlyBeforeMatch.id].sort(),
    );
    const publicUntilActivation = await request('anonymous', 'GET', `/v1/collections/${collection.id}/members`);
    expect(publicUntilActivation.status).toBe(200);
    expect(
      (publicUntilActivation.body as { members: { subjectId: string }[] }).members.map(({ subjectId }) => subjectId),
    ).toEqual([catalogueMatch.id]);

    const firstCollection = (first.body as { collection: { revision: number } }).collection;
    const activated = await request(
      'alice',
      'POST',
      `/v1/collections/${collection.id}:publishSelected`,
      { revision: firstCollection.revision, subjectIds: [libraryOnlyBeforeMatch.id] },
      discoveryKey(),
    );
    expect(activated.status).toBe(200);
    expect(activated.body).toMatchObject({ publication: { state: 'complete', itemCount: 1 } });
    const publicAfterActivation = await request('anonymous', 'GET', `/v1/collections/${collection.id}/members`);
    expect(publicAfterActivation.status).toBe(200);
    expect(
      (publicAfterActivation.body as { members: { subjectId: string }[] }).members.map(({ subjectId }) => subjectId),
    ).toEqual([libraryOnlyBeforeMatch.id]);

    const keys = [routeOf(collection.id), collection.id];
    const beforeRaceHead = (
      await base.inspect<{ generation: string; sourceGeneration: string }>(
        `SELECT generation::text,source_generation::text AS "sourceGeneration"
         FROM library.collection_source_output_head WHERE route=$1 AND collection_id=$2`,
        keys,
      )
    ).rows[0];
    expect(beforeRaceHead).toBeDefined();
    const beforeRaceMembers = (
      await base.inspect<{ subjectId: string }>(
        `SELECT subject_id::text AS "subjectId" FROM library.collection_source_output_member
         WHERE route=$1 AND collection_id=$2 AND generation=$3 ORDER BY subject_id`,
        [...keys, beforeRaceHead!.generation],
      )
    ).rows.map(({ subjectId }) => subjectId);
    const client = await runtimePool!.connect();
    const restorers: (() => void)[] = [];
    let reached!: () => void;
    const waiting = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const onAcquire = (connection: PoolClient) => {
      const original = connection.query;
      connection.query = function (...args: unknown[]) {
        const query = args[0] as string | { text: string };
        const sql = typeof query === 'string' ? query : query.text;
        if (sql.includes('curator_account_id=$3') && sql.includes('FOR UPDATE')) reached();
        return (original as (...values: unknown[]) => unknown).apply(connection, args);
      } as PoolClient['query'];
      restorers.push(() => {
        connection.query = original;
      });
    };
    let late: Promise<Awaited<ReturnType<typeof request>>> | undefined;
    try {
      await client.query('BEGIN');
      // The prepared catalogue observation is valid until this uncommitted fence lands at the final parent lock.
      await client.query(
        'UPDATE library.collection SET source_generation=source_generation+1 WHERE route=$1 AND collection_id=$2',
        keys,
      );
      runtimePool!.on('acquire', onAcquire);
      late = request(
        'alice',
        'POST',
        `/v1/collections/${collection.id}:publishSelected`,
        {
          revision: (activated.body as { collection: { revision: number } }).collection.revision,
          subjectIds: [libraryOnlyBeforeMatch.id],
        },
        discoveryKey(),
      );
      await Promise.race([
        waiting,
        late.then(() => {
          throw new Error('Catalogue publication did not reach its final source-fence compare');
        }),
      ]);
      await client.query('COMMIT');
      const refused = await late;
      expect(refused.status).toBe(409);
      const afterRaceHead = (
        await base.inspect<{ generation: string; sourceGeneration: string }>(
          `SELECT generation::text,source_generation::text AS "sourceGeneration"
           FROM library.collection_source_output_head WHERE route=$1 AND collection_id=$2`,
          keys,
        )
      ).rows[0];
      const afterRaceMembers = (
        await base.inspect<{ subjectId: string }>(
          `SELECT subject_id::text AS "subjectId" FROM library.collection_source_output_member
           WHERE route=$1 AND collection_id=$2 AND generation=$3 ORDER BY subject_id`,
          [...keys, afterRaceHead!.generation],
        )
      ).rows.map(({ subjectId }) => subjectId);
      expect(afterRaceHead).toEqual(beforeRaceHead);
      expect(afterRaceMembers).toEqual(beforeRaceMembers);
    } finally {
      await client.query('ROLLBACK');
      client.release();
      if (late) await late;
      runtimePool!.off('acquire', onAcquire);
      for (const restore of restorers.reverse()) restore();
    }
  } finally {
    await population.close();
  }
}, 180_000);

test('Saved dynamic definitions use actual shared admission while current dynamic readers distinguish private execution from explicit public output', async () => {
  const selected = await f.subject('Selected output');
  const matching = await f.subject('Matching private result outside the selection');
  await f.entry(selected);
  await f.entry(matching);
  const created = await f.send('POST', '/v1/collections', draft);
  expect(created.status).toBe(201);
  const { collection } = await created.json();
  expect((await f.page(collection.id)).members).toContainEqual({ kind: 'dynamic', subjectId: matching });
  expect((await f.send('GET', `/v1/collections/${collection.id}/members`, undefined, f.other)).status).toBe(404);
  const published = await f.send('POST', `/v1/collections/${collection.id}:publishSelected`, {
    revision: collection.revision,
    subjectIds: [selected],
  });
  expect(published.status).toBe(200);
  for (const bearer of [null, f.other]) {
    const response = await f.send('GET', `/v1/collections/${collection.id}/members`, undefined, bearer);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ members: [{ kind: 'dynamic', subjectId: selected }], next: null });
    const full = await f.send('GET', `/v1/collections/${collection.id}/members?view=FULL`, undefined, bearer);
    expect(full.status).toBe(200);
    expect((await full.json()).members).toMatchObject([{ kind: 'dynamic', subjectId: selected }]);
    expect((await f.send('GET', `/v1/collections/${collection.id}/rule`, undefined, bearer)).status).toBe(
      bearer === null ? 401 : 404,
    );
  }
  const changed = await f.send('PUT', `/v1/collections/${collection.id}/rule`, {
    revision: (await published.json()).collection.revision,
    filter: { not: { owner: { presence: true } } },
  });
  expect(changed.status).toBe(200);
  // The old COMPLETE selection belongs to its old source fence, not the edited definition.
  const unavailable = await f.send('GET', `/v1/collections/${collection.id}/members`, undefined, null);
  expect(unavailable.status).toBe(503);
  expect(await unavailable.json()).toMatchObject({ code: 'dependency_unavailable' });
}, 120_000);
