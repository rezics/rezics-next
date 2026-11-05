import { resetGrowthTables } from './growth-reset.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { AccountOperation } from '@rezics/auth';
import { createAccess } from '../../src/access/index.ts';
import { createLifecycleCommands, LIFECYCLE_ACTIONS } from '../../src/access/lifecycle.ts';
import {
  createWorkflowApprovals,
  workflowApprovalBinding,
  sweepWorkflowApprovals,
} from '../../src/access/workflow-approvals.ts';
import { newId, partitionOf } from '../../src/route/route.ts';
import { checkGrowth, capture, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

let db: GrowthDatabase;
const signing = await generateKeyPair('ES256', { extractable: true });
const jwk = { ...(await exportJWK(signing.publicKey)), kid: 'growth-approval', alg: 'ES256' };
const issuer = 'https://approval-growth.test';
const audience = 'https://api.approval-growth.test';
const referenceKeys = { current: 1, keys: new Map([[1, Buffer.alloc(32, 42)]]) };
const auth = { issuer, audience, jwksUrl: `${issuer}/jwks`, fetch: async () => Response.json({ keys: [jwk] }) };
const actions = LIFECYCLE_ACTIONS;
const route = 0x4567;
const targetRoute = 0x9876;
const context = () => ({ pool: db.pool, deadline: Date.now() + 5000 });
beforeAll(async () => {
  db = await openGrowthDatabase();
  db.pool.options.max = 1;
});
afterAll(async () => db?.close());

async function fixture() {
  const actor = newId(route);
  const target = newId(targetRoute);
  await db.admin.query(
    `INSERT INTO access.account(route,account_id,kind,state,transaction_id,membership_inverse_complete)
    VALUES ($1,$2,'actor','active',$2,true),($3,$4,'actor','active',$4,true)`,
    [route, actor, targetRoute, target],
  );
  await db.admin.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
    VALUES ($1,$2,$3,'account:update','(,)',$3)`,
    [targetRoute, target, actor],
  );
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({
    sub: actor,
    client_id: 'web',
    scope: 'account:update',
    authn_epoch: 1,
    iat: now,
    exp: now + 300,
    auth_time: now,
    amr: ['pwd'],
  })
    .setIssuer(issuer)
    .setAudience(audience)
    .setProtectedHeader({ alg: 'ES256', kid: jwk.kid, typ: 'at+jwt' })
    .sign(signing.privateKey);
  const native = createAccess({ actions, auth });
  const approvals = createWorkflowApprovals({ pool: db.pool, access: native, actions, referenceKeys });
  const operation: AccountOperation = {
    kind: 'rename',
    accountId: target,
    handle: 'next',
    expectedHandle: null,
    authorization: 'input',
  };
  const input = { operationKey: 'logical-operation', operation };
  const approval = await approvals.approve(token, input, context());
  return { actor, target, token, native, approvals, operation, input, approval };
}

async function postDeletionFixture() {
  const f = await fixture();
  const operator = newId(targetRoute);
  await db.admin.query(
    `INSERT INTO access.account(route,account_id,kind,state,transaction_id,membership_inverse_complete)
    VALUES ($1,$2,'actor','active',$2,true)`,
    [targetRoute, operator],
  );
  await db.admin.query('UPDATE access.account SET operator_account_id=$3 WHERE route=$1 AND account_id=$2', [
    targetRoute,
    f.target,
    operator,
  ]);
  await db.admin.query('DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2', [targetRoute, f.target]);
  await db.admin.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
    VALUES ($1,$2,$3,'account:manage','(,)',$3)`,
    [targetRoute, operator, f.actor],
  );
  const deletion: AccountOperation = { kind: 'delete', accountId: f.target, authorization: 'input' };
  const now = Math.floor(Date.now() / 1000);
  const bearer = await new SignJWT({
    sub: f.actor,
    client_id: 'web',
    scope: 'account:delete account:manage',
    authn_epoch: 1,
    iat: now,
    exp: now + 300,
    auth_time: now,
    amr: ['pwd'],
  })
    .setIssuer(issuer)
    .setAudience(audience)
    .setProtectedHeader({ alg: 'ES256', kid: jwk.kid, typ: 'at+jwt' })
    .sign(signing.privateKey);
  const approved = await f.approvals.approve(
    bearer,
    { operationKey: 'post-deletion-growth', operation: deletion },
    context(),
  );
  const request = await f.approvals.resolve(approved.reference, deletion, context());
  const binding = workflowApprovalBinding(request)!;
  const commands = createLifecycleCommands({ pool: db.pool, access: f.native });
  await commands.tombstone(request, {
    accountId: f.target,
    key: `${binding.commandKeyPrefix}:tombstone`,
  });
  return { ...f, operator, deletion, approved };
}

