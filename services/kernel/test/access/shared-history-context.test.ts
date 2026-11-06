import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  advancePendingContextRoleProvenance,
  deliverContextRoleProvenance,
  readContextRoleProvenance,
  type ContextRoleOccurrence,
} from '../../src/access/shared-history-context.ts';
import { noEffect, runCommand, type CommandEvent } from '../../src/command/command.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { createDeletionFixture } from '../semantic/support/deletion-fixture.ts';
import { HistoryRegistry } from '../../src/history/contract/registry.ts';
import { admitSharedHistory } from '../../src/access/shared-history.ts';
import {
  withSelectedHistoryOriginal,
  consumeSelectedHistoryOriginal,
  identityOriginalRemainder,
  HISTORY_ORIGINAL_LOCAL_ALLOWANCE,
  ADDITIONAL_ORIGINAL_TRANSFER_CONTROL,
  sumOriginalControl,
  originalWorkVector,
  type IdentityOriginalTransfer,
} from '../../src/access/identity-original-admission.ts';
import type { WorkClient } from '../../src/work/client.ts';

// Reuse real Context creation and grant mutation; no alternate receiving/source harness.
const f = await createDeletionFixture();
let client: Awaited<ReturnType<typeof createWorkClient>>;
const createdHomes = new Set<number>();
beforeAll(async () => {
  await f.setup();
  client = await createWorkClient(process.env.DATABASE_URL!, f.pool);
});
afterAll(async () => {
  await client?.close();
  await f.close();
});

async function create() {
  const key = `"${randomUUID()}"`;
  const body = { labels: { en: 'Native historical Context party' } };
  const answer = await f.call('POST', '/v1/contexts', 'owner', body, key);
  f.status(answer, 201);
  const resource = { route: routeOf(answer.body.context.id)!, id: answer.body.context.id as string };
  createdHomes.add(partitionOf(resource.route));
  return { key, body, resource };
}
const rows = (resource: { route: number; id: string }, accountId = f.accounts.owner) =>
  readContextRoleProvenance(f.admin, { resource, accountId });
const drive = (partition: number, after?: ContextRoleOccurrence) =>
  advancePendingContextRoleProvenance(
    { pool: f.pool, client, clock: f.clock },
    { partition, ...(after === undefined ? {} : { after }) },
  );
const deliver = (source: ContextRoleOccurrence) =>
  runCommand(f.pool, { partition: partitionOf(source.route) }, async (tx) =>
    noEffect(await deliverContextRoleProvenance(tx, source)),
  );

test('Actual selected native History original survives failed dispatch without a new identity or deadline and rejects foreign live handles', async () => {
  const account = newId(0x9d10);
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
  let ended: IdentityOriginalTransfer | undefined;
  const failure = new Error('affected dispatch failed');
  await expect(
    withSelectedHistoryOriginal(deps, async (selected, transfer) => {
      expect(selected).toBe(job);
      ended = transfer;
      for (const foreign of [
        { ...deps, pool: f.admin },
        { ...deps, client: { ...client } as WorkClient },
        { ...deps, registry: new HistoryRegistry() },
      ])
        expect(() => identityOriginalRemainder(foreign, transfer, selected)).toThrow('handle-unavailable');
      expect(() => identityOriginalRemainder(deps, { ...transfer }, selected)).toThrow('handle-unavailable');
      expect(() => identityOriginalRemainder(deps, transfer, randomUUID())).toThrow('handle-unavailable');
      const now = Date.now;
      const expires = identityOriginalRemainder(deps, transfer, selected).deadline;
      try {
        Date.now = () => expires;
        expect(() => identityOriginalRemainder(deps, transfer, selected)).toThrow('handle-unavailable');
      } finally {
        Date.now = now;
      }
      await consumeSelectedHistoryOriginal(deps, transfer, selected);
      await expect(consumeSelectedHistoryOriginal(deps, transfer, selected)).rejects.toThrow('consumed-or-changed');
      throw failure;
    }),
  ).rejects.toBe(failure);
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
  expect(before[0]!.advanced).toBe(false);
  expect(() => identityOriginalRemainder(deps, ended!, job)).toThrow('handle-unavailable');
  await f.admin.query("UPDATE core.preference_history_job SET next_run='-infinity' WHERE job_id=$1", [job]);
  await expect(
    withSelectedHistoryOriginal(deps, async () => {
      throw new Error('replay reached dispatch');
    }),
  ).rejects.toThrow('already-dispatched');
  expect(await snapshot()).toEqual(before);
  await f.admin.query("UPDATE core.preference_history_job SET next_run='infinity' WHERE job_id=$1", [job]);
});

