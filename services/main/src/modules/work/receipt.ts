import { createHash } from 'node:crypto';
import { FusekiClient } from '../../infrastructure/fuseki.ts';

const RV = 'https://rezics.com/vocab/';
const RECEIPTS = 'urn:rezics:graph:receipts';

export interface WorkTerminalReceipt {
  outcome: 'succeeded' | 'cancelled';
  receipt: string;
  admissionId: string;
  requestDigest: string;
  authorityEpoch: string;
  scope: string;
  dataEpoch: string;
  sequence: string;
  work?: string;
  mainVersion?: string;
  workRevision?: string;
  mainRevision?: string;
}

export function workReceiptIri(admissionId: string): string {
  const digest = createHash('sha256').update(`${admissionId}\0create-metadata-work`).digest('hex');
  return `urn:rezics:receipt:${digest}`;
}

export async function readWorkTerminalReceipt(
  fuseki: FusekiClient, admissionId: string,
): Promise<WorkTerminalReceipt | null> {
  const receipt = workReceiptIri(admissionId);
  const result = await fuseki.query(`PREFIX rv: <${RV}>
    SELECT ?outcome ?digest ?admissionId ?authorityEpoch ?scope ?work ?main ?workRevision ?mainRevision ?sequence ?epoch WHERE {
      GRAPH <${RECEIPTS}> {
        <${receipt}> rv:outcome ?outcome ; rv:requestDigest ?digest ;
          rv:admissionId ?admissionId ; rv:authorityEpoch ?authorityEpoch ;
          rv:admittedScope ?scope ; rv:sequence ?sequence ; rv:dataEpoch ?epoch .
        OPTIONAL { <${receipt}> rv:work ?work ; rv:mainVersion ?main ;
          rv:workRevision ?workRevision ; rv:mainRevision ?mainRevision }
      }
    }`);
  const rows = result.results?.bindings ?? [];
  if (rows.length === 0) return null;
  if (rows.length !== 1) throw new Error('Work receipt cardinality violation');
  const row = rows[0]!;
  if (!row.outcome || !row.digest || !row.admissionId || !row.authorityEpoch
    || !row.scope || !row.sequence || !row.epoch) throw new Error('incomplete Work receipt');
  const outcomeIri = row.outcome.value;
  if (outcomeIri !== `${RV}Succeeded` && outcomeIri !== `${RV}Cancelled`) {
    throw new Error('unknown Work receipt outcome');
  }
  const outcome = outcomeIri === `${RV}Succeeded` ? 'succeeded' : 'cancelled';
  if (outcome === 'succeeded' && (!row.work || !row.main || !row.workRevision || !row.mainRevision)) {
    throw new Error('successful Work receipt has no result');
  }
  if (outcome === 'cancelled' && (row.work || row.main || row.workRevision || row.mainRevision)) {
    throw new Error('cancelled Work receipt has a result');
  }
  return { outcome, receipt, admissionId: row.admissionId.value,
    requestDigest: row.digest.value, authorityEpoch: row.authorityEpoch.value,
    scope: row.scope.value, dataEpoch: row.epoch.value, sequence: row.sequence.value,
    ...(row.work ? { work: row.work.value } : {}),
    ...(row.main ? { mainVersion: row.main.value } : {}),
    ...(row.workRevision ? { workRevision: row.workRevision.value } : {}),
    ...(row.mainRevision ? { mainRevision: row.mainRevision.value } : {}) };
}
