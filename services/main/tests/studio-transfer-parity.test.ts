import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { startPostgresCluster, type PostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import type { FusekiClient, SparqlResult } from '../src/infrastructure/fuseki.ts';
import type { VerifiedPrincipal } from '../src/modules/access/admission.ts';
import { StudioAccess } from '../src/modules/studio/access.ts';
import { readStudioWork, readStudioWorks } from '../src/modules/studio/works.ts';
import type { ReadRow, WorkReadSession } from '../src/modules/work/read-session.ts';

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

async function provision(client: Pick<Pool, 'query'>, owner: Controller, kind = 'person', state = 'active') {
  const id = randomUUID();
  await client.query(`INSERT INTO access.agent_provision (id,principal_id,idempotency_key,request_digest,
    agent_id,agent_kind,display_name,principal_epoch,state,graph_data_epoch,graph_sequence,representation_id)
    VALUES ($1::uuid,$2,$1::text,$3,$4,$6,'Studio steward fixture',0,$7,'fixture',1,$5)`,
  [id, owner.id, digest(id), owner.actor, owner.mandate, kind, state]);
}

async function controller(kind = 'person', provisionState = 'active'): Promise<Controller> {
  const owner: Controller = { id: randomUUID(), actor: native(), mandate: randomUUID(),
    principal: { issuer: 'https://accounts.test', subject: randomUUID(), emailVerified: true } };
  await pool.query('INSERT INTO access.principal (id,account_issuer,account_subject) VALUES ($1,$2,$3)',
    [owner.id, owner.principal.issuer, owner.principal.subject]);
  await pool.query("INSERT INTO access.authority_subject (id,kind) VALUES ($1,'agent')", [owner.actor]);
  await pool.query(`INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
    VALUES ($1,$2,$3,'agent.control','infinity')`, [owner.mandate, owner.id, owner.actor]);
  await provision(pool, owner, kind, provisionState);
  return owner;
}

type Work = { resource: string; admission: string; main: string; receipt: string; digest: string;
  action: string; scope: string; writer: string; nativeCredit: boolean; kind: 'work' | 'post' | 'chapter' | 'definition' | 'zone';
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
    digest: byAdmission.get(row.creation_admission)!.request_digest, action, scope, writer: owner.actor, nativeCredit: true, kind }));
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


function session(owner: Controller, r: ReturnType<typeof reader>, options: { cursor?: string; limit?: number } = {},
  beforeFence?: () => Promise<void>) {
  const queries: string[] = [];
  const term = (value: string) => ({ type: 'uri' as const, value });
  const head = (work: Work): ReadRow => ({ admission: { type: 'literal', value: work.admission },
    work: term(work.resource), main: term(work.main), head: term(`${work.resource}/head`),
    mainHead: term(`${work.main}/head`), title: { type: 'literal', value: 'Transferred book', 'xml:lang': 'en' } });
  const value = { principal: owner.principal, deps: { studioAccess: r.access },
    options: { actingSubject: owner.actor, ...options }, position: { dataEpoch: 'fixture', sequence: '1' },
    async query(query: string) {
      queries.push(query);
      if (query.includes('SELECT ?admission')) {
        expect(query).toContain('VALUES (?admission ?writer)');
        expect(query).toContain('rv:agent ?writer');
        const authored = query.includes('FILTER EXISTS {');
        return [...r.library.values()].filter(work => query.includes(`"${work.admission}"`)
          && query.includes(`("${work.admission}" <${work.writer}>)`)
          && work.nativeCredit === authored).map(head).reverse();
      }
      if (query.includes('SELECT ?credit')) return [...r.library.values()]
        .filter(work => query.includes(`<${work.resource}>`) && work.nativeCredit
          && query.includes(`rv:agent <${work.writer}>`))
        .map(work => ({ credit: term(`${work.resource}/credit`) }));
      if (query.includes('SELECT ?main ?head')) return [...r.library.values()]
        .filter(work => query.includes(`<${work.resource}>`)).map(head);
      return [];
    },
    async summaries() { if (beforeFence) await beforeFence(); return []; },
  } as unknown as WorkReadSession;
  return { value, queries };
}

