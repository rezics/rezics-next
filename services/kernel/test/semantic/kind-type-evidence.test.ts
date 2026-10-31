import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { Pool } from 'pg';
import type { Access } from '../../src/request/access.ts';
import type { OperationalTransaction } from '../../src/command/operational.ts';
import type { CollectionKindPreparationLocator } from '../../src/library/collection-kind-work-admission.ts';
import type { WorkAllowance } from '../../src/library/collection-source.ts';
import { createNativeKindTypeEvidence } from '../../src/semantic/kind-type-evidence.ts';
import { newId } from '../../src/route/route.ts';
import { createCollectionKindFixture, type CollectionKindFixture } from '../library/support/collection-kind-fixture.ts';
import { identityFixture } from './identity-fixture.ts';

function allowance(): WorkAllowance {
  return {
    reservationId: crypto.randomUUID(),
    remaining: {
      candidateKeys: 100,
      nativeRows: 10000,
      identityMetadataRows: 8192,
      nativePoints: 10000,
      witnessKeys: 100,
      statements: 1000,
      bytes: 1024 * 1024,
      emptySeeks: 1000,
    },
  };
}

test('a Kind locator, audience namespace and structural transaction cannot issue native Type evidence', async () => {
  let io = 0;
  const pool = {
    connect() {
      io++;
      throw new Error('Unadmitted Kind reached Source I/O');
    },
  } as unknown as Pool;
  const locator: CollectionKindPreparationLocator = {
    route: 0xc100,
    collectionId: newId(0xc100),
    ownerAccountId: newId(0xc100),
    preparationId: crypto.randomUUID(),
  };
  const tx = {
    query() {
      io++;
      throw new Error('Unadmitted Kind reached native I/O');
    },
  } as unknown as OperationalTransaction;
  const evidence = createNativeKindTypeEvidence({ pool, access: {} as Access });
  const budget = allowance();
  // An audience label cannot extend the original closed Library locator. A
  // valid locator will require paid native owner lookup once that owner exists.
  const forgedLocator = { ...locator, audience: 'public' };
  const read = await evidence.read({ locator: forgedLocator, allowance: budget, deadline: Date.now() + 10000 });
  expect(read.status).toBe('unavailable');
  expect(read.work.reservationId).toBe(budget.reservationId);
  expect(Object.values(read.work.used).every((value) => value === 0)).toBe(true);
  const verified = await evidence.verify({
    work: { kind: 'collection-kind-preparation', tx, locator },
    evidence: { locator, evidenceId: crypto.randomUUID() },
    allowance: budget,
    deadline: Date.now() + 10000,
  });
  expect(verified.status).toBe('unavailable');
  expect(verified).not.toHaveProperty('contributions');
  expect(io).toBe(0);
});

let f: CollectionKindFixture;
beforeAll(async () => {
  f = await createCollectionKindFixture();
}, 120000);
afterAll(async () => {
  await f?.close();
});

/** The named native outcome remains red until all ORIGINAL owner producers are
 * bound. Never replace it with the refusal test above or synthetic evidence.
 * Existing native APIs/fixtures and default maintenance own all successful work.
 */
test('Native Kind Type evidence requires genuine purpose-bound audience origin and admitted per-home attempt and remains current across original terminal negative and disclosure changes', async () => {
  const identities = await identityFixture(f.database.pool, f.database.admin);
  const collection = await f.collection({ visibility: 'public' });
  const root = await identities.create(0x6e00);
  const originals = [
    await identities.create(0x6e10),
    await identities.create(0x6e20),
    await identities.create(0x6e30),
  ];
  const movies = [await f.subject('schema:Movie'), await f.subject('schema:Movie')];
  for (const id of [...originals, ...movies]) await f.add(collection.id, id);
  expect(await f.complete(collection.id, null)).toMatchObject({
    presentationKind: 'schema:Person',
    presentationKindSource: 'members',
  });
  for (const original of originals) {
    await identities.merge(original, root);
    await identities.finishMove(original, root);
  }
  // Three actual stored supports now name ONE canonical Type vote, less than
  // the two Movie terminals. Counting the aliases would choose Person.
  for (const bearer of [null, f.owner.bearer, f.other.bearer]) {
    const row = await f.complete(collection.id, bearer);
    expect(row).toMatchObject({ presentationKind: 'schema:Movie', presentationKindSource: 'members' });
    expect(row).not.toHaveProperty('typeCounts');
    expect(row).not.toHaveProperty('typeEvidence');
  }
  for (const movie of movies) await f.hide(movie);
  expect(await f.complete(collection.id, null)).toMatchObject({
    presentationKind: 'schema:Person',
    presentationKindSource: 'members',
  });
  for (const original of originals) await identities.hide(original);
  expect((await f.send(null, 'GET', `/v1/subjects/${root}`)).status).toBe(200);
  // A readable terminal cannot rescue any of its three hidden originals.
  for (const bearer of [null, f.owner.bearer, f.other.bearer]) {
    const row = await f.complete(collection.id, bearer);
    expect(row).toMatchObject({ presentationKind: null, presentationKindSource: 'empty' });
    expect(row).not.toHaveProperty('typeCounts');
  }
  // An excluded original is a retained negative dependency. Restoring it must
  // invalidate the old empty proof even though canonical identity is unchanged.
  await identities.hide(originals[0]!, 'restore');
  expect(await f.complete(collection.id, null)).toMatchObject({
    presentationKind: 'schema:Person',
    presentationKindSource: 'members',
  });
  await identities.hide(root);
  expect(await f.complete(collection.id, null)).toMatchObject({
    presentationKind: null,
    presentationKindSource: 'empty',
  });
  await identities.hide(root, 'restore');
  expect(await f.complete(collection.id, f.other.bearer)).toMatchObject({
    presentationKind: 'schema:Person',
    presentationKindSource: 'members',
  });
}, 120000);

test('a private native Kind audience cannot be borrowed by anonymous or unrelated readers', async () => {
  await f.refresh();
  const collection = await f.collection({ visibility: 'private' });
  await f.add(collection.id, await f.subject('schema:Book'));
  expect(await f.complete(collection.id, f.owner.bearer)).toMatchObject({
    presentationKind: 'schema:Book',
    presentationKindSource: 'members',
  });
  for (const bearer of [null, f.other.bearer]) {
    const response = await f.send(bearer, 'GET', f.path(collection.id));
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body).not.toHaveProperty('presentationKind');
    expect(body).not.toHaveProperty('typeCounts');
  }
}, 120000);
