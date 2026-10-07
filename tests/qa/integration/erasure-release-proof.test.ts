import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Client, Pool, type PoolClient } from 'pg';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { engageAccessRecoveryFence } from '../../../services/main/src/modules/access/admission.ts';
import { readRetainedNativeGraphSuppressionProof } from '../../../services/main/src/modules/erasure/custody.ts';
import { GraphErasureConflict, GraphErasureUnavailable, graphErasureReceipt, heldErasureMaintenanceClient,
  heldGraphLineageSequence, readGraphErasureProof, suppressGraphContentRevisions, suppressHeldGraphContentRevisions,
  type GraphSuppressionProof, type HeldGraphErasureAuthorization, type HeldGraphErasureProof,
  type HeldGraphErasureReplay, type ReleasedGraphErasureProof } from '../../../services/main/src/modules/erasure/graph.ts';
import { journalErasure, markErasureSuppressed, readErasure } from '../../../services/main/src/modules/erasure/journal.ts';
import { initializeRelayCheckpoint, relayMainOutboxOnce } from '../../../services/main/src/modules/outbox/relay.ts';
import { MAIN_RELAY_STREAM_SCOPE } from '../../../services/main/src/modules/outbox/relay-position.ts';
import { DATASET, GRAPHS, RV, hash, initializeFreshGraph, iri, lit } from '../../../services/main/src/modules/work/activate.ts';
import { cutoverRestoredGraphLineage, readGraphRecoverySource } from '../../../services/main/src/modules/work/restore-lineage.ts';
import { fusekiSecrets, pinnedImage, qaStack, standaloneFuseki } from '../fault-recovery/search-ops-support.ts';
import { cloneQaOwnerDatabases } from '../support/fake-delivery.ts';

type ReleaseExpectation = ReleasedGraphErasureProof['released'];
type Native = Awaited<ReturnType<typeof standaloneFuseki>>;
type Entry = { id: string; epoch: string; revisions: string[]; original: GraphSuppressionProof;
  evidenceDigest: string; journal: Awaited<ReturnType<typeof readErasure>> };
let qa: ReturnType<typeof qaStack>, databases: Awaited<ReturnType<typeof cloneQaOwnerDatabases>>;
let access: Pool, relay: Pool, relayObserver: Client, accessObserver: Client;
let source: Native, restored: Native, legacy: Native, native: FusekiClient, fuseki: FusekiClient, legacyFuseki: FusekiClient;
let generation: string, pairedRelease: ReleaseExpectation, legacyRelease: ReleaseExpectation, ownReceipt: string;
let beforeCut: HeldGraphErasureProof, afterCut: HeldGraphErasureProof;
const entries: Entry[] = [], containers: Native[] = [], volumes: string[] = [];
const suffix = randomUUID(), originalLineage = { dataEpoch: randomUUID(), routingEpoch: '7' };
const nextLineage = { dataEpoch: randomUUID(), routingEpoch: '8' };
const liveVolume = `rezics-release-proof-${suffix}-live`, cutVolume = `rezics-release-proof-${suffix}-cut`;
const restoredVolume = `rezics-release-proof-${suffix}-restored`, heldVolume = `rezics-release-proof-${suffix}-held`;
const releasedVolume = `rezics-release-proof-${suffix}-released`, legacyVolume = `rezics-release-proof-${suffix}-legacy`;

function docker(args: string[]) {
  const result = spawnSync('docker', args, { env: qa.dockerEnv, encoding: 'utf8', timeout: 60_000 });
  if (result.status !== 0) throw new Error(`isolated release proof fixture operation failed: ${result.stderr.slice(-1500)}`);
}

function copyGraph(from: string, to: string) {
  docker(['run', '--rm', '--network', 'none', '--user', '0:0', '--volume', `${from}:/from:ro`,
    '--volume', `${to}:/to`, '--entrypoint', 'sh', pinnedImage(), '-ec',
    'rm -rf /to/rezics; cp -a /from/rezics /to/rezics']);
}

