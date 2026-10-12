import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import {
  engageAccessRecoveryFence,
  releaseAccessRecoveryFence,
} from '../../../services/main/src/modules/access/admission.ts';
import { grantFixtureAuthority } from '../../../services/main/src/modules/access/fixture-authority.ts';
import { GovernanceStore } from '../../../services/main/src/modules/governance/store.ts';
import { cloneQaOwnerDatabases } from '../support/databases.ts';
import { fixtureReasons } from './g-565-decision-support.ts';

const globalContext = 'urn:rezics:context:global';
const native = () => `https://rezics.com/id/${randomUUID()}`;
const digest = 'a'.repeat(64);
const principalId = randomUUID(),
  actor = native(),
  scope = `governance:platform:${randomUUID()}`;
let databases: Awaited<ReturnType<typeof cloneQaOwnerDatabases>>;
let access: Pool;

beforeAll(async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Use the QA integration tier');
  databases = await cloneQaOwnerDatabases(Bun.env.REZICS_QA_RUN_ID, ['access'], 'owner');
  access = new Pool({ connectionString: databases.urls.access, max: 8 });
  await access.query(
    'INSERT INTO access.principal(id,account_issuer,account_subject) VALUES ($1,$2,$3)',
    [principalId, 'https://governance-disclosure-cut.test', randomUUID()],
  );
  await access.query("INSERT INTO access.authority_subject(id,kind) VALUES ($1,'agent')", [actor]);
  await transaction(async (client) => {
    await grantFixtureAuthority(client, {
      scope,
      requireDispatch: true,
      representations: [{ principalId, actor, action: 'governance.moderate', lifetime: '8 hours' }],
      grant: { actor, action: 'governance.moderate', lifetime: '8 hours' },
    });
  });
  expect(
    (
      await access.query(`SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'access.governance_enforcement'::regclass
      AND tgname = 'governance_disclosure_change' AND NOT tgisinternal`)
    ).rowCount,
  ).toBe(1);
}, 30_000);

afterAll(async () => {
  await access?.end();
  await databases?.close();
});

async function transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await access.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

type Staged = { id: string; caseId: string; resources: string[] };

/** Stage immutable decisions through the ordinary case/target guards. Owner
 * acknowledgement remains pending so enforcement has its own later commit. */
async function stage(
  resources: string[],
  outcome: 'restrict' | 'restore' = 'restrict',
  existingCase?: string,
): Promise<Staged> {
  return transaction(async (client) => {
    const id = randomUUID(),
      caseId = existingCase ?? randomUUID();
    if (!existingCase)
      await client.query(
        `INSERT INTO access.governance_case
      (id,kind,authority_kind,authority_scope_id,context,target_owner,target_resource,target_component,disclosure)
      VALUES ($1,'content_report','platform',$2,$3,'graph',$4,'record','private')`,
        [caseId, scope, globalContext, resources[0]],
      );
    const {
      rows: [head],
    } = await client.query<{ sequence: string }>(
      'SELECT (generation + 1)::text AS sequence FROM access.governance_case WHERE id = $1 FOR UPDATE',
      [caseId],
    );
    await client.query(
      `INSERT INTO access.moderation_decision
      (id,kind,outcome,context,case_id,case_sequence,principal_id,acting_subject,authority_kind,
       authority_scope_id,authority_epoch,authority_proof_digest,idempotency_key,request_digest,
       rule_ref,rule_revision,rule_digest,evidence_digest,rationale,disclosure,statement_of_reasons)
      VALUES ($1::uuid,'content_moderation',$2,$3,$4,$5,$6,$7,'platform',$8,0,$9,$1::text,$9,
       'urn:governance-disclosure-cut:rule','1',$9,$9,'Reviewed fixture evidence','private',$10::jsonb)`,
      [id, outcome, globalContext, caseId, head!.sequence, principalId, actor, scope, digest, fixtureReasons],
    );
    await client.query('INSERT INTO access.safety_decision_operation(decision_id) VALUES ($1)', [
      id,
    ]);
    for (const [index, resource] of resources.entries()) {
      await client.query(
        `INSERT INTO access.moderation_decision_target
        (decision_id,ordinal,owner,resource,component,scope_kind,revision,effect)
        VALUES ($1,$2,'graph',$3,'record','component',NULL,'disclosure')`,
        [id, index + 1, resource],
      );
      await client.query(
        `INSERT INTO access.safety_decision_effect(decision_id,ordinal,plan)
        VALUES ($1,$2,$3::jsonb)`,
        [id, index + 1, JSON.stringify({ owner: 'graph', resource, component: 'record' })],
      );
    }
    await client.query(
      'UPDATE access.governance_case SET decision_head = $2,generation = $3 WHERE id = $1',
      [caseId, id, head!.sequence],
    );
    return { id, caseId, resources };
  });
}

