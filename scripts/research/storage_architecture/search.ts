import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import pg from "pg";
import {
  batches, candidateBatchSize, cjkDocuments, cjkQueries, compileLucene,
  initialTopK, quoteSparqlLiteral, sortedUnique, targetCount, workloadDocument,
} from "./search-support";

type Tools = Record<string, unknown>;
type QueryResult = { head: { vars: string[] }; results: { bindings: Record<string, { value: string }>[] } };
const source = resolve(import.meta.dir, "SearchProbe.java");
const base = "https://example.test/search/";
const recommendation = "For this normalized substring workload, apply the selective Realm predicate before a bounded literal substring test when text is in the same engine. Jena graph-first CONTAINS and PostgreSQL realm-first strpos are complete over 517 subjects, and both are much cheaper here than subject-bound Jena text:query or PGroonga full-text on the common term. The PGroonga/Jena text timing difference reflects different operators and plans, not an engine-wide advantage. Retain a text index for query shapes needing its semantics or broader candidate search, and qualify its plan. A fixed topK followed by a Realm residual is partial even when it returns zero; these synthetic fixtures and seven warm repetitions do not qualify general relevance or global ranked continuation.";

function toolPath(tools: Tools, ...names: string[]): string {
  for (const name of names) if (typeof tools[name] === "string") return tools[name] as string;
  throw new Error(`missing research tool path: ${names.join(" or ")}`);
}

async function command(args: string[], quiet = false): Promise<string> {
  const p = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited,
  ]);
  if (code !== 0) throw new Error(`${args.join(" ")} exited ${code}: ${err.slice(-4000)}`);
  if (!quiet && err.trim()) process.stderr.write(err);
  return out.trim() || err.trim();
}

async function freePort(): Promise<number> {
  return await new Promise((accept, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("no loopback port"));
      server.close(() => accept(address.port));
    });
  });
}

async function dirBytes(path: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) total += await dirBytes(child);
    else if (entry.isFile()) total += (await stat(child)).size;
  }
  return total;
}

async function latencySamples(run: () => Promise<unknown>, repetitions = 7): Promise<{ samples: number[]; p50: number; p95: number }> {
  await run(); // warm the query path before the measured sequence
  const samples: number[] = [];
  for (let i = 0; i < repetitions; i++) {
    const started = performance.now();
    await run();
    samples.push(performance.now() - started);
  }
  const ordered = [...samples].sort((a, b) => a - b);
  return { samples, p50: ordered[Math.ceil(0.5 * repetitions) - 1], p95: ordered[Math.ceil(0.95 * repetitions) - 1] };
}

function sparqlTextQuery(graph: string, input: string, extra = "", limit?: number): string {
  const phrase = quoteSparqlLiteral(compileLucene(input));
  return `PREFIX text: <http://jena.apache.org/text#> PREFIX s: <${base}> SELECT DISTINCT ?s WHERE { GRAPH <${graph}> { ${extra} ?s text:query (s:body ${phrase}${limit === undefined ? "" : ` ${limit}`}) . } } ORDER BY ?s`;
}

