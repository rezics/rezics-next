import type { GraphTerminalProof, RegisteredAdmission } from '../access/admission.ts';
import type { CommandValidation } from '../../infrastructure/fuseki.ts';
import { receiptFamilyFor } from '../access/receipt-families.ts';
import { DATASET, GRAPHS, RV, hash, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import { realmSelectionSlotIri } from '../work/select-realm.ts';
import { SUBMISSION_COST, SubmissionMissing, SubmissionUnavailable, type SubmissionInput } from './schema.ts';

/** Submission eligibility is public publication, not Main Version selection. A
 * newer private draft does not supersede the public revision offered for adoption. */
export async function requireCandidate(env: WorkActivationEnvironment, realm: string, input: SubmissionInput) {
  const correction = input.correctionOf ? `
    ${iri(realmSelectionSlotIri(realm, input.mainVersion))} rv:selectionHead ${iri(input.correctionOf)} .` : '';
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?draft WHERE {
    GRAPH ${iri(GRAPHS.current)} {
      ?space a rv:Space ; rv:realmCapability ${iri(realm)} .
      ${iri(realm)} a rv:Realm ; rv:realmState rv:Active ; rv:space ?space .
      ${iri(input.work)} rv:mainVersion ${iri(input.mainVersion)} .
      ${iri(input.contribution)} a rv:TextContribution ; rv:work ${iri(input.work)} ;
        rv:author ${iri(input.actingSubject)} ; rv:publicationHead ${iri(input.publicationDecision)} .
      ${correction}
    }
    GRAPH ${iri(GRAPHS.revisions)} {
      ${iri(input.publicationDecision)} a rv:PublicationDecision ; rv:component ${iri(input.contribution)} ;
        rv:work ${iri(input.work)} ; rv:selectedDraft ?draft ; rv:disclosure rv:Public ;
        rv:rightsBasis rv:OriginalContribution .
      FILTER(?draft = ${iri(input.selectedDraft)})
      ${input.correctionOf ? `${iri(input.correctionOf)} a rv:PublicationSelection ; rv:context ${iri(realm)} .` : ''}
    }
  } LIMIT ${SUBMISSION_COST.candidateRows}`, SUBMISSION_COST.candidateBytes)).results?.bindings;
  if (!rows) throw new SubmissionUnavailable('Candidate owner is unavailable');
  if (rows.length !== 1) throw new SubmissionMissing('Exact public candidate is unavailable');
}

function receiptIri(admission: RegisteredAdmission) {
  const family = receiptFamilyFor(admission.action);
  if (!family) throw new SubmissionUnavailable('Submission receipt family is unavailable');
  return `urn:rezics:receipt:${hash(`${admission.id}\0${family}`)}`;
}

export async function readSubmissionReceipt(env: WorkActivationEnvironment,
  admission: RegisteredAdmission): Promise<GraphTerminalProof | null> {
  const receipt = receiptIri(admission);
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT
    ?outcome ?digest ?id ?epoch ?scope ?dataEpoch ?sequence WHERE {
    GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ;
      rv:outcome ?outcome ; rv:requestDigest ?digest ; rv:admissionId ?id ;
      rv:authorityEpoch ?epoch ; rv:admittedScope ?scope ; rv:dataEpoch ?dataEpoch ; rv:sequence ?sequence . }
  } LIMIT 2`, 8192)).results?.bindings;
  if (!rows) throw new SubmissionUnavailable('Submission receipt owner is unavailable');
  if (!rows.length) return null;
  const row = rows[0]!;
  const outcome = row.outcome?.value === `${RV}Succeeded` ? 'succeeded'
    : row.outcome?.value === `${RV}Cancelled` ? 'cancelled' : null;
  if (rows.length !== 1 || !outcome || row.digest?.value !== admission.requestDigest
    || row.id?.value !== admission.id || row.epoch?.value !== admission.authorityEpoch
    || row.scope?.value !== admission.scope || !row.dataEpoch?.value
    || !/^\d+$/.test(row.sequence?.value ?? '')) throw new SubmissionUnavailable('Submission receipt differs');
  return { outcome, receipt, admissionId: admission.id, requestDigest: admission.requestDigest,
    authorityEpoch: admission.authorityEpoch, scope: admission.scope,
    dataEpoch: row.dataEpoch.value, sequence: row.sequence!.value };
}

/** Acknowledge an already committed Access result; no internal note reaches Jena. */
export async function acknowledgeSubmission(env: WorkActivationEnvironment,
  admission: RegisteredAdmission, outcome: 'succeeded' | 'cancelled', mutation?: {
    insert: string; remove: string; where: string; validations: CommandValidation[];
    event?: { kind: string; fields: string };
    receiptFields?: string;
  }) {
  const existing = await readSubmissionReceipt(env, admission);
  if (existing) return existing;
  const receipt = receiptIri(admission);
  try { await env.fuseki.commandWithReceipt({ receipt, digest: admission.requestDigest,
    validations: mutation?.validations ?? [], deadlineMs: 10_000, update: `PREFIX rv: <${RV}>
    DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } ${mutation?.remove ?? ''} }
    INSERT {
      ${mutation?.insert ?? ''}
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ;
        ${mutation?.receiptFields ?? ''}
        rv:requestDigest ${lit(admission.requestDigest)} ; rv:admissionId ${lit(admission.id)} ;
        rv:authorityEpoch ${lit(admission.authorityEpoch)} ; rv:admittedScope ${lit(admission.scope)} ;
        rv:outcome rv:${outcome === 'succeeded' ? 'Succeeded' : 'Cancelled'} ;
          rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }
      GRAPH ${iri(GRAPHS.outbox)} { ${iri(`urn:rezics:outbox:${hash(receipt)}`)} a rv:OutboxBatch ;
        rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next ; rv:eventCount ${mutation?.event ? 1 : 0}
        ${mutation?.event ? `; rv:event ${iri(`urn:rezics:event:${hash(receipt)}`)} .
          ${iri(`urn:rezics:event:${hash(receipt)}`)} a rv:${mutation.event.kind} ; rv:ordinal 0 ;
          rv:action ${lit(admission.action)} ; rv:receipt ${iri(receipt)} ; ${mutation.event.fields}` : ''} . }
    } WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      ${mutation?.where ?? ''}
      BIND(?n + 1 AS ?next)
    }` }); } catch { /* The receipt resolves an ambiguous transport outcome. */ }
  const terminal = await readSubmissionReceipt(env, admission);
  if (!terminal || terminal.outcome !== outcome) throw new SubmissionUnavailable('Submission settlement is pending');
  return terminal;
}
