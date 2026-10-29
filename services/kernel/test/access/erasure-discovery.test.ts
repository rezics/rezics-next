import { afterAll, beforeAll, expect, test } from 'bun:test';
import { discoverErasurePage, ERASURE_DISCOVERY_ROLES } from '../../src/access/erasure-progress.ts';
import { LifecycleDeniedError } from '../../src/access/lifecycle-20261025094010-command.ts';
import { createPool } from '../../src/database/pool.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { capture, checkGrowth, costOf, measure, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

let db: GrowthDatabase;
const at = '2026-10-01T00:00:00Z';
const later = '2026-10-01T00:01:00Z';
const digest = 'a'.repeat(64);
const valid = '[2026-01-01,2026-01-02)';
beforeAll(async () => {
  db = await openGrowthDatabase();
});
afterAll(async () => {
  await db?.close();
});

async function insert(table: string, values: Record<string, unknown>) {
  const columns = Object.keys(values);
  return (
    await db.admin.query(
      `INSERT INTO access.${table} (${columns.join(',')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`,
      Object.values(values),
    )
  ).rows[0]!;
}
async function account(id = newId(64)) {
  await insert('account', { route: routeOf(id), account_id: id, kind: 'actor', state: 'deleted', transaction_id: id });
  return id;
}
async function obligation(id = newId(64)) {
  await account(id);
  await insert('erasure', { route: routeOf(id), account_id: id, version: 1, at });
  return id;
}
const discover = (accountId: string, store: string, role: string, page = 0) =>
  discoverErasurePage(db.pool, { accountId, store, role, page });

