import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { copyVolume, removeVolumes, run } from '../../../scripts/fixture/stack.ts';
import { RetainedSources } from '../../../scripts/qa/retained-source.ts';
import { OFFLINE_INDEX_SCRIPT } from '../../../scripts/operations/search-state.ts';
import { FusekiClient, type SparqlResult } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import { queryPublicContentPhrase } from '../../../services/main/src/modules/content-publication/search.ts';
import type { ContentCore } from '../../../services/content/src/core.ts';
import type { PublicTextPosition } from '../../../services/main/src/modules/work/search-readiness.ts';
import { RV, iri } from '../../../services/main/src/modules/work/activate.ts';
import { searchRoutes, type SearchRouteDependencies } from '../../../services/main/src/routes/search.ts';
import type { seedRecoveryContent } from './search-content-fixture.ts';
import { retainedContentSourceAdapter, retainedContentSourceDirectory } from './retained-content-source-support.ts';
import { fusekiSecrets, pinnedImage, requireFaultTier, standaloneFuseki, waitForFuseki,
  type StandaloneFuseki } from './search-ops-support.ts';

export const STATE = '/fuseki/databases/rezics';
export const JENA = '/opt/apache-jena-fuseki-6.2.0/fuseki-server.jar';
export const PUBLIC = 'urn:rezics:search:public';

/** These values are bound to the physical/owner cut by the verified manifest. */
export interface RetainedContentFacts {
  producer: Awaited<ReturnType<typeof seedRecoveryContent>>;
  cut: Awaited<ReturnType<ContentCore['ownerPosition']>>;
  projectionCursor: Awaited<ReturnType<ContentCore['ownerPosition']>>;
  consumer: string;
  lineage: { dataEpoch: string; routingEpoch: string };
  unit: string;
  input: { phrase: string; language: string };
  before: Awaited<ReturnType<typeof queryPublicContentPhrase>>;
  beforeApi: { status: number; body: Record<string, unknown> };
  position: PublicTextPosition;
  retainedFacts: NonNullable<SparqlResult['results']>['bindings'];
  sourceVolumes: { graph: string; postgres: string; rustfs: string };
}

/** Consumers can only select and restore custody. They never prepare a producer. */
export async function withRetainedContentCopy(mode: 'valid' | 'missing' | 'ambiguous',
  consume: (copy: Awaited<ReturnType<typeof openRetainedContentCopy>>) => Promise<void>) {
  const copy = await openRetainedContentCopy(mode);
  try { await consume(copy); }
  finally { await copy.dispose(); }
}

/** Each negative test restores its own complete owner cut from the same key. */
export async function qualifyRetainedContentRefusal(mode: 'missing' | 'ambiguous') {
  await withRetainedContentCopy(mode, async copy => {
    const { facts, stack, phase, evidence } = copy;
    const copyAt = Date.now();
    await phase('stop-restored-original', () => stack.runner.stop());
    const volume = await phase('negative-graph-copy', () => copy.clone(facts.sourceVolumes.graph, mode));
    expect(volume).not.toBe(facts.sourceVolumes.graph);
    expect(volume).not.toBe(stack.stateVolume);
    const change = mode === 'missing' ? 'DELETE DATA' : 'INSERT DATA';
    const value = mode === 'missing' ? 'Body' : 'Title';
    const mutation = `PREFIX rv: <${RV}> ${change} { GRAPH <${PUBLIC}> { ${iri(facts.unit)} rv:field rv:${value} . } }`;
    Object.assign(evidence, { isolatedGraph: volume, mutation });
    await phase('offline-source-mutation', () => copy.offline(volume, `exec 9>>${STATE}/owner.lock
flock -n 9
cat > /tmp/source-control.ru <<'RU'
${mutation}
RU
java -Xmx512m -cp ${JENA} tdb2.tdbupdate --loc=${STATE}/tdb2 --update=/tmp/source-control.ru`));
    evidence.indexLog = (await phase('offline-index', () => copy.offline(volume, OFFLINE_INDEX_SCRIPT))).slice(-4000);
    await phase('startup-refusal', async () => {
      await expect(copy.start(volume, url => waitForFuseki(url, 20_000))).rejects.toThrow(/did not become ready/);
      const refusal = readFileSync(join(copy.artifacts, `standalone-fuseki-readiness-${evidence.nativeContainer}.log`), 'utf8');
      evidence.refusal = refusal;
      copy.record();
      expect(refusal).toContain('Content source field missing or ambiguous: field');
      expect(refusal).toContain('OccurrenceTextSchema.rebuildIfIncompatible');
    });
    evidence.copyElapsedMs = Date.now() - copyAt;
    expect(Date.now() - copyAt).toBeLessThan(600_000);
    await phase('final-backup-byte-equality', async () => {
      const final = await copy.store.select(copy.adapter);
      expect(final.integrity).toEqual(copy.lease.manifest.integrity);
      expect(final.digest).toBe(copy.lease.manifest.digest);
      evidence.finalManifestDigest = final.digest;
      evidence.finalIntegrityDigest = final.integrity.digest;
    });
  });
}