async function offlineUpdate(graph: Native, update: string) {
  graph.runner.stop();
  graph.runner.offline(`exec 9>>/fuseki/databases/rezics/owner.lock
flock -n 9
mkdir -p /fuseki/databases/rezics/.temp
cat > /fuseki/databases/rezics/.temp/released-proof.ru <<'ERASURE_RELEASE_PROOF'
${update}
ERASURE_RELEASE_PROOF
java -Xmx512m -cp /opt/apache-jena-fuseki-6.2.0/fuseki-server.jar \\
  tdb2.tdbupdate --loc=/fuseki/databases/rezics/tdb2 --update=/fuseki/databases/rezics/.temp/released-proof.ru`);
  await graph.runner.start();
}

async function resetReleased() {
  restored.runner.stop();
  copyGraph(releasedVolume, restoredVolume);
  await restored.runner.start();
}

async function txid(client: PoolClient) {
  return (await client.query<{ id: string }>('SELECT txid_current()::text AS id')).rows[0]!.id;
}

async function withClients<T>(work: (clients: { accessClient: PoolClient; relayClient: PoolClient }) => Promise<T>) {
  const accessClient = await access.connect(), relayClient = await relay.connect();
  try {
    await relayClient.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    await accessClient.query('BEGIN');
    for (const client of [relayClient, accessClient]) {
      await client.query("SET LOCAL lock_timeout = '11s'");
      await client.query("SET LOCAL statement_timeout = '13s'");
    }
    // The real caller holds the allocator before any original journal/source read.
    await relayClient.query("SELECT pg_advisory_xact_lock(hashtextextended('rezics-relay-erasure-epoch', 0))");
    await accessClient.query('SELECT open FROM access.recovery_fence WHERE id FOR UPDATE');
    const relayId = await txid(relayClient), accessId = await txid(accessClient);
    const value = await work({ accessClient, relayClient });
    expect(await txid(relayClient)).toBe(relayId);
    expect(await txid(accessClient)).toBe(accessId);
    for (const client of [relayClient, accessClient]) {
      expect((await client.query('SHOW lock_timeout')).rows[0].lock_timeout).toBe('11s');
      expect((await client.query('SHOW statement_timeout')).rows[0].statement_timeout).toBe('13s');
    }
    expect((await relayObserver.query(`SELECT pg_try_advisory_xact_lock(
      hashtextextended('rezics-relay-erasure-epoch', 0)) AS available`)).rows[0].available).toBe(false);
    return value;
  } finally {
    await relayClient.query('ROLLBACK'); await accessClient.query('ROLLBACK');
    relayClient.release(); accessClient.release();
  }
}

async function releaseGraph(client: FusekiClient, expectation: ReleaseExpectation) {
  const { lineage, restoreCutover, effective } = expectation, paired = effective.main !== undefined;
  const receipt = `urn:rezics:receipt:restore-release:${hash(lineage.dataEpoch)}`;
  const digest = hash(JSON.stringify(paired
    ? { family: 'restore-release-v2', lineage, priorDataEpoch: effective.dataEpoch,
      priorSequence: effective.graphSequence, priorMainSequence: effective.main!.sequence,
      streamScope: MAIN_RELAY_STREAM_SCOPE }
    : { family: 'restore-release-v1', lineage, priorDataEpoch: effective.dataEpoch,
      priorSequence: effective.graphSequence }));
  const mainFacts = paired ? `; rv:priorMainSequence ${effective.main!.sequence}; rv:streamScope ${lit(MAIN_RELAY_STREAM_SCOPE)}` : '';
  const mainGuard = paired ? `${iri(restoreCutover)} rv:priorMainSequence ${effective.main!.sequence} .`
    : `FILTER NOT EXISTS { ${iri(restoreCutover)} rv:priorMainSequence ?main }`;
  const result = await client.commandWithReceipt({ receipt, digest, validations: [], deadlineMs: 10_000,
    update: `PREFIX rv: <${RV}>
      DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      INSERT { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt;
        rv:requestDigest ${lit(digest)}; rv:datasetId ${iri(DATASET)};
        rv:dataEpoch ${lit(lineage.dataEpoch)}; rv:sequence 0 ${mainFacts} . } }
      WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(lineage.dataEpoch)};
        rv:routingEpoch ${lit(lineage.routingEpoch)}; rv:sequence 0; rv:restoreCutover ${iri(restoreCutover)};
        rv:restoreHold true . ${iri(restoreCutover)} rv:priorDataEpoch ${lit(effective.dataEpoch)};
        rv:priorSequence ${effective.graphSequence} . ${mainGuard} }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } } }` });
  expect(result.status).toBe('committed');
  const facts = (await client.query(`SELECT ?predicate ?object WHERE {
    GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?predicate ?object } } LIMIT 8`)).results?.bindings;
  expect(facts).toHaveLength(paired ? 7 : 5);
}