test('transfer recipient inventory, exact read and chapter actions follow current authority with creation provenance unchanged', async () => {
  const creator = await controller(), recipient = await controller(), viewer = await controller();
  const [book] = await works(creator, 1), [chapter] = await works(creator, 1, 'chapter');
  const r = reader([book!, chapter!]);
  const created = await r.access.studioWork(creator.principal, creator.actor, book!.resource);
  await transfer(book!.resource, recipient.actor);
  await transfer(chapter!.resource, recipient.actor);
  const list = await readStudioWorks(session(recipient, r).value, recipient.actor, {});
  expect(list.items).toHaveLength(1);
  expect(list.items[0]).toMatchObject({ id: book!.resource, relationship: 'authored' });
  const exact = await readStudioWork(session(recipient, r).value, recipient.actor, book!.resource);
  expect(exact.item.relationship).toBe(list.items[0]!.relationship);
  expect(exact.item.createdAt).toBe(created.row!.created_at.toISOString());
  expect((await readStudioWorks(session(creator, r).value, creator.actor, {})).items).toEqual([]);
  expect((await r.access.studioWork(creator.principal, creator.actor, book!.resource)).row).toBeNull();
  expect((await r.access.chapterWriters(recipient.principal, recipient.actor, [chapter!.resource])).get(chapter!.resource))
    .toMatchObject({ writer: creator.actor, authoringSubject: recipient.actor, authoritySubject: recipient.actor });
  expect(await r.access.contentVariantAuthority(recipient.principal, recipient.actor, chapter!.resource))
    .toEqual({ authoringSubject: recipient.actor });
  expect((await r.access.chapterWriters(creator.principal, creator.actor, [chapter!.resource])).get(chapter!.resource))
    .toMatchObject({ writer: creator.actor, authoringSubject: null, controlled: false });
  const scope = `content:variants:${chapter!.resource}`;
  await pool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [scope]);
  // C has an explicit private grant under C's own identity. Creation
  // provenance cannot select the read actor or confer an authoring subject.
  await pool.query(`INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
    VALUES (gen_random_uuid(),$1,$2,'content.variants.read','infinity')`, [viewer.id, viewer.actor]);
  await pool.query(`INSERT INTO access.permission_grant (id,issuer_subject,recipient_subject,scope_id,action,valid_until)
    VALUES (gen_random_uuid(),$1,$2,$3,'content.variants.read','infinity')`, [recipient.actor, viewer.actor, scope]);
  expect((await r.access.chapterWriters(viewer.principal, viewer.actor, [chapter!.resource])).get(chapter!.resource))
    .toMatchObject({ writer: creator.actor, controlled: true, authoritySubject: viewer.actor, authoringSubject: null });
  expect(await r.access.contentVariantAuthority(viewer.principal, viewer.actor, chapter!.resource))
    .toEqual({ authoringSubject: null });
  expect(await r.access.contentVariantAuthority(creator.principal, creator.actor, chapter!.resource)).toBeNull();
  expect((await r.access.studioWork(viewer.principal, viewer.actor, chapter!.resource)).row).toBeNull();
  expect((await readStudioWorks(session(viewer, r).value, viewer.actor, {})).items).toEqual([]);
  expect((await pool.query('SELECT principal_id,acting_subject FROM access.admission WHERE id = $1',
    [book!.admission])).rows[0]).toEqual({ principal_id: creator.id, acting_subject: creator.actor });
});

