import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import type { FusekiClient, SparqlResult } from '../src/infrastructure/fuseki.ts';
import type { VerifiedPrincipal } from '../src/modules/access/admission.ts';
import { StudioAccess } from '../src/modules/studio/access.ts';
import { authorWorkGeneration, authorWorkGenerations } from '../src/modules/access/author-baseline.ts';

const root = resolve(import.meta.dir, '../../..');
const state = join(root, '.temp', `studio-handover-${randomUUID()}`);
const data = join(state, 'pgdata');
const native = () => `https://rezics.com/id/${randomUUID()}`;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
type Controller = { id: string; actor: string; mandate: string; principal: VerifiedPrincipal };
const expiredController: Controller = { id: randomUUID(), actor: native(), mandate: randomUUID(),
  principal: { issuer: 'https://accounts.test', subject: randomUUID(), emailVerified: true } };
let pool: Pool;
let started = false;

beforeAll(async () => {
  mkdirSync(state, { recursive: true, mode: 0o700 });
  execFileSync('initdb', ['-D', data, '-A', 'trust', '--no-instructions'], { cwd: state, stdio: 'pipe' });
  const port = await new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('no PostgreSQL test port'));
      server.close(() => resolvePort(address.port));
    });
  });
  execFileSync('pg_ctl', ['-D', data, '-l', join(state, 'postgres.log'),
    '-o', `-h 127.0.0.1 -p ${port} -k /tmp`, '-w', 'start'], { cwd: state, stdio: 'pipe' });
  started = true;
  pool = new Pool({ host: '127.0.0.1', port, user: process.env.USER, database: 'postgres', max: 4 });
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
  if (started) execFileSync('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop'], { cwd: state, stdio: 'pipe' });
});

async function provision(client: Pick<Pool, 'query'>, owner: Controller, kind = 'person') {
  const id = randomUUID();
  await client.query(`INSERT INTO access.agent_provision (id,principal_id,idempotency_key,request_digest,
    agent_id,agent_kind,display_name,principal_epoch,state,graph_data_epoch,graph_sequence,representation_id)
    VALUES ($1::uuid,$2,$1::text,$3,$4,$6,'Studio steward fixture',0,'active','fixture',1,$5)`,
  [id, owner.id, digest(id), owner.actor, owner.mandate, kind]);
}

async function controller(kind = 'person'): Promise<Controller> {
  const owner: Controller = { id: randomUUID(), actor: native(), mandate: randomUUID(),
    principal: { issuer: 'https://accounts.test', subject: randomUUID(), emailVerified: true } };
  await pool.query('INSERT INTO access.principal (id,account_issuer,account_subject) VALUES ($1,$2,$3)',
    [owner.id, owner.principal.issuer, owner.principal.subject]);
  await pool.query("INSERT INTO access.authority_subject (id,kind) VALUES ($1,'agent')", [owner.actor]);
  await pool.query(`INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
    VALUES ($1,$2,$3,'agent.control','infinity')`, [owner.mandate, owner.id, owner.actor]);
  await provision(pool, owner, kind);
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
  [owner.id, owner.actor, scope, action, digest('studio fixture'), `urn:rezics:receipt:${digest('receipt').slice(0, 32)}`, count])).rows;
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

