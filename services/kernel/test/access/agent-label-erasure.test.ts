import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledRelease } from '@rezics/definitions/bundled';
import { createReceiptTestPool } from '../support/receipt-test-pool.ts';
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
import { ensureAccountAgent } from '../../src/semantic/account-agents.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { readItemDetails, readLabels } from '../../src/semantic/public-subject-facts.ts';
import { admittedAccess, authenticateAccount } from '../support/admitted-access.ts';
import { runAccountIdentityReversal } from '../support/account-identity-publication.ts';
import { startAccountIdentityPublication } from '../support/identity-work-process.ts';
import { publishVerifiedAgentFixture } from '../support/verified-agent-fixture.ts';
import type { AgentVerificationReversal } from '../../src/access/agent-verification.ts';
import { Value } from 'typebox/value';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createReceiptTestPool(databaseUrl);
const route = 0x5348;
const routeKey = Buffer.alloc(32, 38);
const access = admittedAccess({ actions: LIFECYCLE_ACTIONS });
const recovery = new Map<object, RecoveryEvidence>();
const lifecycle = createLifecycleInternals({
  pool,
  routeKey,
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
  expect(Value.Check(EVENT_TYPES()[type]!, row.data)).toBe(true);
  return {
    ...activation(accountId),
    id: row.id,
    source: `urn:rezics:log:${row.partition_no}.${row.epoch}`,
    sequence: String(row.position).padStart(19, '0'),
    type,
    data: row.data,
  };
}

async function labels(subjectId: string) {
  const result = (await readLabels(pool, [subjectId])).get(subjectId);
  if (!result) throw new Error(`Missing visible subject ${subjectId}`);
  return result;
}

async function revision(accountId: string): Promise<number> {
  const { rows } = await pool.query<{ revision: number }>(
    `SELECT revision FROM semantic.revision WHERE route = $1 AND subject_id = $2
     ORDER BY revision DESC LIMIT 1`,
    [route, accountAgentId(accountId)],
  );
  return rows[0]!.revision;
}

async function expectErased(accountId: string, names: string[]) {
  expect(await labels(accountAgentId(accountId))).toEqual({});
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

async function tombstone(accountId: string, authnEpoch = 1) {
  await pool.query(
    `INSERT INTO access.resource_grant(route, resource_id, subject_id, action, valid, transaction_id)
     VALUES ($1, $2, $2, 'account:delete', '(,)', $2)`,
    [route, accountId],
  );
  const actor = await authenticateAccount(
    access,
    { pool, deadline: Date.now() + 30_000 },
    { accountId, clientId: 'agent-erasure', scopes: ['account:delete'], authnEpoch },
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

async function clearFence(accountId: string, fence: Awaited<ReturnType<typeof lifecycle.raiseFence>>['value']) {
  const evidence = {};
  const authnEpoch = Number(fence.minimumAuthnEpoch);
  recovery.set(evidence, { ...fence, authnEpoch, establishmentId: randomUUID() });
  await lifecycle.clearFence({ accountId, key: randomUUID(), evidence });
  return authnEpoch;
}

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
  await clearFence(account.id, fenced.value);
  const restored = await lastEvent(account.id, 'com.rezics.access.authentication-established.v1');
  await applyAccountAgentEffect(pool, restored);
  expect(await labels(accountAgentId(account.id))).toEqual({ und: currentName });
  await applyAccountAgentEffect(pool, fenceEvent);
  expect(await labels(accountAgentId(account.id))).toEqual({ und: currentName });
  await pool.query('UPDATE access.account SET display_name = NULL WHERE route = $1 AND account_id = $2', [
    route,
    account.id,
  ]);
  await applyAccountAgentEffect(pool, restored);
  expect(await labels(accountAgentId(account.id))).toEqual({ und: account.handle });
});

test('a repeated or replayed event converges', async () => {
  const account = await seed();
  const stale = activation(account.id);
  const deleted = await tombstone(account.id);
  await applyAccountAgentEffect(pool, stale);
  const priorRevision = await revision(account.id);
  for (const delivery of [deleted, stale, deleted]) await applyAccountAgentEffect(pool, delivery);
  expect(await revision(account.id)).toBe(priorRevision);
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
    expect((await readItemDetails(pool, [accountAgentId(account.id)])).get(accountAgentId(account.id))?.type).toBe(
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

test("deleting a verified account reverses the verification and erases the restored node's label while preserving catalogue labels", async () => {
  const { id: accountId, name } = await seed();
  const catalogueId = newId(route + 32);
  const catalogueLabels = { en: 'Independent catalogue name', ja: 'Catalogue alias' };
  const publication = await startAccountIdentityPublication({
    databaseUrl,
    routeKey: routeKey.toString('base64url'),
    searchPrefix: `agent-erasure-${randomUUID().slice(0, 8)}-`,
    openSearchUrl: process.env.OPENSEARCH_URL,
  });
  try {
    await publishVerifiedAgentFixture(pool, publication.workClient, accountId, catalogueId, catalogueLabels);
    expect(await labels(catalogueId)).toEqual(catalogueLabels);

    const fenced = await lifecycle.raiseFence({ accountId: accountId, key: randomUUID() });
    await applyAccountAgentEffect(pool, await lastEvent(accountId, 'com.rezics.access.authentication-fenced.v1'));
    expect(await labels(catalogueId)).toEqual(catalogueLabels);

    const authnEpoch = await clearFence(accountId, fenced.value);
    const deleted = await tombstone(accountId, authnEpoch);
    await applyAccountAgentEffect(pool, deleted);
    const reversing = await lastEvent(accountId, 'com.rezics.access.agent-verification.reversing.v1');
    expect(
      (
        await pool.query("SELECT body FROM semantic.fact WHERE route = $1 AND subject_id = $2 AND kind = 'label'", [
          route,
          accountAgentId(accountId),
        ])
      ).rows,
    ).toEqual([{ body: name }]);
    await expect(applyAccountAgentEffect(pool, deleted)).rejects.toThrow('Account agent work is still pending');

    await runAccountIdentityReversal(pool, publication.workClient, reversing.data as AgentVerificationReversal);
    await expectErased(accountId, [name]);
    const reversed = await lastEvent(accountId, 'com.rezics.access.agent-verification.reversed.v1');
    await applyAccountAgentEffect(pool, reversed);
    await applyAccountAgentEffect(pool, activation(accountId));
    await expectErased(accountId, [name]);
    expect(await labels(catalogueId)).toEqual(catalogueLabels);
    expect(
      (
        await pool.query('SELECT * FROM access.agent_page WHERE route = $1 AND subject_id = $2', [
          route + 32,
          catalogueId,
        ])
      ).rows,
    ).toEqual([]);
  } finally {
    await publication.stop();
  }
}, 240_000);
