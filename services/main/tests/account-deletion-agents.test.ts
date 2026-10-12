import { afterAll, beforeAll, expect, test } from 'bun:test';
import { AsyncResource } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { startPostgresCluster, type PostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import type { FusekiClient } from '../src/infrastructure/fuseki.ts';
import {
  AccessAdmissionRegistry, AdmissionUnavailable, engageAccessRecoveryFence,
  releaseAccessRecoveryFence, type VerifiedPrincipal,
} from '../src/modules/access/admission.ts';
import { AccountHasOwnedAgents } from '../src/modules/access/admission.ts';
import { AccessAgentControl } from '../src/modules/access/agent-control.ts';
import { grantFixtureAuthority, grantFixtureControllerEdge, deactivateFixtureController } from '../src/modules/access/fixture-authority.ts';
import { AccessProtectedChanges, APPROVE } from '../src/modules/access/protected-set.ts';
import { ControlConflict } from '../src/modules/access/topology-control.ts';
import { CONTROLLER_CONTINUITY_COST } from '../src/modules/access/controller-continuity.ts';
import { MAX_EDGE_DEGREE, MAX_PATH_EDGES } from '../src/modules/access/topology-schema.ts';
import { AgentProvisioning, agentProvisionDigest } from '../src/modules/agent/provision.ts';

const root = resolve(import.meta.dir, '../../..');
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
let cluster: PostgresCluster | undefined;
let pool: Pool;
let access: AccessAdmissionRegistry;
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
  access = new AccessAdmissionRegistry(pool);
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

async function deletion(owner: Principal, leaveOwnedAgentsStanding = false) {
  return access.strongDeactivateAccountSubject(owner.verified.issuer, owner.verified.subject,
    { leaveOwnedAgentsStanding });
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

async function orphanRows(owner: Principal) {
  return (await pool.query<{ agent_id: string; operation_id: string; deleted_principal_id: string;
    deleted_at: Date }>(
    `SELECT agent_id,operation_id,deleted_principal_id,deleted_at FROM access.account_deletion_orphan_agent
      WHERE deleted_principal_id = $1 ORDER BY agent_id`, [owner.id])).rows;
}

async function fenceRows(owner: Principal) {
  return (await pool.query<{ id: string }>(`SELECT id FROM access.outbox
    WHERE principal_id = $1 AND kind = 'account.deletion_fenced'`, [owner.id])).rows;
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

test('an ending Person control edge requires consent naming the Organization and records its orphan', async () => {
  const owner = await principal();
  const person = await provision(owner, 'person');
  const organization = await provision(owner, 'organization', 'Edge-controlled Organization');
  const edge = await grantFixtureControllerEdge(pool, {
    principalId: owner.id, representative: person, represented: organization,
  });
  expect(await subjectState(organization)).toEqual({ active: true, controllers: 2 });
  let refusal: unknown;
  try { await deletion(owner); } catch (error) { refusal = error; }
  expect(refusal).toBeInstanceOf(AccountHasOwnedAgents);
  if (!(refusal instanceof AccountHasOwnedAgents)) throw refusal;
  expect(refusal.agents).toEqual([{ id: organization, kind: 'organization',
    displayName: 'Edge-controlled Organization' }]);
  expect(await subjectState(person)).toEqual({ active: true, controllers: 1 });
  expect(await principalState(owner)).toEqual({ active: true, enforcement_epoch: '0' });
  expect(await orphanRows(owner)).toEqual([]);
  expect(await deletion(owner, true)).toMatchObject({ enforcementEpoch: '1' });
  expect(await subjectState(person)).toEqual({ active: false, controllers: 0 });
  expect(await subjectState(organization)).toEqual({ active: true, controllers: 0 });
  expect((await orphanRows(owner)).map(row => row.agent_id)).toEqual([organization]);
  // Authority ending invalidates the controller even while the historical edge
  // itself remains active. Replayed deletion cannot manufacture a controller.
  expect((await pool.query('SELECT active FROM access.representation_edge WHERE id = $1',
    [edge])).rows[0]?.active).toBe(true);
  await deletion(owner);
  expect(await subjectState(organization)).toEqual({ active: true, controllers: 0 });
});

test('a live second principal prevents orphaning and an ended Person cannot waive the next removal floor', async () => {
  const owner = await principal();
  const other = await principal();
  const person = await provision(owner, 'person');
  const organization = await provision(owner, 'organization');
  await grantFixtureControllerEdge(pool, {
    principalId: owner.id, representative: person, represented: organization,
  });
  await addFixtureController(other, organization);
  await deletion(owner);
  expect(await subjectState(person)).toEqual({ active: false, controllers: 0 });
  expect(await subjectState(organization)).toEqual({ active: true, controllers: 1 });
  expect(await orphanRows(owner)).toEqual([]);
  await expect(removeController(other, organization)).rejects.toBeInstanceOf(ControlConflict);
  expect(await subjectState(organization)).toEqual({ active: true, controllers: 1 });
});

test('an active different Person edge still counts after the deleting Person ends', async () => {
  const owner = await principal();
  const other = await principal();
  const person = await provision(owner, 'person');
  const otherPerson = await provision(other, 'person');
  const organization = await provision(owner, 'organization');
  for (const representative of [person, otherPerson]) await grantFixtureControllerEdge(pool, {
    principalId: owner.id, representative, represented: organization,
  });
  await deletion(owner);
  expect(await subjectState(person)).toEqual({ active: false, controllers: 0 });
  expect(await subjectState(otherPerson)).toEqual({ active: true, controllers: 1 });
  expect(await subjectState(organization)).toEqual({ active: true, controllers: 1 });
  expect(await orphanRows(owner)).toEqual([]);
  expect(await principalState(other)).toEqual({ active: true, enforcement_epoch: '0' });
});

test('an Organization reached only through an ending Person is included in deletion classification', async () => {
  const owner = await principal();
  const original = await principal();
  const person = await provision(owner, 'person');
  const organization = await provision(original, 'organization', 'Indirect Organization');
  await grantFixtureControllerEdge(pool, {
    principalId: original.id, representative: person, represented: organization,
  });
  await removeController(original, organization);
  await expect(deletion(owner)).rejects.toMatchObject({ code: 'account_has_owned_agents',
    agents: [{ id: organization, kind: 'organization', displayName: 'Indirect Organization' }] });
  await deletion(owner, true);
  expect(await subjectState(person)).toEqual({ active: false, controllers: 0 });
  expect(await subjectState(organization)).toEqual({ active: true, controllers: 0 });
  expect((await orphanRows(owner)).map(row => row.agent_id)).toEqual([organization]);
});

test('two control-edge levels propagate Person endings before classifying an indirect Organization', async () => {
  const owner = await principal();
  const original = await principal();
  const person = await provision(owner, 'person');
  const intermediate = await provision(original, 'person');
  const organization = await provision(original, 'organization', 'Second-level Organization');
  await grantFixtureControllerEdge(pool, {
    principalId: original.id, representative: person, represented: intermediate,
  });
  await grantFixtureControllerEdge(pool, {
    principalId: original.id, representative: intermediate, represented: organization,
  });
  await removeController(original, intermediate);
  await removeController(original, organization);
  await expect(deletion(owner)).rejects.toMatchObject({ code: 'account_has_owned_agents',
    agents: [{ id: organization, kind: 'organization', displayName: 'Second-level Organization' }] });
  expect(await subjectState(intermediate)).toEqual({ active: true, controllers: 1 });
  await deletion(owner, true);
  for (const ended of [person, intermediate]) {
    expect(await subjectState(ended)).toEqual({ active: false, controllers: 0 });
  }
  expect(await subjectState(organization)).toEqual({ active: true, controllers: 0 });
  expect((await orphanRows(owner)).map(row => row.agent_id)).toEqual([organization]);
});

async function personChain(owner: Principal, edges: number) {
  const persons = [await provision(owner, 'person')];
  for (let index = 1; index < edges; index++) {
    const original = await principal();
    const person = await provision(original, 'person');
    await grantFixtureControllerEdge(pool, {
      principalId: original.id, representative: persons.at(-1)!, represented: person,
    });
    await removeController(original, person);
    persons.push(person);
  }
  return persons;
}

for (const edges of [3, MAX_PATH_EDGES, MAX_PATH_EDGES + 1]) {
  test(`a ${edges}-edge control path names its Organization and completes with consent`, async () => {
    const owner = await principal();
    const original = await principal();
    const persons = await personChain(owner, edges);
    const organization = await provision(original, 'organization', 'Indirect Organization');
    await grantFixtureControllerEdge(pool, {
      principalId: original.id, representative: persons.at(-1)!, represented: organization,
    });
    await removeController(original, organization);
    await expect(deletion(owner)).rejects.toMatchObject({ code: 'account_has_owned_agents',
      agents: [{ id: organization, kind: 'organization', displayName: 'Indirect Organization' }],
      hasMore: false, moreCount: 0 });
    expect(await principalState(owner)).toEqual({ active: true, enforcement_epoch: '0' });
    expect(await fenceRows(owner)).toEqual([]);
    for (const person of persons) expect(await subjectState(person)).toEqual({ active: true, controllers: 1 });
    await deletion(owner, true);
    for (const person of persons) expect(await subjectState(person)).toEqual({ active: false, controllers: 0 });
    expect(await subjectState(organization)).toEqual({ active: true, controllers: 0 });
    expect((await orphanRows(owner)).map(row => row.agent_id)).toEqual([organization]);
  });
}

test('40 owned Organizations at depth three retain the bounded preview and all consented effects', async () => {
  const owner = await principal();
  const persons = await personChain(owner, 2);
  const original = await principal();
  const organizations: string[] = [];
  const endedPersons = [...persons];
  for (let branch = 0; branch < Math.ceil(40 / MAX_EDGE_DEGREE); branch++) {
    const branchOwner = await principal();
    const person = await provision(branchOwner, 'person');
    await grantFixtureControllerEdge(pool, {
      principalId: original.id, representative: persons.at(-1)!, represented: person,
    });
    await removeController(branchOwner, person);
    endedPersons.push(person);
    for (let index = 0; index < MAX_EDGE_DEGREE && organizations.length < 40; index++) {
      const organization = await provision(original, 'organization');
      await grantFixtureControllerEdge(pool, {
        principalId: original.id, representative: person, represented: organization,
      });
      await removeController(original, organization);
      organizations.push(organization);
    }
  }
  await expect(deletion(owner)).rejects.toMatchObject({ code: 'account_has_owned_agents',
    agents: expect.arrayContaining(organizations.slice().sort().slice(0, 16).map(id =>
      ({ id, kind: 'organization', displayName: 'Deletion fixture' }))), hasMore: true, moreCount: 24 });
  await deletion(owner, true);
  for (const person of endedPersons) expect(await subjectState(person)).toEqual({ active: false, controllers: 0 });
  for (const organization of organizations) expect(await subjectState(organization)).toEqual({ active: true, controllers: 0 });
  expect((await orphanRows(owner)).map(row => row.agent_id)).toEqual(organizations.sort());
});

test('owned-Agent refusal rolls back Person termination, principal fence and all orphan markers', async () => {
  const owner = await principal();
  const person = await provision(owner, 'person');
  const organization = await provision(owner, 'organization', 'Person Agent');
  const service = await provision(owner, 'service', 'Automation');
  let refusal: unknown;
  try { await deletion(owner); } catch (error) { refusal = error; }
  expect(refusal).toBeInstanceOf(AccountHasOwnedAgents);
  if (!(refusal instanceof AccountHasOwnedAgents)) throw refusal;
  expect(refusal.agents).toEqual(expect.arrayContaining([
    { id: organization, kind: 'organization', displayName: 'Person Agent' },
    { id: service, kind: 'service', displayName: 'Automation' },
  ]));
  expect(refusal.agents).toHaveLength(2);
  expect(refusal.hasMore).toBe(false);
  expect(refusal.moreCount).toBe(0);
  expect(await principalState(owner)).toEqual({ active: true, enforcement_epoch: '0' });
  for (const subject of [person, organization, service]) {
    expect(await subjectState(subject)).toEqual({ active: true, controllers: 1 });
  }
  expect(await fenceRows(owner)).toEqual([]);
  expect(await orphanRows(owner)).toEqual([]);
});

test('recovery hold refuses both deletion variants without partially ending or orphaning Agents', async () => {
  const owner = await principal();
  const person = await provision(owner, 'person');
  const organization = await provision(owner, 'organization');
  const generation = await engageAccessRecoveryFence(pool);
  try {
    await expect(deletion(owner)).rejects.toBeInstanceOf(AdmissionUnavailable);
    await expect(deletion(owner, true)).rejects.toBeInstanceOf(AdmissionUnavailable);
    expect(await principalState(owner)).toEqual({ active: true, enforcement_epoch: '0' });
    expect(await subjectState(person)).toEqual({ active: true, controllers: 1 });
    expect(await subjectState(organization)).toEqual({ active: true, controllers: 1 });
    expect(await fenceRows(owner)).toEqual([]);
    expect(await orphanRows(owner)).toEqual([]);
  } finally { await releaseAccessRecoveryFence(pool, generation); }
  expect(await deletion(owner, true)).toMatchObject({ enforcementEpoch: '1' });
});

test('a controller inventory beyond 256 is a bounded refusal followed by complete consented deletion', async () => {
  const owner = await principal();
  const person = await provision(owner, 'person');
  const organizations: string[] = [];
  for (let index = 0; index < 257; index++) {
    organizations.push(await provision(owner, 'organization', `Organization ${index}`));
  }
  const original = await principal();
  const intermediate = await provision(original, 'person');
  // The shortcut makes shortest-path depth unsuitable for effect ordering.
  for (const [representative, represented] of [
    [person, intermediate], [person, organizations[0]!], [intermediate, organizations[0]!],
  ] as const) await grantFixtureControllerEdge(pool, {
    principalId: original.id, representative, represented,
  });
  await removeController(original, intermediate);
  let refusal: unknown;
  try { await deletion(owner); } catch (error) { refusal = error; }
  expect(refusal).toBeInstanceOf(AccountHasOwnedAgents);
  if (!(refusal instanceof AccountHasOwnedAgents)) throw refusal;
  expect(refusal.agents).toHaveLength(16);
  expect(refusal.hasMore).toBe(true);
  expect(refusal.moreCount).toBe(241);
  for (const agent of refusal.agents) expect(organizations).toContain(agent.id);
  expect(await principalState(owner)).toEqual({ active: true, enforcement_epoch: '0' });
  if (!cluster) throw new Error('Postgres fixture unavailable');
  const interrupted = new Pool({ ...cluster.connection, max: 1 });
  const batchSizes: number[] = [];
  let batchCommitted = false;
  const interruption = new Error('lost connection after committed deletion step');
  interrupted.on('connect', client => {
    const query = client.query.bind(client);
    client.query = ((...args: unknown[]) => Reflect.apply(query, client, args)
      .then((result: { rowCount: number | null }) => {
        const sql = args[0];
        if (typeof sql === 'string' && sql.includes('CREATE TEMP TABLE account_deletion_batch')) {
          batchSizes.push(result.rowCount ?? 0);
        }
        if (sql === 'COMMIT' && batchSizes.length > 0 && !batchCommitted) {
          batchCommitted = true;
          throw interruption;
        }
        return result;
      })) as typeof client.query;
  });
  try {
    await expect(new AccessAdmissionRegistry(interrupted).strongDeactivateAccountSubject(
      owner.verified.issuer, owner.verified.subject, { leaveOwnedAgentsStanding: true }))
      .rejects.toBe(interruption);
  } finally { await interrupted.end(); }
  expect(batchSizes).toEqual([CONTROLLER_CONTINUITY_COST.maxSubjects]);
  expect(await principalState(owner)).toEqual({ active: false, enforcement_epoch: '1' });
  expect(await fenceRows(owner)).toEqual([]);
  expect(await subjectState(person)).toEqual({ active: true, controllers: 0 });
  expect(await subjectState(intermediate)).toEqual({ active: true, controllers: 1 });
  const progress = (await pool.query<{ operation_id: string; completed: boolean }>(`SELECT operation_id,completed
    FROM access.account_deletion_progress WHERE principal_id = $1`, [owner.id])).rows[0]!;
  expect(progress.completed).toBe(false);
  expect((await orphanRows(owner)).length).toBeGreaterThan(0);
  // A held recovery fence stops further steps; consent and operation survive.
  const generation = await engageAccessRecoveryFence(pool);
  try { await expect(deletion(owner)).rejects.toBeInstanceOf(AdmissionUnavailable); }
  finally { await releaseAccessRecoveryFence(pool, generation); }
  // An ordinary controller change cannot invalidate the persisted inventory.
  const replacement = await principal();
  await expect(addFixtureController(replacement, organizations[0]!)).rejects.toMatchObject({ code: '54000' });
  expect(await deletion(owner)).toMatchObject({ enforcementEpoch: '1' });
  expect((await fenceRows(owner))[0]?.id).toBe(progress.operation_id);
  expect((await orphanRows(owner)).every(row => row.operation_id === progress.operation_id)).toBe(true);
  expect(await subjectState(person)).toEqual({ active: false, controllers: 0 });
  expect(await subjectState(intermediate)).toEqual({ active: false, controllers: 0 });
  const standing = await pool.query<{ count: string }>(`SELECT count(*) AS count
    FROM access.authority_subject WHERE id = ANY($1::text[]) AND active
      AND access.agent_controller_count(id) = 0`, [organizations]);
  expect(standing.rows[0]?.count).toBe('257');
  const orphans = await orphanRows(owner);
  expect(orphans.map(row => row.agent_id).sort()).toEqual(organizations.sort());
  expect(new Set(orphans.map(row => row.operation_id))).toEqual(new Set([(await fenceRows(owner))[0]!.id]));
}, 60_000);

test('lost-response retry keeps one deletion fence and the original orphan operation', async () => {
  const owner = await principal();
  await provision(owner, 'person');
  const organization = await provision(owner, 'organization');
  const first = await deletion(owner, true);
  const markers = await orphanRows(owner);
  expect(markers).toHaveLength(1);
  expect(markers[0]?.agent_id).toBe(organization);
  expect(await deletion(owner)).toEqual(first);
  expect(await deletion(owner, true)).toEqual(first);
  expect(await orphanRows(owner)).toEqual(markers);
  expect(await fenceRows(owner)).toHaveLength(1);
  expect(await principalState(owner)).toEqual({ active: false, enforcement_epoch: '1' });
});

test('approved independent recovery reattaches an orphan and restores ordinary controller continuity', async () => {
  const owner = await principal();
  const claimant = await principal();
  const guardian = await principal();
  const person = await provision(owner, 'person');
  const organization = await provision(owner, 'organization');
  await grantFixtureControllerEdge(pool, {
    principalId: owner.id, representative: person, represented: organization,
  });
  const recoverySubject = await provision(guardian, 'person');
  const configured = await control.configure(owner.verified, receipt(), {
    subjectId: organization, recoverySubject, recoveryApprovals: 1,
    recoveryDelaySeconds: 0, minControllers: 1, maxControllers: 2,
  });
  await grantFixtureAuthority(pool, {
    scope: 'work:create:root', requireDispatch: true,
    representations: [{ principalId: guardian.id, actor: recoverySubject,
      action: APPROVE, lifetime: 'infinity' }],
    grant: { actor: recoverySubject, action: APPROVE, lifetime: 'infinity' },
  });
  await deletion(owner, true);
  expect(await subjectState(person)).toEqual({ active: false, controllers: 0 });
  expect(await subjectState(organization)).toEqual({ active: true, controllers: 0 });
  expect(await orphanRows(owner)).toHaveLength(1);
  const recoveryId = randomUUID();
  const request = await control.requestRecovery(claimant.verified, receipt(), {
    recoveryId, subjectId: organization, reason: 'last-controller-lost',
    expectedControlGeneration: configured.generation,
  });
  const protectedChanges = new AccessProtectedChanges(pool);
  await expect(protectedChanges.activate(claimant.verified, receipt(), recoveryId))
    .rejects.toThrow();
  expect(await orphanRows(owner)).toHaveLength(1);
  await protectedChanges.approve(guardian.verified, receipt(), {
    proposalId: recoveryId, approverSubject: recoverySubject, changeDigest: request.changeDigest,
  });
  const hold = await engageAccessRecoveryFence(pool);
  try {
    await expect(protectedChanges.activate(claimant.verified, receipt(), recoveryId)).rejects.toThrow();
    expect(await subjectState(organization)).toEqual({ active: true, controllers: 0 });
    expect(await orphanRows(owner)).toHaveLength(1);
  } finally { await releaseAccessRecoveryFence(pool, hold); }
  expect(await protectedChanges.activate(claimant.verified, receipt(), recoveryId))
    .toMatchObject({ status: 'activated' });
  expect(await orphanRows(owner)).toEqual([]);
  expect(await subjectState(organization)).toEqual({ active: true, controllers: 1 });
  const mandate = (await pool.query<{ id: string; generation: string }>(`SELECT id,generation
    FROM access.representation WHERE subject_id = $1 AND principal_id = $2 AND active`,
  [organization, claimant.id])).rows[0]!;
  await expect(control.removeController(claimant.verified, receipt(), {
    subjectId: organization, representationId: mandate.id, expectedGeneration: mandate.generation,
  })).rejects.toBeInstanceOf(ControlConflict);
  await expect(deactivateFixtureController(pool, mandate.id)).rejects.toMatchObject({ code: '23514' });
  expect(await subjectState(organization)).toEqual({ active: true, controllers: 1 });
});

test('ordinary fixture controller insertion does not clear intentional orphan state', async () => {
  const owner = await principal();
  const replacement = await principal();
  const organization = await provision(owner, 'organization');
  await deletion(owner, true);
  const marker = await orphanRows(owner);
  await addFixtureController(replacement, organization);
  expect(await subjectState(organization)).toEqual({ active: true, controllers: 1 });
  expect(await orphanRows(owner)).toEqual(marker);
});

test('concurrent account deletion and ordinary removal preserve the surviving controller', async () => {
  const owner = await principal();
  const other = await principal();
  const organization = await provision(owner, 'organization');
  const otherMandate = await addFixtureController(other, organization);
  const contexts = [new AsyncResource('account-deletion'), new AsyncResource('controller-removal')];
  const results = await Promise.allSettled([
    contexts[0]!.runInAsyncScope(() => deletion(owner)),
    contexts[1]!.runInAsyncScope(() => control.removeController(other.verified, receipt(), {
      subjectId: organization, representationId: otherMandate.id,
      expectedGeneration: otherMandate.generation,
    })),
  ]);
  for (const context of contexts) context.emitDestroy();
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  const failure = results.find(result => result.status === 'rejected');
  expect(failure?.status === 'rejected'
    && (failure.reason instanceof AccountHasOwnedAgents || failure.reason instanceof ControlConflict)).toBe(true);
  expect(await subjectState(organization)).toEqual({ active: true, controllers: 1 });
  expect(await orphanRows(owner)).toEqual([]);
});

test('indirect Organization controller removal serializes with account deletion', async () => {
  const owner = await principal();
  const other = await principal();
  const person = await provision(owner, 'person');
  const organization = await provision(other, 'organization');
  await grantFixtureControllerEdge(pool, {
    principalId: other.id, representative: person, represented: organization,
  });
  const contexts = [new AsyncResource('account-deletion'), new AsyncResource('controller-removal')];
  const results = await Promise.allSettled([
    contexts[0]!.runInAsyncScope(() => deletion(owner)),
    contexts[1]!.runInAsyncScope(() => removeController(other, organization)),
  ]);
  for (const context of contexts) context.emitDestroy();
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  const failure = results.find(result => result.status === 'rejected');
  expect(failure?.status === 'rejected'
    && (failure.reason instanceof AccountHasOwnedAgents || failure.reason instanceof ControlConflict)).toBe(true);
  expect(await subjectState(organization)).toEqual({ active: true, controllers: 1 });
  expect(await orphanRows(owner)).toEqual([]);
});

test('deletion without owned Agents adds at most one bounded read to the previous query budget', async () => {
  if (!cluster) throw new Error('Postgres fixture unavailable');
  const empty = await principal();
  const personOnly = await principal();
  await provision(personOnly, 'person');
  const measured = new Pool({ ...cluster.connection, max: 1 });
  const statements: string[] = [];
  let returnedRows = 0;
  measured.on('connect', client => {
    const query = client.query.bind(client);
    client.query = ((...args: unknown[]) => {
      const sql = args[0];
      if (typeof sql === 'string') statements.push(sql);
      return Reflect.apply(query, client, args).then((result: { rowCount: number | null }) => {
        returnedRows += result.rowCount ?? 0;
        return result;
      });
    }) as typeof client.query;
  });
  try {
    for (const fixture of [
      { owner: empty, statements: 21, reads: 8, rows: 10 },
      { owner: personOnly, statements: 23, reads: 10, rows: 13 },
    ]) {
      statements.length = 0;
      returnedRows = 0;
      expect(await new AccessAdmissionRegistry(measured).strongDeactivateAccountSubject(
        fixture.owner.verified.issuer, fixture.owner.verified.subject))
        .toMatchObject({ enforcementEpoch: '1' });
      // The prior implementation added one lock and continuity read per Person.
      expect(statements.length).toBeLessThanOrEqual(fixture.statements + 1);
      expect(statements.filter(sql => /^\s*(SELECT|WITH)\b/i.test(sql)).length)
        .toBeLessThanOrEqual(fixture.reads + 1);
      expect(returnedRows).toBeLessThanOrEqual(fixture.rows + 1);
      if (fixture.owner === empty) {
        expect(statements.some(sql => /account_deletion_orphan_agent/i.test(sql))).toBe(false);
      }
      expect(await orphanRows(fixture.owner)).toEqual([]);
    }
  } finally { await measured.end(); }
});
