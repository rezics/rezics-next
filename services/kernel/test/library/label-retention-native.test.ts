import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';
import { createPersonalLabelCommands } from '../../src/library/label-commands.ts';
import { purgeLabelRetentionPage } from '../../src/library/label-retention.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
let f: NativeProfileFixture;
beforeAll(async () => {
  f = await createProfileEntryFixture();
}, 120000);
afterAll(async () => {
  await f?.close();
});
test('native ordinary label purge refuses early expiry without changing retained metadata', async () => {
  const labels = createPersonalLabelCommands({ pool: f.pool, tokens: f.tokens });
  const made = await labels.createLabel(f.owner.actor, { name: 'Private retained label' }, entryKey());
  const id = made.value.label.id;
  await labels.deleteLabel(f.owner.actor, id, made.value.label.revision, entryKey());
  const args = [routeOf(f.owner.actor.accountId), f.owner.actor.accountId, id];
  const read = async () =>
    (
      await f.pool.query(
        'SELECT normalized_name,revision,deleted_at,purge_after FROM library.personal_label WHERE route=$1 AND account_id=$2 AND label_id=$3',
        args,
      )
    ).rows;
  const before = await read();
  expect(before).toHaveLength(1);
  expect(before[0].deleted_at).not.toBeNull();
  const result = await purgeLabelRetentionPage(
    { pool: f.pool },
    { partition: partitionOf(args[0] as number), limit: 1, after: null },
  );
  expect(result.removed).toBe(0);
  expect(result.examined).toBeLessThanOrEqual(1);
  expect(await read()).toEqual(before);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(4096);
}, 120000);
