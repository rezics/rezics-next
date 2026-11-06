import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import {
  advancePendingContextRoleProvenance,
  deliverContextRoleProvenance,
  readContextRoleProvenance,
} from '../../src/access/shared-history-context.ts';
import { noEffect, runCommand } from '../../src/command/command.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { createDeletionFixture } from '../semantic/support/deletion-fixture.ts';
import { HistoryRegistry } from '../../src/history/contract/registry.ts';
import { admitSharedHistory } from '../../src/access/shared-history.ts';
import {
  withSelectedHistoryOriginal,
  consumeSelectedHistoryOriginal,
  HISTORY_ORIGINAL_LOCAL_ALLOWANCE,
  ADDITIONAL_ORIGINAL_TRANSFER_CONTROL,
  sumOriginalControl,
  originalWorkVector,
} from '../../src/access/identity-original-admission.ts';

const f = await createDeletionFixture();
const single = new pg.Pool({ connectionString: process.env.DATABASE_URL!, max: 1 });
let client: Awaited<ReturnType<typeof createWorkClient>>;
const basis = {
  actorAccountId: '00000000-0000-8000-8000-000000000001',
  clientId: 'internal-access',
  requestedBy: null,
};
beforeAll(async () => {
  await f.setup();
  client = await createWorkClient(process.env.DATABASE_URL!, f.pool);
});
afterAll(async () => {
  await client?.close();
  await single.end();
  await f.close();
});
async function create() {
  const response = await f.call(
    'POST',
    '/v1/contexts',
    'owner',
    {
      labels: { en: 'Native receiving integration' },
    },
    `"${randomUUID()}"`,
  );
  f.status(response, 201);
  return { route: routeOf(response.body.context.id)!, id: response.body.context.id as string };
}

test('Changed selected native cursor refuses before affected dispatch and failed validation cannot refill admission', async () => {
  const account = newId(0x9d20);
  const home = partitionOf(routeOf(account)!);
  const job = randomUUID();
  const registry = new HistoryRegistry();
  await f.admin.query("INSERT INTO core.partition(partition_no,node) VALUES($1,'local') ON CONFLICT DO NOTHING", [
    home,
  ]);
  await f.admin.query('INSERT INTO access.erasure(route,account_id,version,at) VALUES($1,$2,1,now())', [
    routeOf(account),
    account,
  ]);
  const generation = (
    await f.admin.query(
      `INSERT INTO core.history_registry(singleton,digest,gaps) VALUES(true,$1,'[]')
    ON CONFLICT(singleton) DO UPDATE SET digest=EXCLUDED.digest,generation=core.history_registry.generation+1
    RETURNING generation::text`,
      [registry.digest()],
    )
  ).rows[0]!.generation;
  await runCommand(f.pool, { partition: home }, async (tx) => noEffect(await admitSharedHistory(tx, account, job)));
  await f.admin.query(
    `UPDATE core.preference_history_job SET registry_digest=$2,registry_generation=$3,
    next_run='-infinity' WHERE job_id=$1`,
    [job, registry.digest(), generation],
  );
  const deps = { pool: f.pool, client, registry };
  let affected = false;
  await expect(
    withSelectedHistoryOriginal(deps, async (selected, transfer) => {
      expect(selected).toBe(job);
      await f.admin.query('UPDATE core.preference_history_job SET scan_partition=1 WHERE job_id=$1', [job]);
      await expect(consumeSelectedHistoryOriginal(deps, transfer, selected)).rejects.toThrow(
        'selected-position-changed',
      );
      // The same live token is one-shot even when the native validation transaction rolled back.
      await consumeSelectedHistoryOriginal(deps, transfer, selected);
      affected = true;
    }),
  ).rejects.toThrow('consumed-or-changed');
  expect(affected).toBe(false);
  const snapshot = async () =>
    (
      await f.admin.query(
        `SELECT original_id,deadline::text,spent,dispatched,advanced
    FROM core.identity_history_original WHERE job_id=$1 ORDER BY ordinal`,
        [job],
      )
    ).rows;
  const before = await snapshot();
  expect(before).toHaveLength(1);
  expect(before[0]!.spent.map(Number)).toEqual(
    originalWorkVector(sumOriginalControl(HISTORY_ORIGINAL_LOCAL_ALLOWANCE, ADDITIONAL_ORIGINAL_TRANSFER_CONTROL)),
  );
  expect(before[0]!.dispatched).toBe(true);
  await f.admin.query("UPDATE core.preference_history_job SET next_run='-infinity' WHERE job_id=$1", [job]);
  await expect(
    withSelectedHistoryOriginal(deps, async () => {
      affected = true;
    }),
  ).rejects.toThrow('unfinished-position-changed');
  expect(await snapshot()).toEqual(before);
  expect(affected).toBe(false);
  await f.admin.query("UPDATE core.preference_history_job SET next_run='infinity' WHERE job_id=$1", [job]);
});

