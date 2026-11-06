import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { routeOf } from '../../src/route/route.ts';
import { createCollectionRulesFixture, type CollectionRulesFixture } from './support/collection-rules-fixture.ts';

// An explicit catalogue Source selects Search's public population. The curator's Library never supplies membership.
describe('native catalogue whole-query publication through the existing default worker', () => {
  let f: CollectionRulesFixture;
  beforeAll(async () => {
    f = await createCollectionRulesFixture();
  }, 120_000);
  afterAll(async () => {
    await f?.close();
  });

  async function catalogueCollection(title: string, type: string) {
    const created = await f.send('POST', '/v1/collections', {
      membershipKind: 'dynamic',
      title,
      visibility: 'private',
      rule: { filter: { type: { in: [type] } }, sort: 'id', source: { kind: 'catalogue' } },
    });
    expect(created.status).toBe(201);
    const { collection } = (await created.json()) as { collection: { id: string; revision: number } };
    const rule = await f.send('GET', `/v1/collections/${collection.id}/rule`);
    expect(await rule.json()).toMatchObject({ rule: { source: { kind: 'catalogue' } } });
    return collection;
  }

  async function publish(id: string, revision: number, key = randomUUID()) {
    return f.send('POST', `/v1/collections/${id}:publish`, { revision, visibility: 'unlisted' }, f.owner, key);
  }

  // Observes the fixture's default worker until the explicit publication completes; it never drives the steps.
  async function awaitComplete(progress: { id: string }) {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const response = await f.send('GET', `/v1/collectionPublications/${progress.id}`);
      expect(response.status).toBe(200);
      const status = await response.json();
      expect(status.phase).not.toBe('refused');
      if (status.phase === 'complete') return status as { publication: { generation: string } };
      if (Date.now() > deadline) throw new Error('Catalogue publication did not complete');
      await Bun.sleep(20);
    }
  }

  async function members(id: string, persona: string | null | undefined = undefined) {
    const page = await f.send('GET', `/v1/collections/${id}/members`, undefined, persona);
    expect(page.status).toBe(200);
    const body = await page.json();
    expect(body.next).toBeNull();
    return (body.members as { subjectId: string }[]).map((member) => member.subjectId).sort();
  }

  async function nativeOutput(id: string, generation: string) {
    const rows = await f.database.admin.query<{ subjectId: string }>(
      `SELECT subject_id::text AS "subjectId" FROM library.collection_source_output_member
       WHERE route=$1 AND collection_id=$2 AND generation=$3 ORDER BY subject_id`,
      [routeOf(id), id, generation],
    );
    return rows.rows.map((row) => row.subjectId);
  }

  test('a catalogue Source publishes the complete public population across pages, not the Library; A stays until republish', async () => {
    // Eighteen Subjects absent from the curator's Library exceed one 16-subject staging page.
    const matches: string[] = [];
    for (let index = 0; index < 18; index++)
      matches.push(await f.subject(`Catalogue book ${String(index).padStart(2, '0')}`));
    // A readable Library Subject that the catalogue rule does not match must not appear in any output.
    const outside = await f.subject('Library movie outside the catalogue rule', 'schema:Movie');
    await f.entry(outside, 'schema:Movie');
    const collection = await catalogueCollection('Catalogue books', 'schema:Book');
    const input = { revision: collection.revision, visibility: 'unlisted' };
    const key = randomUUID();
    const accepted = await publish(collection.id, collection.revision, key);
    expect(accepted.status).toBe(202);
    const progress = await accepted.json();
    expect(progress).toMatchObject({ collectionId: collection.id, visibility: 'unlisted' });
    expect(progress).not.toHaveProperty('publication');
    // An exact retry returns the same publication while the default worker is still staging it.
    const retry = await publish(collection.id, collection.revision, key);
    expect([200, 202]).toContain(retry.status);
    expect((await retry.json()).id).toBe(progress.id);
    expect((await f.send('POST', `/v1/collections/${collection.id}:publish`, input, null, key)).status).toBe(401);

    const complete = await awaitComplete(progress);
    const expected = [...matches].sort();
    expect(await nativeOutput(collection.id, complete.publication.generation)).toEqual(expected);
    expect(await members(collection.id, null)).toEqual(expected);
    expect(await members(collection.id, f.other)).toEqual(expected);

    // Working membership is live: a later catalogue match is visible to the curator, while public A is unchanged.
    const late = await f.subject('Catalogue book added after publication');
    expect(await members(collection.id)).toEqual([...expected, late].sort());
    expect(await members(collection.id, null)).toEqual(expected);

    const republished = await publish(collection.id, await currentRevision(collection.id));
    expect(republished.status).toBe(202);
    const next = await awaitComplete(await republished.json());
    const replaced = [...expected, late].sort();
    expect(await nativeOutput(collection.id, next.publication.generation)).toEqual(replaced);
    expect(await members(collection.id, null)).toEqual(replaced);
  }, 120_000);

  test('an owner Source with catalogue predicates publishes only the curator Library matches, never the whole catalogue', async () => {
    const owned = await f.subject('Owner book with a Library entry');
    await f.entry(owned);
    // A catalogue Book absent from the curator's Library and a Library Movie must both stay out of the owner population.
    await f.subject('Catalogue book absent from the owner Library');
    const movie = await f.subject('Owner movie outside the type predicate', 'schema:Movie');
    await f.entry(movie, 'schema:Movie');
    const created = await f.send('POST', '/v1/collections', {
      membershipKind: 'dynamic',
      title: 'Owner books',
      visibility: 'private',
      rule: { filter: { type: { in: ['schema:Book'] } }, sort: 'id' },
    });
    expect(created.status).toBe(201);
    const { collection } = (await created.json()) as { collection: { id: string; revision: number } };
    const accepted = await publish(collection.id, collection.revision);
    expect(accepted.status).toBe(202);
    const complete = await awaitComplete(await accepted.json());
    expect(await nativeOutput(collection.id, complete.publication.generation)).toEqual([owned]);
    expect(await members(collection.id, null)).toEqual([owned]);
    // The owner's working read may prepare first; the fixture's page helper observes that real preparation.
    const working = await f.page(collection.id);
    expect((working.members as { subjectId: string }[]).map((member) => member.subjectId)).toEqual([owned]);
  }, 120_000);

  test('a catalogue Source with no matching catalogue Subject completes as a true empty output', async () => {
    const collection = await catalogueCollection('Empty catalogue series', 'schema:TVSeries');
    const accepted = await publish(collection.id, collection.revision);
    expect(accepted.status).toBe(202);
    const complete = await awaitComplete(await accepted.json());
    expect(await nativeOutput(collection.id, complete.publication.generation)).toEqual([]);
    expect(await members(collection.id, null)).toEqual([]);
  }, 120_000);

  async function currentRevision(id: string) {
    const response = await f.send('GET', `/v1/collections/${id}`);
    expect(response.status).toBe(200);
    return (await response.json()).collection.revision as number;
  }
});