for (const population of ['same-actor history', 'unrelated accounts and resources'] as const) {
  for (const mode of ['approve', 'resolve', 'denied replay', 'expiry sweep'] as const) {
    test(`${mode} stays bounded as ${population} grows with K fixed`, async () => {
      await resetGrowthTables(db.admin, [
        'access.workflow_approval',
        'access.resource_grant',
        'access.resource_denial',
        'access.account',
        'core.receipt',
      ]);
      const f = await fixture();
      const commands = createLifecycleCommands({ pool: db.pool, access: f.native });
      const request = await f.approvals.resolve(f.approval.reference, f.operation, context());
      const key = `${workflowApprovalBinding(request)!.commandKeyPrefix}:profile`;
      const command = { accountId: f.target, key, patch: { displayName: 'once' } };
      await commands.updateAccount(request, command);
      if (mode === 'denied replay')
        await db.admin.query('DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2', [
          targetRoute,
          f.target,
        ]);
      async function operation() {
        if (mode === 'expiry sweep') {
          expect(await sweepWorkflowApprovals(db.pool, route, 8)).toBe(8);
          return;
        }
        if (mode === 'approve') return f.approvals.approve(f.token, f.input, context());
        if (mode === 'resolve') return f.approvals.resolve(f.approval.reference, f.operation, context());
        await expect(f.approvals.resolve(f.approval.reference, f.operation, context())).rejects.toThrow();
        // The native executor must independently reject even a previously resolved
        // context before consulting its existing receipt. No simulated command.
        await expect(commands.updateAccount({ ...request, deadline: Date.now() + 5000 }, command)).rejects.toThrow();
      }
      const report = await checkGrowth(db, {
        name: `${mode}: ${population}`,
        bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
        repetitions: 3,
        warmups: 1,
        async grow(database, scale, previous) {
          const from = previous * 256;
          const to = scale * 256;
          const ids = Array.from({ length: to - from }, () => newId(route));
          // Privileged population setup grows the exact native approval and receipt
          // indexes. Measured paths always traverse actual approve/resolve/commands.
          if (population === 'unrelated accounts and resources') {
            await database.admin.query(
              `INSERT INTO access.account(route,account_id,kind,state,transaction_id,membership_inverse_complete)
              SELECT $1,id,'actor','active',id,true FROM unnest($2::uuid[]) id`,
              [route, ids],
            );
            await database.admin.query(
              `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
              SELECT $1,id,id,'account:update','(,)',id FROM unnest($2::uuid[]) id`,
              [route, ids],
            );
          }
          await database.admin.query(
            `INSERT INTO access.workflow_approval
            (route,approval_id,actor_id,client_id,scopes,authn_epoch,operation_key,operation,digest,created_at,expires_at,jwt_expires_at,transaction_id)
            SELECT $1,id,CASE WHEN $4 THEN $3::uuid ELSE id END,'web',ARRAY['account:update'],1,id::text,'{}',repeat('0',64),
              '2000-01-01'::timestamptz,'2000-01-01 00:05:00'::timestamptz,'2000-01-01 00:05:00'::timestamptz,id
            FROM unnest($2::uuid[]) id`,
            [route, ids, f.actor, population === 'same-actor history'],
          );
          await database.admin.query(
            `INSERT INTO core.receipt
            (partition_no,principal_kind,principal_id,command_kind,idempotency_key,request_digest,epoch,position,transaction_id,response)
            SELECT $1,'account',CASE WHEN $4 THEN $3::uuid ELSE id END,'access.workflow-approval.create',$5||':'||id::text,
              decode(repeat('0',64),'hex'),1,1,id,'{}' FROM unnest($2::uuid[]) id`,
            [partitionOf(route), ids, f.actor, population === 'same-actor history', route],
          );
          for (const table of ['access.workflow_approval', 'core.receipt', 'access.account', 'access.resource_grant'])
            await database.admin.query(`VACUUM (ANALYZE) ${table}`);
        },
        operation,
      });
      expect(report.samples.map((sample) => sample.scale)).toEqual([1, 8, 64]);
      if (mode === 'resolve' || mode === 'denied replay') {
        for (const sample of report.samples) expect(sample.cost.relations?.['access.workflow_approval']?.rows).toBe(1);
      }
      if (mode === 'denied replay') {
        const denied = await capture(db, operation);
        // One exact approval provenance receipt is read; the denied business
        // command must never read its stored response.
        expect(denied.capture.statements.filter((sql) => /FROM core\.receipt/.test(sql))).toHaveLength(1);
      }
    }, 60_000);
  }
}

