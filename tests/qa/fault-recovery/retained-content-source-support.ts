import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { Pool } from 'pg';
import { readEnv, savePrivate } from '../../../scripts/dev/config.ts';
import { sha256, stable } from '../../../scripts/fixture/corpus.ts';
import { fixtureModel } from '../../../scripts/fixture/model.ts';
import type { RetainedFileIntegrity, RetainedOwnerState } from '../../../scripts/fixture/manifest.ts';
import { copyVolume, currentEngines, freshPorts, postgresImage, removeVolumes, run, volumeExists } from '../../../scripts/fixture/stack.ts';
import { migrateTracked } from '../../../scripts/ops/migrate.ts';
import { runQaStartupChildAsync } from '../../../scripts/qa/stack-startup.ts';
import { RetainedSources, sourceFileDigests, type RetainedSourceAdapter } from '../../../scripts/qa/retained-source.ts';
import { ContentCore } from '../../../services/content/src/core.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { ContentProjectionCursor } from '../../../services/content/src/projection-cursor.ts';
import { contentRebuildDelivery } from '../../../services/main/src/modules/content-publication/rebuild-preflight.ts';
import { relayContentProjectionOnce } from '../../../services/main/src/modules/content-publication/relay.ts';
import { queryPublicContentPhrase } from '../../../services/main/src/modules/content-publication/search.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import { GRAPHS, RV, initializeFreshGraph, iri } from '../../../services/main/src/modules/work/activate.ts';
import { assertPublicTextReady } from '../../../services/main/src/modules/work/search-readiness.ts';
import { searchRoutes, type SearchRouteDependencies } from '../../../services/main/src/routes/search.ts';
import { seedRecoveryContent } from './search-content-fixture.ts';
import { migrateAccess, pinnedImage, qaStack, requireFaultTier, root, rootCommand, type QaStack } from './search-ops-support.ts';

const CONTRACT = 'retained-content-source-v1';
const PUBLIC = 'urn:rezics:search:public';
const INPUTS = {
  contentBody: 'exact content beacon', companionBody: 'recovery companion public text',
  language: 'en', direction: 'ltr', disclosure: 'public', rightsBasis: 'original-contribution',
  companionSelection: 'main-maintainer', titlePattern: 'Recovery Content <generated UUID>',
  contentProjectionConsumer: 'main-content-public-search-v1', mainRelayConsumer: 'main-graph-v1',
  foregroundSeed: null, laterAdmission: false,
};

/** Explicit source closure: test assertions and Git revision are not producer inputs. */
function producerFiles(): string[] {
  const files = new Set<string>();
  const visit = (path: string) => {
    // Scheduling/registration changes do not change the produced source.
    if (path === 'scripts/qa/core.ts' || files.has(path)) return;
    const absolute = resolve(root, path);
    if (relative(root, absolute).startsWith('..')) throw new Error('producer dependency escapes checkout');
    if (!statSync(absolute).isFile()) throw new Error(`producer digest input is not a file: ${path}`);
    files.add(path);
    if (!path.endsWith('.ts')) return;
    for (const match of readFileSync(absolute, 'utf8').matchAll(/(?:from|import)\s*['"](\.[^'"]+)['"]/g)) {
      const target = resolve(dirname(absolute), match[1]!);
      if (existsSync(target) && statSync(target).isFile()) visit(relative(root, target));
      else if (existsSync(`${target}.ts`)) visit(relative(root, `${target}.ts`));
      else if (existsSync(join(target, 'index.ts'))) visit(relative(root, join(target, 'index.ts')));
    }
  };
  const walk = (directory: string) => {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      if (['node_modules', '.temp', 'target', 'dist', 'bin', 'obj'].includes(entry.name)) continue;
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.add(path);
    }
  };
  for (const path of ['tests/qa/fault-recovery/retained-content-source-support.ts', 'yarn.lock',
    'package.json', 'services/main/package.json', 'services/content/package.json', 'infra/dev/compose.yaml']) visit(path);
  for (const directory of ['services/content/migrations', 'services/main/migrations/access',
    'services/main/migrations/relay', 'packages/model/src', 'model', 'infra/jena']) walk(directory);
  return [...files].sort();
}