beforeAll(async () => {
  const started = Date.now(), runId = Bun.env.REZICS_QA_RUN_ID;
  if (!runId) throw new Error('Run through the isolated QA integration tier');
  qa = qaStack(runId);
  databases = await cloneQaOwnerDatabases(runId, ['access', 'relay']);
  const pool = (url: string) => new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 1500 });
  access = pool(databases.urls.access); relay = pool(databases.urls.relay);
  relayObserver = new Client({ connectionString: databases.urls.relay });
  accessObserver = new Client({ connectionString: databases.urls.access });
  await relayObserver.connect(); await accessObserver.connect();
  for (const volume of [liveVolume, cutVolume, restoredVolume, heldVolume, releasedVolume, legacyVolume]) {
    docker(['volume', 'create', volume]); volumes.push(volume);
  }
  const graph = async (volume: string) => {
    const value = await standaloneFuseki(qa.dockerEnv, { name: volume, volume, image: pinnedImage(),
      secrets: fusekiSecrets(qa.composeEnv) });
    containers.push(value); return value;
  };
  source = await graph(liveVolume);
  native = new FusekiClient(source.url, qa.composeEnv.FUSEKI_MAINTENANCE_TOKEN, qa.composeEnv.FUSEKI_COMMAND_TOKEN);
  await initializeFreshGraph(native, originalLineage);
  const consumer = `released-proof:${suffix}`;
  await initializeRelayCheckpoint(relay, consumer, originalLineage.dataEpoch);
  for (let sequence = 1; sequence <= 4; sequence++) {
    if (sequence === 4) {
      source.runner.stop(); copyGraph(liveVolume, cutVolume);
      // The real fourth producer allocates both its terminal and Main envelope.
      await offlineUpdate(source, `PREFIX rv: <${RV}>
        DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?old } }
        INSERT { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence 899 } }
        WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?old } }`);
    }
    const revisions = Array.from({ length: sequence === 4 ? 2 : 1 }, () => randomUUID());
    const intent = await journalErasure(relay, { operationId: randomUUID(), requestDigest: hash(randomUUID()),
      kind: 'revision', principalId: randomUUID(), admissionId: randomUUID(), authorityEpoch: '0',
      targets: revisions.map(ref => ({ kind: 'content_revision', ref })) });
    await suppressGraphContentRevisions(native, originalLineage, intent.erasureId, intent.erasureEpoch, revisions);
    await markErasureSuppressed(relay, intent.erasureId);
    const batch = await relayMainOutboxOnce(native, relay, consumer);
    expect(batch?.sequence).toBe(String(sequence));
    if (sequence === 4) expect(batch!.graphSequence).toBe('900');
    const original = await readGraphErasureProof(native, originalLineage, intent.erasureId, intent.erasureEpoch, revisions);
    entries.push({ id: intent.erasureId, epoch: intent.erasureEpoch, revisions, original,
      evidenceDigest: '', journal: await readErasure(relay, intent.erasureId) });
  }
  expect(await relayMainOutboxOnce(native, relay, consumer)).toBeNull();
  source.runner.stop();
  await expect(native.query('ASK {}', 1024)).rejects.toThrow();
  generation = await engageAccessRecoveryFence(access);
  await withClients(async ({ relayClient }) => {
    for (const entry of entries) {
      const retained = await readRetainedNativeGraphSuppressionProof(relayClient, entry.id, entry.epoch, entry.revisions);
      expect(retained.original).toEqual(entry.original); entry.evidenceDigest = retained.evidenceDigest;
    }
  });
  copyGraph(cutVolume, restoredVolume); restored = await graph(restoredVolume);
  fuseki = new FusekiClient(restored.url, qa.composeEnv.FUSEKI_MAINTENANCE_TOKEN, qa.composeEnv.FUSEKI_COMMAND_TOKEN);
  const saved = await readGraphRecoverySource(fuseki);
  expect(saved).toMatchObject({ ...originalLineage, sequence: '3', relay: { sequence: '3' } });
  await cutoverRestoredGraphLineage(fuseki, { prior: { ...originalLineage, sequence: saved.sequence }, next: nextLineage });
  const cut = { ...nextLineage, restoreCutover: `urn:rezics:restore:${nextLineage.dataEpoch}`,
    priorDataEpoch: saved.dataEpoch, priorSequence: saved.sequence };
  const captured = (entry: Entry): HeldGraphErasureProof => ({ cut, accessHoldGeneration: generation,
    revisionIds: [...entry.revisions], original: { ...entry.original } });
  beforeCut = captured(entries[0]!); afterCut = captured(entries[3]!);
  const assertCurrent = async (clients: { accessClient: PoolClient; relayClient: PoolClient }, request: HeldGraphErasureAuthorization) => {
    const entry = entries.find(value => value.id === request.erasureId);
    if (!entry) throw new GraphErasureConflict('fixture entry is unavailable');
    expect(request).toEqual({ ...captured(entry), revisionIds: [...entry.revisions].sort(), erasureId: entry.id, epoch: entry.epoch });
    const report = await readErasure(clients.relayClient, entry.id);
    expect(report).toEqual(entry.journal);
    expect(report.suppression).toBe('suppressed');
    expect((await clients.accessClient.query(`SELECT open, generation::text AS generation
      FROM access.recovery_fence WHERE id`)).rows).toEqual([{ open: false, generation }]);
    expect(await readRetainedNativeGraphSuppressionProof(clients.relayClient, entry.id, entry.epoch, entry.revisions))
      .toEqual({ original: entry.original, evidenceDigest: entry.evidenceDigest });
    expect(await heldGraphLineageSequence(fuseki, cut)).toBe('0');
  };
  const maintenance = heldErasureMaintenanceClient(restored.url, qa.composeEnv.FUSEKI_MAINTENANCE_TOKEN!);
  await withClients(async clients => {
    const held: HeldGraphErasureReplay = { ...afterCut, signingKey: qa.composeEnv.FUSEKI_TITLE_ADMISSION_KEY!,
      maintenance, assertCurrent: request => assertCurrent(clients, request) };
    expect(await suppressHeldGraphContentRevisions(fuseki, entries[3]!.id, entries[3]!.epoch, entries[3]!.revisions, held))
      .toEqual(entries[3]!.original);
    const own = (await fuseki.query(`PREFIX rv: <${RV}> SELECT ?receipt WHERE { GRAPH ${iri(GRAPHS.receipts)} {
      ?receipt rv:commandFamily "rezics-erasure-restore-v1"; rv:erasureId ${lit(entries[3]!.id)} } } LIMIT 2`)).results?.bindings;
    expect(own).toHaveLength(1); ownReceipt = own![0]!.receipt!.value;
    restored.runner.stop(); copyGraph(restoredVolume, heldVolume); await restored.runner.start();
    const old = { dataEpoch: saved.dataEpoch, graphSequence: saved.sequence, main: saved.relay };
    pairedRelease = { lineage: nextLineage, restoreCutover: cut.restoreCutover, saved: old, effective: old };
    await releaseGraph(fuseki, pairedRelease);
    expect((await clients.accessClient.query('SELECT open FROM access.recovery_fence WHERE id')).rows[0].open).toBe(false);
  });
  restored.runner.stop(); copyGraph(restoredVolume, releasedVolume);
  copyGraph(heldVolume, legacyVolume); legacy = await graph(legacyVolume);
  legacyFuseki = new FusekiClient(legacy.url, qa.composeEnv.FUSEKI_MAINTENANCE_TOKEN, qa.composeEnv.FUSEKI_COMMAND_TOKEN);
  // Preserve the existing legacy marker contract; the release receipt itself is written by native command.
  await offlineUpdate(legacy, `PREFIX rv: <${RV}> DELETE WHERE {
    GRAPH ${iri(GRAPHS.control)} { ${iri(cut.restoreCutover)} rv:priorMainSequence ?main } }`);
  const old = { dataEpoch: saved.dataEpoch, graphSequence: saved.sequence };
  legacyRelease = { lineage: nextLineage, restoreCutover: cut.restoreCutover, saved: old, effective: old };
  await withClients(() => releaseGraph(legacyFuseki, legacyRelease));
  legacy.runner.stop();
  await restored.runner.start();
  expect(Date.now() - started).toBeLessThan(600_000);
}, 600_000);

