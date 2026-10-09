import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { startPostgresCluster, type PostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import type { FusekiClient, SparqlResult } from '../src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry, type VerifiedPrincipal } from '../src/modules/access/admission.ts';
import { REFERENCE_DISCLOSURE_COST } from '../src/modules/access/semantic-disclosure.ts';

const root = resolve(import.meta.dir, '../../..');
const native = () => `https://rezics.com/id/${randomUUID()}`;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
type Controller = { id: string; actor: string; mandate: string; principal: VerifiedPrincipal };
const expiredController: Controller = { id: randomUUID(), actor: native(), mandate: randomUUID(),
  principal: { issuer: 'https://accounts.test', subject: randomUUID(), emailVerified: true } };
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
        // The permanent-controller upgrade preserves finite legacy mandates.
        await client.query('INSERT INTO access.principal (id,account_issuer,account_subject) VALUES ($1,$2,$3)',
          [expiredController.id, expiredController.principal.issuer, expiredController.principal.subject]);
        await client.query("INSERT INTO access.authority_subject (id,kind) VALUES ($1,'agent')", [expiredController.actor]);
        await client.query(`INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
          VALUES ($1,$2,$3,'agent.control',clock_timestamp() - interval '1 hour')`,
        [expiredController.mandate, expiredController.id, expiredController.actor]);
      }
      await client.query(readFileSync(join(root, 'services/main/migrations/access', file), 'utf8'));
    }
    await provision(client, expiredController);
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

async function provision(client: Pick<Pool, 'query'>, owner: Controller) {
  const id = randomUUID();
  await client.query(`INSERT INTO access.agent_provision (id,principal_id,idempotency_key,request_digest,
    agent_id,agent_kind,display_name,principal_epoch,state,graph_data_epoch,graph_sequence,representation_id)
    VALUES ($1::uuid,$2,$1::text,$3,$4,'person','Reference author fixture',0,'active','fixture',1,$5)`,
  [id, owner.id, digest(id), owner.actor, owner.mandate]);
}

async function controller(): Promise<Controller> {
  const owner: Controller = { id: randomUUID(), actor: native(), mandate: randomUUID(),
    principal: { issuer: 'https://accounts.test', subject: randomUUID(), emailVerified: true } };
  await pool.query('INSERT INTO access.principal (id,account_issuer,account_subject) VALUES ($1,$2,$3)',
    [owner.id, owner.principal.issuer, owner.principal.subject]);
  await pool.query("INSERT INTO access.authority_subject (id,kind) VALUES ($1,'agent')", [owner.actor]);
  await pool.query(`INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
    VALUES ($1,$2,$3,'agent.control','infinity')`, [owner.mandate, owner.id, owner.actor]);
  await provision(pool, owner);
  return owner;
}

type Work = { resource: string; admission: string; main: string; receipt: string; digest: string;
  action: string; scope: string; kind: 'work' | 'post' | 'chapter' | 'definition' | 'zone';
  erased?: boolean; protected?: boolean; missingHead?: boolean };

