import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection } from 'node:net';
import { createServer, type Server } from 'node:http';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { freePort } from './graph-support';
import { PREFIX } from './fixture';

type Json = Record<string, unknown>;
type Statement = { sql: string; rows: unknown[][]; pages: number };
type Running = { child: ChildProcess; logs: string[]; name: string };
const WORK_ROWS = 6_000;
const SOURCE = 'bridge-probe:main';
const ROW_IRI = `${PREFIX}r/work/`;
const PROPERTY = `${PREFIX}p/`;

export function bridgeMapping(): string {
  return `@prefix rr: <http://www.w3.org/ns/r2rml#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
<${PREFIX}m/Work> a rr:TriplesMap ;
  rr:logicalTable [ rr:tableName "bridge_work" ] ;
  rr:subjectMap [ rr:template "${ROW_IRI}{id}" ] ;
  rr:predicateObjectMap [ rr:predicate <${PROPERTY}title> ; rr:objectMap [ rr:column "title" ] ] ;
  rr:predicateObjectMap [ rr:predicate <${PROPERTY}amount> ; rr:objectMap [ rr:column "amount" ; rr:datatype xsd:decimal ] ] ;
  rr:predicateObjectMap [ rr:predicate <${PROPERTY}payload> ; rr:objectMap [ rr:column "payload" ] ] .`;
}

/** VALUES stays outside GRAPH so these are outer bindings, not an inner VALUES block. */
export function bridgeValuesQuery(count: number): Json {
  if (!Number.isInteger(count) || count < 1 || count > WORK_ROWS) throw new RangeError('count');
  return {
    '@context': { ex: PROPERTY },
    'from-named': [SOURCE],
    select: ['?work', '?title'],
    where: [
      ['values', ['?work', Array.from({ length: count }, (_, i) => ({ '@id': `${ROW_IRI}${i}` }))]],
      ['graph', SOURCE, { '@id': '?work', 'ex:title': '?title' }],
    ],
    opts: { meta: true },
  };
}

export function bridgeStatementLogs(lines: readonly string[]): string[] {
  return lines.filter(line => /\bstatement\b/.test(line) && /\bsql=/.test(line));
}

export function queryRows(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (body && typeof body === 'object' && Array.isArray((body as Json).result)) return (body as Json).result as unknown[];
  throw new Error(`query did not return array rows: ${JSON.stringify(body).slice(0, 800)}`);
}

function termText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const term = value as Json;
    for (const key of ['@id', '@value', 'value']) if (typeof term[key] === 'string') return term[key];
  }
  return String(value);
}

/** Check the complete key/value set, not only cardinality. */
export function verifyWorkRows(rows: readonly unknown[], count: number): { correct: boolean; problems: string[] } {
  const seen = new Set<number>();
  const problems: string[] = [];
  for (const [index, row] of rows.entries()) {
    if (!Array.isArray(row) || row.length !== 2) { problems.push(`row ${index}: unexpected shape`); continue; }
    const terms = row.map(termText);
    const iri = terms.find(term => term.startsWith(ROW_IRI));
    const title = terms.find(term => term.startsWith('Work '));
    if (!iri || !title) { problems.push(`row ${index}: missing IRI or title`); continue; }
    const id = Number(iri.slice(ROW_IRI.length));
    if (!Number.isInteger(id) || id < 0 || id >= count || title !== `Work ${id}`) {
      problems.push(`row ${index}: ${iri}, ${title}`);
    }
    if (seen.has(id)) problems.push(`duplicate id ${id}`);
    seen.add(id);
  }
  if (seen.size !== count) problems.push(`expected ${count} unique ids, observed ${seen.size}`);
  return { correct: problems.length === 0, problems: problems.slice(0, 20) };
}

function requiredTool(tools: Record<string, unknown>, name: string): string {
  const value = tools[name];
  if (typeof value !== 'string' || !value.startsWith('/')) throw new Error(`tools.${name} must be an absolute path`);
  return value;
}

