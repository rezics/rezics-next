import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { readContextRoleProvenance, type ContextRoleProvenance } from '../../src/access/shared-history-context.ts';
import { runCommand, type CommandTransaction } from '../../src/command/command.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { enrollContextRoleProvenance } from '../../src/semantic/context-role-provenance.ts';
import {
  beginSemanticErasure,
  createSemanticLocatorEffect,
  SEMANTIC_LOCATOR_SCHEDULED,
} from '../../src/semantic/account-erasure.ts';
import { accountErasureFixture, type AccountErasureFixture } from './support/account-erasure-fixture.ts';

let f: AccountErasureFixture;
let single: Pool;
beforeAll(async () => {
  f = await accountErasureFixture();
  single = new Pool({ connectionString: f.db.url, max: 1 });
});
afterAll(async () => {
  await single?.end();
  await f?.close();
});
const platform = {
  actorAccountId: '00000000-0000-8000-8000-000000000001',
  clientId: 'internal-semantic-erasure',
  requestedBy: null,
};

async function context(creator: Awaited<ReturnType<AccountErasureFixture['author']>>) {
  const result = await f.call(creator, 'POST', '/v1/contexts', { labels: { en: 'Historical owners' } });
  expect(result.status, JSON.stringify(result.body)).toBe(201);
  const id = result.body.context.id as string;
  return { id, route: routeOf(id)! };
}
async function occurrences(tx: CommandTransaction, resource: { id: string; route: number }, accountId: string) {
  const page = await readContextRoleProvenance(tx, { resource, accountId });
  for (const row of page)
    await tx.query('SELECT 1 FROM access.resource_role_provenance WHERE route=$1 AND occurrence=$2 FOR UPDATE', [
      resource.route,
      row.occurrence,
    ]);
  return page;
}
async function enroll(resource: { id: string; route: number }, accountId: string) {
  return runCommand(single, { partition: partitionOf(resource.route), basis: platform }, async (tx) => {
    const rows = await occurrences(tx, resource, accountId);
    const results = [];
    for (const row of rows)
      results.push(await enrollContextRoleProvenance(tx, { route: resource.route, occurrence: row }));
    const position = (
      await tx.query<{ position: string }>(
        'SELECT (position+1)::text AS position FROM core.partition WHERE partition_no=$1',
        [partitionOf(resource.route)],
      )
    ).rows[0]!.position;
    return { value: { rows, results }, events: [{ type: SEMANTIC_LOCATOR_SCHEDULED, data: { position } }] };
  });
}
async function relay(result: Awaited<ReturnType<typeof enroll>>) {
  const effect = createSemanticLocatorEffect(single);
  // The existing effect advances one indexed native locator per call; replay its real envelope.
  for (let step = 0; step < 12; step++) {
    await effect.run({
      specversion: '1.0',
      id: randomUUID(),
      source: `urn:rezics:log:${result.partition}.${result.epoch}`,
      type: SEMANTIC_LOCATOR_SCHEDULED,
      time: new Date().toISOString(),
      datacontenttype: 'application/json',
      sequence: String(result.position),
      data: { position: String(result.position) },
    });
    const cursor = await f.db.admin.query(
      'SELECT complete FROM semantic.erasure_delivery WHERE partition_no=$1 AND source_position=$2',
      [result.partition, String(result.position)],
    );
    if (cursor.rows[0]?.complete) return;
  }
  throw new Error('Context locator page did not finish');
}