// Real Access storage and locks; the graph owner boundary supplies exact
// receipt/head results. These fixtures do not qualify a native Jena plan.
function reader(targets: readonly Work[]) {
  const library = new Map(targets.map(work => [work.resource, work]));
  const statements: { sql: string; values: unknown[]; rows: number }[] = [];
  const proofs: { query: string; limit: number | undefined; bytes: number }[] = [];
  let failure = false, extra: string | undefined, pause: (() => Promise<void>) | undefined;
  const graph: Pick<FusekiClient, 'query'> = { async query(query, limit) {
    if (pause) await pause();
    if (failure) throw new Error('Studio graph unavailable');
    const requested = query.includes('ASK {')
      ? [...library.keys()].filter(resource => query.includes(`<${resource}>`))
      : [...query.matchAll(/BIND\(<([^>]+)> AS \?resource\)/g)].map(match => match[1]!);
    const allowed = requested.filter(resource => {
      const work = library.get(resource);
      return !!work && !work.erased && !work.protected && !work.missingHead
        && query.includes(`<${work.receipt}>`) && query.includes(`"${work.admission}"`)
        && query.includes(`"${work.digest}"`) && query.includes(`"${work.scope}"`)
        && (work.kind === 'chapter' ? query.includes('(rv:post|rv:chapterWork)')
          : query.includes(`<${work.main}>`));
    });
    const result: SparqlResult = query.includes('ASK {') ? { boolean: allowed.length > 0 }
      : { results: { bindings: [...new Set(allowed)].map(resource => ({ resource: { type: 'uri', value: resource } })) } };
    if (extra && result.results) result.results.bindings.push({ resource: { type: 'uri', value: extra } });
    const bytes = Buffer.byteLength(JSON.stringify(result));
    expect(bytes).toBeLessThanOrEqual(limit!);
    proofs.push({ query, limit, bytes });
    return result;
  } };
  const measured = { async connect() {
    const client = await pool.connect();
    return { release: () => client.release(), async query(sql: string, values: unknown[] = []) {
      const result = await client.query(sql, values);
      statements.push({ sql, values, rows: result.rows.length });
      return result;
    } };
  } } as unknown as Pool;
  return { access: new StudioAccess(measured, graph), graph, statements, proofs, library,
    fail: () => { failure = true; }, inject: (resource: string) => { extra = resource; },
    pause: (callback: () => Promise<void>) => { pause = callback; },
    clear: () => { statements.length = 0; proofs.length = 0; } };
}

const resources = (targets: readonly Work[]) => targets.map(work => work.resource);

test('Studio exact Work and private chapter authority follows transfer; creator provenance survives transfer back', async () => {
  const creator = await controller(), next = await controller();
  const [book] = await works(creator, 1), [chapter] = await works(creator, 1, 'chapter');
  const r = reader([book!, chapter!]);
  const initial = await r.access.studioWork(creator.principal, creator.actor, book!.resource);
  const before = (await r.access.chapterWriters(creator.principal, creator.actor, [chapter!.resource])).get(chapter!.resource)!;
  expect(initial.row?.generation).toBe('0');
  expect(before).toMatchObject({ writer: creator.actor, controlled: true, authoritySubject: creator.actor });
  await transfer(book!.resource, next.actor);
  await transfer(chapter!.resource, next.actor);
  expect((await r.access.studioWork(creator.principal, creator.actor, book!.resource)).row).toBeNull();
  expect((await r.access.studioWork(next.principal, next.actor, book!.resource)).row?.generation).toBe('1');
  expect((await r.access.chapterWriters(creator.principal, creator.actor, [chapter!.resource])).get(chapter!.resource))
    .toMatchObject({ writer: creator.actor, controlled: false, authoritySubject: null });
  const current = (await r.access.chapterWriters(next.principal, next.actor, [chapter!.resource])).get(chapter!.resource)!;
  expect(current).toMatchObject({ writer: creator.actor, controlled: true, authoritySubject: next.actor });
  expect(await r.access.canReadContentVariants(next.principal, current.authoritySubject!, chapter!.resource)).toBe(true);
  expect(await r.access.canReadContentVariants(creator.principal, creator.actor, chapter!.resource)).toBe(false);
  await transfer(book!.resource, creator.actor);
  await transfer(chapter!.resource, creator.actor);
  expect((await r.access.studioWork(creator.principal, creator.actor, book!.resource)).stamp).not.toBe(initial.stamp);
  const returned = (await r.access.chapterWriters(creator.principal, creator.actor, [chapter!.resource])).get(chapter!.resource)!;
  expect(returned.controlled).toBe(true);
  expect(returned.stamp).not.toBe(before.stamp);
  expect((await pool.query('SELECT principal_id,acting_subject FROM access.admission WHERE id = $1',
    [chapter!.admission])).rows[0]).toEqual({ principal_id: creator.id, acting_subject: creator.actor });
});

