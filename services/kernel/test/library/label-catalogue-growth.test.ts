import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createLifecycleInternals, type ProvisioningEvidence } from '../../src/access/lifecycle.ts';
import { GrantDeniedError } from '../../src/access/grant-commands.ts';
import { createPersonalLabelCommands } from '../../src/library/label-commands.ts';
import { LibraryNotFoundError } from '../../src/library/command-support.ts';
import { LibraryConflictError } from '../../src/library/entries.ts';
import { readPartition } from '../../src/partition/partition.ts';
import { deadlineFor } from '../../src/request/deadline.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { encodeListCursor } from '../../src/tokens/list-cursor.ts';
import { authenticateAccount } from '../support/admitted-access.ts';
import {
  assertGrowth,
  capture,
  catalogStatementBound,
  costOf,
  medianCost,
  openGrowthDatabase,
  type Capture,
  type Cost,
  type GrowthDatabase,
  type GrowthSample,
} from '../support/growth.ts';
import { testRouteKey } from '../support/test-kernel.ts';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';

let db: GrowthDatabase, f: NativeProfileFixture;
let labels: ReturnType<typeof createPersonalLabelCommands>;
beforeAll(async () => {
  db = await openGrowthDatabase();
  f = await createProfileEntryFixture({ pool: db.pool });
  labels = createPersonalLabelCommands({ pool: db.pool, tokens: f.tokens });
}, 120000);
afterAll(async () => {
  await f?.close();
  await db?.close();
});
const scopes = ['library_entry:update', 'library_entry:read', 'library_entry:list'];

// Provision a real, authenticated actor on the same partition, with no account/grant SQL seed.
async function neighbour() {
  const proofs = new WeakMap<object, ProvisioningEvidence>();
  const lifecycle = createLifecycleInternals({
    pool: db.pool,
    routeKey: testRouteKey(),
    provisioningEvidence: async (proof) =>
      typeof proof === 'object' && proof !== null ? (proofs.get(proof) ?? null) : null,
    recoveryEvidence: async () => null,
  });
  const partition = partitionOf(routeOf(f.owner.actor.accountId)!);
  let key: string, accountId: string;
  do {
    key = entryKey();
    accountId = lifecycle.registrationTarget(key);
  } while (partitionOf(routeOf(accountId)!) !== partition);
  const handle = `catalogue_${key.replaceAll('-', '')}`;
  const reservation = await lifecycle.reserveHandle({ accountId, handle, key });
  const input = { accountId, handle, reservationId: reservation.value.reservationId, key };
  const pending = await lifecycle.createPending(input);
  const evidence = Object.freeze({});
  proofs.set(evidence, {
    accountId,
    registrationId: pending.value.registrationId,
    authIdentityId: accountId,
    authnEpoch: 1,
  });
  await lifecycle.claimHandle({ ...input, key: entryKey(), evidence });
  await lifecycle.activate({ accountId, key: entryKey(), evidence });
  return authenticateAccount(
    f.access,
    { pool: db.pool, deadline: deadlineFor(30000) },
    { accountId, clientId: 'native-label-catalogue', scopes },
  );
}

