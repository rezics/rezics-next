import { afterAll, beforeAll, expect, test } from 'bun:test';
import { AsyncResource } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { boundedPool } from '../src/infrastructure/pg-pool.ts';
import type { FusekiClient } from '../src/infrastructure/fuseki.ts';
import {
  AccessAdmissionRegistry,
  AdmissionConflict,
  AdmissionDenied,
  type AdmissionRequest,
  type VerifiedPrincipal,
} from '../src/modules/access/admission.ts';
import { AccessAgentControl } from '../src/modules/access/agent-control.ts';
import { AccessRevocations } from '../src/modules/access/revocation-requests.ts';
import { baselineMemberProof } from '../src/modules/access/baseline.ts';
import { WorkMaintainers } from '../src/modules/work/maintainers.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { principalControllerSubjects } from '../src/modules/access/controller-continuity.ts';

const root = resolve(import.meta.dir, '../../..');
const state = join(root, '.temp', `access-controller-${randomUUID()}`);
const data = join(state, 'pgdata');
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const native = () => `https://rezics.com/id/${randomUUID()}`;
let pool: Pool;
let single: Pool;
let started = false;

beforeAll(async () => {
  mkdirSync(state, { recursive: true, mode: 0o700 });
  execFileSync('initdb', ['-D', data, '-A', 'trust', '--no-instructions'], {
    cwd: state,
    stdio: 'pipe',
  });
  const port = await new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string')
        return reject(new Error('missing PostgreSQL port'));
      server.close(() => resolvePort(address.port));
    });
  });
  execFileSync(
    'pg_ctl',
    [
      '-D',
      data,
      '-l',
      join(state, 'postgres.log'),
      '-o',
      `-h 127.0.0.1 -p ${port} -k /tmp`,
      '-w',
      'start',
    ],
    { cwd: state, stdio: 'pipe' },
  );
  started = true;
  const config = {
    host: '127.0.0.1',
    port,
    user: process.env.USER,
    database: 'postgres',
    connectionTimeoutMillis: 1000,
  };
  pool = new Pool({ ...config, max: 4 });
  single = boundedPool({ ...config, max: 1 });
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
  } finally {
    client.release();
  }
}, 60_000);

afterAll(async () => {
  await single?.end();
  await pool?.end();
  if (started)
    execFileSync('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop'], {
      cwd: state,
      stdio: 'pipe',
    });
});

async function principal() {
  const id = randomUUID();
  const verified: VerifiedPrincipal = {
    issuer: 'https://account.rezics.test',
    subject: randomUUID(),
    emailVerified: true,
  };
  verified.currentAssertion = async () => verified;
  await pool.query(
    'INSERT INTO access.principal (id,account_issuer,account_subject) VALUES ($1,$2,$3)',
    [id, verified.issuer, verified.subject],
  );
  return { id, verified };
}

async function agent(controllers: Awaited<ReturnType<typeof principal>>[]) {
  const actor = native();
  await pool.query("INSERT INTO access.authority_subject (id,kind) VALUES ($1,'agent')", [actor]);
  const mandates: { id: string; generation: string }[] = [];
  for (const controller of controllers) {
    const row = (
      await pool.query<{ id: string; generation: string }>(
        `INSERT INTO access.representation
      (id,principal_id,subject_id,action,valid_until) VALUES ($1,$2,$3,'agent.control','infinity') RETURNING id,generation`,
        [randomUUID(), controller.id, actor],
      )
    ).rows[0]!;
    mandates.push(row);
  }
  const provision = randomUUID();
  await pool.query(
    `INSERT INTO access.agent_provision (id,principal_id,idempotency_key,request_digest,
    agent_id,agent_kind,display_name,principal_epoch,state,graph_data_epoch,graph_sequence,representation_id)
    VALUES ($1::uuid,$2,$1::text,$3,$4,'person','Controller fixture',0,'active','fixture',1,$5)`,
    [provision, controllers[0]!.id, digest(provision), actor, mandates[0]!.id],
  );
  return { actor, mandates, provision };
}

