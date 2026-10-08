import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FusekiClient, FusekiQueryResponseTooLarge, type SparqlResult }
  from '../../../services/main/src/infrastructure/fuseki.ts';
import { DATASET, GRAPHS, RV, hash, initializeFreshGraph, iri, lit }
  from '../../../services/main/src/modules/work/activate.ts';
import { MAIN_RELAY_STREAM_SCOPE } from '../../../services/main/src/modules/outbox/relay-position.ts';
import { cutoverRestoredGraphLineage, readRestoredGraphReleaseProof, type RestoredGraphReleaseExpectation }
  from '../../../services/main/src/modules/work/restore-lineage.ts';
import { docker } from '../../../scripts/operations/search-state.ts';
import { fusekiSecrets, pinnedImage, qaStack, standaloneFuseki }
  from '../fault-recovery/search-ops-support.ts';

type Row = NonNullable<SparqlResult['results']>['bindings'][number];
const directory = resolve(import.meta.dir, '../../../.temp', `restore-release-proof-${randomUUID()}`);
const volume = `rezics-release-proof-${randomUUID()}`;
let graph: Awaited<ReturnType<typeof standaloneFuseki>>;
let qa: ReturnType<typeof qaStack>;
let fuseki: FusekiClient;

beforeAll(async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through isolated Task QA');
  qa = qaStack(Bun.env.REZICS_QA_RUN_ID);
  graph = await standaloneFuseki(qa.dockerEnv, { name: volume, volume, image: pinnedImage(),
    secrets: fusekiSecrets(qa.composeEnv) });
  fuseki = new FusekiClient(graph.url, qa.composeEnv.FUSEKI_MAINTENANCE_TOKEN, qa.composeEnv.FUSEKI_COMMAND_TOKEN);
  mkdirSync(directory, { recursive: true });
}, 120_000);

afterAll(() => {
  graph?.remove();
  if (qa) docker(['volume', 'rm', '-f', volume], qa.dockerEnv);
  rmSync(directory, { recursive: true, force: true });
}, 120_000);

/** Corruption is confined to a stopped, disposable TDB2 copy under its owner lock. */
async function loadCopy(update: string) {
  graph.runner.stop();
  try {
    graph.runner.offline(`exec 9>>/fuseki/databases/rezics/owner.lock
flock -n 9
cat > /tmp/restore-release-proof.ru <<'RESTORE_RELEASE_PROOF'
${update}
RESTORE_RELEASE_PROOF
java -Xmx512m -cp /opt/apache-jena-fuseki-6.2.0/fuseki-server.jar \\
  tdb2.tdbupdate --loc=/fuseki/databases/rezics/tdb2 --update=/tmp/restore-release-proof.ru`);
  } finally { await graph.runner.start(); }
}

function rdf(term: Row[string]) {
  if (term.type === 'uri') return `<${term.value}>`;
  if (term.type !== 'literal') throw new Error('native fixture must contain only named subjects and literals');
  return `${lit(term.value)}${term['xml:lang'] ? '@' + term['xml:lang']
    : term.datatype ? `^^<${term.datatype}>` : ''}`;
}

function restore(rows: Row[]) {
  return `CLEAR GRAPH ${iri(GRAPHS.control)}; CLEAR GRAPH ${iri(GRAPHS.receipts)};
    INSERT DATA { ${rows.map(row => `GRAPH ${rdf(row.graph!)} {
      ${rdf(row.subject!)} ${rdf(row.predicate!)} ${rdf(row.object!)} . }`).join('\n')} }`;
}