async function works(owner: Controller, count: number, kind: Work['kind'] = 'work'): Promise<Work[]> {
  const action = kind === 'chapter' ? 'work.edit' : 'work.create';
  const scope = kind === 'chapter' ? `work:edit:${native()}` : 'work:create:root';
  await pool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
  const admissions = (await pool.query<{ id: string; graph_receipt: string; request_digest: string }>(`
    INSERT INTO access.admission (id,principal_id,acting_subject,scope_id,action,idempotency_key,
      request_digest,authority_epoch,expires_at,state,graph_receipt,graph_outcome,graph_data_epoch,graph_sequence,sealed_at)
    SELECT id,$1,$2,$3,$4,id::text,$5,0,now(),'sealed',$6 || replace(id::text,'-',''),
      'succeeded','fixture',1,now() FROM (SELECT gen_random_uuid() AS id FROM generate_series(1,$7)) ids
    RETURNING id,graph_receipt,request_digest`,
  [owner.id, owner.actor, scope, action, digest('reference fixture'), `urn:rezics:receipt:${digest('receipt').slice(0, 32)}`, count])).rows;
  const created = (await pool.query<{ work: string; main_version: string; creation_admission: string }>(`
    INSERT INTO access.work_maintainer_set (work,main_version,creation_admission)
    SELECT 'https://rezics.com/id/' || gen_random_uuid()::text,
      'https://rezics.com/id/' || gen_random_uuid()::text,id FROM unnest($1::uuid[]) AS ids(id)
    RETURNING work,main_version,creation_admission`, [admissions.map(row => row.id)])).rows;
  await pool.query(`INSERT INTO access.work_maintainer (work,agent)
    SELECT work,$2 FROM unnest($1::text[]) AS wanted(work)`, [created.map(row => row.work), owner.actor]);
  const byAdmission = new Map(admissions.map(row => [row.id, row]));
  return created.map(row => ({ resource: row.work, admission: row.creation_admission, main: row.main_version,
    receipt: byAdmission.get(row.creation_admission)!.graph_receipt,
    digest: byAdmission.get(row.creation_admission)!.request_digest, action, scope, kind }));
}

async function transfer(work: string, actor: string) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE access.work_maintainer_set SET generation = generation + 1 WHERE work = $1', [work]);
    await client.query('DELETE FROM access.work_maintainer WHERE work = $1', [work]);
    await client.query('INSERT INTO access.work_maintainer (work,agent) VALUES ($1,$2)', [work, actor]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

type GraphPath = 'semantic' | 'definition' | 'zone' | 'public' | 'author';
// PostgreSQL is real. The graph fixture models each owner's response separately:
// a private Work can only pass the author receipt/current-head proof.
// SPARQL proof shape is checked against the scalar evaluator in
// reference-handover.test.ts; this fixture does not qualify a native Jena plan.
function reader(targets: readonly Work[]) {
  const library = new Map(targets.map(work => [work.resource, work]));
  const publicWorks = new Set<string>(), publicSemantics = new Set<string>();
  const statements: { sql: string; values: unknown[]; rows: number }[] = [];
  const proofs: { path: GraphPath; query: string; limit: number | undefined; bytes: number }[] = [];
  let failure = false;
  let extra: string | undefined;
  let pause: (() => Promise<void>) | undefined;
  const graph: Pick<FusekiClient, 'query'> = { async query(query, limit) {
    const path: GraphPath = query.includes('rv:admittedScope "semantic:create:root"') ? 'definition'
      : query.includes('rv:admittedScope "space:create:root"') ? 'zone'
        : query.includes('rv:admissionId') ? 'author'
          : query.includes('rv:semanticHead') ? 'semantic' : 'public';
    const requested = query.startsWith('PREFIX') && query.includes('ASK {')
      ? [...library.keys()].filter(resource => query.includes(`<${resource}>`))
      : path === 'semantic'
        ? [...query.matchAll(/VALUES \?resource \{([^}]+)\}/g)].flatMap(match => [...match[1]!.matchAll(/<([^>]+)>/g)].map(iri => iri[1]!))
        : [...query.matchAll(/BIND\(<([^>]+)> AS \?resource\)/g)].map(match => match[1]!);
    if (path === 'author') {
      if (pause) await pause();
      if (failure) throw new Error('reference graph unavailable');
    }
    const admitted = requested.filter(resource => {
      if (path === 'semantic') return publicSemantics.has(resource);
      if (path === 'public') return publicWorks.has(resource);
      if (path !== 'author') return false;
      const work = library.get(resource);
      return !!work && ['work', 'post', 'chapter'].includes(work.kind)
        && !work.erased && !work.protected && !work.missingHead
        && query.includes(`<${work.receipt}>`) && query.includes(`"${work.admission}"`)
        && query.includes(`"${work.digest}"`) && query.includes(`"${work.scope}"`)
        && (work.kind === 'chapter' ? query.includes('(rv:post|rv:chapterWork)')
          : query.includes(`<${work.main}>`));
    });
    const result: SparqlResult = query.includes('ASK {') ? { boolean: admitted.length > 0 }
      : { results: { bindings: [...new Set(admitted)].map(resource => ({ resource: { type: 'uri', value: resource } })) } };
    if (path === 'author' && extra && result.results) {
      result.results.bindings.push({ resource: { type: 'uri', value: extra } });
    }
    const bytes = Buffer.byteLength(JSON.stringify(result));
    expect(bytes).toBeLessThanOrEqual(limit!);
    proofs.push({ path, query, limit, bytes });
    return result;
  } };
  const measured = { async connect() {
    const client = await pool.connect();
    return { release: () => client.release(), async query(sql: string, values: unknown[] = []) {
      const result = await client.query(sql, values);
      // Scalar reads begin with a multi-statement transaction setup, for which
      // pg returns one QueryResult per statement.
      const rows = Array.isArray(result)
        ? result.reduce((count, statement) => count + statement.rows.length, 0)
        : result.rows.length;
      statements.push({ sql, values, rows });
      return result;
    } };
  } } as unknown as Pool;
  const access = new AccessAdmissionRegistry(measured);
  access.configureBaseline(graph);
  return { access, publicWorks, publicSemantics, statements, proofs,
    fail: () => { failure = true; }, inject: (resource: string) => { extra = resource; },
    pause: (callback: () => Promise<void>) => { pause = callback; },
    clear: () => { statements.length = 0; proofs.length = 0; } };
}

