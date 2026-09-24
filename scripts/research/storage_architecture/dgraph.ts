import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { freePort, directoryBytes } from './graph-support';
import { fixtureWork, oracle, sampleIds } from './fixture';

const IMAGE = 'docker.io/dgraph/dgraph:v25.4.1';
const IMAGE_ID = '023abcb91868d151df1889342041529670580773b8de48a48d2bb6dd466007d0';
const IMAGE_DIGEST = 'docker.io/dgraph/dgraph@sha256:056bd94a3cd67da552fe6ddb575a1d6f0b5597eb9d96da73827bcb1e80cf5f8f';
type Tools = { containerRuntime?: string };

async function command(argv: string[]) {
  const child = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`${argv.slice(0, 3).join(' ')} (${code}): ${stderr.slice(-2000)}`);
  return stdout.trim();
}

export async function runDgraph(root: string, tools: Tools) {
  const outRoot = resolve(root, '.temp/storage-architecture/dgraph');
  await mkdir(outRoot, { recursive: true });
  const runtime = tools.containerRuntime;
  if (!runtime) throw new Error('tools.json lacks admitted Podman runtime');
  try { await command([runtime, 'image', 'inspect', IMAGE]); }
  catch { await command([runtime, 'pull', IMAGE]); }
  const info = JSON.parse(await command([runtime, 'image', 'inspect', IMAGE]))[0];
  const image = { tag: IMAGE, id: info.Id, digest: info.RepoDigests?.[0] ?? info.Digest ?? null, inspectedAt: new Date().toISOString() };
  await Bun.write(resolve(outRoot, 'image.json'), JSON.stringify(image, null, 2));
  if (image.id !== IMAGE_ID || image.digest !== IMAGE_DIGEST) throw new Error(`Dgraph image drift: ${JSON.stringify(image)}`);
  if (process.argv.includes('--prepare-only')) return { prepared: true, image };
  if (process.argv.includes('--help-only')) return { image, zero: await command([runtime, 'run', '--rm', image.id, 'dgraph', 'zero', '--help']), alpha: await command([runtime, 'run', '--rm', image.id, 'dgraph', 'alpha', '--help']) };
  const runDir = resolve(outRoot, `run-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  await mkdir(runDir, { recursive: true });
  const server = await startServer(runtime, image.id, runDir);
  const result: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    environment: { image, runtime, runDir, endpoint: server.base, loopbackOnly: true, version: null, topology: 'one Zero, one Alpha, one rootless Podman pod' },
    fixture: { scale: 10_000, source: 'fixtureWork/oracle/sampleIds', representation: 'Work nodes with explicit occurrence and selection nodes; no RDF triple equivalence' },
    schema: SCHEMA,
    queries: QUERIES,
    checks: {},
    limitations: [
      'Standalone one-Alpha measurements do not establish distributed scaling, tablet movement, failover, or shard placement.',
      'DQL predicates and occurrence nodes model selected bounded domain cases; arbitrary variable-predicate RDF claims, qualifiers, and context evaluation need an application compiler and are not proved here.',
      'Application-owned revision and outbox nodes are graph data, not Dgraph temporal history or a PostgreSQL transactional outbox.',
      'Lost-reply behavior is simulated by discarding the first committed response and retrying the same command; no network fault proxy was injected.',
      'Synthetic 10,000 Work nodes and short single-client reads are not production performance qualifications.',
      'Data-directory byte counts include Dgraph baseline and preallocated WAL/postings files; they are not normalized storage-efficiency measurements.',
      'No SHACL validation, RDF/SPARQL interoperability, general policy compiler, or production relay/recovery protocol was implemented.'
    ]
  };
  const api = client(server.base);
  try {
    const health = await api.get('/health');
    result.environment = { ...(result.environment as object), health, version: Array.isArray(health) ? health[0]?.version : null };
    await api.post('/alter', { schema: SCHEMA });
    await runProbe(api, result, runDir);
    result.requests = api.counts;
    result.storageBytes = { zero: await directoryBytes(resolve(runDir, 'zero')), alpha: await directoryBytes(resolve(runDir, 'alpha')) };
    result.completedAt = new Date().toISOString();
  } catch (error) {
    result.error = String(error);
    result.requests = api.counts;
    throw error;
  } finally {
    for (const name of [server.alpha, server.zero]) {
      await Bun.write(resolve(runDir, `${name}.log`), await command([runtime, 'logs', name]).catch(error => String(error)));
    }
    await command([runtime, 'pod', 'rm', '-f', server.pod]).catch(error => console.error(error));
    const probe = Bun.spawn([runtime, 'pod', 'exists', server.pod], { stdout: 'pipe', stderr: 'pipe' });
    result.containerCleanupVerified = await probe.exited !== 0;
    await Bun.write(resolve(outRoot, 'results.json'), JSON.stringify(result, null, 2));
  }
  return {
    version: (result.environment as any).version,
    size: (result.checks as any).ingest.size,
    directedEdges: (result.checks as any).relations.directedEdges,
    occurrenceIds: (result.checks as any).occurrences.allIds,
    casCommitted: (result.checks as any).cas.committedAttemptCount,
    requests: result.requests,
    containerCleanupVerified: result.containerCleanupVerified,
    resultsPath: resolve(outRoot, 'results.json')
  };
}

const SCHEMA = `
work.key: string @index(hash) @upsert .
work.id: int @index(int) .
work.title: string @lang .
work.tag: int @index(int) .
work.related: [uid] .
work.occurrence: [uid] .
work.selection: [uid] .
work.head: int @index(int) .
work.payload: string .
work.baseline: bool .
work.override: string .
occ.id: string @index(hash) .
occ.predicate: string @index(hash) .
occ.object: string @index(hash) .
occ.qualifier: string @index(hash) .
occ.context: string @index(hash) .
sel.context: string @index(hash) .
sel.state: string @index(hash) .
sel.revision: int .
history.key: string @index(hash) .
history.rev: int @index(int) .
history.payload: string .
receipt.key: string @index(hash) @upsert .
receipt.rev: int .
outbox.key: string @index(hash) @upsert .
outbox.rev: int .
`;

const QUERIES = {
  sample: `query sample($id: int) { work(func: eq(work.id, $id)) { uid work.id work.title@en work.title@zh work.tag work.head work.payload work.baseline work.override work.related { work.id } } }`,
  occurrence: `{ work(func: eq(work.key, "pilot")) { work.occurrence { occ.id occ.predicate occ.object occ.qualifier occ.context } work.selection { sel.context sel.state sel.revision } } }`,
  authority: `{ work(func: eq(work.key, "authority")) { uid work.head work.payload } history(func: eq(history.key, "authority")) { history.rev history.payload } receipt(func: has(receipt.key)) { receipt.key receipt.rev } outbox(func: has(outbox.key)) { outbox.key outbox.rev } }`
};

async function startServer(runtime: string, imageId: string, runDir: string) {
  const stamp = `${process.pid}-${Date.now()}`;
  const pod = `rezics-dgraph-${stamp}`;
  const zero = `${pod}-zero`;
  const alpha = `${pod}-alpha`;
  const port = await freePort();
  await mkdir(resolve(runDir, 'zero'), { recursive: true });
  await mkdir(resolve(runDir, 'alpha'), { recursive: true });
  try {
    await command([runtime, 'pod', 'create', '--name', pod, '-p', `127.0.0.1:${port}:8080`]);
    await command([runtime, 'run', '-d', '--name', zero, '--pod', pod, '-v', `${resolve(runDir, 'zero')}:/data:Z,U`, imageId,
      'dgraph', 'zero', '--my', 'localhost:5080', '--cwd', '/data', '--wal', '/data/zw', '--telemetry', 'reports=false']);
    await command([runtime, 'run', '-d', '--name', alpha, '--pod', pod, '-v', `${resolve(runDir, 'alpha')}:/data:Z,U`, imageId,
      'dgraph', 'alpha', '--my', 'localhost:7080', '--zero', 'localhost:5080', '--cwd', '/data', '--postings', '/data/p', '--wal', '/data/w', '--tmp', '/data/t', '--telemetry', 'reports=false', '--cache', 'size-mb=256', '--security', 'whitelist=0.0.0.0/0']);
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 100; i++) {
      try {
        const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) });
        if (health.ok) return { base, pod, zero, alpha };
      } catch {}
      await Bun.sleep(500);
    }
    throw new Error(`Dgraph Alpha not healthy; ${await command([runtime, 'logs', alpha])}`);
  } catch (error) {
    await command([runtime, 'pod', 'rm', '-f', pod]).catch(() => {});
    throw error;
  }
}

function client(base: string) {
  const counts: Record<string, number> = {};
  async function send(method: string, path: string, body?: unknown, type = 'application/json') {
    counts[`${method} ${path.split('?')[0]}`] = (counts[`${method} ${path.split('?')[0]}`] ?? 0) + 1;
    const serialized = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const response = await fetch(base + path, { method, headers: serialized === undefined ? undefined : { 'content-type': type }, body: serialized, signal: AbortSignal.timeout(60_000) });
    const text = await response.text();
    let parsed: any;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    if (!response.ok || (parsed && typeof parsed === 'object' && parsed.errors?.length)) throw new Error(`${method} ${path}: ${response.status} ${text.slice(0, 1500)}`);
    return parsed;
  }
  return {
    counts,
    get: (path: string) => send('GET', path),
    post: (path: string, body: unknown, type?: string) => send('POST', path, body, type),
    query: (query: string, variables?: Record<string, string>) => send('POST', '/query', variables ? { query, variables } : query, variables ? 'application/json' : 'application/dql'),
    mutate: (set: unknown) => send('POST', '/mutate?commitNow=true', { set }),
    upsert: (body: string) => send('POST', '/mutate?commitNow=true', body, 'application/rdf')
  };
}

type Api = ReturnType<typeof client>;
const rows = (result: any, key: string): any[] => result?.data?.[key] ?? [];
function verify(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function equal(actual: unknown, expected: unknown, message: string) {
  verify(JSON.stringify(actual) === JSON.stringify(expected), `${message}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
}
function selected(baseline: boolean, local: 'absent' | 'accept' | 'reject' | 'unavailable') {
  if (local === 'unavailable') throw new Error('context checkpoint unavailable');
  return local === 'accept' ? true : local === 'reject' ? false : baseline;
}

async function runProbe(api: Api, result: Record<string, unknown>, runDir: string) {
  const checks = result.checks as Record<string, unknown>;
  const size = 10_000;
  const uids: string[] = [];
  const ingestStart = performance.now();
  for (let offset = 0; offset < size; offset += 250) {
    const set = Array.from({ length: Math.min(250, size - offset) }, (_, j) => {
      const w = fixtureWork(offset + j, size);
      return {
        uid: `_:work${w.id}`, 'work.key': `work-${w.id}`, 'work.id': w.id,
        'work.title@en': w.title, 'work.title@zh': `作品 ${w.id}`, 'work.tag': w.tag,
        'work.head': w.revision, 'work.payload': w.payload, 'work.baseline': w.baseline,
        ...(w.override === null ? {} : { 'work.override': w.override })
      };
    });
    const reply = await api.mutate(set);
    for (let j = 0; j < set.length; j++) {
      const uid = reply.data?.uids?.[`work${offset + j}`];
      verify(typeof uid === 'string', `Missing UID for work ${offset + j}: ${JSON.stringify(reply).slice(0, 500)}`);
      uids.push(uid);
    }
  }
  checks.ingest = { size, chunks: Math.ceil(size / 250), elapsedMs: Number((performance.now() - ingestStart).toFixed(3)), uidCount: uids.length };
  const relatedStart = performance.now();
  for (let offset = 0; offset < size; offset += 250) {
    const set = Array.from({ length: Math.min(250, size - offset) }, (_, j) => {
      const w = fixtureWork(offset + j, size);
      return { uid: uids[w.id], 'work.related': w.related.map(id => ({ uid: uids[id] })) };
    });
    await api.mutate(set);
  }
  checks.relations = { elapsedMs: Number((performance.now() - relatedStart).toFixed(3)), directedEdges: Array.from({ length: size }, (_, i) => fixtureWork(i, size).related.length).reduce((a, b) => a + b, 0) };
  const samples: any[] = [];
  for (const expected of oracle(size, sampleIds(size))) {
    const response = await api.query(QUERIES.sample, { $id: String(expected.id) });
    const actual = rows(response, 'work')[0];
    verify(actual, `Missing work ${expected.id}`);
    equal(actual['work.id'], expected.id, 'Sample work ID');
    equal(actual['work.title@en'], expected.title, 'English title');
    equal(actual['work.title@zh'], `作品 ${expected.id}`, 'Chinese title');
    equal(actual['work.tag'], expected.tag, 'Tag');
    equal(actual['work.head'], expected.revision, 'Head revision');
    equal(actual['work.payload'], expected.payload, 'Payload');
    equal(actual['work.related'].map((x: any) => x['work.id']).sort((a: number, b: number) => a - b), fixtureWork(expected.id, size).related.sort((a, b) => a - b), 'Related Work UIDs');
    samples.push({ id: expected.id, uid: actual.uid, related: actual['work.related'].length });
  }
  checks.sampleOracle = { count: samples.length, samples };
  const hop2Query = `{ work(func: eq(work.id, 0)) { work.id work.related { work.id work.related { work.id } } } }`;
  const hop2 = await api.query(hop2Query);
  const hopRoot = rows(hop2, 'work')[0];
  verify(hopRoot?.['work.related']?.length === fixtureWork(0, size).related.length, 'First hop fanout');
  const hop2Targets = new Set<number>();
  for (const branch of hopRoot['work.related']) {
    for (const target of branch['work.related'] ?? []) hop2Targets.add(target['work.id']);
  }
  const expectedHop2 = new Set<number>();
  for (const id of fixtureWork(0, size).related) for (const target of fixtureWork(id, size).related) expectedHop2.add(target);
  equal([...hop2Targets].sort((a, b) => a - b), [...expectedHop2].sort((a, b) => a - b), 'Two-hop target set');
  const warmMs: number[] = [];
  for (let i = 0; i < 10; i++) {
    const start = performance.now();
    await api.query(hop2Query);
    warmMs.push(Number((performance.now() - start).toFixed(3)));
  }
  checks.hop2 = { anchor: 0, firstHopCount: hopRoot['work.related'].length, distinctTargets: hop2Targets.size, warmMs, query: hop2Query };

  const pilot = {
    uid: '_:pilot', 'work.key': 'pilot', 'work.id': size,
    'work.occurrence': [
      { uid: '_:occ1', 'occ.id': 'credit-1', 'occ.predicate': 'credit', 'occ.object': 'agent:A', 'occ.qualifier': 'author', 'occ.context': 'global' },
      { uid: '_:occ2', 'occ.id': 'credit-2', 'occ.predicate': 'credit', 'occ.object': 'agent:A', 'occ.qualifier': 'translator', 'occ.context': 'global' },
      { uid: '_:occ3', 'occ.id': 'credit-3', 'occ.predicate': 'credit', 'occ.object': 'agent:B', 'occ.qualifier': 'author', 'occ.context': 'realm' },
      { uid: '_:occ4', 'occ.id': 'claim-1', 'occ.predicate': 'classification', 'occ.object': 'sense:42', 'occ.qualifier': 'primary', 'occ.context': 'realm' }
    ],
    'work.selection': [{ uid: '_:sel1', 'sel.context': 'global', 'sel.state': 'accept', 'sel.revision': 1 }, { uid: '_:sel2', 'sel.context': 'realm', 'sel.state': 'reject', 'sel.revision': 2 }]
  };
  await api.mutate(pilot);
  const occurrenceQuery = `{ work(func: eq(work.key, "pilot")) { work.occurrence @filter(eq(occ.object, "agent:A") AND eq(occ.qualifier, "author")) { occ.id occ.predicate occ.object occ.qualifier occ.context } } }`;
  const occurrenceResult = await api.query(occurrenceQuery);
  const selectedOccurrences = rows(occurrenceResult, 'work')[0]?.['work.occurrence'] ?? [];
  equal(selectedOccurrences.map((x: any) => x['occ.id']), ['credit-1'], 'Same occurrence author/A filter');
  const detail = await api.query(QUERIES.occurrence);
  const claimQuery = `query claim($predicate: string, $object: string) { work(func: eq(work.key, "pilot")) { work.occurrence @filter(eq(occ.predicate, $predicate) AND eq(occ.object, $object)) { occ.id occ.predicate occ.object occ.qualifier occ.context } } }`;
  const claimResult = await api.query(claimQuery, { $predicate: 'classification', $object: 'sense:42' });
  equal(rows(claimResult, 'work')[0]?.['work.occurrence']?.map((x: any) => x['occ.id']), ['claim-1'], 'Parameterized predicate/object occurrence');
  const pilotDetail = rows(detail, 'work')[0];
  equal(pilotDetail['work.occurrence'].length, 4, 'Distinct identified occurrences retained');
  const local = pilotDetail['work.selection'].find((x: any) => x['sel.context'] === 'realm');
  equal(local['sel.state'], 'reject', 'Realm rejection stored');
  checks.occurrences = { sameOccurrenceIds: selectedOccurrences.map((x: any) => x['occ.id']), variablePredicateIds: rows(claimResult, 'work')[0]?.['work.occurrence']?.map((x: any) => x['occ.id']), allIds: pilotDetail['work.occurrence'].map((x: any) => x['occ.id']).sort(), query: occurrenceQuery, claimQuery, raw: occurrenceResult, claimRaw: claimResult };
  checks.selection = { global: true, realm: local['sel.state'], absentInherits: selected(true, 'absent'), acceptOverrides: selected(false, 'accept'), rejectShadows: selected(true, 'reject'), unavailableThrows: false, raw: detail };
  try { selected(true, 'unavailable'); } catch (error) { checks.selection = { ...(checks.selection as object), unavailableThrows: String(error).includes('checkpoint unavailable') }; }
  verify((checks.selection as any).unavailableThrows, 'Unavailable context must fail readiness');
  const contextCases = [
    { key: 'context-absent', baseline: true, state: 'absent', expected: true },
    { key: 'context-accept', baseline: false, state: 'accept', expected: true },
    { key: 'context-reject', baseline: true, state: 'reject', expected: false },
    { key: 'context-unavailable', baseline: true, state: 'unavailable', expected: 'error' }
  ] as const;
  await api.mutate(contextCases.map((c, i) => ({
    uid: `_:context${i}`, 'work.key': c.key, 'work.baseline': c.baseline,
    ...(c.state === 'absent' ? {} : { 'work.selection': [{ uid: `_:contextSelection${i}`, 'sel.context': 'realm', 'sel.state': c.state, 'sel.revision': 2 }] })
  })));
  const contextResults: any[] = [];
  for (const c of contextCases) {
    const response = await api.query(`{ work(func: eq(work.key, "${c.key}")) { work.key work.baseline work.selection { sel.context sel.state sel.revision } } }`);
    const stored = rows(response, 'work')[0];
    verify(stored, `Missing stored context case ${c.key}`);
    const state = stored['work.selection']?.find((x: any) => x['sel.context'] === 'realm')?.['sel.state'] ?? 'absent';
    equal(state, c.state, 'Stored local context state');
    let actual: boolean | 'error';
    try { actual = selected(stored['work.baseline'], state); } catch { actual = 'error'; }
    equal(actual, c.expected, `Resolved context ${c.key}`);
    contextResults.push({ key: c.key, stored, actual });
  }
  checks.selection = { ...(checks.selection as object), storedCases: contextResults, method: 'DQL exact Work lookup followed by application precedence/readiness evaluator; no native selection operator' };

  await api.mutate([
    { uid: '_:authority', 'work.key': 'authority', 'work.head': 1, 'work.payload': 'payload-v1' },
    { uid: '_:history1', 'history.key': 'authority', 'history.rev': 1, 'history.payload': 'payload-v1' }
  ]);
  const casAttempts = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => api.upsert(casMutation(`cmd-${i}`, i, 1, 2))));
  const accepted = casAttempts.map((attempt, i) => ({ i, status: attempt.status, value: attempt.status === 'fulfilled' ? attempt.value : String(attempt.reason) }));
  const committedAttempts = accepted.filter((attempt: any) => Object.keys(attempt.value?.data?.uids ?? {}).length > 0);
  equal(committedAttempts.length, 1, 'Exactly one CAS mutation committed');
  const state = await api.query(QUERIES.authority);
  const head = rows(state, 'work')[0];
  const receipts = rows(state, 'receipt');
  const outbox = rows(state, 'outbox');
  const history = rows(state, 'history');
  verify(head?.['work.head'] === 2 && receipts.length === 1 && outbox.length === 1 && history.length === 2, `CAS invariant failed: ${JSON.stringify(state)}`);
  const winningKey = receipts[0]['receipt.key'];
  equal(outbox[0]['outbox.key'], winningKey, 'Receipt/outbox command key');
  equal(outbox[0]['outbox.rev'], 2, 'Outbox revision');
  const old = history.find((x: any) => x['history.rev'] === 1);
  equal(old?.['history.payload'], 'payload-v1', 'Exact old revision payload');
  const exactOldQuery = `{ history(func: eq(history.rev, 1)) @filter(eq(history.key, "authority")) { history.rev history.payload } }`;
  const exactOld = await api.query(exactOldQuery);
  equal(rows(exactOld, 'history'), [{ 'history.rev': 1, 'history.payload': 'payload-v1' }], 'Exact old revision query after edit');
  const retry = await api.upsert(casMutation(winningKey, Number(winningKey.slice(4)), 1, 2));
  const afterRetry = await api.query(QUERIES.authority);
  equal(rows(afterRetry, 'receipt').length, 1, 'Lost-reply retry receipt count');
  equal(rows(afterRetry, 'outbox').length, 1, 'Lost-reply retry outbox count');
  let failedMutation = '';
  try { await api.upsert(invalidMutation()); } catch (error) { failedMutation = String(error); }
  verify(failedMutation.length > 0, 'Malformed transaction should fail');
  const afterFailed = await api.query(QUERIES.authority);
  equal(rows(afterFailed, 'history').length, 2, 'Failed mutation history count');
  equal(rows(afterFailed, 'outbox').length, 1, 'Failed mutation outbox count');
  checks.cas = { attempts: accepted, committedAttemptCount: committedAttempts.length, winner: winningKey, head, receipt: receipts, outbox, history, exactOldQuery, exactOld, retry, failedMutation, afterFailed };
  result.queries = { ...QUERIES, hop2Query, occurrenceQuery, claimQuery, exactOldQuery, casExample: casMutation('cmd-example', 0, 1, 2), invalidExample: invalidMutation() };
  await Bun.write(resolve(runDir, 'schema.dql'), SCHEMA);
  await Bun.write(resolve(runDir, 'queries.json'), JSON.stringify(result.queries, null, 2));
}