test('current controller handover keeps exact Work and chapter reads; revoked/former controllers fail', async () => {
  const creator = await controller(), successor = await controller(), session = await controller();
  const targets = [...await works(creator, 1), ...await works(creator, 1, 'chapter')], r = reader(targets);
  const before = (await r.access.chapterWriters(creator.principal, creator.actor, [targets[1]!.resource])).get(targets[1]!.resource)!;
  await pool.query(`INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
    VALUES (gen_random_uuid(),$1,$2,'agent.control','infinity')`, [successor.id, creator.actor]);
  // Same principal, another Studio identity: use the controlled steward for chapters.
  await pool.query(`INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
    VALUES (gen_random_uuid(),$1,$2,'agent.control','infinity')`, [successor.id, session.actor]);
  await pool.query('UPDATE access.representation SET active = false WHERE id = $1', [creator.mandate]);
  expect((await r.access.studioWork(successor.principal, creator.actor, targets[0]!.resource)).row).not.toBeNull();
  const current = (await r.access.chapterWriters(successor.principal, session.actor, [targets[1]!.resource])).get(targets[1]!.resource)!;
  expect(current).toMatchObject({ writer: creator.actor, controlled: true, authoritySubject: creator.actor });
  expect(current.stamp).not.toBe(before.stamp);
  await expect(r.access.studioWork(creator.principal, creator.actor, targets[0]!.resource)).rejects.toThrow('representation');
  await expect(r.access.chapterWriters(creator.principal, creator.actor, [targets[1]!.resource])).rejects.toThrow('representation');
  await pool.query('UPDATE access.principal SET active = false WHERE id = $1', [creator.id]);
  expect((await r.access.studioWork(successor.principal, creator.actor, targets[0]!.resource)).row).not.toBeNull();
});

test('Organization stewards use current control for transferred private variants without acquiring Person authorship', async () => {
  const creator = await controller(), steward = await controller('organization');
  const targets = [...await works(creator, 1), ...await works(creator, 1, 'chapter')], r = reader(targets);
  for (const work of targets) await transfer(work.resource, steward.actor);
  expect((await r.access.studioWork(steward.principal, steward.actor, targets[0]!.resource)).row?.generation).toBe('1');
  const chapter = (await r.access.chapterWriters(steward.principal, steward.actor, [targets[1]!.resource])).get(targets[1]!.resource)!;
  expect(chapter).toMatchObject({ writer: creator.actor, controlled: true, authoritySubject: steward.actor });
  expect(await r.access.canReadContentVariants(steward.principal, chapter.authoritySubject!, targets[1]!.resource)).toBe(true);
  expect(await r.access.canReadContentVariants({ ...steward.principal, emailVerified: false }, steward.actor, targets[1]!.resource)).toBe(false);
});

test('expired legacy control, inactive principals and Agents deny chapter stewardship without graph proof', async () => {
  const session = await controller(), expired = await works(expiredController, 1, 'chapter'), r = reader(expired);
  await pool.query(`INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
    VALUES (gen_random_uuid(),$1,$2,'agent.control','infinity')`, [expiredController.id, session.actor]);
  expect((await r.access.chapterWriters(expiredController.principal, session.actor, resources(expired))).get(expired[0]!.resource)?.controlled).toBe(false);
  await expect(r.access.studioWork(expiredController.principal, expiredController.actor, expired[0]!.resource)).rejects.toThrow('representation');
  expect(r.proofs).toEqual([]);
  for (const kind of ['principal', 'agent', 'control'] as const) {
    const owner = await controller(), targets = await works(owner, 1, 'chapter'), read = reader(targets);
    const successor = await controller();
    await pool.query(`INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
      VALUES (gen_random_uuid(),$1,$2,'agent.control','infinity')`, [successor.id, owner.actor]);
    expect((await read.access.chapterWriters(owner.principal, owner.actor, resources(targets))).get(targets[0]!.resource)?.controlled).toBe(true);
    if (kind === 'principal') await pool.query('UPDATE access.principal SET active = false WHERE id = $1', [owner.id]);
    if (kind === 'agent') await pool.query('UPDATE access.authority_subject SET active = false WHERE id = $1', [owner.actor]);
    if (kind === 'control') await pool.query('UPDATE access.representation SET active = false WHERE id = $1', [owner.mandate]);
    read.clear();
    await expect(read.access.chapterWriters(owner.principal, owner.actor, resources(targets))).rejects.toThrow();
    expect(read.proofs).toEqual([]);
  }
});

