import { expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Pool } from 'pg';
import { objectStore as recoveryObjectStore } from '../../../scripts/ops/backup.ts';
import { migrateContent } from '../../content/src/migrate.ts';
import { sealRecoveryPayload } from '../../account/src/recovery-envelope.ts';
import { cloneQaOwnerDatabases } from '../../../tests/qa/support/fake-delivery.ts';
import { fusekiSecrets, pinnedImage, qaStack, standaloneFuseki,
  type StandaloneFuseki } from '../../../tests/qa/fault-recovery/search-ops-support.ts';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { ObjectUnavailable, S3ImmutableObjects } from '../src/infrastructure/immutable-objects.ts';
import { engageAccessRecoveryFence, releaseAccessRecoveryFence } from '../src/modules/access/admission.ts';
import { orderTree, recordTree } from '../src/modules/structure/change.ts';
import { StructureGroupRootStore } from '../src/modules/structure/group-root.ts';
import { StructureQualifierRootStore } from '../src/modules/structure/qualifier-index.ts';
import { STRUCTURE_MANIFEST_FORMAT, STRUCTURE_PAGE_FORMAT, STRUCTURE_PROFILE,
  type OccurrenceRecord, type OrderEntry, type StructureManifest } from '../src/modules/structure/format.ts';
import { orderTreeKey } from '../src/modules/structure/graph.ts';
import { newCost } from '../src/modules/structure/tree.ts';
import { assertObjectRecoveryCoverage, captureObjectRecoveryCoverage } from '../src/modules/owner/object-coverage.ts';
import { graphPlacementControl } from '../src/modules/owner/placement.ts';
import { initializeRelayCheckpoint } from '../src/modules/outbox/relay.ts';
import { retainRecoveryCoverageHead } from '../src/modules/outbox/recovery-coverage-head.ts';
import { MAIN_RELAY_STREAM_SCOPE } from '../src/modules/outbox/relay-position.ts';
import { GRAPHS, ID, RV, hash, initializeFreshGraph, iri, lit } from '../src/modules/work/activate.ts';
import * as pgFrontier from '../src/modules/work/pg-recovery-frontier.ts';
import { captureGraphRecoveryCoverage, cutoverRestoredGraphLineage, releaseRestoredGraphHold,
  type AuthenticatedRecoveryCoverage } from '../src/modules/work/restore-lineage.ts';

async function retainedStructure(objects: S3ImmutableObjects, graph: FusekiClient,
  dataEpoch: string, chapters: number, profile: 'book-composition' | 'zone-navigation' = 'book-composition') {
  const structure = ID + randomUUID(), component = ID + randomUUID();
  const revision = ID + randomUUID(), generation = ID + randomUUID();
  const records: OccurrenceRecord[] = Array.from({ length: chapters + 1 }, (_, index) => ({
    occurrence: ID + randomUUID(), state: 'active', parent: structure,
    segmentKey: 'a', orderKey: index.toString(36).padStart(8, '0'),
    role: profile === 'zone-navigation' ? 'mount' : index === 0 ? 'group' : 'chapter',
    labels: [], introducedBy: revision,
    ...(profile === 'zone-navigation' ? { target: ID + randomUUID(), qualifier: {
      type: 'zone-mount' as const, zone: component, routeSegment: `route-${index}`, disclosure: 'public' as const } }
      : index === 0 ? { qualifier: { type: 'book-group' as const, division: 'volume' as const } }
      : { target: ID + randomUUID(), selection: { mode: 'follow-context' as const } }),
  }));
  const cost = newCost(), ordered = orderTree(objects), indexed = recordTree(objects);
  const entries: OrderEntry[] = records.map(record => ({ occurrence: record.occurrence,
    parent: record.parent, segmentKey: record.segmentKey!, orderKey: record.orderKey! }));
  const source: StructureManifest = { format: STRUCTURE_MANIFEST_FORMAT, structure, structureOf: component,
    profile, generation, pageFormat: STRUCTURE_PAGE_FORMAT,
    records: await indexed.apply(await indexed.empty(cost),
      new Map(records.map(record => [record.occurrence, record])), cost),
    order: await ordered.apply(await ordered.empty(cost),
      new Map(entries.map(entry => [orderTreeKey(entry), entry])), cost),
    placementCount: records.length, measures: [], model: STRUCTURE_PROFILE, shape: STRUCTURE_PROFILE };
  const bytes = new TextEncoder().encode(JSON.stringify(source));
  const digest = await objects.put(bytes);
  // New fixture anchors model retained legacy bytes; no existing manifest is rewritten.
  await graph.update(`PREFIX rv: <${RV}> INSERT DATA { GRAPH ${iri(GRAPHS.revisions)} {
    ${iri(revision)} a rv:StructureRevision ; rv:component ${iri(structure)} ;
      rv:manifest <urn:rezics:sha256:${digest}> ; rv:placementCount ${source.placementCount} ;
      rv:modelRevision <${STRUCTURE_PROFILE}> ; rv:shapeRevision <${STRUCTURE_PROFILE}> ;
      rv:dataEpoch ${lit(dataEpoch)} ; rv:sequence 0 .
  } }`);
  return { source, bytes, digest, revision };
}

