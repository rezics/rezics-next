import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { compileCatalogue } from '@rezics/definitions/compile';
import { fixture } from '../../../../packages/definitions/test/support/library-profiles.ts';
import { createCopyCommands } from '../../src/library/copies.ts';
import type { AccountActor } from '../../src/request/access.ts';
import { deadlineFor } from '../../src/request/deadline.ts';
import { newId } from '../../src/route/route.ts';
import { authenticateAccount } from '../support/admitted-access.ts';
import {
  assertGrowth,
  measure,
  openGrowthDatabase,
  type GrowthDatabase,
  type GrowthSample,
} from '../support/growth.ts';
import { createProfileEntryFixture, type NativeProfileFixture } from './support/profile-entry-fixture.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

const route = 0x22c3;
const scopes = ['subject:read', 'copy:create', 'copy:update', 'copy:delete', 'copy:read', 'copy:list'];
const persona = (): AccountActor => ({
  kind: 'account',
  accountId: newId(route),
  scopes,
  clientId: 'copy-inventory-growth',
  requestedBy: null,
  authnEpoch: 1,
});
let matchingOwner = persona();
let nonmatchingOwner = persona();
let foreignOwner = persona();
let database: GrowthDatabase;
let native: NativeProfileFixture;
let commands: ReturnType<typeof createCopyCommands>;
let target: string;
let otherSubject: string;
const clock = () => new Date('2026-10-26T12:00:00.000Z');

async function seedCopies(
  accountId: string,
  subjectId: string,
  status: 'ordered' | 'owned',
  count: number,
  pins: { library: unknown; kind: unknown; status: unknown },
) {
  if (count === 0) return;
  await database.admin.query(
    `INSERT INTO library.copy
       (route, copy_id, account_id, subject_id, status, location, source, acquired_on, disposed_on, note, revision,
        created_at, updated_at, transaction_id, library_profile_pin, kind, kind_profile_pin, status_profile_pin)
     SELECT $1, copy_id, $2, $3, $4, NULL, NULL, NULL, NULL, NULL, 1, $5, $5, $6, $7, 'physical', $8, $9
     FROM unnest($10::uuid[]) AS rows(copy_id)`,
    [
      route,
      accountId,
      subjectId,
      status,
      '2020-01-01T00:00:00.000Z',
      newId(route),
      pins.library,
      pins.kind,
      pins.status,
      Array.from({ length: count }, () => newId(route)),
    ],
  );
}

beforeAll(async () => {
  database = await openGrowthDatabase(databaseUrl);
  native = await createProfileEntryFixture({ pool: database.pool, clock });
  const release = await compileCatalogue(
    fixture({
      id: 'fixture.copy-inventory-growth',
      copies: {
        kinds: [{ id: 'physical', statuses: [{ id: 'ordered' }, { id: 'owned' }, { id: 'lent' }, { id: 'disposed' }] }],
      },
    }),
  );
  await native.activate(await native.publish(release));
  for (const actor of [matchingOwner, nonmatchingOwner, foreignOwner]) {
    await database.admin.query(
      `INSERT INTO access.account
         (route, account_id, kind, state, transaction_id, authn_fenced, minimum_authn_epoch)
       VALUES ($1, $2, 'actor', 'active', $3, false, 1)`,
      [route, actor.accountId, newId(route)],
    );
  }
  const context = { pool: database.pool, deadline: deadlineFor(30_000) };
  matchingOwner = await authenticateAccount(native.access, context, matchingOwner);
  nonmatchingOwner = await authenticateAccount(native.access, context, nonmatchingOwner);
  foreignOwner = await authenticateAccount(native.access, context, foreignOwner);
  commands = createCopyCommands({
    pool: database.pool,
    access: native.access,
    tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(53)]]) },
    clock,
  });
  target = await native.createSubject('game', 'Copy inventory growth target');
  otherSubject = await native.createSubject('game', 'Copy inventory growth other subject');
});

afterAll(async () => {
  if (native) await native.close();
  if (database) await database.close();
});

