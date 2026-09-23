import { createHash } from 'node:crypto';
import type { RegisteredAdmission } from '../access/admission.ts';
import type { WorkActivationEnvironment } from './activate.ts';
import { readWorkTerminalReceipt, workReceiptIri, type WorkTerminalReceipt } from './receipt.ts';

const RV = 'https://rezics.com/vocab/';
const DATASET = 'urn:rezics:dataset:product';
const CONTROL = 'urn:rezics:graph:control';
const RECEIPTS = 'urn:rezics:graph:receipts';
const OUTBOX = 'urn:rezics:graph:outbox';

export class PendingWorkSeal extends Error {}
export class WorkSealConflict extends Error {}

function terminalMatches(receipt: WorkTerminalReceipt, admission: RegisteredAdmission): boolean {
  return receipt.admissionId === admission.id
    && receipt.requestDigest === admission.requestDigest
    && receipt.authorityEpoch === admission.authorityEpoch
    && receipt.scope === admission.scope;
}

/** Seal a Work admission in the same Jena receipt identity as activation. */
export async function sealMetadataWorkAdmission(
  env: WorkActivationEnvironment, admission: RegisteredAdmission,
): Promise<WorkTerminalReceipt> {
  if (admission.action !== 'work.create') throw new WorkSealConflict('unsupported admission action');
  const existing = await readWorkTerminalReceipt(env.fuseki, admission.id);
  if (existing) {
    if (!terminalMatches(existing, admission)) throw new WorkSealConflict('graph receipt differs from Access admission');
    return existing;
  }
  const receipt = workReceiptIri(admission.id);
  const eventHash = createHash('sha256').update(`${receipt}\0cancel`).digest('hex');
  const batch = `urn:rezics:outbox:${eventHash}`;
  const event = `urn:rezics:event:${eventHash}`;
  const update = `PREFIX rv: <${RV}>
    DELETE { GRAPH <${CONTROL}> { <${DATASET}> rv:sequence ?n } }
    INSERT {
      GRAPH <${CONTROL}> { <${DATASET}> rv:sequence ?next }
      GRAPH <${RECEIPTS}> {
        <${receipt}> a rv:OperationReceipt ; rv:requestDigest ${JSON.stringify(admission.requestDigest)} ;
          rv:admissionId ${JSON.stringify(admission.id)} ;
          rv:authorityEpoch ${JSON.stringify(admission.authorityEpoch)} ;
          rv:admittedScope ${JSON.stringify(admission.scope)} ;
          rv:outcome rv:Cancelled ; rv:datasetId <${DATASET}> ;
          rv:dataEpoch ${JSON.stringify(env.lineage.dataEpoch)} ; rv:sequence ?next .
      }
      GRAPH <${OUTBOX}> {
        <${batch}> a rv:OutboxBatch ; rv:dataEpoch ${JSON.stringify(env.lineage.dataEpoch)} ;
          rv:sequence ?next ; rv:eventCount 1 ; rv:event <${event}> .
        <${event}> a rv:AdmissionCancelledEvent ; rv:ordinal 0 ; rv:action "work.create" ;
          rv:receipt <${receipt}> ; rv:admissionId ${JSON.stringify(admission.id)} .
      }
    }
    WHERE {
      GRAPH <${CONTROL}> { <${DATASET}> rv:dataEpoch ${JSON.stringify(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${JSON.stringify(env.lineage.routingEpoch)} ; rv:sequence ?n . }
      FILTER NOT EXISTS { GRAPH <${CONTROL}> { <${DATASET}> rv:restoreHold true } }
      FILTER NOT EXISTS { GRAPH <${RECEIPTS}> { <${receipt}> ?p ?o } }
      BIND(?n + 1 AS ?next)
    }`;
  let updateError: unknown;
  try {
    await env.fuseki.update(update);
  } catch (error) {
    updateError = error;
  }
  const committed = await readWorkTerminalReceipt(env.fuseki, admission.id);
  if (!committed) throw new PendingWorkSeal(updateError
    ? 'graph update outcome unknown; no terminal receipt visible'
    : 'cancellation guard did not match; no terminal receipt visible');
  if (!terminalMatches(committed, admission)) throw new WorkSealConflict('graph receipt differs from Access admission');
  return committed;
}
