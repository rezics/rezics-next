import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { startPostgresCluster, type PostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import type { FusekiClient, SparqlResult } from '../src/infrastructure/fuseki.ts';
import type { VerifiedPrincipal } from '../src/modules/access/admission.ts';
import { authorWorkGeneration, authorWorkGenerations } from '../src/modules/access/author-baseline.ts';
import { MediaAccessBatchReader } from '../src/modules/media/access-batch.ts';

const root = resolve(import.meta.dir, '../../..');
const native = () => `https://rezics.com/id/${randomUUID()}`;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const expiredController = { id: randomUUID(), actor: native(), mandate: randomUUID(),
  principal: { issuer: 'https://accounts.test', subject: randomUUID(), emailVerified: true } satisfies VerifiedPrincipal };
let cluster: PostgresCluster | undefined;
let pool: Pool;

beforeAll(async () => {
  const running = await startPostgresCluster();
  cluster = running;
  pool = new Pool({ ...running.connection, max: 4 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const file of schemaFiles(root, 'access')) {
      if (file === '054_agent_control.sql') {
        // Finite direct controllers were admitted before the permanent-control
        // schema. Upgrade retains those rows; reads must still check expiry.
        await client.query('INSERT INTO access.principal (id,account_issuer,account_subject) VALUES ($1,$2,$3)',
          [expiredController.id, expiredController.principal.issuer, expiredController.principal.subject]);
        await client.query("INSERT INTO access.authority_subject (id,kind) VALUES ($1,'agent')", [expiredController.actor]);
        await client.query(`INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
          VALUES ($1,$2,$3,'agent.control',clock_timestamp() - interval '1 hour')`,
        [expiredController.mandate, expiredController.id, expiredController.actor]);
      }
      await client.query(readFileSync(join(root, 'services/main/migrations/access', file), 'utf8'));
    }
    const provision = randomUUID();
    await client.query(`INSERT INTO access.agent_provision (id,principal_id,idempotency_key,request_digest,
      agent_id,agent_kind,display_name,principal_epoch,state,graph_data_epoch,graph_sequence,representation_id)
      VALUES ($1::uuid,$2,$1::text,$3,$4,'person','Legacy controller',0,'active','fixture',1,$5)`,
    [provision, expiredController.id, digest(provision), expiredController.actor, expiredController.mandate]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}, 60_000);

afterAll(async () => {
  await pool?.end();
  cluster?.remove();
});

async function controller() {
  const id = randomUUID(), actor = native(), mandate = randomUUID(), provision = randomUUID();
  const principal: VerifiedPrincipal = { issuer: 'https://accounts.test', subject: randomUUID(), emailVerified: true };
  await pool.query('INSERT INTO access.principal (id,account_issuer,account_subject) VALUES ($1,$2,$3)',
    [id, principal.issuer, principal.subject]);
  await pool.query("INSERT INTO access.authority_subject (id,kind) VALUES ($1,'agent')", [actor]);
  await pool.query(`INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
    VALUES ($1,$2,$3,'agent.control','infinity')`, [mandate, id, actor]);
  await pool.query(`INSERT INTO access.agent_provision (id,principal_id,idempotency_key,request_digest,
    agent_id,agent_kind,display_name,principal_epoch,state,graph_data_epoch,graph_sequence,representation_id)
    VALUES ($1::uuid,$2,$1::text,$3,$4,'person','Author fixture',0,'active','fixture',1,$5)`,
  [provision, id, digest(provision), actor, mandate]);
  return { id, actor, mandate, principal };
}

// Real Access rows and locks; graph admission/denial is supplied at the owner
// boundary. Query-shape parity is tested separately, not a native Jena plan.
async function works(owner: Awaited<ReturnType<typeof controller>>, count: number,
  action = 'work.create', scope = 'work:create:root') {
  await pool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
  const admissions = (await pool.query<{ id: string }>(`INSERT INTO access.admission
    (id,principal_id,acting_subject,scope_id,action,idempotency_key,request_digest,authority_epoch,
      expires_at,state,graph_receipt,graph_outcome,graph_data_epoch,graph_sequence,sealed_at)
    SELECT id,$1,$2,$3,$4,id::text,$5,0,now(),'sealed','urn:rezics:receipt:' || id::text,
      'succeeded','fixture',1,now() FROM (SELECT gen_random_uuid() AS id FROM generate_series(1,$6)) ids
    RETURNING id`, [owner.id, owner.actor, scope, action, digest('fixture'), count])).rows;
  const created = (await pool.query<{ work: string }>(`INSERT INTO access.work_maintainer_set
    (work,main_version,creation_admission)
    SELECT 'https://rezics.com/id/' || gen_random_uuid()::text,
      'https://rezics.com/id/' || gen_random_uuid()::text,id FROM unnest($1::uuid[]) AS ids(id) RETURNING work`,
  [admissions.map(row => row.id)])).rows.map(row => row.work);
  await pool.query(`INSERT INTO access.work_maintainer (work,agent)
    SELECT work,$2 FROM unnest($1::text[]) AS wanted(work)`, [created, owner.actor]);
  return created;
}

function reader(visible: Iterable<string>) {
  const admitted = new Set(visible);
  const statements: { sql: string; values: unknown[]; rows: number }[] = [];
  const proofs: { query: string; limit: number | undefined; bytes: number }[] = [];
  let failure = false;
  let extra: string | undefined;
  let paused: (() => Promise<void>) | undefined;
  const graph: Pick<FusekiClient, 'query'> = {
    async query(query, limit) {
      if (paused) await paused();
      if (failure) throw new Error('graph unavailable');
      const requested = [...query.matchAll(/BIND\(<([^>]+)> AS \?resource\)/g)].map(match => match[1]!);
      const bindings = requested.filter(work => admitted.has(work)).map(work => ({ resource: { type: 'uri', value: work } }));
      if (extra) bindings.push({ resource: { type: 'uri', value: extra } });
      const result: SparqlResult = { results: { bindings } };
      const bytes = Buffer.byteLength(JSON.stringify(result));
      expect(bytes).toBeLessThanOrEqual(limit!);
      proofs.push({ query, limit, bytes });
      return result;
    },
  };
  const measured = { async connect() {
    const client = await pool.connect();
    return {
      release: () => client.release(),
      async query(sql: string, values: unknown[] = []) {
        const result = await client.query(sql, values);
        statements.push({ sql, values, rows: result.rows.length });
        return result;
      },
    };
  } } as unknown as Pool;
  return { access: new MediaAccessBatchReader(measured, graph), admitted, graph, statements, proofs,
    fail: () => { failure = true; }, inject: (work: string) => { extra = work; },
    pause: (callback: () => Promise<void>) => { paused = callback; },
    clear: () => { statements.length = 0; proofs.length = 0; } };
}

const candidateStatements = (r: ReturnType<typeof reader>) => r.statements.filter(row => row.sql.includes('work_maintainer_set'));

test('65 private Works use one bounded candidate and graph proof despite duplicate controllers and author-library growth', async () => {
  const owner = await controller(), targets = await works(owner, 65);
  await pool.query(`INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
    VALUES (gen_random_uuid(),$1,$2,'agent.control','infinity')`, [owner.id, owner.actor]);
  const r = reader(targets);
  const read = () => r.access.canReadWorks(owner.principal, owner.actor, targets);
  expect(await read()).toEqual(new Set(targets));
  expect(r.statements).toHaveLength(10);
  expect(candidateStatements(r)).toHaveLength(1);
  expect(candidateStatements(r)[0]!.rows).toBe(65);
  expect(r.proofs).toHaveLength(1);
  expect(r.proofs[0]!.limit).toBe(16_384);
  const baseline = { sql: r.statements.length, query: r.proofs[0]!.query, bytes: r.proofs[0]!.bytes };
  const singleton = reader([targets[0]!]);
  expect(await singleton.access.canReadWorks(owner.principal, owner.actor, [targets[0]!])).toEqual(new Set([targets[0]!]));
  expect(singleton.statements).toHaveLength(baseline.sql);
  expect(singleton.proofs).toHaveLength(1);
  await works(owner, 8192);
  await pool.query('ANALYZE access.work_maintainer_set');
  await pool.query('ANALYZE access.work_maintainer');
  await pool.query('ANALYZE access.admission');
  r.clear();
  expect(await read()).toEqual(new Set(targets));
  expect(r.statements).toHaveLength(baseline.sql);
  expect(candidateStatements(r)).toHaveLength(1);
  expect(candidateStatements(r)[0]!.rows).toBe(65);
  expect(r.proofs).toHaveLength(1);
  expect(r.proofs[0]).toMatchObject({ query: baseline.query, bytes: baseline.bytes, limit: 16_384 });
  expect(Buffer.byteLength(r.proofs[0]!.query)).toBeLessThan(160_000);
  const query = candidateStatements(r)[0]!;
  const plan = (await pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.sql}`, query.values)).rows[0]['QUERY PLAN'][0].Plan;
  type Plan = { 'Node Type': string; 'Relation Name'?: string; 'Actual Rows': number; 'Shared Hit Blocks': number; Plans?: Plan[] };
  const nodes = (node: Plan): Plan[] => [node, ...(node.Plans ?? []).flatMap(nodes)];
  expect(plan['Actual Rows']).toBe(65);
  expect(plan['Shared Hit Blocks']).toBeLessThan(2000);
  expect(nodes(plan).filter(node => ['work_maintainer_set', 'work_maintainer', 'admission'].includes(node['Relation Name'] ?? '')
    && node['Node Type'] === 'Seq Scan')).toEqual([]);
}, 30_000);

test('duplicates are deduplicated within 65 and oversized or invalid requests do no owner reads', async () => {
  const owner = await controller(), [work] = await works(owner, 1), r = reader([work!]);
  expect(await r.access.canReadWorks(owner.principal, owner.actor, Array(65).fill(work))).toEqual(new Set([work!]));
  expect(candidateStatements(r)[0]!.values[0]).toEqual([work]);
  expect(r.proofs).toHaveLength(1);
  r.clear();
  for (const resources of [Array(66).fill(work), [], ['urn:invalid']]) {
    expect(await r.access.canReadWorks(owner.principal, owner.actor, resources)).toEqual(new Set());
  }
  expect(await r.access.canReadWorks(owner.principal, 'urn:invalid', [work!])).toEqual(new Set());
  expect(r.statements).toEqual([]);
  expect(r.proofs).toEqual([]);
});

test('transfers and transfer back recheck live maintainers and generation rather than the sealed creator', async () => {
  const owner = await controller(), next = await controller(), targets = await works(owner, 2), work = targets[0]!;
  const r = reader(targets);
  expect(await r.access.canReadWorks(owner.principal, owner.actor, targets)).toEqual(new Set(targets));
  const transfer = async (actor: string) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE access.work_maintainer_set SET generation = generation + 1 WHERE work = $1', [work]);
      await client.query('DELETE FROM access.work_maintainer WHERE work = $1', [work]);
      await client.query('INSERT INTO access.work_maintainer (work,agent) VALUES ($1,$2)', [work, actor]);
      await client.query('COMMIT');
    } finally { client.release(); }
  };
  await transfer(next.actor);
  expect(await r.access.canReadWorks(owner.principal, owner.actor, targets)).toEqual(new Set([targets[1]!]));
  expect(await r.access.canReadWorks(next.principal, next.actor, targets)).toEqual(new Set([work]));
  await transfer(owner.actor);
  const client = await pool.connect();
  try {
    expect(await authorWorkGenerations(client, r.graph, owner.id, owner.actor, targets)).toEqual(new Map([[work, '2'], [targets[1]!, '0']]));
  } finally { client.release(); }
});

test('closed gates, graph denial and missing targets stay indistinguishable; missing gates still permit authors', async () => {
  const owner = await controller(), targets = await works(owner, 3), missing = native();
  const r = reader(targets);
  await pool.query('INSERT INTO access.scope_gate (id,open) VALUES ($1,false)', [`work:read:${targets[0]}`]);
  r.admitted.delete(targets[1]!); // Erased/mismatched proof at the graph boundary.
  expect(await r.access.canReadWorks(owner.principal, owner.actor, [...targets, missing])).toEqual(new Set([targets[2]!]));
  expect(candidateStatements(r)[0]!.values[0]).not.toContain(targets[0]);
  expect(r.proofs[0]!.query).not.toContain(targets[0]!);
  r.clear();
  expect(await r.access.canReadWorks({ ...owner.principal, emailVerified: false }, owner.actor, targets)).toEqual(new Set());
  expect(candidateStatements(r)).toEqual([]);
  expect(r.proofs).toEqual([]);
});

test('revoked controller, inactive principal and inactive Agent remove author access on the next batch', async () => {
  for (const kind of ['controller', 'principal', 'agent'] as const) {
    const owner = await controller(), targets = await works(owner, 2), r = reader(targets);
    const successor = await controller();
    await pool.query(`INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
      VALUES (gen_random_uuid(),$1,$2,'agent.control','infinity')`, [successor.id, owner.actor]);
    expect(await r.access.canReadWorks(owner.principal, owner.actor, targets)).toEqual(new Set(targets));
    if (kind === 'controller') await pool.query('UPDATE access.representation SET active = false WHERE id = $1', [owner.mandate]);
    if (kind === 'principal') await pool.query('UPDATE access.principal SET active = false WHERE id = $1', [owner.id]);
    if (kind === 'agent') await pool.query('UPDATE access.authority_subject SET active = false WHERE id = $1', [owner.actor]);
    r.clear();
    expect(await r.access.canReadWorks(owner.principal, owner.actor, [...targets, native()])).toEqual(new Set());
    expect(r.proofs).toEqual([]);
  }
});

test('explicit grants retain independent current revocation/expiry and mandate checks', async () => {
  for (const kind of ['grant-revoked', 'grant-expired', 'mandate-revoked', 'mandate-expired', 'gate-closed'] as const) {
    const owner = await controller(), resource = native(), scope = `work:read:${resource}`;
    const mandate = randomUUID(), grant = randomUUID();
    await pool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [scope]);
    await pool.query(`INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
      VALUES ($1,$2,$3,'work.read','infinity')`, [mandate, owner.id, owner.actor]);
    await pool.query(`INSERT INTO access.permission_grant (id,issuer_subject,recipient_subject,scope_id,action,valid_until)
      VALUES ($1,$2,$2,$3,'work.read','infinity')`, [grant, owner.actor, scope]);
    const r = reader([]);
    expect(await r.access.canReadWorks({ ...owner.principal, emailVerified: false }, owner.actor, [resource])).toEqual(new Set([resource]));
    if (kind === 'grant-revoked') await pool.query('UPDATE access.permission_grant SET active = false WHERE id = $1', [grant]);
    if (kind === 'grant-expired') await pool.query("UPDATE access.permission_grant SET valid_until = clock_timestamp() - interval '1 second' WHERE id = $1", [grant]);
    if (kind === 'mandate-revoked') await pool.query('UPDATE access.representation SET active = false WHERE id = $1', [mandate]);
    if (kind === 'mandate-expired') await pool.query("UPDATE access.representation SET valid_until = clock_timestamp() - interval '1 second' WHERE id = $1", [mandate]);
    if (kind === 'gate-closed') await pool.query('UPDATE access.scope_gate SET open = false WHERE id = $1', [scope]);
    expect(await r.access.canReadWorks(owner.principal, owner.actor, [resource, native()])).toEqual(new Set());
    expect(r.proofs).toEqual([]);
  }
});

test('unsealed or failed creation never reaches the graph; graph failure rolls back and a retry rereads authority', async () => {
  const owner = await controller(), targets = await works(owner, 3), r = reader(targets);
  await pool.query(`UPDATE access.admission SET state = 'registered', sealed_at = NULL WHERE id =
    (SELECT creation_admission FROM access.work_maintainer_set WHERE work = $1)`, [targets[0]]);
  await pool.query(`UPDATE access.admission SET graph_outcome = 'cancelled' WHERE id =
    (SELECT creation_admission FROM access.work_maintainer_set WHERE work = $1)`, [targets[1]]);
  expect(await r.access.canReadWorks(owner.principal, owner.actor, targets)).toEqual(new Set([targets[2]!]));
  expect(candidateStatements(r)[0]!.rows).toBe(1);
  r.fail();
  await expect(r.access.canReadWorks(owner.principal, owner.actor, targets)).rejects.toThrow('graph unavailable');
  expect(r.statements.at(-1)!.sql).toBe('ROLLBACK');
  const retry = reader(targets);
  expect(await retry.access.canReadWorks(owner.principal, owner.actor, targets)).toEqual(new Set([targets[2]!]));
});

test('maintainer-set share locks order a concurrent transfer after the graph proof', async () => {
  const owner = await controller(), next = await controller(), [work] = await works(owner, 1), r = reader([work!]);
  const writer = await pool.connect();
  let transfer: Promise<unknown> | undefined;
  let finished = false;
  r.pause(async () => {
    await writer.query('BEGIN');
    await writer.query("SET LOCAL lock_timeout = '100ms'");
    transfer = writer.query('UPDATE access.work_maintainer_set SET generation = generation + 1 WHERE work = $1', [work])
      .then(() => { finished = true; });
    await expect(transfer).rejects.toMatchObject({ code: '55P03' });
    expect(finished).toBe(false);
    await writer.query('ROLLBACK');
  });
  try {
    expect(await r.access.canReadWorks(owner.principal, owner.actor, [work!])).toEqual(new Set([work!]));
    await writer.query('BEGIN');
    await writer.query('UPDATE access.work_maintainer_set SET generation = generation + 1 WHERE work = $1', [work]);
    await writer.query('DELETE FROM access.work_maintainer WHERE work = $1', [work]);
    await writer.query('INSERT INTO access.work_maintainer (work,agent) VALUES ($1,$2)', [work, next.actor]);
    await writer.query('COMMIT');
  } finally { writer.release(); }
  expect(await reader([work!]).access.canReadWorks(owner.principal, owner.actor, [work!])).toEqual(new Set());
});

test('unexpected graph proof identities fail closed and release the transaction', async () => {
  const owner = await controller(), [work] = await works(owner, 1), r = reader([work!]);
  r.inject(native());
  await expect(r.access.canReadWorks(owner.principal, owner.actor, [work!])).rejects.toThrow('author Work proof batch is ambiguous');
  expect(r.statements.at(-1)!.sql).toBe('ROLLBACK');
});

test('a batch waiting behind a transfer cannot combine the new generation with the former maintainer', async () => {
  const owner = await controller(), next = await controller(), [work] = await works(owner, 1), r = reader([work!]);
  const writer = await pool.connect();
  let reading: Promise<Set<string>> | undefined;
  try {
    await writer.query('BEGIN');
    await writer.query('UPDATE access.work_maintainer_set SET generation = generation + 1 WHERE work = $1', [work]);
    await writer.query('DELETE FROM access.work_maintainer WHERE work = $1', [work]);
    await writer.query('INSERT INTO access.work_maintainer (work,agent) VALUES ($1,$2)', [work, next.actor]);
    reading = r.access.canReadWorks(owner.principal, owner.actor, [work!]);
    let waiting = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      await writer.query('SELECT pg_stat_clear_snapshot()');
      waiting = (await writer.query(`SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock'
        AND query LIKE '%SELECT wanted.work AS resource, proof.%' AND pid <> pg_backend_pid()`)).rowCount !== 0;
      if (waiting) break;
      await Bun.sleep(10);
    }
    expect(waiting).toBe(true);
    await writer.query('COMMIT');
    expect(await reading).toEqual(new Set());
    expect(r.proofs).toEqual([]);
  } finally {
    await writer.query('ROLLBACK');
    writer.release();
    await reading;
  }
});

test('an expired legacy controller loses singleton and batch proofs despite active rows and sealed creation', async () => {
  const [work] = await works(expiredController, 1), r = reader([work!]);
  expect(await r.access.canReadWorks(expiredController.principal, expiredController.actor, [work!])).toEqual(new Set());
  const client = await pool.connect();
  try {
    expect(await authorWorkGeneration(client, r.graph, expiredController.id, expiredController.actor, work!)).toBeNull();
    expect(await authorWorkGenerations(client, r.graph, expiredController.id, expiredController.actor, [work!])).toEqual(new Map());
  } finally { client.release(); }
  expect(r.proofs).toEqual([]);
});