export function retainedContentSourceDirectory(): string {
  // A worker's preparation writes only its own fixture directory. Consumers
  // can pass the accepted custody directory explicitly to this adapter/store.
  return join(root, '.temp', 'fixture', 'retained-sources');
}

function sourceResources(directory: string, key: string) {
  if (!/^rs-retained-content-source-v1-[a-f0-9]{64}$/.test(key)) throw new Error('Content source key differs');
  const scope = sha256(`${resolve(directory)}\n${key}`).slice(0, 24);
  return { graph: `rezics-retained-content-${scope}-graph`,
    postgres: `rezics-retained-content-${scope}-postgres`,
    rustfs: `rezics-retained-content-${scope}-rustfs`, producer: `rcp-${scope}` };
}

/** Read-only external custody inventory, including file lengths and safe names. */
function volumeInventory(volume: string, docker: NodeJS.ProcessEnv): Record<string, RetainedFileIntegrity> {
  if (!volumeExists(volume, docker)) throw new Error(`retained volume absent: ${volume}`);
  const output = run('docker', ['run', '--rm', '--network', 'none', '--user', '0:0',
    '--mount', `type=volume,source=${volume},target=/backup,readonly,volume-nocopy`,
    '--entrypoint', 'sh', postgresImage(), '-ec', `cd /backup
test -z "$(find . -type l -print -quit)"
find . -type f -exec sh -c 'for file do
  digest=$(sha256sum "$file"); bytes=$(stat -c %s "$file")
  printf "%s\\t%s\\t%s\\n" "${'${digest%% *}'}" "$bytes" "${'${file#./}'}"
done' sh {} +`], docker, 60_000);
  const inventory: Record<string, RetainedFileIntegrity> = {};
  for (const line of output.trim().split('\n').filter(Boolean)) {
    const match = /^([a-f0-9]{64})\t([0-9]+)\t([^\t\n]+)$/.exec(line);
    if (!match || match[3]!.split('/').some(part => part === '..' || !part))
      throw new Error('retained volume inventory is malformed');
    inventory[match[3]!] = { sha256: match[1]!, bytes: Number(match[2]) };
  }
  if (!Object.keys(inventory).length) throw new Error('retained volume is empty');
  return inventory;
}

function postgresControl(volume: string, docker: NodeJS.ProcessEnv): string {
  const output = run('docker', ['run', '--rm', '--network', 'none',
    '--mount', `type=volume,source=${volume},target=/backup,readonly,volume-nocopy`,
    '--entrypoint', 'pg_controldata', postgresImage(), '/backup/18/docker'], docker, 30_000);
  if (!/Database cluster state:\s+shut down\s*$/m.test(output)) throw new Error('retained PostgreSQL cluster was not stopped consistently');
  return output;
}

export interface RetainedContentCandidate {
  stack: QaStack;
  pools: { content: Pool; access: Pool; relay: Pool };
  content: ContentCore;
  cursor: ContentProjectionCursor;
  metadata: RetainedOwnerState;
  closed: boolean;
  poolsClosed: boolean;
}

