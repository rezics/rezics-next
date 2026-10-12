import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { engageAccessRecoveryFence, releaseAccessRecoveryFence } from '../../../services/main/src/modules/access/admission.ts';
import { grantFixtureAuthority } from '../../../services/main/src/modules/access/fixture-authority.ts';
import { ownerEvidenceCapture, ownerTargetHeads } from '../../../services/main/src/modules/governance/evidence.ts';
import { GovernanceStore, type DecisionInput } from '../../../services/main/src/modules/governance/store.ts';
import { cloneQaOwnerDatabases } from '../support/databases.ts';
import { fixtureReasons } from './g-565-decision-support.ts';

const globalContext = 'urn:rezics:context:global';
const native = () => `https://rezics.com/id/${randomUUID()}`;
const digest = 'a'.repeat(64);
const principalId = randomUUID(), actor = native(), scope = 'governance:platform';
const principal = { issuer: 'https://governance-disclosure-cut.test', subject: randomUUID() };
const observations = new Map<string, string>();
let databases: Awaited<ReturnType<typeof cloneQaOwnerDatabases>>;
let access: Pool;
let store: GovernanceStore;

function governance(pool: Pool) {
  return new GovernanceStore(pool, ownerEvidenceCapture({
    source: async (_principal, record, observation) => observations.get(observation) === record
      ? { record, retention: 'retained', byteDigest: digest, mediaType: 'application/json' } : null,
  }), ownerTargetHeads({}), { current: async () => ({ revision: '1', digest }) });
}

beforeAll(async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Use the QA integration tier');
  databases = await cloneQaOwnerDatabases(Bun.env.REZICS_QA_RUN_ID, ['access'], 'owner');
  access = new Pool({ connectionString: databases.urls.access, max: 8 });
  await access.query('INSERT INTO access.principal(id,account_issuer,account_subject) VALUES ($1,$2,$3)',
    [principalId, principal.issuer, principal.subject]);
  await access.query("INSERT INTO access.authority_subject(id,kind) VALUES ($1,'agent')", [actor]);
  await transaction(async client => {
    await grantFixtureAuthority(client, { scope, requireDispatch: true,
      representations: [{ principalId, actor, action: 'governance.moderate', lifetime: '8 hours' }],
      grant: { actor, action: 'governance.moderate', lifetime: '8 hours' } });
  });
  store = governance(access);
  expect((await access.query(`SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'access.governance_enforcement'::regclass
      AND tgname = 'governance_disclosure_change' AND NOT tgisinternal`)).rowCount).toBe(1);
}, 30_000);

afterAll(async () => { await access?.end(); await databases?.close(); });

async function transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await access.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

type Staged = { id: string; caseId: string; resources: string[]; input: DecisionInput };

/** Source disclosure is Access-local. Evidence, acceptance and acknowledgement
 * use production boundaries; Governance itself supplies the owner receipt. */
async function stage(resources: string[], outcome: 'restrict' | 'restore' = 'restrict', existingCase?: string): Promise<Staged> {
  const evidence = resources.map(resource => {
    const revision = native();
    observations.set(revision.slice(-36), resource.slice(-36));
    return { owner: 'source' as const, resource, component: 'record' as const, revision, locator: null };
  });
  const report = await store.submitReport(principal, {
    kind: 'content_report', actingSubject: actor, authority: { kind: 'platform', scopeId: scope },
    context: globalContext, target: { owner: 'source', resource: resources[0]!, component: 'record' },
    disclosure: 'private', reasonCode: 'disclosure', statement: 'Review the retained source records',
    evidence, idempotencyKey: randomUUID(),
  });
  if (existingCase) expect(report.caseId).toBe(existingCase);
  await store.safety.claim(principal, actor, report.caseId);
  const input: DecisionInput = {
    caseId: report.caseId, expectedGeneration: report.caseGeneration, actingSubject: actor, outcome,
    targets: resources.map(resource => ({ owner: 'source', resource, component: 'record', locator: null,
      scopeKind: 'component', revision: null, expectedHead: null, effect: 'disclosure' })),
    rule: { ref: 'urn:governance-disclosure-cut:rule', revision: '1', digest },
    evidenceDigest: report.evidenceDigest, reversesDecisionId: null, answersStepId: null,
    rationale: 'Reviewed fixture evidence', disclosure: 'private', reasons: fixtureReasons, idempotencyKey: randomUUID(),
  };
  const accepted = await store.decide(principal, input, true);
  expect(accepted.operation.status).not.toBe('completed');
  expect((await access.query('SELECT state,receipt FROM access.safety_decision_effect WHERE decision_id = $1 ORDER BY ordinal',
    [accepted.decisionId])).rows).toEqual(resources.map(() => ({ state: 'pending', receipt: null })));
  return { id: accepted.decisionId, caseId: accepted.caseId, resources, input };
}

