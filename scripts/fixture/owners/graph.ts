import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { profileRegistry } from '../../../packages/model/src/generated/profiles.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { CONTINUITY, DATASET, GRAPHS, PROFILE, PUBLIC_SEARCH_ANCHOR, RV }
  from '../../../services/main/src/modules/work/activate.ts';
import { PUBLIC_SEARCH_GRAPH } from '../../../services/main/src/modules/work/select-main.ts';
import { SELECTION_POLICY } from '../../../services/main/src/modules/space/create.ts';
import { type Corpus, type FixtureWork, IMPORT_SEQUENCE, RecordDigest, corpusWorks, publicUnitAt,
  fixtureRealm, sampleIndices, sha256, workAt } from '../corpus.ts';
import { componentObjects } from './objects.ts';
import type { FixtureOwner, LoadTarget } from './types.ts';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';
const JAR = '/opt/apache-jena-fuseki-6.2.0/fuseki-server.jar';
const COMMAND_JAR = '/fuseki/extra/fuseki-command.jar';
const TDB2 = '/fuseki/databases/rezics/tdb2';
const LUCENE = '/fuseki/databases/rezics/lucene';

const node = (value: string) => `<${value}>`;
const text = (value: string) => JSON.stringify(value);
type GraphKind = keyof typeof GRAPHS | 'public';

