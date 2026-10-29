import { afterAll, beforeAll, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
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
  capture,
  checkGrowth,
  catalogStatementBound,
  openGrowthDatabase,
  settle,
  type GrowthDatabase,
  seed,
  type Population,
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
  const actor = f.owner.actor;
  const other = await neighbour();
  const route = routeOf(actor.accountId)!;
  const partition = partitionOf(route);
  expect(partitionOf(routeOf(other.accountId)!)).toBe(partition);

  // Every seed template comes from the real native command path under genuine owner authority.
  async function template(owner: typeof actor, name: string, deleted: boolean) {
    const label = (await labels.createLabel(owner, { name }, entryKey())).value.label;
    if (deleted) await labels.deleteLabel(owner, label.id, 1, entryKey());
    const result = await db.admin.query(
      'SELECT route, account_id, label_id, normalized_name, revision, created_at, updated_at, transaction_id, deleted_at, purge_after FROM library.personal_label WHERE route=$1 AND account_id=$2 AND label_id=$3',
      [routeOf(owner.accountId), owner.accountId, label.id],
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.deleted_at !== null).toBe(deleted);
    return result.rows[0]!;
  }
  const templates = {
    ownerLive: await template(actor, 'Growth owner live template', false),
    ownerDeleted: await template(actor, 'Growth owner deleted template', true),
    otherDeleted: await template(other, 'Growth neighbour deleted template', true),
  };
  const names = ['owner-live', 'owner-deleted', 'neighbour-deleted'] as const;
  const seedNamespace = `Background ${crypto.randomUUID()}`;
  const population: Population = {
    name: 'personal-label-catalogue-background',
    hotPartition: partition,
    hotShare: 1,
    rows(placement) {
      const row = (templateRow: Record<string, unknown>, category: string) => ({
        ...templateRow,
        label_id: newId(routeOf(String(templateRow.account_id))!),
        normalized_name: `${seedNamespace} ${category} ${placement.ordinal}`,
      });
      return {
        'library.personal_label': [
          row(templates.ownerLive, names[0]),
          row(templates.ownerDeleted, names[1]),
          row(templates.otherDeleted, names[2]),
        ],
      };
    },
  };
  const scales = [64, 512, 4096] as const;
  let grownTo = 0;
  const counts: Record<string, unknown> = {};
  async function grow(database: GrowthDatabase, scale: number) {
    if (scale > grownTo) {
      await seed(database, population, { from: grownTo * 32, to: scale * 32 });
      grownTo = scale;
    }
    const expectedPerCategory = 32 * scale;
    for (const category of names) {
      const count = await database.admin.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM library.personal_label WHERE normalized_name LIKE $1',
        [`${seedNamespace} ${category} %`],
      );
      expect(Number(count.rows[0]!.count)).toBe(expectedPerCategory);
    }
    const total = await database.admin.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM library.personal_label',
    );
    const bytes = await database.admin.query<{ tableBytes: string; totalBytes: string }>(
      `SELECT pg_relation_size('library.personal_label')::text AS "tableBytes",
              pg_total_relation_size('library.personal_label')::text AS "totalBytes"`,
    );
    counts[String(scale)] = {
      perOrdinal: 3,
      ordinals: scale,
      backgroundPerCategory: expectedPerCategory,
      backgroundTotal: expectedPerCategory * names.length,
      personalLabelRows: Number(total.rows[0]!.count),
      tableBytes: Number(bytes.rows[0]!.tableBytes),
      totalBytes: Number(bytes.rows[0]!.totalBytes),
    };
  }

  const index = await db.admin.query<{ indexname: string; indexdef: string }>(
    "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname='library' AND tablename='personal_label'",
  );
  const primaryKeyIndex = index.rows.find((item) => item.indexdef.includes('(route, account_id, label_id)'))?.indexname;
  const liveNameIndex = index.rows.find(
    (item) =>
      item.indexdef.includes('(route, account_id, normalized_name)') && item.indexdef.includes('deleted_at IS NULL'),
  )?.indexname;
  if (!primaryKeyIndex || !liveNameIndex) throw new Error('Missing personal label primary or live-name index');
  const reader = db.openPool({ max: 1, options: '-c default_transaction_read_only=on' });
  async function token(after: string, viewer = actor) {
    const p = await readPartition(reader, partitionOf(routeOf(viewer.accountId)!));
    if (!p) throw new Error('Missing partition');
    return encodeListCursor(
      f.tokens,
      { route: 'library_label.list', viewer: viewer.accountId, query: { owner: viewer.accountId, limit: 8 } },
      { epoch: p.epoch, after: [after, p.position.toString()] },
      new Date(),
    );
  }
  async function middleDeletedId(owner: typeof actor) {
    const result = await db.admin.query<{ label_id: string }>(
      'SELECT label_id FROM library.personal_label WHERE route=$1 AND account_id=$2 AND deleted_at IS NOT NULL ORDER BY label_id OFFSET $3 LIMIT 1',
      [routeOf(owner.accountId), owner.accountId, Math.floor((grownTo * 32) / 2)],
    );
    if (!result.rows[0]) throw new Error('Missing deleted cursor anchor');
    return result.rows[0].label_id;
  }
  type State = { id?: string; name?: string; cursor?: string };
  type Operation = {
    name: string;
    prepare(): Promise<State>;
    run(state: State): Promise<unknown>;
    assert(value: any): void;
  };
  const operations: Operation[] = [
    {
      name: 'create',
      async prepare() {
        return {};
      },
      async run() {
        return labels.createLabel(actor, { name: `Growth create ${entryKey()}` }, entryKey());
      },
      assert(value) {
        expect(value.value.label.revision).toBe(1);
      },
    },
    {
      name: 'rename',
      async prepare() {
        const name = `Growth rename ${entryKey()}`;
        return { id: (await labels.createLabel(actor, { name }, entryKey())).value.label.id };
      },
      async run(state) {
        return labels.renameLabel(actor, state.id!, { name: `Renamed ${entryKey()}`, revision: 1 }, entryKey());
      },
      assert(value) {
        expect(value.value.label.revision).toBe(2);
      },
    },
    {
      name: 'noop',
      async prepare() {
        const name = `Growth noop ${entryKey()}`;
        return { id: (await labels.createLabel(actor, { name }, entryKey())).value.label.id, name };
      },
      async run(state) {
        return labels.renameLabel(actor, state.id!, { name: state.name!, revision: 1 }, entryKey());
      },
      assert(value) {
        expect(value.value.label.revision).toBe(1);
      },
    },
    {
      name: 'read',
      async prepare() {
        return {
          id: (await labels.createLabel(actor, { name: `Growth read ${entryKey()}` }, entryKey())).value.label.id,
        };
      },
      async run(state) {
        return labels.readLabel(actor, state.id!);
      },
      assert(value) {
        expect(value.id).toBeTruthy();
      },
    },
    {
      name: 'delete',
      async prepare() {
        return {
          id: (await labels.createLabel(actor, { name: `Growth delete ${entryKey()}` }, entryKey())).value.label.id,
        };
      },
      async run(state) {
        return labels.deleteLabel(actor, state.id!, 1, entryKey());
      },
      assert(value) {
        expect(value.value).toEqual({ deleted: true, revision: 2 });
      },
    },
    {
      name: 'restore',
      async prepare() {
        const id = (await labels.createLabel(actor, { name: `Growth restore ${entryKey()}` }, entryKey())).value.label
          .id;
        await labels.deleteLabel(actor, id, 1, entryKey());
        return { id };
      },
      async run(state) {
        return labels.restoreLabel(actor, state.id!, 2, entryKey());
      },
      assert(value) {
        expect(value.value.label.revision).toBe(3);
      },
    },
    {
      name: 'list-first',
      async prepare() {
        return {};
      },
      async run() {
        return labels.listLabels(actor, { limit: 8 });
      },
      assert(value) {
        expect(value.labels.length).toBeLessThanOrEqual(8);
        expect(value.next).toBeTruthy();
      },
    },
    {
      name: 'list-deep',
      async prepare() {
        return { cursor: await token(await middleDeletedId(actor)) };
      },
      async run(state) {
        return labels.listLabels(actor, { limit: 8, ...(state.cursor === undefined ? {} : { cursor: state.cursor }) });
      },
      assert(value) {
        expect(value.labels.length).toBeLessThanOrEqual(8);
        expect(value.next).toBeTruthy();
      },
    },
    {
      name: 'list-empty',
      async prepare() {
        return {};
      },
      async run() {
        return labels.listLabels(other, { limit: 8 });
      },
      assert(value) {
        expect(value.labels).toEqual([]);
        expect(value.next).toBeTruthy();
      },
    },
    {
      name: 'list-empty-deep',
      async prepare() {
        return { cursor: await token(await middleDeletedId(other), other) };
      },
      async run(state) {
        return labels.listLabels(other, { limit: 8, ...(state.cursor === undefined ? {} : { cursor: state.cursor }) });
      },
      assert(value) {
        expect(value.labels).toEqual([]);
        expect(value.next).toBeTruthy();
      },
    },
  ];

  const priorProfile = process.env.GROWTH_PROFILE;
  const profilePath = '.temp/label-catalogue/GROWTH_PROFILE.jsonl';
  mkdirSync(dirname(profilePath), { recursive: true });
  writeFileSync(profilePath, '');
  process.env.GROWTH_PROFILE = profilePath;
  const evidence: { scale: number; operation: string; capture: unknown }[] = [];
  async function assertCapturedOperation(scale: number, operation: Operation) {
    const state = await operation.prepare();
    const result = await capture(db, () => operation.run(state), { includeBackends: true });
    operation.assert(result.value);
    const catalogue = catalogStatementBound(result.capture);
    expect(catalogue.catalogStatements).toBeLessThanOrEqual(catalogue.allowedStatements);
    const plans = result.capture.plans.flatMap((plan) => nodes(plan));
    const labelNodes = plans.filter((node) => node.Schema === 'library' && node['Relation Name'] === 'personal_label');
    expect(labelNodes.length).toBeGreaterThan(0);
    for (const node of labelNodes) {
      expect(node['Node Type']).not.toBe('Seq Scan');
      if (typeof node['Index Name'] === 'string')
        expect([primaryKeyIndex, liveNameIndex]).toContain(node['Index Name']);
      expect(Number(node['Actual Rows']) * Number(node['Actual Loops'])).toBeLessThanOrEqual(
        operation.name.startsWith('list') ? 8 : 1,
      );
      const removed = Number(node['Rows Removed by Filter'] ?? 0) * Number(node['Actual Loops']);
      if (removed !== 0)
        throw new Error(
          `${operation.name} examined unrelated personal labels: ${JSON.stringify({
            node,
            profile: counts[String(scale)],
          })}`,
        );
    }
    if (operation.name !== 'create')
      expect(labelNodes.some((node) => node['Index Name'] === primaryKeyIndex)).toBe(true);
    if (operation.name.startsWith('list')) {
      const sql = result.capture.statements.find((statement) => /WITH source AS MATERIALIZED/i.test(statement));
      expect(sql).toBeDefined();
      expect(sql).not.toMatch(/deleted_at\s+IS\s+NULL|\bOFFSET\b|\bcount\s*\(/i);
      expect(sql).toMatch(/label_id\s*>/);
      expect(plans.some((node) => node['Node Type'] === 'Limit' && Number(node['Actual Rows']) === 8)).toBe(true);
      expect(labelNodes.some((node) => Number(node['Actual Rows']) === 8)).toBe(true);
    }
    if (operation.name === 'noop') {
      expect(result.capture.statements.some((statement) => /UPDATE library\.personal_label/i.test(statement))).toBe(
        false,
      );
      expect(result.capture.statements.some((statement) => /INSERT INTO core\.outbox/i.test(statement))).toBe(false);
    }
    evidence.push({ scale, operation: operation.name, capture: result.capture });
  }

  const states = new Map<number, State[]>();
  const report = await checkGrowth(db, {
    name: 'Personal label catalogue operations',
    scales,
    rule: 'series',
    warmups: 1,
    repetitions: 5,
    includeBackends: true,
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    async grow(database, scale) {
      await grow(database, scale);
      for (const operation of operations) await assertCapturedOperation(scale, operation);
    },
    async warmup() {
      for (const operation of operations) operation.assert(await operation.run(await operation.prepare()));
    },
    async prepare(database, _scale, repetition) {
      const prepared = new Array<State>(operations.length);
      for (const [index, operation] of operations.entries())
        if (!operation.name.startsWith('list')) prepared[index] = await operation.prepare();
      for (const [index, operation] of operations.entries())
        if (operation.name.startsWith('list')) prepared[index] = await operation.prepare();
      await settle(database);
      states.set(repetition, prepared);
    },
    async operation(_database, _scale, repetition) {
      const prepared = states.get(repetition);
      if (!prepared) throw new Error(`Missing fresh operation states for repetition ${repetition}`);
      const ordered = [
        ...operations
          .map((operation, index) => ({ operation, state: prepared[index]! }))
          .filter(({ operation }) => operation.name.startsWith('list')),
        ...operations
          .map((operation, index) => ({ operation, state: prepared[index]! }))
          .filter(({ operation }) => !operation.name.startsWith('list')),
      ];
      for (const { operation, state } of ordered) operation.assert(await operation.run(state));
    },
  });
  for (const sample of report.samples) {
    const relation = sample.cost.relations['library.personal_label'];
    expect(relation).toBeDefined();
    expect(relation!.sequentialScans).toBe(0);
    const boundedRows = operations.reduce(
      (total, operation) => total + (operation.name.startsWith('list') ? 16 : 2),
      0,
    );
    expect(relation!.rows).toBeLessThanOrEqual(boundedRows);
    expect(sample.cost.backgroundStatements ?? 0).toBe(0);
  }
  mkdirSync('.temp/label-catalogue', { recursive: true });
  writeFileSync('.temp/label-catalogue/native-growth.json', JSON.stringify(evidence));
  appendFileSync(
    profilePath,
    `${JSON.stringify({ check: 'personal-label-catalogue-population', multiplicity: 32, rowsPerOrdinal: 3, seedNamespace, counts })}\n`,
  );
  if (priorProfile === undefined) delete process.env.GROWTH_PROFILE;
  else process.env.GROWTH_PROFILE = priorProfile;
  await reader.end();
}, 1800000);