test('Structure custody: restored GroupRole and qualifier mappings and exact S3 roots gate native writer release', async () => {
  const started = performance.now(), runId = Bun.env.REZICS_QA_RUN_ID;
  if (!runId || !Bun.env.MAIN_S3_ENDPOINT) throw new Error('Run through the isolated QA integration tier');
  const qa = qaStack(runId), suffix = randomUUID().slice(0, 8);
  const directory = resolve('.temp', `structure-group-owner-${suffix}`);
  const volume = `rezics-structure-group-owner-${suffix}`;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const databases = await cloneQaOwnerDatabases(runId, ['account', 'access', 'content', 'relay']);
  const pools = new Set<Pool>();
  const pool = (url: string) => {
    const value = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 2000,
      statement_timeout: 10_000 });
    pools.add(value); return value;
  };
  let native: StandaloneFuseki | undefined;
  let restoreFrontierOracle: (() => void) | undefined;
  const account = pool(databases.urls.account), access = pool(databases.urls.access);
  const relay = pool(databases.urls.relay);
  let sourceContent = pool(databases.urls.content);
  try {
    native = await standaloneFuseki(qa.dockerEnv, { name: `rezics-structure-group-owner-${suffix}`,
      image: pinnedImage(), volume,
      secrets: { ...fusekiSecrets(qa.composeEnv), JVM_ARGS: '-Xms64m -Xmx512m -XX:MaxDirectMemorySize=128m' },
      command: ['/opt/apache-jena-fuseki-6.2.0/fuseki-server', '--port=3030', '--no-cors',
        '--timeout=10000', '--config=/fuseki/fuseki-text-qa.ttl'] });
    const graph = new FusekiClient(native.url, qa.composeEnv.FUSEKI_MAINTENANCE_TOKEN,
      qa.composeEnv.FUSEKI_COMMAND_TOKEN);
    const lineage = { dataEpoch: randomUUID(), routingEpoch: '1' };
    await initializeFreshGraph(graph, lineage);
    const consumer = `structure-group-owner:${suffix}`;
    await initializeRelayCheckpoint(relay, consumer, lineage.dataEpoch);
    await migrateContent(sourceContent);
    const objects = new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT,
      bucket: Bun.env.MAIN_S3_BUCKET!, region: Bun.env.MAIN_S3_REGION,
      accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!, secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!,
      prefix: 'semantic/structure/' });
    await objects.initialize();
    const completeSource = await retainedStructure(objects, graph, lineage.dataEpoch, 10);
    const pendingSource = await retainedStructure(objects, graph, lineage.dataEpoch, 300);
    const completeQualifierSource = await retainedStructure(objects, graph, lineage.dataEpoch, 10, 'zone-navigation');
    const pendingQualifierSource = await retainedStructure(objects, graph, lineage.dataEpoch, 300, 'zone-navigation');
    const sourceStore = new StructureGroupRootStore(sourceContent, objects);
    const completed = await sourceStore.prepare(completeSource.digest);
    const pending = await sourceStore.prepare(pendingSource.digest);
    expect(completed.complete).toBe(true);
    expect(pending).toMatchObject({ complete: false, scanned: 256, total: 301 });
    expect(await sourceStore.completedTopGroups(pendingSource.digest, pendingSource.source)).toBeNull();
    const sourceQualifierStore = new StructureQualifierRootStore(sourceContent, objects);
    const completedQualifier = await sourceQualifierStore.prepare(completeQualifierSource.digest);
    const pendingQualifier = await sourceQualifierStore.prepare(pendingQualifierSource.digest);
    expect(completedQualifier).toMatchObject({ complete: true, progress: { visited: 11, root: { count: 11 } } });
    expect(pendingQualifier).toMatchObject({ complete: false, progress: { visited: 256, root: { count: 256 } } });
    expect(await sourceQualifierStore.completedQualifierKeys(pendingQualifierSource.digest, pendingQualifierSource.source)).toBeNull();
    let wrongResolverCalls = 0;
    const deliberatelyWrongResolver = { retainedRoots: async () => {
      wrongResolverCalls++;
      throw new Error('Source-side resolver must not verify the restored Content owner');
    } };
    const objectStore = { directory, structureObjects: objects, structureGroupRoots: deliberatelyWrongResolver,
      structureQualifierRoots: deliberatelyWrongResolver };
    const fenceGeneration = await engageAccessRecoveryFence(access);
    const coverage = await captureGraphRecoveryCoverage(graph, account, access, relay,
      consumer, sourceContent, objectStore);
    expect(wrongResolverCalls).toBe(0);
    expect(coverage.relay).toMatchObject({ streamScope: MAIN_RELAY_STREAM_SCOPE,
      dataEpoch: lineage.dataEpoch, sequence: '0' });
    const retained = new Set<string>();
    const sourceObjects = { ...objectStore, structureGroupRoots: sourceStore, structureQualifierRoots: sourceQualifierStore };
    expect(await captureObjectRecoveryCoverage(graph, sourceObjects, retained))
      .toEqual(coverage.objects!);
    expect(retained.has(completed.groups.page.slice(7))).toBe(true);
    expect(retained.has(pending.groups.page.slice(7))).toBe(true);
    expect(retained.has(completedQualifier.progress.root.page.slice(7))).toBe(true);
    expect(retained.has(pendingQualifier.progress.root.page.slice(7))).toBe(true);
    const hmacKey = 'b7'.repeat(32);
    const sealedCoverage = JSON.stringify(sealRecoveryPayload(coverage, hmacKey, 'graph-recovery-coverage'));
    await retainRecoveryCoverageHead(relay, sealedCoverage, hmacKey);
    const restoredUrl = await databases.snapshot('content', async () => {
      await sourceContent.end(); pools.delete(sourceContent);
    });
    sourceContent = pool(databases.urls.content);
    const restoredContent = pool(restoredUrl);
    const restoredStore = new StructureGroupRootStore(restoredContent, objects);
    expect(await restoredStore.read(completeSource.digest)).toEqual(completed);
    expect(await restoredStore.read(pendingSource.digest)).toEqual(pending);
    const restoredOwnerObjects = recoveryObjectStore({
      MAIN_OBJECT_DIRECTORY: directory, MAIN_S3_ENDPOINT: Bun.env.MAIN_S3_ENDPOINT!,
      MAIN_S3_BUCKET: Bun.env.MAIN_S3_BUCKET!, MAIN_S3_REGION: Bun.env.MAIN_S3_REGION!,
      MAIN_S3_ACCESS_KEY: Bun.env.MAIN_S3_ACCESS_KEY!, MAIN_S3_SECRET_KEY: Bun.env.MAIN_S3_SECRET_KEY!,
    }, undefined, restoredContent);
    expect(restoredOwnerObjects.structureGroupRoots).toBeInstanceOf(StructureGroupRootStore);
    expect(restoredOwnerObjects.structureQualifierRoots).toBeInstanceOf(StructureQualifierRootStore);
    await assertObjectRecoveryCoverage(graph, restoredOwnerObjects, coverage.objects!);
    const restoredQualifierStore = new StructureQualifierRootStore(restoredContent, objects);
    expect(await restoredQualifierStore.read(completeQualifierSource.digest)).toEqual(completedQualifier);
    expect(await restoredQualifierStore.read(pendingQualifierSource.digest)).toEqual(pendingQualifier);
    const next = { dataEpoch: randomUUID(), routingEpoch: '2' };
    await cutoverRestoredGraphLineage(graph, { prior: { ...lineage, sequence: coverage.priorSequence }, next });
    const streams = (await graph.query(`PREFIX rv: <${RV}> SELECT ?epoch ?sequence WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(MAIN_RELAY_STREAM_SCOPE)} rv:dataEpoch ?epoch ; rv:streamSequence ?sequence }
    } LIMIT 2`)).results!.bindings;
    expect(streams.map(row => [row.epoch!.value, row.sequence!.value])).toEqual([[next.dataEpoch, '0']]);

    // Database-template snapshots qualify owner rows and object closure, not
    // physical WAL replay. Only that independent frontier oracle is substituted;
    // every Account row, Access, relay, Content, S3 and Jena check stays real.
    const frontierOracle = spyOn(pgFrontier, 'assertPgRecoveryFrontier').mockImplementation(async (owner, captured) => {
      expect(owner).toBe(account);
      expect(captured).toEqual(coverage.accountPg);
      expect((await pgFrontier.capturePgRecoveryFrontier(owner)).systemIdentifier).toBe(captured.systemIdentifier);
    });
    restoreFrontierOracle = () => frontierOracle.mockRestore();
    let releaseCallbacks = 0;
    const evidence: AuthenticatedRecoveryCoverage = { sealedCoverage, hmacKey, accountPool: account,
      contentPool: restoredContent, objectStore,
      // This fixture qualifies mapping verification and the borrowed release
      // boundary; it deliberately has no erasure journal replay to qualify.
      releaseErasures: async ({ accessClient, relayClient, fenceGeneration: generation }, releaseGraph) => {
        releaseCallbacks++;
        expect(generation).toBe(fenceGeneration);
        const allocator = (await relayClient.query<{ held: boolean; lock_timeout: string }>(`
          WITH allocator AS (SELECT hashtextextended('rezics-relay-erasure-epoch', 0) AS key)
          SELECT current_setting('lock_timeout') AS lock_timeout, EXISTS (
            SELECT 1 FROM pg_locks, allocator WHERE pid = pg_backend_pid()
              AND locktype = 'advisory' AND granted AND mode = 'ExclusiveLock' AND objsubid = 1
              AND classid = ((allocator.key >> 32) & 4294967295)::oid
              AND objid = (allocator.key & 4294967295)::oid
          ) AS held`)).rows[0]!;
        // A coverage reader must not commit the caller's relay transaction and
        // silently release the allocator before either owner's admission opens.
        expect(allocator).toEqual({ held: true, lock_timeout: '5s' });
        const authority = (await accessClient.query<{ xid: string | null; open: boolean }>(`
          SELECT pg_current_xact_id_if_assigned()::text AS xid, open
          FROM access.recovery_fence WHERE id = true`)).rows[0]!;
        expect(authority.xid).not.toBeNull();
        expect(authority.open).toBe(false);
        await releaseGraph();
        await releaseAccessRecoveryFence(accessClient, generation);
      } };
    const release = () => releaseRestoredGraphHold(graph, access, relay, next, evidence);
    const assertHeld = async () => {
      expect((await graphPlacementControl(graph)).held).toBe(true);
      expect((await access.query<{ open: boolean }>('SELECT open FROM access.recovery_fence WHERE id = true')).rows[0]!.open)
        .toBe(false);
      expect(releaseCallbacks).toBe(0);
      expect(wrongResolverCalls).toBe(0);
    };
    const qualifierSources = [completeQualifierSource, pendingQualifierSource];
    const qualifierRows = await Promise.all(qualifierSources.map(async source =>
      (await restoredContent.query('SELECT * FROM structure.qualifier_root WHERE manifest_digest = $1',
        [source.digest])).rows[0]!));
    const restoreQualifierRow = async (owner: Pool, row: Record<string, unknown>) => {
      await owner.query(`INSERT INTO structure.qualifier_root
        (manifest_digest, source_root, source, progress, version, batch_limit, complete)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`, [row.manifest_digest, row.source_root, row.source, row.progress,
        row.version, row.batch_limit, row.complete]);
    };
    const originalQualifierStore = new StructureQualifierRootStore(sourceContent, objects);
    const originalObjects = { ...objectStore, structureGroupRoots: new StructureGroupRootStore(sourceContent, objects),
      structureQualifierRoots: originalQualifierStore };
    // Both the captured owner and its restored copy must retain pending as well
    // as complete qualifier mappings. Loss cannot be masked by another owner.
    for (const [index, source] of qualifierSources.entries()) {
      const row = qualifierRows[index]!;
      await sourceContent.query('DELETE FROM structure.qualifier_root WHERE manifest_digest = $1', [source.digest]);
      try {
        expect(await originalQualifierStore.read(source.digest)).toBeNull();
        await expect(assertObjectRecoveryCoverage(graph, originalObjects, coverage.objects!)).rejects.toThrow(/coverage/iu);
        evidence.contentPool = sourceContent;
        await expect(release()).rejects.toThrow('Content owner or graph references differ');
        await assertHeld();
      } finally {
        evidence.contentPool = restoredContent;
        await restoreQualifierRow(sourceContent, row);
      }
      await restoredContent.query('DELETE FROM structure.qualifier_root WHERE manifest_digest = $1', [source.digest]);
      try {
        expect(await restoredQualifierStore.read(source.digest)).toBeNull();
        await expect(release()).rejects.toThrow('Content owner or graph references differ');
        await assertHeld();
      } finally { await restoreQualifierRow(restoredContent, row); }
    }
    // A valid-shaped but different supplemental root is still a different
    // Content cut; retain the complete source descriptor and cursor verbatim.
    const savedQualifierProgress = completedQualifier.progress;
    await restoredContent.query('UPDATE structure.qualifier_root SET progress = $2 WHERE manifest_digest = $1',
      [completeQualifierSource.digest, { ...savedQualifierProgress,
        root: { ...savedQualifierProgress.root, page: `sha256:${'f'.repeat(64)}` } }]);
    try {
      await expect(release()).rejects.toThrow('Content owner or graph references differ');
      await assertHeld();
    } finally {
      await restoredContent.query('UPDATE structure.qualifier_root SET progress = $2 WHERE manifest_digest = $1',
        [completeQualifierSource.digest, savedQualifierProgress]);
    }
    const saved = (await restoredContent.query('SELECT * FROM structure.group_root WHERE manifest_digest = $1',
      [completeSource.digest])).rows[0]!;
    // Corrupt only the isolated restored copy, as a failed recovery candidate.
    await restoredContent.query('ALTER TABLE structure.group_root DISABLE TRIGGER group_root_guard');
    try {
      await restoredContent.query('DELETE FROM structure.group_root WHERE manifest_digest = $1', [completeSource.digest]);
      await expect(release()).rejects.toThrow('Content owner or graph references differ');
      await assertHeld();
      await restoredContent.query(`INSERT INTO structure.group_root
        (manifest_digest, structure, records, ordering, total, cursor, scanned, groups, version, complete)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [saved.manifest_digest, saved.structure, saved.records,
        saved.ordering, saved.total, saved.cursor, saved.scanned, saved.groups, saved.version, saved.complete]);
      await restoredContent.query('UPDATE structure.group_root SET groups = $2 WHERE manifest_digest = $1',
        [completeSource.digest, { ...saved.groups, page: `sha256:${'f'.repeat(64)}` }]);
      await expect(release()).rejects.toThrow('Content owner or graph references differ');
      await assertHeld();
      await restoredContent.query('UPDATE structure.group_root SET groups = $2 WHERE manifest_digest = $1',
        [completeSource.digest, saved.groups]);
    } finally { await restoredContent.query('ALTER TABLE structure.group_root ENABLE TRIGGER group_root_guard'); }
    // A missing supplemental page must fail at object verification even when
    // all restored Content rows match. The S3 source remains available elsewhere.
    for (const root of [completed.groups, pending.groups, completedQualifier.progress.root, pendingQualifier.progress.root]) {
      evidence.objectStore = { ...objectStore, structureObjects: {
        put: bytes => objects.put(bytes), get: digest => digest === root.page.slice(7)
          ? Promise.reject(new ObjectUnavailable('restored supplemental root is missing')) : objects.get(digest),
      } };
      try {
        await expect(release()).rejects.toThrow('graph or immutable objects differ');
        await assertHeld();
      } finally { evidence.objectStore = objectStore; }
    }
    expect(await new StructureGroupRootStore(sourceContent, objects)
      .completedTopGroups(completeSource.digest, completeSource.source)).toEqual(completed.groups);
    expect(await restoredQualifierStore.read(completeQualifierSource.digest)).toEqual(completedQualifier);
    expect(await restoredQualifierStore.read(pendingQualifierSource.digest)).toEqual(pendingQualifier);
    await assertObjectRecoveryCoverage(graph, originalObjects, coverage.objects!);
    await release();
    expect(releaseCallbacks).toBe(1);
    expect(wrongResolverCalls).toBe(0);
    expect((await graphPlacementControl(graph)).held).toBe(false);
    expect((await access.query<{ open: boolean }>('SELECT open FROM access.recovery_fence WHERE id = true')).rows[0]!.open)
      .toBe(true);
    for (const source of [completeSource, pendingSource, completeQualifierSource, pendingQualifierSource]) {
      expect(await objects.get(source.digest)).toEqual(source.bytes);
      expect(hash(await objects.get(source.digest))).toBe(source.digest);
    }
    expect(performance.now() - started).toBeLessThan(600_000);
  } finally {
    restoreFrontierOracle?.();
    native?.remove();
    spawnSync('docker', ['volume', 'rm', volume], { env: qa.dockerEnv, timeout: 60_000 });
    await Promise.all([...pools].map(value => value.end()));
    await databases.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 600_000);