test('Actual native Context OLD NEW creator occurrence delivery enrolls genuine Source historical party before delivered state and leaves missing receiver pending with bounded restart and no artifact authority invention', async () => {
  const { resource, key, body } = await create();
  const contextKey = (
    await f.admin.query<{ key: string }>(
      'SELECT erasure_key::text AS key FROM semantic.context WHERE route=$1 AND context_id=$2',
      [resource.route, resource.id],
    )
  ).rows[0]!.key;
  const created = await rows(resource);
  expect(created.map((row) => row.side).sort()).toEqual(['creator', 'new']);
  const creator = created.find((row) => row.side === 'creator')!;
  const original = created.find((row) => row.side === 'new')!;
  expect(creator).toMatchObject({
    resourceId: resource.id,
    resourceType: 'semantic.context',
    originalCreator: f.accounts.owner,
    accountId: f.accounts.owner,
    grantRole: '',
    valid: null,
    grantTransaction: null,
    sourceTransaction: original.sourceTransaction,
    contextKey,
    delivery: 'delivered',
  });
  expect(original).toMatchObject({ grantRole: 'semantic.context.owner', contextKey, delivery: 'delivered' });
  expect(original.grantTransaction).toBe(original.sourceTransaction);
  const replay = await f.call('POST', '/v1/contexts', 'owner', body, key);
  f.status(replay, 201);
  expect(replay.body.context.id).toBe(resource.id);
  expect(await rows(resource)).toEqual(created);

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
  const formerRows = await rows(resource);
  const former = formerRows.find((row) => row.side === 'former')!;
  expect(former).toMatchObject({
    resourceId: original.resourceId,
    originalCreator: original.originalCreator,
    accountId: original.accountId,
    grantRole: original.grantRole,
    valid: original.valid,
    grantTransaction: original.grantTransaction,
    contextKey,
    delivery: 'delivered',
  });
  expect(former.sourceTransaction).not.toBe(original.sourceTransaction);
  expect(former.occurrence).not.toBe(original.occurrence);
  const editorRows = await rows(resource, f.accounts.editor);
  expect(editorRows.some((row) => row.side === 'new')).toBe(true);
  expect(editorRows.every((row) => row.delivery === 'delivered' && row.contextKey === contextKey)).toBe(true);
  const enrollment = () =>
    f.admin.query(
      `SELECT occurrence::text,context_key::text AS "contextKey",side,
       grant_transaction::text AS "grantTransaction",source_transaction::text AS "sourceTransaction"
     FROM semantic.context_role_enrollment WHERE route=$1 AND context_key=$2 ORDER BY occurrence`,
      [resource.route, contextKey],
    );
  const enrolled = (await enrollment()).rows;
  expect(enrolled).toEqual(
    [...formerRows, ...editorRows]
      .sort((a, b) => (BigInt(a.occurrence) < BigInt(b.occurrence) ? -1 : 1))
      .map(({ occurrence, contextKey, side, grantTransaction, sourceTransaction }) => ({
        occurrence,
        contextKey,
        side,
        grantTransaction,
        sourceTransaction,
      })),
  );
  const locators = () =>
    f.admin.query(
      `SELECT account_id::text,role,record_key::text,source_transaction_id::text
     FROM semantic.erasure_locator WHERE partition_no=$1 AND store='context' AND record_key=$2
     ORDER BY account_id,role`,
      [partitionOf(resource.route), contextKey],
    );
  const historicalParties = (await locators()).rows;
  expect(historicalParties).toHaveLength(3);
  expect(historicalParties).toEqual(
    expect.arrayContaining([
      {
        account_id: f.accounts.owner,
        role: 'author',
        record_key: contextKey,
        source_transaction_id: former.sourceTransaction,
      },
      {
        account_id: f.accounts.owner,
        role: 'owner',
        record_key: contextKey,
        source_transaction_id: former.sourceTransaction,
      },
      {
        account_id: f.accounts.editor,
        role: 'owner',
        record_key: contextKey,
        source_transaction_id: editorRows[0]!.sourceTransaction,
      },
    ]),
  );
  // Historical metadata cannot authorize a fresh creator command after transfer.
  f.status(await f.call('DELETE', `/v1/contexts/${resource.id}`, 'owner'), 403);

  for (const row of formerRows) {
    const source = { route: resource.route, occurrence: row.occurrence };
    for (let attempt = 0; attempt < 2; attempt++)
      expect((await deliver(source)).value).toEqual({
        state: 'delivered',
      });
  }
  expect(await rows(resource)).toEqual(formerRows);
  await drive(partitionOf(resource.route));
  await drive(partitionOf(resource.route)); // fresh cursor models process restart
  expect(await rows(resource)).toEqual(formerRows);
  expect(await rows(resource, f.accounts.editor)).toEqual(editorRows);
  expect((await enrollment()).rows).toEqual(enrolled);
  expect((await locators()).rows).toEqual(historicalParties);
  expect(Object.keys(former).sort()).toEqual(
    [
      'occurrence',
      'resourceId',
      'resourceType',
      'originalCreator',
      'accountId',
      'grantRole',
      'valid',
      'side',
      'grantTransaction',
      'sourceTransaction',
      'contextKey',
      'delivery',
    ].sort(),
  );
}, 30000);