test('Native Access Context creator new and former owner occurrences enroll exact actual Context erasure locators in the same source transaction and dirty late generations without claiming final history closure', async () => {
  const creator = await f.author();
  const owner = await f.person();
  await f.db.admin.query(
    "SELECT setval('semantic.erasure_record_key',9007199254740993,false),setval(pg_get_serial_sequence('access.resource_role_provenance','occurrence'),9007199254740993,false)",
  );
  const resource = await context(creator);
  const original = await enroll(resource, creator.accountId);
  expect(original.value.rows.some((row) => row.side === 'creator')).toBe(true);
  expect(original.value.rows.every((row) => BigInt(row.occurrence) > 9007199254740991n)).toBe(true);
  const key = (
    await f.db.admin.query<{ key: string }>(
      'SELECT erasure_key::text AS key FROM semantic.context WHERE route=$1 AND context_id=$2',
      [resource.route, resource.id],
    )
  ).rows[0]!.key;
  expect(BigInt(key)).toBeGreaterThan(9007199254740991n);
  expect(original.value.results.every((result) => result.state === 'enrolled' && result.contextKey === key)).toBe(true);

  const grant = {
    resource,
    subject: { kind: 'account', id: owner.accountId },
    role: 'semantic.context.owner',
    valid: '(,)',
  };
  expect((await f.call(creator, 'POST', '/v1/roleGrants', grant)).status).toBe(201);
  expect((await f.call(creator, 'POST', '/v1/roleGrants:revoke', grant)).status).toBe(200);
  const delivered = await enroll(resource, owner.accountId);
  expect(delivered.value.rows.map((row) => row.side)).toEqual(['new', 'former']);
  const former = delivered.value.rows.find((row) => row.side === 'former')!;
  expect(former.sourceTransaction).not.toBe(former.grantTransaction);
  expect(delivered.value.results).toEqual([
    { state: 'enrolled', contextKey: key },
    { state: 'enrolled', contextKey: key },
  ]);
  expect(
    (
      await f.db.admin.query(
        'SELECT 1 FROM access.resource_role_grant WHERE route=$1 AND resource_id=$2 AND subject_id=$3',
        [resource.route, resource.id, owner.accountId],
      )
    ).rowCount,
  ).toBe(0);
  const locators = await f.db.admin.query(
    "SELECT account_id::text,role,record_key::text FROM semantic.erasure_locator WHERE partition_no=$1 AND store='context' AND record_key=$2",
    [delivered.partition, key],
  );
  expect(locators.rows).toEqual(
    expect.arrayContaining([
      { account_id: creator.accountId, role: 'author', record_key: key },
      { account_id: owner.accountId, role: 'owner', record_key: key },
    ]),
  );
  const before = (
    await f.db.admin.query(
      "SELECT * FROM semantic.erasure_locator WHERE partition_no=$1 AND store='context' AND record_key=$2 ORDER BY account_id,role",
      [delivered.partition, key],
    )
  ).rows;
  await enroll(resource, owner.accountId);
  expect(
    (
      await f.db.admin.query(
        "SELECT * FROM semantic.erasure_locator WHERE partition_no=$1 AND store='context' AND record_key=$2 ORDER BY account_id,role",
        [delivered.partition, key],
      )
    ).rows,
  ).toEqual(before);
  expect((await f.call(creator, 'GET', `/v1/contexts/${resource.id}`)).status).toBe(200);

  // The original native producer and Source insertion also share an uncommitted command.
  const another = await f.person();
  await runCommand(single, { partition: delivered.partition, basis: platform }, async (tx, { transactionId }) => {
    await tx.query(
      `INSERT INTO access.resource_role_grant(route,resource_id,subject_kind,subject_id,subject_role,grant_role,valid,transaction_id)
      VALUES($1,$2,'identity',$3,'','semantic.context.owner','(,)',$4)`,
      [resource.route, resource.id, another.accountId, transactionId],
    );
    const row = (await occurrences(tx, resource, another.accountId))[0]!;
    expect(row.sourceTransaction).toBe(transactionId);
    expect(await enrollContextRoleProvenance(tx, { route: resource.route, occurrence: row })).toEqual({
      state: 'enrolled',
      contextKey: key,
    });
    const native = await tx.query(
      `SELECT e.xmin=l.xmin AS same_transaction,e.enrollment_transaction::text,l.delivery_position::text
      FROM semantic.context_role_enrollment e JOIN semantic.erasure_locator l ON l.partition_no=e.route/16 AND l.record_key=e.context_key
      WHERE e.route=$1 AND e.occurrence=$2 AND l.store='context' AND l.account_id=$3 AND l.role='owner'`,
      [resource.route, row.occurrence, another.accountId],
    );
    expect(native.rows[0]?.same_transaction).toBe(true);
    expect(native.rows[0]?.enrollment_transaction).toBe(transactionId);
    return {
      value: null,
      events: [{ type: SEMANTIC_LOCATOR_SCHEDULED, data: { position: native.rows[0]!.delivery_position } }],
    };
  });
});

