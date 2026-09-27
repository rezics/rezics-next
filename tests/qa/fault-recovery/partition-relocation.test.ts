import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Pool } from 'pg';
import { createMainApp } from '../../../services/main/src/app.ts';
import { ObjectUnavailable, S3ImmutableObjects, type ImmutableObjects }
  from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { OwnerOperations } from '../../../services/main/src/modules/owner/operations.ts';
import { graphPlacementControl, graphPlacementCoverage }
  from '../../../services/main/src/modules/owner/placement.ts';
import { OwnerPartitionRoutes, StalePartitionLease }
  from '../../../services/main/src/modules/partition/route.ts';
import { activateMetadataWork, DATASET, iri, metadataWorkRequestDigest }
  from '../../../services/main/src/modules/work/activate.ts';
import { readExactWorkRevision } from '../../../services/main/src/modules/work/history.ts';
import { changeComposition, compositionChangeDigest, compositionCreateDigest,
  compositionSealDigest, createComposition, sealComposition }
  from '../../../services/main/src/modules/structure/change.ts';
import { readCompositionPage } from '../../../services/main/src/modules/structure/read.ts';
import { readCompositionSeal } from '../../../services/main/src/modules/structure/seal-read.ts';
import { checkStructureManifest } from '../../../services/main/src/modules/structure/format.ts';
import type { MainWorkDependencies } from '../../../services/main/src/routes/dependencies.ts';
import { readEnv, stackDirectory } from '../../../scripts/dev/config.ts';
import { scriptCommand } from '../../../scripts/dev/commands.ts';

const root = resolve(import.meta.dir, '../../..');

function rootCommand(args: string[], timeout = 180_000): void {
  const result = spawnSync(...scriptCommand(args), { cwd: root,
    encoding: 'utf8', timeout, maxBuffer: 1_000_000 });
  if (result.status !== 0 || result.error) {
    throw new Error(`yarn ${args[0]} failed: ${(result.stderr || result.stdout
      || result.error?.message || '').slice(-2000)}`);
  }
}

function rdf(value: { type: string; value: string; datatype?: string; 'xml:lang'?: string }): string {
  if (value.type === 'uri') return `<${value.value}>`;
  if (value.type !== 'literal') throw new Error('relocation fixture contains a blank node');
  if (value['xml:lang']) return `${JSON.stringify(value.value)}@${value['xml:lang']}`;
  return value.datatype ? `${JSON.stringify(value.value)}^^<${value.datatype}>`
    : JSON.stringify(value.value);
}