// Actual initialization and grant rows drive the original capture triggers; no Context
// Source row exists, so this remains unresolved with the real receiver installed.
async function unresolvedContextRoles(route: number, count: number) {
  const resource = { route, id: newId(route) };
  let sourceTransaction = '';
  await f.admin.query(
    `INSERT INTO access.resource_initialization(route,resource_id,resource_type,creator_id,initialized_at)
     VALUES($1,$2,'semantic.context',$3,now())`,
    [route, resource.id, f.accounts.owner],
  );
  await runCommand(
    f.pool,
    {
      partition: partitionOf(route),
      basis: { actorAccountId: '00000000-0000-8000-8000-000000000001', clientId: 'internal-access', requestedBy: null },
    },
    async (tx, command) => {
      const events: CommandEvent[] = [];
      sourceTransaction = command.transactionId;
      await tx.query("SELECT set_config('access.role_native_transaction',$1,true)", [sourceTransaction]);
      for (let n = 0; n < count; n++) {
        await tx.query(
          `INSERT INTO access.resource_role_grant(route,resource_id,subject_id,grant_role,valid,transaction_id)
         VALUES($1,$2,$3,$4,'(,)',$5)`,
          [route, resource.id, f.accounts.owner, `unconverted.role${n}`, command.transactionId],
        );
        events.push({
          type: 'com.rezics.access.role-grant.create.v1',
          data: {
            resource,
            subject: { kind: 'account', id: f.accounts.owner },
            role: `unconverted.role${n}`,
            valid: '(,)',
          },
        });
      }
      return { value: null, events };
    },
  );
  const before = (
    await f.admin.query<{ route: number; occurrence: string }>(
      `SELECT route,occurrence::text FROM access.resource_role_provenance
     WHERE route=$1 AND resource_id=$2 ORDER BY occurrence`,
      [route, resource.id],
    )
  ).rows;
  return { resource, sourceTransaction, before };
}

test('native pending partial index redrive examines eight exact inputs, wraps after restart and preserves skipped locks', async () => {
  // Context creation routes by its random idempotency key. Keep the exact batch-size fixture
  // in a different home from every Context created above, even on a routing collision.
  let route = 0x6d20;
  while (createdHomes.has(partitionOf(route))) route += 16;
  const { resource, sourceTransaction, before } = await unresolvedContextRoles(route, 10);
  expect(before).toHaveLength(10);
  const holder = await f.admin.connect();
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT 1 FROM access.resource_role_provenance WHERE route=$1 AND occurrence=$2 FOR UPDATE', [
      route,
      before[0]!.occurrence,
    ]);
    const first = await drive(partitionOf(route));
    expect(first).toEqual({ attempted: 8, pending: 8, after: before[8]! });
    expect(await drive(partitionOf(route), first.after!)).toEqual({ attempted: 1, pending: 1, after: null });
    await holder.query('COMMIT');
  } finally {
    await holder.query('ROLLBACK');
    holder.release();
  }
  const restarted = await drive(partitionOf(route));
  expect(restarted).toEqual({ attempted: 8, pending: 8, after: before[7]! });
  expect(await drive(partitionOf(route), restarted.after!)).toEqual({ attempted: 2, pending: 2, after: null });
  const firstPage = await rows(resource);
  const lastPage = await readContextRoleProvenance(f.admin, {
    resource,
    accountId: f.accounts.owner,
    after: firstPage.at(-1)!.occurrence,
  });
  expect(firstPage).toHaveLength(8);
  expect(lastPage).toHaveLength(2);
  for (const row of [...firstPage, ...lastPage]) {
    expect(row.sourceTransaction).toBe(sourceTransaction);
    expect(row.grantTransaction).toBe(sourceTransaction);
    expect(row.delivery).toBe('pending');
    expect(row.contextKey).toBeNull();
  }
}, 30000);