test('late native Context generations reopen local obligations and the existing account-home receiver without a final ACK', async () => {
  const creator = await f.author();
  const owner = await f.person();
  const resource = await context(creator);
  const grant = {
    resource,
    subject: { kind: 'account', id: owner.accountId },
    role: 'semantic.context.owner',
    valid: '(,)',
  };
  expect((await f.call(creator, 'POST', '/v1/roleGrants', grant)).status).toBe(201);
  await enroll(resource, owner.accountId);
  await f.tombstone(owner);
  await beginSemanticErasure(single, owner.accountId);
  const initial = await enroll(resource, owner.accountId);
  const initialPosition = (
    await f.db.admin.query(
      `SELECT delivery_position::text FROM semantic.erasure_locator
    WHERE partition_no=$1 AND account_id=$2 AND role='owner' AND store='context'`,
      [initial.partition, owner.accountId],
    )
  ).rows[0]!.delivery_position;
  await relay({ ...initial, position: BigInt(initialPosition) });
  expect(
    (
      await f.db.admin.query(
        `SELECT state FROM semantic.erasure_locator WHERE partition_no=$1 AND account_id=$2
    AND role='owner' AND store='context'`,
        [initial.partition, owner.accountId],
      )
    ).rows[0]!.state,
  ).toBe('minimized');
  expect((await f.call(creator, 'POST', '/v1/roleGrants:revoke', grant)).status).toBe(200);
  const late = await enroll(resource, owner.accountId);
  const next = (
    await f.db.admin.query(
      `SELECT state,delivery_position::text FROM semantic.erasure_locator
    WHERE partition_no=$1 AND account_id=$2 AND role='owner' AND store='context'`,
      [late.partition, owner.accountId],
    )
  ).rows[0]!;
  expect(next.state).toBe('pending');
  expect(BigInt(next.delivery_position)).toBeGreaterThan(BigInt(initialPosition));
  await relay({ ...late, position: BigInt(next.delivery_position) });
  const former = late.value.rows.find((row) => row.side === 'former')!;
  const locator = (
    await f.db.admin.query(
      `SELECT l.state,l.delivery_position::text,l.source_transaction_id::text
    FROM semantic.erasure_locator l JOIN semantic.context c ON c.erasure_key=l.record_key AND c.route=$1
    WHERE l.partition_no=$2 AND c.context_id=$3 AND l.account_id=$4 AND l.role='owner' AND l.store='context'`,
      [resource.route, late.partition, resource.id, owner.accountId],
    )
  ).rows[0]!;
  expect(locator.source_transaction_id).toBe(former.sourceTransaction);
  expect(locator.state).toBe('minimized');
  const nativeLate = await f.db.admin.query(
    "SELECT locator,resolved_at FROM access.erasure_late_item WHERE route=$1 AND account_id=$2 AND participant='semantic' AND locator=$3",
    [
      routeOf(owner.accountId),
      owner.accountId,
      `semantic:${late.partition}:context:${late.value.results[0]!.state === 'enrolled' ? late.value.results[0]!.contextKey : ''}:owner:${locator.delivery_position}`,
    ],
  );
  expect(nativeLate.rows).toHaveLength(1);
  expect(nativeLate.rows[0]!.resolved_at).not.toBeNull();
  const status = await f.status(owner.accountId);
  expect(status?.participants.semantic?.outcome).toBe('pending');
  expect(status?.completedAt).toBeNull();
  expect((await f.call(creator, 'GET', `/v1/contexts/${resource.id}`)).status).toBe(200);
  const duplicate = await enroll(resource, owner.accountId);
  expect(duplicate.value.results.every((result) => result.state === 'enrolled')).toBe(true);
  expect(
    (
      await f.db.admin.query(
        "SELECT state FROM semantic.erasure_locator WHERE partition_no=$1 AND account_id=$2 AND role='owner' AND store='context'",
        [late.partition, owner.accountId],
      )
    ).rows[0]!.state,
  ).toBe('minimized');
});

test('unresolved native Context keys stay pending and caller rollback removes both native occurrence and enrollment', async () => {
  const creator = await f.author();
  const holder = await f.person();
  const resource = await context(creator);
  let rolledBack: ContextRoleProvenance | undefined;
  await expect(
    runCommand(single, { partition: partitionOf(resource.route), basis: platform }, async (tx, { transactionId }) => {
      await tx.query(
        `INSERT INTO access.resource_role_grant(route,resource_id,subject_kind,subject_id,subject_role,grant_role,valid,transaction_id)
      VALUES($1,$2,'identity',$3,'','semantic.context.owner','(,)',$4)`,
        [resource.route, resource.id, holder.accountId, transactionId],
      );
      rolledBack = (await occurrences(tx, resource, holder.accountId))[0]!;
      expect((await enrollContextRoleProvenance(tx, { route: resource.route, occurrence: rolledBack })).state).toBe(
        'enrolled',
      );
      throw new Error('caller rollback');
    }),
  ).rejects.toThrow('caller rollback');
  expect(
    (
      await f.db.admin.query('SELECT 1 FROM semantic.context_role_enrollment WHERE route=$1 AND occurrence=$2', [
        resource.route,
        rolledBack!.occurrence,
      ])
    ).rowCount,
  ).toBe(0);
  expect(
    (
      await f.db.admin.query('SELECT 1 FROM access.resource_role_provenance WHERE route=$1 AND occurrence=$2', [
        resource.route,
        rolledBack!.occurrence,
      ])
    ).rowCount,
  ).toBe(0);
  // A genuine row can still be pending when invoked in a different physical home.
  const source = (await enroll(resource, creator.accountId)).value.rows[0]!;
  const otherRoute = (resource.route + 16) % 65536;
  await runCommand(single, { partition: partitionOf(otherRoute), basis: platform }, async (tx) => {
    expect(await enrollContextRoleProvenance(tx, { route: resource.route, occurrence: source })).toEqual({
      state: 'pending',
    });
    return { value: null, events: [{ type: SEMANTIC_LOCATOR_SCHEDULED, data: { position: '0' } }] };
  });
  await runCommand(single, { partition: partitionOf(resource.route), basis: platform }, async (tx) => {
    // Missing key is a Source lookup case; this altered input is deliberately not an Access receipt.
    expect(
      await enrollContextRoleProvenance(tx, {
        route: resource.route,
        occurrence: { ...source, resourceId: newId(resource.route) },
      }),
    ).toEqual({ state: 'pending' });
    return { value: null, events: [{ type: SEMANTIC_LOCATOR_SCHEDULED, data: { position: '0' } }] };
  });
});