async function creation(
  owner: Awaited<ReturnType<typeof principal>>,
  actor: string,
  action: string,
  scope: string,
) {
  const id = randomUUID();
  const receipt = `urn:rezics:receipt:${digest(id)}`;
  const requestDigest = digest(`${id}:intent`);
  await pool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [
    scope,
  ]);
  await pool.query(
    `INSERT INTO access.admission (id,principal_id,acting_subject,scope_id,action,
    idempotency_key,request_digest,authority_epoch,expires_at,state,graph_receipt,graph_outcome,
    graph_data_epoch,graph_sequence,sealed_at) VALUES ($1::uuid,$2,$3,$4,$5,$1::text,$6,0,now(),'sealed',$7,'succeeded','fixture','1',now())`,
    [id, owner.id, actor, scope, action, requestDigest, receipt],
  );
  return { id, receipt, requestDigest };
}

/** Graph facts are fixed at the external owner boundary; SQL uses all real
 * migrations, row/advisory locks, admissions, revocations and owner receipts.
 * These tests qualify Access behavior, not Fuseki query plans or graph writes. */
async function resources(owner: Awaited<ReturnType<typeof principal>>, actor: string) {
  const work = native(),
    mainVersion = native(),
    definition = native(),
    space = native();
  const workCreation = await creation(owner, actor, 'work.create', 'work:create:root');
  const definitionCreation = await creation(
    owner,
    actor,
    'semantic.change',
    'semantic:create:root',
  );
  const spaceCreation = await creation(owner, actor, 'space.create', 'space:create:root');
  await pool.query(
    'INSERT INTO access.work_maintainer_set (work,main_version,creation_admission) VALUES ($1,$2,$3)',
    [work, mainVersion, workCreation.id],
  );
  await pool.query('INSERT INTO access.work_maintainer (work,agent) VALUES ($1,$2)', [work, actor]);
  const queries: string[] = [];
  const graph = {
    query: async (query: string) => {
      queries.push(query);
      if (query.includes('SELECT DISTINCT ?work')) return { results: { bindings: [] } };
      if (query.includes('SELECT ?admission ?receipt ?digest')) {
        const receipt = query.includes('rv:SemanticDefinition')
          ? definitionCreation
          : spaceCreation;
        return {
          results: {
            bindings: [
              {
                admission: { value: receipt.id },
                receipt: { value: receipt.receipt },
                digest: { value: receipt.requestDigest },
              },
            ],
          },
        };
      }
      return { boolean: true };
    },
  } as unknown as Pick<FusekiClient, 'query'>;
  const registry = new AccessAdmissionRegistry(single);
  registry.configureBaseline(graph);
  const requests = (who: typeof owner) =>
    [
      { action: 'work.edit', scope: `work:edit:${work}` },
      { action: 'semantic.change', scope: `semantic:edit:${definition}` },
      { action: 'zone.edit', scope: `zone:edit:${space}` },
    ].map(
      (target) =>
        ({
          ...target,
          principal: who.verified,
          actingSubject: actor,
          idempotencyKey: randomUUID(),
          requestDigest: digest(randomUUID()),
        }) satisfies AdmissionRequest,
    );
  return { registry, requests, work, mainVersion, definition, space, graph, queries };
}

function receipt() {
  return { idempotencyKey: randomUUID(), requestDigest: digest(randomUUID()) };
}

async function removeController(
  actor: Awaited<ReturnType<typeof principal>>,
  subject: string,
  mandate: { id: string; generation: string },
) {
  return new AccessAgentControl(pool).removeController(actor.verified, receipt(), {
    subjectId: subject,
    representationId: mandate.id,
    expectedGeneration: mandate.generation,
  });
}