test('current controller handover and transferred source adoption keep inventory and exact relationship parity', async () => {
  const creator = await controller(), successor = await controller(), recipient = await controller();
  const [authored] = await works(creator, 1), [curated] = await works(creator, 1), r = reader([authored!, curated!]);
  curated!.nativeCredit = false;
  await pool.query('UPDATE access.admission SET idempotency_key = $2 WHERE id = $1',
    [curated!.admission, `source-adopt-${curated!.admission}`]);
  await pool.query(`INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
    VALUES (gen_random_uuid(),$1,$2,'agent.control','infinity')`, [successor.id, creator.actor]);
  await pool.query('UPDATE access.representation SET active = false WHERE id = $1', [creator.mandate]);
  const successorSession = session({ ...successor, actor: creator.actor }, r).value;
  expect((await readStudioWorks(successorSession, creator.actor, {})).items.map(item => item.id)).toEqual([authored!.resource]);
  await expect(r.access.studioWorks(creator.principal, creator.actor, '', 20)).rejects.toThrow('representation');
  await transfer(curated!.resource, recipient.actor);
  expect((await readStudioWorks(session(recipient, r).value, recipient.actor, {})).items).toEqual([]);
  const inventory = await readStudioWorks(session(recipient, r).value, recipient.actor, { view: 'curated' });
  expect(inventory.items[0]).toMatchObject({ id: curated!.resource, relationship: 'curated' });
  expect((await readStudioWork(session(recipient, r).value, recipient.actor, curated!.resource)).item.relationship).toBe('curated');
});

