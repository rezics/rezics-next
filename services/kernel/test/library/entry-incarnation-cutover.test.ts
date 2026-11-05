import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';
import { cutoverEntryIncarnationsPage } from '../../src/library/entry-incarnation-cutover.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
let f: NativeProfileFixture;
beforeAll(async () => {
  f = await createProfileEntryFixture();
}, 120000);
afterAll(async () => {
  await f?.close();
});
test('default native bounded incarnation cutover preserves the exact genuine legacy fact and owner reads expose its new opaque guard', async () => {
  const subject = await f.createSubject('game');
  const made = (await f.commands.putEntry(f.owner.actor, subject, { state: 'planned' }, entryKey())).value.entry;
  const route = routeOf(f.owner.actor.accountId)!;
  await f.pool.query(
    'UPDATE library.entry SET incarnation_id=NULL WHERE route=$1 AND account_id=$2 AND subject_id=$3',
    [route, f.owner.actor.accountId, subject],
  );
  const read = async () =>
    (
      await f.pool.query(
        'SELECT to_jsonb(e) AS value FROM library.entry e WHERE route=$1 AND account_id=$2 AND subject_id=$3',
        [route, f.owner.actor.accountId, subject],
      )
    ).rows[0].value;
  const before = await read();
  let after: string | null = null;
  let stamped = 0;
  do {
    const page = await cutoverEntryIncarnationsPage(
      { pool: f.pool },
      { partition: partitionOf(route), after, limit: 1 },
    );
    expect(page.examined).toBeLessThanOrEqual(1);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(4096);
    stamped += page.stamped;
    after = page.next;
  } while (after);
  const current = await read();
  expect(stamped).toBe(1);
  expect(current.incarnation_id).toMatch(/^[0-9a-f-]{36}$/);
  const old = { ...before };
  const now = { ...current };
  delete old.incarnation_id;
  delete now.incarnation_id;
  expect(now).toEqual(old);
  expect((await f.commands.readEntry(f.owner.actor, subject)).incarnationId).toBe(current.incarnation_id);
  expect(current.revision).toBe(made.revision);
}, 120000);
