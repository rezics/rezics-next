import { createHash } from 'node:crypto';
import { CommandOutcomeUnknown, CommandRejected, type CommandEnvelope,
  type CommandResult, type FusekiClient } from './fuseki.ts';

const RV = 'https://rezics.com/vocab/';
const DATASET = 'urn:rezics:dataset:product';
const CONTROL = 'urn:rezics:graph:control';
const RECEIPTS = 'urn:rezics:graph:receipts';
const OUTBOX = 'urn:rezics:graph:outbox';

function iri(value: string): string {
  if (!/^(https?:\/\/[^<>\s"{}|\\^`]+|urn:[A-Za-z0-9][A-Za-z0-9:._-]+)$/.test(value)) {
    throw new Error('invalid command IRI');
  }
  return `<${value}>`;
}
const lit = (value: string) => JSON.stringify(value);

/** Commit a typed terminal rejection that races with the original receipt identity. */
export async function finalizeInvalidProfile(fuseki: FusekiClient,
  lineage: { dataEpoch: string; routingEpoch: string }, receipt: string,
  digest: string, admission: {
    id: string; authorityEpoch: string; scope: string;
  }): Promise<'rejected' | 'succeeded'> {
  const batch = `urn:rezics:outbox:${createHash('sha256').update(`${receipt}\0invalid`).digest('hex')}`;
  const update = `PREFIX rv: <${RV}>
    DELETE { GRAPH ${iri(CONTROL)} { ${iri(DATASET)} rv:sequence ?n } }
    INSERT {
      GRAPH ${iri(CONTROL)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(RECEIPTS)} { ${iri(receipt)} a rv:OperationReceipt ;
        rv:requestDigest ${lit(digest)} ; rv:admissionId ${lit(admission.id)} ;
        rv:authorityEpoch ${lit(admission.authorityEpoch)} ; rv:admittedScope ${lit(admission.scope)} ;
        rv:outcome rv:Cancelled ; rv:rejectionKind rv:InvalidProfile ;
        rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(lineage.dataEpoch)} ;
        rv:sequence ?next . }
      GRAPH ${iri(OUTBOX)} { ${iri(batch)} a rv:OutboxBatch ;
        rv:dataEpoch ${lit(lineage.dataEpoch)} ; rv:sequence ?next ; rv:eventCount 0 . }
    }
    WHERE {
      GRAPH ${iri(CONTROL)} { ${iri(DATASET)} rv:dataEpoch ${lit(lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(lineage.routingEpoch)} ; rv:sequence ?n . }
      FILTER NOT EXISTS { GRAPH ${iri(CONTROL)} { ${iri(DATASET)} rv:restoreHold true } }
      FILTER NOT EXISTS { GRAPH ${iri(RECEIPTS)} { ${iri(receipt)} ?p ?o } }
      BIND(?n + 1 AS ?next)
    }`;
  await fuseki.commandWithReceipt({ receipt, digest, update, validations: [], deadlineMs: 10_000 });
  const observed = await fuseki.query(`PREFIX rv: <${RV}> SELECT ?digest ?outcome ?kind WHERE {
    GRAPH ${iri(RECEIPTS)} { ${iri(receipt)} rv:requestDigest ?digest ; rv:outcome ?outcome .
      OPTIONAL { ${iri(receipt)} rv:rejectionKind ?kind } }
  }`);
  const rows = observed.results?.bindings ?? [];
  if (rows.length !== 1 || !rows[0]?.digest || !rows[0]?.outcome) {
    throw new CommandOutcomeUnknown('invalid command rejection receipt unavailable');
  }
  const row = rows[0]!;
  if (row.digest.value !== digest) throw new CommandRejected({ status: 'conflict' });
  if (row.outcome.value === `${RV}Cancelled` && row.kind?.value === `${RV}InvalidProfile`) {
    return 'rejected';
  }
  if (row.outcome.value === `${RV}Succeeded`) return 'succeeded';
  throw new CommandOutcomeUnknown('unexpected terminal outcome after invalid command');
}

export async function validatedCommand(env: {
  fuseki: FusekiClient; lineage: { dataEpoch: string; routingEpoch: string };
}, envelope: CommandEnvelope, admission: {
  id: string; authorityEpoch: string; scope: string;
}): Promise<CommandResult> {
  const result = await env.fuseki.commandWithReceipt(envelope);
  if (result.status === 'invalid') {
    const terminal = await finalizeInvalidProfile(env.fuseki, env.lineage,
      envelope.receipt, envelope.digest, admission);
    if (terminal === 'rejected') return result;
    return env.fuseki.commandWithReceipt(envelope);
  }
  if (result.status === 'committed') {
    const replay = await env.fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(RECEIPTS)} {
      ${iri(envelope.receipt)} rv:outcome rv:Cancelled ; rv:rejectionKind rv:InvalidProfile . } }`);
    if (replay.boolean === true) return { status: 'invalid' };
  }
  return result;
}

export async function assertNotInvalidProfileReceipt(fuseki: FusekiClient, receipt: string): Promise<void> {
  const result = await fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(RECEIPTS)} {
    ${iri(receipt)} rv:outcome rv:Cancelled ; rv:rejectionKind rv:InvalidProfile . } }`);
  if (result.boolean === true) throw new CommandRejected({ status: 'invalid' });
}