const candidateStatements = (r: ReturnType<typeof reader>) => r.statements.filter(row => row.sql.includes('work_maintainer_set'));
const authorProofs = (r: ReturnType<typeof reader>) => r.proofs.filter(row => row.path === 'author');
const resources = (targets: readonly Work[]) => targets.map(work => work.resource);
async function parity(r: ReturnType<typeof reader>, owner: Controller, targets: readonly Work[], allowed: readonly Work[]) {
  expect(await r.access.canReadReferences(owner.principal, owner.actor, resources(targets))).toEqual(new Set(resources(allowed)));
  for (const work of targets) {
    expect(await r.access.canReadWork(owner.principal, owner.actor, work.resource)).toBe(allowed.includes(work));
  }
}

test('a new principal controlling the same Agent inherits private references and revocation removes the creator', async () => {
  const owner = await controller(), next = await controller();
  const targets = [...await works(owner, 1), ...await works(owner, 1, 'chapter')], r = reader(targets);
  await parity(r, owner, targets, targets);
  await parity(r, next, targets, []);
  await pool.query(`INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
    VALUES (gen_random_uuid(),$1,$2,'agent.control','infinity')`, [next.id, owner.actor]);
  const successor = { ...next, actor: owner.actor };
  await parity(r, successor, targets, targets);
  await pool.query('UPDATE access.representation SET active = false WHERE id = $1', [owner.mandate]);
  await parity(r, owner, targets, []);
  await pool.query('UPDATE access.principal SET active = false WHERE id = $1', [owner.id]);
  await parity(r, successor, targets, targets);
  expect((await pool.query('SELECT principal_id,acting_subject FROM access.admission WHERE id = $1',
    [targets[0]!.admission])).rows[0]).toEqual({ principal_id: owner.id, acting_subject: owner.actor });
});

test('maintainer transfer and transfer back use current membership for Work and Post/chapter references', async () => {
  const owner = await controller(), next = await controller();
  const targets = [...await works(owner, 1), ...await works(owner, 1, 'post'), ...await works(owner, 1, 'chapter')];
  const r = reader(targets);
  await parity(r, owner, targets, targets);
  for (const work of targets) await transfer(work.resource, next.actor);
  await parity(r, owner, targets, []);
  await parity(r, next, targets, targets);
  for (const work of targets) await transfer(work.resource, owner.actor);
  await parity(r, owner, targets, targets);
  await parity(r, next, targets, []);
  expect((await pool.query('SELECT generation::text FROM access.work_maintainer_set WHERE work = ANY($1::text[])',
    [resources(targets)])).rows.map(row => row.generation)).toEqual(['2', '2', '2']);
});