/** Native fixtures keep all constraints and immutability guards enabled. */
async function residue(table: string, role: string, id: string, routing: string) {
  const route = routing === 'owner' ? routeOf(id)! : 1;
  const nativeId = newId(route);
  const base = { route, transaction_id: newId(route) };
  const common = { account_id: nativeId };
  const receipt = { account_id: nativeId, receipt_id: newId(route) };
  const relation = { organization_id: nativeId, member_account_id: newId(2), reservation_id: newId(route) };
  const fixtures: Record<string, Record<string, unknown>> = {
    account: { ...common, kind: 'actor', state: 'active' },
    account_preferences: { ...common, spoiler_level: 0, suitability: 'show', version: 1 },
    agent_page: { subject_id: nativeId, account_id: newId(2), verification_receipt_id: newId(route) },
    agent_verification_request: {
      route: 0,
      request_id: newId(0),
      account_id: newId(2),
      account_kind: 'actor',
      requested_by: newId(2),
      catalogue_subject_id: newId(0),
      statement: 'Private evidence',
      state: 'approved',
      decision_receipt_id: newId(0),
      decided_by: newId(2),
    },
    committed_continuation: {
      ...common,
      continuation_id: newId(route),
      operation_key: 'erasure-test',
      operation_digest: digest,
      command_key_prefix: `wf:${digest}`,
      barrier_receipt_id: newId(route),
      barrier_transaction_id: newId(route),
      minimum_authn_epoch: 1,
      prior_operator_account_id: newId(2),
      prior_reservation_id: newId(route),
      allowlist: JSON.stringify([{ step: 'release', target: id, key: 'release', digest }]),
      digest,
      created_at: at,
      committed_expires_at: later,
      expires_at: later,
    },
    credential_floor_receipt: {
      ...common,
      opening_receipt_id: newId(route),
      receipt_id: newId(route),
      operation_key: 'credential-test',
      effect_reference: 'private',
      effect_digest: digest,
      purpose: 'set-password',
      previous_floor: 1,
      minimum_authn_epoch: 2,
      fenced: true,
    },
    erasure_acknowledgement: { account_id: id, participant: 'access', outcome: 'erased', route: routeOf(id) },
    governance_bootstrap: { route: 0, resource_id: '00000000-0000-8000-8000-000000000000', account_id: id },
    governance_reach: { resource_id: nativeId, actor_account_id: newId(2), action: 'access:grant' },
    handle_claim: { route: 2, normalized_handle: 'discovery3050', account_id: id, state: 'active' },
    lifecycle_coordination: {
      ...common,
      related_account_id: newId(2),
      reservation_id: newId(route),
      purpose: 'membership',
    },
    lifecycle_fence_receipt: { ...receipt, minimum_authn_epoch: 2, kind: 'fence', prior_operator_account_id: newId(2) },
    lifecycle_handle_effect: {
      account_id: id,
      normalized_handle: 'old-handle',
      reservation_id: newId(route),
      operation_id: 'old-operation',
      effect: 'reserved',
    },
    lifecycle_handle_operation: {
      ...common,
      operation_id: 'old-operation',
      handle: 'old-handle',
      reservation_id: newId(route),
      state: 'completed',
    },
    lifecycle_membership_slot: { ...relation, terminal: true },
    lifecycle_registration_expiry: { ...common, reservation_id: newId(route), handle: 'old-handle' },
    membership_inverse: { ...common, kind: 'organization', group_id: newId(2), reservation_id: newId(route) },
    membership_inverse_terminal: {
      ...common,
      kind: 'organization',
      group_id: newId(2),
      reservation_id: newId(route),
      reservation_transaction_id: newId(route),
      proof_transaction_id: newId(route),
    },
    operator_opening_receipt: {
      operator_account_id: nativeId,
      receipt_id: newId(route),
      subject_account_id: newId(2),
      acting_human_id: newId(2),
      purpose: 'session',
      action: 'account:update',
      client_id: 'test',
      scopes: [],
      human_authn_epoch: 1,
      human_epoch_floor: 1,
      operator_epoch_floor: 1,
      subject_epoch_floor: 1,
      relation_version: 1,
      reservation_id: newId(route),
      created_at: at,
      expires_at: later,
    },
    operator_relation_slot: {
      subject_account_id: nativeId,
      operator_account_id: newId(2),
      reservation_id: newId(route),
    },
    organization_close: {
      organization_id: nativeId,
      receipt_id: newId(route),
      cursor_member: newId(2),
      handle_key: 'close',
    },
    organization_member: { organization_id: nativeId, member_account_id: newId(2), role: 'member', valid },
    principal_assignment: {
      principal_id: nativeId,
      request_id: newId(route),
      assigned_actor_id: newId(2),
      creator_principal_id: nativeId,
      valid,
    },
    rating_counter_controller: { ...common, controller_id: newId(2), effective_at: at },
    resource_denial: { resource_id: nativeId, subject_id: newId(2), action: 'account:read', reason: 'resource', valid },
    resource_grant: { resource_id: nativeId, subject_id: newId(2), action: 'account:read', valid },
    resource_role_grant: { resource_id: nativeId, subject_id: newId(2), grant_role: 'reader', valid },
    resource_initialization: {
      resource_id: nativeId,
      resource_type: 'account',
      creator_id: newId(2),
      initialized_at: at,
    },
    standing_parent_installation: { resource_id: nativeId, actions: ['account:read'] },
    workflow_approval: {
      approval_id: newId(route),
      actor_id: nativeId,
      client_id: 'test',
      scopes: [],
      authn_epoch: 1,
      operation_key: 'approval',
      operation: '{}',
      digest,
      created_at: at,
      expires_at: later,
      jwt_expires_at: later,
    },
  };
  if ((table === 'account' || table === 'erasure') && role === 'account_id') return;
  const row: Record<string, unknown> = { ...base, ...fixtures[table], [role]: id };
  if (table === 'principal_assignment' && role !== 'assigned_actor_id') {
    row.principal_id = id;
    row.creator_principal_id = id;
  }
  if (table === 'lifecycle_fence_receipt' && role === 'operator_account_id') {
    row.operator_reservation_id = newId(route);
    row.operator_continuation_id = newId(route);
  }
  if (table === 'committed_continuation' && row.account_id !== id) await account(row.account_id as string);
  // Some native tables have no transaction column.
  for (const name of [
    'account_preferences',
    'agent_page',
    'rating_counter_controller',
    'resource_initialization',
    'organization_close',
    'erasure_acknowledgement',
  ])
    if (table === name) delete (row as Record<string, unknown>).transaction_id;
  await insert(table, row);
}

