import { qaStartupTestTimeout } from '../../../scripts/qa/stack-startup.ts';
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { graphErasureSuppressed, suppressGraphContentRevisions }
  from '../../../services/main/src/modules/erasure/graph.ts';
import { readMainOutboxEnvelope, readNextMainOutboxBatch }
  from '../../../services/main/src/modules/outbox/relay.ts';
import { initializeFreshGraph } from '../../../services/main/src/modules/work/activate.ts';
import { offlineTextIndex } from '../../../scripts/operations/search-state.ts';
import { qaStack, requireFaultTier, rootCommand } from './search-ops-support.ts';

const RV = 'https://rezics.com/vocab/';
const PUBLIC = 'urn:rezics:search:public';
const PRIVATE = 'urn:rezics:search:private';

test('OPS10/SEARCH20/WORK10: graph command suppresses exact public and private units with replay proof', async () => {
  const { runId } = requireFaultTier();
  const stack = qaStack(`${runId}-ec`);
  let started = false;
  try {
    started = true;
    await rootCommand(['stack:up', ...stack.args], 180_000);
    const lineage = { dataEpoch: stack.apps.MAIN_DATA_EPOCH!,
      routingEpoch: stack.apps.MAIN_ROUTING_EPOCH! };
    await initializeFreshGraph(stack.fuseki, lineage);
    const revisionId = randomUUID();
    const unindexedRevisionId = randomUUID();
    const target = `urn:rezics:content:revision:${revisionId}`;
    const publicUnit = `urn:rezics:content:match-unit:${randomUUID()}`;
    const privateUnit = `urn:rezics:content:match-unit:${randomUUID()}`;
    const retainedUnit = `urn:rezics:content:match-unit:${randomUUID()}`;
    stack.runner.stop();
    stack.runner.offline(`cat > /fuseki/databases/erasure-command.nq <<'NQ'
<${publicUnit}> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <${RV}MatchUnit> <${PUBLIC}> .
<${publicUnit}> <${RV}revision> <${target}> <${PUBLIC}> .
<${publicUnit}> <${RV}searchBody> "erase graph phrase"@en <${PUBLIC}> .
<${privateUnit}> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <${RV}MatchUnit> <${PRIVATE}> .
<${privateUnit}> <${RV}contentRevision> <${target}> <${PRIVATE}> .
<${privateUnit}> <${RV}privateSearchBody> "private erased phrase"@en <${PRIVATE}> .
<${retainedUnit}> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <${RV}MatchUnit> <${PUBLIC}> .
<${retainedUnit}> <${RV}searchBody> "retained graph phrase"@en <${PUBLIC}> .
NQ
java -Xmx2g -cp /opt/apache-jena-fuseki-6.2.0/fuseki-server.jar \
  tdb2.tdbloader --loader=phased --loc=/fuseki/databases/rezics/tdb2 \
  /fuseki/databases/erasure-command.nq`);
    await stack.runner.start();
    await offlineTextIndex(stack.runner);
    const erasureId = randomUUID();
    const targets = [revisionId, unindexedRevisionId];
    await suppressGraphContentRevisions(stack.fuseki, lineage, erasureId, '7', targets);
    expect(await graphErasureSuppressed(stack.fuseki, erasureId, '7', targets)).toBe(true);
    // Same receipt is idempotent; a different erasure cannot retarget this IRI.
    await suppressGraphContentRevisions(stack.fuseki, lineage, erasureId, '7', targets);
    await expect(suppressGraphContentRevisions(stack.fuseki, lineage,
      randomUUID(), '8', [revisionId])).rejects.toThrow();
    const phrase = async (graph: string, field: string, value: string) => stack.fuseki.query(
      `PREFIX rv: <${RV}> PREFIX text: <http://jena.apache.org/text#>
       SELECT ?unit WHERE { GRAPH <${graph}> {
         (?unit ?score) text:query (rv:${field} '"${value}"' 10) . } }`);
    expect((await phrase(PUBLIC, 'searchBody', 'erase graph phrase')).results?.bindings).toHaveLength(0);
    expect((await phrase(PRIVATE, 'privateSearchBody', 'private erased phrase')).results?.bindings).toHaveLength(0);
    expect((await phrase(PUBLIC, 'searchBody', 'retained graph phrase')).results?.bindings[0]?.unit?.value)
      .toBe(retainedUnit);
    const batch = await readNextMainOutboxBatch(stack.fuseki, lineage.dataEpoch, '0');
    expect(batch?.eventIds).toHaveLength(1);
    const event = await readMainOutboxEnvelope(stack.fuseki, batch!, batch!.eventIds[0]!);
    expect(event).toMatchObject({ type: 'com.rezics.erasure.graph-suppressed.v1',
      data: { receipt: { action: 'erasure.graph', systemProof: { kind: 'relay-erasure',
        erasureId, erasureEpoch: '7' } } } });
  } finally {
    if (started) await rootCommand(['stack:reset', ...stack.args], 120_000);
  }
}, qaStartupTestTimeout(420_000));