test('revoked control, inactive principal and inactive Agent remove reference and scalar authority', async () => {
  for (const kind of ['controller', 'principal', 'agent'] as const) {
    const owner = await controller(), targets = await works(owner, 1), r = reader(targets);
    const successor = await controller();
    await pool.query(`INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
      VALUES (gen_random_uuid(),$1,$2,'agent.control','infinity')`, [successor.id, owner.actor]);
    await parity(r, owner, targets, targets);
    if (kind === 'controller') await pool.query('UPDATE access.representation SET active = false WHERE id = $1', [owner.mandate]);
    if (kind === 'principal') await pool.query('UPDATE access.principal SET active = false WHERE id = $1', [owner.id]);
    if (kind === 'agent') await pool.query('UPDATE access.authority_subject SET active = false WHERE id = $1', [owner.actor]);
    r.clear();
    await parity(r, owner, targets, []);
    expect(authorProofs(r)).toEqual([]);
  }
});

test('an expired legacy controller cannot disclose references despite sealed creation and active rows', async () => {
  const targets = await works(expiredController, 1), r = reader(targets);
  await parity(r, expiredController, targets, []);
  expect(authorProofs(r)).toEqual([]);
});

test('missing Work gates admit authors while independent semantic closures do not remove Work authority', async () => {
  const owner = await controller(), targets = await works(owner, 3), r = reader(targets);
  await pool.query('INSERT INTO access.scope_gate (id,open) VALUES ($1,false),($2,false)',
    [`work:read:${targets[0]!.resource}`, `semantic:read:${targets[1]!.resource}`]);
  await parity(r, owner, targets, targets.slice(1));
  expect(candidateStatements(r)[0]!.values[0]).not.toContain(targets[0]!.resource);
  expect(authorProofs(r)[0]!.query).not.toContain(targets[0]!.resource);
});

