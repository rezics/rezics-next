import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { startPostgresCluster, type PostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import type { VerifiedPrincipal } from '../src/modules/access/admission.ts';
import { AccessPolicyChanges } from '../src/modules/access/policy-changes.ts';
import { AccessPolicyDecisions, DIRECT_GRANT_PROOF_LIMIT } from '../src/modules/access/policy-decisions.ts';
import { ProofHandleStale } from '../src/modules/access/policy-errors.ts';
import { representedWorkProof } from '../src/modules/access/represented-work-proof.ts';

const root = resolve(import.meta.dir, '../../..');
const agent = () => `https://rezics.com/id/${randomUUID()}`;
const grantId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

let cluster: PostgresCluster | undefined;
let pool: Pool;
let scope: string;
let owner: string;
let principalId: string;
let principal: VerifiedPrincipal;
let decisions: AccessPolicyDecisions;

beforeAll(async () => {
  const running = await startPostgresCluster();
  cluster = running;
  pool = new Pool({ ...running.connection, max: 4 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const file of schemaFiles(root, 'access')) {
      await client.query(readFileSync(join(root, 'services/main/migrations/access', file), 'utf8'));
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }

  principalId = randomUUID();
  principal = { issuer: 'https://account.rezics.test', subject: randomUUID() };
  owner = agent();
  scope = `wiki:${randomUUID()}`;
  await pool.query('INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1,$2,$3)',
    [principalId, principal.issuer, principal.subject]);
  await pool.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent')", [owner]);
  await pool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [scope]);
  const manageMandate = randomUUID();
  await pool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
    VALUES ($1,$2,$3,'access.policy.manage', clock_timestamp() + interval '1 hour')`,
  [manageMandate, principalId, owner]);
  await pool.query(`INSERT INTO access.permission_grant (id, issuer_subject, recipient_subject, scope_id,
      action, valid_until)
    VALUES ($1,$2,$2,$3,'access.policy.manage', clock_timestamp() + interval '1 hour')`,
  [randomUUID(), owner, scope]);
  const key = randomUUID();
  await new AccessPolicyChanges(pool).change({
    principal, issuerSubject: owner, expectedAuthorityEpoch: '0', idempotencyKey: key, requestDigest: digest(key),
  }, {
    action: 'publish-revision', policyId: randomUUID(), scopeId: scope, expectedHeadRevision: '0',
    mandatory: [
      { ruleId: randomUUID(), actions: ['work.edit'], condition: { op: 'authenticated' } },
      { ruleId: randomUUID(), actions: ['work.edit'], condition: { op: 'represents' } },
    ],
    ordered: [{ ruleId: randomUUID(), actions: ['work.edit'], effect: 'allow',
      condition: { op: 'has-grant', action: 'work.edit' } }],
  });
  decisions = new AccessPolicyDecisions(pool);
}, 180_000);

afterAll(async () => {
  await pool?.end();
  cluster?.remove();
});

async function editor() {
  const actor = agent();
  await pool.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent')", [actor]);
  await pool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
    VALUES ($1,$2,$3,'work.edit', clock_timestamp() + interval '1 hour')`, [randomUUID(), principalId, actor]);
  return actor;
}

async function grant(actor: string, id: string, lifetime: string) {
  await pool.query(`INSERT INTO access.permission_grant (id, issuer_subject, recipient_subject, scope_id,
      action, valid_until)
    VALUES ($1,$2,$3,$4,'work.edit', clock_timestamp() + $5::interval)`,
  [id, owner, actor, scope, lifetime]);
  return (await pool.query<{ valid_until: Date }>(
    'SELECT valid_until FROM access.permission_grant WHERE id = $1', [id])).rows[0]!.valid_until;
}

function decide(actor: string, validitySeconds = 120) {
  return decisions.decide({ principal, scopeId: scope, action: 'work.edit', actingSubject: actor,
    reusable: true, validitySeconds });
}

async function proofGrants(decisionId: string) {
  const rows = await pool.query<{ permission_grant_id: string }>(`SELECT permission_grant_id
    FROM access.decision_snapshot_input
    WHERE decision_id = $1 AND role = 'proof' AND kind = 'permission_grant'
    ORDER BY permission_grant_id`, [decisionId]);
  return rows.rows.map(row => row.permission_grant_id);
}

test('zero live direct grants deny and record no proof source', async () => {
  const decision = await decide(await editor());
  expect([decision.result, decision.sources]).toEqual(['deny', []]);
});

test('one live direct grant is the only recorded source', async () => {
  const actor = await editor();
  const id = grantId(1);
  await grant(actor, id, '1 hour');
  const decision = await decide(actor);
  expect([decision.result, decision.sources.map(source => source.id)]).toEqual(['allow', [id]]);
  expect(decision.sources[0]).toMatchObject({ kind: 'permission_grant', generation: '0' });
  expect(await proofGrants(decision.decisionId!)).toEqual([id]);
});

test('two live direct grants are both recorded in id order', async () => {
  const actor = await editor();
  const higher = grantId(20);
  const lower = grantId(12);
  await grant(actor, higher, '1 hour');
  await grant(actor, lower, '1 hour');
  const decision = await decide(actor);
  // A single-row limit would keep only one of these grants.
  expect([decision.result, decision.sources.map(source => source.id)]).toEqual(['allow', [lower, higher]]);
  expect(await proofGrants(decision.decisionId!)).toEqual([lower, higher]);
  const expiresIn = Date.parse(decision.expiresAt!) - Date.now();
  expect(expiresIn).toBeGreaterThan(100_000);
  expect(expiresIn).toBeLessThanOrEqual(120_000);
});

test('nine live direct grants record the eight lowest ids and still allow', async () => {
  const actor = await editor();
  const ids = Array.from({ length: DIRECT_GRANT_PROOF_LIMIT + 1 }, (_, index) => grantId(30 + index));
  for (const id of [...ids].reverse()) await grant(actor, id, '1 hour');
  const decision = await decide(actor);
  const recorded = ids.slice(0, DIRECT_GRANT_PROOF_LIMIT);
  expect([decision.result, decision.sources.map(source => source.id)]).toEqual(['allow', recorded]);
  expect(await proofGrants(decision.decisionId!)).toEqual(recorded);
  expect(decision.sources.some(source => source.id === ids.at(-1))).toBe(false);
});

test('an expired direct grant is not a proof source', async () => {
  const actor = await editor();
  const expired = grantId(50);
  const live = grantId(51);
  await grant(actor, expired, '-1 minute');
  await grant(actor, live, '1 hour');
  const decision = await decide(actor);
  expect([decision.result, decision.sources.map(source => source.id)]).toEqual(['allow', [live]]);
  expect(await proofGrants(decision.decisionId!)).toEqual([live]);
});

test('two direct grants end the decision at the earlier expiry and either revocation stales it', async () => {
  const actor = await editor();
  const longer = grantId(60);
  const sooner = grantId(61);
  const longerUntil = await grant(actor, longer, '1 hour');
  const soonerUntil = await grant(actor, sooner, '45 seconds');
  const decision = await decide(actor);
  expect(decision.sources.map(source => source.id)).toEqual([longer, sooner]);
  expect(await proofGrants(decision.decisionId!)).toEqual([longer, sooner]);
  const expiresAt = Date.parse(decision.expiresAt!);
  expect(Math.abs(expiresAt - soonerUntil.getTime())).toBeLessThan(50);
  expect(expiresAt).toBeLessThan(longerUntil.getTime());

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const proof = await representedWorkProof(client, principalId, actor, 'work.edit', scope);
    await client.query('COMMIT');
    expect(proof?.grantId).toBe(longer);
  } finally { client.release(); }

  await pool.query('UPDATE access.permission_grant SET active = false WHERE id = $1', [longer]);
  await expect(decisions.revalidate(principal, decision.decisionId!, scope, 'work.edit', actor))
    .rejects.toBeInstanceOf(ProofHandleStale);
  const remaining = await decide(actor);
  expect(remaining.sources).toEqual([{ kind: 'permission_grant', id: sooner, generation: '0' }]);
  expect(await proofGrants(remaining.decisionId!)).toEqual([sooner]);
  expect(Math.abs(Date.parse(remaining.expiresAt!) - soonerUntil.getTime())).toBeLessThan(50);
  const rows = await pool.query('SELECT id, active, generation FROM access.permission_grant WHERE id = ANY($1) ORDER BY id',
    [[longer, sooner]]);
  expect(rows.rows).toEqual([
    { id: longer, active: false, generation: '1' },
    { id: sooner, active: true, generation: '0' },
  ]);
});