test('large transferred inventory remains bounded and pages by current membership Work key without omissions', async () => {
  const creator = await controller(), recipient = await controller(), targets = await works(creator, 227), r = reader(targets);
  for (const target of targets) await transfer(target.resource, recipient.actor);
  const seen: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await readStudioWorks(session(recipient, r, { cursor }).value, recipient.actor, {});
    expect(page.items.length).toBeLessThanOrEqual(20);
    seen.push(...page.items.map(item => item.id));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  expect(seen).toEqual(targets.map(work => work.resource).sort());
  expect(new Set(seen).size).toBe(targets.length);
  for (const proof of r.proofs) {
    expect([...proof.query.matchAll(/BIND\(/g)].length).toBeLessThanOrEqual(65);
    expect(proof.limit).toBe(16_384);
  }
  const candidates = r.statements.filter(row => row.sql.includes('FROM access.work_maintainer m'));
  expect(candidates.every(row => row.rows <= 201)).toBe(true);
  expect(candidates.every(row => row.sql.includes('m.work > $2') && row.sql.includes('ORDER BY m.work LIMIT $3'))).toBe(true);
  expect((await r.access.studioWorks(creator.principal, creator.actor, '', 201)).rows).toEqual([]);
}, 30_000);

test('stale or erased receipt evidence denies list and exact read while bounded empty pages can continue', async () => {
  const owner = await controller(), targets = await works(owner, 203), r = reader(targets);
  const sorted = [...targets].sort((left, right) => left.resource.localeCompare(right.resource));
  for (const target of sorted.slice(0, 200)) target.erased = true;
  const first = await readStudioWorks(session(owner, r).value, owner.actor, {});
  expect(first.items).toEqual([]);
  expect(first.nextCursor).not.toBeNull();
  const next = await readStudioWorks(session(owner, r, { cursor: first.nextCursor! }).value, owner.actor, {});
  expect(next.items.map(item => item.id)).toEqual(sorted.slice(200).map(work => work.resource));
  expect((await r.access.studioWork(owner.principal, owner.actor, sorted[0]!.resource)).row).toBeNull();
  r.library.get(sorted[200]!.resource)!.digest = digest('stale receipt');
  expect((await r.access.studioWork(owner.principal, owner.actor, sorted[200]!.resource)).row).toBeNull();
  expect((await r.access.studioWorks(owner.principal, owner.actor, sorted[199]!.resource, 20)).rows[0]!.generation).toBeNull();
});

test('recovery hold, failed graph and ambiguous proof fail closed with retry against live maintainership', async () => {
  const creator = await controller(), recipient = await controller(), [target] = await works(creator, 1), r = reader([target!]);
  await pool.query('UPDATE access.recovery_fence SET open = false WHERE id');
  try {
    await expect(r.access.studioWorks(creator.principal, creator.actor, '', 20)).rejects.toThrow('Access recovery hold');
    expect(r.proofs).toEqual([]);
  } finally { await pool.query('UPDATE access.recovery_fence SET open = true WHERE id'); }
  r.fail();
  await expect(r.access.studioWorks(creator.principal, creator.actor, '', 20)).rejects.toThrow('Studio graph unavailable');
  expect(r.statements.at(-1)!.sql).toBe('ROLLBACK');
  await transfer(target!.resource, recipient.actor);
  const retry = reader([target!]);
  expect((await retry.access.studioWorks(creator.principal, creator.actor, '', 20)).rows).toEqual([]);
  expect((await retry.access.studioWorks(recipient.principal, recipient.actor, '', 20)).rows[0]!.generation).toBe('1');
  retry.inject(native());
  await expect(retry.access.studioWorks(recipient.principal, recipient.actor, '', 20)).rejects.toThrow('proof batch is ambiguous');
});

test('transfer during hydration fences the response and retries as the recipient', async () => {
  const creator = await controller(), recipient = await controller(), [target] = await works(creator, 1), r = reader([target!]);
  const reading = session(creator, r, {}, () => transfer(target!.resource, recipient.actor));
  await expect(readStudioWorks(reading.value, creator.actor, {})).rejects.toThrow('Studio Work inventory changed');
  expect((await readStudioWorks(session(recipient, r).value, recipient.actor, {})).items[0]!.id).toBe(target!.resource);
});

test('inventory proof locks order concurrent transfers and controller revocation', async () => {
  const owner = await controller(), [target] = await works(owner, 1), r = reader([target!]), writer = await pool.connect();
  r.pause(async () => {
    for (const [sql, key] of [
      ['UPDATE access.work_maintainer_set SET generation = generation + 1 WHERE work = $1', target!.resource],
      ['UPDATE access.representation SET active = false WHERE id = $1', owner.mandate],
    ]) {
      await writer.query('BEGIN');
      await writer.query("SET LOCAL lock_timeout = '100ms'");
      await expect(writer.query(sql!, [key])).rejects.toMatchObject({ code: '55P03' });
      await writer.query('ROLLBACK');
    }
  });
  try {
    expect((await r.access.studioWorks(owner.principal, owner.actor, '', 20)).rows[0]!.generation).toBe('0');
  } finally { await writer.query('ROLLBACK'); writer.release(); }
});

test('unverified controllers, inactive provisioning and nonterminal provenance cannot populate editable inventory', async () => {
  const owner = await controller(), targets = await works(owner, 3), r = reader(targets);
  await pool.query("UPDATE access.admission SET state = 'registered',sealed_at = NULL WHERE id = $1", [targets[0]!.admission]);
  await pool.query("UPDATE access.admission SET graph_outcome = 'cancelled' WHERE id = $1", [targets[1]!.admission]);
  expect((await r.access.studioWorks(owner.principal, owner.actor, '', 20)).rows.filter(row => row.generation !== null).map(row => row.work)).toEqual([targets[2]!.resource]);
  r.clear();
  const unverified = { ...owner.principal, emailVerified: false };
  expect((await r.access.studioWorks(unverified, owner.actor, '', 20)).rows.find(row => row.work === targets[2]!.resource)!.generation).toBeNull();
  expect((await r.access.studioWork(unverified, owner.actor, targets[2]!.resource)).row).toBeNull();
  expect(r.proofs).toEqual([]);
  const pending = await controller('person', 'planned'), [pendingWork] = await works(pending, 1), inactive = reader([pendingWork!]);
  for (const state of ['planned', 'compensating', 'compensated']) {
    if (state !== 'planned') await pool.query('UPDATE access.agent_provision SET state = $2 WHERE agent_id = $1', [pending.actor, state]);
    expect((await inactive.access.studioWorks(pending.principal, pending.actor, '', 20)).rows[0]!.generation).toBeNull();
    expect((await inactive.access.studioWork(pending.principal, pending.actor, pendingWork!.resource)).row).toBeNull();
    expect(inactive.proofs).toEqual([]);
  }
  r.clear();
  for (const limit of [0, 202, 1.5]) await expect(r.access.studioWorks(owner.principal, owner.actor, '', limit)).rejects.toThrow('page size');
  expect(r.statements).toEqual([]);
});

test('ordinary catalogue Works stay curated and original native writer credits classify transferred Works without supplying authority', async () => {
  const creator = await controller(), recipient = await controller();
  const [authored] = await works(creator, 1), [catalogue] = await works(creator, 1);
  catalogue!.nativeCredit = false;
  const r = reader([authored!, catalogue!]);
  // Both have ordinary creation keys; catalogue origin cannot be inferred from
  // the source-adoption prefix, and transfer must not manufacture author credits.
  expect((await pool.query('SELECT idempotency_key FROM access.admission WHERE id = $1',
    [catalogue!.admission])).rows[0].idempotency_key).not.toStartWith('source-adopt-');
  for (const owner of [creator, recipient]) {
    if (owner === recipient) for (const target of [authored!, catalogue!]) await transfer(target.resource, recipient.actor);
    const authoredSession = session(owner, r);
    const own = await readStudioWorks(authoredSession.value, owner.actor, { view: 'authored' });
    const curated = await readStudioWorks(session(owner, r).value, owner.actor, { view: 'curated' });
    expect(own.items.map(item => item.id)).toEqual([authored!.resource]);
    expect(curated.items.map(item => item.id)).toEqual([catalogue!.resource]);
    const exactAuthoredSession = session(owner, r);
    expect((await readStudioWork(exactAuthoredSession.value, owner.actor, authored!.resource)).item.relationship).toBe('authored');
    expect((await readStudioWork(session(owner, r).value, owner.actor, catalogue!.resource)).item.relationship).toBe('curated');
    expect(authoredSession.queries.find(query => query.includes('SELECT ?admission')))
      .toContain(`("${authored!.admission}" <${creator.actor}>)`);
    expect(exactAuthoredSession.queries.find(query => query.includes('SELECT ?credit')))
      .toContain(`rv:agent <${creator.actor}>`);
  }
  // The original credit remains, while the former maintainer loses both views.
  expect(authored!.writer).toBe(creator.actor);
  expect(authored!.nativeCredit).toBe(true);
  for (const view of ['authored', 'curated'] as const) {
    expect((await readStudioWorks(session(creator, r).value, creator.actor, { view })).items).toEqual([]);
  }
});

test('catalogue classification can produce a bounded empty authored page without hiding later authored Works', async () => {
  const owner = await controller(), targets = await works(owner, 201), r = reader(targets);
  const sorted = [...targets].sort((left, right) => left.resource.localeCompare(right.resource));
  for (const target of sorted.slice(0, 200)) target.nativeCredit = false;
  const first = await readStudioWorks(session(owner, r).value, owner.actor, { view: 'authored' });
  expect(first.items).toEqual([]);
  expect(first.nextCursor).not.toBeNull();
  const next = await readStudioWorks(session(owner, r, { cursor: first.nextCursor! }).value, owner.actor, { view: 'authored' });
  expect(next.items.map(item => item.id)).toEqual([sorted[200]!.resource]);
  expect(next.nextCursor).toBeNull();
  const curated = await readStudioWorks(session(owner, r).value, owner.actor, { view: 'curated' });
  expect(curated.items.map(item => item.id)).toEqual(sorted.slice(0, 20).map(work => work.resource));
  expect(curated.nextCursor).not.toBeNull();
});