test('deferred native creator NEW and OLD delivery shares actual Source enrollment and preserves former grant provenance', async () => {
  const resource = await create();
  const created = await readContextRoleProvenance(f.admin, { resource, accountId: f.accounts.owner });
  expect(created.map((row) => row.side).sort()).toEqual(['creator', 'new']);
  const original = created.find((row) => row.side === 'new')!;
  const role = {
    resource,
    subject: { kind: 'account', id: f.accounts.owner },
    role: 'semantic.context.owner',
    valid: original.valid,
  };
  f.status(
    await f.call('POST', '/v1/roleGrants', 'owner', {
      ...role,
      subject: { kind: 'account', id: f.accounts.editor },
    }),
    201,
  );
  f.status(await f.call('POST', '/v1/roleGrants:revoke', 'owner', role), 200);
  const historical = await readContextRoleProvenance(f.admin, { resource, accountId: f.accounts.owner });
  const former = historical.find((row) => row.side === 'former')!;
  expect(former.grantTransaction).toBe(original.grantTransaction);
  expect(former.sourceTransaction).not.toBe(original.sourceTransaction);
  expect(former.occurrence).not.toBe(original.occurrence);
  for (const row of historical) {
    expect(row.delivery).toBe('delivered');
    expect(row.contextKey).toMatch(/^[1-9][0-9]*$/);
    const proof = (
      await f.admin.query(
        `SELECT p.xmin=e.xmin AS same_transaction,e.context_key::text,e.side,
         e.source_transaction::text,e.grant_transaction::text,c.erasure_key::text
       FROM access.resource_role_provenance p
       JOIN semantic.context_role_enrollment e USING(route,occurrence)
       JOIN semantic.context c ON c.route=p.route AND c.context_id=p.resource_id
       WHERE p.route=$1 AND p.occurrence=$2`,
        [resource.route, row.occurrence],
      )
    ).rows[0]!;
    expect(proof).toEqual({
      same_transaction: true,
      context_key: row.contextKey,
      erasure_key: row.contextKey,
      side: row.side,
      source_transaction: row.sourceTransaction,
      grant_transaction: row.grantTransaction,
    });
    const duplicate = await runCommand(single, { partition: partitionOf(resource.route), basis }, async (tx) =>
      noEffect(await deliverContextRoleProvenance(tx, { route: resource.route, occurrence: row.occurrence })),
    );
    expect(duplicate.value).toEqual({ state: 'delivered' });
  }
  const locators = (
    await f.admin.query(
      `SELECT account_id::text,role FROM semantic.erasure_locator
     WHERE partition_no=$1 AND store='context' AND record_key=$2 ORDER BY account_id,role`,
      [partitionOf(resource.route), former.contextKey],
    )
  ).rows;
  expect(locators).toEqual(
    expect.arrayContaining([
      { account_id: f.accounts.owner, role: 'author' },
      { account_id: f.accounts.owner, role: 'owner' },
      { account_id: f.accounts.editor, role: 'owner' },
    ]),
  );
  // The retained creator/former metadata grants no current action.
  f.status(await f.call('DELETE', `/v1/contexts/${resource.id}`, 'owner'), 403);
});

test('released bounded redrive enrolls pending native input under its real platform command with a one-connection pool', async () => {
  const resource = await create();
  const partition = partitionOf(resource.route);
  let sourceTransaction = '';
  await runCommand(single, { partition, basis }, async (tx, command) => {
    sourceTransaction = command.transactionId;
    await tx.query(
      `INSERT INTO access.resource_role_grant(route,resource_id,subject_kind,subject_id,subject_role,grant_role,valid,transaction_id)
       VALUES($1,$2,'identity',$3,'','semantic.context.owner','(,)',$4)`,
      [resource.route, resource.id, f.accounts.editor, sourceTransaction],
    );
    // An early native trigger has no forthcoming Source commit or editorial fence yet.
    // It must preserve pending, even though the actual Context key already exists.
    await tx.query('SET CONSTRAINTS access.resource_role_provenance_deliver IMMEDIATE');
    const input = await readContextRoleProvenance(tx, { resource, accountId: f.accounts.editor });
    expect(input).toHaveLength(1);
    expect(input[0]!.delivery).toBe('pending');
    expect(input[0]!.contextKey).toBeNull();
    return { value: null, events: [{ type: 'com.rezics.access.context-role-delivery-advanced.v1', data: {} }] };
  });
  const pending = (await readContextRoleProvenance(f.admin, { resource, accountId: f.accounts.editor }))[0]!;
  const after = { route: resource.route, occurrence: (BigInt(pending.occurrence) - 1n).toString() };
  const drive = () =>
    advancePendingContextRoleProvenance({ pool: single, client, clock: f.clock }, { partition, after });
  const progress = await drive();
  expect(progress.attempted).toBeGreaterThanOrEqual(1);
  expect(progress.attempted).toBeLessThanOrEqual(8);
  const delivered = (await readContextRoleProvenance(f.admin, { resource, accountId: f.accounts.editor }))[0]!;
  expect(delivered).toMatchObject({ ...pending, delivery: 'delivered', contextKey: expect.any(String) });
  const proof = (
    await f.admin.query(
      `SELECT e.enrollment_transaction::text,e.source_transaction::text,p.xmin=e.xmin AS same_transaction,
       b.xmin=e.xmin AS same_command
     FROM access.resource_role_provenance p JOIN semantic.context_role_enrollment e USING(route,occurrence)
     JOIN editorial.write_basis b ON b.partition_no=e.route/16 AND b.transaction_id=e.enrollment_transaction
     WHERE p.route=$1 AND p.occurrence=$2`,
      [resource.route, pending.occurrence],
    )
  ).rows[0]!;
  expect(proof.source_transaction).toBe(sourceTransaction);
  expect(proof.enrollment_transaction).not.toBe(sourceTransaction);
  expect(proof.same_transaction).toBe(true);
  expect(proof.same_command).toBe(true);
  await drive(); // restarting selection cannot duplicate the Source receipt or lose input
  expect(await readContextRoleProvenance(f.admin, { resource, accountId: f.accounts.editor })).toEqual([delivered]);
});