async function confirm(
  client: PoolClient,
  decision: Staged,
  ordinal = 1,
  fence?: string,
): Promise<string> {
  const id = fence ?? randomUUID();
  if (fence)
    await client.query(
      `UPDATE access.governance_enforcement
    SET decision_id = $2,decision_ordinal = $3,state = 'released',fence_epoch = fence_epoch + 1
    WHERE id = $1`,
      [id, decision.id, ordinal],
    );
  else
    await client.query(
      `INSERT INTO access.governance_enforcement
    (id,authority_scope_id,context,owner,resource,component,revision,effect,decision_id,decision_ordinal,state,fence_epoch)
    VALUES ($1,$2,$3,'graph',$4,'record',NULL,'disclosure',$5,$6,'restricted',1)`,
      [id, scope, globalContext, decision.resources[ordinal - 1], decision.id, ordinal],
    );
  await client.query(
    `UPDATE access.safety_decision_effect
    SET state = 'confirmed',receipt = $3,continuation = NULL,error = NULL
    WHERE decision_id = $1 AND ordinal = $2`,
    [decision.id, ordinal, `access:governance-enforcement:${decision.id}:${ordinal}`],
  );
  return id;
}

const basis = async () =>
  (await access.query<{ basis: string }>('SELECT access.site_moderation_basis() AS basis')).rows[0]!
    .basis;
const signalCount = async () =>
  (
    await access.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM access.site_moderation_change',
    )
  ).rows[0]!.count;

test('confirmation and restoration advance the disclosure cut after their already recorded decisions', async () => {
  const preceding = await basis(), precedingCount = await signalCount();
  const decision = await stage([native()]);
  const pending = await basis();
  const count = await signalCount();
  expect(pending).not.toBe(preceding);
  expect(count).toBe(precedingCount + 1);
  const fence = await transaction((client) => confirm(client, decision));
  expect(await basis()).not.toBe(pending);
  expect(await signalCount()).toBe(count + 1);
  const principal = (await access.query<{ issuer: string; subject: string }>(
    'SELECT account_issuer AS issuer,account_subject AS subject FROM access.principal WHERE id = $1', [principalId],
  )).rows[0]!;
  const store = new GovernanceStore(access,
    { capture: async () => { throw new Error('Replay must retain its accepted evidence'); } },
    { current: async () => null }, { current: async () => null });
  const acknowledged = await basis(), acknowledgedCount = await signalCount();
  const firstReplay = await store.resumeDecision(principal, actor, decision.id);
  expect(firstReplay.operation.status).toBe('completed');
  const completedReplay = await store.resumeDecision(principal, actor, decision.id);
  expect(completedReplay.operation.status).toBe('completed');
  expect(await basis()).toBe(acknowledged);
  expect(await signalCount()).toBe(acknowledgedCount);
  expect((await access.query('SELECT state,fence_epoch::text FROM access.governance_enforcement WHERE id = $1', [fence])).rows)
    .toEqual([{ state: 'restricted', fence_epoch: '1' }]);
  const restore = await stage(decision.resources, 'restore', decision.caseId);
  const pendingRestore = await basis();
  await transaction((client) => confirm(client, restore, 1, fence));
  expect(await basis()).not.toBe(pendingRestore);
  expect(
    (
      await access.query(
        'SELECT state,fence_epoch::text FROM access.governance_enforcement WHERE id = $1',
        [fence],
      )
    ).rows,
  ).toEqual([{ state: 'released', fence_epoch: '2' }]);
});