async function nativeReleased(paired: boolean, advanced: boolean) {
  const started = Date.now();
  await loadCopy('DROP ALL');
  const prior = { dataEpoch: randomUUID(), routingEpoch: '1', sequence: '900' };
  const lineage = { dataEpoch: randomUUID(), routingEpoch: '2' };
  await initializeFreshGraph(fuseki, prior);
  await loadCopy(`PREFIX rv: <${RV}>
    DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?old .
      ${iri(MAIN_RELAY_STREAM_SCOPE)} rv:streamSequence ?main . } }
    INSERT { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence 900 .
      ${iri(MAIN_RELAY_STREAM_SCOPE)} rv:streamSequence 4 . } }
    WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?old .
      ${iri(MAIN_RELAY_STREAM_SCOPE)} rv:streamSequence ?main . } }`);
  expect(await cutoverRestoredGraphLineage(fuseki, { prior, next: lineage })).toMatchObject({ sequence: '0', replayed: false });
  const marker = `urn:rezics:restore:${lineage.dataEpoch}`;
  // An old marker is a supported legacy input to the actual native release family.
  if (!paired || advanced) await loadCopy(`PREFIX rv: <${RV}>
    ${!paired ? `DELETE DATA { GRAPH ${iri(GRAPHS.control)} { ${iri(marker)} rv:priorMainSequence 4 } };` : ''}
    ${advanced ? `INSERT DATA { GRAPH ${iri(GRAPHS.control)} { ${iri(marker)} rv:reconciledPriorSequence 1100
      ${paired ? '; rv:reconciledPriorMainSequence 7' : ''} } }` : ''}`);
  const main = (sequence: string) => ({ streamScope: MAIN_RELAY_STREAM_SCOPE, dataEpoch: prior.dataEpoch, sequence });
  const expected: RestoredGraphReleaseExpectation = { lineage, restoreCutover: marker,
    saved: { dataEpoch: prior.dataEpoch, graphSequence: '900', ...(paired ? { main: main('4') } : {}) },
    effective: { dataEpoch: prior.dataEpoch, graphSequence: advanced ? '1100' : '900',
      ...(paired ? { main: main(advanced ? '7' : '4') } : {}) } };
  const receipt = `urn:rezics:receipt:restore-release:${hash(lineage.dataEpoch)}`;
  const digest = hash(JSON.stringify(paired
    ? { family: 'restore-release-v2', lineage, priorDataEpoch: prior.dataEpoch,
      priorSequence: expected.effective.graphSequence, priorMainSequence: expected.effective.main!.sequence,
      streamScope: MAIN_RELAY_STREAM_SCOPE }
    : { family: 'restore-release-v1', lineage, priorDataEpoch: prior.dataEpoch,
      priorSequence: expected.effective.graphSequence }));
  // The existing writer's five/seven predicates, accepted by the native command invariant.
  const command = { receipt, digest, validations: [], deadlineMs: 10_000,
    update: `PREFIX rv: <${RV}>
    DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
    INSERT { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ;
      rv:requestDigest ${lit(digest)} ; rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(lineage.dataEpoch)} ; rv:sequence 0
      ${paired ? `; rv:priorMainSequence ${expected.effective.main!.sequence} ; rv:streamScope ${lit(MAIN_RELAY_STREAM_SCOPE)}` : ''} . } }
    WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(lineage.dataEpoch)} ;
      rv:routingEpoch ${lit(lineage.routingEpoch)} ; rv:sequence 0 ; rv:restoreCutover ${iri(marker)} ; rv:restoreHold true .
      ${iri(marker)} rv:priorDataEpoch ${lit(prior.dataEpoch)} ; rv:priorSequence ?saved .
      OPTIONAL { ${iri(marker)} rv:reconciledPriorSequence ?cursor }
      FILTER(COALESCE(?cursor, ?saved) = ${expected.effective.graphSequence}) }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } } }` };
  expect(await readRestoredGraphReleaseProof(fuseki, expected)).toBeNull();
  expect(await fuseki.commandWithReceipt(command)).toMatchObject({ status: 'committed' });
  const proof = await readRestoredGraphReleaseProof(fuseki, expected);
  expect(proof).toEqual({ expectation: expected, receipt: { id: receipt, requestDigest: digest, dataEpoch: lineage.dataEpoch, sequence: '0' } });
  // Preserve the native analyzer facts and use one captured baseline for every corrupt copy.
  const baseline = (await fuseki.query(`SELECT ?graph ?subject ?predicate ?object WHERE {
    VALUES ?graph { ${iri(GRAPHS.control)} ${iri(GRAPHS.receipts)} }
    GRAPH ?graph { ?subject ?predicate ?object } } LIMIT 100`)).results!.bindings;
  expect(baseline.length).toBeLessThan(100);
  expect(baseline.some(row => row.predicate!.value === RV + 'textIndexGeneration')).toBe(true);
  expect(baseline.filter(row => row.subject!.value === receipt)).toHaveLength(paired ? 7 : 5);
  writeFileSync(resolve(directory, `${paired ? 'paired' : 'legacy'}-baseline.json`), JSON.stringify(baseline));
  expect(Date.now() - started).toBeLessThan(600_000);
  return { expected, baseline, receipt, proof };
}