test('exact sealed receipt and live unerased head are required for private Work and chapter authority', async () => {
  const owner = await controller();
  for (const kind of ['work', 'chapter'] as const) {
    const targets = await works(owner, 8, kind), r = reader(targets);
    r.library.get(targets[0]!.resource)!.erased = true;
    r.library.get(targets[1]!.resource)!.protected = true;
    r.library.get(targets[2]!.resource)!.missingHead = true;
    r.library.get(targets[3]!.resource)!.receipt = 'urn:rezics:receipt:wrong';
    r.library.get(targets[4]!.resource)!.digest = digest('wrong');
    r.library.get(targets[5]!.resource)!.admission = randomUUID();
    r.library.get(targets[6]!.resource)!.scope = 'work:edit:wrong';
    // The graph boundary knows the correct provenance independently of Access.
    // These altered expected fields make every mismatched receipt return denial.
    for (const target of targets.slice(0, 7)) {
      expect((await r.access.studioWork(owner.principal, owner.actor, target.resource)).row).toBeNull();
      expect((await r.access.chapterWriters(owner.principal, owner.actor, [target.resource])).get(target.resource)?.controlled).toBe(false);
    }
    expect((await r.access.studioWork(owner.principal, owner.actor, targets[7]!.resource)).row).not.toBeNull();
    const chapter = (await r.access.chapterWriters(owner.principal, owner.actor, [targets[7]!.resource])).get(targets[7]!.resource)!;
    expect(chapter.controlled).toBe(true);
    const client = await pool.connect();
    try {
      expect(await authorWorkGeneration(client, r.graph, owner.id, owner.actor, targets[7]!.resource)).toBe('0');
      expect(await authorWorkGenerations(client, r.graph, owner.id,
        new Map([[targets[7]!.resource, owner.actor]]), [targets[7]!.resource])).toEqual(new Map([[targets[7]!.resource, '0']]));
    } finally { client.release(); }
    for (const proof of r.proofs) {
      expect(proof.query).toContain('rv:outcome rv:Succeeded');
      expect(proof.query).toContain('?erasedWorkHead a rv:ErasedRevision');
      expect(proof.query).toContain('rv:protectionHead ?protection');
    }
  }
});

test('former creator explicit variant read grants survive transfer and keep their revocation, expiry and gate checks', async () => {
  for (const denial of ['grant-revoked', 'grant-expired', 'mandate-revoked', 'mandate-expired', 'gate-closed']) {
    const creator = await controller(), next = await controller(), [chapter] = await works(creator, 1, 'chapter');
    const r = reader([chapter!]), scope = `content:variants:${chapter!.resource}`, grant = randomUUID(), mandate = randomUUID();
    await transfer(chapter!.resource, next.actor);
    await pool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [scope]);
    await pool.query(`INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
      VALUES ($1,$2,$3,'content.variants.read','infinity')`, [mandate, creator.id, creator.actor]);
    await pool.query(`INSERT INTO access.permission_grant (id,issuer_subject,recipient_subject,scope_id,action,valid_until)
      VALUES ($1,$2,$2,$3,'content.variants.read','infinity')`, [grant, creator.actor, scope]);
    const read = () => r.access.chapterWriters(creator.principal, creator.actor, [chapter!.resource]);
    expect((await read()).get(chapter!.resource)).toMatchObject({ writer: creator.actor, controlled: true, authoritySubject: creator.actor });
    expect(await r.access.canReadContentVariants({ ...creator.principal, emailVerified: false }, creator.actor, chapter!.resource)).toBe(true);
    if (denial === 'grant-revoked') await pool.query('UPDATE access.permission_grant SET active = false WHERE id = $1', [grant]);
    if (denial === 'grant-expired') await pool.query("UPDATE access.permission_grant SET valid_until = clock_timestamp() - interval '1 second' WHERE id = $1", [grant]);
    if (denial === 'mandate-revoked') await pool.query('UPDATE access.representation SET active = false WHERE id = $1', [mandate]);
    if (denial === 'mandate-expired') await pool.query("UPDATE access.representation SET valid_until = clock_timestamp() - interval '1 second' WHERE id = $1", [mandate]);
    if (denial === 'gate-closed') await pool.query('UPDATE access.scope_gate SET open = false WHERE id = $1', [scope]);
    expect((await read()).get(chapter!.resource)?.controlled).toBe(false);
    expect(await r.access.canReadContentVariants(creator.principal, creator.actor, chapter!.resource)).toBe(false);
  }
});