test('independent enforcement writers detect a late lower-xid commit while the oldest snapshot stays pinned', async () => {
  const first = await stage([native()]),
    second = await stage([native()]);
  const oldest = await access.connect(),
    held = await access.connect(),
    later = await access.connect();
  try {
    for (const client of [oldest, held, later]) {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '1500ms'");
      await client.query("SET LOCAL statement_timeout = '2000ms'");
      await client.query('SELECT pg_current_xact_id()');
    }
    const before = await basis();
    await confirm(held, first);
    expect(await basis()).toBe(before);
    await confirm(later, second);
    await later.query('COMMIT');
    const afterLater = await basis();
    expect(afterLater).not.toBe(before);
    await access.query('SELECT pg_current_xact_id()');
    expect(await basis()).toBe(afterLater);
    await held.query('COMMIT');
    expect(await basis()).not.toBe(afterLater);
    await oldest.query('ROLLBACK');
    const stable = await basis();
    await access.query('SELECT pg_current_xact_id()');
    expect(await basis()).toBe(stable);
  } finally {
    for (const client of [oldest, held, later]) {
      await client.query('ROLLBACK');
      client.release();
    }
  }
});

test('partial effect recovery and batch confirmation reuse one ordered signal per transaction and recovery generation', async () => {
  const decision = await stage([native(), native(), native()]);
  const count = await signalCount();
  await transaction((client) => confirm(client, decision));
  expect(await signalCount()).toBe(count + 1);
  const partial = await basis();
  await access.query(
    `UPDATE access.safety_decision_effect SET state = 'uncertain',error = 'owner-response-lost'
    WHERE decision_id = $1 AND ordinal = 2`,
    [decision.id],
  );
  expect(await basis()).toBe(partial);
  const generation = await engageAccessRecoveryFence(access);
  try {
    const held = await basis();
    expect(held).not.toBe(partial);
    const xid = await transaction(async (client) => {
      const row = (await client.query<{ xid: string }>('SELECT pg_current_xact_id()::text AS xid'))
        .rows[0]!;
      await confirm(client, decision, 2);
      await confirm(client, decision, 3);
      // Even a caller already using the same recorder does not add a signal.
      await client.query('SELECT access.record_site_moderation_change()');
      return row.xid;
    });
    expect(await basis()).not.toBe(held);
    expect(await signalCount()).toBe(count + 2);
    expect(
      (
        await access.query(
          'SELECT epoch::text FROM access.site_moderation_change WHERE xid = $1::xid8',
          [xid],
        )
      ).rows,
    ).toEqual([{ epoch: generation }]);
  } finally {
    await releaseAccessRecoveryFence(access, generation);
  }
  expect(
    (
      await access.query('SELECT state FROM access.safety_decision_effect WHERE decision_id = $1', [
        decision.id,
      ])
    ).rows,
  ).toEqual([{ state: 'confirmed' }, { state: 'confirmed' }, { state: 'confirmed' }]);
});

test('rolled-back confirmations and refused stale, no-op and delete writes leave the cut unchanged', async () => {
  const decision = await stage([native()]);
  const pending = await basis(),
    count = await signalCount();
  await expect(
    transaction(async (client) => {
      await confirm(client, decision);
      throw new Error('confirmation aborted');
    }),
  ).rejects.toThrow('confirmation aborted');
  expect(await basis()).toBe(pending);
  expect(await signalCount()).toBe(count);
  const fence = await transaction((client) => confirm(client, decision));
  const restore = await stage(decision.resources, 'restore', decision.caseId);
  const effective = await basis(),
    effectiveCount = await signalCount();
  await expect(
    transaction((client) =>
      client.query(
        `UPDATE access.governance_enforcement
    SET decision_id = $2,state = 'released',fence_epoch = 1 WHERE id = $1`,
        [fence, restore.id],
      ),
    ),
  ).rejects.toMatchObject({ code: '23514' });
  expect(await basis()).toBe(effective);
  expect(await signalCount()).toBe(effectiveCount);
  for (const sql of [
    'UPDATE access.governance_enforcement SET state = state WHERE id = $1',
    'UPDATE access.governance_enforcement SET fence_epoch = fence_epoch + 1 WHERE id = $1',
    'DELETE FROM access.governance_enforcement WHERE id = $1',
  ]) {
    await expect(transaction((client) => client.query(sql, [fence]))).rejects.toMatchObject({
      code: '23514',
    });
    expect(await basis()).toBe(effective);
    expect(await signalCount()).toBe(effectiveCount);
  }
});