async function command(file: string, args: string[], cwd: string, timeoutMs = 30_000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout?.on('data', chunk => { stdout += String(chunk); });
    child.stderr?.on('data', chunk => { stderr += String(chunk); });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${file} timed out: ${stderr.slice(-1000)}`)); }, timeoutMs);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${file} exited ${code}: ${stderr.slice(-2000)} ${stdout.slice(-500)}`));
    });
  });
}

function service(name: string, file: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): Running {
  const child = spawn(file, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const logs: string[] = [];
  child.stdout?.on('data', chunk => logs.push(String(chunk)));
  child.stderr?.on('data', chunk => logs.push(String(chunk)));
  child.once('error', error => logs.push(`${name} spawn error: ${error}`));
  return { child, logs, name };
}

async function waitTcp(port: number, server: Running, timeoutMs = 20_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (server.child.exitCode !== null) throw new Error(`${server.name} exited: ${server.logs.join('').slice(-2000)}`);
    const open = await new Promise<boolean>(resolve => {
      const socket = createConnection({ host: '127.0.0.1', port });
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => resolve(false));
    });
    if (open) return;
    await Bun.sleep(100);
  }
  throw new Error(`${server.name} did not listen on ${port}: ${server.logs.join('').slice(-2000)}`);
}

async function waitHttp(url: string, server: Running): Promise<void> {
  await waitTcp(Number(new URL(url).port), server);
  const end = Date.now() + 20_000;
  while (Date.now() < end) {
    try { if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return; } catch { /* retry startup */ }
    await Bun.sleep(100);
  }
  throw new Error(`${server.name} health unavailable: ${server.logs.join('').slice(-2000)}`);
}

async function postJson(url: string, value: unknown): Promise<unknown> {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(value), signal: AbortSignal.timeout(120_000) });
  const text = await response.text();
  if (!response.ok) throw new Error(`POST ${url}: ${response.status} ${text.slice(0, 2000)}`);
  try { return JSON.parse(text); } catch { throw new Error(`POST ${url}: non-JSON ${text.slice(0, 1000)}`); }
}

async function statement(base: string, sql: string): Promise<Statement> {
  const first = await fetch(`${base}/v1/statement`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: sql, signal: AbortSignal.timeout(120_000) });
  if (!first.ok) throw new Error(`bridge POST: ${first.status} ${(await first.text()).slice(0, 1000)}`);
  let page = await first.json() as Json;
  const rows: unknown[][] = [];
  let pages = 0;
  while (true) {
    if (page.error) throw new Error(`bridge SQL ${sql.slice(0, 100)}: ${JSON.stringify(page.error)}`);
    if (Array.isArray(page.data)) rows.push(...page.data as unknown[][]);
    const next = page.nextUri;
    if (typeof next !== 'string') break;
    const response = await fetch(next, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`bridge page: ${response.status} ${(await response.text()).slice(0, 1000)}`);
    page = await response.json() as Json;
    pages++;
    if (pages > 1000) throw new Error('bridge page loop');
  }
  return { sql, rows, pages };
}

function sqlTrace(body: unknown): string[] {
  if (!body || typeof body !== 'object') return [];
  const entries = (body as Json).sql;
  return Array.isArray(entries) ? entries.map(entry => String((entry as Json).sql ?? '')) : [];
}

type SnapshotProxy = { base: string; server: Server; arm: () => void; report: () => Json };