test('filtered page cost stays bounded while matching and nonmatching native populations grow independently', async () => {
  const matchingSeed = await commands.createCopy(
    matchingOwner,
    { subjectId: target, kind: 'physical', status: 'ordered' },
    randomUUID(),
  );
  const stored = await database.admin.query<{
    library_profile_pin: unknown;
    kind_profile_pin: unknown;
    status_profile_pin: unknown;
  }>(
    `SELECT library_profile_pin, kind_profile_pin, status_profile_pin
     FROM library.copy WHERE copy_id = $1`,
    [matchingSeed.value.id],
  );
  const pins = {
    library: stored.rows[0]!.library_profile_pin,
    kind: stored.rows[0]!.kind_profile_pin,
    status: stored.rows[0]!.status_profile_pin,
  };
  const scales = [64, 512, 4096] as const;
  const matchSamples: GrowthSample[] = [];
  const nonmatchSamples: GrowthSample[] = [];
  let previous = 0;
  for (const scale of scales) {
    await seedCopies(matchingOwner.accountId, target, 'ordered', scale - previous - (previous === 0 ? 1 : 0), pins);
    if (previous === 0) {
      await seedCopies(matchingOwner.accountId, target, 'owned', 64, pins);
      await seedCopies(nonmatchingOwner.accountId, target, 'ordered', 64, pins);
    }
    await seedCopies(nonmatchingOwner.accountId, target, 'owned', scale - previous, pins);
    await seedCopies(foreignOwner.accountId, target, 'ordered', scale - previous, pins);
    await seedCopies(foreignOwner.accountId, otherSubject, 'ordered', scale - previous, pins);

    const matching = await measure(database, () =>
      commands.listCopiesWithObservation(matchingOwner, {
        subjectId: target,
        kind: 'physical',
        status: 'ordered',
        limit: 1,
      }),
    );
    const nonmatching = await measure(database, () =>
      commands.listCopiesWithObservation(nonmatchingOwner, {
        subjectId: target,
        kind: 'physical',
        status: 'ordered',
        limit: 1,
      }),
    );
    for (const sample of [matching, nonmatching]) {
      expect(sample.value.copies).toHaveLength(1);
      expect(sample.value.filterOptions.kinds.choices).toContainEqual(
        expect.objectContaining({ id: 'physical', meaning: 'available' }),
      );
      expect(new TextEncoder().encode(JSON.stringify(sample.value.filterOptions)).byteLength).toBeLessThanOrEqual(
        65_536,
      );
      expect(sample.cost.relations?.['library.copy']?.sequentialScans ?? 0).toBe(0);
    }
    matchSamples.push({ scale, cost: matching.cost });
    nonmatchSamples.push({ scale, cost: nonmatching.cost });
    previous = scale;
  }
  for (const samples of [matchSamples, nonmatchSamples]) {
    expect(samples.map((sample) => sample.cost.statements)).toEqual([
      samples[0]!.cost.statements,
      samples[0]!.cost.statements,
      samples[0]!.cost.statements,
    ]);
    assertGrowth(samples, { statements: 'constant', rows: 'constant', blocks: 'logarithmic' });
  }

  const firstMaximum = await commands.listCopiesWithObservation(matchingOwner, {
    subjectId: target,
    kind: 'physical',
    status: 'ordered',
    limit: 100,
  });
  expect(firstMaximum.copies).toHaveLength(100);
  expect(firstMaximum.next).toBeString();
  const nextMaximum = await commands.listCopiesWithObservation(matchingOwner, {
    subjectId: target,
    kind: 'physical',
    status: 'ordered',
    limit: 100,
    cursor: firstMaximum.next!,
  });
  expect(nextMaximum.copies).toHaveLength(100);
  expect(nextMaximum.next).toBeString();
  const firstIds = new Set(firstMaximum.copies.map((copy) => copy.id));
  expect(nextMaximum.copies.every((copy) => !firstIds.has(copy.id))).toBe(true);
  const lastFirst = firstMaximum.copies.at(-1)!;
  const firstNext = nextMaximum.copies[0]!;
  expect(
    lastFirst.createdAt < firstNext.createdAt ||
      (lastFirst.createdAt === firstNext.createdAt && lastFirst.id < firstNext.id),
  ).toBe(true);
});
