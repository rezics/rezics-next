import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { initializeFreshGraph } from '../../../services/main/src/modules/work/activate.ts';
import { cutoverRestoredGraphLineage } from '../../../services/main/src/modules/work/restore-lineage.ts';
import { assertPublicTextReady, SearchIndexUnavailable }
  from '../../../services/main/src/modules/work/search-readiness.ts';
import { fusekiSecrets, pinnedImage, qaStack, requireFaultTier, root,
  rootCommand, standaloneFuseki } from './search-ops-support.ts';

const RV = 'https://rezics.com/vocab/';
const GRAPH = 'urn:rezics:search:public';
const PRIVATE_GRAPH = 'urn:rezics:search:private';

test('OPS10/SEARCH08/SEARCH20/WORK10: offline sanitized graph and Lucene copy excludes an exact erased revision', async () => {
  const { runId } = requireFaultTier();
  const stack = qaStack(`${runId}-eg`);
  const candidateName = `rezics-erasure-${randomUUID().slice(0, 12)}`;
  const retirementId = `qa-${randomUUID().slice(0, 12)}`;
  let started = false;
  let candidate: Awaited<ReturnType<typeof standaloneFuseki>> | undefined;
  try {
    started = true;
    rootCommand(['stack:up', ...stack.args], 180_000);
    const lineage = { dataEpoch: stack.apps.MAIN_DATA_EPOCH!, routingEpoch: '1' };
    await initializeFreshGraph(stack.fuseki, lineage);
    stack.runner.stop();
    const revision = `urn:rezics:content:revision:${randomUUID()}`;
    const projection = `urn:rezics:content:projection:${randomUUID()}`;
    const erasedUnit = `urn:rezics:content:match-unit:${randomUUID()}`;
    const privateUnit = `urn:rezics:content:match-unit:${randomUUID()}`;
    const retainedUnit = `urn:rezics:content:match-unit:${randomUUID()}`;
    const seed = `
<${projection}> <${RV}contentRevision> <${revision}> <urn:rezics:graph:revisions> .
<${projection}> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <${RV}ContentProjection> <urn:rezics:graph:revisions> .
<${projection}> <${RV}matchUnit> <${erasedUnit}> <urn:rezics:graph:revisions> .
<${erasedUnit}> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <${RV}MatchUnit> <${GRAPH}> .
<${erasedUnit}> <${RV}revision> <${revision}> <${GRAPH}> .
<${erasedUnit}> <${RV}projection> <${projection}> <${GRAPH}> .
<${erasedUnit}> <${RV}searchBody> "forbidden lighthouse payload"@en <${GRAPH}> .
<${privateUnit}> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <${RV}MatchUnit> <${PRIVATE_GRAPH}> .
<${privateUnit}> <${RV}revision> <${revision}> <${PRIVATE_GRAPH}> .
<${privateUnit}> <${RV}privateSearchBody> "hidden forbidden payload"@en <${PRIVATE_GRAPH}> .
<${retainedUnit}> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <${RV}MatchUnit> <${GRAPH}> .
<${retainedUnit}> <${RV}searchBody> "retained lighthouse payload"@en <${GRAPH}> .
<urn:rezics:search:public:anchor> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <${RV}SearchGraphAnchor> <${GRAPH}> .
`;
    // The stopped synthetic source mirrors a prepared revision and an unrelated
    // public unit. The purge operates on TDB2 bytes, never on a mock dataset.
    stack.runner.offline(`cat > /fuseki/databases/erasure-seed.nq <<'NQ'
${seed}NQ
java -Xmx2g -cp /opt/apache-jena-fuseki-6.2.0/fuseki-server.jar \
  tdb2.tdbloader --loader=phased --loc=/fuseki/databases/rezics/tdb2 \
  /fuseki/databases/erasure-seed.nq`);
    const mount = `${join(root, 'infra/jena/purge-tdb2.sh')}:/tmp/purge-tdb2.sh:ro`;
    const active = stack.compose(['run', '--rm', '--no-deps', '-T', '--volume', mount,
      '--entrypoint', 'sh', 'fuseki', '-ec',
      `sh /tmp/purge-tdb2.sh /fuseki/databases/erasure-candidate '${revision}' 7`], 300_000);
    expect(active.status).toBe(0);
    expect(active.output).toContain('sanitized candidate built');
    const duplicate = stack.compose(['run', '--rm', '--no-deps', '-T', '--volume', mount,
      '--entrypoint', 'sh', 'fuseki', '-ec',
      `sh /tmp/purge-tdb2.sh /fuseki/databases/erasure-candidate '${revision}' 7`], 30_000);
    expect(duplicate.status).toBe(75);
    const source = stack.runner.offline('java -cp /opt/apache-jena-fuseki-6.2.0/fuseki-server.jar tdb2.tdbdump --loc=/fuseki/databases/rezics/tdb2');
    expect(source).toContain('forbidden lighthouse payload');
    const copied = stack.runner.offline('java -cp /opt/apache-jena-fuseki-6.2.0/fuseki-server.jar tdb2.tdbdump --loc=/fuseki/databases/erasure-candidate/databases/rezics/tdb2');
    expect(copied).not.toContain('forbidden lighthouse payload');
    expect(copied).not.toContain('hidden forbidden payload');
    expect(copied).toContain(revision);
    expect(copied).toContain('ErasedRevision');
    expect(copied).toContain('erasureEpoch');
    expect(copied).toContain('retained lighthouse payload');
    candidate = await standaloneFuseki(stack.dockerEnv, {
      name: candidateName, image: pinnedImage(),
      volume: stack.stateVolume,
      secrets: { ...fusekiSecrets(stack.composeEnv),
        FUSEKI_BASE: '/fuseki/databases/erasure-candidate' },
      command: ['sh', '-ec', 'cd /fuseki/databases/erasure-candidate && exec /opt/apache-jena-fuseki-6.2.0/fuseki-server --port=3030 --no-cors --timeout=10000 --config=/fuseki/fuseki-text.ttl'],
    });
    const query = async (phrase: string, graph = GRAPH,
      field: 'searchBody' | 'privateSearchBody' = 'searchBody', url = candidate!.url) => {
      const response = await fetch(new URL('query', url), { method: 'POST',
        headers: { 'content-type': 'application/sparql-query', accept: 'application/sparql-results+json' },
        body: `PREFIX rv: <${RV}> PREFIX text: <http://jena.apache.org/text#>
          SELECT ?unit WHERE { GRAPH <${graph}> {
            (?unit ?score) text:query (rv:${field} '"${phrase}"' 10) . } }` });
      expect(response.status).toBe(200);
      return await response.text();
    };
    expect(await query('forbidden lighthouse payload')).not.toContain(erasedUnit);
    expect(await query('hidden forbidden payload', PRIVATE_GRAPH, 'privateSearchBody'))
      .not.toContain(privateUnit);
    expect(await query('retained lighthouse payload')).toContain(retainedUnit);
    const receipt = `urn:rezics:receipt:erasure-replay-test:${randomUUID()}`;
    const replay = await fetch(new URL('command', candidate.url), { method: 'POST',
      headers: { 'content-type': 'application/json', authorization:
        `Bearer ${stack.composeEnv.FUSEKI_COMMAND_TOKEN}` },
      body: JSON.stringify({ receipt, digest: 'a'.repeat(64), deadlineMs: 10_000,
        validations: [], update: `PREFIX rv: <${RV}> INSERT {
          GRAPH <urn:rezics:graph:revisions> { <${projection}> rv:contentRevision <${revision}> . }
          GRAPH <urn:rezics:graph:receipts> { <${receipt}> a rv:OperationReceipt . }
        } WHERE { }` }) });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ status: 'invalid',
      report: 'erased exact revision cannot be reactivated' });
    const candidateClient = new FusekiClient(candidate.url,
      stack.composeEnv.FUSEKI_MAINTENANCE_TOKEN, stack.composeEnv.FUSEKI_COMMAND_TOKEN);
    const next = { dataEpoch: randomUUID(),
      routingEpoch: (BigInt(lineage.routingEpoch) + 1n).toString() };
    expect(await cutoverRestoredGraphLineage(candidateClient, {
      prior: { ...lineage, sequence: '0' }, next })).toMatchObject({
      lineage: next, sequence: '0', replayed: false });
    await expect(assertPublicTextReady(candidateClient, next))
      .rejects.toBeInstanceOf(SearchIndexUnavailable);
    expect(candidate.runner.exec('test ! -e /fuseki/databases/erasure-candidate/databases/rezics/lucene.uncertain && echo ready')).toContain('ready');
    await candidate.runner.stop();
    const activateMount = `${join(root, 'infra/jena/purge-activate.sh')}:/tmp/purge-activate.sh:ro`;
    const activate = (mode: string, candidateBase: string) => stack.compose(['run', '--rm', '--no-deps',
      '-T', '--volume', activateMount, '--entrypoint', 'sh', 'fuseki', '-ec',
      `sh /tmp/purge-activate.sh ${mode} ${candidateBase} '${revision}' 7 ${retirementId}`], 60_000);
    expect(activate('activate', '/fuseki/databases/erasure-candidate').status).toBe(75);
    stack.runner.offline(`cp /fuseki/databases/erasure-candidate/databases/rezics/erasure-purge.ready \
      /fuseki/databases/erasure-candidate/databases/rezics/erasure-purge.verified`);
    const promoted = activate('activate', '/fuseki/databases/erasure-candidate');
    expect(promoted.status).toBe(0);
    expect(promoted.output).toContain('candidate active');
    expect(activate('activate', '/fuseki/databases/erasure-candidate').status).toBe(75);
    expect(stack.runner.offline(`java -cp /opt/apache-jena-fuseki-6.2.0/fuseki-server.jar \
      tdb2.tdbdump --loc=/fuseki/databases/rezics/tdb2`)).not.toContain('forbidden lighthouse payload');
    expect(stack.runner.offline(`java -cp /opt/apache-jena-fuseki-6.2.0/fuseki-server.jar \
      tdb2.tdbdump --loc=/fuseki/databases/rezics-retired-${retirementId}/tdb2`))
      .toContain('forbidden lighthouse payload');
    await stack.runner.start();
    expect(await query('retained lighthouse payload', GRAPH, 'searchBody', stack.apps.FUSEKI_URL!))
      .toContain(retainedUnit);
    expect(await query('forbidden lighthouse payload', GRAPH, 'searchBody', stack.apps.FUSEKI_URL!))
      .not.toContain(erasedUnit);
    expect(activate('destroy', retirementId).status).toBe(75);
    await stack.runner.stop();
    const destroyed = activate('destroy', retirementId);
    expect(destroyed.status).toBe(0);
    expect(destroyed.output).toContain('retired fileset unlinked');
    expect(stack.runner.offline(`test ! -e /fuseki/databases/rezics-retired-${retirementId}
      test -f /fuseki/databases/rezics/erasure-purge.retired-${retirementId}
      test ! -e /fuseki/databases/purge.incomplete
      echo destroyed`)).toContain('destroyed');
  } finally {
    candidate?.remove();
    spawnSync('docker', ['rm', '-f', candidateName], { env: stack.dockerEnv, timeout: 60_000 });
    if (started) rootCommand(['stack:reset', ...stack.args], 120_000);
  }
}, 420_000);
