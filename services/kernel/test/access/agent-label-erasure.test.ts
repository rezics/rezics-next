import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { createPool } from '../../src/database/pool.ts';
import { newId, partitionOf } from '../../src/route/route.ts';
import type { CloudEvent } from '../../src/events/log.ts';
import { EVENT_TYPES } from '../../src/events/log.ts';
import { ACCOUNT_AGENT_EVENT_TYPES, applyAccountAgentEffect } from '../../src/access/account-agent-effect.ts';
import {
  createLifecycleCommands,
  createLifecycleInternals,
  LIFECYCLE_ACTIONS,
  type RecoveryEvidence,
} from '../../src/access/lifecycle.ts';
import { accountAgentId } from '../../src/semantic/agents.ts';
import { ensureAccountAgent, verifyAccountAgent } from '../../src/semantic/account-agents.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { createSubject, readSubject } from '../../src/semantic/subject.ts';
import { admittedAccess, authenticateAccount } from '../support/admitted-access.ts';
import { Value } from 'typebox/value';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const route = 0x5348;
const access = admittedAccess({ actions: LIFECYCLE_ACTIONS });
const recovery = new Map<object, RecoveryEvidence>();
const lifecycle = createLifecycleInternals({
  pool,
  routeKey: new Uint8Array(32).fill(38),
  provisioningEvidence: async () => null,
  recoveryEvidence: async (evidence) => recovery.get(evidence as object) ?? null,
});
beforeAll(() => bootstrapRelease(pool, bundledRelease));
afterAll(() => pool.end());

async function seed(kind: 'person' | 'organization' | 'software' = 'person') {
  const id = newId(route);
  const handle = `erasure_${randomUUID().replaceAll('-', '')}`;
  const name = `Private name ${randomUUID()}`;
  await pool.query(
    `INSERT INTO access.account
       (route, account_id, kind, handle, display_name, state, operator_account_id, transaction_id)
     VALUES ($1, $2, $3, $4, $5, 'active', $6, $2)`,
    [
      route,
      id,
      kind === 'organization' ? 'organization' : 'actor',
      handle,
      name,
      kind === 'software' ? newId(route) : null,
    ],
  );
  await applyAccountAgentEffect(pool, activation(id));
  return { id, handle, name, kind };
}

function activation(accountId: string): CloudEvent {
  return {
    specversion: '1.0',
    id: newId(route),
    source: `urn:rezics:log:${partitionOf(route)}.1`,
    type: 'com.rezics.access.actor-activated.v1',
    subject: accountId,
    time: '2026-10-28T00:00:00.000Z',
    datacontenttype: 'application/json',
    sequence: '0000000000000000001',
    data: { accountId },
  };
}

async function lastEvent(accountId: string, type: string): Promise<CloudEvent> {
  const { rows } = await pool.query(
    `SELECT * FROM core.outbox WHERE partition_no = $1 AND subject = $2 AND type = $3
     ORDER BY position DESC, event_seq DESC LIMIT 1`,
    [partitionOf(route), accountId, type],
  );
  const row = rows[0];
  if (!row) throw new Error(`Missing event ${type}`);
  expect(Value.Check(EVENT_TYPES[type]!, row.data)).toBe(true);
  return {
    ...activation(accountId),
    id: row.id,
    source: `urn:rezics:log:${row.partition_no}.${row.epoch}`,
    sequence: String(row.position).padStart(19, '0'),
    type,
    data: row.data,
  };
}

async function subject(accountId: string) {
  const result = await readSubject(
    pool,
    accountAgentId(accountId),
    async () => true,
    undefined,
    new Uint8Array(32).fill(38),
  );
  if (!result) throw new Error('Missing account agent');
  return result.subject;
}

async function expectErased(accountId: string, names: string[]) {
  expect((await subject(accountId)).labels).toEqual({});
  const { rows: tables } = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname = 'semantic'");
  for (const { tablename } of tables) {
    const { rows } = await pool.query(
      `SELECT count(*)::integer AS count FROM semantic."${tablename}" AS row
       WHERE EXISTS (SELECT FROM unnest($1::text[]) name WHERE strpos(to_jsonb(row)::text, name) > 0)`,
      [names],
    );
    expect(rows, tablename).toEqual([{ count: 0 }]);
  }
  for (const table of ['outbox', 'receipt']) {
    const { rows } = await pool.query(
      `SELECT count(*)::integer AS count FROM core.${table} AS row
       WHERE EXISTS (SELECT FROM unnest($1::text[]) name WHERE strpos(to_jsonb(row)::text, name) > 0)`,
      [names],
    );
    expect(rows, table).toEqual([{ count: 0 }]);
  }
}