test('post-deletion delete approval resolution stays bounded as accounts and receipts grow', async () => {
  await resetGrowthTables(db.admin, [
    'access.workflow_approval',
    'access.lifecycle_fence_receipt',
    'access.resource_grant',
    'access.resource_denial',
    'access.account',
    'core.receipt',
  ]);
  const f = await postDeletionFixture();
  const report = await checkGrowth(db, {
    name: 'post-deletion delete approval resolution',
    scales: [256, 1024, 4096],
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    repetitions: 3,
    async grow(database, scale, previous) {
      const ids = Array.from({ length: scale - previous }, () => newId(targetRoute));
      await database.admin.query(
        `INSERT INTO access.account(route,account_id,kind,state,transaction_id,membership_inverse_complete)
        SELECT $1,id,'actor','active',id,true FROM unnest($2::uuid[]) id`,
        [targetRoute, ids],
      );
      await database.admin.query(
        `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
        SELECT $1,id,$2,'account:manage','(,)',id FROM unnest($3::uuid[]) id`,
        [targetRoute, f.actor, ids],
      );
      const repeatedAccounts = ids.flatMap((id) => [id, id, id, id]);
      const receiptIds = Array.from({ length: repeatedAccounts.length }, () => newId(targetRoute));
      const transactionIds = Array.from({ length: repeatedAccounts.length }, () => newId(targetRoute));
      await database.admin.query(
        `INSERT INTO access.lifecycle_fence_receipt
        (route,account_id,receipt_id,minimum_authn_epoch,kind,prior_operator_account_id,transaction_id)
        SELECT $1,account_id,receipt_id,1,'fence',NULL,transaction_id
        FROM unnest($2::uuid[],$3::uuid[],$4::uuid[]) rows(account_id,receipt_id,transaction_id)`,
        [targetRoute, repeatedAccounts, receiptIds, transactionIds],
      );
      await database.admin.query(
        `INSERT INTO core.receipt
        (partition_no,principal_kind,principal_id,command_kind,idempotency_key,request_digest,epoch,position,transaction_id,response)
        SELECT $1,'account',id,'growth.unrelated','seed:'||id::text,decode(repeat('0',64),'hex'),1,1,id,'{}'
        FROM unnest($2::uuid[]) id`,
        [partitionOf(targetRoute), ids],
      );
    },
    async operation() {
      return f.approvals.resolve(f.approved.reference, f.deletion, context());
    },
  });
  expect(report.samples.map((sample) => sample.scale)).toEqual([256, 1024, 4096]);
  for (const sample of report.samples) {
    expect(sample.cost.relations?.['access.lifecycle_fence_receipt']?.sequentialScans).toBe(0);
    expect(sample.cost.relations?.['core.receipt']?.sequentialScans).toBe(0);
    expect(sample.cost.relations?.['access.lifecycle_fence_receipt']?.rows).toBeLessThanOrEqual(6);
  }
});