afterAll(async () => {
  await Promise.allSettled([access?.end(), relay?.end(), relayObserver?.end(), accessObserver?.end()]);
  for (const graph of containers) graph.remove();
  if (qa) for (const volume of volumes) docker(['volume', 'rm', '-f', volume]);
  await databases?.close();
}, 120_000);

function read(entry: Entry, captured: HeldGraphErasureProof, client = fuseki, released = pairedRelease) {
  return readGraphErasureProof(client, nextLineage, entry.id, entry.epoch, entry.revisions, { captured, released });
}

test('released v2 whole inventory keeps actual graph900 distinct from retained Main4 with the original source stopped', async () => {
  await withClients(async clients => {
    const entry = entries[3]!;
    expect(entry.original).toEqual({ receipt: graphErasureReceipt(entry.id), dataEpoch: originalLineage.dataEpoch, sequence: '900' });
    const source = await readRetainedNativeGraphSuppressionProof(clients.relayClient, entry.id, entry.epoch, entry.revisions);
    expect(source).toEqual({ original: entry.original, evidenceDigest: entry.evidenceDigest });
    const positions = (await clients.relayClient.query(`SELECT sequence::text AS main_sequence,
      envelope->'data'->'sourcePosition'->>'sequence' AS graph_sequence FROM relay.delivered_event
      WHERE envelope->'data'->'receipt'->>'id' = $1`, [entry.original.receipt])).rows;
    expect(positions).toEqual([{ main_sequence: '4', graph_sequence: '900' }]);
    expect(await read(entry, afterCut)).toEqual(entry.original);
    expect(await readGraphErasureProof(fuseki, nextLineage, entry.id, entry.epoch, [...entry.revisions].reverse(),
      { released: pairedRelease, captured: { ...afterCut, revisionIds: [...entry.revisions].reverse() } })).toEqual(entry.original);
    expect((await accessObserver.query('SELECT open FROM access.recovery_fence WHERE id')).rows[0].open).toBe(false);
    await expect(native.query('ASK {}', 1024)).rejects.toThrow();
    expect(access.totalCount).toBe(1); expect(relay.totalCount).toBe(1);
  });
}, 30_000);