async function tombstone(accountId: string) {
  await pool.query(
    `INSERT INTO access.resource_grant(route, resource_id, subject_id, action, valid, transaction_id)
     VALUES ($1, $2, $2, 'account:delete', '(,)', $2)`,
    [route, accountId],
  );
  const actor = await authenticateAccount(
    access,
    { pool, deadline: Date.now() + 30_000 },
    { accountId, clientId: 'agent-erasure', scopes: ['account:delete'] },
  );
  await createLifecycleCommands({ pool, access }).tombstone(
    { actor, deadline: Date.now() + 30_000 },
    { accountId, key: randomUUID() },
  );
  return lastEvent(accountId, 'com.rezics.access.account-tombstoned.v1');
}

test("deleting an account erases its agent node's label with nothing left in history revisions or events", async () => {
  const account = await seed();
  const oldName = `Earlier name ${randomUUID()}`;
  await ensureAccountAgent(pool, { account: account.id, kind: 'person', name: oldName, language: 'ja' });
  await ensureAccountAgent(pool, { account: account.id, kind: 'person', name: account.name, language: 'en' });
  const deleted = await tombstone(account.id);
  expect(deleted.data).not.toHaveProperty('displayName');
  await applyAccountAgentEffect(pool, deleted);
  await expectErased(account.id, [oldName, account.name]);
});

test('fencing an account erases the label and clearing the fence restores the current display name', async () => {
  const account = await seed();
  const fenced = await lifecycle.raiseFence({ accountId: account.id, key: randomUUID() });
  const fenceEvent = await lastEvent(account.id, 'com.rezics.access.authentication-fenced.v1');
  await applyAccountAgentEffect(pool, fenceEvent);
  await expectErased(account.id, [account.name]);
  const currentName = `Current name ${randomUUID()}`;
  await pool.query('UPDATE access.account SET display_name = $3 WHERE route = $1 AND account_id = $2', [
    route,
    account.id,
    currentName,
  ]);
  const evidence = {};
  recovery.set(evidence, {
    ...fenced.value,
    authnEpoch: Number(fenced.value.minimumAuthnEpoch),
    establishmentId: randomUUID(),
  });
  await lifecycle.clearFence({ accountId: account.id, key: randomUUID(), evidence });
  const restored = await lastEvent(account.id, 'com.rezics.access.authentication-established.v1');
  await applyAccountAgentEffect(pool, restored);
  expect((await subject(account.id)).labels).toEqual({ und: currentName });
  await applyAccountAgentEffect(pool, fenceEvent);
  expect((await subject(account.id)).labels).toEqual({ und: currentName });
  await pool.query('UPDATE access.account SET display_name = NULL WHERE route = $1 AND account_id = $2', [
    route,
    account.id,
  ]);
  await applyAccountAgentEffect(pool, restored);
  expect((await subject(account.id)).labels).toEqual({ und: account.handle });
});

test('a repeated or replayed event converges', async () => {
  const account = await seed();
  const stale = activation(account.id);
  const deleted = await tombstone(account.id);
  await applyAccountAgentEffect(pool, stale);
  const revision = (await subject(account.id)).revision;
  for (const delivery of [deleted, stale, deleted]) await applyAccountAgentEffect(pool, delivery);
  expect((await subject(account.id)).revision).toBe(revision);
  await expectErased(account.id, [account.name]);
});

test('erasure preserves organization and software kinds after tombstoning clears the operator', async () => {
  for (const kind of ['organization', 'software'] as const) {
    const account = await seed(kind);
    await pool.query(
      `UPDATE access.account SET state = 'deleted', authn_fenced = true, display_name = NULL,
         handle = NULL, operator_account_id = NULL WHERE route = $1 AND account_id = $2`,
      [route, account.id],
    );
    await applyAccountAgentEffect(pool, activation(account.id));
    await expectErased(account.id, [account.name]);
    expect((await subject(account.id)).type).toBe(
      kind === 'organization' ? 'schema:Organization' : 'schema:SoftwareApplication',
    );
  }
});

test('all native fence and restoration events are bound to account agent synchronization', () => {
  for (const type of [
    'authentication-fenced',
    'authentication-floor-advanced',
    'authentication-established',
    'account.suspended',
    'account.reinstated',
    'operator.subject-fenced',
    'operator.subject-unfenced',
    'agent-verification.reversed',
  ])
    expect(ACCOUNT_AGENT_EVENT_TYPES).toContain(`com.rezics.access.${type}.v1`);
});