test('current controller manages Work, Definition and Space; creation principal loses new and saved admissions', async () => {
  const old = await principal(),
    next = await principal();
  const control = await agent([old, next]);
  const f = await resources(old, control.actor);
  const saved = [];
  for (const request of f.requests(old)) saved.push(await f.registry.register(request));
  await removeController(next, control.actor, control.mandates[0]!);
  for (const request of f.requests(next)) {
    const admission = await f.registry.register(request);
    expect(admission.dispatchEligible).toBe(true);
    expect(
      (await f.registry.claim(admission.id, admission.requestDigest, next.verified)).state,
    ).toBe('claimed');
  }
  for (const request of f.requests(old))
    await expect(f.registry.register(request)).rejects.toBeInstanceOf(AdmissionDenied);
  for (const admission of saved)
    await expect(
      f.registry.claim(admission.id, admission.requestDigest, old.verified),
    ).rejects.toBeInstanceOf(AdmissionDenied);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    expect((await baselineMemberProof(client, next.id, control.actor))?.provision_id).toBe(
      control.provision,
    );
    expect(await baselineMemberProof(client, old.id, control.actor)).toBeNull();
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
  await f.registry.strongDeactivatePrincipal(old.id, '0');
  for (const request of f.requests(next)) {
    expect((await f.registry.register(request)).dispatchEligible).toBe(true);
  }
});

