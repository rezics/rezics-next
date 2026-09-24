import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { cjkDocuments, cjkQueries, sortedUnique, workloadDocument, targetCount } from './search-support';

const IMAGE = 'docker.io/openlink/virtuoso-opensource-7:7.2.17-r25-g6eb68b6-ubuntu';
const IMAGE_ID = 'a6cbc2c869d23c04b131fa2c0e1663abc347747f12efe9bd62453eab1ea8575e';
const IMAGE_DIGEST = 'docker.io/openlink/virtuoso-opensource-7@sha256:2a9914b95f8a52927a73947c87ec2727f78f87d38e41c38c379efb121f9cbed1';
const GRAPH = 'urn:rezics:virtuoso:probe';
const PASSWORD = 'rezics-virtuoso-disposable';
const workIri = (id: number) => `<urn:rezics:work:${String(id).padStart(6, '0')}>`;
type Tools = { containerRuntime?: string };

async function command(argv: string[]) {
  const process = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
  if (code !== 0) throw new Error(`${argv.slice(0, 3).join(' ')} (${code}): ${stderr.slice(-2000)}`);
  return stdout.trim();
}

export async function runVirtuoso(root: string, tools: Tools) {
  const dir = resolve(root, '.temp/storage-architecture/virtuoso');
  await mkdir(dir, { recursive: true });
  const runtime = tools.containerRuntime;
  if (!runtime) throw new Error('tools.json lacks admitted Podman runtime');
  try { await command([runtime, 'image', 'inspect', IMAGE]); }
  catch { await command([runtime, 'pull', IMAGE]); }
  const info = JSON.parse(await command([runtime, 'image', 'inspect', IMAGE]))[0];
  const image = { tag: IMAGE, id: info.Id as string, digest: (info.RepoDigests?.[0] ?? info.Digest ?? null) as string | null, inspectedAt: new Date().toISOString() };
  await Bun.write(resolve(dir, 'image.json'), JSON.stringify(image, null, 2));
  if (process.argv.includes('--prepare-only')) return { prepared: true, image };
  if (image.id !== IMAGE_ID || image.digest !== IMAGE_DIGEST) throw new Error(`Virtuoso image drift: ${JSON.stringify(image)}`);
  const container = `rezics-virtuoso-probe-${process.pid}`;
  const database = resolve(dir, `database-r25-${Date.now()}`);
  await mkdir(database, { recursive: true });
  const scripts = resolve(dir, 'scripts');
  await mkdir(scripts, { recursive: true });
  const result: Record<string, unknown> = { generatedAt: new Date().toISOString(), image, queries: [], sqlSessions: 0, httpRequests: 0,
    documentation: ['https://docs.openlinksw.com/virtuoso/sparqlextensions/', 'https://docs.openlinksw.com/virtuoso/fn_explain/', 'https://hub.docker.com/r/openlink/virtuoso-opensource-7'],
    limitations: ['Fixed synthetic 50k or 10k roots; no production concurrency, durability, memory, CJK relevance, or scale qualification.', 'Native bif:contains has different matching semantics from the NFKC/lowercase substring oracle.', 'Realm test is membership plus same-occurrence agent/role only; no contextual fallback/reject, rating, classification, or publication resolution.', 'HTTP query latency is a single first-call sample; SQL sessions are isql invocations, each potentially containing multiple statements.', 'EXPLAIN estimates and join order do not establish actual internal postings examined or constant work.'] };
  let started = false;
  try {
    const version = await command([runtime, 'run', '--rm', image.id, 'version']);
    result.version = version;
    if (!/Version 7\.2\.17\.3243-pthreads .*\(c4fd28e38e\)/.test(version)) throw new Error(`Binary version mismatch: ${version}`);
    await command([runtime, 'run', '--rm', '-d', '--name', container, '-e', `DBA_PASSWORD=${PASSWORD}`, '-p', '127.0.0.1::8890', '-v', `${database}:/database:Z,U`, '-v', `${scripts}:/probe:ro,Z`, image.id]);
    started = true;
    const portLine = await command([runtime, 'port', container, '8890/tcp']);
    const match = portLine.match(/127\.0\.0\.1:(\d+)/);
    if (!match) throw new Error(`Unexpected endpoint binding ${portLine}`);
    const endpoint = `http://127.0.0.1:${match[1]}/sparql`;
    result.endpoint = endpoint;
    for (let i = 0; i < 120; i++) {
      try { if ((await fetch(endpoint, { signal: AbortSignal.timeout(1000) })).ok) break; } catch { /* startup */ }
      if (i === 119) throw new Error('Virtuoso HTTP startup timeout');
      await Bun.sleep(1000);
    }
    const sql = async (name: string, source: string) => {
      const file = resolve(scripts, `${name}.sql`);
      await Bun.write(file, source);
      (result.sqlSessions as number)++;
      const output = await command([runtime, 'exec', container, 'isql', '1111', 'dba', PASSWORD, 'VERBOSE=OFF', `/probe/${name}.sql`]);
      await Bun.write(resolve(dir, `${name}.out.txt`), output);
      if (/\*\*\* Error|SQLSTATE\[|^Error /mi.test(output)) throw new Error(`${name} SQL: ${output.slice(-2000)}`);
      return output;
    };
    const query = async (name: string, sparql: string) => {
      (result.queries as any[]).push({ name, sparql });
      (result.httpRequests as number)++;
      const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/sparql-results+json' }, body: new URLSearchParams({ query: sparql }), signal: AbortSignal.timeout(120000) });
      const body = await response.text();
      if (!response.ok) throw new Error(`${name} HTTP ${response.status}: ${body.slice(0,2000)}`);
      try { return JSON.parse(body) as any; } catch { throw new Error(`${name} non-JSON response: ${body.slice(0,2000)}`); }
    };
    await sql('setup', `DB.DBA.RDF_OBJ_FT_RULE_ADD('${GRAPH}', 'urn:rezics:body', 'rezics-virtuoso-probe');\n`);
    const triples = cjkDocuments.map(d => `<urn:rezics:${d.id}> <urn:rezics:body> ${JSON.stringify(d.body)} .`).join('\n');
    await sql('cjk-load', `SPARQL INSERT DATA { GRAPH <${GRAPH}> { ${triples} } };\nDB.DBA.VT_INC_INDEX_DB_DBA_RDF_OBJ ();\n`);
    const cases = [];
    for (const c of cjkQueries) {
      const term = c.input.includes(' ') ? c.input.replaceAll(' ', '" AND "') : c.input;
      const sparql = `SELECT ?s FROM <${GRAPH}> WHERE { ?s <urn:rezics:body> ?o . ?o bif:contains '${JSON.stringify(term)}' } ORDER BY ?s`;
      try {
        const response = await query(`cjk-${c.input}`, sparql);
        const actual = sortedUnique(response.results.bindings.map((b:any) => String(b.s.value).replace('urn:rezics:', '')));
        cases.push({ input: c.input, expectedNormalizedSubstring: c.expected, nativeIds: actual, matchesOracle: JSON.stringify(actual) === JSON.stringify(c.expected) });
      } catch (error) { cases.push({ input: c.input, expectedNormalizedSubstring: c.expected, error: String(error) }); }
    }
    result.cjkCases = cases;
    await sql('clear-cjk', `SPARQL CLEAR GRAPH <${GRAPH}>;\nDB.DBA.VT_INC_INDEX_DB_DBA_RDF_OBJ ();\n`);
    const scale = process.argv.includes('--scale-50000') ? 50_000 : 10_000;
    const roots = Array.from({ length: scale }, (_, i) => workloadDocument(i + 1, scale));
    const batches: string[] = [];
    for (let start = 0; start < scale; start += 500) {
      const body = roots.slice(start, start + 500).map(w => {
        const s = workIri(w.id);
        const o = `<urn:rezics:credit:${w.id}:0>`;
        const triples = [`${s} <urn:rezics:body> ${JSON.stringify(w.body)} .`, `${s} <urn:rezics:credit> ${o} .`, `${o} <urn:rezics:agent> <urn:rezics:agent:A> .`, `${o} <urn:rezics:role> "${w.id > scale - targetCount ? 'translator' : 'author'}" .`];
        if (w.realm || w.id === 513) triples.push(`${s} <urn:rezics:realm> <urn:rezics:realm:A> .`);
        if (w.id === 513) triples.push(`${s} <urn:rezics:credit> <urn:rezics:credit:513:1> .`, '<urn:rezics:credit:513:1> <urn:rezics:agent> <urn:rezics:agent:B> .', '<urn:rezics:credit:513:1> <urn:rezics:role> "translator" .');
        return triples.join('\n');
      }).join('\n');
      batches.push(`SPARQL INSERT DATA { GRAPH <${GRAPH}> { ${body} } };`);
    }
    const ingestStart = performance.now();
    await sql('workload-load', `${batches.join('\n')}\nDB.DBA.VT_INC_INDEX_DB_DBA_RDF_OBJ ();\n`);
    result.ingestMs = performance.now() - ingestStart;
    result.workload = { scale, realmMemberCount: 513 + targetCount, targetIds: roots.slice(-targetCount).map(w => w.id), tripleCount: 4 * scale + 513 + targetCount + 3, term: '中文', negativeControl: 'work:000513 has matching text and Realm, agent A as author on occurrence 0 and agent B as translator on occurrence 1' };
    const textPattern = `?s <urn:rezics:body> ?o . ?o bif:contains '"中文"' option (score ?rankScore) .`;
    const joinedWhere = `${textPattern} ?s <urn:rezics:realm> <urn:rezics:realm:A> . ?s <urn:rezics:credit> ?occ . ?occ <urn:rezics:agent> <urn:rezics:agent:A> ; <urn:rezics:role> "translator" .`;
    const broad = `SELECT ?s ?rankScore FROM <${GRAPH}> WHERE { ${textPattern} } ORDER BY DESC(?rankScore) ?s LIMIT 100`;
    const joined = `SELECT ?s ?rankScore FROM <${GRAPH}> WHERE { ${joinedWhere} } ORDER BY DESC(?rankScore) ?s LIMIT 5`;
    const ids = (response: any): number[] => (response.results.bindings as any[]).map((b:any) => {
      const value = String(b.s.value);
      if (!/^urn:rezics:work:\d{6}$/.test(value)) throw new Error(`Unexpected non-work subject in workload query: ${value}`);
      return Number(value.slice(-6));
    });
    const broadStart = performance.now();
    const broadResponse = await query('text-top100', broad);
    const broadIds = ids(broadResponse);
    const joinedStart = performance.now();
    const joinedResponse = await query('joined-top5', joined);
    const joinedIds = ids(joinedResponse);
    result.ranking = { broadTop100Ids: broadIds, broadTop100RealmResidualIds: broadIds.filter(id => roots[id - 1]?.realm || id === 513), broadTop100FullResidualIds: broadIds.filter(id => id > scale - targetCount), joinedIds, expectedIds: roots.slice(-5).map(w => w.id), broadFirstCallMs: joinedStart - broadStart, joinedFirstCallMs: performance.now() - joinedStart, joinedComplete: JSON.stringify([...joinedIds].sort((a,b)=>a-b)) === JSON.stringify(roots.slice(-5).map(w => w.id)) };
    if (!(result.ranking as any).joinedComplete || (result.ranking as any).broadTop100FullResidualIds.length !== 0) throw new Error(`Pre-top-K membership mismatch: ${JSON.stringify(result.ranking)}`);
    const naiveOccurrence = `SELECT ?s FROM <${GRAPH}> WHERE { ?s <urn:rezics:body> ?o ; <urn:rezics:realm> <urn:rezics:realm:A> ; <urn:rezics:credit> ?a, ?b . ?o bif:contains '"中文"' . ?a <urn:rezics:agent> <urn:rezics:agent:A> . ?b <urn:rezics:role> "translator" . FILTER (?s = ${workIri(513)}) }`;
    const sameOccurrence = `SELECT ?s FROM <${GRAPH}> WHERE { ${joinedWhere} FILTER (?s = ${workIri(513)}) }`;
    const naiveIds = ids(await query('split-occurrence-naive', naiveOccurrence));
    const sameIds = ids(await query('split-occurrence-same', sameOccurrence));
    result.occurrenceControl = { naiveIds, sameIds, expectedNaiveIds: [513], expectedSameIds: [] };
    if (JSON.stringify(naiveIds) !== '[513]' || sameIds.length !== 0) throw new Error(`Occurrence control failed: ${JSON.stringify(result.occurrenceControl)}`);
    const explainInput = joined.replaceAll("'", "''");
    const plan = await sql('joined-plan', `explain ('SPARQL ${explainInput}');\n`);
    result.plan = { file: resolve(dir, 'joined-plan.out.txt'), excerpt: plan.slice(0, 4000) };
    const updated = roots.at(-1)!;
    const changed = '修改后的正文不含查询词';
    await sql('update', `SPARQL DELETE DATA { GRAPH <${GRAPH}> { ${workIri(updated.id)} <urn:rezics:body> ${JSON.stringify(updated.body)} . } };\nSPARQL INSERT DATA { GRAPH <${GRAPH}> { ${workIri(updated.id)} <urn:rezics:body> ${JSON.stringify(changed)} . } };\nDB.DBA.VT_INC_INDEX_DB_DBA_RDF_OBJ ();\n`);
    const afterUpdate = ids(await query('after-update', joined));
    const deleted = roots.at(-2)!;
    await sql('delete', `SPARQL DELETE DATA { GRAPH <${GRAPH}> { ${workIri(deleted.id)} <urn:rezics:body> ${JSON.stringify(deleted.body)} . } };\nDB.DBA.VT_INC_INDEX_DB_DBA_RDF_OBJ ();\n`);
    const afterDelete = ids(await query('after-delete', joined));
    result.indexVisibility = { afterUpdate, afterDelete, expectedAfterUpdate: roots.slice(-5, -1).map(w => w.id), expectedAfterDelete: roots.slice(-5, -2).map(w => w.id) };
    if (JSON.stringify([...afterUpdate].sort((a,b)=>a-b)) !== JSON.stringify((result.indexVisibility as any).expectedAfterUpdate) || JSON.stringify([...afterDelete].sort((a,b)=>a-b)) !== JSON.stringify((result.indexVisibility as any).expectedAfterDelete)) throw new Error(`Index update/delete visibility failed: ${JSON.stringify(result.indexVisibility)}`);
    await Bun.write(resolve(dir, 'results.json'), JSON.stringify(result, null, 2));
    return { version, cjkPassed: cases.filter(c => c.matchesOracle).length, workload: result.workload, ranking: result.ranking, occurrenceControl: result.occurrenceControl, indexVisibility: result.indexVisibility, sqlSessions: result.sqlSessions, httpRequests: result.httpRequests };
  } catch (error) {
    result.error = String(error);
    throw error;
  } finally {
    if (started) {
      result.logs = await command([runtime, 'logs', container]).catch(String);
      await command([runtime, 'rm', '-f', container]).catch(() => {});
      const exists = Bun.spawn([runtime, 'container', 'exists', container], { stdout: 'pipe', stderr: 'pipe' });
      result.containerCleanupVerified = await exists.exited !== 0;
    }
    await Bun.write(resolve(dir, 'results.json'), JSON.stringify(result, null, 2));
  }
}