async function jenaQuery(port: number, query: string): Promise<string[]> {
  const response = await fetch(`http://127.0.0.1:${port}/search/query`, {
    method: "POST", headers: { "content-type": "application/sparql-query", accept: "application/sparql-results+json" },
    body: query, signal: AbortSignal.timeout(120_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Fuseki ${response.status}: ${text.slice(0, 1200)} query=${query.slice(0, 800)}`);
  const data = JSON.parse(text) as QueryResult;
  return data.results.bindings.map((row) => row.s.value.slice(base.length));
}

async function startJena(java: string, jar: string, root: string, rows: number): Promise<{ port: number; loadMs: number; stop: () => Promise<void> }> {
  const port = await freePort();
  const p = Bun.spawn([java, "-Xmx6g", "--enable-native-access=ALL-UNNAMED", "-cp", jar, source, root, String(port), String(rows)], {
    stdout: "pipe", stderr: "pipe", cwd: root,
  });
  const decoder = new TextDecoder();
  let combined = "";
  let err = "";
  const errorRead = (async () => { for await (const chunk of p.stderr) err += decoder.decode(chunk); })();
  const ready = (async () => {
    for await (const chunk of p.stdout) {
      combined += decoder.decode(chunk);
      const m = combined.match(/(?:^|\n)READY (\d+) (\d+) (\d+)(?:\n|$)/);
      if (m) return Number(m[3]);
    }
    throw new Error(`Jena exited before READY: ${combined.slice(-3000)} ${err.slice(-3000)}`);
  })();
  const timer = setTimeout(() => p.kill(), 600_000);
  try {
    const loadMs = await ready;
    clearTimeout(timer);
    return { port, loadMs, stop: async () => { p.kill(); await p.exited; await errorRead; } };
  } catch (e) {
    clearTimeout(timer);
    p.kill();
    await p.exited;
    await errorRead;
    throw e;
  }
}

async function startPostgres(image: string, root: string, runtime: string, host?: string): Promise<{ client: pg.Client; stop: () => Promise<void>; imageId: string }> {
  const container = host ? [runtime, "--host", host] : [runtime];
  const imageId = await command([...container, "image", "inspect", "--format", "{{.Id}}", image], true);
  const name = `rezics-search-${process.pid}-${Date.now()}`;
  const pgRoot = resolve(root, "postgres");
  await mkdir(pgRoot, { recursive: true });
  await command([...container, "run", "--rm", "-d", "--name", name,
    "-e", "POSTGRES_PASSWORD=research", "-e", "POSTGRES_USER=research", "-e", "POSTGRES_DB=research",
    "-p", "127.0.0.1::5432", "-v", `${pgRoot}:/var/lib/postgresql:Z,U`,
    image, "postgres", "-c", "fsync=on"], true);
  try {
    const portText = await command([...container, "port", name, "5432/tcp"], true);
    const port = Number(portText.match(/:(\d+)\s*$/)?.[1]);
    if (!port) throw new Error(`could not parse Docker port: ${portText}`);
    let client: pg.Client | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      const candidate = new pg.Client({ host: "127.0.0.1", port, user: "research", password: "research", database: "research" });
      try { await candidate.connect(); client = candidate; break; } catch { await candidate.end().catch(() => {}); await Bun.sleep(300); }
    }
    if (!client) throw new Error("PGroonga container did not become ready");
    return { client, imageId, stop: async () => { await client.end(); await command([...container, "stop", name], true); } };
  } catch (error) {
    await command([...container, "stop", name], true).catch(() => {});
    throw error;
  }
}

async function insertPg(client: pg.Client, rows: number, table: string): Promise<number> {
  const started = performance.now();
  await client.query(`CREATE TABLE ${table} (id integer PRIMARY KEY, body text NOT NULL, realm boolean NOT NULL)`);
  for (let first = 1; first <= rows; first += 500) {
    const params: unknown[] = [];
    const values: string[] = [];
    for (let id = first; id <= Math.min(rows, first + 499); id++) {
      const doc = workloadDocument(id, rows);
      const n = params.length;
      values.push(`($${n + 1},$${n + 2},$${n + 3})`);
      params.push(doc.id, doc.body, doc.realm);
    }
    await client.query(`INSERT INTO ${table} (id, body, realm) VALUES ${values.join(",")}`, params);
  }
  await client.query(`CREATE INDEX ${table}_text_idx ON ${table} USING pgroonga (body pgroonga_text_full_text_search_ops_v2)`);
  await client.query(`CREATE INDEX ${table}_realm_idx ON ${table} (realm, id)`);
  await client.query(`ANALYZE ${table}`);
  return Math.round(performance.now() - started);
}

async function jenaSemantic(port: number): Promise<{ passed: number; cases: unknown[]; httpRequests: number }> {
  const cases = [];
  for (const c of cjkQueries) {
    const actual = sortedUnique(await jenaQuery(port, sparqlTextQuery("urn:search:fixtures", c.input)));
    cases.push({ input: c.input, expected: c.expected, actual, pass: JSON.stringify(actual) === JSON.stringify(sortedUnique(c.expected)) });
  }
  return { passed: cases.filter((c) => c.pass).length, cases, httpRequests: cases.length };
}

async function pgSemantic(client: pg.Client): Promise<{ passed: number; cases: unknown[]; sqlRequests: number }> {
  await client.query("CREATE TABLE search_fixtures (id text PRIMARY KEY, body text NOT NULL)");
  for (const doc of cjkDocuments) await client.query("INSERT INTO search_fixtures VALUES ($1,$2)", [doc.id, doc.body]);
  await client.query("CREATE INDEX search_fixtures_text_idx ON search_fixtures USING pgroonga (body pgroonga_text_full_text_search_ops_v2)");
  const cases = [];
  for (const c of cjkQueries) {
    const result = await client.query<{ id: string }>("SELECT id FROM search_fixtures WHERE body &@~ pgroonga_query_escape($1) ORDER BY id", [c.input]);
    const actual = sortedUnique(result.rows.map((row) => row.id));
    cases.push({ input: c.input, expected: c.expected, actual, pass: JSON.stringify(actual) === JSON.stringify(sortedUnique(c.expected)) });
  }
  return { passed: cases.filter((c) => c.pass).length, cases, sqlRequests: cases.length };
}

async function workload(client: pg.Client, port: number, rows: number): Promise<unknown> {
  const table = `search_docs_${rows}`;
  const pgLoadMs = await insertPg(client, rows, table);
  const expected = Array.from({ length: targetCount }, (_, i) => rows - targetCount + i + 1);
  const query = "中文";
  const started = performance.now();
  const textTop = await jenaQuery(port, sparqlTextQuery("urn:search:public", query, "", initialTopK));
  const jenaTopMs = performance.now() - started;
  const pgTopStart = performance.now();
  const pgTop = await client.query<{ id: number }>(`SELECT id FROM ${table} WHERE body &@~ pgroonga_query_escape($1) ORDER BY id LIMIT ${initialTopK}`, [query]);
  const pgTopMs = performance.now() - pgTopStart;
  const pgResidual = await client.query<{ id: number }>(`SELECT id FROM ${table} WHERE realm AND id = ANY($1::integer[]) ORDER BY id`, [pgTop.rows.map((r) => r.id)]);

  // The SQL Realm index supplies a small, complete candidate set. Send IDs in bounded
  // batches across the graph boundary; Fuseki still evaluates the text operator.
  const realmStart = performance.now();
  const realmRows = await client.query<{ id: number }>(`SELECT id FROM ${table} WHERE realm ORDER BY id`);
  const realmSqlMs = performance.now() - realmStart;
  const realmIds = realmRows.rows.map((r) => r.id);
  const matchIds: number[] = [];
  let jenaBatchMs = 0;
  const chunks = batches(realmIds, candidateBatchSize);
  for (const chunk of chunks) {
    const values = chunk.map((id) => `<${base}w${id}>`).join(" ");
    const sparql = sparqlTextQuery("urn:search:public", query, `VALUES ?s { ${values} }`);
    const t = performance.now();
    matchIds.push(...(await jenaQuery(port, sparql)).map((id) => Number(id.slice(1))));
    jenaBatchMs += performance.now() - t;
  }
  const exactPgStart = performance.now();
  const exactPg = await client.query<{ id: number }>(`SELECT id FROM ${table} WHERE realm AND body &@~ pgroonga_query_escape($1) ORDER BY id`, [query]);
  const exactPgMs = performance.now() - exactPgStart;
  const directJenaStart = performance.now();
  const directJena = await jenaQuery(port, sparqlTextQuery("urn:search:public", query, '?s s:realm "A" .'));
  const directJenaMs = performance.now() - directJenaStart;
  const containsQuery = `PREFIX s: <${base}> SELECT DISTINCT ?s WHERE { GRAPH <urn:search:public> { ?s s:realm "A" ; s:body ?body . FILTER(CONTAINS(?body, "中文")) } } ORDER BY ?s`;
  const containsStart = performance.now();
  const directContains = await jenaQuery(port, containsQuery);
  const directContainsMs = performance.now() - containsStart;
  const sqlBytes = await client.query<{ bytes: string }>("SELECT pg_total_relation_size($1::regclass)::text AS bytes", [table]);
  const pgExactIds = exactPg.rows.map((r) => r.id);
  const jenaExactIds = matchIds.sort((a, b) => a - b);
  const directJenaIds = directJena.map((id) => Number(id.slice(1))).sort((a, b) => a - b);
  const directContainsIds = directContains.map((id) => Number(id.slice(1))).sort((a, b) => a - b);
  if (JSON.stringify(jenaExactIds) !== JSON.stringify(expected)) throw new Error(`Jena batched candidate exchange incomplete at ${rows}: ${jenaExactIds}`);
  if (JSON.stringify(pgExactIds) !== JSON.stringify(expected)) throw new Error(`PGroonga exact Realm result incomplete at ${rows}: ${pgExactIds}`);
  if (JSON.stringify(directJenaIds) !== JSON.stringify(expected)) throw new Error(`Jena graph-first text join incomplete at ${rows}: ${directJenaIds}`);
  if (JSON.stringify(directContainsIds) !== JSON.stringify(expected)) throw new Error(`Jena graph-first CONTAINS incomplete at ${rows}: ${directContainsIds}`);
  const batchedLatency = await latencySamples(async () => {
    const ids = (await client.query<{ id: number }>(`SELECT id FROM ${table} WHERE realm ORDER BY id`)).rows.map((r) => r.id);
    const found: number[] = [];
    for (const chunk of batches(ids, candidateBatchSize)) {
      const values = chunk.map((id) => `<${base}w${id}>`).join(" ");
      found.push(...(await jenaQuery(port, sparqlTextQuery("urn:search:public", query, `VALUES ?s { ${values} }`))).map((id) => Number(id.slice(1))));
    }
    if (JSON.stringify(found.sort((a, b) => a - b)) !== JSON.stringify(expected)) throw new Error("batched replay incomplete");
  });
  const pgExactLatency = await latencySamples(async () => {
    const found = (await client.query<{ id: number }>(`SELECT id FROM ${table} WHERE realm AND body &@~ pgroonga_query_escape($1) ORDER BY id`, [query])).rows.map((r) => r.id);
    if (JSON.stringify(found) !== JSON.stringify(expected)) throw new Error("PGroonga replay incomplete");
  });
  const jenaGraphFirstLatency = await latencySamples(async () => {
    const found = (await jenaQuery(port, sparqlTextQuery("urn:search:public", query, '?s s:realm "A" .'))).map((id) => Number(id.slice(1))).sort((a, b) => a - b);
    if (JSON.stringify(found) !== JSON.stringify(expected)) throw new Error("Jena graph-first replay incomplete");
  });
  const jenaContainsLatency = await latencySamples(async () => {
    const found = (await jenaQuery(port, containsQuery)).map((id) => Number(id.slice(1))).sort((a, b) => a - b);
    if (JSON.stringify(found) !== JSON.stringify(expected)) throw new Error("Jena CONTAINS replay incomplete");
  });
  return {
    rows, expected, pgLoadMs, storage: { postgresRelationAndIndexesBytes: Number(sqlBytes.rows[0].bytes) },
    jenaInitialTopK: { candidateCount: textTop.length, realmHits: textTop.filter((id) => expected.includes(Number(id.slice(1)))),
      complete: false, reason: "topK applies before Realm residual; no snapshot continuation", ms: jenaTopMs, httpRequests: 1 },
    pgInitialTopK: { candidateCount: pgTop.rows.length, realmHits: pgResidual.rows.map((r) => r.id),
      complete: false, reason: "candidate budget exhausted before Realm residual", ms: pgTopMs, sqlRequests: 2 },
    batchedExchange: { realmCandidateCount: realmIds.length, batchSize: candidateBatchSize, resultIds: jenaExactIds,
      complete: true, sqlRequests: 1, httpRequests: chunks.length, realmSqlMs, jenaBatchMs,
      latencyMs: batchedLatency },
    pgExact: { resultIds: pgExactIds, complete: true, sqlRequests: 1, ms: exactPgMs, latencyMs: pgExactLatency },
    jenaGraphFirst: { resultIds: directJenaIds, complete: true,
      httpRequests: 1, ms: directJenaMs, latencyMs: jenaGraphFirstLatency,
      note: "single graph/text join; subject-bound text operator may invoke Lucene per subject" },
    jenaGraphFirstContains: { resultIds: directContainsIds, complete: true,
      httpRequests: 1, ms: directContainsMs, latencyMs: jenaContainsLatency,
      note: "same normalized workload semantics, evaluated on 517 Realm-bound literals" },
  };
}

async function runPgContainsControl(outRoot: string, tools: Tools): Promise<unknown> {
  const resultPath = resolve(outRoot, "results.json");
  const report = await Bun.file(resultPath).json() as Record<string, unknown>;
  const environment = report.environment as Record<string, unknown>;
  const dataRoot = environment.dataRoot;
  if (typeof dataRoot !== "string" || !dataRoot.startsWith(`${outRoot}/run-`)) {
    throw new Error("results.json does not identify a retained search-probe data root");
  }
  const image = toolPath(tools, "pgroongaImage", "searchImage");
  if (image !== environment.pgroongaImage) throw new Error("PGroonga image changed since the measured run");
  const postgres = await startPostgres(image, dataRoot,
    typeof tools.containerRuntime === "string" ? tools.containerRuntime : "docker",
    typeof tools.dockerHost === "string" ? tools.dockerHost : undefined);
  try {
    const observations = [];
    for (const rows of [10_000, 50_000]) {
      const table = `search_docs_${rows}`;
      const expected = Array.from({ length: targetCount }, (_, i) => rows - targetCount + i + 1);
      const literalSql = `SELECT id FROM ${table} WHERE realm AND strpos(body, $1) > 0 ORDER BY id`;
      const pgroongaSql = `SELECT id FROM ${table} WHERE realm AND body &@~ pgroonga_query_escape($1) ORDER BY id`;
      async function verified(sql: string): Promise<number[]> {
        const ids = (await postgres.client.query<{ id: number }>(sql, ["中文"])).rows.map((row) => row.id);
        if (JSON.stringify(ids) !== JSON.stringify(expected)) throw new Error(`incomplete result for ${rows}: ${sql}: ${ids}`);
        return ids;
      }
      const realmCandidates = Number((await postgres.client.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${table} WHERE realm`)).rows[0].count);
      if (realmCandidates !== 517) throw new Error(`unexpected Realm candidate count ${realmCandidates}`);
      const literalLatency = await latencySamples(() => verified(literalSql));
      const pgroongaLatency = await latencySamples(() => verified(pgroongaSql));
      const literalPlan = (await postgres.client.query<{ "QUERY PLAN": unknown }>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${literalSql}`, ["中文"])).rows[0]["QUERY PLAN"];
      const pgroongaPlan = (await postgres.client.query<{ "QUERY PLAN": unknown }>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${pgroongaSql}`, ["中文"])).rows[0]["QUERY PLAN"];
      observations.push({ rows, realmCandidates, expected, sqlRequestsPerLookup: 1,
        literal: { predicate: "strpos(body, $1) > 0", resultIds: expected, latencyMs: literalLatency, explainAnalyzeBuffersJson: literalPlan },
        pgroonga: { predicate: "body &@~ pgroonga_query_escape($1)", resultIds: expected, latencyMs: pgroongaLatency, explainAnalyzeBuffersJson: pgroongaPlan } });
    }
    const control = {
      measuredAt: new Date().toISOString(),
      reusedDataRoot: dataRoot,
      imageId: postgres.imageId,
      semantics: "The fixture body and query are already normalized; PostgreSQL strpos and Jena CONTAINS both test case-sensitive literal substring presence for these rows. PGroonga is a distinct full-text operator with the same five expected IDs here.",
      timing: "one warm request, then seven sequential client-observed requests per SQL shape after restarting the retained isolated PostgreSQL volume; comparison to Jena's earlier session is descriptive, not a simultaneous engine benchmark",
      observations,
    };
    report.pgContainsControl = control;
    await writeFile(resultPath, JSON.stringify(report, null, 2) + "\n");
    return { results: resultPath, pgContainsControl: observations.map((entry) => ({
      rows: entry.rows, realmCandidates: entry.realmCandidates,
      literalMs: entry.literal.latencyMs, pgroongaMs: entry.pgroonga.latencyMs,
    })) };
  } finally { await postgres.stop(); }
}