async function snapshotProxy(port: number, bridgeBase: string): Promise<SnapshotProxy> {
  const base = `http://127.0.0.1:${port}`;
  let armed = false, dataStatements = 0, firstId: string | null = null;
  let firstComplete = false, updated = false;
  let postUpdateCounts: unknown[] | null = null;
  const events: Json[] = [];
  let releaseFirst!: () => void;
  const firstDone = new Promise<void>(resolve => { releaseFirst = resolve; });
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      const sql = req.method === 'POST' && req.url === '/v1/statement' ? body.toString('utf8') : '';
      let dataOrdinal: number | null = null;
      if (armed && /JOIN \(VALUES/.test(sql) && /bridge_work/.test(sql)) {
        dataOrdinal = ++dataStatements;
        const contains2000 = /\(2000\)/.test(sql);
        events.push({ event: 'data-post', ordinal: dataOrdinal, sqlLength: sql.length, contains2000 });
        if (dataOrdinal === 1 && contains2000) throw new Error('first SQL chunk unexpectedly contains id 2000');
        if (dataOrdinal === 2) {
          if (!contains2000) throw new Error('second SQL chunk does not contain id 2000');
          await Promise.race([firstDone, Bun.sleep(15_000).then(() => { throw new Error('first data statement did not finish before second'); })]);
          events.push({ event: 'first-complete-before-update', firstComplete });
          if (!firstComplete) throw new Error('first data page not complete');
          await statement(bridgeBase, "UPDATE bridge_work SET title = 'Updated ' || id");
          const verification = await statement(bridgeBase, "SELECT COUNT(*) FILTER (WHERE title = 'Updated ' || id), COUNT(*) FILTER (WHERE title = 'Work ' || id), COUNT(*) FROM bridge_work");
          postUpdateCounts = verification.rows[0] ?? null;
          if (JSON.stringify(postUpdateCounts) !== JSON.stringify([2001, 0, 2001])) {
            throw new Error(`atomic UPDATE did not leave all 2001 rows new: ${JSON.stringify(postUpdateCounts)}`);
          }
          updated = true;
          events.push({ event: 'all-2001-updated-before-second-forward', postUpdateCounts });
        }
      }
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (['host', 'connection', 'content-length', 'transfer-encoding', 'accept-encoding'].includes(key) || value === undefined) continue;
        headers.set(key, Array.isArray(value) ? value.join(',') : value);
      }
      const response = await fetch(`${bridgeBase}${req.url ?? ''}`, { method: req.method, headers,
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body, signal: AbortSignal.timeout(120_000) });
      const responseText = await response.text();
      const parsed = responseText ? JSON.parse(responseText) as Json : {};
      if (dataOrdinal === 1 && typeof parsed.id === 'string') firstId = parsed.id;
      if (armed && req.method === 'GET' && firstId && req.url?.includes(firstId) && typeof parsed.nextUri !== 'string') {
        firstComplete = true;
        events.push({ event: 'first-data-page-complete', id: firstId, rows: Array.isArray(parsed.data) ? parsed.data.length : null });
        releaseFirst();
      }
      const rewritten = responseText ? JSON.stringify(parsed).replaceAll(bridgeBase, base) : '';
      res.writeHead(response.status, responseText ? { 'content-type': 'application/json' } : {});
      res.end(rewritten);
    } catch (error) {
      events.push({ event: 'proxy-error', error: String(error) });
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(error) }));
    }
  });
  await new Promise<void>((resolve, reject) => server.listen(port, '127.0.0.1', () => resolve()).once('error', reject));
  return { base, server, arm: () => { armed = true; },
    report: () => ({ dataStatements, firstComplete, updated, postUpdateCounts, events }) };
}

async function stop(server: Running | undefined): Promise<void> {
  if (!server || server.child.exitCode !== null) return;
  server.child.kill('SIGTERM');
  await Promise.race([new Promise<void>(resolve => server.child.once('exit', () => resolve())), Bun.sleep(5_000)]);
  if (server.child.exitCode === null) server.child.kill('SIGKILL');
}

