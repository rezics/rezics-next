import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createShelfTypeKeys } from '../../src/library/shelf-type-keys.ts';
import { createTypePreparationPorts } from '../../src/library/type-preparation-contract.ts';
import { observePreparationSource, observePreparationIdentity } from '../../src/library/preparation-source.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';
let f: NativeProfileFixture;
beforeAll(async () => {
  f = await createProfileEntryFixture();
}, 120_000);
afterAll(async () => {
  await f?.close();
});
const keys = createShelfTypeKeys();
function ports() {
  return createTypePreparationPorts({
    ...f,
    keys,
    observe: (id) => observePreparationSource(f, id),
    observeIdentity: (id) => observePreparationIdentity(f, id),
  });
}
// Fault injection is confined to the dictionary persistence seam. Source truth and readiness use real commands.
async function collision(fullType: string) {
  const accountId = f.owner.actor.accountId,
    route = routeOf(accountId)!;
  const primary = await keys.lookup(f.pool, route, accountId, 'ex:Child');
  expect(primary).not.toBeNull();
  await f.pool.query(
    `INSERT INTO library.shelf_type_root(route,account_id,digest,primary_type_id,root_node_id)
    VALUES($1,$2,$3,$4,$5)`,
    [route, accountId, createHash('sha256').update(fullType).digest(), primary, newId(route)],
  );
  return { accountId, route, primary };
}
test('concurrent identities never alias or expose partial terminals', async () => {
  const { accountId, route, primary } = await collision('ex:Recipe');
  const subjectId = await f.createSubject('recipe');
  const requestKey = entryKey();
  const prepared = await ports().prepare(f.owner.actor, { subjectId, requestKey });
  expect(prepared.status).toBe('ready');
  const resolved = await keys.lookup(f.pool, route, accountId, 'ex:Recipe');
  expect(resolved).not.toBeNull();
  expect(resolved).not.toBe(primary);
  expect(await keys.lookup(f.pool, route, accountId, 'ex:Child')).toBe(primary);
  expect(await keys.lookup(f.pool, route, accountId, 'ex:recipe')).toBeNull();
  const again = await ports().prepare(f.owner.actor, { subjectId, requestKey });
  expect(again).toEqual(prepared);
});
test('long collision paths finish in bounded resumable transactions', async () => {
  const fullType = 'ex:' + 'L'.repeat(256 * 104);
  const release = {
    ...f.original,
    types: {
      ...f.original.types,
      [fullType]: { ...f.original.types['ex:Child']!, iri: 'https://example.test/' + 'L'.repeat(256 * 104) },
    },
  };
  await f.activate(await f.publish(release));
  const response = await f.send('owner', 'POST', '/v1/subjects', {
    type: fullType,
    labels: { en: 'Long native Type' },
  });
  expect(response.status).toBe(201);
  const subjectId = ((await response.json()) as { subject: { id: string } }).subject.id;
  const { route, accountId, primary } = await collision(fullType);
  const preparation = ports();
  const first = await preparation.prepare(f.owner.actor, { subjectId, requestKey: entryKey() });
  expect(first.status).toBe('pending');
  if (first.status !== 'pending') throw new Error('Expected native reservation');
  expect(first.intent.offset).toBe(100 * 256);
  expect(await keys.lookup(f.pool, route, accountId, fullType)).toBeNull();
  const rows = await f.pool.query(
    'SELECT count(*)::integer AS n FROM library.shelf_type_node WHERE route=$1 AND account_id=$2 AND terminal_type_id IS NULL',
    [route, accountId],
  );
  expect(rows.rows[0].n).toBe(100);
  const final = await preparation.continue(first.intent);
  expect(final.status).toBe('ready');
  if (final.status !== 'ready') throw new Error('Expected atomic final publication');
  expect(final.prepared.typeId).not.toBe(primary);
  expect(await keys.lookup(f.pool, route, accountId, fullType)).toBe(final.prepared.typeId);
  expect(await preparation.continue(first.intent)).toEqual(final);
  const value = await f.pool.query(
    'SELECT full_type FROM library.shelf_type_value WHERE route=$1 AND account_id=$2 AND type_id=$3',
    [route, accountId, final.prepared.typeId],
  );
  expect(value.rows[0].full_type).toBe(fullType);
});
