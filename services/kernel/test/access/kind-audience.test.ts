import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { createAccess } from '../../src/access/index.ts';
import { kindOriginalFormulaPlan } from '../../src/access/kind-audience-formula.ts';
import { AccessWorkAccounting, accessNativeDeclaration } from '../../src/work/access-work.ts';
import { mintReadTime, releaseOperationalTime } from '../../src/command/command.ts';
import { withConnection } from '../../src/database/pool.ts';
import { createCollectionKindFixture, type CollectionKindFixture } from '../library/support/collection-kind-fixture.ts';

let fixture: CollectionKindFixture;

beforeAll(async () => {
  fixture = await createCollectionKindFixture();
}, 120_000);

beforeEach(async () => {
  await fixture.refresh();
}, 120_000);

afterAll(async () => {
  await fixture?.close();
});

test('default Collection Kind follows current canonical items, preserves owner choice, and keeps GET metadata fixed', async () => {
  const collection = await fixture.collection({ visibility: 'public' });
  const book = await fixture.subject('schema:Book');
  await fixture.add(collection.id, book);

  const automatic = await fixture.complete(collection.id, null);
  expect(automatic).toMatchObject({
    presentationKind: 'schema:Book',
    presentationKindSource: 'members',
    memberCount: 1,
  });
  expect(automatic).not.toHaveProperty('typeCounts');
  expect(automatic).not.toHaveProperty('actor');

  expect(await fixture.patch(collection.id, 'schema:Movie')).toMatchObject({
    presentationKind: 'schema:Movie',
    presentationKindSource: 'owner',
    memberCount: 1,
  });

  await fixture.patch(collection.id, null);
  expect(await fixture.complete(collection.id, fixture.other.bearer)).toMatchObject({
    presentationKind: 'schema:Book',
    presentationKindSource: 'members',
    memberCount: 1,
  });

  await fixture.hide(book);
  const afterRevocation = await fixture.read(collection.id, null);
  expect(afterRevocation.presentationKindSource).not.toBe('members');
  expect(afterRevocation).not.toHaveProperty('typeCounts');
  expect(afterRevocation.memberCount).toBe(1);
});

// Authored for native integration; do not replace missing producer authority with fixture rows.
test('Complete owned default product journey without invented authority', async () => {
  const collection = await fixture.collection({ visibility: 'public' });
  const book = await fixture.subject('schema:Book');
  await fixture.add(collection.id, book);
  await fixture.add(collection.id, book);
  for (const bearer of [null, fixture.owner.bearer, fixture.other.bearer]) {
    const current = await fixture.complete(collection.id, bearer);
    expect(current).toMatchObject({
      presentationKind: 'schema:Book',
      presentationKindSource: 'members',
      memberCount: 2,
    });
    expect(current).not.toHaveProperty('actor');
    expect(current).not.toHaveProperty('typeCounts');
    expect(current).not.toHaveProperty('coverage');
  }
  expect(await fixture.patch(collection.id, 'schema:Movie')).toMatchObject({
    presentationKind: 'schema:Movie',
    presentationKindSource: 'owner',
  });
  await fixture.patch(collection.id, null);
  expect(await fixture.complete(collection.id, null)).toMatchObject({
    presentationKind: 'schema:Book',
    presentationKindSource: 'members',
  });
  await fixture.hide(book);
  const changed = await fixture.read(collection.id, null);
  expect(changed.presentationKind).toBeNull();
  expect(changed.presentationKindSource).not.toBe('members');
}, 120_000);

test('Kind original formula funds the complete native 1000-group inverse and both gates', async () => {
  const pool = fixture.database.pool;
  const time = await withConnection(pool, (client) => mintReadTime(client));
  const deadline = Date.now() + 5000;
  // Only the declaration is evaluated here. This sink cannot authorize or dispatch any native work.
  const work = new AccessWorkAccounting(
    {
      reserve() {
        throw new Error('A pure Kind declaration performed accounting IO');
      },
    },
    deadline,
  );
  try {
    const actions = new Map([['collection:read', { anonymous: true }]]);
    const access = createAccess({ actions, auth: fixture.runtime.identity.accessConfig.auth! });
    const actor = await access.authenticate(fixture.owner.bearer, { pool, deadline });
    const plan = kindOriginalFormulaPlan(actor, { pool, deadline, time, work }, actions);
    if (!plan.access) throw new Error('The installed original formula has no native declaration');
    const inverse = accessNativeDeclaration('inverse', {}, { members: 1, groups: 1000 }).bound;
    const membership = accessNativeDeclaration('membership', {}, { groups: 1000 }).bound;
    expect(plan.access.rows).toBeGreaterThan(inverse.rows + membership.rows);
    expect(plan.access.keys).toBeGreaterThan(inverse.keys + membership.keys);
    expect(plan.overhead.statements).toBe(13);
    expect(plan.overhead.nativePoints).toBe(4);
    expect(plan.overhead.identityMetadataRows).toBe(0);
    expect(plan.overhead.witnessKeys).toBe(0);
  } finally {
    releaseOperationalTime(time);
  }
}, 120_000);