export async function runSearch(root: string, tools: Tools): Promise<unknown> {
  const outRoot = resolve(root, ".temp/storage-architecture/search");
  await mkdir(outRoot, { recursive: true });
  if (process.argv.includes("--pg-contains-control")) return runPgContainsControl(outRoot, tools);
  if (process.argv.includes("--report-only")) {
    const report = await Bun.file(resolve(outRoot, "results.json")).json() as Record<string, unknown>;
    report.recommendation = recommendation;
    await writeFile(resolve(outRoot, "results.json"), JSON.stringify(report, null, 2) + "\n");
    return { results: resolve(outRoot, "results.json"), recommendation };
  }
  const runRoot = resolve(outRoot, `run-${Date.now()}-${process.pid}`);
  await mkdir(runRoot, { recursive: true });
  const java = toolPath(tools, "java", "javaPath");
  const jar = toolPath(tools, "jenaJar", "jenaJarPath", "jenaFusekiJar");
  const result: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    environment: { java: await command([java, "-version"], true), jenaJar: jar,
      jenaJarSha1: tools.jenaSha1, dataRoot: runRoot },
    fixtureOracle: "NFKC lowercase substring containment for 11 named cases only; no general relevance claim",
  };
  let postgres: Awaited<ReturnType<typeof startPostgres>>;
  try {
    const image = toolPath(tools, "pgroongaImage", "searchImage");
    postgres = await startPostgres(image, runRoot,
      typeof tools.containerRuntime === "string" ? tools.containerRuntime : "docker",
      typeof tools.dockerHost === "string" ? tools.dockerHost : undefined);
    result.environment = { ...(result.environment as object), pgroongaImage: image,
      pgroongaImageId: postgres.imageId, pgroongaDigest: tools.pgroongaDigest,
      postgresql: (await postgres.client.query("SHOW server_version")).rows[0].server_version };
  } catch (error) {
    result.blocker = `PGroonga unavailable: ${String(error)}`;
    const jenaRoot = resolve(runRoot, "jena-10000");
    await mkdir(jenaRoot, { recursive: true });
    try {
      const jena = await startJena(java, jar, jenaRoot, 10_000);
      try { result.jenaSemantics = await jenaSemantic(jena.port); }
      finally { await jena.stop(); }
    } catch (jenaError) { result.jenaBlocker = String(jenaError); }
    await writeFile(resolve(outRoot, "results.json"), JSON.stringify(result, null, 2) + "\n");
    return result;
  }
  try {
    await postgres.client.query("CREATE EXTENSION pgroonga");
    result.environment = { ...(result.environment as object), pgroonga: (await postgres.client.query("SELECT extversion FROM pg_extension WHERE extname='pgroonga'")).rows[0].extversion };
    result.pgroongaSemantics = await pgSemantic(postgres.client);
    const runs = [];
    for (const rows of [10_000, 50_000]) {
      const jenaRoot = resolve(runRoot, `jena-${rows}`);
      await mkdir(jenaRoot, { recursive: true });
      const jena = await startJena(java, jar, jenaRoot, rows);
      try {
        if (rows === 10_000) result.jenaSemantics = await jenaSemantic(jena.port);
        const one = await workload(postgres.client, jena.port, rows) as Record<string, unknown>;
        one.jenaLoadMs = jena.loadMs;
        one.storage = { ...(one.storage as object), jenaTdbAndLuceneBytes: await dirBytes(jenaRoot) };
        runs.push(one);
      } finally { await jena.stop(); }
    }
    result.workloads = runs;
    result.recommendation = recommendation;
    return result;
  } catch (error) {
    result.error = String(error);
    throw error;
  } finally {
    await writeFile(resolve(outRoot, "results.json"), JSON.stringify(result, null, 2) + "\n");
    await postgres.stop();
  }
}