test('actual legacy native release preserves its ordered v1 receipt and analyzer state', async () => {
  const f = await nativeReleased(false, false);
  expect(await readRestoredGraphReleaseProof(fuseki, f.expected)).toEqual(f.proof);
  const fields = structuredClone(f.baseline);
  fields.find(row => row.subject!.value === f.receipt && row.predicate!.value === RV + 'datasetId')!.object = { type: 'uri', value: 'urn:rezics:dataset:wrong' };
  await loadCopy(restore(fields));
  expect(await readRestoredGraphReleaseProof(fuseki, f.expected)).toBeNull();
}, 120_000);

test('actual paired native release rejects malformed complete subjects, holds, cursors and restored counters', async () => {
  const f = await nativeReleased(true, true);
  const replace = (rows: Row[], subject: string, predicate: string, object: Row[string]) => {
    rows.find(row => row.subject!.value === subject && row.predicate!.value === RV + predicate)!.object = object;
  };
  const integer = (value: string, datatype = 'integer') => ({ type: 'literal', value,
    datatype: 'http://www.w3.org/2001/XMLSchema#' + datatype });
  const hold = (value: string): Row => ({ graph: { type: 'uri', value: GRAPHS.control },
    subject: { type: 'uri', value: DATASET }, predicate: { type: 'uri', value: RV + 'restoreHold' },
    object: { type: 'literal', value, datatype: 'http://www.w3.org/2001/XMLSchema#boolean' } });
  // The unit inventory checks every field. Native cases qualify the real query's
  // whole subjects, hold and cursor projection, RDF term identities and bounds.
  const mutations: { name: string; change: (rows: Row[]) => void }[] = [
    { name: 'advanced restored Main counter', change: rows => replace(rows, MAIN_RELAY_STREAM_SCOPE,
      'streamSequence', integer('1')) },
    { name: 'one paired cursor missing', change: rows => { rows.splice(rows.findIndex(row =>
      row.subject!.value === f.expected.restoreCutover && row.predicate!.value === RV + 'reconciledPriorMainSequence'), 1); } },
    { name: 'unknown marker namespace', change: rows => { rows.push({
      graph: { type: 'uri', value: GRAPHS.control }, subject: { type: 'uri', value: f.expected.restoreCutover },
      predicate: { type: 'uri', value: 'https://unknown.test/vocab/priorSequence' }, object: integer('900') }); } },
    { name: 'false hold', change: rows => { rows.push(hold('false')); } },
    { name: 'competing hold values', change: rows => { rows.push(hold('false'), hold('true')); } },
    { name: 'competing receipt digest', change: rows => { rows.push({
      ...rows.find(row => row.subject!.value === f.receipt && row.predicate!.value === RV + 'requestDigest')!,
      object: { type: 'literal', value: 'wrong' } }); } },
    { name: 'stream scope wrong RDF term kind', change: rows => replace(rows, f.receipt,
      'streamScope', { type: 'uri', value: MAIN_RELAY_STREAM_SCOPE }) },
    { name: 'receipt integer wrong datatype', change: rows => replace(rows, f.receipt,
      'sequence', integer('0', 'decimal')) },
  ];
  for (const mutation of mutations) {
    const rows = structuredClone(f.baseline); mutation.change(rows);
    await loadCopy(restore(rows));
    expect(await readRestoredGraphReleaseProof(fuseki, f.expected), mutation.name).toBeNull();
  }
  const growth = structuredClone(f.baseline);
  const row = growth.find(item => item.subject!.value === f.receipt)!;
  for (let index = 0; index < 500; index++) growth.push({ ...row, predicate: { type: 'uri', value: `https://unknown.test/p${index}` } });
  await loadCopy(restore(growth));
  expect(await readRestoredGraphReleaseProof(fuseki, f.expected)).toBeNull();
  const oversized = structuredClone(f.baseline);
  oversized.find(item => item.subject!.value === f.receipt && item.predicate!.value === RV + 'requestDigest')!.object = { type: 'literal', value: 'x'.repeat(20_000) };
  await loadCopy(restore(oversized));
  await expect(readRestoredGraphReleaseProof(fuseki, f.expected)).rejects.toBeInstanceOf(FusekiQueryResponseTooLarge);
  await loadCopy(restore(f.baseline));
  expect(await readRestoredGraphReleaseProof(fuseki, f.expected)).toEqual(f.proof);
}, 300_000);