test('source identity is immutable, unavailable delivery cannot be forged, and native source failures preserve occurrences', async () => {
  const { resource } = await unresolvedContextRoles(0x6d40, 1);
  const before = await rows(resource);
  expect(before).toHaveLength(1);
  expect(before[0]!.delivery).toBe('pending');
  expect(before[0]!.contextKey).toBeNull();
  const source = { route: resource.route, occurrence: before[0]!.occurrence };
  expect((await deliver(source)).value).toEqual({
    state: 'pending',
    reason: 'semantic-context-historical-party-enrollment-pending',
    source,
  });
  for (const assignment of ['source_transaction=gen_random_uuid()', "delivery='delivered'", 'context_key=123'])
    await expect(
      f.admin.query(`UPDATE access.resource_role_provenance SET ${assignment} WHERE route=$1 AND occurrence=$2`, [
        source.route,
        source.occurrence,
      ]),
    ).rejects.toThrow();
  await expect(
    runCommand(f.pool, { partition: partitionOf(source.route) }, async (tx) => {
      await deliverContextRoleProvenance(tx, source);
      throw new Error('native transaction failed');
    }),
  ).rejects.toThrow('native transaction failed');
  expect(await rows(resource)).toEqual(before);
  await expect(deliverContextRoleProvenance(f.admin, source)).rejects.toThrow('live same-home');
  for (const occurrence of ['00', '01', '-1', '1e2', '9223372036854775808'])
    await expect(
      readContextRoleProvenance(f.admin, { resource, accountId: f.accounts.owner, after: occurrence }),
    ).rejects.toThrow('Invalid role occurrence');
}, 30000);

test('Complete owned default product journey without invented authority', async () => {
  const { advanceSelectedHistoryOriginal } = await import('../../src/history/adapters/work.ts');
  const account = newId(0x9d30);
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
    scan_partition=4096,next_run='-infinity' WHERE job_id=$1`,
    [job, registry.digest(), generation],
  );
  const deps = { pool: f.pool, client, registry, env: {}, clock: f.clock };
  const started = Date.now();
  expect(await advanceSelectedHistoryOriginal(deps)).toEqual({ state: 'more', gap: null });
  const first = (
    await f.admin.query(
      `SELECT original_id,dispatched,advanced,deadline::text
    FROM core.identity_history_original WHERE job_id=$1 ORDER BY ordinal`,
      [job],
    )
  ).rows[0]!;
  expect(first.dispatched).toBe(true);
  expect(first.advanced).toBe(true);
  expect(Number(first.deadline)).toBeGreaterThanOrEqual(started + 5000);
  const progressed = (
    await f.admin.query('SELECT phase,verify_partition FROM core.preference_history_job WHERE job_id=$1', [job])
  ).rows[0];
  expect(progressed).toEqual({ phase: 'verify', verify_partition: 0 });
  // A later actual position is independently admissible. Missing child producers still
  // cannot reinterpret the spent local allocation as a private Source/Library grant.
  await f.admin.query("UPDATE core.preference_history_job SET next_run='-infinity' WHERE job_id=$1", [job]);
  await withSelectedHistoryOriginal(deps, async (selected, transfer) => {
    expect(selected).toBe(job);
    await consumeSelectedHistoryOriginal(deps, transfer, selected);
    const parent = identityOriginalRemainder(deps, transfer, selected);
    expect(parent.originalId).not.toBe(first.original_id);
    expect(parent.position.phase).toBe('verify');
    expect(parent.source).toBeNull();
    expect(parent.library).toBeNull();
    const { withIdentityOriginalSourceTransfer } = await import('../../src/access/identity-original-admission.ts');
    let child = false;
    await expect(
      withIdentityOriginalSourceTransfer(deps, transfer, selected, async () => {
        child = true;
      }),
    ).rejects.toThrow('source-transfer-unavailable');
    expect(child).toBe(false);
  });
  await f.admin.query("UPDATE core.preference_history_job SET next_run='infinity' WHERE job_id=$1", [job]);
});
