/** Disposable graph architecture comparison. Run only through yarn research:architecture graph. */
import { closeSync, openSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { Pool } from 'pg';
import { P, R, fixtureWork, oracle, reachable, realm, revision, sampleIds, tag, tagParent, work, type Work } from './fixture';
import { assertStatus, directoryBytes, ensure, freePort, measure, percentile, request, type Sample } from './graph-support';

const SIZES = (process.env.GRAPH_SIZES ?? '10000,50000').split(',').map(Number);
const TIMEOUT = 20_000;
const CTX = { ex: P };
const uri = (value: string) => `<${value}>`;
const lit = (value: string | number | boolean) => typeof value === 'boolean'
  ? `"${value}"^^<http://www.w3.org/2001/XMLSchema#boolean>` : JSON.stringify(value);
const triple = (subject: string, predicate: string, object: string) => `${uri(subject)} ${uri(`${P}${predicate}`)} ${object} .\n`;
const graphIds = (ids: number[]) => ids.map(i => uri(work(i))).join(' ');
const pref = `PREFIX ex: <${P}>\n`;
const elapsed = (start: number) => Number((performance.now() - start).toFixed(1));
const check = (label: string, actual: unknown, expected: unknown, checks: any[]) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  checks.push({ label, ok, actual, expected });
  if (!ok) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};

function facts(w: Work): string {
  const s = work(w.id);
  let text = `${uri(s)} ${uri('http://www.w3.org/1999/02/22-rdf-syntax-ns#type')} ${uri(`${P}Work`)} .\n` +
    triple(s, 'title', lit(w.title)) + triple(s, 'tag', uri(tag(w.tag))) +
    triple(s, 'revision', uri(revision(w.revision))) + triple(s, 'baseline', lit(w.baseline));
  if (w.override) text += triple(s, 'realmDecision', lit(w.override)) + triple(s, 'realm', uri(realm));
  for (const id of w.related) text += triple(s, 'related', uri(work(id)));
  return text;
}

function document(w: Work) {
  return { '@id': work(w.id), '@type': 'ex:Work', 'ex:title': w.title, 'ex:tag': { '@id': tag(w.tag) },
    'ex:revision': { '@id': revision(w.revision) }, 'ex:baseline': w.baseline,
    ...(w.override ? { 'ex:realmDecision': w.override, 'ex:realm': { '@id': realm } } : {}),
    'ex:related': w.related.map(i => ({ '@id': work(i) })) };
}

type Engine = { name: string; query: (sparql: string) => Promise<{ bindings: Record<string, any>[]; sample: Sample }>;
  update: (sparql: string) => Promise<{ status: number; text: string; sample: Sample }>;
  storage: string; stop: () => Promise<void>; seed: (size: number) => Promise<any> };

function decodeBindings(text: string): Record<string, any>[] {
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed?.results?.bindings)) throw new Error(`non-SPARQL result: ${text.slice(0, 400)}`);
  return parsed.results.bindings;
}