const XSD_INT = '<http://www.w3.org/2001/XMLSchema#int>';
function literal(value: string) { return JSON.stringify(value); }
function casMutation(commandKey: string, variant: number, expected: number, next: number) {
  const payload = `payload-v${next}-writer-${variant}`;
  const query = `{ v as var(func: eq(work.key, "authority")) @filter(eq(work.head, ${expected})) r as var(func: eq(receipt.key, ${literal(commandKey)})) }`;
  const body = `upsert {
  query ${query}
  mutation @if(eq(len(v), 1) AND eq(len(r), 0)) {
    set {
      uid(v) <work.head> "${next}"^^${XSD_INT} .
      uid(v) <work.payload> ${literal(payload)} .
      _:history <history.key> "authority" .
      _:history <history.rev> "${next}"^^${XSD_INT} .
      _:history <history.payload> ${literal(payload)} .
      _:receipt <receipt.key> ${literal(commandKey)} .
      _:receipt <receipt.rev> "${next}"^^${XSD_INT} .
      _:outbox <outbox.key> ${literal(commandKey)} .
      _:outbox <outbox.rev> "${next}"^^${XSD_INT} .
    }
  }
}`;
  return body;
}
function invalidMutation() {
  return `upsert { query { v as var(func: eq(work.key, "authority")) @filter(eq(work.head, 2)) } mutation @if(eq(len(v), 1)) { set { uid(v) <work.head> "not-an-int"^^${XSD_INT} . _:failed <outbox.key> "failed" . } } }`;
}
