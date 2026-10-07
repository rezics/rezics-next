import type { RegisteredAdmission } from '../../services/main/src/modules/access/admission.ts';
import type { CommandEnvelope, FusekiClient, SparqlResult } from '../../services/main/src/infrastructure/fuseki.ts';
import { commitMetadata, readMetadataReceipt } from '../../services/main/src/modules/work/metadata-command.ts';
import { metadataComponent, type MetadataIntent } from '../../services/main/src/modules/work/metadata-schema.ts';
import { RV, hash, iri, type WorkActivationEnvironment } from '../../services/main/src/modules/work/activate.ts';

type Term = NonNullable<SparqlResult['results']>['bindings'][number][string];

export interface EditionCommandMeasurement {
  mode: 'legacy' | 'slim';
  work: string;
  component: string;
  revision: string;
  receipt: string;
  persistedQuads: number;
  serializedNQuadsBytes: number;
  defaultGraphQuads: number;
  namedGraphQuads: number;
  proofQuads: number;
  graphCommitMs: number;
  operationMs: number;
  commandRequestBytes: number;
}

function nquadTerm(term: Term): string {
  if (term.type === 'uri') return `<${term.value}>`;
  if (term.type === 'bnode') return `_:${term.value}`;
  const literal = JSON.stringify(term.value);
  return term['xml:lang'] ? `${literal}@${term['xml:lang']}`
    : term.datatype ? `${literal}^^<${term.datatype}>` : literal;
}

/** Count the command's persisted component, new revision, receipt and outbox facts.
 * The shared control counter and older revisions are outside this command cut. */
export async function editionCommandFootprint(fuseki: FusekiClient,
  input: { work: string; component: string; revision: string; receipt: string }) {
  const batch = `urn:rezics:outbox:${hash(input.receipt)}`;
  const event = `urn:rezics:event:${hash(input.receipt)}`;
  const rows = (await fuseki.query(`PREFIX rv: <${RV}>
    SELECT ?graph ?subject ?predicate ?object WHERE {
      VALUES ?subject { ${[input.component, input.revision, input.receipt, batch, event, input.work].map(iri).join(' ')} }
      { GRAPH ?graph { ?subject ?predicate ?object } } UNION { ?subject ?predicate ?object }
      FILTER(?subject != ${iri(input.work)} || ?predicate = rv:editionsRevision)
    }`, 1_048_576)).results?.bindings;
  if (!rows) throw new Error('Edition command footprint is unavailable');
  const serialized = rows.map(row => {
    if (!row.subject || !row.predicate || !row.object) throw new Error('Incomplete command footprint quad');
    return `${nquadTerm(row.subject)} ${nquadTerm(row.predicate)} ${nquadTerm(row.object)}${row.graph ? ` ${nquadTerm(row.graph)}` : ''} .\n`;
  }).sort().join('');
  return { persistedQuads: rows.length, serializedNQuadsBytes: Buffer.byteLength(serialized),
    defaultGraphQuads: rows.filter(row => !row.graph).length,
    namedGraphQuads: rows.filter(row => row.graph).length,
    proofQuads: rows.filter(row => row.subject!.value === input.receipt).length };
}

/** Runs the real metadata primitive. Compare modes on one edition with identical state;
 * the second command uses the first revision as its CAS basis. No backend is started. */
export async function measureEditionCommand(input: {
  mode: EditionCommandMeasurement['mode']; env: WorkActivationEnvironment;
  admission: RegisteredAdmission; intent: MetadataIntent;
}): Promise<EditionCommandMeasurement> {
  if (input.intent.state.kind !== 'edition') throw new Error('Measurement requires one edition component');
  const latencies: number[] = [];
  const requestBytes: number[] = [];
  const fuseki = new Proxy(input.env.fuseki, {
    get(target, property) {
      if (property === 'commandWithReceipt') return async (envelope: CommandEnvelope) => {
        const started = performance.now();
        requestBytes.push(Buffer.byteLength(JSON.stringify(envelope)));
        try { return await target.commandWithReceipt(envelope); }
        finally { latencies.push(performance.now() - started); }
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as FusekiClient;
  const env = { ...input.env, fuseki };
  const started = performance.now();
  if (!await commitMetadata(env, input.admission, input.intent)) throw new Error('Measurement command did not commit');
  const operationMs = performance.now() - started;
  const receipt = await readMetadataReceipt(env, input.admission.id);
  if (receipt?.outcome !== 'succeeded' || !receipt.revision || latencies.length !== 1) {
    throw new Error('Measurement requires one successful native command request');
  }
  const identities = { work: input.intent.work, component: metadataComponent(input.intent.work, input.intent.state),
    revision: receipt.revision, receipt: receipt.receipt };
  return { mode: input.mode, ...identities, ...await editionCommandFootprint(fuseki, identities),
    graphCommitMs: latencies[0]!, operationMs, commandRequestBytes: requestBytes[0]! };
}

export function compareEditionCommands(before: EditionCommandMeasurement, after: EditionCommandMeasurement) {
  if (before.mode !== 'legacy' || after.mode !== 'slim' || before.work !== after.work || before.component !== after.component) {
    throw new Error('Comparison requires the same Work and edition fixture in legacy then slim mode');
  }
  return { format: 'rezics-slim-command-measurement-v1', command: 'work-metadata-details-v1/edition',
    measuredAt: new Date().toISOString(), before, after,
    reduction: { quads: before.persistedQuads - after.persistedQuads,
      serializedNQuadsBytes: before.serializedNQuadsBytes - after.serializedNQuadsBytes,
      quadFraction: 1 - after.persistedQuads / before.persistedQuads,
      serializedByteFraction: 1 - after.serializedNQuadsBytes / before.serializedNQuadsBytes },
    timingScope: 'Single native command request wall time; operation time additionally includes graph reads, object custody and PostgreSQL reconciliation.',
    storageScope: 'Component, new revision, receipt, batch, event and Work editionsRevision; shared control counter and older history excluded.' };
}
