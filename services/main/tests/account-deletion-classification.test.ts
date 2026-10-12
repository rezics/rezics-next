import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, statSync, writeFileSync, openSync, readSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { startPostgresCluster, type PostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import { boundedPool, nestedPoolCheckoutMode, setNestedPoolCheckoutMode } from '../src/infrastructure/pg-pool.ts';
import type { FusekiClient } from '../src/infrastructure/fuseki.ts';
import {
  AccessAdmissionRegistry, AccountHasOwnedAgents, type VerifiedPrincipal,
} from '../src/modules/access/admission.ts';
import { ACCOUNT_DELETION_CLASSIFICATION_COST, collectAccountDeletionAgents, lockAccountDeletionTopology } from '../src/modules/access/account-deletion-agents.ts';
import { AccessAgentControl } from '../src/modules/access/agent-control.ts';
import { grantFixtureAuthority, grantFixtureControllerEdge, deactivateFixtureController, registerFixtureIdentity } from '../src/modules/access/fixture-authority.ts';
import { AgentProvisioning, agentProvisionDigest } from '../src/modules/agent/provision.ts';

const root = resolve(import.meta.dir, '../../..');
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
let cluster: PostgresCluster | undefined;
let pool: Pool;
let control: AccessAgentControl;

beforeAll(async () => {
  cluster = await startPostgresCluster({ serverSettings: `shared_preload_libraries = 'auto_explain'
auto_explain.log_analyze = on
auto_explain.log_buffers = on
auto_explain.log_timing = off
auto_explain.log_nested_statements = on
auto_explain.log_format = 'json'
log_line_prefix = ''
logging_collector = off
log_destination = 'stderr'
` });
  pool = new Pool({ ...cluster.connection, max: 4, connectionTimeoutMillis: 5000,
    // Only fixture preparation skips per-write flushes. Metered production
    // clients retain the server's synchronous commit and timeout defaults.
    options: '-c synchronous_commit=off -c jit=off' });
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

// Fault injection observes the production transaction and statement boundary.
function measuredPool(observer: (sql: string) => void,
  before?: (sql: string) => void) {
  if (!cluster) throw new Error('Postgres fixture unavailable');
  const measured = new Pool({ ...cluster.connection, max: 1 });
  measured.on('connect', client => {
    let timeoutArmed = false;
    const query = client.query.bind(client);
    client.query = ((...args: unknown[]) => {
      const sql = typeof args[0] === 'string' ? args[0] : '';
      if (sql === 'BEGIN') timeoutArmed = false;
      if (sql.includes("SET LOCAL statement_timeout = '5s'")) timeoutArmed = true;
      if (sql.includes('account_deletion_classification_step')) expect(timeoutArmed).toBe(true);
      before?.(sql);
      return Reflect.apply(query, client, args).then((result: unknown) => {
        observer(sql);
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

let unaffectedCorpus: { survivor: Principal; persons: string[] } | undefined;
async function unaffectedChain() {
  if (unaffectedCorpus) return unaffectedCorpus;
  const survivor = await principal();
  const corpus: string[] = [];
  for (let index = 0; index < 512; index++) corpus.push(await provision(survivor, 'person'));
  // Join independently admitted halves so each edge admission sees at most
  // 256 ancestors or descendants. Every measured root has a fresh controller
  // inventory, and its descendants reuse this one retained corpus.
  const links = [...Array.from({ length: 511 }, (_, index) => index + 1)
    .filter(index => index !== 256), 256];
  for (const index of links) {
    await grantFixtureControllerEdge(pool, {
      principalId: survivor.id, representative: corpus[index - 1]!, represented: corpus[index]!,
    });
    await removeController(survivor, corpus[index]!);
  }
  unaffectedCorpus = { survivor, persons: corpus };
  return unaffectedCorpus;
}

test('unaffected co-controlled Person chains have identical deletion work at 8, 64 and 512 Agents', async () => {
  const costs: { statements: number; rows: number }[] = [];
  const { survivor, persons: corpus } = await unaffectedChain();
  for (const size of [8, 64, 512]) {
    const owner = await principal();
    const rootPerson = size === 512 ? corpus[0]! : await provision(survivor, 'person');
    const persons = size === 512 ? corpus : [rootPerson, ...corpus.slice(-(size - 1))];
    if (size !== 512) await grantFixtureControllerEdge(pool, {
      principalId: survivor.id, representative: rootPerson, represented: persons[1]!,
    });
    await addFixtureController(owner, rootPerson);
    const cost = { statements: 0, plans: 0, rows: 0 };
    const measured = planPool([], (_sql, plans) => {
      cost.statements++;
      cost.plans += plans.length;
      cost.rows += plans.reduce((sum, plan) => sum + planRows(plan.Plan), 0);
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
}, 300_000);

test('long sole-controlled Person chains classify in bounded persisted steps and resume a failed step', async () => {
  const owner = await principal();
  const builder = await principal();
  const persons = [await provision(owner, 'person')];
  for (let index = 1; index < 40; index++) persons.push(await appendPerson(builder, persons.at(-1)!));
  const interruption = new Error('classification statement interrupted');
  let steps = 0;
  const counts: number[] = [];
  const observeStep = (sql: string, plans: RecordedPlan[]) => {
    if (!sql.includes('account_deletion_classification_step')) return;
    const reads = plans.reduce((sum, plan) => sum + planRows(plan.Plan), 0);
    expect(reads).toBeLessThanOrEqual(1024);
    expect(plans.reduce((sum, plan) => sum + planBuffers(plan.Plan), 0)).toBeLessThanOrEqual(2048);
    counts.push(reads);
  };
  const measured = planPool([], observeStep, sql => {
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
  const resumed = planPool([], observeStep);
  try {
    expect(await new AccessAdmissionRegistry(resumed).strongDeactivateAccountSubject(
      owner.verified.issuer, owner.verified.subject)).toMatchObject({ enforcementEpoch: '1' });
  } finally { await resumed.end(); }
  expect(counts).toHaveLength(persons.length);
  expect(counts.reduce((sum, count) => sum + count, 0)).toBeLessThanOrEqual(persons.length * 1024);
  expect((await pool.query(`SELECT agent_id FROM access.account_deletion_progress_agent
    WHERE operation_id = $1 AND effect = 'end'`, [progress!.operation_id])).rows).toHaveLength(persons.length);
  for (const subject of persons) expect(await subjectState(subject)).toEqual({ active: false, controllers: 0 });
  expect((await pool.query(`SELECT id FROM access.outbox WHERE principal_id = $1
    AND kind = 'account.deletion_fenced'`, [owner.id])).rows).toEqual([{ id: progress!.operation_id }]);
}, 60_000);

test('controller loss at an unfenced cut wakes only that frontier target', async () => {
  const owner = await principal();
  const survivor = await principal();
  const persons: string[] = [];
  for (let index = 0; index < 32; index++) {
    const person = await provision(owner, 'person');
    await addFixtureController(survivor, person);
    persons.push(person);
  }
  const interruption = new Error('classification frontier committed');
  let classified = false;
  const measured = measuredPool(sql => {
    if (sql.includes('account_deletion_classification_step')) classified = true;
    if (sql === 'COMMIT' && classified) throw interruption;
  });
  try {
    await expect(new AccessAdmissionRegistry(measured).strongDeactivateAccountSubject(
      owner.verified.issuer, owner.verified.subject)).rejects.toBe(interruption);
  } finally { await measured.end(); }
  const progress = (await pool.query<{ operation_id: string; root_cursor: string }>(`SELECT operation_id,root_cursor
    FROM access.account_deletion_progress WHERE principal_id = $1`, [owner.id])).rows[0]!;
  expect((await pool.query('SELECT agent_id FROM access.account_deletion_progress_agent WHERE operation_id = $1',
    [progress.operation_id])).rows).toEqual([]);
  const cut = (await pool.query<{ subject_id: string }>(`SELECT subject_id FROM access.representation
    WHERE principal_id = $1 AND action = 'agent.control' AND active AND id <= $2::uuid
    ORDER BY id LIMIT 1`, [owner.id, progress.root_cursor])).rows[0]!.subject_id;
  // This cut was already visited, so a root cursor alone would miss its loss.
  await removeController(survivor, cut);
  expect((await pool.query(`SELECT agent_id FROM access.account_deletion_classification_frontier
    WHERE operation_id = $1`, [progress.operation_id])).rows).toEqual([{ agent_id: cut }]);
  expect(await new AccessAdmissionRegistry(pool).strongDeactivateAccountSubject(
    owner.verified.issuer, owner.verified.subject)).toMatchObject({ enforcementEpoch: '1' });
  expect(await subjectState(cut)).toEqual({ active: false, controllers: 0 });
  for (const person of persons.filter(person => person !== cut)) {
    expect(await subjectState(person)).toEqual({ active: true, controllers: 1 });
  }
  expect((await pool.query('SELECT agent_id FROM access.account_deletion_progress_agent WHERE operation_id = $1',
    [progress.operation_id])).rows).toEqual([{ agent_id: cut }]);
}, 60_000);

test('newly affected orphans below a committed cursor are recorded on retry', async () => {
  const owner = await principal();
  const survivor = await principal();
  const organizations: string[] = [];
  for (let index = 0; index < 258; index++) organizations.push(await provision(owner, 'organization'));
  organizations.sort();
  const cut = organizations[0]!;
  await addFixtureController(survivor, cut);
  const interruption = new Error('first orphan page committed');
  let orphanPage = false;
  const measured = measuredPool(sql => {
    if (sql.includes('CREATE TEMP TABLE account_deletion_batch')) orphanPage = true;
    if (sql === 'COMMIT' && orphanPage) throw interruption;
  });
  try {
    await expect(new AccessAdmissionRegistry(measured).strongDeactivateAccountSubject(
      owner.verified.issuer, owner.verified.subject, { leaveOwnedAgentsStanding: true })).rejects.toBe(interruption);
  } finally { await measured.end(); }
  const progress = (await pool.query<{ operation_id: string; orphan_cursor: string }>(`SELECT operation_id,orphan_cursor
    FROM access.account_deletion_progress WHERE principal_id = $1`, [owner.id])).rows[0]!;
  expect(cut < progress.orphan_cursor).toBe(true);
  expect((await pool.query('SELECT agent_id FROM access.account_deletion_orphan_agent WHERE operation_id = $1',
    [progress.operation_id])).rows).toHaveLength(256);
  await removeController(survivor, cut);
  expect((await pool.query(`SELECT agent_id FROM access.account_deletion_classification_frontier
    WHERE operation_id = $1`, [progress.operation_id])).rows).toEqual([{ agent_id: cut }]);
  const access = new AccessAdmissionRegistry(pool);
  await expect(access.strongDeactivateAccountSubject(owner.verified.issuer, owner.verified.subject))
    .resolves.toMatchObject({ enforcementEpoch: '1' });
  expect((await pool.query(`SELECT agent_id FROM access.account_deletion_orphan_agent
    WHERE operation_id = $1 ORDER BY agent_id`, [progress.operation_id])).rows.map(row => row.agent_id)).toEqual(organizations);
  expect((await pool.query(`SELECT agent_id FROM access.account_deletion_progress_agent
    WHERE operation_id = $1 AND (fenced OR NOT completed)`, [progress.operation_id])).rows).toEqual([]);
  await expect(access.strongDeactivateAccountSubject(owner.verified.issuer, owner.verified.subject))
    .resolves.toMatchObject({ enforcementEpoch: '1' });
}, 120_000);

test('legacy keep inventory releases every fence before the survivor changes control or deletes', async () => {
  const owner = await principal();
  const survivor = await principal();
  const replacement = await principal();
  const organization = await provision(owner, 'organization');
  await addFixtureController(survivor, organization);
  const access = new AccessAdmissionRegistry(pool);
  await access.strongDeactivatePrincipal(owner.id, '0');
  const operation = randomUUID();
  // The frontier migration preserves a fence-first operation with keep rows.
  await pool.query(`INSERT INTO access.account_deletion_progress
    (operation_id,principal_id,roots_done,classification_done,consent) VALUES ($1,$2,true,true,true)`, [operation, owner.id]);
  await pool.query(`INSERT INTO access.account_deletion_progress_agent (operation_id,agent_id,effect,expanded,fenced)
    VALUES ($1,$2,'keep',true,true)`, [operation, organization]);
  await expect(access.strongDeactivateAccountSubject(owner.verified.issuer, owner.verified.subject))
    .resolves.toMatchObject({ enforcementEpoch: '1' });
  expect((await pool.query(`SELECT fenced FROM access.account_deletion_progress_agent
    WHERE operation_id = $1`, [operation])).rows).toEqual([{ fenced: false }]);
  await addFixtureController(replacement, organization);
  await removeController(replacement, organization);
  await expect(access.strongDeactivateAccountSubject(survivor.verified.issuer, survivor.verified.subject,
    { leaveOwnedAgentsStanding: true })).resolves.toMatchObject({ enforcementEpoch: '1' });
});

test('legacy fence completion migration repairs stranded rows while preserving open operation fences', async () => {
  const legacyCluster = await startPostgresCluster();
  const legacyPool = new Pool({ ...legacyCluster.connection, max: 1 });
  const client = await legacyPool.connect();
  try {
    await client.query('BEGIN');
    for (const file of schemaFiles(root, 'access')) {
      if (file === '2060_account_deletion_fence_completion.sql') break;
      await client.query(readFileSync(join(root, 'services/main/migrations/access', file), 'utf8'));
    }
    const inventories: { operation: string; agent: string; representation: string; completed: boolean }[] = [];
    for (const [effect, completed] of [['keep', true], ['end', true], ['orphan', true], ['keep', false]] as const) {
      const owner = randomUUID();
      const agent = `https://rezics.com/id/${randomUUID()}`;
      const operation = randomUUID();
      await registerFixtureIdentity(client, { principalId: owner, issuer: 'https://account.rezics.test', subject: owner, actor: agent });
      const authority = await grantFixtureAuthority(client, {
        scope: 'work:create:root', requireDispatch: true,
        representations: [{ principalId: owner, actor: agent, action: 'agent.control', lifetime: 'infinity' }],
        grant: { actor: agent, action: 'agent.control', lifetime: 'infinity' },
      });
      await client.query(`INSERT INTO access.account_deletion_progress
        (operation_id,principal_id,completed,orphan_cursor) VALUES ($1,$2,$3,$4)`, [operation, owner, completed, agent]);
      await client.query(`INSERT INTO access.account_deletion_progress_agent (operation_id,agent_id,effect,fenced)
        VALUES ($1,$2,$3,true)`, [operation, agent, effect]);
      inventories.push({ operation, agent, representation: authority.representationIds[0]!, completed });
    }
    await client.query(readFileSync(join(root, 'services/main/migrations/access/2060_account_deletion_fence_completion.sql'), 'utf8'));
    for (const inventory of inventories) {
      expect((await client.query('SELECT fenced FROM access.account_deletion_progress_agent WHERE operation_id = $1',
        [inventory.operation])).rows).toEqual([{ fenced: !inventory.completed }]);
      expect((await client.query('SELECT orphan_cursor FROM access.account_deletion_progress WHERE operation_id = $1',
        [inventory.operation])).rows).toEqual([{ orphan_cursor: inventory.completed ? inventory.agent : null }]);
      // The real fence predicate permits changes to the repaired row only.
      await client.query('SAVEPOINT controller_change');
      const change = deactivateFixtureController(client, inventory.representation);
      if (inventory.completed) {
        await expect(change).resolves.toBeUndefined();
        expect((await client.query('SELECT active FROM access.representation WHERE id = $1',
          [inventory.representation])).rows).toEqual([{ active: false }]);
      }
      else await expect(change).rejects.toMatchObject({ code: '54000' });
      await client.query('ROLLBACK TO SAVEPOINT controller_change');
    }
    await client.query('COMMIT');
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await legacyPool.end();
    legacyCluster.remove();
  }
}, 60_000);

test('ordinary principal fencing counts 129 distinct Agents with two mandates each', async () => {
  const owner = await principal();
  const survivor = await principal();
  const organizations: string[] = [];
  const fixtures = new Pool({ ...cluster!.connection, max: 1 });
  fixtures.on('connect', client => {
    const query = client.query.bind(client);
    client.query = ((...args: unknown[]) => {
      // Admit a second valid mandate through the fixture owner, bypassing only
      // its reuse lookup so the production trigger sees both real mandates.
      if (typeof args[0] === 'string' && args[0].includes('SELECT id FROM access.representation')) {
        args[0] = args[0].replace('FOR SHARE', 'AND false FOR SHARE');
      }
      return Reflect.apply(query, client, args);
    }) as typeof client.query;
  });
  try {
    for (let index = 0; index < 129; index++) {
      const organization = await provision(owner, 'organization');
      organizations.push(organization);
      await addFixtureController(survivor, organization);
      await grantFixtureAuthority(fixtures, {
        scope: 'work:create:root', requireDispatch: true,
        representations: [{ principalId: owner.id, actor: organization, action: 'agent.control', lifetime: 'infinity' }],
        grant: { actor: organization, action: 'agent.control', lifetime: 'infinity' },
      });
    }
  } finally { await fixtures.end(); }
  expect((await pool.query('SELECT representation_id FROM access.live_principal_controller WHERE principal_id = $1',
    [owner.id])).rows).toHaveLength(258);
  await expect(new AccessAdmissionRegistry(pool).strongDeactivatePrincipal(owner.id, '0'))
    .resolves.toMatchObject({ enforcementEpoch: '1' });
  expect((await pool.query('SELECT representation_id FROM access.live_principal_controller WHERE principal_id = $1',
    [owner.id])).rows).toEqual([]);
  for (const organization of organizations) expect(await subjectState(organization)).toEqual({ active: true, controllers: 1 });
  // The same subject budget governs restoration, including every mandate.
  await pool.query('UPDATE access.principal SET active = true WHERE id = $1', [owner.id]);
  expect((await pool.query('SELECT representation_id FROM access.live_principal_controller WHERE principal_id = $1',
    [owner.id])).rows).toHaveLength(258);
  for (const organization of organizations) expect(await subjectState(organization)).toEqual({ active: true, controllers: 3 });
}, 120_000);


test('bounded production pool releases classification and orphan handoffs in throw and log modes', async () => {
  const previous = nestedPoolCheckoutMode();
  const original = console.error;
  const logged: string[] = [];
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  try {
    for (const mode of ['throw', 'log'] as const) {
      setNestedPoolCheckoutMode(mode);
      const owner = await principal();
      for (let index = 0; index < 18; index++) await provision(owner, 'person');
      const measured = boundedPool({ ...cluster!.connection, max: 1, connectionTimeoutMillis: 1000 });
      const held = new WeakSet<object>();
      measured.on('acquire', client => held.add(client));
      measured.on('release', (_error, client) => held.delete(client));
      measured.on('connect', client => {
        const query = client.query.bind(client);
        client.query = ((...args: unknown[]) => {
          expect(held.has(client)).toBe(true);
          return Reflect.apply(query, client, args);
        }) as typeof client.query;
      });
      try {
        expect(await new AccessAdmissionRegistry(measured).strongDeactivateAccountSubject(
          owner.verified.issuer, owner.verified.subject)).toMatchObject({ enforcementEpoch: '1' });
      } finally { await measured.end(); }
    }
    expect(logged.filter(line => line.includes('NestedPoolCheckoutError'))).toEqual([]);
  } finally {
    console.error = original;
    setNestedPoolCheckoutMode(previous);
  }
}, 60_000);


type ReadPlan = {
  'Node Type': string; 'Relation Name'?: string; 'Actual Rows': number; 'Actual Loops': number;
  'Index Name'?: string; 'Index Cond'?: string; 'Filter'?: string; 'Rows Removed by Filter'?: number; 'Rows Removed by Index Recheck'?: number;
  'Shared Hit Blocks'?: number; 'Shared Read Blocks'?: number; 'Local Hit Blocks'?: number; 'Local Read Blocks'?: number; Plans?: ReadPlan[];
};
type RecordedPlan = { 'Query Text': string; Plan: ReadPlan; Statement: string; StatementInstance: number };
function planRows(plan: ReadPlan, relation?: string): number {
  const own = plan['Relation Name'] && (!relation || plan['Relation Name'] === relation) && plan['Node Type'].endsWith('Scan') ? (plan['Actual Rows'] + (plan['Rows Removed by Filter'] ?? 0)
    + (plan['Rows Removed by Index Recheck'] ?? 0)) * plan['Actual Loops'] : 0;
  return own + (plan.Plans ?? []).reduce((sum, child) => sum + planRows(child, relation), 0);
}

function planBuffers(plan: ReadPlan): number {
  // The root includes index-maintenance and FK work as well as scan buffers.
  // Nested function roots are also counted, conservatively including overlap.
  return (plan['Shared Hit Blocks'] ?? 0) + (plan['Shared Read Blocks'] ?? 0)
    + (plan['Local Hit Blocks'] ?? 0) + (plan['Local Read Blocks'] ?? 0);
}

/** auto_explain logs the executed production statement and every nested SQL
 * function/trigger plan. Result cardinality cannot hide discarded history. */
function planPool(plans: RecordedPlan[], observe?: (sql: string, plans: RecordedPlan[]) => void,
  before?: (sql: string) => void) {
  const measured = new Pool({ ...cluster!.connection, max: 1 });
  let instance = 0;
  measured.on('connect', client => {
    const query = client.query.bind(client);
    let armed = false;
    let timeoutArmed = false;
    client.query = ((...args: unknown[]) => {
      const callback = typeof args.at(-1) === 'function' ? args.pop() as (error: unknown, result?: unknown) => void : undefined;
      const pending = (async () => {
        if (!armed) {
          await query("SET auto_explain.log_min_duration = 0");
          armed = true;
        }
        const statement = typeof args[0] === 'string' ? args[0] : '';
        if (statement === 'BEGIN') timeoutArmed = false;
        if (statement.includes("SET LOCAL statement_timeout = '5s'")) timeoutArmed = true;
        if (statement.includes('account_deletion_classification_step')) expect(timeoutArmed).toBe(true);
        before?.(statement);
        const statementInstance = ++instance;
        const executed: RecordedPlan[] = [];
        const path = join(cluster!.directory, 'postgres.log');
        const offset = statSync(path).size;
        const result = await Reflect.apply(query, client, args);
        // ReadyForQuery can arrive before ExecutorEnd flushes the plan log.
        await query('SELECT 1 /* plan_log_flush */');
        const length = statSync(path).size - offset;
        const appended = Buffer.alloc(length);
        const logFile = openSync(path, 'r');
        try { readSync(logFile, appended, 0, length, offset); } finally { closeSync(logFile); }
        const log = appended.toString();
        for (const match of log.matchAll(/plan:\n\t(\{[\s\S]*?\n\t\})/g)) {
          const plan = JSON.parse(match[1]!) as RecordedPlan;
          if (!plan['Query Text'].includes('plan_log_flush')) executed.push({ ...plan,
            Statement: statement, StatementInstance: statementInstance });
        }
        plans.push(...executed);
        observe?.(statement, executed);
        return result;
      })();
      if (callback) {
        void pending.then(result => callback(null, result), error => callback(error));
        return undefined;
      }
      return pending;
    }) as typeof client.query;
  });
  return measured;
}

async function measuredWork(work: (measured: Pool) => Promise<void>) {
  const plans: RecordedPlan[] = [];
  const measured = planPool(plans);
  try { await work(measured); } finally { await measured.end(); }
  expect(plans.length).toBeGreaterThan(0);
  return { rows: plans.reduce((sum, plan) => sum + planRows(plan.Plan), 0), plans };
}

function readScans(plan: ReadPlan): unknown[] {
  return [...(plan['Relation Name'] && plan['Node Type'].endsWith('Scan') ? [{
    node: plan['Node Type'], relation: plan['Relation Name'], index: plan['Index Name'], condition: plan['Index Cond'], filter: plan.Filter,
    rows: plan['Actual Rows'], removed: plan['Rows Removed by Filter'], loops: plan['Actual Loops'],
  }] : []), ...(plan.Plans ?? []).flatMap(readScans)];
}

test('classification and wake-up read budgets exclude inactive history and unrelated open deletions', async () => {
  const survivor = await principal();
  const target = await provision(survivor, 'organization');
  const { persons: unrelated } = await unaffectedChain();
  const inactiveCosts: number[] = [];
  const samples: unknown[] = [];
  const wakeCosts: number[] = [];
  let size = 0;
  for (const next of [8, 64, 512]) {
    for (; size < next; size++) {
      // Historical mandates are installed through the fixture authority owner;
      // ordinary Account deletion retains them after principal deactivation.
      const historical = await principal();
      await addFixtureController(historical, target);
      await new AccessAdmissionRegistry(pool).strongDeactivateAccountSubject(
        historical.verified.issuer, historical.verified.subject);
      const waiting = await principal();
      await addFixtureController(waiting, unrelated[size]!);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await lockAccountDeletionTopology(client);
        await collectAccountDeletionAgents(client, waiting.id, randomUUID(), {});
        await client.query('COMMIT');
      } finally { client.release(); }
    }
    const deleting = await principal();
    await addFixtureController(deleting, target);
    const classified = await measuredWork(async measured => {
      await new AccessAdmissionRegistry(measured).strongDeactivateAccountSubject(
        deleting.verified.issuer, deleting.verified.subject);
    });
    inactiveCosts.push(classified.rows);
    samples.push({ size: next, rows: classified.rows, plans: classified.plans.map(plan => ({
      statement: plan.Statement.slice(0, 100), query: plan['Query Text'].slice(0, 300), scans: readScans(plan.Plan),
    })) });
    writeFileSync('.temp/deletion-read-samples.json', JSON.stringify(samples, null, 2));
    const waking = await measuredWork(async measured => {
      await measured.query('SELECT access.queue_account_deletion_candidate($1)', [target]);
    });
    wakeCosts.push(waking.rows);
  }
  console.info('Account deletion reads at 8/64/512', { deletion: inactiveCosts, wake: wakeCosts });
  expect(inactiveCosts[1]).toBe(inactiveCosts[0]);
  expect(inactiveCosts[2]).toBe(inactiveCosts[0]);
  expect(wakeCosts[1]).toBe(wakeCosts[0]);
  expect(wakeCosts[2]).toBe(wakeCosts[0]);
}, 300_000);

test('final principal UPDATE excludes retained mandates and unrelated open erasures', async () => {
  const { persons } = await unaffectedChain();
  for (const size of [8, 64, 512]) {
    const owner = await principal();
    for (const person of persons.slice(0, size)) await addFixtureController(owner, person);
    const cost = await measuredWork(async measured => {
      await new AccessAdmissionRegistry(measured).strongDeactivateAccountSubject(
        owner.verified.issuer, owner.verified.subject);
    });
    const update = cost.plans.filter(plan => /^\s*UPDATE access\.principal SET active = false/.test(plan.Statement));
    expect(update.length).toBeGreaterThan(0);
    expect(update.reduce((sum, plan) => sum + planRows(plan.Plan), 0)).toBeLessThanOrEqual(64);
    expect((await pool.query('SELECT id FROM access.representation WHERE principal_id = $1 AND active AND action = \'agent.control\'', [owner.id])).rows).toHaveLength(size);
    expect(await principalState(owner)).toEqual({ active: false, enforcement_epoch: '1' });
  }
}, 300_000);

test('owned refusal cleans a persisted long closure in bounded statements and releases every fence', async () => {
  const owner = await principal();
  const builder = await principal();
  const persons = [await provision(owner, 'person')];
  for (let index = 1; index < 40; index++) persons.push(await appendPerson(builder, persons.at(-1)!));
  const organization = await provision(builder, 'organization', 'Long closure consent');
  await grantFixtureControllerEdge(pool, { principalId: builder.id,
    representative: persons.at(-1)!, represented: organization });
  await removeController(builder, organization);
  let refusal: unknown;
  const cost = await measuredWork(async measured => {
    try {
      await new AccessAdmissionRegistry(measured).strongDeactivateAccountSubject(owner.verified.issuer, owner.verified.subject);
    } catch (error) { refusal = error; }
  });
  expect(refusal).toBeInstanceOf(AccountHasOwnedAgents);
  expect(refusal).toMatchObject({ agents: [{ id: organization, kind: 'organization', displayName: 'Long closure consent' }],
    hasMore: false, moreCount: 0 });
  const deletes = new Map<number, RecordedPlan[]>();
  for (const plan of cost.plans) {
    if (!/DELETE FROM access\.account_deletion_progress_agent/.test(plan.Statement)) continue;
    const statements = deletes.get(plan.StatementInstance) ?? [];
    statements.push(plan);
    deletes.set(plan.StatementInstance, statements);
  }
  expect(deletes.size).toBeGreaterThanOrEqual(3);
  for (const plans of deletes.values()) {
    const reads = plans.reduce((sum, plan) => sum + planRows(plan.Plan), 0);
    if (reads > 32) console.info('Refusal cleanup scans', JSON.stringify(plans.map(plan => ({
      query: plan['Query Text'].slice(0, 200), scans: readScans(plan.Plan),
    }))));
    expect(reads).toBeLessThanOrEqual(32);
  }
  expect((await pool.query('SELECT operation_id FROM access.account_deletion_progress WHERE principal_id = $1',
    [owner.id])).rows).toEqual([]);
  expect(await principalState(owner)).toEqual({ active: true, enforcement_epoch: '0' });
  for (const person of persons) expect(await subjectState(person)).toEqual({ active: true, controllers: 1 });
}, 60_000);

test('sole-controlled chains at 8, 64 and 512 levels read a fixed budget per persisted step', async () => {
  const builder = await principal();
  const corpus: string[] = [];
  for (let index = 0; index < 584; index++) corpus.push(await provision(builder, 'person'));
  console.info('Long-chain fixture provisioned');
  // Each isolated chain is admitted by joining halves no larger than 256;
  // recovery independence checks both ancestors and descendants at admission.
  const links = [...Array.from({ length: 7 }, (_, index) => index + 1),
    ...Array.from({ length: 63 }, (_, index) => index + 9),
    ...Array.from({ length: 511 }, (_, index) => index + 73).filter(index => index !== 328), 328];
  const setup = await pool.connect();
  try {
    await setup.query('BEGIN');
    for (const index of links) await grantFixtureControllerEdge(setup, {
      principalId: builder.id, representative: corpus[index - 1]!, represented: corpus[index]!,
    });
    console.info('Long-chain fixture linked');
    const anchors = new Set([0, 8, 72]);
    const mandates = (await setup.query<{ id: string; subject_id: string }>(`SELECT id, subject_id
      FROM access.representation WHERE principal_id = $1 AND action = 'agent.control' AND active`, [builder.id])).rows;
    const roots = new Set([...anchors].map(index => corpus[index]!));
    for (const mandate of mandates) {
      if (!roots.has(mandate.subject_id)) await deactivateFixtureController(setup, mandate.id);
    }
    await setup.query('COMMIT');
    console.info('Long-chain fixture committed');
  } catch (error) {
    await setup.query('ROLLBACK');
    throw error;
  } finally { setup.release(); }
  const samples: { size: number; steps: number; maxReads: number; maxInventoryReads: number; totalReads: number; maxBuffers: number }[] = [];
  for (const [offset, size] of [[0, 8], [8, 64], [72, 512]] as const) {
    const owner = await principal();
    const rootPerson = corpus[offset]!;
    await addFixtureController(owner, rootPerson);
    await removeController(builder, rootPerson);
    console.info('Long-chain deletion started', size);
    const reads: number[] = [];
    const inventoryReads: number[] = [];
    const buffers: number[] = [];
    const measured = planPool([], (sql, plans) => {
      if (!sql.includes('account_deletion_classification_step')) return;
      if (reads.length % 64 === 0) console.info('Long-chain classification step', size, reads.length);
      reads.push(plans.reduce((sum, plan) => sum + planRows(plan.Plan), 0));
      inventoryReads.push(plans.reduce((sum, plan) => sum + planRows(plan.Plan, 'account_deletion_progress_agent'), 0));
      if (inventoryReads.at(-1)! > ACCOUNT_DELETION_CLASSIFICATION_COST.subjectsPerStep * 4 + 8) {
        console.info('Classification inventory rescan', JSON.stringify({ size, step: reads.length,
          plans: plans.map(plan => ({ query: plan['Query Text'].slice(0, 200), scans: readScans(plan.Plan) })) }));
      }
      buffers.push(plans.reduce((sum, plan) => sum + planBuffers(plan.Plan), 0));
    });
    try {
      expect(await new AccessAdmissionRegistry(measured).strongDeactivateAccountSubject(
        owner.verified.issuer, owner.verified.subject)).toMatchObject({ enforcementEpoch: '1' });
    } finally { await measured.end(); }
    console.info('Long-chain deletion completed', size);
    expect(reads.length).toBe(size);
    // A step can seek its new candidates and parent, but cannot reread the
    // growing classified inventory. A 512-row rescan fits the broad SQL budget.
    expect(Math.max(...inventoryReads)).toBeLessThanOrEqual(ACCOUNT_DELETION_CLASSIFICATION_COST.subjectsPerStep * 4 + 8);
    expect(Math.max(...reads)).toBeLessThanOrEqual(1024);
    expect(Math.max(...buffers)).toBeLessThanOrEqual(2048);
    expect(reads.reduce((sum, count) => sum + count, 0)).toBeLessThanOrEqual((size + 1) * 1024);
    const inventory = (await pool.query(`SELECT a.agent_id FROM access.account_deletion_progress_agent a
      JOIN access.account_deletion_progress p USING (operation_id)
      WHERE p.principal_id = $1 AND a.effect = 'end'`, [owner.id])).rows;
    expect(inventory).toHaveLength(size);
    for (const person of corpus.slice(offset, offset + size)) {
      expect(await subjectState(person)).toEqual({ active: false, controllers: 0 });
    }
    if (offset + size < corpus.length) expect((await subjectState(corpus[offset + size]!))?.active).toBe(true);
    samples.push({ size, steps: reads.length, maxReads: Math.max(...reads), maxInventoryReads: Math.max(...inventoryReads),
      totalReads: reads.reduce((sum, count) => sum + count, 0), maxBuffers: Math.max(...buffers) });
  }
  console.info('Account deletion chain read budgets', samples);
}, 300_000);

test('initial retirement includes the minimum admitted mandate UUID', async () => {
  const owner = await principal();
  const builder = await principal();
  const person = await provision(builder, 'person');
  const minimum = '00000000-0000-0000-0000-000000000000';
  const fixtures = new Pool({ ...cluster!.connection, max: 1 });
  fixtures.on('connect', client => {
    const query = client.query.bind(client);
    client.query = ((...args: unknown[]) => {
      // Bind the helper's new {id, principal, subject, action} fixture tuple.
      if (Array.isArray(args[1]) && args[1].length === 4 && args[1][1] === owner.id
        && args[1][2] === person && args[1][3] === 'agent.control') args[1] = [minimum, ...args[1].slice(1)];
      return Reflect.apply(query, client, args);
    }) as typeof client.query;
  });
  try { await grantFixtureAuthority(fixtures, {
    scope: 'work:create:root', requireDispatch: true,
    representations: [{ principalId: owner.id, actor: person, action: 'agent.control', lifetime: 'infinity' }],
    grant: { actor: person, action: 'agent.control', lifetime: 'infinity' },
  }); } finally { await fixtures.end(); }
  await removeController(builder, person);
  expect((await pool.query('SELECT representation_id FROM access.live_principal_controller WHERE principal_id = $1',
    [owner.id])).rows).toEqual([{ representation_id: minimum }]);
  expect(await new AccessAdmissionRegistry(pool).strongDeactivateAccountSubject(owner.verified.issuer, owner.verified.subject))
    .toMatchObject({ enforcementEpoch: '1' });
  expect(await subjectState(person)).toEqual({ active: false, controllers: 0 });
  expect((await pool.query('SELECT representation_id FROM access.live_principal_controller WHERE principal_id = $1',
    [owner.id])).rows).toEqual([]);
});