test('concurrent principal deactivation and revocation of the last two controllers leave exactly one live controller', async () => {
  const first = await principal(),
    second = await principal(),
    revoker = await principal();
  const control = await agent([first, second]);
  await pool.query(
    `INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
    VALUES ($1,$2,$3,'access.revoke',clock_timestamp() + interval '1 hour')`,
    [randomUUID(), revoker.id, control.actor],
  );
  // Separate root async contexts model independent HTTP requests.
  const contexts = [new AsyncResource('deactivation'), new AsyncResource('revocation')];
  const results = await Promise.allSettled([
    contexts[0]!.runInAsyncScope(() =>
      new AccessAdmissionRegistry(pool).strongDeactivatePrincipal(first.id, '0'),
    ),
    contexts[1]!.runInAsyncScope(() =>
      new AccessRevocations(pool).revoke(
        revoker.verified,
        {
          revocationId: randomUUID(),
          issuerSubject: control.actor,
          mode: 'strong',
          scopeId: 'work:create:root',
          expectedAuthorityEpoch: '0',
          target: {
            kind: 'representation',
            id: control.mandates[1]!.id,
            expectedGeneration: control.mandates[1]!.generation,
          },
        },
        receipt(),
      ),
    ),
  ]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  const failure = results.find((result) => result.status === 'rejected');
  expect(failure?.status === 'rejected' ? failure.reason.message : '').toContain('continuity');
  expect(
    (await pool.query('SELECT access.agent_controller_count($1) AS n', [control.actor])).rows[0]!.n,
  ).toBe(1);
});

test('sole-controller deactivation and Account deletion are refused; handover permits the old principal fence', async () => {
  const old = await principal(),
    next = await principal();
  const control = await agent([old]);
  const registry = new AccessAdmissionRegistry(pool);
  await expect(registry.strongDeactivatePrincipal(old.id, '0')).rejects.toBeInstanceOf(
    AdmissionConflict,
  );
  await expect(
    registry.strongDeactivateAccountSubject(old.verified.issuer, old.verified.subject),
  ).rejects.toBeInstanceOf(AdmissionConflict);
  expect(
    (
      await pool.query('SELECT active,enforcement_epoch FROM access.principal WHERE id = $1', [
        old.id,
      ])
    ).rows[0],
  ).toMatchObject({ active: true, enforcement_epoch: '0' });
  expect(
    (
      await pool.query(
        "SELECT id FROM access.outbox WHERE principal_id = $1 AND kind = 'account.deletion_fenced'",
        [old.id],
      )
    ).rows,
  ).toHaveLength(0);
  await pool.query(
    `INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
    VALUES ($1,$2,$3,'agent.control','infinity')`,
    [randomUUID(), next.id, control.actor],
  );
  expect(await registry.strongDeactivatePrincipal(old.id, '0')).toMatchObject({
    enforcementEpoch: '1',
  });
  expect(await registry.strongDeactivatePrincipal(old.id, '0')).toMatchObject({
    enforcementEpoch: '1',
  });
});

test('owner authority probes reuse a one-client pool and roll back the callback with the enclosing transaction', async () => {
  const owner = await principal();
  const control = await agent([owner]);
  const f = await resources(owner, control.actor);
  const request = f.requests(owner)[1]!;
  const query = f.graph.query.bind(f.graph);
  const graph = {
    query: async (
      text: string,
      ...args: Parameters<typeof query> extends [string, ...infer Rest] ? Rest : never
    ) =>
      text.includes('SELECT DISTINCT ?work')
        ? { results: { bindings: [{ work: { value: f.work } }] } }
        : query(text, ...args),
  };
  f.registry.configureBaseline(graph as Pick<FusekiClient, 'query'>);
  await f.registry.assertAuthority(request);
  const marker = randomUUID();
  await expect(
    f.registry.withOwnerAuthority(request, async (client) => {
      await client.query("INSERT INTO access.authority_subject (id,kind) VALUES ($1,'agent')", [
        `https://rezics.com/id/${marker}`,
      ]);
      throw new Error('owner effect fails');
    }),
  ).rejects.toThrow('owner effect fails');
  expect(
    (
      await pool.query('SELECT id FROM access.authority_subject WHERE id = $1', [
        `https://rezics.com/id/${marker}`,
      ])
    ).rows,
  ).toHaveLength(0);
  // A real editorial permit exercises both registration and claim while the
  // same one-client pool is already held by admission.
  const proposer = await principal();
  const proposingAgent = await agent([proposer]);
  const proposal = randomUUID(),
    application = randomUUID();
  const target = { resource: f.definition, context: 'fixture', work: f.work };
  await pool.query(
    `INSERT INTO access.editorial_proposal (id,kind,target,resource,context,work,
    proposer_principal,proposer_agent,proposer_key,proposer_controllers)
    VALUES ($1,'semantic-change',$2,$3,'fixture',$4,$5,$6,$7,$8)`,
    [
      proposal,
      target,
      f.definition,
      f.work,
      proposer.id,
      proposingAgent.actor,
      digest(`${proposal}\0${proposer.id}`),
      [proposer.id],
    ],
  );
  await pool.query(
    `INSERT INTO access.editorial_revision (proposal,n,candidate,candidate_digest,
    before_state,base_heads,evidence,owner_command,author_agent)
    VALUES ($1,1,'{}',$2,'{}',$3,'[]',$4,$5)`,
    [
      proposal,
      digest('{}'),
      JSON.stringify([{ component: f.definition, head: native() }]),
      { action: request.action, scope: request.scope, digest: request.requestDigest },
      proposingAgent.actor,
    ],
  );
  await pool.query(
    `INSERT INTO access.editorial_application (id,proposal,revision,principal,actor,
    operation_key,command_key,command_digest,approve,required,message)
    VALUES ($1,$2,1,$3,$4,$5,$6,$7,true,1,'')`,
    [
      application,
      proposal,
      owner.id,
      control.actor,
      request.idempotencyKey,
      randomUUID(),
      request.requestDigest,
    ],
  );
  const reviewed = await f.registry.register({ ...request, editorialPermit: application });
  expect((await f.registry.claim(reviewed.id, reviewed.requestDigest, owner.verified)).state).toBe(
    'claimed',
  );
  expect(single.totalCount).toBe(1);
});

test('stewardship transfer admits the current Work maintainer and refuses a target with no controller', async () => {
  const old = await principal(),
    next = await principal();
  const source = await agent([old]),
    target = await agent([next]);
  const f = await resources(old, source.actor);
  const savedRequest = f.requests(old)[0]!;
  const saved = await f.registry.register(savedRequest);
  const maintainers = new WorkMaintainers(pool, {
    fuseki: f.graph,
    lineage: { dataEpoch: 'fixture', routingEpoch: 'fixture' },
  } as WorkActivationEnvironment);
  const abandoned = native();
  await pool.query("INSERT INTO access.authority_subject (id,kind) VALUES ($1,'agent')", [
    abandoned,
  ]);
  await expect(
    maintainers.change(
      old.verified,
      {
        work: f.work,
        actingSubject: source.actor,
        target: abandoned,
        action: 'transfer',
        expectedGeneration: '0',
      },
      randomUUID(),
    ),
  ).rejects.toBeInstanceOf(AdmissionConflict);
  expect(
    await maintainers.change(
      old.verified,
      {
        work: f.work,
        actingSubject: source.actor,
        target: target.actor,
        action: 'transfer',
        expectedGeneration: '0',
      },
      randomUUID(),
    ),
  ).toMatchObject({
    generation: '1',
    maintainers: [target.actor],
    replayed: false,
  });
  expect(
    (await f.registry.register({ ...f.requests(next)[0]!, actingSubject: target.actor }))
      .dispatchEligible,
  ).toBe(true);
  await expect(f.registry.register(f.requests(old)[0]!)).rejects.toBeInstanceOf(AdmissionDenied);
  await expect(
    f.registry.claim(saved.id, saved.requestDigest, old.verified),
  ).rejects.toBeInstanceOf(AdmissionDenied);
});

test('concurrent deactivations use the same floor and an installed policy retains its higher minimum', async () => {
  const first = await principal(),
    second = await principal();
  const control = await agent([first, second]);
  const registry = new AccessAdmissionRegistry(pool);
  const results = await Promise.allSettled([
    registry.strongDeactivatePrincipal(first.id, '0'),
    registry.strongDeactivatePrincipal(second.id, '0'),
  ]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(
    (await pool.query('SELECT access.agent_controller_count($1) AS n', [control.actor])).rows[0]!.n,
  ).toBe(1);
  const third = await principal(),
    fourth = await principal();
  const configured = await agent([third, fourth]);
  const recovery = native();
  await pool.query("INSERT INTO access.authority_subject (id,kind) VALUES ($1,'agent')", [
    recovery,
  ]);
  await pool.query(
    `INSERT INTO access.agent_control (subject_id,min_controllers,max_controllers,
    recovery_subject,recovery_approvals,recovery_delay) VALUES ($1,2,16,$2,1,interval '0 seconds')`,
    [configured.actor, recovery],
  );
  await expect(registry.strongDeactivatePrincipal(third.id, '0')).rejects.toBeInstanceOf(
    AdmissionConflict,
  );
  expect(
    (await pool.query('SELECT access.agent_controller_count($1) AS n', [configured.actor])).rows[0]!
      .n,
  ).toBe(2);
});

test('principal controller inventory uses the principal index against unrelated authority rows', async () => {
  const owner = await principal(),
    unrelated = await principal();
  const control = await agent([owner]);
  await pool.query(
    `WITH subjects AS (INSERT INTO access.authority_subject (id,kind)
    SELECT 'https://rezics.com/id/' || gen_random_uuid()::text,'agent' FROM generate_series(1,16000) RETURNING id)
    INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
    SELECT gen_random_uuid(),$1,id,'agent.control','infinity' FROM subjects`,
    [unrelated.id],
  );
  await pool.query('ANALYZE access.representation');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    expect(await principalControllerSubjects(client, owner.id)).toEqual([control.actor]);
    const plan = (
      await client.query(
        `EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT DISTINCT subject_id
      FROM access.representation WHERE principal_id = $1 AND action = 'agent.control' AND active
      ORDER BY subject_id LIMIT 257`,
        [owner.id],
      )
    ).rows[0]!['QUERY PLAN'][0].Plan;
    expect(JSON.stringify(plan)).toContain('representation_active_lookup');
    expect(JSON.stringify(plan)).not.toContain('Seq Scan');
    expect(plan['Shared Hit Blocks'] + plan['Shared Read Blocks']).toBeLessThan(20);
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
});