test('unsealed and failed admissions, missing and unrelated private targets do not supply Studio authority', async () => {
  const owner = await controller(), other = await controller(), targets = await works(owner, 2, 'chapter');
  const foreign = await works(other, 1, 'chapter'), missing = native(), r = reader([...targets, ...foreign]);
  await pool.query("UPDATE access.admission SET state = 'registered',sealed_at = NULL WHERE id = $1", [targets[0]!.admission]);
  await pool.query("UPDATE access.admission SET graph_outcome = 'cancelled' WHERE id = $1", [targets[1]!.admission]);
  const controlled = await r.access.chapterWriters(owner.principal, owner.actor, [...resources(targets), ...resources(foreign), missing]);
  expect(controlled.size).toBe(1);
  expect(controlled.get(foreign[0]!.resource)).toMatchObject({ writer: other.actor, controlled: false, authoritySubject: null });
  for (const resource of [...resources(targets), ...resources(foreign), missing]) {
    expect((await r.access.studioWork(owner.principal, owner.actor, resource)).row).toBeNull();
  }
  expect(r.proofs).toEqual([]);
});

test('20 chapters across 20 controlled steward identities use one proof batch independent of library growth and duplicate mandates', async () => {
  const session = await controller(), targets: Work[] = [];
  for (let index = 0; index < 20; index++) {
    const owner = await controller();
    targets.push(...await works(owner, 1, 'chapter'));
    await pool.query(`INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
      SELECT gen_random_uuid(),$1,$2,'agent.control','infinity' FROM generate_series(1,2)`, [session.id, owner.actor]);
  }
  const r = reader(targets), read = () => r.access.chapterWriters(session.principal, session.actor, resources(targets));
  expect([...(await read()).values()].every(row => row.controlled)).toBe(true);
  expect(r.proofs).toHaveLength(1);
  expect(r.proofs[0]!.limit).toBe(16_384);
  expect(r.proofs[0]!.query).toContain('LIMIT 21');
  expect(r.statements.filter(row => row.sql.includes('work_maintainer_set')).map(row => row.rows)).toEqual([20, 20]);
  const baseline = { statements: r.statements.length, proofs: [...r.proofs] };
  await works(session, 4096);
  r.clear();
  expect([...(await read()).values()].every(row => row.controlled)).toBe(true);
  expect(r.statements).toHaveLength(baseline.statements);
  expect(r.proofs).toEqual(baseline.proofs);
  r.clear();
  await expect(r.access.chapterWriters(session.principal, session.actor, Array(21).fill(targets[0]!.resource))).rejects.toThrow('bound');
  await expect(r.access.chapterWriters(session.principal, session.actor, ['urn:invalid'])).rejects.toThrow('bound');
  expect(r.statements).toEqual([]);
  expect(r.proofs).toEqual([]);
  expect((await r.access.chapterWriters(session.principal, session.actor, Array(20).fill(targets[0]!.resource))).size).toBe(1);
}, 30_000);