async function openRetainedContentCopy(mode: string) {
  const { runId, artifacts } = requireFaultTier();
  const store = new RetainedSources(retainedContentSourceDirectory());
  const adapter = retainedContentSourceAdapter();
  const startedAt = Date.now();
  const lease = await store.restore(adapter);
  const { stack, content, cursor, pools } = lease.candidate;
  const facts = lease.manifest.metadata as unknown as RetainedContentFacts;
  const phases: Record<string, number> = { restore: lease.elapsedMs };
  const evidence: Record<string, unknown> = { mode, sourceKey: lease.manifest.key,
    manifestDigest: lease.manifest.digest, integrityDigest: lease.manifest.integrity.digest,
    producerRevision: lease.manifest.provenance.producerRevision,
    sourceQaIdentity: lease.manifest.provenance.qaIdentity, runId, image: pinnedImage(),
    sourceVolumes: facts.sourceVolumes, restoredProject: stack.project,
    restoredVolumes: { graph: stack.stateVolume, postgres: `${stack.project}_postgres_data`, rustfs: `${stack.project}_rustfs_data` },
    restoredObjectDirectory: stack.apps.MAIN_OBJECT_DIRECTORY,
    admissionWaitMs: lease.admissionWaitMs, phasesMs: phases };
  const record = () => writeFileSync(join(artifacts, `retained-content-source-${mode}.json`),
    `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  const phase = async <T>(name: string, work: () => T | Promise<T>): Promise<T> => {
    const at = Date.now();
    evidence.activePhase = name;
    record();
    try { return await work(); }
    finally { phases[name] = Date.now() - at; delete evidence.activePhase; record(); }
  };
  const volumes: string[] = [];
  const containers: StandaloneFuseki[] = [];
  const clone = async (source: string, kind: string) => {
    const volume = `rezics-source-${kind}-${randomUUID()}`;
    volumes.push(volume);
    await copyVolume(source, volume, stack.dockerEnv);
    return volume;
  };
  const offline = (volume: string, script: string) => {
    // The runner supplies the isolated owner's private config to the native image.
    // It must never be redirected to an immutable source volume.
    if (Object.values(facts.sourceVolumes).includes(volume)) throw new Error('native process cannot open retained custody');
    if (volume === stack.stateVolume) return stack.runner.offline(script);
    return runOffline(volume, script, stack.dockerEnv);
  };
  const dump = (volume: string) => offline(volume, `java -Xmx512m -cp ${JENA} tdb2.tdbdump --loc=${STATE}/tdb2`);
  const env = { fuseki: stack.fuseki, lineage: facts.lineage, objectDirectory: stack.apps.MAIN_OBJECT_DIRECTORY! };
  const query = (client: FusekiClient) => queryPublicContentPhrase({ ...env, fuseki: client }, content, cursor, facts.consumer, facts.input);
  const publicSearch = async (client: FusekiClient) => {
    const dependencies = { environment: { ...env, fuseki: client }, account: {},
      access: new AccessAdmissionRegistry(pools.access), contentProjection: { content, cursor, consumer: facts.consumer } } as SearchRouteDependencies;
    const response = await searchRoutes(client, dependencies).handle(new Request('http://main.local/v1/queries', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile: 'public-content-phrase-v1', ...facts.input }) }));
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  const start = (volume: string, waitForReady?: (url: string) => Promise<void>) => {
    const name = `rezics-source-${mode}-${randomUUID().slice(0, 12)}`;
    evidence.nativeContainer = name;
    return standaloneFuseki(stack.dockerEnv, { name, volume, image: pinnedImage(), secrets: fusekiSecrets(stack.composeEnv) },
      { onAllocated: value => containers.push(value), ...(waitForReady ? { waitForReady } : {}) });
  };
  const client = (server: StandaloneFuseki) => new FusekiClient(server.url,
    stack.composeEnv.FUSEKI_MAINTENANCE_TOKEN!, stack.composeEnv.FUSEKI_COMMAND_TOKEN!);
  record();
  return { stack, facts, lease, store, adapter, phases, evidence, record, phase, clone, offline, dump,
    query, publicSearch, start, client, startedAt, artifacts,
    originalRdf: () => readFileSync(join(lease.manifest.provenance.backupPath, 'rdf.json'), 'utf8'),
    dispose: async () => {
      await phase('cleanup', async () => {
        try {
          for (const container of containers.reverse()) container.remove();
          removeVolumes(volumes, stack.dockerEnv);
        } finally { await lease.dispose(); }
      });
      evidence.activeElapsedMs = Date.now() - startedAt - lease.admissionWaitMs;
      record();
    } };
}

function runOffline(volume: string, script: string, docker: NodeJS.ProcessEnv): string {
  return run('docker', ['run', '--rm', '--network', 'none', '--hostname', 'localhost',
    '--volume', `${volume}:/fuseki/databases`, '--entrypoint', 'sh', pinnedImage(), '-ec', script], docker, 180_000);
}
