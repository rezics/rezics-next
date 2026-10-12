import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { startPostgresCluster, type PostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import type { FusekiClient } from '../src/infrastructure/fuseki.ts';
import {
  AccessAdmissionRegistry, type VerifiedPrincipal,
} from '../src/modules/access/admission.ts';
import { AccessAgentControl } from '../src/modules/access/agent-control.ts';
import { grantFixtureAuthority, grantFixtureControllerEdge } from '../src/modules/access/fixture-authority.ts';
import { AgentProvisioning, agentProvisionDigest } from '../src/modules/agent/provision.ts';

const root = resolve(import.meta.dir, '../../..');
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
let cluster: PostgresCluster | undefined;
let pool: Pool;
let control: AccessAgentControl;

beforeAll(async () => {
  cluster = await startPostgresCluster();
  pool = new Pool({ ...cluster.connection, max: 4, connectionTimeoutMillis: 1000 });
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
  control = new AccessAgentControl(pool);
}, 60_000);

afterAll(async () => {
  await pool?.end();
  cluster?.remove();
});

async function principal() {
  const id = randomUUID();
  const verified: VerifiedPrincipal = {
    issuer: 'https://account.rezics.test', subject: randomUUID(), emailVerified: true,
  };
  verified.currentAssertion = async () => verified;
  await pool.query(`INSERT INTO access.principal (id,account_issuer,account_subject)
    VALUES ($1,$2,$3)`, [id, verified.issuer, verified.subject]);
  return { id, verified };
}

type Principal = Awaited<ReturnType<typeof principal>>;

/** Graph receipt reconciliation is the external owner boundary. The real
 * provisioning state machine installs the subject and its controller in SQL. */
async function provision(owner: Principal, kind: 'person' | 'organization' | 'service',
  displayName = 'Deletion fixture') {
  const input = { kind, displayName };
  const graph = { query: async () => ({ results: { bindings: [{
    digest: { type: 'literal', value: agentProvisionDigest(input) },
    epoch: { type: 'literal', value: 'deletion-fixture' },
    sequence: { type: 'literal', value: '1' },
  }] } }) } as unknown as FusekiClient;
  const provisioning = new AgentProvisioning(pool, { fuseki: graph,
    lineage: { dataEpoch: 'deletion-fixture', routingEpoch: 'deletion-fixture' },
    objectDirectory: '.temp/account-deletion-agents' });
  const result = await provisioning.provision({ verify: async () => owner.verified },
    new Request('http://main.local/v1/agents'), input, randomUUID());
  expect(result.state).toBe('active');
  return result.agent;
}

function receipt() {
  const idempotencyKey = randomUUID();
  return { idempotencyKey, requestDigest: digest(idempotencyKey) };
}

async function principalState(owner: Principal) {
  return (await pool.query<{ active: boolean; enforcement_epoch: string }>(
    'SELECT active,enforcement_epoch FROM access.principal WHERE id = $1', [owner.id])).rows[0];
}

async function subjectState(subject: string) {
  return (await pool.query<{ active: boolean; controllers: number }>(`SELECT active,
    access.agent_controller_count(id) AS controllers FROM access.authority_subject WHERE id = $1`,
  [subject])).rows[0];
}

async function addFixtureController(owner: Principal, subject: string) {
  const authority = await grantFixtureAuthority(pool, {
    scope: 'work:create:root', requireDispatch: true,
    representations: [{ principalId: owner.id, actor: subject,
      action: 'agent.control', lifetime: 'infinity' }],
    grant: { actor: subject, action: 'agent.control', lifetime: 'infinity' },
  });
  return (await pool.query<{ id: string; generation: string }>(
    'SELECT id,generation FROM access.representation WHERE id = $1',
    [authority.representationIds[0]])).rows[0]!;
}

async function removeController(owner: Principal, subject: string) {
  const mandate = (await pool.query<{ id: string; generation: string }>(`SELECT id,generation
    FROM access.representation WHERE subject_id = $1 AND principal_id = $2
      AND action = 'agent.control' AND active`, [subject, owner.id])).rows[0]!;
  return control.removeController(owner.verified, receipt(), {
    subjectId: subject, representationId: mandate.id, expectedGeneration: mandate.generation,
  });
}

// Counting SQL results makes the budget independent of host scheduling.
function measuredPool(observer: (sql: string, result: { rowCount: number | null; rows: Record<string, unknown>[] }) => void,
  before?: (sql: string) => void) {
  if (!cluster) throw new Error('Postgres fixture unavailable');
  const measured = new Pool({ ...cluster.connection, max: 1 });
  measured.on('connect', client => {
    const query = client.query.bind(client);
    client.query = ((...args: unknown[]) => {
      const sql = typeof args[0] === 'string' ? args[0] : '';
      before?.(sql);
      return Reflect.apply(query, client, args).then((result: { rowCount: number | null; rows: Record<string, unknown>[] }) => {
        observer(sql, result);
        return result;
      });
    }) as typeof client.query;
  });
  return measured;
}

async function appendPerson(owner: Principal, parent: string) {
  const person = await provision(owner, 'person');
  await grantFixtureControllerEdge(pool, { principalId: owner.id, representative: parent, represented: person });
  await removeController(owner, person);
  return person;
}

test('unaffected co-controlled Person chains have identical deletion work at 8, 64 and 512 Agents', async () => {
  const costs: { statements: number; rows: number; classified: number; controllers: number }[] = [];
  for (const size of [8, 64, 512]) {
    const owner = await principal();
    const survivor = await principal();
    const persons = [await provision(owner, 'person')];
    await addFixtureController(survivor, persons[0]!);
    // Join two independently admitted halves: each edge admission sees at
    // most 256 ancestors or descendants, while the retained chain has 512.
    for (let index = 1; index < size; index++) persons.push(await provision(survivor, 'person'));
    const midpoint = Math.ceil(size / 2);
    const links = [...Array.from({ length: size - 1 }, (_, index) => index + 1)
      .filter(index => index !== midpoint), midpoint];
    for (const index of links) {
      await grantFixtureControllerEdge(pool, {
        principalId: survivor.id, representative: persons[index - 1]!, represented: persons[index]!,
      });
      await removeController(survivor, persons[index]!);
    }
    const cost = { statements: 0, rows: 0, classified: 0, controllers: 0 };
    const measured = measuredPool((sql, result) => {
      cost.statements++;
      cost.rows += result.rowCount ?? 0;
      if (sql.includes('account_deletion_classification_step')) {
        cost.classified += Number(result.rows[0]?.examined ?? 0);
        cost.controllers += Number(result.rows[0]?.controller_rows ?? 0);
      }
    });
    try {
      expect(await new AccessAdmissionRegistry(measured).strongDeactivateAccountSubject(
        owner.verified.issuer, owner.verified.subject)).toMatchObject({ enforcementEpoch: '1' });
    } finally { await measured.end(); }
    costs.push(cost);
    const touched = await pool.query(`SELECT id FROM access.authority_subject
      WHERE id = ANY($1::text[]) AND (NOT active OR generation <> 0)`, [persons]);
    expect(touched.rows).toEqual([]);
    const fenced = await pool.query(`SELECT a.agent_id FROM access.account_deletion_progress_agent a
      JOIN access.account_deletion_progress p USING (operation_id)
      WHERE p.principal_id = $1 AND a.agent_id = ANY($2::text[])`, [owner.id, persons]);
    expect(fenced.rows).toEqual([]);
    expect(await subjectState(persons[0]!)).toEqual({ active: true, controllers: 1 });
  }
  expect(costs[1]).toEqual(costs[0]);
  expect(costs[2]).toEqual(costs[0]);
}, 180_000);

test('long sole-controlled Person chains classify in bounded persisted steps and resume a failed step', async () => {
  const owner = await principal();
  const builder = await principal();
  const persons = [await provision(owner, 'person')];
  for (let index = 1; index < 40; index++) persons.push(await appendPerson(builder, persons.at(-1)!));
  const interruption = new Error('classification statement interrupted');
  let steps = 0;
  const counts: number[] = [];
  const measured = measuredPool((sql, result) => {
    if (sql.includes('CREATE TEMP TABLE account_deletion_candidates') || sql.includes('account_deletion_classification_step')) {
      const examined = Number(result.rows[0]?.examined ?? result.rowCount ?? 0);
      expect(examined).toBeLessThanOrEqual(16);
      expect(Number(result.rows[0]?.controller_rows ?? 0)).toBeLessThanOrEqual(1024);
      counts.push(examined);
    }
  }, sql => {
    if (sql.includes('account_deletion_classification_step') && ++steps === 5) throw interruption;
  });
  try {
    await expect(new AccessAdmissionRegistry(measured).strongDeactivateAccountSubject(
      owner.verified.issuer, owner.verified.subject)).rejects.toBe(interruption);
  } finally { await measured.end(); }
  expect(await principalState(owner)).toEqual({ active: true, enforcement_epoch: '0' });
  const progress = (await pool.query<{ operation_id: string }>(`SELECT operation_id
    FROM access.account_deletion_progress WHERE principal_id = $1 AND NOT completed`, [owner.id])).rows[0];
  expect(progress).toBeDefined();
  const retained = await pool.query(`SELECT agent_id FROM access.account_deletion_progress_agent
    WHERE operation_id = $1`, [progress!.operation_id]);
  expect(retained.rows).toHaveLength(4);
  const resumed = measuredPool((sql, result) => {
    if (sql.includes('account_deletion_classification_step')) {
      const examined = Number(result.rows[0]?.examined ?? 0);
      expect(examined).toBeLessThanOrEqual(16);
      expect(Number(result.rows[0]?.controller_rows ?? 0)).toBeLessThanOrEqual(1024);
      counts.push(examined);
    }
  });
  try {
    expect(await new AccessAdmissionRegistry(resumed).strongDeactivateAccountSubject(
      owner.verified.issuer, owner.verified.subject)).toMatchObject({ enforcementEpoch: '1' });
  } finally { await resumed.end(); }
  expect(counts).toHaveLength(persons.length);
  expect(counts.reduce((sum, count) => sum + count, 0)).toBe(persons.length);
  for (const subject of persons) expect(await subjectState(subject)).toEqual({ active: false, controllers: 0 });
  expect((await pool.query(`SELECT id FROM access.outbox WHERE principal_id = $1
    AND kind = 'account.deletion_fenced'`, [owner.id])).rows).toEqual([{ id: progress!.operation_id }]);
}, 60_000);
