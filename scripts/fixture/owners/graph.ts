import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { profileRegistry } from '../../../packages/model/src/generated/profiles.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { CONTINUITY, DATASET, GRAPHS, PROFILE, RV } from '../../../services/main/src/modules/work/activate.ts';
import { type Corpus, type FixtureWork, IMPORT_SEQUENCE, RecordDigest, corpusWorks, sampleIndices,
  sha256, workAt } from '../corpus.ts';
import { componentObjects } from './objects.ts';
import type { FixtureOwner, LoadTarget } from './types.ts';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';
const JAR = '/opt/apache-jena-fuseki-6.2.0/fuseki-server.jar';
const TDB2 = '/fuseki/databases/rezics/tdb2';
const LUCENE = '/fuseki/databases/rezics/lucene';

const node = (value: string) => `<${value}>`;
const text = (value: string) => JSON.stringify(value);

/** The current and revision quads activateMetadataWork commits, minus its receipt and outbox. */
function* workQuads(corpus: Corpus, work: FixtureWork): Generator<[keyof typeof GRAPHS, string]> {
  const current = (s: string, p: string, o: string) =>
    ['current', `${node(s)} ${node(p)} ${o} ${node(GRAPHS.current)} .`] as [keyof typeof GRAPHS, string];
  yield current(work.work, RDF_TYPE, node('https://schema.org/CreativeWork'));
  for (const type of work.semanticTypes) yield current(work.work, RDF_TYPE, node(type));
  yield current(work.work, `${RV}mainVersion`, node(work.mainVersion));
  yield current(work.work, `${RV}continuityProfile`, node(CONTINUITY));
  yield current(work.work, RDFS_LABEL, `${text(work.title)}@en`);
  yield current(work.work, `${RV}head`, node(work.workRevision));
  yield current(work.mainVersion, RDF_TYPE, node(`${RV}MainVersion`));
  yield current(work.mainVersion, `${RV}work`, node(work.work));
  yield current(work.mainVersion, `${RV}hostingPolicy`, node(`${RV}MetadataOnly`));
  yield current(work.mainVersion, `${RV}head`, node(work.mainRevision));
  const objects = componentObjects(work);
  for (const [revision, component, manifest] of [
    [work.workRevision, work.work, objects.workManifest],
    [work.mainRevision, work.mainVersion, objects.mainManifest],
  ] as const) {
    const anchor = (p: string, o: string) =>
      ['revisions', `${node(revision)} ${node(p)} ${o} ${node(GRAPHS.revisions)} .`] as [keyof typeof GRAPHS, string];
    yield anchor(RDF_TYPE, node(`${RV}RevisionAnchor`));
    yield anchor(`${RV}component`, node(component));
    yield anchor(`${RV}operation`, node(corpus.importOperation));
    yield anchor(`${RV}manifest`, node(`urn:rezics:sha256:${manifest.digest}`));
    yield anchor(`${RV}modelRevision`, node(PROFILE));
    yield anchor(`${RV}shapeRevision`, node(PROFILE));
    yield anchor(`${RV}datasetId`, node(DATASET));
    yield anchor(`${RV}dataEpoch`, text(corpus.lineage.dataEpoch));
    yield anchor(`${RV}sequence`, `"${IMPORT_SEQUENCE}"^^${node(XSD_INTEGER)}`);
  }
}

async function* nquads(corpus: Corpus): AsyncGenerator<string> {
  let chunk = '';
  for (const work of corpusWorks(corpus)) {
    for (const [, quad] of workQuads(corpus, work)) chunk += `${quad}\n`;
    if (chunk.length > 1_048_576) { yield chunk; chunk = ''; }
  }
  if (chunk) yield chunk;
}

async function count(fuseki: FusekiClient, graph: string): Promise<number> {
  const result = await fuseki.query(`SELECT (COUNT(*) AS ?n) WHERE { GRAPH <${graph}> { ?s ?p ?o } }`);
  return Number(result.results?.bindings[0]?.n?.value ?? Number.NaN);
}

export const graphOwner: FixtureOwner = {
  name: 'graph',
  generator: 'graph-work-metadata-v1',
  phase: 'offline-graph',
  compatibilityInputs(root) {
    const dockerfile = readFileSync(join(root, 'infra/jena/Dockerfile'), 'utf8');
    return {
      jena: /^ARG FUSEKI_VERSION=(\d+\.\d+\.\d+)$/m.exec(dockerfile)?.[1] ?? 'unknown',
      'infra/jena/fuseki-text.ttl': sha256(readFileSync(join(root, 'infra/jena/fuseki-text.ttl'))),
      'profile:work-metadata-v1': profileRegistry['work-metadata-v1'].sha256,
    };
  },
  summarize(corpus) {
    const digest = new RecordDigest();
    for (const work of corpusWorks(corpus)) {
      for (const [graph, quad] of workQuads(corpus, work)) digest.add(`graph:${graph}`, quad);
    }
    return digest.finish();
  },
  async load(corpus, target) {
    const started = performance.now();
    // No server holds the stopped TDB2; it already has the bootstrap control graph.
    const loader = await target.fusekiOffline(
      `java -Xmx4g -cp ${JAR} tdb2.tdbloader --loc ${TDB2} --loader=phased --syntax=nquads`,
      nquads(corpus));
    const loaded = performance.now();
    // Same offline index construction as search:rebuild, for this new generation only.
    const indexer = await target.fusekiOffline(`rm -rf ${LUCENE} && mkdir -p ${LUCENE} && cd /fuseki `
      + `&& java -Xmx4g -cp ${JAR} jena.textindexer --desc=/fuseki/fuseki-text.ttl`);
    return { elapsedMs: performance.now() - started, detail: {
      loaderMs: Math.round(loaded - started), textIndexMs: Math.round(performance.now() - loaded),
      loaderTail: loader.trim().split('\n').slice(-3), indexerTail: indexer.trim().split('\n').slice(-2) } };
  },
  async verify(corpus, target: LoadTarget) {
    const fuseki = new FusekiClient(target.apps.FUSEKI_URL!);
    for (const index of sampleIndices(corpus)) {
      const work = workAt(corpus, index);
      const hit = await fuseki.query(`PREFIX text: <http://jena.apache.org/text#>
        SELECT ?s WHERE { GRAPH <${GRAPHS.current}> {
          (?s ?score ?literal) text:query (<${RDFS_LABEL}> ${text(work.token)} 5) } }`);
      const found = (hit.results?.bindings ?? []).map(row => row.s?.value);
      if (found.length !== 1 || found[0] !== work.work) {
        throw new Error(`text index does not resolve sample ${work.token} to its Work`);
      }
    }
    return { 'graph:current': await count(fuseki, GRAPHS.current),
      'graph:revisions': await count(fuseki, GRAPHS.revisions) };
  },
};
