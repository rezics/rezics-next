import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mintReadTime } from '../../src/command/command.ts';
import { withConnection } from '../../src/database/pool.ts';
import {
  authorizeNativeCollectionMetadata,
  readNativeCollectionMetadata,
  readNativeCollectionRawOrdinalPage,
} from '../../src/library/collection-source-native.ts';
import {
  sourceRuntimeFixture,
  sourceAllowance,
  type SourceRuntimeFixture,
} from './support/canonical-source-runtime-fixture.ts';

let f: SourceRuntimeFixture;
beforeAll(async () => {
  f = await sourceRuntimeFixture();
}, 120000);
afterAll(async () => {
  await f?.close();
});

test('raw ordinal progress retains duplicate occurrences and settles deleted rows without disclosing their payload', async () => {
  const source = await f.collection('private', 'curated'),
    subjectId = await f.createSubject('game'),
    path = `/v1/collections/${source.collectionId}`;
  const memberIds: string[] = [];
  for (const note of ['retained private note', 'live private note']) {
    const response = await f.send(f.owner.bearer, 'POST', path + '/members', { subjectId, note });
    expect(response.status).toBe(201);
    memberIds.push((await response.json()).member.id);
  }
  const parent = await f.send(f.owner.bearer, 'GET', path);
  expect(parent.status).toBe(200);
  const revision = (await parent.json()).collection.revision;
  const deleted = await f.send(f.owner.bearer, 'DELETE', `${path}/members/${memberIds[0]}?revision=${revision}`);
  expect(deleted.status).toBe(204);
  const deadline = Date.now() + 30000;
  const { metadata } = await readNativeCollectionMetadata(f.pool, source, {
    deadline,
    allowance: sourceAllowance(),
  });
  if (!metadata) throw new Error('The native curated source must exist');
  const at = await withConnection(f.pool, (client) => mintReadTime(client));
  const authorized = await authorizeNativeCollectionMetadata(f.pool, metadata, {
    access: f.access,
    actor: f.owner.actor,
    at,
    deadline,
    allowance: sourceAllowance(),
  });
  expect(authorized.authorized).toBe(true);
  const page = await readNativeCollectionRawOrdinalPage(f.pool, metadata, {
    deadline,
    allowance: sourceAllowance(),
    after: null,
    limit: 2,
  });
  expect(page.rows.map((row) => row.memberId)).toEqual([memberIds[1]!, memberIds[0]!]);
  expect(page.rows.map((row) => row.subjectId)).toEqual([subjectId, subjectId]);
  expect(page.rows[0]?.deletionId).toBeNull();
  expect(page.rows[1]?.deletionId).toBe(deleted.headers.get('Library-Collection-Member-Deletion-Id'));
  expect(page.frontier.after).toEqual({
    ordinalKey: page.rows[1]!.ordinalKey,
    memberId: memberIds[0]!,
  });
  expect(page.work.used.candidateKeys).toBe(2);
  expect(page.exhausted).toBe(false);
  expect(JSON.stringify(page.rows)).not.toContain('private note');
  const end = await readNativeCollectionRawOrdinalPage(f.pool, metadata, {
    deadline,
    allowance: sourceAllowance(),
    after: page.frontier.after,
    limit: 2,
  });
  expect(end.rows).toEqual([]);
  expect(end.frontier).toEqual(page.frontier);
  expect(end.exhausted).toBe(true);
});