/** The current and revision quads activateMetadataWork commits, minus its receipt and outbox. */
function* workQuads(corpus: Corpus, work: FixtureWork): Generator<[GraphKind, string]> {
  const current = (s: string, p: string, o: string) =>
    ['current', `${node(s)} ${node(p)} ${o} ${node(GRAPHS.current)} .`] as [GraphKind, string];
  const revision = (s: string, p: string, o: string) =>
    ['revisions', `${node(s)} ${node(p)} ${o} ${node(GRAPHS.revisions)} .`] as [GraphKind, string];
  const publicQuad = (s: string, p: string, o: string) =>
    ['public', `${node(s)} ${node(p)} ${o} ${node(PUBLIC_SEARCH_GRAPH)} .`] as [GraphKind, string];
  if (work.index === 0) {
    const realm = fixtureRealm(corpus);
    yield current(realm.space, RDF_TYPE, node(`${RV}Space`));
    yield current(realm.space, `${RV}realmCapability`, node(realm.realm));
    yield current(realm.space, `${RV}disclosure`, node(`${RV}Public`));
    yield current(realm.realm, RDF_TYPE, node(`${RV}Realm`));
    yield current(realm.realm, `${RV}space`, node(realm.space));
    yield current(realm.realm, `${RV}realmState`, node(`${RV}Active`));
    yield current(realm.realm, `${RV}selectionPolicy`, node(SELECTION_POLICY));
    const rejected = publicUnitAt(corpus, Math.min(129, corpus.publicUnits - 1));
    yield current(realm.rejectionSlot, RDF_TYPE, node(`${RV}RealmPublicationSlot`));
    yield current(realm.rejectionSlot, `${RV}realm`, node(realm.realm));
    yield current(realm.rejectionSlot, `${RV}mainVersion`, node(rejected.work.mainVersion));
    yield current(realm.rejectionSlot, `${RV}selectionHead`, node(realm.rejectionSelection));
  }
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
      ['revisions', `${node(revision)} ${node(p)} ${o} ${node(GRAPHS.revisions)} .`] as [GraphKind, string];
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
  if (work.index === 0 || work.index > corpus.publicUnits) return;
  const selected = publicUnitAt(corpus, work.index - 1);
  yield current(work.mainVersion, `${RV}selectionHead`, node(selected.selection));
  yield current(selected.contribution, RDF_TYPE, node(`${RV}TextContribution`));
  yield current(selected.contribution, `${RV}work`, node(work.work));
  yield current(selected.contribution, `${RV}author`, node(work.agent));
  yield current(selected.contribution, `${RV}language`, text(work.language));
  yield current(selected.contribution, `${RV}draftHead`, node(selected.draft));
  yield current(selected.contribution, `${RV}publicationHead`, node(selected.decision));
  yield revision(selected.selection, RDF_TYPE, node(`${RV}PublicationSelection`));
  yield revision(selected.selection, `${RV}matchUnit`, node(selected.unit));
  yield revision(selected.selection, `${RV}mainVersion`, node(work.mainVersion));
  yield revision(selected.selection, `${RV}contribution`, node(selected.contribution));
  yield revision(selected.decision, RDF_TYPE, node(`${RV}PublicationDecision`));
  yield revision(selected.decision, `${RV}contribution`, node(selected.contribution));
  yield revision(selected.decision, `${RV}selectedDraft`, node(selected.draft));
  for (const [predicate, object] of [
    [RDF_TYPE, node(`${RV}MatchUnit`)], [`${RV}work`, node(work.work)],
    [`${RV}mainVersion`, node(work.mainVersion)], [`${RV}context`, node(work.mainVersion)],
    [`${RV}contribution`, node(selected.contribution)], [`${RV}revision`, node(selected.draft)],
    [`${RV}selection`, node(selected.selection)], [`${RV}language`, text(work.language)],
    [`${RV}field`, node(`${RV}Body`)], [`${RV}disclosure`, node(`${RV}Public`)],
    [`${RV}searchBody`, `${text(selected.body)}@${work.language}`],
  ]) yield publicQuad(selected.unit, predicate!, object!);
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
  generator: 'graph-work-public-search-v2',
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
    digest.add('graph:public', `${node(PUBLIC_SEARCH_ANCHOR)} ${node(RDF_TYPE)} ${node(`${RV}SearchGraphAnchor`)} ${node(PUBLIC_SEARCH_GRAPH)} .`);
    for (const work of corpusWorks(corpus)) {
      for (const [graph, quad] of workQuads(corpus, work)) digest.add(`graph:${graph}`, quad);
    }
    return digest.finish();
  },
  async load(corpus, target) {
    const started = performance.now();
    const heap = corpus.profile === 'small' ? '512m' : '4g';
    // No server holds the stopped TDB2; it already has the bootstrap control graph.
    const loader = await target.fusekiOffline(
      `java -Xmx${heap} -cp ${JAR} tdb2.tdbloader --loc ${TDB2} --loader=phased --syntax=nquads`,
      nquads(corpus),
    );
    const loaded = performance.now();
    // Same offline index construction as search:rebuild, for this new generation only.
    const indexer = await target.fusekiOffline(
      `rm -rf ${LUCENE} && mkdir -p ${LUCENE} && cd /fuseki ` +
        `&& java -Xmx${heap} -cp ${COMMAND_JAR}:${JAR} com.rezics.jena.ErasureTextIndexer --desc=/fuseki/fuseki-text.ttl`,
    );
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
    for (const ordinal of [0, Math.floor(corpus.publicUnits / 2), corpus.publicUnits - 1]) {
      const selected = publicUnitAt(corpus, ordinal);
      const hit = await fuseki.query(`PREFIX rv: <${RV}> PREFIX text: <http://jena.apache.org/text#>
        SELECT ?unit WHERE { GRAPH <${PUBLIC_SEARCH_GRAPH}> {
          (?unit ?score) text:query (rv:searchBody ${text(selected.work.token)} 2) .
          ?unit a rv:MatchUnit . } }`);
      const found = (hit.results?.bindings ?? []).map(row => row.unit?.value);
      if (found.length !== 1 || found[0] !== selected.unit) {
        throw new Error(`public text index does not resolve sample ${selected.work.token}`);
      }
    }
    const population = await fuseki.query(`PREFIX rv: <${RV}> SELECT (COUNT(?unit) AS ?n) WHERE {
      GRAPH <${PUBLIC_SEARCH_GRAPH}> { ?unit a rv:MatchUnit } }`);
    if (Number(population.results?.bindings[0]?.n?.value) !== corpus.publicUnits) {
      throw new Error('public MatchUnit population differs from fixture plan');
    }
    return { 'graph:current': await count(fuseki, GRAPHS.current),
      'graph:revisions': await count(fuseki, GRAPHS.revisions),
      'graph:public': await count(fuseki, PUBLIC_SEARCH_GRAPH) };
  },
};