test('recovery hold, graph failure and ambiguous proof fail closed; retry rechecks live transfer', async () => {
  const owner = await controller(), next = await controller(), targets = await works(owner, 1, 'chapter'), r = reader(targets);
  await pool.query('UPDATE access.recovery_fence SET open = false WHERE id');
  try {
    await expect(r.access.chapterWriters(owner.principal, owner.actor, resources(targets))).rejects.toThrow('Access recovery hold');
    expect(r.proofs).toEqual([]);
  } finally { await pool.query('UPDATE access.recovery_fence SET open = true WHERE id'); }
  r.fail();
  await expect(r.access.chapterWriters(owner.principal, owner.actor, resources(targets))).rejects.toThrow('Studio graph unavailable');
  expect(r.statements.at(-1)!.sql).toBe('ROLLBACK');
  await transfer(targets[0]!.resource, next.actor);
  const retry = reader(targets);
  expect((await retry.access.chapterWriters(owner.principal, owner.actor, resources(targets))).get(targets[0]!.resource)?.controlled).toBe(false);
  expect((await retry.access.chapterWriters(next.principal, next.actor, resources(targets))).get(targets[0]!.resource)?.controlled).toBe(true);
  retry.inject(native());
  await expect(retry.access.chapterWriters(next.principal, next.actor, resources(targets))).rejects.toThrow('proof batch is ambiguous');
  expect(retry.statements.at(-1)!.sql).toBe('ROLLBACK');
});

test('chapter read share locks order concurrent transfer and controller revocation after its proof', async () => {
  const owner = await controller(), targets = await works(owner, 1, 'chapter'), r = reader(targets), writer = await pool.connect();
  r.pause(async () => {
    for (const [sql, key] of [
      ['UPDATE access.work_maintainer_set SET generation = generation + 1 WHERE work = $1', targets[0]!.resource],
      ['UPDATE access.representation SET active = false WHERE id = $1', owner.mandate],
    ]) {
      await writer.query('BEGIN');
      await writer.query("SET LOCAL lock_timeout = '100ms'");
      await expect(writer.query(sql!, [key])).rejects.toMatchObject({ code: '55P03' });
      await writer.query('ROLLBACK');
    }
  });
  try {
    expect((await r.access.chapterWriters(owner.principal, owner.actor, resources(targets))).get(targets[0]!.resource)?.controlled).toBe(true);
  } finally { await writer.query('ROLLBACK'); writer.release(); }
});

test('a chapter read waiting behind transfer cannot retain the former maintainer from a stale join snapshot', async () => {
  const owner = await controller(), next = await controller(), targets = await works(owner, 1, 'chapter');
  const r = reader(targets), writer = await pool.connect();
  let reading: ReturnType<StudioAccess['chapterWriters']> | undefined;
  try {
    await writer.query('BEGIN');
    await writer.query('UPDATE access.work_maintainer_set SET generation = generation + 1 WHERE work = $1', [targets[0]!.resource]);
    await writer.query('DELETE FROM access.work_maintainer WHERE work = $1', [targets[0]!.resource]);
    await writer.query('INSERT INTO access.work_maintainer (work,agent) VALUES ($1,$2)', [targets[0]!.resource, next.actor]);
    reading = r.access.chapterWriters(owner.principal, owner.actor, resources(targets));
    let waiting = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      await writer.query('SELECT pg_stat_clear_snapshot()');
      waiting = (await writer.query(`SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock'
        AND query LIKE '%FROM access.work_maintainer_set s%' AND pid <> pg_backend_pid()`)).rowCount !== 0;
      if (waiting) break;
      await Bun.sleep(10);
    }
    expect(waiting).toBe(true);
    await writer.query('COMMIT');
    expect((await reading).get(targets[0]!.resource)?.controlled).toBe(false);
    expect(r.proofs).toEqual([]);
  } finally { await writer.query('ROLLBACK'); writer.release(); await reading; }
  expect((await reader(targets).access.chapterWriters(next.principal, next.actor, resources(targets))).get(targets[0]!.resource)?.controlled).toBe(true);
});