/** Pinned runtime integration probe. Output is evidence, including explicit failures. */
export async function runBridge(root: string, tools: Record<string, unknown>): Promise<unknown> {
  const smoke = process.env.REZICS_BRIDGE_SMOKE === '1';
  const snapshot = process.env.REZICS_BRIDGE_SNAPSHOT === '1';
  const rowsToLoad = smoke ? 2 : snapshot ? 2_001 : WORK_ROWS;
  const temp = join(root, '.temp/storage-architecture/bridge');
  await mkdir(temp, { recursive: true });
  if (!smoke && snapshot && await Bun.file(join(temp, 'result.json')).exists() && !await Bun.file(join(temp, 'measurement-baseline.json')).exists()) {
    await copyFile(join(temp, 'result.json'), join(temp, 'measurement-baseline.json'));
  }
  for (const owned of ['pg-data', 'pg-socket', 'fluree-storage', 'fluree-home', '.fluree']) {
    await rm(join(temp, owned), { recursive: true, force: true });
  }
  const postgres = requiredTool(tools, 'postgres');
  const initdb = requiredTool(tools, 'initdb');
  const bridge = requiredTool(tools, 'bridge');
  const fluree = requiredTool(tools, 'fluree');
  const pgPort = await freePort(), bridgePort = await freePort(), flureePort = await freePort(), proxyPort = await freePort();
  const pgData = join(temp, 'pg-data');
  const running: Running[] = [];
  let proxy: SnapshotProxy | undefined;
  const result: Json = {
    status: 'running', startedAt: new Date().toISOString(),
    source: 'Fluree v4.2.1 and matching fluree-sql-bridge source', smoke, snapshot,
    sourceCommit: tools.sourceCommit, sourceArchiveSha256: tools.sourceArchiveSha256,
    flureeSha256: tools.flureeSha256, ports: { pgPort, bridgePort, flureePort },
  };
  try {
    result.versions = {
      postgres: (await command(postgres, ['--version'], temp)).stdout.trim(),
      bridge: (await command(bridge, ['--version'], temp)).stdout.trim(),
      fluree: (await command(fluree, ['--version'], temp)).stdout.trim(),
    };
    await command(initdb, ['-D', pgData, '-U', 'rezics', '-A', 'trust', '--encoding=UTF8', '--no-instructions'], temp, 60_000);
    const pgSocket = join(temp, 'pg-socket');
    await mkdir(pgSocket, { recursive: true });
    const pg = service('postgres', postgres, ['-D', pgData, '-h', '127.0.0.1', '-k', pgSocket, '-p', String(pgPort)], temp);
    running.push(pg);
    await waitTcp(pgPort, pg);
    const sqlBase = `http://127.0.0.1:${bridgePort}`;
    const sidecar = service('bridge', bridge, ['--listen', `127.0.0.1:${bridgePort}`, '--database', `postgres://rezics@127.0.0.1:${pgPort}/postgres`, '--decimal-scale', '6'], temp,
      { ...process.env, RUST_LOG: 'info,sqlx=warn' });
    running.push(sidecar);
    await waitHttp(`${sqlBase}/v1/info`, sidecar);
    await statement(sqlBase, 'CREATE TABLE bridge_work (id integer PRIMARY KEY, title text NOT NULL, amount numeric(38,12) NOT NULL, payload jsonb NOT NULL)');
    await statement(sqlBase, `INSERT INTO bridge_work SELECT g, 'Work ' || g, 1.234567890123::numeric(38,12), '{"fraction":0.12345678901234567890,"nested":{"label":"中文"}}'::jsonb FROM generate_series(0,${rowsToLoad - 1}) AS g`);
    const direct = await statement(sqlBase, 'SELECT id, amount::text, payload::text, amount, payload FROM bridge_work WHERE id = 0');
    result.directBridge = { columns: ['id', 'amount::text', 'payload::text', 'amount', 'payload'], rows: direct.rows, pages: direct.pages };
    const flureeBase = `http://127.0.0.1:${flureePort}`;
    if (snapshot) proxy = await snapshotProxy(proxyPort, sqlBase);
    await command(fluree, ['init'], temp);
    const graph = service('fluree', fluree, ['server', 'run', '--listen-addr', `127.0.0.1:${flureePort}`, '--storage-path', join(temp, 'fluree-storage')], temp,
      { ...process.env, FLUREE_HOME: join(temp, 'fluree-home'), ...(snapshot ? { FLUREE_SQL_PUSHDOWN_CACHE_ROWS: '0' } : {}) });
    running.push(graph);
    await waitHttp(`${flureeBase}/.well-known/fluree.json`, graph);
    result.mapping = await postJson(`${flureeBase}/v1/fluree/sql/map`, { name: 'bridge-probe', endpoint: proxy?.base ?? sqlBase, dialect: 'postgres', schema: 'public', r2rml: bridgeMapping() });
    const amounts = await postJson(`${flureeBase}/v1/fluree/query`, { from: SOURCE, select: ['?amount', '?payload'], where: [{ '@id': `${ROW_IRI}0`, [`${PROPERTY}amount`]: '?amount', [`${PROPERTY}payload`]: '?payload' }], opts: { meta: true } });
    result.mappedTypes = { raw: amounts, sql: sqlTrace(amounts) };
    const directRow = direct.rows[0] ?? [];
    const mappedRow = queryRows(amounts)[0];
    result.lexicalRoundTrip = {
      postgresNumericText: directRow[1], bridgeNumeric: directRow[3], mappedNumeric: Array.isArray(mappedRow) ? mappedRow[0] : null,
      postgresJsonbText: directRow[2], bridgeJsonbString: directRow[4], mappedJsonbString: Array.isArray(mappedRow) ? mappedRow[1] : null,
      bridgeNumericMatchesPostgresText: directRow[1] === directRow[3],
      bridgeJsonbMatchesPostgresText: directRow[2] === directRow[4],
    };
    if (smoke) {
      const body = await postJson(`${flureeBase}/v1/fluree/query`, bridgeValuesQuery(1));
      result.smokeQuery = { raw: body, correctness: verifyWorkRows(queryRows(body), 1) };
      result.status = 'complete';
      result.finishedAt = new Date().toISOString();
      return result;
    }
    if (snapshot) {
      proxy!.arm();
      const body = await postJson(`${flureeBase}/v1/fluree/query`, bridgeValuesQuery(2_001));
      const rows = queryRows(body);
      const oldPart = rows.filter(row => Array.isArray(row) && row[1] === `Work ${String(row[0]).split('/').at(-1)}`);
      const oldRows = oldPart.length;
      const updatedRows = rows.filter(row => Array.isArray(row) && row[0] === `${ROW_IRI}2000` && row[1] === 'Updated 2000').length;
      const oldPartCorrect = verifyWorkRows(oldPart, 2_000).correct;
      const mixedWithinOneQuery = rows.length === 2_001 && oldRows === 2_000 && oldPartCorrect && updatedRows === 1
        && proxy!.report().updated === true && proxy!.report().dataStatements === 2;
      result.snapshotCounterexample = { observedRows: rows.length, oldRows, updatedRows,
        oldPartCorrect, mixedWithinOneQuery,
        first: rows[0], last: rows.at(-1), proxy: proxy!.report(), trackedSql: sqlTrace(body) };
      if (!mixedWithinOneQuery) throw new Error(`snapshot counterexample was not established: ${JSON.stringify(result.snapshotCounterexample).slice(0, 2000)}`);
      result.status = 'complete';
      result.finishedAt = new Date().toISOString();
      return { status: result.status, evidencePath: join(temp, 'result.json'), snapshotCounterexample: {
        observedRows: rows.length, oldRows, updatedRows,
        mixedWithinOneQuery: (result.snapshotCounterexample as Json).mixedWithinOneQuery,
        proxy: proxy!.report(), trackedSqlCount: sqlTrace(body).length } };
    }
    const directBatch: Json[] = [];
    for (const count of [1_999, 2_001, 5_000]) {
      const ids = Array.from({ length: count }, (_, i) => i).join(',');
      const began = performance.now();
      const selected = await statement(sqlBase, `SELECT '${ROW_IRI}' || id AS work, title FROM bridge_work WHERE id = ANY (ARRAY[${ids}]::integer[]) ORDER BY id`);
      directBatch.push({ count, observedRows: selected.rows.length, ...verifyWorkRows(selected.rows, count),
        elapsedMs: Number((performance.now() - began).toFixed(3)), bridgeHttpStatements: 1, pages: selected.pages });
    }
    result.directBatch = directBatch;
    const runCounts = async (mode: string): Promise<Json[]> => {
      const countRuns: Json[] = [];
      for (const count of [1_999, 2_001, 5_000]) {
        const before = bridgeStatementLogs(sidecar.logs.join('').split('\n')).length;
        const began = performance.now();
        const body = await postJson(`${flureeBase}/v1/fluree/query`, bridgeValuesQuery(count));
        const elapsedMs = Number((performance.now() - began).toFixed(3));
        const rows = queryRows(body);
        const emitted = bridgeStatementLogs(sidecar.logs.join('').split('\n')).slice(before);
        const trackedSql = sqlTrace(body);
        const metadataProbeCount = emitted.filter(line => /\bsql=SELECT \* .* LIMIT 0\b/.test(line)).length;
        countRuns.push({ mode, count, observedRows: rows.length, ...verifyWorkRows(rows, count),
          firstRow: rows[0], lastRow: rows.at(-1), elapsedMs,
          trackedSql, trackedPushdownCount: trackedSql.length,
          bridgeStatementLogCount: sidecar.logs.length ? emitted.length : null,
          metadataProbeCount, bridgeDataStatementCount: sidecar.logs.length ? emitted.length - metadataProbeCount : null,
          bridgeStatementLog: emitted.map(line => line.slice(0, 600)) });
      }
      return countRuns;
    };
    result.outerBindings = { defaultCache: await runCounts('default-cache') };
    await stop(graph);
    const seeded = service('fluree-seeded', fluree, ['server', 'run', '--listen-addr', `127.0.0.1:${flureePort}`, '--storage-path', join(temp, 'fluree-storage')], temp,
      { ...process.env, FLUREE_HOME: join(temp, 'fluree-home'), FLUREE_SQL_PUSHDOWN_CACHE_ROWS: '0' });
    running.push(seeded);
    await waitHttp(`${flureeBase}/.well-known/fluree.json`, seeded);
    (result.outerBindings as Json).seeded = await runCounts('cache-disabled');
    result.status = 'complete';
    result.finishedAt = new Date().toISOString();
    const compact = (result.outerBindings as { defaultCache: Json[]; seeded: Json[] });
    const summary = (runs: Json[]) => runs.map(({ mode, count, observedRows, correct, problems, elapsedMs,
      trackedPushdownCount, bridgeStatementLogCount, metadataProbeCount, bridgeDataStatementCount }) =>
      ({ mode, count, observedRows, correct, problems, elapsedMs, trackedPushdownCount,
        bridgeStatementLogCount, metadataProbeCount, bridgeDataStatementCount }));
    return { status: result.status, evidencePath: join(temp, 'result.json'), versions: result.versions,
      lexicalRoundTrip: result.lexicalRoundTrip, directBatch,
      outerBindings: { defaultCache: summary(compact.defaultCache), seeded: summary(compact.seeded) } };
  } catch (error) {
    result.status = 'failed';
    result.error = String(error);
    result.finishedAt = new Date().toISOString();
    throw error;
  } finally {
    for (const server of [...running].reverse()) await stop(server);
    if (proxy) await new Promise<void>(resolve => proxy!.server.close(() => resolve()));
    result.logs = Object.fromEntries(running.map(server => [server.name, server.logs.join('').slice(-12_000)]));
    await writeFile(join(temp, 'result.json'), JSON.stringify(result, null, 2));
  }
}