// Independent inventory assertion prevents a missing descriptor from silently dropping a role's test.
const inventory: Record<string, string> = {
  account: 'account_id,operator_account_id,controller_id',
  account_preferences: 'account_id',
  agent_page: 'account_id',
  agent_verification_request: 'account_id,requested_by,decided_by',
  committed_continuation: 'account_id,prior_operator_account_id',
  credential_floor_receipt: 'account_id',
  erasure: 'account_id',
  erasure_acknowledgement: 'account_id',
  governance_bootstrap: 'account_id',
  governance_reach: 'actor_account_id,resource_id',
  handle_claim: 'account_id',
  lifecycle_coordination: 'account_id,related_account_id',
  lifecycle_fence_receipt: 'account_id,prior_operator_account_id,operator_account_id',
  lifecycle_handle_effect: 'account_id',
  lifecycle_handle_operation: 'account_id',
  lifecycle_membership_slot: 'organization_id,member_account_id',
  lifecycle_registration_expiry: 'account_id',
  membership_inverse: 'account_id,group_id',
  membership_inverse_terminal: 'account_id,group_id',
  operator_opening_receipt: 'operator_account_id,subject_account_id,acting_human_id',
  operator_relation_slot: 'subject_account_id,operator_account_id',
  organization_close: 'organization_id,cursor_member',
  organization_member: 'organization_id,member_account_id',
  principal_assignment: 'principal_id,creator_principal_id,assigned_actor_id',
  rating_counter_controller: 'account_id,controller_id',
  resource_denial: 'resource_id,subject_id',
  resource_grant: 'resource_id,subject_id',
  resource_initialization: 'resource_id,creator_id',
  resource_role_grant: 'resource_id,subject_id',
  standing_parent_installation: 'resource_id',
  workflow_approval: 'actor_id',
};
test('every scalar role in the adopted Access inventory is covered', () => {
  expect(ERASURE_DISCOVERY_ROLES.map(([store, role]) => `${store}.${role}`).sort()).toEqual(
    Object.entries(inventory)
      .flatMap(([store, roles]) => roles.split(',').map((role) => `${store}.${role}`))
      .sort(),
  );
});

function nodes(value: unknown): Record<string, unknown>[] {
  if (!value || typeof value !== 'object') return [];
  return [value as Record<string, unknown>, ...Object.values(value).flatMap(nodes)];
}
for (const [store, role, routing] of ERASURE_DISCOVERY_ROLES) {
  test(`${store}.${role}: indexed native discovery preserves the row and all payload`, async () => {
    const id = await obligation();
    await residue(store, role, id, routing);
    const snapshot = async () =>
      (await db.admin.query(`SELECT to_jsonb(t) AS row FROM access.${store} t WHERE ${role}=$1`, [id])).rows;
    const before = await snapshot();
    expect(before.length).toBeGreaterThan(0);
    await db.admin.query(`VACUUM (ANALYZE) access.${store}`);
    const { value, capture: measured } = await capture(db, () => discover(id, store, role));
    expect(value.keys.length).toBe(before.length);
    expect(value.partition).toBe(routing === 'owner' ? 4 : 0);
    expect(await snapshot()).toEqual(before);
    const scans = measured.plans.flatMap(nodes).filter((node) => node['Relation Name'] === store);
    expect(scans.some((node) => String(node['Node Type']).includes('Index'))).toBe(true);
    expect(scans.some((node) => node['Node Type'] === 'Seq Scan')).toBe(false);
    const indexes = await db.admin.query(
      `SELECT i.relname AS name, a.attname AS first
      FROM pg_index x JOIN pg_class i ON i.oid=x.indexrelid
      JOIN pg_attribute a ON a.attrelid=x.indrelid AND a.attnum=x.indkey[0]
      WHERE x.indrelid=$1::regclass AND i.relname LIKE 'erasure_%'`,
      [`access.${store}`],
    );
    const roleIndexes = indexes.rows.filter((index) => index.first === role).map((index) => index.name);
    expect(roleIndexes.length).toBeGreaterThan(0);
    expect(scans.some((node) => roleIndexes.includes(node['Index Name']))).toBe(true);
    expect(costOf(measured).statements).toBeLessThanOrEqual(8 + 4 * value.keys.length);
  });
}

async function history(id: string, route: number, count: number) {
  await db.admin.query(
    `INSERT INTO access.organization_member(route,organization_id,member_account_id,role,valid,transaction_id)
    SELECT $1,org,$2,'member',tstzrange('2026-01-01','2026-01-02','[)'),org FROM unnest($3::uuid[]) org`,
    [route, id, Array.from({ length: count }, () => newId(route))],
  );
}

