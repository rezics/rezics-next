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