test('released v1 and v2 accept the exact pre-cut original without requiring an unissued held replay receipt', async () => {
  const entry = entries[0]!;
  await legacy.runner.start();
  try {
    for (const [client, expectation] of [[fuseki, pairedRelease], [legacyFuseki, legacyRelease]] as const) {
      expect((await client.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.receipts)} {
        ?receipt rv:commandFamily "rezics-erasure-restore-v1"; rv:erasureId ${lit(entry.id)} } }`)).boolean).toBe(false);
      expect(await read(entry, beforeCut, client, expectation)).toEqual(entry.original);
      expect(await read(entries[3]!, afterCut, client, expectation)).toEqual(entries[3]!.original);
    }
  } finally { legacy.runner.stop(); }
}, 90_000);

type NativeCorruption = { name: string; update: () => string; error?: typeof GraphErasureConflict | typeof GraphErasureUnavailable };
const nativeCorruptions: NativeCorruption[] = [
  { name: 'extra original receipt fact', update: () => `INSERT DATA { GRAPH ${iri(GRAPHS.receipts)} { ${iri(entries[3]!.original.receipt)} <${RV}extra> "extra" } }` },
  { name: 'competing original graph position', update: () => `INSERT DATA { GRAPH ${iri(GRAPHS.receipts)} { ${iri(entries[3]!.original.receipt)} <${RV}sequence> 4 } }` },
  { name: 'missing post-cut held replay receipt', update: () => `DELETE WHERE { GRAPH ${iri(GRAPHS.receipts)} { ${iri(ownReceipt)} ?p ?o } }`, error: GraphErasureUnavailable },
  { name: 'extra held replay receipt fact', update: () => `INSERT DATA { GRAPH ${iri(GRAPHS.receipts)} { ${iri(ownReceipt)} <${RV}extra> "extra" } }` },
  { name: 'partial target tombstones', update: () => `DELETE WHERE { GRAPH ${iri(GRAPHS.revisions)} { <urn:rezics:content:revision:${entries[3]!.revisions[0]}> ?p ?o } }` },
  ...(['public', 'private'] as const).map(graph => ({ name: `remaining ${graph} indexed reference`,
    update: () => `INSERT DATA { GRAPH <urn:rezics:search:${graph}> { <urn:rezics:release-proof:unit> <${RV}revision> <urn:rezics:content:revision:${entries[3]!.revisions[0]}> } }` })),
  { name: 'indexed inventory beyond64 units', update: () => `INSERT DATA { GRAPH <urn:rezics:search:public> {
    ${Array.from({ length: 65 }, (_, index) => `<urn:rezics:release-proof:unit:${index}> <${RV}contentRevision> <urn:rezics:content:revision:${entries[3]!.revisions[0]}> .`).join('\n')} } }`, error: GraphErasureUnavailable },
  { name: 'competing marker Main cut', update: () => `INSERT DATA { GRAPH ${iri(GRAPHS.control)} { ${iri(pairedRelease.restoreCutover)} <${RV}priorMainSequence> 900 } }` },
];

for (const corruption of nativeCorruptions) {
  test(`released whole native proof denies ${corruption.name} and restored physical bytes recover its exact proof`, async () => {
    try {
      await offlineUpdate(restored, corruption.update());
      await expect(read(entries[3]!, afterCut)).rejects.toBeInstanceOf(corruption.error ?? GraphErasureConflict);
      expect((await accessObserver.query(`SELECT open, generation::text AS generation
        FROM access.recovery_fence WHERE id`)).rows).toEqual([{ open: false, generation }]);
    } finally { await resetReleased(); }
    expect(await read(entries[3]!, afterCut)).toEqual(entries[3]!.original);
  }, 180_000);
}

test('native release evidence changed between the two real Kernel reads cannot authorize a released erasure proof', async () => {
  const query = fuseki.query.bind(fuseki);
  let releaseReads = 0;
  fuseki.query = async (text, limit) => {
    const result = await query(text, limit);
    if (text.includes('SELECT ?graph ?subject ?predicate ?object') && text.includes('LIMIT 22')) {
      releaseReads++;
      if (releaseReads === 1) await offlineUpdate(restored, `INSERT DATA { GRAPH ${iri(GRAPHS.receipts)} {
        <urn:rezics:receipt:restore-release:${hash(nextLineage.dataEpoch)}> <${RV}extra> "changed during read" } }`);
    }
    return result;
  };
  try {
    await expect(read(entries[3]!, afterCut)).rejects.toThrow('native graph release evidence changed during erasure proof read');
    expect(releaseReads).toBe(2);
  } finally { fuseki.query = query; await resetReleased(); }
  expect(await read(entries[3]!, afterCut)).toEqual(entries[3]!.original);
}, 180_000);

test('the separately retained PG source still refuses corruption after native release without owning caller lifecycle', async () => {
  await withClients(async clients => {
    const entry = entries[3]!, before = await txid(clients.relayClient);
    await clients.relayClient.query('SAVEPOINT original_source');
    expect((await clients.relayClient.query(`UPDATE relay.delivered_event SET envelope =
      jsonb_set(envelope, '{data,receipt,requestDigest}', to_jsonb(repeat('0', 64)))
      WHERE envelope->'data'->'receipt'->>'id' = $1`, [entry.original.receipt])).rowCount).toBe(1);
    await expect(readRetainedNativeGraphSuppressionProof(clients.relayClient, entry.id, entry.epoch, entry.revisions))
      .rejects.toBeInstanceOf(GraphErasureUnavailable);
    await clients.relayClient.query('ROLLBACK TO SAVEPOINT original_source');
    expect(await readRetainedNativeGraphSuppressionProof(clients.relayClient, entry.id, entry.epoch, entry.revisions))
      .toEqual({ original: entry.original, evidenceDigest: entry.evidenceDigest });
    expect(await txid(clients.relayClient)).toBe(before);
    expect(await read(entry, afterCut)).toEqual(entry.original);
  });
}, 30_000);