test('native release preserves opaque and long cuts with genuine absent or old legacy Main records', async () => {
  const longGraph = '9'.repeat(120), longMain = '4'.repeat(110);
  for (const shape of ['absent', 'old-no-prefix', 'paired'] as const) {
    const started = Date.now(), paired = shape === 'paired';
    await loadCopy('DROP ALL');
    const priorEpoch = `original:opaque/${shape}:α`, epoch = `restored:opaque/${shape}:β`;
    const lineage = { dataEpoch: epoch, routingEpoch: shape === 'old-no-prefix'
      ? '8'.repeat(200) : 'opaque route / β "quoted"' };
    // Main facts come only from the native bootstrap. Legacy keeps that original
    // old-epoch/zero record or removes it; it never acquires a synthetic new Main.
    await initializeFreshGraph(fuseki, paired ? lineage : { dataEpoch: priorEpoch, routingEpoch: 'original opaque route' });
    const marker = `urn:rezics:restore:${epoch}`;
    const main = (sequence: string) => ({ streamScope: MAIN_RELAY_STREAM_SCOPE, dataEpoch: priorEpoch, sequence });
    const graphAfter = (BigInt(longGraph) + 1n).toString(), mainAfter = (BigInt(longMain) + 2n).toString();
    const integer = (value: string) => `${lit(value)}^^<http://www.w3.org/2001/XMLSchema#integer>`;
    const expected: RestoredGraphReleaseExpectation = { lineage, restoreCutover: marker,
      saved: { dataEpoch: priorEpoch, graphSequence: longGraph, ...(paired ? { main: main(longMain) } : {}) },
      effective: { dataEpoch: priorEpoch, graphSequence: graphAfter, ...(paired ? { main: main(mainAfter) } : {}) } };
    // Install an old held cut, with no release receipt, on a stopped copy.
    await loadCopy(`PREFIX rv: <${RV}>
      ${shape === 'absent' ? `DELETE WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(MAIN_RELAY_STREAM_SCOPE)} ?p ?o } };` : ''}
      ${shape === 'old-no-prefix' ? `DELETE WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(MAIN_RELAY_STREAM_SCOPE)} rv:legacyThroughSequence ?prefix } };` : ''}
      DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:routingEpoch ?routing } }
      INSERT { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(epoch)} ;
        rv:routingEpoch ${lit(lineage.routingEpoch)} ; rv:restoreCutover <${marker}> ; rv:restoreHold true .
        <${marker}> a rv:RestoreCutover ; rv:dataEpoch ${lit(epoch)} ; rv:priorDataEpoch ${lit(priorEpoch)} ;
          rv:priorSequence ${integer(longGraph)} ; rv:reconciledPriorSequence ${integer(graphAfter)}
          ${paired ? `; rv:priorMainSequence ${integer(longMain)} ; rv:reconciledPriorMainSequence ${integer(mainAfter)}` : ''} . } }
      WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:routingEpoch ?routing ; rv:sequence 0 } }`);
    const currentMain = async () => (await fuseki.query(`SELECT ?predicate ?object WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(MAIN_RELAY_STREAM_SCOPE)} ?predicate ?object } } ORDER BY ?predicate LIMIT 4`)).results!.bindings;
    const before = await currentMain();
    expect(before).toHaveLength(shape === 'absent' ? 0 : paired ? 3 : 2);
    if (shape === 'old-no-prefix') {
      expect(before.find(row => row.predicate!.value === RV + 'dataEpoch')!.object!.value).toBe(priorEpoch);
      expect(before.find(row => row.predicate!.value === RV + 'streamSequence')!.object!.value).toBe('0');
      expect(before.some(row => row.predicate!.value === RV + 'legacyThroughSequence')).toBe(false);
    }
    const evidence = resolve(import.meta.dir, '../../../.temp/ref/restore-release-proof-compatibility');
    mkdirSync(evidence, { recursive: true });
    // Read stored terms before release; a writer/query cache must not conceal changed integers.
    const held = (await fuseki.query(`SELECT ?predicate ?object WHERE {
      BIND(IRI(${lit(marker)}) AS ?marker) GRAPH ${iri(GRAPHS.control)} { ?marker ?predicate ?object } } LIMIT 10`)).results!.bindings;
    writeFileSync(resolve(evidence, `${shape}-native-held.json`), JSON.stringify({ expected, held, beforeMain: before }));
    for (const [name, value] of [['priorSequence', longGraph], ['reconciledPriorSequence', graphAfter],
      ...(paired ? [['priorMainSequence', longMain], ['reconciledPriorMainSequence', mainAfter]] : [])]) {
      expect(held.find(row => row.predicate!.value === RV + name)!.object).toEqual({ type: 'literal',
        datatype: 'http://www.w3.org/2001/XMLSchema#integer', value });
    }
    const receipt = `urn:rezics:receipt:restore-release:${hash(epoch)}`;
    const digest = hash(JSON.stringify(paired
      ? { family: 'restore-release-v2', lineage, priorDataEpoch: priorEpoch, priorSequence: graphAfter,
        priorMainSequence: mainAfter, streamScope: MAIN_RELAY_STREAM_SCOPE }
      : { family: 'restore-release-v1', lineage, priorDataEpoch: priorEpoch, priorSequence: graphAfter }));
    expect(await readRestoredGraphReleaseProof(fuseki, expected)).toBeNull();
    expect(await fuseki.commandWithReceipt({ receipt, digest, validations: [], deadlineMs: 10_000,
      update: `PREFIX rv: <${RV}>
      DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      INSERT { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ; rv:requestDigest ${lit(digest)} ;
        rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(epoch)} ; rv:sequence 0
        ${paired ? `; rv:priorMainSequence ${integer(mainAfter)} ; rv:streamScope ${lit(MAIN_RELAY_STREAM_SCOPE)}` : ''} . } }
      WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(epoch)} ;
        rv:routingEpoch ${lit(lineage.routingEpoch)} ; rv:sequence 0 ; rv:restoreCutover <${marker}> ; rv:restoreHold true .
        <${marker}> rv:priorDataEpoch ${lit(priorEpoch)} ; rv:priorSequence ${integer(longGraph)} ; rv:reconciledPriorSequence ${integer(graphAfter)} . }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } } }` })).toMatchObject({ status: 'committed' });
    const proof = { expectation: expected, receipt: { id: receipt, requestDigest: digest, dataEpoch: epoch, sequence: '0' } };
    expect(await readRestoredGraphReleaseProof(fuseki, expected)).toEqual(proof);
    expect(await readRestoredGraphReleaseProof(fuseki, expected)).toEqual(proof);
    // Check before any released-copy restart can run startup's legacy upgrade.
    expect(await currentMain()).toEqual(before);
    const baseline = (await fuseki.query(`SELECT ?graph ?subject ?predicate ?object WHERE {
      VALUES ?graph { ${iri(GRAPHS.control)} ${iri(GRAPHS.receipts)} }
      GRAPH ?graph { ?subject ?predicate ?object } } LIMIT 100`)).results!.bindings;
    expect(baseline.filter(row => row.subject!.value === receipt)).toHaveLength(paired ? 7 : 5);
    writeFileSync(resolve(directory, `${shape}-compatibility-baseline.json`), JSON.stringify(baseline));
    // Retain evidence in the worktree after the disposable fixture is removed.
    writeFileSync(resolve(evidence, `${shape}-native-baseline.json`), JSON.stringify({ expected, baseline, beforeMain: before, proof }));
    expect(Date.now() - started).toBeLessThan(300_000);
  }
}, 300_000);