test('native duplicate create, exact replay, rename CAS and occupied restore races have one effect', async () => {
  const actor = (await f.identity(scopes)).actor;
  const before = await f.inspect(actor.accountId);
  const duplicate = await Promise.allSettled([
    labels.createLabel(actor, { name: 'Cafe\u0301' }, entryKey()),
    labels.createLabel(actor, { name: 'Café' }, entryKey()),
  ]);
  expect(duplicate.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(duplicate.find((r) => r.status === 'rejected')).toMatchObject({ reason: expect.any(LibraryConflictError) });
  const result = duplicate.find((r) => r.status === 'fulfilled');
  if (!result || result.status !== 'fulfilled') throw new Error('Missing winner');
  const id = result.value.value.label.id;
  const after = await f.inspect(actor.accountId);
  expect(after.events.length - before.events.length).toBe(1);
  expect(after.receipts.length - before.receipts.length).toBe(1);
  const rename = await Promise.allSettled([
    labels.renameLabel(actor, id, { name: 'Left', revision: 1 }, entryKey()),
    labels.renameLabel(actor, id, { name: 'Right', revision: 1 }, entryKey()),
  ]);
  expect(rename.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(rename.find((r) => r.status === 'rejected')).toMatchObject({ reason: expect.any(LibraryConflictError) });
  const name = (await labels.readLabel(actor, id)).name;
  const deleteKey = entryKey();
  await labels.deleteLabel(actor, id, 2, deleteKey);
  const undo = await Promise.allSettled([
    labels.restoreLabel(actor, id, 3, entryKey()),
    labels.createLabel(actor, { name }, entryKey()),
  ]);
  expect(undo.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  const failure = undo.find((r) => r.status === 'rejected');
  if (!failure || failure.status !== 'rejected') throw new Error('Missing conflict');
  expect(
    failure.reason instanceof LibraryConflictError || failure.reason.code === 'library_label_restore_occupied',
  ).toBe(true);
  const replay = await labels.deleteLabel(actor, id, 2, deleteKey);
  expect(replay.replayed).toBe(true);
  expect(replay.value).toEqual({ deleted: true, revision: 3 });
  const key = entryKey();
  const identical = await Promise.all([
    labels.createLabel(actor, { name: 'Replay race' }, key),
    labels.createLabel(actor, { name: 'Replay race' }, key),
  ]);
  expect(identical[0]!.value).toEqual(identical[1]!.value);
  expect(identical.filter((r) => r.replayed)).toHaveLength(1);
}, 120000);

test('native strict inputs, sparse raw pages, replay privacy and current read authority', async () => {
  const actor = (await f.identity(scopes)).actor;
  const create = (name: string) => labels.createLabel(actor, { name }, entryKey());
  const first = (await create('First')).value.label;
  await labels.deleteLabel(actor, first.id, 1, entryKey());
  const second = (await create('Second')).value.label;
  await create('third');
  const page = await labels.listLabels(actor, { limit: 1 });
  expect(page.labels).toEqual([]);
  expect(page.next).toBeTruthy();
  const next = await labels.listLabels(actor, { limit: 1, cursor: page.next! });
  expect(next.labels).toEqual([{ ...second, name: 'Second' }]);
  await expect(labels.listLabels(actor, { limit: 2, cursor: page.next! })).rejects.toMatchObject({
    code: 'invalid_cursor',
  });
  await expect(labels.listLabels(f.other.actor, { limit: 1, cursor: page.next! })).rejects.toMatchObject({
    code: 'invalid_cursor',
  });
  const before = await f.inspect(actor.accountId);
  await labels.renameLabel(actor, second.id, { name: ' Second\t', revision: 1 }, entryKey());
  const after = await f.inspect(actor.accountId);
  expect(after.events).toEqual(before.events);
  expect(after.partition).toEqual(before.partition);
  await labels.listLabels(actor, { limit: 1, cursor: page.next! });
  for (const input of [
    { name: '' },
    { name: '\u0000' },
    { name: '\ud800' },
    { name: 'x'.repeat(101) },
    { name: 'ok', extra: true },
  ])
    await expect(labels.createLabel(actor, input, entryKey())).rejects.toBeInstanceOf(Error);
  for (const rev of [0, -1, 1.5, 2147483648, Number.NaN])
    await expect(labels.deleteLabel(actor, second.id, rev, entryKey())).rejects.toBeInstanceOf(TypeError);
  for (const id of ['bad', newId((routeOf(actor.accountId)! + 1) % 65536), newId(routeOf(actor.accountId)!)])
    await expect(labels.renameLabel(actor, id, { name: 'x', revision: 1 }, entryKey())).rejects.toBeInstanceOf(
      LibraryNotFoundError,
    );
  await expect(labels.restoreLabel(actor, second.id, 1, entryKey())).rejects.toMatchObject({
    code: 'library_label_restore_stale',
  });
  const renameKey = entryKey(),
    restoreKey = entryKey();
  const renamed = await labels.renameLabel(actor, second.id, { name: 'Renamed', revision: 1 }, renameKey);
  await labels.deleteLabel(actor, second.id, 2, entryKey());
  const restored = await labels.restoreLabel(actor, second.id, 3, restoreKey);
  await labels.renameLabel(actor, second.id, { name: 'Later', revision: 4 }, entryKey());
  expect(await labels.renameLabel(actor, second.id, { name: 'Renamed', revision: 1 }, renameKey)).toMatchObject({
    replayed: true,
    value: renamed.value,
  });
  expect(await labels.restoreLabel(actor, second.id, 3, restoreKey)).toMatchObject({
    replayed: true,
    value: restored.value,
  });
  const inspected = await f.inspect(actor.accountId);
  for (const { row } of inspected.events.filter(({ row }) => row.type === 'com.rezics.library.label.changed.v1')) {
    expect(row.type).toBe('com.rezics.library.label.changed.v1');
    expect(Object.keys(row.data)).toEqual(['labelId']);
  }
  for (const { row } of inspected.receipts) {
    expect(JSON.stringify(row.response)).not.toMatch(/First|Second|Renamed|Later|deletedAt|purgeAfter/);
  }
  await f.revokeIdentity(actor.accountId);
  await expect(labels.readLabel(actor, second.id)).rejects.toBeInstanceOf(GrantDeniedError);
  await expect(labels.listLabels(actor, { cursor: 'broken' })).rejects.toBeInstanceOf(GrantDeniedError);
}, 120000);

function nodes(value: unknown, result: Record<string, unknown>[] = []) {
  if (value && typeof value === 'object') {
    if ('Node Type' in value) result.push(value as Record<string, unknown>);
    for (const child of Object.values(value)) nodes(child, result);
  }
  return result;
}

test('all native catalogue operations keep point and limit-first costs at 64/512/4096 live deleted and same-partition rows', async () => {
  const actor = f.owner.actor,
    other = await neighbour();
  const route = routeOf(actor.accountId)!;
  const reader = db.openPool({ max: 1, options: '-c default_transaction_read_only=on' });
  const samples = new Map<string, GrowthSample[]>();
  let previous = 0,
    deepKey = '',
    deletedDeepKey = '';
  const evidence: { scale: number; operation: string; capture: Capture; cost: Cost }[] = [];
  async function token(after: string, viewer = actor) {
    const p = await readPartition(reader, partitionOf(route));
    if (!p) throw new Error('Missing partition');
    return encodeListCursor(
      f.tokens,
      { route: 'library_label.list', viewer: viewer.accountId, query: { owner: viewer.accountId, limit: 8 } },
      { epoch: p.epoch, after: [after, p.position.toString()] },
      new Date(),
    );
  }
  for (const scale of [64, 512, 4096]) {
    for (let n = previous; n < scale; n++) {
      const dead = (await labels.createLabel(actor, { name: `Deleted ${n}` }, entryKey())).value.label;
      await labels.deleteLabel(actor, dead.id, 1, entryKey());
      if (n === scale - 16) deepKey = dead.id;
      await labels.createLabel(actor, { name: `Live ${n}` }, entryKey());
      const unrelated = (await labels.createLabel(other, { name: `Other ${n}` }, entryKey())).value.label;
      await labels.deleteLabel(other, unrelated.id, 1, entryKey());
      if (n === scale - 16) deletedDeepKey = unrelated.id;
    }
    previous = scale;
    await db.admin.query('VACUUM (ANALYZE)');
    const costs = new Map<string, Cost[]>();
    async function measure<T>(operation: string, work: () => Promise<T>, measured: boolean) {
      const result = await capture(db, work, { includeBackends: true });
      const cost = costOf(result.capture);
      const catalogue = catalogStatementBound(result.capture);
      expect(catalogue.catalogStatements).toBeLessThanOrEqual(catalogue.allowedStatements);
      expect(cost.backgroundStatements ?? 0).toBe(0);
      const plans = result.capture.plans.flatMap((plan) => nodes(plan));
      const labelNodes = plans.filter(
        (node) => node.Schema === 'library' && node['Relation Name'] === 'personal_label',
      );
      expect(labelNodes.length).toBeGreaterThan(0);
      for (const node of labelNodes) {
        if (node['Node Type'] === 'Seq Scan') console.error(JSON.stringify({ operation, scale, node }));
        expect(node['Node Type']).not.toBe('Seq Scan');
        expect(Number(node['Actual Rows']) * Number(node['Actual Loops'])).toBeLessThanOrEqual(
          operation.startsWith('list') ? 8 : 1,
        );
        expect(Number(node['Rows Removed by Filter'] ?? 0) * Number(node['Actual Loops'])).toBe(0);
      }
      if (operation.startsWith('list')) {
        const sql = result.capture.statements.find((s) => /WITH source AS MATERIALIZED/i.test(s));
        expect(sql).toBeDefined();
        expect(sql).not.toMatch(/deleted_at\s+IS\s+NULL|\bOFFSET\b|\bcount\s*\(/i);
        expect(sql).toMatch(/label_id\s*>/);
        expect(plans.some((node) => node['Node Type'] === 'Limit' && Number(node['Actual Rows']) <= 8)).toBe(true);
      }
      if (operation === 'noop') {
        expect(result.capture.statements.some((s) => /UPDATE library\.personal_label/i.test(s))).toBe(false);
        expect(result.capture.statements.some((s) => /INSERT INTO core\.outbox/i.test(s))).toBe(false);
      }
      if (measured) {
        const values = costs.get(operation) ?? [];
        values.push(cost);
        costs.set(operation, values);
        evidence.push({ scale, operation, capture: result.capture, cost });
      }
      return result.value;
    }
    for (let run = 0; run < 6; run++) {
      const measured = run > 0,
        name = `Probe ${scale} ${run}`;
      const created = await measure('create', () => labels.createLabel(actor, { name }, entryKey()), measured);
      const id = created.value.label.id;
      await measure(
        'rename',
        () => labels.renameLabel(actor, id, { name: `${name}!`, revision: 1 }, entryKey()),
        measured,
      );
      await measure(
        'noop',
        () => labels.renameLabel(actor, id, { name: `${name}!`, revision: 2 }, entryKey()),
        measured,
      );
      await measure('read', () => labels.readLabel(actor, id), measured);
      await measure('delete', () => labels.deleteLabel(actor, id, 2, entryKey()), measured);
      await measure('restore', () => labels.restoreLabel(actor, id, 3, entryKey()), measured);
      const first = await measure('list-first', () => labels.listLabels(actor, { limit: 8 }), measured);
      expect(first.labels.length).toBeLessThan(8);
      const cursor = await token(deepKey);
      const deep = await measure('list-deep', () => labels.listLabels(actor, { limit: 8, cursor }), measured);
      expect(deep.next).toBeTruthy();
      const empty = await measure('list-empty', () => labels.listLabels(other, { limit: 8 }), measured);
      expect(empty.labels).toEqual([]);
      expect(empty.next).toBeTruthy();
      const deletedCursor = await token(deletedDeepKey, other);
      const emptyDeep = await measure(
        'list-empty-deep',
        () => labels.listLabels(other, { limit: 8, cursor: deletedCursor }),
        measured,
      );
      expect(emptyDeep.labels).toEqual([]);
      expect(emptyDeep.next).toBeTruthy();
    }
    for (const [operation, repetitions] of costs) {
      const series = samples.get(operation) ?? [];
      series.push({ scale, cost: medianCost(repetitions), repetitions });
      samples.set(operation, series);
    }
  }
  mkdirSync('.temp/label-catalogue', { recursive: true });
  writeFileSync('.temp/label-catalogue/native-growth.json', JSON.stringify(evidence));
  for (const [operation, series] of samples) {
    console.info(JSON.stringify({ operation, samples: series }));
    assertGrowth(series, { rows: 'constant', statements: 'constant', blocks: 'logarithmic' });
  }
}, 1800000);