async function policy(owner: Controller, scope: string, ended = false) {
  const client = await pool.connect(), id = randomUUID(), grant = randomUUID();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
    await client.query(`INSERT INTO access.permission_grant
      (id,issuer_subject,recipient_subject,scope_id,action,valid_until) VALUES ($1,$2,$2,$3,'work.read','infinity')`,
    [grant, owner.actor, scope]);
    await client.query(`INSERT INTO access.policy (id,scope_id,owner_subject,head_revision,ended_at)
      VALUES ($1,$2,$3,1,CASE WHEN $4 THEN now() END)`, [id, scope, owner.actor, ended]);
    await client.query(`INSERT INTO access.policy_revision (policy_id,revision,scope_id,profile,
      combining_algorithm,default_effect,mandatory_count,ordered_count,reference_count,max_states,max_input_rows,
      deadline_ms,digest,published_by_principal,publisher_subject,publisher_representation_id,
      publisher_representation_generation,publisher_grant_id,publisher_grant_generation,result_authority_epoch)
      VALUES ($1,1,$2,'access-policy-v1','first-applicable','deny',0,0,0,1,1,100,$3,$4,$5,$6,0,$7,0,1)`,
    [id, scope, digest(id), owner.id, owner.actor, owner.mandate, grant]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

test('installed and ended Work policies exclude baseline; a semantic policy leaves independent Work authority', async () => {
  const owner = await controller(), targets = await works(owner, 3), r = reader(targets);
  await policy(owner, `work:read:${targets[0]!.resource}`);
  await policy(owner, `work:read:${targets[1]!.resource}`, true);
  await policy(owner, `semantic:read:${targets[2]!.resource}`);
  await parity(r, owner, targets, targets.slice(2));
  expect(candidateStatements(r)[0]!.values[0]).toEqual([targets[2]!.resource]);
});

test('erasure, protection, missing heads and mismatched receipts reject only the affected private proof', async () => {
  const owner = await controller(), targets = await works(owner, 5);
  targets[0]!.erased = true;
  targets[1]!.protected = true;
  targets[2]!.missingHead = true;
  await pool.query('UPDATE access.admission SET graph_receipt = $1 WHERE id = $2',
    [`urn:rezics:receipt:${digest('wrong receipt')}`, targets[3]!.admission]);
  const r = reader(targets);
  await parity(r, owner, targets, targets.slice(4));
});

test('unsealed and cancelled creation provenance never reaches an author graph proof', async () => {
  const owner = await controller(), targets = await works(owner, 3), r = reader(targets);
  await pool.query("UPDATE access.admission SET state = 'registered',sealed_at = NULL WHERE id = $1", [targets[0]!.admission]);
  await pool.query("UPDATE access.admission SET graph_outcome = 'cancelled' WHERE id = $1", [targets[1]!.admission]);
  await parity(r, owner, targets, targets.slice(2));
  expect(candidateStatements(r)[0]!.rows).toBe(1);
  expect(authorProofs(r)[0]!.query).not.toContain(targets[0]!.resource);
  expect(authorProofs(r)[0]!.query).not.toContain(targets[1]!.resource);
});

test('public Work and Post baseline belongs to verified members; anonymous reads disclose public semantics only', async () => {
  const owner = await controller(), other = await controller();
  const targets = [...await works(owner, 1), ...await works(owner, 1, 'post')], semantic = native(), r = reader(targets);
  for (const work of targets) r.publicWorks.add(work.resource);
  r.publicSemantics.add(semantic);
  expect(await r.access.canReadReferences(null, null, [...resources(targets), semantic])).toEqual(new Set([semantic]));
  await parity(r, other, targets, targets);
  expect(await r.access.canReadReferences({ ...other.principal, emailVerified: false }, other.actor,
    [...resources(targets), semantic])).toEqual(new Set([semantic]));
  expect(authorProofs(r)).toEqual([]);
});

test('Work maintainer provenance does not grant Zone or definition creator authority', async () => {
  const owner = await controller();
  const targets = [...await works(owner, 1, 'definition'), ...await works(owner, 1, 'zone')], r = reader(targets);
  expect(await r.access.canReadReferences(owner.principal, owner.actor, resources(targets))).toEqual(new Set());
  expect(r.proofs.filter(proof => proof.path === 'zone')).toHaveLength(1);
  expect(r.proofs.filter(proof => proof.path === 'definition')).toEqual([]);
  expect(authorProofs(r)).toHaveLength(1);
});

test('explicit Work and semantic read grants retain their independent expiry, revocation and gate checks', async () => {
  for (const action of ['work.read', 'semantic.read']) {
    for (const denial of ['grant-revoked', 'grant-expired', 'mandate-revoked', 'mandate-expired', 'gate-closed']) {
      const owner = await controller(), resource = native(), scope = `${action === 'work.read' ? 'work' : 'semantic'}:read:${resource}`;
      const mandate = randomUUID(), grant = randomUUID(), r = reader([]);
      await pool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [scope]);
      await pool.query(`INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
        VALUES ($1,$2,$3,$4,'infinity')`, [mandate, owner.id, owner.actor, action]);
      await pool.query(`INSERT INTO access.permission_grant (id,issuer_subject,recipient_subject,scope_id,action,valid_until)
        VALUES ($1,$2,$2,$3,$4,'infinity')`, [grant, owner.actor, scope, action]);
      expect(await r.access.canReadReferences({ ...owner.principal, emailVerified: false }, owner.actor, [resource])).toEqual(new Set([resource]));
      if (denial === 'grant-revoked') await pool.query('UPDATE access.permission_grant SET active = false WHERE id = $1', [grant]);
      if (denial === 'grant-expired') await pool.query("UPDATE access.permission_grant SET valid_until = now() - interval '1 second' WHERE id = $1", [grant]);
      if (denial === 'mandate-revoked') await pool.query('UPDATE access.representation SET active = false WHERE id = $1', [mandate]);
      if (denial === 'mandate-expired') await pool.query("UPDATE access.representation SET valid_until = now() - interval '1 second' WHERE id = $1", [mandate]);
      if (denial === 'gate-closed') await pool.query('UPDATE access.scope_gate SET open = false WHERE id = $1', [scope]);
      expect(await r.access.canReadReferences(owner.principal, owner.actor, [resource, native()])).toEqual(new Set());
      expect(authorProofs(r)).toEqual([]);
    }
  }
});

test('recovery hold fences public and private reference paths before graph reads and rolls back', async () => {
  const owner = await controller(), targets = await works(owner, 1), r = reader(targets);
  await pool.query('UPDATE access.recovery_fence SET open = false WHERE id');
  try {
    await expect(r.access.canReadReferences(owner.principal, owner.actor, resources(targets))).rejects.toThrow('Access recovery is held');
    await expect(r.access.canReadReferences(null, null, resources(targets))).rejects.toThrow('Access recovery is held');
    await expect(r.access.canReadWork(owner.principal, owner.actor, targets[0]!.resource)).rejects.toThrow('Access is held for recovery');
    expect(r.proofs).toEqual([]);
    expect(r.statements.at(-1)!.sql).toBe('ROLLBACK');
  } finally { await pool.query('UPDATE access.recovery_fence SET open = true WHERE id'); }
  await parity(r, owner, targets, targets);
});

test('graph failure rolls back; a retry rereads transferred membership rather than saving authority', async () => {
  const owner = await controller(), next = await controller(), targets = await works(owner, 1), r = reader(targets);
  r.fail();
  await expect(r.access.canReadReferences(owner.principal, owner.actor, resources(targets))).rejects.toThrow('reference graph unavailable');
  expect(r.statements.at(-1)!.sql).toBe('ROLLBACK');
  await transfer(targets[0]!.resource, next.actor);
  const retry = reader(targets);
  await parity(retry, owner, targets, []);
  await parity(retry, next, targets, targets);
});

test('reference proof locks order a concurrent maintainer transfer after the read', async () => {
  const owner = await controller(), next = await controller(), targets = await works(owner, 1), r = reader(targets);
  const writer = await pool.connect();
  r.pause(async () => {
    await writer.query('BEGIN');
    await writer.query("SET LOCAL lock_timeout = '100ms'");
    await expect(writer.query('UPDATE access.work_maintainer_set SET generation = generation + 1 WHERE work = $1',
      [targets[0]!.resource])).rejects.toMatchObject({ code: '55P03' });
    await writer.query('ROLLBACK');
  });
  try {
    expect(await r.access.canReadReferences(owner.principal, owner.actor, resources(targets))).toEqual(new Set(resources(targets)));
  } finally { await writer.query('ROLLBACK'); writer.release(); }
  await transfer(targets[0]!.resource, next.actor);
  await parity(reader(targets), owner, targets, []);
  await parity(reader(targets), next, targets, targets);
});

test('a reference read waiting behind a transfer cannot combine the new set with former membership', async () => {
  const owner = await controller(), next = await controller(), targets = await works(owner, 1), r = reader(targets);
  const writer = await pool.connect();
  let reading: Promise<ReadonlySet<string>> | undefined;
  try {
    await writer.query('BEGIN');
    await writer.query('UPDATE access.work_maintainer_set SET generation = generation + 1 WHERE work = $1', [targets[0]!.resource]);
    await writer.query('DELETE FROM access.work_maintainer WHERE work = $1', [targets[0]!.resource]);
    await writer.query('INSERT INTO access.work_maintainer (work,agent) VALUES ($1,$2)', [targets[0]!.resource, next.actor]);
    reading = r.access.canReadReferences(owner.principal, owner.actor, resources(targets));
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
    expect(authorProofs(r)).toEqual([]);
  } finally {
    await writer.query('ROLLBACK');
    writer.release();
    await reading;
  }
  await parity(reader(targets), next, targets, targets);
});

test('65 references have fixed query and byte bounds independent of duplicate mandates and unrelated library growth', async () => {
  const owner = await controller(), targets = await works(owner, 65), r = reader(targets);
  await pool.query(`INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
    VALUES (gen_random_uuid(),$1,$2,'agent.control','infinity')`, [owner.id, owner.actor]);
  const read = () => r.access.canReadReferences(owner.principal, owner.actor, resources(targets));
  expect(await read()).toEqual(new Set(resources(targets)));
  expect(candidateStatements(r)).toHaveLength(1);
  expect(candidateStatements(r)[0]!.rows).toBe(65);
  expect(authorProofs(r)).toHaveLength(1);
  expect(authorProofs(r)[0]!.limit).toBe(16_384);
  expect(r.proofs.length).toBeLessThanOrEqual(REFERENCE_DISCLOSURE_COST.graphReads);
  const baseline = { sql: r.statements.length, proofs: [...r.proofs], candidate: candidateStatements(r)[0]! };
  const singleton = reader([targets[0]!]);
  expect(await singleton.access.canReadReferences(owner.principal, owner.actor, [targets[0]!.resource])).toEqual(new Set([targets[0]!.resource]));
  expect(singleton.statements).toHaveLength(baseline.sql);
  expect(singleton.proofs).toHaveLength(baseline.proofs.length);
  await works(owner, 8192);
  for (const table of ['work_maintainer_set', 'work_maintainer', 'admission']) await pool.query(`ANALYZE access.${table}`);
  r.clear();
  expect(await read()).toEqual(new Set(resources(targets)));
  expect(r.statements).toHaveLength(baseline.sql);
  expect(r.proofs).toEqual(baseline.proofs);
  expect(candidateStatements(r)).toHaveLength(1);
  expect(candidateStatements(r)[0]!.rows).toBe(65);
  expect(Buffer.byteLength(authorProofs(r)[0]!.query)).toBeLessThan(160_000);
  const query = baseline.candidate;
  const plan = (await pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.sql}`, query.values)).rows[0]['QUERY PLAN'][0].Plan;
  type Plan = { 'Node Type': string; 'Relation Name'?: string; 'Actual Rows': number; 'Shared Hit Blocks': number; Plans?: Plan[] };
  const nodes = (node: Plan): Plan[] => [node, ...(node.Plans ?? []).flatMap(nodes)];
  expect(plan['Actual Rows']).toBe(65);
  expect(plan['Shared Hit Blocks']).toBeLessThan(2000);
  expect(nodes(plan).filter(node => ['work_maintainer_set', 'work_maintainer', 'admission'].includes(node['Relation Name'] ?? '')
    && node['Node Type'] === 'Seq Scan')).toEqual([]);
}, 30_000);

test('duplicate and invalid references remain bounded; oversized input performs no owner reads', async () => {
  const owner = await controller(), targets = await works(owner, 1), r = reader(targets), resource = targets[0]!.resource;
  expect(await r.access.canReadReferences(owner.principal, owner.actor, Array(65).fill(resource))).toEqual(new Set([resource]));
  expect(candidateStatements(r)[0]!.values[0]).toEqual([resource]);
  r.clear();
  expect(await r.access.canReadReferences(owner.principal, owner.actor, ['urn:invalid', resource])).toEqual(new Set([resource]));
  r.clear();
  for (const refs of [[], ['urn:invalid']]) expect(await r.access.canReadReferences(owner.principal, owner.actor, refs)).toEqual(new Set());
  await expect(r.access.canReadReferences(owner.principal, owner.actor, Array(66).fill(resource))).rejects.toThrow('semantic disclosure batch exceeds its profile');
  expect(r.statements).toEqual([]);
  expect(r.proofs).toEqual([]);
});

test('unexpected private proof identities reject the whole result and release owner locks', async () => {
  const owner = await controller(), targets = await works(owner, 1), r = reader(targets);
  r.inject(native());
  await expect(r.access.canReadReferences(owner.principal, owner.actor, resources(targets))).rejects.toThrow('author Work proof batch is ambiguous');
  expect(r.statements.at(-1)!.sql).toBe('ROLLBACK');
  await transfer(targets[0]!.resource, (await controller()).actor);
});