test('MODEL07/MODEL12/SYS08/COMP07: verified move retains Work and Structure history', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.FUSEKI_URL || !Bun.env.ACCESS_DATABASE_URL
    || !Bun.env.ACCOUNT_RELAY_DATABASE_URL || !Bun.env.MAIN_DATA_EPOCH
    || !Bun.env.MAIN_ROUTING_EPOCH) throw new Error('Run through the isolated fault/recovery tier');
  const targetRun = `move-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const targetArgs = ['--profile', 'qa', '--persistent', '--raw-update', '--run-id', targetRun];
  const directory = resolve('.temp', `partition-move-${randomUUID()}`);
  const sourceDirectory = join(directory, 'source-objects');
  const targetDirectory = join(directory, 'target-objects');
  mkdirSync(sourceDirectory, { recursive: true, mode: 0o700 });
  const access = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL, max: 3 });
  const relay = new Pool({ connectionString: Bun.env.ACCOUNT_RELAY_DATABASE_URL, max: 3 });
  const source = new FusekiClient(Bun.env.FUSEKI_URL);
  const sourceLineage = { dataEpoch: Bun.env.MAIN_DATA_EPOCH,
    routingEpoch: Bun.env.MAIN_ROUTING_EPOCH };
  let targetStarted = false;
  try {
    rootCommand(['stack:up', ...targetArgs]);
    targetStarted = true;
    const targetApps = readEnv(join(stackDirectory(root, { profile: 'qa', runId: targetRun,
      persistent: true, rawUpdate: true }), 'apps.env'));
    const target = new FusekiClient(targetApps.FUSEKI_URL!, targetApps.FUSEKI_MAINTENANCE_TOKEN!,
      targetApps.FUSEKI_COMMAND_TOKEN!);
    const sourceControl = await graphPlacementControl(source);
    expect(sourceControl).toMatchObject({ dataEpoch: sourceLineage.dataEpoch,
      routingEpoch: sourceLineage.routingEpoch, held: false });
    const title = `Relocated exact Work ${randomUUID()}`;
    const created = await activateMetadataWork({ fuseki: source, lineage: sourceLineage,
      objectDirectory: sourceDirectory }, { title,
      semanticTypes: ['https://schema.org/Book'],
      admission: { id: randomUUID(), scope: 'work:create:root', action: 'work.create',
        idempotencyKey: `relocate-${randomUUID()}`,
        requestDigest: metadataWorkRequestDigest(title, ['https://schema.org/Book']),
        authorityEpoch: '0', expiresAt: new Date(Date.now() + 60_000).toISOString() } });
    const structureObjects = new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!,
      bucket: Bun.env.MAIN_S3_BUCKET!, region: Bun.env.MAIN_S3_REGION!,
      accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!, secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!,
      prefix: 'semantic/structure/' });
    await structureObjects.initialize();
    const structureEnv = { fuseki: source, lineage: sourceLineage,
      objectDirectory: sourceDirectory, structureObjects };
    const admitted = (digest: string) => ({ id: randomUUID(), scope: `work:edit:${created.work}`,
      action: 'work.edit', requestDigest: digest, authorityEpoch: '0',
      expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const composition = await createComposition(structureEnv, { owner: created.work,
      component: created.mainVersion, profile: 'book-composition',
      admission: admitted(compositionCreateDigest(created.mainVersion)) });
    const structure = composition.terminal.structure!;
    const firstHead = composition.terminal.revision!;
    const insertOperations = [{ op: 'insert' as const, parent: structure,
      role: 'chapter' as const, target: created.work, position: 'last' as const }];
    const changed = await changeComposition(structureEnv, { structure,
      expectedHead: firstHead, operations: insertOperations,
      admission: admitted(compositionChangeDigest(structure, firstHead, insertOperations)) });
    const retainedRevision = changed.terminal.revision!;
    const sealed = await sealComposition(structureEnv, { structure,
      expectedHead: retainedRevision, canReadTarget: async () => true,
      admission: admitted(compositionSealDigest(structure, retainedRevision)) });
    const seal = sealed.terminal.seal!;
    const oldManifestRows = await source.query(`PREFIX rv: <https://rezics.com/vocab/>
      SELECT ?manifest WHERE { GRAPH <urn:rezics:graph:revisions> {
        ${iri(retainedRevision)} rv:manifest ?manifest . } }`);
    const oldManifestDigest = oldManifestRows.results!.bindings[0]!.manifest!.value.slice(-64);
    const oldManifest = checkStructureManifest(await structureObjects.get(oldManifestDigest));
    const retainedPageDigest = oldManifest.records.page.slice(7);
    const snapshot = await source.query('SELECT ?graph ?subject ?predicate ?object WHERE { GRAPH ?graph { ?subject ?predicate ?object } }');
    const facts = snapshot.results?.bindings;
    if (!facts?.length) throw new Error('relocation source snapshot is empty');
    for (let offset = 0; offset < facts.length; offset += 100) {
      const batch = facts.slice(offset, offset + 100).map(row => {
        if (!row.graph || !row.subject || !row.predicate || !row.object) {
          throw new Error('relocation source snapshot is incomplete');
        }
        return `GRAPH <${row.graph.value}> { ${rdf(row.subject)} ${rdf(row.predicate)} ${rdf(row.object)} . }`;
      });
      await target.update(`INSERT DATA { ${batch.join('\n')} }`);
    }
    cpSync(sourceDirectory, targetDirectory, { recursive: true });
    const routes = new OwnerPartitionRoutes(access);
    const initialRoute = await routes.initialize({ owner: 'graph', datasetId: DATASET,
      location: Bun.env.FUSEKI_URL, routingEpoch: sourceLineage.routingEpoch });
    let withholdPage = false;
    const targetStructureObjects: ImmutableObjects = {
      put: bytes => structureObjects.put(bytes),
      get: digest => withholdPage && digest === retainedPageDigest
        ? Promise.reject(new ObjectUnavailable('retained Structure page was not copied'))
        : structureObjects.get(digest),
    };
    const operations = new OwnerOperations(relay, structureEnv, undefined, {
      sourceLocation: Bun.env.FUSEKI_URL, targetLocation: targetApps.FUSEKI_URL!, target,
      sourceObjects: { directory: sourceDirectory, structureObjects },
      targetObjects: { directory: targetDirectory, structureObjects: targetStructureObjects },
      routes });
    const app = createMainApp(source, { ownerOperations: operations,
      account: { verify: async (request: Request, scopes: readonly string[]) => {
        if (request.headers.get('authorization') !== 'Bearer operator'
          || scopes[0] !== 'owner:operate') throw new Error('operator denied');
        return { issuer: 'https://owner.test', subject: 'operator' };
      } }, access: { activePrincipalId: async () => randomUUID() } } as unknown as MainWorkDependencies);
    const send = (body: object, key: string) => app.handle(new Request(
      'http://main.local/v1/owners/relocations', { method: 'POST',
        headers: { authorization: 'Bearer operator', 'content-type': 'application/json',
          'idempotency-key': key }, body: JSON.stringify(body) }));
    const key = `physical-${randomUUID()}`;
    const stagedResponse = await send({ profile: 'owner-relocation-v1', action: 'stage',
      owner: 'graph', datasetId: DATASET, sourceLocation: Bun.env.FUSEKI_URL,
      targetLocation: targetApps.FUSEKI_URL, sourceRoutingEpoch: sourceLineage.routingEpoch }, key);
    expect(stagedResponse.status).toBe(201);
    const staged = await stagedResponse.json() as { id: string };
    const manifestRows = await source.query(`PREFIX rv: <https://rezics.com/vocab/>
      SELECT ?manifest WHERE { GRAPH <urn:rezics:graph:revisions> {
        ${iri(created.workRevision)} rv:manifest ?manifest } }`);
    const manifest = manifestRows.results?.bindings[0]?.manifest?.value;
    if (!manifest) throw new Error('retained anchor manifest is missing');
    const targetManifest = join(targetDirectory, manifest.slice(-64));
    renameSync(targetManifest, `${targetManifest}.held`);
    const incomplete = await send({ profile: 'owner-relocation-v1', action: 'activate',
      id: staged.id }, key);
    expect({ status: incomplete.status, body: await incomplete.json() }).toEqual({ status: 409,
      body: expect.objectContaining({ code: 'owner_operation_busy' }) });
    expect((await routes.current('graph', DATASET)).location).toBe(Bun.env.FUSEKI_URL);
    expect((await graphPlacementControl(source)).held).toBe(true);
    expect((await graphPlacementControl(target)).routingEpoch).toBe(sourceLineage.routingEpoch);
    renameSync(`${targetManifest}.held`, targetManifest);
    withholdPage = true;
    const missingStructure = await send({ profile: 'owner-relocation-v1', action: 'activate',
      id: staged.id }, key);
    expect(missingStructure.status).toBe(409);
    expect((await routes.current('graph', DATASET)).location).toBe(Bun.env.FUSEKI_URL);
    withholdPage = false;
    const movedResponse = await send({ profile: 'owner-relocation-v1', action: 'activate',
      id: staged.id }, key);
    const movedBody = await movedResponse.json();
    expect({ status: movedResponse.status, body: movedBody }).toEqual({ status: 201,
      body: expect.objectContaining({ id: staged.id, state: 'activated' }) });
    const targetControl = await graphPlacementControl(target);
    const targetLineage = { dataEpoch: targetControl.dataEpoch,
      routingEpoch: targetControl.routingEpoch };
    expect(targetLineage.routingEpoch).not.toBe(sourceLineage.routingEpoch);
    expect((await graphPlacementControl(target)).held).toBe(false);
    expect((await graphPlacementControl(source)).held).toBe(true);
    const route = await routes.current('graph', DATASET);
    expect(route).toMatchObject({ location: targetApps.FUSEKI_URL,
      routingEpoch: targetLineage.routingEpoch, relocationId: staged.id });
    expect(BigInt(route.leaseEpoch)).toBe(BigInt(initialRoute.leaseEpoch) + 1n);
    const planner = await access.connect();
    try {
      await planner.query('BEGIN');
      await planner.query('SET LOCAL enable_seqscan = off');
      const plan = (await planner.query<{ 'QUERY PLAN': string }>(`EXPLAIN (ANALYZE, BUFFERS)
        SELECT location, routing_epoch, lease_epoch FROM access.owner_partition_route
        WHERE owner = 'graph' AND dataset_id = $1`, [DATASET]))
        .rows.map(row => row['QUERY PLAN']).join('\n');
      expect(plan).toContain('owner_partition_route_pkey');
      await planner.query('ROLLBACK');
    } finally { planner.release(); }
    await expect(routes.assertWrite({ ...initialRoute })).rejects.toBeInstanceOf(StalePartitionLease);
    await expect(routes.assertWrite({ ...route, leaseEpoch: initialRoute.leaseEpoch }))
      .rejects.toBeInstanceOf(StalePartitionLease);
    await expect(activateMetadataWork({ fuseki: source, lineage: sourceLineage,
      objectDirectory: sourceDirectory, partitionLease: { routes,
        location: initialRoute.location, leaseEpoch: initialRoute.leaseEpoch } }, {
      title: 'stale worker write', admission: { id: randomUUID(), scope: 'work:create:root',
        action: 'work.create', idempotencyKey: `old-${randomUUID()}`,
        requestDigest: metadataWorkRequestDigest('stale worker write'), authorityEpoch: '0',
        expiresAt: new Date(Date.now() + 60_000).toISOString() } }))
      .rejects.toBeInstanceOf(StalePartitionLease);
    const unleasedTitle = `old binary ${randomUUID()}`;
    await expect(activateMetadataWork({ fuseki: source, lineage: sourceLineage,
      objectDirectory: sourceDirectory }, { title: unleasedTitle,
      admission: { id: randomUUID(), scope: 'work:create:root', action: 'work.create',
        idempotencyKey: `unleased-old-${randomUUID()}`,
        requestDigest: metadataWorkRequestDigest(unleasedTitle), authorityEpoch: '0',
        expiresAt: new Date(Date.now() + 60_000).toISOString() } }))
      .rejects.toThrow();
    expect((await readExactWorkRevision({ fuseki: target, lineage: targetLineage,
      objectDirectory: targetDirectory }, created.workRevision, async () => true)).title).toBe(title);
    const movedStructureEnv = { fuseki: target, lineage: targetLineage,
      objectDirectory: targetDirectory, structureObjects: targetStructureObjects };
    expect((await readCompositionPage(movedStructureEnv, { structure, revision: retainedRevision,
      limit: 10, canReadTarget: async () => true })).occurrences[0]?.target).toBe(created.work);
    expect((await readCompositionSeal(movedStructureEnv, { structure, seal, limit: 10,
      canReadTarget: async () => true })).pins[0]?.occurrence)
      .toBe(changed.occurrences[0]);
    expect(await graphPlacementCoverage(target, { directory: targetDirectory,
      structureObjects: targetStructureObjects }))
      .toEqual(await graphPlacementCoverage(source, { directory: sourceDirectory,
        structureObjects }));
    expect((await send({ profile: 'owner-relocation-v1', action: 'activate', id: staged.id }, key)).status)
      .toBe(200);
    const evidence = await relay.query<{ source_data_epoch: string; source_sequence: string;
      anchor_count: string; object_count: string }>(`SELECT source_data_epoch,
        source_sequence::text, anchor_count::text, object_count::text
        FROM relay.owner_relocation WHERE id = $1`, [staged.id]);
    expect(evidence.rows[0]?.source_data_epoch).toBe(sourceLineage.dataEpoch);
    expect(evidence.rows[0]?.source_sequence).toBe(sealed.terminal.sequence);
    expect(Number(evidence.rows[0]?.anchor_count)).toBeGreaterThan(0);
    expect(Number(evidence.rows[0]?.object_count)).toBeGreaterThan(0);
    const unused = Buffer.from(`unadopted relocation candidate ${randomUUID()}`);
    const unusedDigest = createHash('sha256').update(unused).digest('hex');
    const unusedPath = join(sourceDirectory, unusedDigest);
    writeFileSync(unusedPath, unused);
    const old = new Date(Date.now() - 2 * 86_400_000);
    utimesSync(unusedPath, old, old);
    const beforeGc = await graphPlacementCoverage(source, { directory: sourceDirectory,
      structureObjects });
    const gcKey = `retention-${randomUUID()}`;
    const gc = () => app.handle(new Request('http://main.local/v1/owners/reconciliations', {
      method: 'POST', headers: { authorization: 'Bearer operator',
        'content-type': 'application/json', 'idempotency-key': gcKey },
      body: JSON.stringify({ profile: 'owner-reconciliation-v1', kind: 'retention_gc' }) }));
    const gcResponse = await gc();
    expect(gcResponse.status).toBe(201);
    expect(await gcResponse.json()).toMatchObject({ state: 'reconciled',
      disposition: 'retired' });
    expect(existsSync(unusedPath)).toBe(false);
    expect(await graphPlacementCoverage(source, { directory: sourceDirectory,
      structureObjects })).toEqual(beforeGc);
    expect((await gc()).status).toBe(200);
    expect((await readExactWorkRevision({ fuseki: target, lineage: targetLineage,
      objectDirectory: targetDirectory }, created.workRevision, async () => true)).title).toBe(title);
  } finally {
    await Promise.allSettled([access.end(), relay.end()]);
    if (targetStarted) rootCommand(['stack:reset', ...targetArgs]);
    rmSync(directory, { recursive: true, force: true });
  }
}, 240_000);
