import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mintReadTime } from '../../src/command/command.ts';
import { withConnection } from '../../src/database/pool.ts';
import { routeOf } from '../../src/route/route.ts';
import {
  readNativeCollectionMetadata,
  authorizeNativeCollectionMetadata,
  readNativeCollectionRawPage,
} from '../../src/library/collection-source-native.ts';
import { createProfileEntryFixture, type NativeProfileFixture, entryKey } from './support/profile-entry-fixture.ts';
let native: NativeProfileFixture;
beforeAll(async () => {
  native = await createProfileEntryFixture();
  const response = await native.send('steward', 'POST', '/v1/platform/exposure/collections:open');
  expect(response.status).toBe(200);
}, 120000);
afterAll(async () => {
  await native?.close();
});
const allowance = () => ({
  reservationId: entryKey(),
  remaining: {
    candidateKeys: 100,
    identityMetadataRows: 0,
    nativeRows: 1000000,
    nativePoints: 10000,
    witnessKeys: 10000,
    statements: 1000,
    bytes: 16 * 1024 * 1024,
    emptySeeks: 100,
  },
});
test('native Collection source primitives preserve current source authority and expose only charged raw membership evidence', async () => {
  const owner = await native.identity(['subject:read', 'collection:create', 'collection:read', 'collection:update']);
  const other = await native.identity(['subject:read', 'collection:read']);
  const created = await native.send(owner.bearer, 'POST', '/v1/collections', {
    title: 'Source private',
    visibility: 'private',
  });
  expect(created.status).toBe(201);
  const collectionId = (await created.json()).collection.id as string,
    subject = await native.createSubject('game');
  for (const note of ['first private note', 'second private note'])
    expect(
      (
        await native.send(owner.bearer, 'POST', '/v1/collections/' + collectionId + '/members', {
          subjectId: subject,
          note,
        })
      ).status,
    ).toBe(201);
  const ref = { route: routeOf(collectionId)!, collectionId },
    deadline = Date.now() + 30000;
  const observed = await readNativeCollectionMetadata(native.pool, ref, { deadline, allowance: allowance() });
  expect(observed.work.used.nativeRows).toBeGreaterThan(0);
  if (!observed.metadata) throw new Error('Actual source metadata is missing');
  const at = await withConnection(native.pool, (c) => mintReadTime(c, () => new Date()));
  expect(
    (
      await authorizeNativeCollectionMetadata(native.pool, observed.metadata, {
        access: native.access,
        actor: owner.actor,
        at,
        deadline,
        allowance: allowance(),
      })
    ).authorized,
  ).toBe(true);
  expect(
    (
      await authorizeNativeCollectionMetadata(native.pool, observed.metadata, {
        access: native.access,
        actor: other.actor,
        at,
        deadline,
        allowance: allowance(),
      })
    ).authorized,
  ).toBe(false);
  const page = await readNativeCollectionRawPage(native.pool, observed.metadata, {
    driver: 'member',
    after: null,
    limit: 2,
    deadline,
    allowance: allowance(),
  });
  expect(page.rows).toHaveLength(2);
  expect(page.exhausted).toBe(false);
  for (const row of page.rows) {
    expect(row.key.storedSubjectId).toBe(subject);
    expect(row).not.toHaveProperty('note');
    expect(row).not.toHaveProperty('ordinalKey');
  }
  expect(page.rows[0]!.key.factId).not.toBe(page.rows[1]!.key.factId);
  expect(page.work.used.candidateKeys).toBeGreaterThanOrEqual(2);
  expect(page.work.used.nativeRows).toBeGreaterThanOrEqual(2);
  const eof = await readNativeCollectionRawPage(native.pool, observed.metadata, {
    driver: 'member',
    after: page.after,
    limit: 2,
    deadline,
    allowance: allowance(),
  });
  expect(eof.rows).toEqual([]);
  expect(eof.exhausted).toBe(true);
  await expect(
    readNativeCollectionMetadata(native.pool, ref, {
      deadline,
      allowance: { ...allowance(), remaining: { ...allowance().remaining, nativeRows: 0 } },
    }),
  ).rejects.toThrow();
});