async function ready(url: string, child: ChildProcess, log: string): Promise<void> {
  for (let i = 0; i < 160; i++) {
    if (child.exitCode !== null) throw new Error(`engine exited ${child.exitCode}: ${(await readFile(log, 'utf8')).slice(-3000)}`);
    try { const response = await request(url, 'application/sparql-query', 'ASK {}', 1000); if (response.status === 200) return; } catch { /* starting */ }
    await Bun.sleep(250);
  }
  throw new Error(`engine startup timeout: ${(await readFile(log, 'utf8')).slice(-3000)}`);
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([new Promise<void>(resolve => child.once('exit', () => resolve())), Bun.sleep(10_000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function startJena(jar: string, java: string, dir: string): Promise<Engine> {
  await ensure(join(dir, 'tdb2'));
  const port = await freePort();
  const log = join(dir, 'server.log');
  const logFd = openSync(log, 'w');
  const child = spawn(java, ['-Xms256m', '-Xmx3g', '-jar', jar, '--localhost', `--port=${port}`, '--tdb2', `--loc=${join(dir, 'tdb2')}`, '--update', '--timeout=20000', '/bench'],
    { cwd: dir, stdio: ['ignore', logFd, logFd] });
  closeSync(logFd);
  const endpoint = `http://127.0.0.1:${port}/bench`;
  try { await ready(`${endpoint}/query`, child, log); } catch (error) { await stop(child); throw error; }
  const query = async (sparql: string) => {
    const response = await request(`${endpoint}/query`, 'application/sparql-query', sparql, TIMEOUT);
    assertStatus(response.status, response.text, 'Jena query');
    const bindings = decodeBindings(response.text);
    response.sample.resultRows = bindings.length;
    return { bindings, sample: response.sample };
  };
  return { name: 'jena-fuseki-6.2.0', storage: join(dir, 'tdb2'), query,
    update: sparql => request(`${endpoint}/update`, 'application/sparql-update', sparql, TIMEOUT),
    stop: () => stop(child),
    seed: async size => {
      const start = performance.now(); let requests = 0; let bytes = 0;
      const post = async (body: string) => {
        const response = await request(`${endpoint}/data?default`, 'application/n-triples', body, 60_000);
        assertStatus(response.status, response.text, 'Jena seed'); requests++; bytes += response.sample.sentBytes;
      };
      let tags = '';
      for (let i = 0; i < 256; i++) { const parent = tagParent(i); if (parent !== null) tags += triple(tag(i), 'parent', uri(tag(parent))); }
      await post(tags);
      for (let begin = 0; begin < size; begin += 500) {
        let body = '';
        for (let i = begin; i < Math.min(begin + 500, size); i++) body += facts(fixtureWork(i, size));
        await post(body);
      }
      return { ms: elapsed(start), requests, sentBytes: bytes };
    } };
}

async function startFluree(binary: string, dir: string, existing = false): Promise<Engine> {
  await ensure(dir);
  if (!existing) {
    const init = spawnSync(binary, ['--direct', '--no-color', 'init'], { cwd: dir, encoding: 'utf8', timeout: 30_000 });
    if (init.status !== 0) throw new Error(`Fluree init: ${init.stderr || init.stdout}`);
    const create = spawnSync(binary, ['--direct', '--no-color', 'create', 'graph-bench'], { cwd: dir, encoding: 'utf8', timeout: 30_000 });
    if (create.status !== 0) throw new Error(`Fluree create: ${create.stderr || create.stdout}`);
  }
  const port = await freePort();
  const log = join(dir, 'server.log');
  const logFd = openSync(log, 'w');
  const child = spawn(binary, ['--no-color', 'server', 'run', '--listen-addr', `127.0.0.1:${port}`, '--storage-path', join(dir, '.fluree/storage'), '--log-level', 'warn'],
    { cwd: dir, env: { ...process.env, FLUREE_STORAGE_FSYNC: '1' }, stdio: ['ignore', logFd, logFd] });
  closeSync(logFd);
  const endpoint = `http://127.0.0.1:${port}/v1/fluree`;
  try { await ready(`${endpoint}/query/graph-bench`, child, log); } catch (error) { await stop(child); throw error; }
  const query = async (sparql: string) => {
    const response = await request(`${endpoint}/query/graph-bench`, 'application/sparql-query', sparql, TIMEOUT);
    assertStatus(response.status, response.text, 'Fluree query');
    const bindings = decodeBindings(response.text);
    response.sample.resultRows = bindings.length;
    return { bindings, sample: response.sample };
  };
  return { name: 'fluree-4.2.1', storage: join(dir, '.fluree/storage'), query,
    update: sparql => request(`${endpoint}/update/graph-bench`, 'application/sparql-update', sparql, TIMEOUT),
    stop: () => stop(child),
    seed: async size => {
      const start = performance.now(); let requests = 0; let bytes = 0;
      const post = async (insert: object[]) => {
        const body = JSON.stringify({ '@context': CTX, insert });
        const response = await request(`${endpoint}/update/graph-bench`, 'application/json', body, 60_000);
        assertStatus(response.status, response.text, 'Fluree seed'); requests++; bytes += response.sample.sentBytes;
      };
      const tags = Array.from({ length: 256 }, (_, i) => ({ '@id': tag(i), ...(tagParent(i) === null ? {} : { 'ex:parent': { '@id': tag(tagParent(i)!) } }) }));
      await post(tags);
      for (let begin = 0; begin < size; begin += 250) {
        const batch = Array.from({ length: Math.min(250, size - begin) }, (_, j) => document(fixtureWork(begin + j, size)));
        await post(batch);
      }
      return { ms: elapsed(start), requests, sentBytes: bytes };
    } };
}

function queries(size: number) {
  const ids = sampleIds(size);
  const values = `VALUES ?w { ${graphIds(ids)} }`;
  return {
    metadata: `${pref}SELECT ?w ?title ?revision WHERE { ${values} ?w ex:title ?title ; ex:revision ?revision . }`,
    complete: `${pref}SELECT ?w ?title ?tag ?parent ?revision ?baseline ?override WHERE { ${values} ?w ex:title ?title ; ex:tag ?tag ; ex:revision ?revision ; ex:baseline ?baseline . OPTIONAL { ?tag ex:parent ?parent } OPTIONAL { ?w ex:realmDecision ?override } }`,
    effective: `${pref}SELECT ?w WHERE { ${values} ?w ex:baseline ?baseline . OPTIONAL { ?w ex:realmDecision ?override } FILTER((!BOUND(?override) && ?baseline = true) || (?override = "accept")) }`,
    hop2: `${pref}SELECT DISTINCT ?target WHERE { ${uri(work(0))} ex:related ?a . ?a ex:related ?target } LIMIT 128`,
    hop4: `${pref}SELECT DISTINCT ?target WHERE { ${uri(work(17))} ex:related ?a . ?a ex:related ?b . ?b ex:related ?c . ?c ex:related ?target } LIMIT 128`,
  };
}

function index(iri: string, kind: 'work' | 'tag' | 'revision'): number { return Number(iri.slice(iri.lastIndexOf(`/${kind}/`) + kind.length + 2)); }
function value(row: Record<string, any>, key: string): string | undefined { return row[key]?.value; }
function normalized(rows: Record<string, any>[]) {
  return rows.map(row => ({ id: index(value(row, 'w')!, 'work'), title: value(row, 'title')!,
    tag: index(value(row, 'tag')!, 'tag'), parent: value(row, 'parent') ? index(value(row, 'parent')!, 'tag') : null,
    revision: index(value(row, 'revision')!, 'revision'), baseline: value(row, 'baseline') === 'true',
    override: value(row, 'override') ?? null })).sort((a, b) => a.id - b.id);
}

async function graphRead(engine: Engine, size: number, pool: Pool, checks: any[]) {
  const q = queries(size), ids = sampleIds(size), expected = oracle(size, ids).sort((a, b) => a.id - b.id);
  const series: Record<string, any> = {};
  for (const [name, sparql] of Object.entries(q)) {
    series[name] = await measure(async () => (await engine.query(sparql)).sample);
  }
  series.graphThenPayload = await measure(async () => {
    const g = await engine.query(q.metadata);
    const selected = g.bindings.map(row => index(value(row, 'revision')!, 'revision'));
    const body = JSON.stringify(selected);
    const start = performance.now();
    const p = await pool.query('SELECT revision_id, body FROM payload WHERE revision_id = ANY($1::int[])', [selected]);
    return { ms: Number((g.sample.ms + elapsed(start)).toFixed(3)), requests: 2,
      sentBytes: g.sample.sentBytes + Buffer.byteLength(body), receivedBytes: g.sample.receivedBytes + Buffer.byteLength(JSON.stringify(p.rows)), resultRows: p.rowCount ?? 0 };
  });
  const complete = await engine.query(q.complete);
  check(`${engine.name} complete relations`, normalized(complete.bindings), expected.map(({ id, title, tag, parent, revision, baseline, override }) => ({ id, title, tag, parent, revision, baseline, override })), checks);
  const accepted = expected.filter(w => w.effective).map(w => w.id).sort((a, b) => a - b);
  const actual = (await engine.query(q.effective)).bindings.map(row => index(value(row, 'w')!, 'work')).sort((a, b) => a - b);
  check(`${engine.name} effective Realm fallback`, actual, accepted, checks);
  const metadata = await engine.query(q.metadata);
  const selected = metadata.bindings.map(row => [index(value(row, 'w')!, 'work'), index(value(row, 'revision')!, 'revision')] as const).sort((a, b) => a[0] - b[0]);
  check(`${engine.name} graph to pinned revision IDs`, selected, expected.map(w => [w.id, w.revision]), checks);
  const payloads = await pool.query('SELECT revision_id, body FROM payload WHERE revision_id = ANY($1::int[])', [selected.map(pair => pair[1])]);
  check(`${engine.name} pinned payload batch`, payloads.rows.map(row => [row.revision_id, row.body]).sort((a, b) => a[0] - b[0]),
    expected.map(w => [w.revision, w.payload] as const).sort((a, b) => a[0] - b[0]), checks);
  for (const [name, anchor, hops] of [['hop2', 0, 2], ['hop4', 17, 4]] as const) {
    const paths = (await engine.query(q[name])).bindings.map(row => index(value(row, 'target')!, 'work'));
    const valid = reachable(size, anchor, hops);
    check(`${engine.name} ${name} bounded output count`, paths.length, Math.min(128, valid.size), checks);
    check(`${engine.name} ${name} paths reachable`, paths.every(id => valid.has(id)), true, checks);
  }
  return series;
}

async function pgSeed(pool: Pool, size: number) {
  await pool.query(`CREATE TABLE work (id integer PRIMARY KEY, title text NOT NULL, tag_id integer NOT NULL, revision_id integer NOT NULL, baseline boolean NOT NULL, head_version integer NOT NULL DEFAULT 0);
    CREATE TABLE tag (id integer PRIMARY KEY, parent_id integer);
    CREATE TABLE realm_override (work_id integer PRIMARY KEY REFERENCES work(id), decision text NOT NULL CHECK (decision IN ('accept','reject')));
    CREATE TABLE related (source_id integer NOT NULL REFERENCES work(id), target_id integer NOT NULL REFERENCES work(id), PRIMARY KEY(source_id,target_id));
    CREATE INDEX related_target ON related(target_id);
    CREATE TABLE payload (revision_id integer PRIMARY KEY, body text NOT NULL);
    CREATE TABLE immutable_revision (revision_id text PRIMARY KEY, body text NOT NULL);
    CREATE TABLE receipt (id text PRIMARY KEY, work_id integer NOT NULL, head_version integer NOT NULL);`);
  const tags = Array.from({ length: 256 }, (_, i) => i);
  await pool.query('INSERT INTO tag SELECT x, CASE WHEN x=0 THEN NULL ELSE (x-1)/4 END FROM unnest($1::int[]) AS x', [tags]);
  const start = performance.now();
  for (let begin = 0; begin < size; begin += 500) {
    const batch = Array.from({ length: Math.min(500, size - begin) }, (_, j) => fixtureWork(begin + j, size));
    const ids = batch.map(w => w.id);
    await pool.query(`INSERT INTO work(id,title,tag_id,revision_id,baseline)
      SELECT * FROM unnest($1::int[],$2::text[],$3::int[],$4::int[],$5::boolean[])`,
      [ids, batch.map(w => w.title), batch.map(w => w.tag), batch.map(w => w.revision), batch.map(w => w.baseline)]);
    await pool.query('INSERT INTO payload SELECT * FROM unnest($1::int[],$2::text[])', [batch.map(w => w.revision), batch.map(w => w.payload)]);
    const overrides = batch.filter(w => w.override);
    if (overrides.length) await pool.query('INSERT INTO realm_override SELECT * FROM unnest($1::int[],$2::text[])',
      [overrides.map(w => w.id), overrides.map(w => w.override)]);
  }
  for (let begin = 0; begin < size; begin += 500) {
    const batch = Array.from({ length: Math.min(500, size - begin) }, (_, j) => fixtureWork(begin + j, size));
    const edges = batch.flatMap(w => w.related.map(target => [w.id, target]));
    await pool.query('INSERT INTO related SELECT * FROM unnest($1::int[],$2::int[]) ON CONFLICT DO NOTHING',
      [edges.map(e => e[0]), edges.map(e => e[1])]);
  }
  return { ms: elapsed(start), rows: size };
}

function sqlQueries(size: number) {
  const ids = sampleIds(size);
  return {
    complete: { sql: `SELECT w.id,w.title,w.tag_id,t.parent_id,w.revision_id,w.baseline,o.decision AS override FROM work w JOIN tag t ON t.id=w.tag_id LEFT JOIN realm_override o ON o.work_id=w.id WHERE w.id=ANY($1::int[])`, args: [ids] },
    effective: { sql: `SELECT w.id FROM work w LEFT JOIN realm_override o ON o.work_id=w.id WHERE w.id=ANY($1::int[]) AND COALESCE(o.decision='accept',w.baseline)`, args: [ids] },
    graphThenPayload: { sql: `SELECT w.id,w.title,w.revision_id,p.body FROM work w JOIN payload p ON p.revision_id=w.revision_id WHERE w.id=ANY($1::int[])`, args: [ids] },
    hop2: { sql: `SELECT DISTINCT r2.target_id FROM related r1 JOIN related r2 ON r2.source_id=r1.target_id WHERE r1.source_id=0 LIMIT 128`, args: [] },
    hop4: { sql: `SELECT DISTINCT r4.target_id FROM related r1 JOIN related r2 ON r2.source_id=r1.target_id JOIN related r3 ON r3.source_id=r2.target_id JOIN related r4 ON r4.source_id=r3.target_id WHERE r1.source_id=17 LIMIT 128`, args: [] },
    hop4Dedup: { sql: `WITH h1 AS MATERIALIZED (SELECT DISTINCT target_id FROM related WHERE source_id=17),
      h2 AS MATERIALIZED (SELECT DISTINCT r.target_id FROM related r JOIN h1 ON h1.target_id=r.source_id),
      h3 AS MATERIALIZED (SELECT DISTINCT r.target_id FROM related r JOIN h2 ON h2.target_id=r.source_id),
      h4 AS MATERIALIZED (SELECT DISTINCT r.target_id FROM related r JOIN h3 ON h3.target_id=r.source_id)
      SELECT target_id FROM h4 LIMIT 128`, args: [] },
  };
}

async function sqlRead(pool: Pool, size: number, checks: any[]) {
  const expected = oracle(size, sampleIds(size)).sort((a, b) => a.id - b.id), q = sqlQueries(size);
  const series: Record<string, any> = {};
  for (const [name, { sql, args }] of Object.entries(q)) series[name] = await measure(async () => {
    const start = performance.now(); const result = await pool.query(sql, args);
    return { ms: elapsed(start), requests: 1, sentBytes: Buffer.byteLength(sql) + Buffer.byteLength(JSON.stringify(args)),
      receivedBytes: Buffer.byteLength(JSON.stringify(result.rows)), resultRows: result.rowCount ?? 0 };
  });
  const full = await pool.query(q.complete.sql, q.complete.args);
  check('SQL complete relations', full.rows.map(row => ({ id: row.id, title: row.title, tag: row.tag_id, parent: row.parent_id,
    revision: row.revision_id, baseline: row.baseline, override: row.override })).sort((a, b) => a.id - b.id),
    expected.map(({ id, title, tag, parent, revision, baseline, override }) => ({ id, title, tag, parent, revision, baseline, override })), checks);
  const accepted = await pool.query(q.effective.sql, q.effective.args);
  check('SQL effective Realm fallback', accepted.rows.map(row => row.id).sort((a, b) => a - b), expected.filter(w => w.effective).map(w => w.id).sort((a, b) => a - b), checks);
  for (const [name, anchor, hops] of [['hop2', 0, 2], ['hop4', 17, 4], ['hop4Dedup', 17, 4]] as const) {
    const { sql, args } = q[name]; const paths = (await pool.query(sql, args)).rows.map(row => row.target_id);
    const valid = reachable(size, anchor, hops);
    check(`SQL ${name} bounded output count`, paths.length, Math.min(128, valid.size), checks);
    check(`SQL ${name} paths reachable`, paths.every(id => valid.has(id)), true, checks);
  }
  series.hopPlans = {};
  for (const name of ['hop4', 'hop4Dedup'] as const) {
    const explained = await pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${q[name].sql}`);
    series.hopPlans[name] = explained.rows[0]?.['QUERY PLAN']?.[0] ?? null;
  }
  return series;
}

async function graphCAS(engine: Engine, checks: any[]) {
  const subject = `${R}cas`;
  const initial = `INSERT DATA { ${uri(subject)} ${uri(`${P}headVersion`)} 0 . }`;
  const seeded = await engine.update(initial); assertStatus(seeded.status, seeded.text, `${engine.name} CAS seed`);
  const contender = (i: number) => `PREFIX ex: <${P}> DELETE { ${uri(subject)} ex:headVersion 0 } INSERT { ${uri(subject)} ex:headVersion 1 . ${uri(`${R}receipt/${i}`)} ex:receiptVersion 1 } WHERE { ${uri(subject)} ex:headVersion 0 }`;
  const outcomes = await Promise.all(Array.from({ length: 8 }, (_, i) => engine.update(contender(i))));
  const heads = await engine.query(`${pref}SELECT ?v WHERE { ${uri(subject)} ex:headVersion ?v }`);
  const receipts = await engine.query(`${pref}SELECT ?r WHERE { ?r ex:receiptVersion 1 }`);
  check(`${engine.name} CAS head`, heads.bindings.map(row => Number(value(row, 'v'))), [1], checks);
  check(`${engine.name} CAS single receipt`, receipts.bindings.length, 1, checks);
  const stale = await engine.update(contender(99));
  const absent = await engine.query(`${pref}SELECT ?r WHERE { ${uri(`${R}receipt/99`)} ex:receiptVersion ?r }`);
  check(`${engine.name} stale no-op has no receipt`, absent.bindings.length, 0, checks);
  const invalid = await engine.update(`${pref}INSERT DATA { ${uri(`${R}receipt/invalid`)} ex:receiptVersion . }`);
  const invalidAbsent = await engine.query(`${pref}SELECT ?v WHERE { ${uri(`${R}receipt/invalid`)} ex:receiptVersion ?v }`);
  check(`${engine.name} invalid syntax rejected`, invalid.status >= 400, true, checks);
  check(`${engine.name} invalid syntax has no receipt`, invalidAbsent.bindings.length, 0, checks);
  let workShapeStatus: number | null = null;
  if (engine.name.startsWith('fluree')) {
    const shape = await engine.update(`${pref}PREFIX sh: <http://www.w3.org/ns/shacl#>
      INSERT DATA { ${uri(`${R}WorkShape`)} a sh:NodeShape ; sh:targetClass ex:Work ;
        sh:property [ sh:path ex:title ; sh:minCount 1 ] . }`);
    assertStatus(shape.status, shape.text, 'Fluree Work title shape install');
    workShapeStatus = shape.status;
  }
  const domainInvalid = await engine.update(`${pref}INSERT DATA { ${uri(`${R}invalid-work`)} a ex:Work . ${uri(`${R}receipt/domain-invalid`)} ex:receiptVersion 1 . }`);
  const domainReceipt = await engine.query(`${pref}SELECT ?v WHERE { ${uri(`${R}receipt/domain-invalid`)} ex:receiptVersion ?v }`);
  if (engine.name.startsWith('fluree')) {
    check('Fluree Work title SHACL rejects same-command invalid write', domainInvalid.status >= 400, true, checks);
    check('Fluree invalid Work transaction has no receipt', domainReceipt.bindings.length, 0, checks);
  }
  return { responseStatus: outcomes.map(o => o.status), staleStatus: stale.status,
    invalidSyntaxStatus: invalid.status,
    workShapeStatus, domainInvalidStatus: domainInvalid.status, domainInvalidReceiptCount: domainReceipt.bindings.length,
    responseBytes: outcomes.reduce((n, o) => n + o.sample.receivedBytes, 0), oneWinner: receipts.bindings.length === 1,
    limitation: engine.name.startsWith('fluree') ? 'One Work title SHACL rule only; full REZICS profile and cross-owner checks not covered' :
      'Bare Fuseki has no Work SHACL enforcement or domain-command module; domain-invalid Work receipt acceptance is recorded, not qualified as correct product behavior' };
}

async function publishByReference(engine: Engine, pool: Pool, checks: any[]) {
  const slot = `${R}publication/${engine.name}`;
  const orphan = `${R}immutable/${engine.name}/orphan`;
  const r1 = `${R}immutable/${engine.name}/r1`;
  const latest = `${R}immutable/${engine.name}/latest`;
  const slot2 = `${R}publication/${engine.name}/race`;
  const receipt = (command: string) => `${R}publication-receipt/${engine.name}/${command}`;
  const querySlot = async (id: string) => (await engine.query(`${pref}SELECT ?revision ?version WHERE { ${uri(id)} ex:headVersion ?version . OPTIONAL { ${uri(id)} ex:currentRevision ?revision } }`)).bindings;
  const init = await engine.update(`${pref}INSERT DATA { ${uri(slot)} ex:headVersion 0 . ${uri(slot2)} ex:headVersion 0 . }`);
  assertStatus(init.status, init.text, 'publication slots');

  await pool.query('INSERT INTO immutable_revision VALUES ($1,$2)', [orphan, 'staged but never published']);
  check(`${engine.name} staged revision remains graph invisible before commit`, (await querySlot(slot)).map(row => value(row, 'revision') ?? null), [null], checks);
  check(`${engine.name} pre-commit failure leaves orphan`, (await pool.query('SELECT count(*)::integer AS n FROM immutable_revision WHERE revision_id=$1', [orphan])).rows[0].n, 1, checks);

  await pool.query('INSERT INTO immutable_revision VALUES ($1,$2),($3,$4)', [r1, 'published immutable body', latest, 'newer unrelated body']);
  const command = (id: string, expected: number, newRevision: string, commandId: string) => `${pref}
    DELETE { ${uri(id)} ex:headVersion ${expected} }
    INSERT { ${uri(id)} ex:headVersion ${expected + 1} ; ex:currentRevision ${uri(newRevision)} . ${uri(receipt(commandId))} ex:commandId ${lit(commandId)} . }
    WHERE { ${uri(id)} ex:headVersion ${expected} }`;
  const first = await engine.update(command(slot, 0, r1, 'lost-reply'));
  assertStatus(first.status, first.text, 'publish first command');
  // Model a lost HTTP reply by ignoring the successful response and reading the receipt.
  const observed = await engine.query(`${pref}SELECT ?command WHERE { ${uri(receipt('lost-reply'))} ex:commandId ?command }`);
  check(`${engine.name} lost reply reconciled by command receipt`, observed.bindings.map(row => value(row, 'command')), ['lost-reply'], checks);
  const retry = await engine.update(command(slot, 0, r1, 'lost-reply'));
  assertStatus(retry.status, retry.text, 'publish retry');
  check(`${engine.name} retry does not publish twice`, (await querySlot(slot)).map(row => [value(row, 'revision'), Number(value(row, 'version'))]), [[r1, 1]], checks);
  check(`${engine.name} retry has one receipt`, (await engine.query(`${pref}SELECT ?command WHERE { ${uri(receipt('lost-reply'))} ex:commandId ?command }`)).bindings.length, 1, checks);

  await pool.query('DELETE FROM immutable_revision WHERE revision_id=$1', [r1]);
  const pinned = value((await querySlot(slot))[0]!, 'revision')!;
  const pinnedRows = await pool.query('SELECT body FROM immutable_revision WHERE revision_id=$1', [pinned]);
  const latestRows = await pool.query('SELECT body FROM immutable_revision WHERE revision_id=$1', [latest]);
  check(`${engine.name} missing pinned revision is unavailable`, pinnedRows.rowCount, 0, checks);
  check(`${engine.name} newer body exists but is not substituted`, latestRows.rowCount, 1, checks);

  const candidates = [`${R}immutable/${engine.name}/race-a`, `${R}immutable/${engine.name}/race-b`];
  await pool.query('INSERT INTO immutable_revision VALUES ($1,$2),($3,$4)', [candidates[0], 'race-a', candidates[1], 'race-b']);
  const raced = await Promise.all(candidates.map((candidate, i) => engine.update(command(slot2, 0, candidate, `race-${i}`))));
  const raceHead = await querySlot(slot2);
  const raceReceipts = await engine.query(`${pref}SELECT ?r WHERE { ?r ex:commandId ?c . FILTER(?c = "race-0" || ?c = "race-1") }`);
  check(`${engine.name} publication same-head one revision`, raceHead.length, 1, checks);
  check(`${engine.name} publication same-head one receipt`, raceReceipts.bindings.length, 1, checks);
  return { stagedOrphan: orphan, publishedRevision: r1, droppedReply: first.status, retryStatus: retry.status,
    pinnedMissing: true, noLatestFallback: true, racedStatuses: raced.map(r => r.status), winner: value(raceHead[0]!, 'revision'),
    limitation: 'No atomic commit across PostgreSQL and graph. Orphan cleanup and missing-payload recovery remain application protocols.' };
}

async function sqlCAS(pool: Pool, checks: any[]) {
  const contenders = await Promise.all(Array.from({ length: 8 }, async (_, i) => {
    const client = await pool.connect();
    try { await client.query('BEGIN');
      const updated = await client.query('UPDATE work SET head_version=1 WHERE id=0 AND head_version=0 RETURNING id');
      if (updated.rowCount) await client.query('INSERT INTO receipt VALUES ($1,0,1)', [`candidate-${i}`]);
      await client.query('COMMIT'); return updated.rowCount ?? 0;
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }));
  check('SQL CAS single winner', contenders.reduce((a, b) => a + b, 0), 1, checks);
  const receipts = await pool.query('SELECT count(*)::integer AS n FROM receipt WHERE work_id=0');
  check('SQL CAS single receipt', receipts.rows[0].n, 1, checks);
  let domainInvalidError = '';
  try { await pool.query('INSERT INTO work(id,title,tag_id,revision_id,baseline) VALUES (999999,NULL,0,0,true)'); }
  catch (error) { domainInvalidError = String(error); }
  check('SQL missing title rejected', domainInvalidError.length > 0, true, checks);
  return { winners: contenders.reduce((a, b) => a + b, 0), domainInvalidError };
}

async function startPostgres(initdb: string, pgCtl: string, dir: string, existing = false) {
  await ensure(dir); const data = join(dir, 'data');
  const port = await freePort();
  const run = (command: string, args: string[]) => {
    const result = spawnSync(command, args, { cwd: dir, encoding: 'utf8', timeout: 30_000 });
    if (result.status !== 0) throw new Error(`${command}: ${result.stderr || result.stdout}`);
  };
  if (!existing) run(initdb, ['-D', data, '-A', 'trust', '--no-instructions']);
  run(pgCtl, ['-D', data, '-l', join(dir, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port} -c unix_socket_directories= -c fsync=on`, '-w', 'start']);
  const pool = new Pool({ host: '127.0.0.1', port, user: process.env.USER, database: 'postgres', max: 8 });
  for (let i = 0; i < 8; i++) await pool.query('SELECT 1');
  return { pool, storage: data, stop: async () => { await pool.end(); run(pgCtl, ['-D', data, '-m', 'fast', '-w', 'stop']); } };
}

async function runPostIndex(root: string, paths: Record<'fluree' | 'jenaJar' | 'java' | 'postgres' | 'initdb' | 'pg_ctl', string>) {
  const out = join(root, '.temp/storage-architecture/graph');
  const previous = JSON.parse(await readFile(join(out, 'results.json'), 'utf8'));
  const scale = previous.scales.find((s: any) => s.size === 50_000 && s.engines?.fluree?.reads);
  if (!scale) throw new Error('No completed 50k Fluree scale to index');
  const dir = scale.dir as string;
  const beforeBytes = await directoryBytes(join(dir, 'fluree/.fluree/storage'));
  const started = performance.now();
  const indexed = spawnSync(paths.fluree, ['--direct', '--no-color', 'index', 'graph-bench'],
    { cwd: join(dir, 'fluree'), encoding: 'utf8', timeout: 180_000 });
  if (indexed.status !== 0) throw new Error(`Fluree index: ${indexed.stderr || indexed.stdout}`);
  const indexMs = elapsed(started);
  const afterBytes = await directoryBytes(join(dir, 'fluree/.fluree/storage'));
  const pg = await startPostgres(paths.initdb, paths.pg_ctl, join(dir, 'postgres'), true);
  let engine: Engine | undefined;
  try {
    engine = await startFluree(paths.fluree, join(dir, 'fluree'), true);
    const metadataQuery = queries(50_000).metadata;
    const metadata = async () => (await engine!.query(metadataQuery)).sample;
    const hydration = async () => {
      const g = await engine!.query(metadataQuery);
      const revisions = g.bindings.map(row => index(value(row, 'revision')!, 'revision'));
      const start = performance.now();
      const body = await pg.pool.query('SELECT revision_id, body FROM payload WHERE revision_id=ANY($1::int[])', [revisions]);
      return { ms: Number((g.sample.ms + elapsed(start)).toFixed(3)), requests: 2,
        sentBytes: g.sample.sentBytes + Buffer.byteLength(JSON.stringify(revisions)),
        receivedBytes: g.sample.receivedBytes + Buffer.byteLength(JSON.stringify(body.rows)), resultRows: body.rowCount ?? 0 } as Sample;
    };
    const cold = { metadata: await metadata(), graphThenPayload: await hydration() };
    const warm = { metadata: [] as Sample[], graphThenPayload: [] as Sample[] };
    for (let i = 0; i < 7; i++) { warm.metadata.push(await metadata()); warm.graphThenPayload.push(await hydration()); }
    const summary = (samples: Sample[]) => ({ raw: samples, p50: percentile(samples.map(s => s.ms), .5),
      p95: percentile(samples.map(s => s.ms), .95), p99: percentile(samples.map(s => s.ms), .99) });
    const result = { kind: 'post-index 50k supplement, same fixture and payload cluster', dir, indexMs,
      indexStdout: `${indexed.stdout ?? ''}`.slice(0, 1000), beforeBytes, afterBytes,
      priorMetadataP50: scale.engines.fluree.reads.metadata.p50,
      priorHydrationP50: scale.engines.fluree.reads.graphThenPayload.p50,
      cold, warm: { metadata: summary(warm.metadata), graphThenPayload: summary(warm.graphThenPayload) },
      note: 'Fluree direct index ran after server shutdown, then server and PostgreSQL were restarted; 7 alternating read pairs. Not a concurrent-write index barrier. Hydration reads 16 fixed small synthetic payloads, not general long-form body performance.' };
    await writeFile(join(out, 'post-index-50000.json'), JSON.stringify(result, null, 2));
    return { resultPath: join(out, 'post-index-50000.json'), metadataP50: result.warm.metadata.p50, hydrationP50: result.warm.graphThenPayload.p50 };
  } finally { await engine?.stop(); await pg.stop(); }
}

export async function runGraph(root: string, tools: Record<string, unknown>) {
  const OUT = join(root, '.temp/storage-architecture/graph');
  await ensure(OUT);
  const paths = { fluree: tools.fluree, jenaJar: tools.jenaJar, java: tools.java,
    postgres: tools.postgres, initdb: tools.initdb, pg_ctl: tools.pg_ctl } as Record<'fluree' | 'jenaJar' | 'java' | 'postgres' | 'initdb' | 'pg_ctl', string>;
  for (const [key, path] of Object.entries(paths)) if (!path || typeof path !== 'string') throw new Error(`tools.json missing ${key}`);
  if (process.env.GRAPH_POST_INDEX === '1') return runPostIndex(root, paths);
  const version = (command: string, args: string[]) => {
    const run = spawnSync(command, args, { encoding: 'utf8', timeout: 10_000 });
    return { exitCode: run.status, output: `${run.stdout ?? ''}${run.stderr ?? ''}`.trim().slice(0, 1000) };
  };
  const report: any = { kind: 'synthetic graph architecture probe, not product acceptance', generatedAt: new Date().toISOString(),
    versions: { fluree: version(paths.fluree, ['--version']), jena: version(paths.java, ['-jar', paths.jenaJar, '--version']),
      postgres: version(paths.postgres, ['--version']), java: version(paths.java, ['--version']) }, tools: paths,
    assumptions: { loopback: true, durableWorkspaceDisk: OUT, fsync: true, warmedConnections: true,
      graphHTTP: true, payloadBackend: 'PostgreSQL', requestCount: 'HTTP exchanges or SQL statements; no TCP packet count',
      sqlBytes: 'Approximate query text, JSON arguments and JSON result bytes, not PostgreSQL wire bytes',
      readRounds: 15, cold: 'first measured request after seeding; client and engine already started',
      fixture: 'Synthetic deterministic Work/tag/revision/Realm/related facts; tag tree 256, skew hub up to 1000 edges',
      payloadShape: 'Graph+PostgreSQL hydration reads 16 fixed small synthetic JSON revision bodies; no long-form body or throughput claim',
      graphWrites: 'Batch ingestion and SPARQL conditional updates; no production command module or full SHACL profile', flureeFsync: 'FLUREE_STORAGE_FSYNC=1',
      hopLimits: 'Two and four fixed hops; LIMIT 128 caps returned rows, not internal expansion work' }, scales: [] };
  if (process.env.GRAPH_PROTOCOL_SMOKE === '1') {
    const dir = join(OUT, `protocol-${Date.now()}`);
    const engine = await startFluree(paths.fluree, dir);
    try {
      const seed = await engine.seed(10);
      const rows = (await engine.query(`${pref}SELECT ?title WHERE { ${uri(work(1))} ex:title ?title }`)).bindings;
      check('Fluree HTTP JSON-LD seed and SPARQL query', rows.map(row => value(row, 'title')), ['Work 000001'], []);
      const shape = await engine.update(`${pref}PREFIX sh: <http://www.w3.org/ns/shacl#>
        INSERT DATA { ${uri(`${R}SmokeWorkShape`)} a sh:NodeShape ; sh:targetClass ex:Work ; sh:property [ sh:path ex:title ; sh:minCount 1 ] . }`);
      assertStatus(shape.status, shape.text, 'smoke Work shape');
      const invalid = await engine.update(`${pref}INSERT DATA { ${uri(`${R}smoke-invalid`)} a ex:Work . ${uri(`${R}smoke-receipt`)} ex:receiptVersion 1 . }`);
      const receipt = (await engine.query(`${pref}SELECT ?v WHERE { ${uri(`${R}smoke-receipt`)} ex:receiptVersion ?v }`)).bindings;
      check('Fluree Work SHACL rejects invalid write', invalid.status >= 400, true, []);
      check('Fluree rejected transaction has no receipt', receipt.length, 0, []);
      return { smoke: 'passed', dir, seed, shapeStatus: shape.status, invalidStatus: invalid.status };
    } finally { await engine.stop(); }
  }
  for (const size of SIZES) {
    if (!Number.isInteger(size) || size < 10_000 || size > 100_000) throw new Error('GRAPH_SIZES must be 10000..100000');
    const dir = join(OUT, `run-${Date.now()}-${size}`); await mkdir(dir, { recursive: true });
    const scale: any = { size, dir, checks: [], engines: {} }; report.scales.push(scale);
    let pg: Awaited<ReturnType<typeof startPostgres>> | undefined;
    try {
      pg = await startPostgres(paths.initdb, paths.pg_ctl, join(dir, 'postgres'));
      scale.postgresSeed = await pgSeed(pg.pool, size);
      scale.engines.sql = { reads: await sqlRead(pg.pool, size, scale.checks), cas: await sqlCAS(pg.pool, scale.checks) };
      for (const candidate of ['jena', 'fluree'] as const) {
        if (process.env.GRAPH_ENGINE && process.env.GRAPH_ENGINE !== candidate) continue;
        let engine: Engine | undefined;
        try {
          engine = candidate === 'jena' ? await startJena(paths.jenaJar, paths.java, join(dir, 'jena')) : await startFluree(paths.fluree, join(dir, 'fluree'));
          const ingestion = await engine.seed(size);
          const reads = await graphRead(engine, size, pg.pool, scale.checks);
          const cas = await graphCAS(engine, scale.checks);
          const publication = await publishByReference(engine, pg.pool, scale.checks);
          scale.engines[candidate] = { ingestion, reads, cas, publication, bytesOnDisk: await directoryBytes(engine.storage) };
        } catch (error) { scale.engines[candidate] = { error: String(error) }; }
        finally {
          if (engine) {
            await engine.stop();
            scale.engines[candidate].bytesOnDiskAfterStop = await directoryBytes(engine.storage);
          }
        }
        await writeFile(join(dir, 'results.json'), JSON.stringify(scale, null, 2));
        await writeFile(join(OUT, 'results.json'), JSON.stringify(report, null, 2));
      }
      scale.engines.sql.bytesOnDisk = await directoryBytes(pg.storage);
    } catch (error) { scale.error = String(error); }
    finally { await pg?.stop(); await writeFile(join(dir, 'results.json'), JSON.stringify(scale, null, 2));
      await writeFile(join(OUT, 'results.json'), JSON.stringify(report, null, 2)); }
  }
  if (report.scales.some((s: any) => s.error || Object.values(s.engines).some((e: any) => e.error))) process.exitCode = 1;
  return { resultPath: join(OUT, 'results.json'), scales: report.scales.map((s: any) => ({ size: s.size,
    checks: s.checks.length, error: s.error, engines: Object.fromEntries(Object.entries(s.engines).map(([k, v]: any) => [k, v.error ?? 'recorded'])) })) };
}

if (import.meta.main) await runGraph(resolve(import.meta.dir, '../../..'), JSON.parse(await readFile(join(resolve(import.meta.dir, '../../..'), '.temp/storage-architecture/tools.json'), 'utf8')));
