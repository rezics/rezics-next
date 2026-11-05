import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Compile } from 'typebox/compile';
import {
  collectionPublicationStatusSchema,
  collectionPublishQueryRequestSchema,
} from '../../src/library/collection-publication-http.ts';
import { routeOf } from '../../src/route/route.ts';
import { createCollectionRulesFixture, type CollectionRulesFixture } from './support/collection-rules-fixture.ts';

test('whole-query input is closed, never coerces revision, and cannot select an owner or subset', () => {
  const input = Compile(collectionPublishQueryRequestSchema);
  expect(input.Check({ revision: 0, visibility: 'unlisted' })).toBe(true);
  expect(input.Check({ revision: 1, visibility: 'public' })).toBe(true);
  for (const body of [
    { revision: '1', visibility: 'public' },
    { revision: -1, visibility: 'public' },
    { revision: 1.5, visibility: 'public' },
    { revision: 1, visibility: 'private' },
    { revision: 1 },
    { revision: 1, visibility: 'public', subjectIds: [] },
    { revision: 1, visibility: 'public', ownerAccountId: randomUUID() },
    { revision: 1, visibility: 'public', filter: { owner: { presence: true } } },
  ])
    expect(input.Check(body)).toBe(false);
});

test('status grammar requires a completed reference only for complete and excludes internal creation data', () => {
  const status = Compile(collectionPublicationStatusSchema);
  const common = { id: randomUUID(), collectionId: randomUUID(), visibility: 'public' };
  const publication = { generation: randomUUID() };
  for (const phase of ['staging', 'awaiting_activation', 'refused']) {
    expect(status.Check({ ...common, phase })).toBe(true);
    expect(status.Check({ ...common, phase, publication })).toBe(false);
  }
  expect(status.Check({ ...common, phase: 'complete' })).toBe(false);
  const complete = { ...common, phase: 'complete', publication };
  expect(status.Check(complete)).toBe(true);
  for (const field of ['source', 'initiator', 'durableInitiator', 'rule', 'pins', 'custody', 'itemCount', 'selected'])
    expect(status.Check({ ...complete, [field]: {} })).toBe(false);
  expect(status.Check({ ...complete, publication: { ...publication, members: '0' } })).toBe(false);
});

describe('native whole-query publication through the existing default worker', () => {
  let f: CollectionRulesFixture;
  beforeAll(async () => {
    f = await createCollectionRulesFixture();
  }, 120_000);
  afterAll(async () => {
    await f?.close();
  });

  test('a curator requests and inspects an actual whole-query publication with current denial and exact retry', async () => {
    const subjectIds = [await f.subject('Whole-query first match'), await f.subject('Whole-query second match')];
    for (const subjectId of subjectIds) await f.entry(subjectId);
    const created = await f.send('POST', '/v1/collections', {
      membershipKind: 'dynamic',
      title: 'Whole-query publication',
      visibility: 'private',
      rule: { filter: { owner: { presence: true } } },
    });
    expect(created.status).toBe(201);
    const collection = (await created.json()).collection as { id: string; revision: number };
    const path = `/v1/collections/${collection.id}:publish`;
    const input = { revision: collection.revision, visibility: 'unlisted' };
    const key = randomUUID();
    const accepted = await f.send('POST', path, input, f.owner, key);
    expect(accepted.status).toBe(202);
    expect(accepted.headers.get('cache-control')).toBe('private, no-store');
    const progress = await accepted.json();
    expect(progress).toMatchObject({ collectionId: collection.id, visibility: 'unlisted' });
    expect(['staging', 'awaiting_activation']).toContain(progress.phase);
    expect(progress).not.toHaveProperty('publication');
    expect(Compile(collectionPublicationStatusSchema).Check(progress)).toBe(true);
    const retry = await f.send('POST', path, input, f.owner, key);
    expect([200, 202]).toContain(retry.status);
    expect((await retry.json()).id).toBe(progress.id);
    expect((await f.send('POST', path, input, f.reduced, key)).status).toBe(403);
    expect((await f.send('POST', path, input, f.other, key)).status).toBe(404);
    expect((await f.send('POST', path, input, null, key)).status).toBe(401);
    const statusPath = `/v1/collectionPublications/${progress.id}`;
    expect((await f.send('GET', statusPath, undefined, f.other)).status).toBe(404);
    expect((await f.send('GET', statusPath, undefined, f.reduced)).status).toBe(403);

    // Observe the existing fixture's actual default worker; never drive or replace its steps.
    let complete;
    for (let attempt = 0; attempt < 100; attempt++) {
      const response = await f.send('GET', statusPath);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      const status = await response.json();
      expect(Compile(collectionPublicationStatusSchema).Check(status)).toBe(true);
      expect(status.id).toBe(progress.id);
      expect(status.phase).not.toBe('refused');
      if (status.phase === 'complete') {
        complete = status;
        break;
      }
      expect(status).not.toHaveProperty('publication');
      await Bun.sleep(10);
    }
    expect(complete).toBeDefined();
    const members = await f.database.admin.query<{ subjectId: string }>(
      `SELECT subject_id::text AS "subjectId" FROM library.collection_source_output_member
       WHERE route=$1 AND collection_id=$2 AND generation=$3 ORDER BY subject_id LIMIT 3`,
      [routeOf(collection.id), collection.id, complete.publication.generation],
    );
    expect(members.rows.map((row) => row.subjectId)).toEqual([...subjectIds].sort());
    const receipt = await f.database.admin.query(
      `SELECT generation::text FROM library.collection_source_output_publication
       WHERE route=$1 AND collection_id=$2 AND generation=$3`,
      [routeOf(collection.id), collection.id, complete.publication.generation],
    );
    expect(receipt.rows).toEqual([{ generation: complete.publication.generation }]);
    // The completed generation must be useful to its public consumers, not only visible in native tables.
    for (const persona of [null, f.other]) {
      const detail = await f.send('GET', `/v1/collections/${collection.id}`, undefined, persona);
      expect(detail.status).toBe(200);
      const body = await detail.json();
      expect(body.collection.visibility).toBe('unlisted');
      const page = await f.send('GET', `/v1/collections/${collection.id}/members`, undefined, persona);
      expect(page.status).toBe(200);
      const output = await page.json();
      expect(output.members.map((member: { subjectId: string }) => member.subjectId).sort()).toEqual(
        [...subjectIds].sort(),
      );
      expect(output.next).toBeNull();
    }
  }, 120_000);
});