/** Savepoints hold real Governance transactions inside a controlled outer
 * commit. Every mapped fence write and receipt remains GovernanceStore's work. */
function transactionPool(client: PoolClient, failOrdinal?: number): Pool {
  const held = new Proxy(client, { get(target, property) {
    if (property === 'release') return () => {};
    if (property === 'query') return (sql: string, args?: unknown[]) => {
      if (sql.startsWith('BEGIN')) return target.query('SAVEPOINT governance_acknowledgement');
      if (sql === 'COMMIT') return target.query('RELEASE SAVEPOINT governance_acknowledgement');
      if (sql === 'ROLLBACK') return target.query('ROLLBACK TO SAVEPOINT governance_acknowledgement');
      if (failOrdinal && sql.includes('INSERT INTO access.governance_enforcement') && args?.[9] === failOrdinal)
        throw new Error('acknowledgement connection interrupted');
      return target.query(sql, args);
    };
    const value: unknown = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  return new Proxy(access, { get(target, property) {
    if (property === 'connect') return async () => held;
    const value: unknown = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}

async function confirm(client: PoolClient, decision: Staged, failOrdinal?: number): Promise<string> {
  const result = await governance(transactionPool(client, failOrdinal)).resumeDecision(principal, actor, decision.id);
  if (!failOrdinal) expect(result.operation.status, JSON.stringify(result.operation)).toBe('completed');
  return (await client.query<{ id: string }>('SELECT id FROM access.governance_enforcement WHERE decision_id = $1 AND decision_ordinal = 1',
    [decision.id])).rows[0]!.id;
}

const basis = async () => (await access.query<{ basis: string }>('SELECT access.site_moderation_basis() AS basis')).rows[0]!.basis;
const signalCount = async () => (await access.query<{ count: number }>('SELECT count(*)::int AS count FROM access.site_moderation_change')).rows[0]!.count;

test('accepted pending decisions, acknowledgement and restoration advance the cut; accepted and completed replays preserve it', async () => {
  const preceding = await basis(), precedingCount = await signalCount();
  const decision = await stage([native()]);
  const pending = await basis(), count = await signalCount();
  expect(pending).not.toBe(preceding);
  expect(count).toBe(precedingCount + 1);
  const fence = await transaction(client => confirm(client, decision));
  expect(await basis()).not.toBe(pending);
  expect(await signalCount()).toBe(count + 1);
  const acknowledged = await basis(), acknowledgedCount = await signalCount();
  for (const replay of [() => store.resumeDecision(principal, actor, decision.id),
    () => store.decide(principal, decision.input), () => store.resumeDecision(principal, actor, decision.id)]) {
    const result = await replay();
    expect(result.replayed).toBe(true);
    expect(result.operation.status).toBe('completed');
    expect(await basis()).toBe(acknowledged);
    expect(await signalCount()).toBe(acknowledgedCount);
    expect((await access.query('SELECT state,fence_epoch::text FROM access.governance_enforcement WHERE id = $1', [fence])).rows)
      .toEqual([{ state: 'restricted', fence_epoch: '1' }]);
  }
  expect((await access.query('SELECT receipt FROM access.safety_decision_effect WHERE decision_id = $1', [decision.id])).rows)
    .toEqual([{ receipt: `access:governance-enforcement:${decision.id}:1` }]);
  const precedingRestore = await basis(), precedingRestoreCount = await signalCount();
  const restore = await stage(decision.resources, 'restore', decision.caseId);
  const pendingRestore = await basis();
  expect(pendingRestore).not.toBe(precedingRestore);
  expect(await signalCount()).toBe(precedingRestoreCount + 1);
  await transaction(client => confirm(client, restore));
  expect(await basis()).not.toBe(pendingRestore);
  expect((await access.query('SELECT state,fence_epoch::text FROM access.governance_enforcement WHERE id = $1', [fence])).rows)
    .toEqual([{ state: 'released', fence_epoch: '2' }]);
});

test('independent acknowledgement writers detect a late lower-xid commit while the oldest snapshot stays pinned', async () => {
  const first = await stage([native()]), second = await stage([native()]);
  const oldest = await access.connect(), held = await access.connect(), later = await access.connect();
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
  } finally { for (const client of [oldest, held, later]) { await client.query('ROLLBACK'); client.release(); } }
});

test('partial acknowledgement recovery and batch confirmation record one signal per transaction and recovery generation', async () => {
  const decision = await stage([native(), native(), native()]);
  const count = await signalCount();
  await transaction(client => confirm(client, decision, 2));
  expect(await signalCount()).toBe(count + 1);
  expect((await access.query('SELECT state,receipt FROM access.safety_decision_effect WHERE decision_id = $1 ORDER BY ordinal', [decision.id])).rows)
    .toEqual([{ state: 'confirmed', receipt: `access:governance-enforcement:${decision.id}:1` },
      { state: 'uncertain', receipt: null }, { state: 'pending', receipt: null }]);
  const partial = await basis(), generation = await engageAccessRecoveryFence(access);
  const held = await basis();
  try { expect(held).not.toBe(partial); }
  // Recovery holds ordinary writers. Resume only after the owner reopens it.
  finally { await releaseAccessRecoveryFence(access, generation); }
  const xid = await transaction(async client => {
    const row = (await client.query<{ xid: string }>('SELECT pg_current_xact_id()::text AS xid')).rows[0]!;
    await confirm(client, decision);
    await client.query('SELECT access.record_site_moderation_change()');
    return row.xid;
  });
  expect(await basis()).not.toBe(held);
  expect(await signalCount()).toBe(count + 2);
  expect((await access.query('SELECT epoch::text FROM access.site_moderation_change WHERE xid = $1::xid8', [xid])).rows)
    .toEqual([{ epoch: generation }]);
  expect((await access.query('SELECT state FROM access.safety_decision_effect WHERE decision_id = $1 ORDER BY ordinal', [decision.id])).rows)
    .toEqual([{ state: 'confirmed' }, { state: 'confirmed' }, { state: 'confirmed' }]);
});

test('rolled-back acknowledgements and refused stale, no-op and delete writes leave the cut unchanged', async () => {
  const decision = await stage([native()]);
  const pending = await basis(), count = await signalCount();
  await expect(transaction(async client => { await confirm(client, decision); throw new Error('confirmation aborted'); }))
    .rejects.toThrow('confirmation aborted');
  expect(await basis()).toBe(pending);
  expect(await signalCount()).toBe(count);
  const fence = await transaction(client => confirm(client, decision));
  const restore = await stage(decision.resources, 'restore', decision.caseId);
  const effective = await basis(), effectiveCount = await signalCount();
  await expect(transaction(client => client.query(`UPDATE access.governance_enforcement
    SET decision_id = $2,state = 'released',fence_epoch = 1 WHERE id = $1`, [fence, restore.id])))
    .rejects.toMatchObject({ code: '23514' });
  expect(await basis()).toBe(effective);
  expect(await signalCount()).toBe(effectiveCount);
  for (const sql of ['UPDATE access.governance_enforcement SET state = state WHERE id = $1',
    'UPDATE access.governance_enforcement SET fence_epoch = fence_epoch + 1 WHERE id = $1',
    'DELETE FROM access.governance_enforcement WHERE id = $1']) {
    await expect(transaction(client => client.query(sql, [fence]))).rejects.toMatchObject({ code: '23514' });
    expect(await basis()).toBe(effective);
    expect(await signalCount()).toBe(effectiveCount);
  }
});