test('pages select 100 keys with one lookahead; store/role cursors cross partitions independently and find closed history absent from the inverse', async () => {
  const id = await obligation();
  await history(id, 1, 205);
  await history(id, 15, 1);
  await history(id, 16, 2);
  expect((await db.admin.query('SELECT 1 FROM access.membership_inverse WHERE account_id=$1', [id])).rowCount).toBe(0);
  const results = [];
  for (let page = 0; page < 4; page++) {
    const { value, cost } = await measure(db, () => discover(id, 'organization_member', 'member_account_id', page));
    expect(cost.relations['access.organization_member']?.rows).toBeLessThanOrEqual(101);
    results.push(value);
  }
  expect(results.map((result) => [result.partition, result.keys.length])).toEqual([
    [0, 100],
    [0, 100],
    [0, 6],
    [1, 2],
  ]);
  expect(new Set(results.flatMap((result) => result.keys.map((key) => JSON.stringify(key)))).size).toBe(208);
  const independent = await discover(id, 'lifecycle_membership_slot', 'member_account_id');
  expect(independent.partition).toBe(0);
  const otherRole = await discover(id, 'organization_member', 'organization_id');
  expect(otherRole.partition).toBe(4);
  expect(otherRole.done).toBe(true);
  // All sixteen routes in a partition share one native range statement.
  const { capture: measured } = await capture(db, () => discover(id, 'organization_member', 'member_account_id', 4));
  expect(measured.statements.filter((sql) => sql.includes('FROM access.organization_member'))).toHaveLength(1);
});

test('a lost response replays the committed keys, and the next page neither repeats nor skips; pre-commit failure rolls back progress', async () => {
  const id = await obligation();
  await history(id, 1, 201);
  const first = await discover(id, 'organization_member', 'member_account_id');
  const restarted = createPool(db.url);
  try {
    const input = { accountId: id, store: 'organization_member', role: 'member_account_id', page: 0 };
    const replay = await capture(db, () => discoverErasurePage(restarted, input));
    expect(replay.value).toEqual(first);
    expect(replay.capture.statements.some((sql) => sql.includes('FROM access.organization_member'))).toBe(false);
    const next = await discoverErasurePage(restarted, { ...input, page: 1 });
    const last = await discoverErasurePage(restarted, { ...input, page: 2 });
    expect(new Set([...first.keys, ...next.keys, ...last.keys].map((key) => JSON.stringify(key))).size).toBe(201);
  } finally {
    await restarted.end();
  }
  const failId = await obligation();
  await history(failId, 1, 101);
  await db.admin.query(`CREATE FUNCTION public.reject_discovery() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.last_page >= 0 THEN RAISE EXCEPTION 'page commit failed'; END IF; RETURN NEW; END $$`);
  await db.admin.query(
    `CREATE TRIGGER reject_discovery BEFORE UPDATE ON access.erasure_progress FOR EACH ROW EXECUTE FUNCTION public.reject_discovery()`,
  );
  try {
    await expect(discover(failId, 'organization_member', 'member_account_id')).rejects.toThrow('page commit failed');
  } finally {
    await db.admin.query('DROP TRIGGER reject_discovery ON access.erasure_progress');
    await db.admin.query('DROP FUNCTION public.reject_discovery()');
  }
  expect((await db.admin.query('SELECT 1 FROM access.erasure_progress WHERE account_id=$1', [failId])).rowCount).toBe(
    0,
  );
  expect((await discover(failId, 'organization_member', 'member_account_id')).keys).toHaveLength(100);
});

test('missing and uncommitted obligations are refused before progress or native reads', async () => {
  for (const id of [newId(64), await account()]) {
    const { capture: measured } = await capture(db, async () => {
      await expect(discover(id, 'organization_member', 'member_account_id')).rejects.toBeInstanceOf(
        LifecycleDeniedError,
      );
    });
    expect(measured.statements.filter((sql) => /SELECT|INSERT|UPDATE/i.test(sql))).toHaveLength(1);
    expect(costOf(measured).relations['access.organization_member']).toBeUndefined();
  }
  const id = await account();
  const writer = await db.admin.connect();
  try {
    await writer.query('BEGIN');
    await writer.query('INSERT INTO access.erasure(route,account_id,version,at) VALUES(64,$1,1,$2)', [id, at]);
    await expect(discover(id, 'organization_member', 'member_account_id')).rejects.toBeInstanceOf(LifecycleDeniedError);
  } finally {
    await writer.query('ROLLBACK');
    writer.release();
  }
});