test("deleting a verified account reverses the verification first and then erases the restored node's label; the catalogue agent keeps its own labels", async () => {
  const account = await seed();
  const catalogueId = newId(route + 32);
  const key = randomUUID();
  const target = { route: route + 32, id: catalogueId };
  await createSubject(pool, {
    actor: {
      kind: 'account',
      accountId: account.id,
      clientId: 'fixture',
      requestedBy: null,
      scopes: ['subject:create'],
      authnEpoch: 1,
    },
    target,
    idempotencyKey: key,
    digest: createHash('sha256').update(key).digest(),
    item: { type: 'schema:Person', labels: { en: 'Independent catalogue name', ja: 'Catalogue alias' } },
    release: { digest: bundledDigest, release: bundledRelease },
    authorization: {
      action: 'subject:create',
      resource: target,
      denied: () => new Error('Fixture denied'),
      async authorize() {
        return 'execute';
      },
    },
  });
  const receipt = newId(route);
  await verifyAccountAgent(pool, { account: account.id, catalogue: catalogueId, receipt });
  await pool.query(
    `UPDATE access.account SET agent_verified = true, agent_subject_id = $3,
       agent_verification_receipt_id = $4 WHERE route = $1 AND account_id = $2`,
    [route, account.id, catalogueId, receipt],
  );
  await pool.query(
    `INSERT INTO access.agent_page(route, subject_id, account_id, verification_receipt_id) VALUES ($1, $2, $3, $4)`,
    [route + 32, catalogueId, account.id, receipt],
  );
  const catalogueBefore = (await readSubject(
    pool,
    catalogueId,
    async () => true,
    undefined,
    new Uint8Array(32).fill(38),
  ))!.subject;
  // A fence must never erase independently maintained catalogue labels through a merged node.
  await lifecycle.raiseFence({ accountId: account.id, key: randomUUID() });
  await applyAccountAgentEffect(pool, await lastEvent(account.id, 'com.rezics.access.authentication-fenced.v1'));
  expect(
    (await readSubject(pool, catalogueId, async () => true, undefined, new Uint8Array(32).fill(38)))!.subject,
  ).toEqual(catalogueBefore);
  // Finish deletion from a current terminal row, independently of the caller's revoked session.
  await pool.query(
    `UPDATE access.account SET state = 'deleted', handle = NULL, display_name = NULL
     WHERE route = $1 AND account_id = $2`,
    [route, account.id],
  );
  await applyAccountAgentEffect(pool, activation(account.id));
  const reversing = await lastEvent(account.id, 'com.rezics.access.agent-verification.reversing.v1');
  expect(
    (
      await pool.query("SELECT body FROM semantic.fact WHERE route = $1 AND subject_id = $2 AND kind = 'label'", [
        route,
        accountAgentId(account.id),
      ])
    ).rows,
  ).toEqual([{ body: account.name }]);
  await expect(applyAccountAgentEffect(pool, activation(account.id))).rejects.toThrow(
    'Account agent work is still pending',
  );

  // Run the real durable reversal, including its final synchronization step, in its own SDK process.
  const program = `
    import { createPool } from './src/database/pool.ts';
    import { createWorkClient } from './src/work/client.ts';
    import { composeWork } from './src/work/registry.ts';
    import { registerAgentVerificationWork } from './src/access/agent-verification-work.ts';
    const pool = createPool(process.env.DATABASE_URL);
    const client = await createWorkClient(process.env.DATABASE_URL, pool);
    const decision = JSON.parse(process.env.REVERSAL);
    const work = await composeWork([{ name: 'accounts', register: registerAgentVerificationWork }], {
      pool, client, databaseUrl: process.env.DATABASE_URL, executorId: 'agent-erasure-test',
    });
    try {
      await work.launch();
      const handle = await client.enqueue({ workflowName: 'accounts.agent-verification-reversal',
        queueName: 'workflows', workflowID: 'accounts.agent-verification-reversal:'+decision.accountId+':'+decision.receiptId,
        workflowIDReusePolicy: 'return-existing' }, decision);
      await handle.getResult();
    } finally { await work.shutdown(); await client.close(); await pool.end(); }
  `;
  const worker = Bun.spawn([process.execPath, '-e', program], {
    cwd: new URL('../..', import.meta.url).pathname,
    env: { ...process.env, REVERSAL: JSON.stringify(reversing.data) },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const deadline = setTimeout(() => worker.kill('SIGKILL'), 60_000);
  const [, errors, status] = await Promise.all([
    new Response(worker.stdout).text(),
    new Response(worker.stderr).text(),
    worker.exited,
  ]);
  clearTimeout(deadline);
  expect(status, errors).toBe(0);
  await expectErased(account.id, [account.name]);
  const reversed = await lastEvent(account.id, 'com.rezics.access.agent-verification.reversed.v1');
  await applyAccountAgentEffect(pool, reversed);
  await applyAccountAgentEffect(pool, activation(account.id));
  await expectErased(account.id, [account.name]);
  expect(
    (await readSubject(pool, catalogueId, async () => true, undefined, new Uint8Array(32).fill(38)))!.subject.labels,
  ).toEqual(catalogueBefore.labels);
  expect(
    (
      await pool.query('SELECT * FROM access.agent_page WHERE route = $1 AND subject_id = $2', [
        route + 32,
        catalogueId,
      ])
    ).rows,
  ).toEqual([]);
}, 90_000);
