import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createShelfTypeKeys, type ShelfTypeDigest } from '../../src/library/shelf-type-keys.ts';
import { createTypePreparationPorts } from '../../src/library/type-preparation-contract.ts';
import { observePreparationIdentity, observePreparationSource } from '../../src/library/preparation-source.ts';
import { routeOf } from '../../src/route/route.ts';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';

let fixture: NativeProfileFixture;
let keys: ReturnType<typeof createShelfTypeKeys>;
const digestInputs: string[] = [];
const digest: ShelfTypeDigest = (bytes) => {
  digestInputs.push(bytes.toString('ascii'));
  return Buffer.alloc(32, 0x53);
};

beforeAll(async () => {
  fixture = await createProfileEntryFixture();
  keys = createShelfTypeKeys({ digest });
}, 120_000);

afterAll(async () => {
  await fixture?.close();
});

test('the factory uses its injected digest for lookup and reservation through a real collision', async () => {
  const ports = createTypePreparationPorts({
    ...fixture,
    keys,
    observe: (id) => observePreparationSource(fixture, id),
    observeIdentity: (id) => observePreparationIdentity(fixture, id),
  });
  const accountId = fixture.owner.actor.accountId;
  const route = routeOf(accountId)!;
  const recipe = await fixture.createSubject('recipe');
  const record = await fixture.createSubject('record');
  const start = digestInputs.length;
  const preparedRecipe = await ports.prepare(fixture.owner.actor, { subjectId: recipe, requestKey: entryKey() });
  const preparedRecord = await ports.prepare(fixture.owner.actor, { subjectId: record, requestKey: entryKey() });

  expect(preparedRecipe.status).toBe('ready');
  expect(preparedRecord.status).toBe('ready');
  if (preparedRecipe.status !== 'ready' || preparedRecord.status !== 'ready')
    throw new Error('Expected both profile-derived Types to be ready');
  expect(preparedRecord.prepared.typeId).not.toBe(preparedRecipe.prepared.typeId);
  expect(await keys.lookup(fixture.pool, route, accountId, 'ex:Recipe')).toBe(preparedRecipe.prepared.typeId);
  expect(await keys.lookup(fixture.pool, route, accountId, 'ex:Record')).toBe(preparedRecord.prepared.typeId);
  expect(digestInputs.slice(start).filter((input) => input === 'ex:Recipe').length).toBeGreaterThan(1);
});
