import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createPersonalLabelCommands } from '../../src/library/label-commands.ts';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';
let f: NativeProfileFixture;
beforeAll(async () => {
  f = await createProfileEntryFixture();
}, 120000);
afterAll(async () => {
  await f?.close();
});
test('native label prefix paging uses the live C-name index preserves literal normalized prefixes and resumes long Unicode names without scanning the catalogue', async () => {
  const commands = createPersonalLabelCommands({ pool: f.pool, tokens: f.tokens }),
    actor = f.owner.actor;
  for (let n = 0; n < 105; n++)
    await commands.createLabel(actor, { name: 'Other ' + n.toString().padStart(3, '0') }, entryKey());
  const names = ['Café Shelf', 'A%_ Literal', 'AB_ decoy', '字'.repeat(99) + '甲', '字'.repeat(99) + '乙'];
  for (const name of names) await commands.createLabel(actor, { name }, entryKey());
  const maximum = await commands.listLabels(actor, { q: 'Other ', limit: 100 });
  expect(maximum.labels).toHaveLength(100);
  expect(maximum.next).toBeTruthy();
  const maximumNext = await commands.listLabels(actor, { q: 'Other ', limit: 100, cursor: maximum.next! });
  expect(maximumNext.labels).toHaveLength(5);
  expect(maximumNext.next).toBeNull();
  expect((await commands.listLabels(actor, { q: '  Cafe\u0301  ', limit: 20 })).labels.map((x) => x.name)).toEqual([
    'Café Shelf',
  ]);
  expect((await commands.listLabels(actor, { q: 'A%_', limit: 20 })).labels.map((x) => x.name)).toEqual([
    'A%_ Literal',
  ]);
  expect((await commands.listLabels(actor, { q: 'café', limit: 20 })).labels).toEqual([]);
  const q = '字'.repeat(99),
    seen: string[] = [];
  let cursor: string | undefined;
  for (let step = 0; step < 4; step++) {
    const page = await commands.listLabels(actor, { q, limit: 1, ...(cursor ? { cursor } : {}) });
    seen.push(...page.labels.map((x) => x.name));
    if (!page.next) {
      cursor = undefined;
      break;
    }
    expect(page.next.length).toBeLessThanOrEqual(4096);
    cursor = page.next;
  }
  expect(seen.sort()).toEqual(names.slice(3).sort());
  expect(cursor).toBeUndefined();
  const first = await commands.listLabels(actor, { q: 'Other ', limit: 1 });
  expect(first.next).toBeTruthy();
  await expect(
    commands.listLabels(f.other.actor, { q: 'Other ', limit: 1, cursor: first.next! }),
  ).rejects.toMatchObject({ code: 'invalid_cursor' });
  await commands.createLabel(actor, { name: 'Other later' }, entryKey());
  await expect(commands.listLabels(actor, { q: 'Other ', limit: 1, cursor: first.next! })).rejects.toMatchObject({
    code: 'stale_cursor',
  });
}, 120000);