test('oversized pages and locators are refused atomically; no payload is fetched', async () => {
  for (const [length, count] of [
    [800, 100],
    [1100, 1],
  ]) {
    const id = await obligation();
    await db.admin.query(
      `INSERT INTO access.lifecycle_handle_operation(route,account_id,operation_id,handle,reservation_id,state,transaction_id)
      SELECT 64,$1,repeat('x',$2)||n,'old-handle',$1,'completed',$1 FROM generate_series(1,$3) n`,
      [id, length, count],
    );
    await expect(discover(id, 'lifecycle_handle_operation', 'account_id')).rejects.toThrow('byte bound');
    expect((await db.admin.query('SELECT 1 FROM access.erasure_progress WHERE account_id=$1', [id])).rowCount).toBe(0);
  }
  const id = await obligation();
  await insert('agent_page', { route: 1, subject_id: newId(1), account_id: id, verification_receipt_id: newId(1) });
  const { value, capture: measured } = await capture(db, () => discover(id, 'agent_page', 'account_id'));
  expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThanOrEqual(65536);
  const native = measured.statements.find((sql) => sql.includes('FROM access.agent_page'))!;
  expect(native).not.toContain('verification_receipt_id');
});

test('identity sentinel grants are not mistaken for account roles; compact keys remain bounded for long permission vocabulary', async () => {
  const id = await obligation();
  const resourceId = newId(1);
  await insert('resource_grant', {
    route: 1,
    resource_id: resourceId,
    subject_id: id,
    action: `account:${'a'.repeat(2000)}`,
    valid,
    transaction_id: resourceId,
  });
  await insert('resource_grant', {
    route: 1,
    resource_id: resourceId,
    subject_id: '00000000-0000-0000-0000-000000000000',
    subject_kind: 'active_accounts',
    action: 'account:read',
    valid,
    transaction_id: resourceId,
  });
  const result = await discover(id, 'resource_grant', 'subject_id');
  expect(result.keys).toHaveLength(1);
  expect(Buffer.byteLength(JSON.stringify(result.keys[0]))).toBeLessThan(1024);
});

for (const path of ['page', 'deep', 'empty', 'denied', 'retry']) {
  test(`growth: ${path} holds native statements, examined rows and selected keys fixed at 1/100/10000 unrelated rows and history`, async () => {
    const id = await obligation();
    const deniedId = newId(64);
    await history(id, 1, 202);
    const initial = await discover(id, 'organization_member', 'member_account_id');
    const saved = (await db.admin.query('SELECT * FROM access.erasure_progress WHERE account_id=$1', [id])).rows[0]!;
    let selected: string | undefined;
    const report = await checkGrowth(db, {
      name: `Access erasure discovery ${path}`,
      scales: [1, 100, 10000],
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      indexProbes: 5,
      async grow(database, scale, previous) {
        await history(newId(64), 1, scale - previous);
        const ids = Array.from({ length: scale - previous }, () => newId(64));
        await database.admin.query(
          `INSERT INTO access.account(route,account_id,kind,state,transaction_id) SELECT 64,id,'actor','deleted',id FROM unnest($1::uuid[]) id`,
          [ids],
        );
        await database.admin.query(
          `INSERT INTO access.erasure(route,account_id,version,at) SELECT 64,id,1,$2 FROM unnest($1::uuid[]) id`,
          [ids, at],
        );
        await database.admin.query(
          `INSERT INTO access.erasure_progress(route,account_id,store,role,partition_no) SELECT 64,id,'organization_member','member_account_id',0 FROM unnest($1::uuid[]) id`,
          [ids],
        );
      },
      async operation() {
        // Reset only this fixture's checkpoint through the uninstrumented admin connection.
        await db.admin.query(
          `UPDATE access.erasure_progress SET partition_no=$2,cursor=$3,state='discovering',last_page=$4,result=$5 WHERE account_id=$1`,
          [
            id,
            path === 'empty' ? 2 : 0,
            path === 'deep' ? saved.cursor : null,
            path === 'retry' ? 0 : -1,
            path === 'retry' ? JSON.stringify(initial) : null,
          ],
        );
        if (path === 'denied') {
          await expect(discover(deniedId, 'organization_member', 'member_account_id')).rejects.toBeInstanceOf(
            LifecycleDeniedError,
          );
          return;
        }
        const result = await discover(id, 'organization_member', 'member_account_id');
        const keys = JSON.stringify(result.keys);
        selected ??= keys;
        expect(keys).toBe(selected);
      },
    });
    expect(new Set(report.samples.map(({ cost }) => cost.statements)).size).toBe(1);
    expect(new Set(report.samples.map(({ cost }) => cost.rows)).size).toBe(1);
    for (const { cost } of report.samples) {
      expect(cost.relations['access.organization_member']?.rows ?? 0).toBeLessThanOrEqual(101);
      expect(cost.relations['access.organization_member']?.sequentialScans ?? 0).toBe(0);
      expect(cost.statements).toBeLessThanOrEqual(8 + 4 * 100);
    }
  }, 180000);
}