export function retainedContentSourceAdapter(directory = retainedContentSourceDirectory()): RetainedSourceAdapter<RetainedOwnerState, RetainedContentCandidate> {
  const docker = qaStack(requireFaultTier().runId).dockerEnv;
  const engines = currentEngines(docker);
  const specification = { producer: CONTRACT, version: '1', files: sourceFileDigests(root, producerFiles()),
    inputs: INPUTS, compatibility: JSON.parse(JSON.stringify({ engines,
      selectedNativeImage: pinnedImage(), modelGeneration: fixtureModel(root).generation,
      contentProjectionModel: 'https://rezics.com/definition/content-match-unit-v1',
      postgresLayout: '18/docker', ownerSchemas: ['content', 'access', 'relay'] })) as RetainedOwnerState };
  return {
    specification,
    build: async context => {
      const { runId } = requireFaultTier();
      const resources = sourceResources(directory, context.key);
      const stack = qaStack(resources.producer);
      const pools: Pool[] = [];
      const phases: Record<string, number> = {};
      const phase = async <T>(name: string, work: () => Promise<T> | T): Promise<T> => {
        const at = Date.now(), waiting = context.budget.admissionWaitMs();
        try { context.budget.remaining(); return await work(); }
        finally { phases[name] = Date.now() - at - (context.budget.admissionWaitMs() - waiting); context.budget.remaining(); }
      };
      try {
        await phase('startup', async () => {
          const result = await runQaStartupChildAsync(root, ['stack:up', ...stack.args], 180_000);
          context.budget.excludeAdmissionWait(result.admissionWaitMs);
          if (!result.ok) throw new Error(`Content producer startup failed: ${result.output.slice(-4000)}`);
        });
        const lineage = { dataEpoch: stack.apps.MAIN_DATA_EPOCH!, routingEpoch: stack.apps.MAIN_ROUTING_EPOCH! };
        const env = { fuseki: stack.fuseki, lineage, objectDirectory: stack.apps.MAIN_OBJECT_DIRECTORY! };
        const contentPool = new Pool({ connectionString: stack.apps.CONTENT_DATABASE_URL, max: 4 });
        const accessPool = new Pool({ connectionString: stack.apps.ACCESS_DATABASE_URL, max: 4 });
        const relayPool = new Pool({ connectionString: stack.apps.MAIN_RELAY_DATABASE_URL, max: 2 });
        pools.push(contentPool, accessPool, relayPool);
        const content = new ContentCore(contentPool), cursor = new ContentProjectionCursor(contentPool);
        const populated = await phase('producer', async () => {
          await initializeFreshGraph(env.fuseki, lineage);
          await migrateContent(contentPool);
          await migrateAccess(stack.apps.ACCESS_DATABASE_URL!);
          await migrateTracked(stack.apps.MAIN_RELAY_DATABASE_URL!, root, 'services/main/migrations/relay');
          const producer = await seedRecoveryContent(env, contentPool, accessPool);
          const delivery = contentRebuildDelivery(env, content, relayPool, INPUTS.mainRelayConsumer);
          await delivery.relayPosition();
          while (await delivery.relayOnce() !== null) { /* retain supported owner approvals */ }
          const through = await delivery.relayPosition();
          while (await delivery.deliverOnce(through) !== null) { /* deliver before freezing the Content cut */ }
          const cut = await content.ownerPosition();
          await cursor.initialize(INPUTS.contentProjectionConsumer);
          for (let i = 0; i < 20 && (await cursor.read(INPUTS.contentProjectionConsumer)).sequence !== cut.sequence; i++) {
            if (!await relayContentProjectionOnce(env, content, cursor, INPUTS.contentProjectionConsumer))
              throw new Error('producer stopped before frozen Content cut');
          }
          const projectionCursor = await cursor.read(INPUTS.contentProjectionConsumer);
          const exact = (await content.readExactBatch([producer.content.revisionId], async ids => new Set(ids)))[0];
          if (exact?.status !== 'available') throw new Error('producer exact Content reference is unavailable');
          const contentPins = { byteDigest: exact.reference.byteDigest, ownerDataEpoch: cut.dataEpoch };
          const input = { phrase: INPUTS.contentBody, language: INPUTS.language };
          const before = await queryPublicContentPhrase(env, content, cursor, INPUTS.contentProjectionConsumer, input);
          const unit = before.results[0]?.matchUnit;
          if (!unit) throw new Error('producer supplied no retained Content identity');
          const facts = await env.fuseki.query(`PREFIX rv: <${RV}>
SELECT ?g ?s ?p ?o WHERE {
  GRAPH <${PUBLIC}> { ${iri(unit)} rv:projection ?projection . }
  VALUES ?g { ${iri(GRAPHS.current)} ${iri(GRAPHS.revisions)} <${PUBLIC}> }
  GRAPH ?g { ?s ?p ?o . }
  FILTER(?s IN (${iri(unit)}, ?projection, ${iri(producer.content.variantId)},
    ${iri(producer.content.publicationDecision)}, ${iri(producer.content.eligibilityDecision)}))
} ORDER BY ?g ?s ?p ?o`);
          const position = await assertPublicTextReady(env.fuseki, lineage);
          const dependencies = { environment: env, account: {}, access: new AccessAdmissionRegistry(accessPool),
            contentProjection: { content, cursor, consumer: INPUTS.contentProjectionConsumer } } as SearchRouteDependencies;
          const response = await searchRoutes(env.fuseki, dependencies).handle(new Request('http://main.local/v1/queries', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ profile: 'public-content-phrase-v1', ...input }) }));
          const beforeApi = { status: response.status, body: await response.json() };
          const rdf = await env.fuseki.query('SELECT ?g ?s ?p ?o WHERE { GRAPH ?g { ?s ?p ?o } } ORDER BY ?g ?s ?p ?o');
          return { producer, contentPins, cut, projectionCursor, through, relayPosition: await delivery.relayPosition(),
            unit, input, before, beforeApi, retainedFacts: facts.results?.bindings ?? [], position, rdf };
        });
        await phase('stopped-custody', async () => {
          await Promise.all(pools.map(pool => pool.end()));
          pools.length = 0;
          const stopped = stack.compose(['stop', 'fuseki', 'postgres', 'rustfs']);
          if (stopped.status !== 0) throw new Error(`Content producer stop failed: ${stopped.output.slice(-2000)}`);
          cpSync(env.objectDirectory, join(context.backup, 'objects'), { recursive: true });
          savePrivate(join(context.backup, 'compose.env'), stack.composeEnv);
          writeFileSync(join(context.backup, 'rdf.json'), stable(populated.rdf), { mode: 0o600 });
          await copyVolume(stack.stateVolume, resources.graph, docker);
          await copyVolume(`${stack.project}_postgres_data`, resources.postgres, docker);
          await copyVolume(`${stack.project}_rustfs_data`, resources.rustfs, docker);
        });
        const inventories = await phase('physical-manifests', async () => ({
          graph: volumeInventory(resources.graph, docker), postgres: volumeInventory(resources.postgres, docker),
          rustfs: volumeInventory(resources.rustfs, docker), postgresControl: postgresControl(resources.postgres, docker),
        }));
        const { rdf, ...facts } = populated;
        const metadata = JSON.parse(JSON.stringify({ contract: CONTRACT, ...facts, lineage,
          consumer: INPUTS.contentProjectionConsumer, relayConsumer: INPUTS.mainRelayConsumer,
          runtime: { config: 'compose.env', objects: 'objects', postgresLayout: '18/docker' },
          sourceVolumes: { graph: resources.graph, postgres: resources.postgres, rustfs: resources.rustfs } })) as RetainedOwnerState;
        const ownerState = JSON.parse(JSON.stringify({ contract: CONTRACT, lineage, contentCut: populated.cut,
          projectionCursor: populated.projectionCursor, consumer: INPUTS.contentProjectionConsumer,
          relayConsumer: INPUTS.mainRelayConsumer, relayThrough: populated.through, relayPosition: populated.relayPosition,
          databaseRoles: ['content', 'access', 'relay'], sourceVolumes: metadata.sourceVolumes, inventories })) as RetainedOwnerState;
        return { metadata, ownerState, rdfDigest: sha256(stable(rdf)),
          producerRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
          qaIdentity: runId, phases };
      } finally {
        for (const pool of pools) await pool.end();
        if (existsSync(join(stack.directory, 'compose.env'))) await rootCommand(['stack:reset', ...stack.args], 120_000);
      }
    },
    verify: async (context, manifest) => {
      const evidence: string[] = [];
      for (const field of ['producer', 'contentPins', 'unit', 'input', 'before', 'beforeApi', 'position', 'retainedFacts', 'runtime']) {
        if (manifest.metadata[field] === undefined) evidence.push(`retained Content metadata missing: ${field}`);
      }
      const expected = sourceResources(directory, context.key);
      const names = { graph: expected.graph, postgres: expected.postgres, rustfs: expected.rustfs };
      if (manifest.metadata.contract !== CONTRACT || stable(manifest.metadata.sourceVolumes) !== stable(names) ||
        stable(manifest.integrity.ownerState.sourceVolumes) !== stable(names)) evidence.push('Content owner custody descriptor differs');
      const inventories = manifest.integrity.ownerState.inventories as RetainedOwnerState | undefined;
      for (const kind of ['graph', 'postgres', 'rustfs'] as const) {
        if (stable(volumeInventory(names[kind], docker)) !== stable(inventories?.[kind])) evidence.push(`${kind} physical manifest differs`);
      }
      if (postgresControl(names.postgres, docker) !== inventories?.postgresControl) evidence.push('PostgreSQL stopped control differs');
      if (sha256(readFileSync(join(context.backup, 'rdf.json'))) !== manifest.integrity.rdfDigest) evidence.push('RDF digest differs');
      for (const [metadataField, ownerField] of [['lineage', 'lineage'], ['cut', 'contentCut'],
        ['projectionCursor', 'projectionCursor'], ['consumer', 'consumer'], ['relayConsumer', 'relayConsumer'],
        ['through', 'relayThrough'], ['relayPosition', 'relayPosition']] as const) {
        if (manifest.metadata[metadataField] === undefined ||
          stable(manifest.metadata[metadataField]) !== stable(manifest.integrity.ownerState[ownerField]))
          evidence.push(`required owner state differs: ${metadataField}`);
      }
      return evidence;
    },
    restore: async (context, manifest) => {
      const source = sourceResources(directory, context.key);
      const stack = qaStack(`rc-copy-${randomUUID().replaceAll('-', '').slice(0, 23)}`);
      let candidate: RetainedContentCandidate | undefined;
      try {
        mkdirSync(stack.directory, { recursive: true, mode: 0o700 });
        const saved = readEnv(join(context.backup, 'compose.env'));
        savePrivate(join(stack.directory, 'compose.env'), { ...saved, ...await freshPorts() });
        cpSync(join(context.backup, 'objects'), join(stack.directory, 'objects'), { recursive: true });
        await copyVolume(source.graph, stack.stateVolume, docker);
        await copyVolume(source.postgres, `${stack.project}_postgres_data`, docker);
        await copyVolume(source.rustfs, `${stack.project}_rustfs_data`, docker);
        const result = await runQaStartupChildAsync(root, ['stack:up', ...stack.args], 180_000);
        context.budget.excludeAdmissionWait(result.admissionWaitMs);
        if (!result.ok) throw new Error(`isolated Content restore startup failed: ${result.output.slice(-4000)}`);
        const pools = { content: new Pool({ connectionString: stack.apps.CONTENT_DATABASE_URL, max: 4 }),
          access: new Pool({ connectionString: stack.apps.ACCESS_DATABASE_URL, max: 4 }),
          relay: new Pool({ connectionString: stack.apps.MAIN_RELAY_DATABASE_URL, max: 2 }) };
        candidate = { stack, pools, content: new ContentCore(pools.content), cursor: new ContentProjectionCursor(pools.content),
          metadata: manifest.metadata, closed: false, poolsClosed: false };
        return candidate;
      } catch (error) {
        if (candidate) await Promise.all(Object.values(candidate.pools).map(pool => pool.end()));
        await rootCommand(['stack:reset', ...stack.args], 120_000);
        throw error;
      }
    },
    dispose: async candidate => {
      if (candidate.closed) return;
      if (!candidate.poolsClosed) {
        await Promise.all(Object.values(candidate.pools).map(pool => pool.end()));
        candidate.poolsClosed = true;
      }
      await rootCommand(['stack:reset', ...candidate.stack.args], 120_000);
      candidate.closed = true;
    },
    remove: async key => {
      const resources = sourceResources(directory, key);
      const producer = qaStack(resources.producer);
      if (existsSync(join(producer.directory, 'compose.env'))) await rootCommand(['stack:reset', ...producer.args], 120_000);
      removeVolumes([resources.graph, resources.postgres, resources.rustfs], docker);
    },
  };
}

export function prepareRetainedContentSource() {
  const directory = retainedContentSourceDirectory();
  return new RetainedSources(directory).prepare(retainedContentSourceAdapter(directory));
}
