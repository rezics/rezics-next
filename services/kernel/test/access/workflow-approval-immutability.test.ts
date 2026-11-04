import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createPool } from '../../src/database/pool.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import consume from '../../src/access/workflow-approvals-credential-consume.sql';

const pool = createPool(process.env.DATABASE_URL!);
afterAll(() => pool.end());

test('credential consumption preserves generated attribution and refuses approval edits and reuse', async () => {
  const actor = newId(0x1357);
  const approval = newId(0x1357);
  const principal = randomUUID();
  const transaction = randomUUID();
  await pool.query(
    `INSERT INTO access.workflow_approval
      (route,approval_id,actor_id,client_id,scopes,requested_by,authn_epoch,operation_key,operation,digest,
       created_at,expires_at,jwt_expires_at,transaction_id)
     VALUES ($1,$2,$3,'web',ARRAY['account:manage'],$4,1,$8,$5,$6,
       clock_timestamp()-interval '1 second',clock_timestamp()+interval '30 seconds',
       clock_timestamp()+interval '60 seconds',$7)`,
    [
      routeOf(actor),
      approval,
      actor,
      `urn:rezics:request:${principal}:${randomUUID()}`,
      JSON.stringify({ kind: 'credential', subjectAccountId: actor }),
      'a'.repeat(64),
      transaction,
      randomUUID(),
    ],
  );
  const before = (await pool.query('SELECT * FROM access.workflow_approval WHERE approval_id=$1', [approval])).rows[0];
  expect(before.erasure_subject_id).toBe(actor);
  expect(before.erasure_principal_id).toBe(principal);
  await expect(
    pool.query(
      `UPDATE access.workflow_approval SET client_id='other',consumed_at=clock_timestamp(),
      consumed_transaction_id=$2 WHERE approval_id=$1`,
      [approval, transaction],
    ),
  ).rejects.toThrow('Workflow approvals are immutable');
  const input = {
    route: routeOf(actor)!,
    approval_id: approval,
    digest: 'a'.repeat(64),
    at: new Date().toISOString(),
    transaction_id: transaction,
  };
  expect(await consume.run(pool, input)).toHaveLength(1);
  const after = (await pool.query('SELECT * FROM access.workflow_approval WHERE approval_id=$1', [approval])).rows[0];
  expect(after.erasure_subject_id).toBe(actor);
  expect(after.erasure_principal_id).toBe(principal);
  expect(after.consumed_transaction_id).toBe(transaction);
  expect(await consume.run(pool, input)).toHaveLength(0);
  await expect(
    pool.query(
      'UPDATE access.workflow_approval SET consumed_at=NULL,consumed_transaction_id=NULL WHERE approval_id=$1',
      [approval],
    ),
  ).rejects.toThrow('Workflow approvals are immutable');
});
