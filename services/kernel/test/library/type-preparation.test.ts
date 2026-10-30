import { noEffect } from '../../src/command/command.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createShelfTypeKeys } from '../../src/library/shelf-type-keys.ts';
import { createTypePreparationPorts } from '../../src/library/type-preparation-contract.ts';
import { observePreparationSource, observePreparationIdentity } from '../../src/library/preparation-source.ts';
import { createLibraryCommandRunner } from '../../src/library/command-support.ts';
import { routeOf } from '../../src/route/route.ts';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';
let f: NativeProfileFixture;
beforeAll(async () => {
  f = await createProfileEntryFixture({ singleConnection: true });
}, 120_000);
afterAll(async () => {
  await f?.close();
});
test('preparation requires current native evidence and same-command consumption after source revalidation', async () => {
  const subjectId = await f.createSubject('game');
  const keys = createShelfTypeKeys();
  const ports = createTypePreparationPorts({
    ...f,
    keys,
    observe: (id) => observePreparationSource(f, id),
    observeIdentity: (id) => observePreparationIdentity(f, id),
  });
  const first = await ports.prepare(f.owner.actor, { subjectId, requestKey: entryKey() });
  expect(first.status).toBe('ready');
  if (first.status !== 'ready') throw new Error('Expected native ready receipt');
  const runner = createLibraryCommandRunner(f);
  const consume = (prepared = first.prepared) =>
    runner.ownAccountPrepared(
      f.owner.actor,
      {
        action: 'library_entry:update',
        kind: 'library.fixture.consume-type',
        requestKey: entryKey(),
        input: { subjectId },
        prepare: () => ports.revalidate(f.owner.actor, prepared),
      },
      async (tx, _context, current) => {
        expect(current).toBe('current');
        return noEffect(await ports.consume(tx, prepared));
      },
    );
  expect((await consume()).value).toMatchObject({
    status: 'ready',
    typeId: first.prepared.typeId,
    sourceId: subjectId,
  });
  await expect(
    keys.reserve(
      { client: f.pool, route: routeOf(f.owner.actor.accountId)!, accountId: f.owner.actor.accountId },
      'ex:Child',
    ),
  ).rejects.toThrow('current native preparation admission');
  const cloned = { ...first.prepared };
  await runner.ownAccount(
    f.owner.actor,
    { action: 'library_entry:update', kind: 'library.fixture.forged-type', requestKey: entryKey(), input: {} },
    async (tx) => {
      expect(await ports.consume(tx, cloned)).toEqual({ status: 'refresh' });
      return noEffect(true);
    },
  );
  await f.pool.query(
    'DELETE FROM library.type_preparation_progress WHERE route=$1 AND account_id=$2 AND preparation_id=$3',
    [routeOf(f.owner.actor.accountId), f.owner.actor.accountId, first.prepared.evidence.preparationId],
  );
  expect(await ports.revalidate(f.owner.actor, first.prepared)).toBe('refresh');
});

test('completed entry replay after deletion commits no new preparation metadata', async () => {
  const subjectId = await f.createSubject('game'),
    requestKey = entryKey();
  const first = await f.commands.putEntry(f.owner.actor, subjectId, { state: 'planned' }, requestKey);
  await f.commands.deleteEntry(
    f.owner.actor,
    subjectId,
    first.value.entry.revision,
    entryKey(),
    first.value.entry.incarnationId!,
  );
  const before = await f.inspect();
  expect(await f.commands.putEntry(f.owner.actor, subjectId, { state: 'planned' }, requestKey)).toEqual({
    ...first,
    replayed: true,
  });
  expect(await f.inspect()).toEqual(before);
});
