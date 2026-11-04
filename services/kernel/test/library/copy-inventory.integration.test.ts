import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { compileCatalogue } from '@rezics/definitions/compile';
import { fixture } from '../../../../packages/definitions/test/support/library-profiles.ts';
import { createCopyCommands } from '../../src/library/copies.ts';
import type { AccountActor } from '../../src/request/access.ts';
import { deadlineFor } from '../../src/request/deadline.ts';
import { newId } from '../../src/route/route.ts';
import { authenticateAccount } from '../support/admitted-access.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { createProfileEntryFixture, type NativeProfileFixture } from './support/profile-entry-fixture.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

const route = 0x22c2;
const scopes = ['subject:read', 'copy:create', 'copy:update', 'copy:delete', 'copy:read', 'copy:list'];
const persona = (): AccountActor => ({
  kind: 'account',
  accountId: newId(route),
  scopes,
  clientId: 'copy-inventory-test',
  requestedBy: null,
  authnEpoch: 1,
});
let owner = persona();
let other = persona();
let database: GrowthDatabase;
let native: NativeProfileFixture;
let commands: ReturnType<typeof createCopyCommands>;
let now = Date.parse('2026-10-26T12:00:00.000Z');
const clock = () => new Date(now);
const tick = () => {
  now += 1000;
};
const key = () => randomUUID();

async function subject(label: string): Promise<string> {
  return native.createSubject('game', label);
}

async function denyRead(subjectId: string): Promise<void> {
  await database.admin.query(
    `INSERT INTO access.resource_denial
       (route, resource_id, subject_id, subject_role, action, reason, valid, transaction_id)
     VALUES ($1, $2, $3, '', 'subject:read', 'resource', '(,)'::tstzrange, $4)`,
    [route, subjectId, owner.accountId, randomUUID()],
  );
}

beforeAll(async () => {
  database = await openGrowthDatabase(databaseUrl);
  native = await createProfileEntryFixture({ pool: database.pool, clock });
  const release = await compileCatalogue(
    fixture({
      id: 'fixture.copy-inventory',
      copies: {
        kinds: [
          {
            id: 'physical',
            statuses: [{ id: 'ordered' }, { id: 'owned' }, { id: 'lent' }, { id: 'disposed' }],
          },
        ],
      },
    }),
  );
  await native.activate(await native.publish(release));
  for (const actor of [owner, other]) {
    await database.admin.query(
      `INSERT INTO access.account
         (route, account_id, kind, state, transaction_id, authn_fenced, minimum_authn_epoch)
       VALUES ($1, $2, 'actor', 'active', $3, false, 1)`,
      [route, actor.accountId, newId(route)],
    );
  }
  const context = { pool: database.pool, deadline: deadlineFor(30_000) };
  owner = await authenticateAccount(native.access, context, owner);
  other = await authenticateAccount(native.access, context, other);
  commands = createCopyCommands({
    pool: database.pool,
    access: native.access,
    tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(41)]]) },
    clock,
  });
});

afterAll(async () => {
  if (native) await native.close();
  if (database) await database.close();
});

test('native filters select past unrelated pages, bind cursors, and keep tuple order through edits', async () => {
  const target = await subject('Hidden inventory filter target');
  const unrelated = await subject('Other inventory filter target');
  for (let index = 0; index < 24; index++) {
    tick();
    await commands.createCopy(owner, { subjectId: target, kind: 'physical', status: 'owned' }, key());
  }
  tick();
  const matching = [];
  for (let index = 0; index < 3; index++) {
    matching.push(
      (await commands.createCopy(owner, { subjectId: target, kind: 'physical', status: 'ordered' }, key())).value,
    );
  }
  await commands.createCopy(owner, { subjectId: unrelated, kind: 'physical', status: 'ordered' }, key());
  const expected = [...matching].sort(
    (left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  );
  expect(new Set(matching.map((copy) => copy.createdAt)).size).toBe(1);

  const filtered = await commands.listCopies(owner, {
    subjectId: target,
    kind: 'physical',
    status: 'ordered',
    limit: 100,
  });
  expect(filtered.copies.map((copy) => copy.id)).toEqual(expected.map((copy) => copy.id));
  expect(filtered.filterOptions.kinds.state).toBe('available');
  expect(filtered.filterOptions.kinds.choices.some((choice) => choice.id === 'physical')).toBe(true);
  expect(filtered.filterOptions.statuses.choices.some((choice) => choice.id === 'ordered')).toBe(true);

  const first = await commands.listCopies(owner, {
    subjectId: target,
    kind: 'physical',
    status: 'ordered',
    limit: 1,
  });
  expect(first.copies.map((copy) => copy.id)).toEqual([expected[0]!.id]);
  expect(first.next).toBeString();
  await expect(
    commands.listCopies(owner, {
      subjectId: target,
      kind: 'physical',
      status: 'owned',
      cursor: first.next!,
    }),
  ).rejects.toMatchObject({ code: 'invalid_cursor' });
  await expect(commands.listCopies(other, { cursor: first.next! })).rejects.toMatchObject({ code: 'invalid_cursor' });
  await expect(
    commands.listCopies(owner, { subjectId: target, kind: 'physical and digital' }),
  ).rejects.toMatchObject({ name: 'CopyInvalidError', field: 'kind' });
  expect(
    (await commands.listCopies(owner, { subjectId: target, kind: 'removed-kind', status: 'ordered' })).copies,
  ).toEqual([]);

  await commands.updateCopy(owner, expected[1]!.id, { revision: expected[1]!.revision, status: 'owned' }, key());
  await denyRead(target);
  const afterEdit = await commands.listCopies(owner, {
    subjectId: target,
    kind: 'physical',
    status: 'ordered',
    limit: 10,
    cursor: first.next!,
  });
  expect(afterEdit.copies.map((copy) => copy.id)).toEqual([expected[2]!.id]);
});
