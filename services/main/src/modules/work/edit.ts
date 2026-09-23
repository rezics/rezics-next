import type { RegisteredAdmission } from '../access/admission.ts';
import { CONTINUITY, DATASET, GRAPHS, ID, PROFILE, RV, hash, iri, lit,
  metadataWorkRequestDigest, prepareComponent, validateCandidate,
  PendingActivation, IdempotencyConflict, type WorkActivationEnvironment } from './activate.ts';

export class StaleWorkHead extends Error {}
export class WorkEditUnavailable extends Error {}

export interface EditMetadataWorkIntent {
  admission: Pick<RegisteredAdmission, 'id' | 'scope' | 'action' | 'requestDigest' | 'authorityEpoch' | 'expiresAt'>;
  work: string;
  expectedHead: string;
  title: string;
}

export interface WorkEditReceipt {
  work: string;
  revision: string;
  predecessor: string;
  receipt: string;
  admissionId: string;
  dataEpoch: string;
  sequence: string;
  replayed: boolean;
}

export interface TerminalWorkEdit {
  outcome: 'succeeded' | 'cancelled';
  reason?: 'stale-head';
  work?: string;
  revision?: string;
  predecessor?: string;
  receipt: string;
  admissionId: string;
  requestDigest: string;
  authorityEpoch: string;
  scope: string;
  dataEpoch: string;
  sequence: string;
}

export function metadataWorkEditDigest(work: string, expectedHead: string, title: string): string {
  iri(work);
  iri(expectedHead);
  metadataWorkRequestDigest(title);
  return hash(JSON.stringify({ family: 'edit-metadata-work-v1', work, expectedHead, title }));
}

export function workEditReceiptIri(admissionId: string): string {
  return `urn:rezics:receipt:${hash(`${admissionId}\0edit-metadata-work`)}`;
}

export async function readWorkEditTerminalReceipt(env: WorkActivationEnvironment, admissionId: string): Promise<TerminalWorkEdit | null> {
  const receipt = workEditReceiptIri(admissionId);
  const result = await env.fuseki.query(`PREFIX rv: <${RV}>
    SELECT ?outcome ?reason ?digest ?admissionId ?authorityEpoch ?scope ?work ?revision ?predecessor ?sequence ?epoch WHERE {
      GRAPH <${GRAPHS.receipts}> {
        <${receipt}> rv:outcome ?outcome ; rv:requestDigest ?digest ; rv:admissionId ?admissionId ;
          rv:authorityEpoch ?authorityEpoch ; rv:admittedScope ?scope ; rv:sequence ?sequence ; rv:dataEpoch ?epoch .
        OPTIONAL { <${receipt}> rv:reason ?reason }
        OPTIONAL { <${receipt}> rv:work ?work ; rv:workRevision ?revision ; rv:expectedHead ?predecessor }
      }
    }`);
  const rows = result.results?.bindings ?? [];
  if (rows.length === 0) return null;
  if (rows.length !== 1) throw new Error('Work edit receipt cardinality violation');
  const row = rows[0]!;
  if (!row.digest || !row.admissionId || !row.authorityEpoch || !row.scope || !row.sequence || !row.epoch) {
    throw new Error('incomplete Work edit receipt');
  }
  const outcome = row.outcome?.value === `${RV}Succeeded` ? 'succeeded'
    : row.outcome?.value === `${RV}Cancelled` ? 'cancelled' : null;
  if (!outcome) throw new Error('unknown Work edit outcome');
  const reason = row.reason?.value === `${RV}StaleHead` ? 'stale-head' : undefined;
  if (outcome === 'succeeded' && (!row.work || !row.revision || !row.predecessor)) {
    throw new Error('successful Work edit has no result');
  }
  if (outcome === 'cancelled' && (row.work || row.revision || row.predecessor)) {
    throw new Error('cancelled Work edit has a result');
  }
  return { outcome, ...(reason ? { reason } : {}),
    ...(row.work ? { work: row.work.value, revision: row.revision!.value,
      predecessor: row.predecessor!.value } : {}),
    receipt, admissionId: row.admissionId.value, requestDigest: row.digest.value,
    authorityEpoch: row.authorityEpoch.value, scope: row.scope.value,
    dataEpoch: row.epoch.value, sequence: row.sequence.value };
}

function checkedTerminal(terminal: TerminalWorkEdit, intent: EditMetadataWorkIntent, digest: string): WorkEditReceipt {
  if (terminal.admissionId !== intent.admission.id || terminal.requestDigest !== digest
    || terminal.authorityEpoch !== intent.admission.authorityEpoch || terminal.scope !== intent.admission.scope) {
    throw new IdempotencyConflict('Work edit receipt does not match admission');
  }
  if (terminal.outcome === 'cancelled') {
    if (terminal.reason === 'stale-head') throw new StaleWorkHead('expected Work head is stale');
    throw new WorkEditUnavailable('Work edit was cancelled');
  }
  if (terminal.work !== intent.work || terminal.predecessor !== intent.expectedHead) {
    throw new IdempotencyConflict('Work edit receipt targets another intent');
  }
  return { work: terminal.work, revision: terminal.revision!, predecessor: terminal.predecessor,
    receipt: terminal.receipt, admissionId: terminal.admissionId,
    dataEpoch: terminal.dataEpoch, sequence: terminal.sequence, replayed: true };
}

async function sealStaleHead(env: WorkActivationEnvironment, intent: EditMetadataWorkIntent, digest: string): Promise<TerminalWorkEdit | null> {
  const receipt = workEditReceiptIri(intent.admission.id);
  const batch = `urn:rezics:outbox:${hash(`${receipt}\0stale`)}`;
  const event = `urn:rezics:event:${hash(`${receipt}\0stale`)}`;
  const update = `PREFIX rv: <${RV}>
    DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }
    INSERT {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.receipts)} {
        ${iri(receipt)} a rv:OperationReceipt ; rv:requestDigest ${lit(digest)} ;
          rv:admissionId ${lit(intent.admission.id)} ; rv:authorityEpoch ${lit(intent.admission.authorityEpoch)} ;
          rv:admittedScope ${lit(intent.admission.scope)} ; rv:outcome rv:Cancelled ; rv:reason rv:StaleHead ;
          rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next .
      }
      GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch)} a rv:OutboxBatch ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:sequence ?next ; rv:eventCount 1 ; rv:event ${iri(event)} . ${iri(event)} a rv:WorkEditRejectedEvent . }
    }
    WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
      GRAPH ${iri(GRAPHS.current)} { ${iri(intent.work)} rv:head ?currentHead . }
      FILTER(?currentHead != ${iri(intent.expectedHead)})
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} {
        ${iri(intent.work)} rv:head ${iri(intent.expectedHead)} . } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      BIND(?n + 1 AS ?next)
    }`;
  try { await env.fuseki.update(update); } catch { /* resolve the same receipt after an ambiguous response */ }
  return readWorkEditTerminalReceipt(env, intent.admission.id);
}

/** Strong closure races this terminal cancellation against the original edit. */
export async function sealMetadataWorkEditAdmission(
  env: WorkActivationEnvironment, admission: RegisteredAdmission,
): Promise<TerminalWorkEdit> {
  if (admission.action !== 'work.edit') throw new Error('unsupported edit admission');
  const existing = await readWorkEditTerminalReceipt(env, admission.id);
  if (existing) {
    if (existing.admissionId !== admission.id || existing.requestDigest !== admission.requestDigest
      || existing.scope !== admission.scope || existing.authorityEpoch !== admission.authorityEpoch) {
      throw new IdempotencyConflict('edit receipt differs from Access admission');
    }
    return existing;
  }
  const receipt = workEditReceiptIri(admission.id);
  const eventHash = hash(`${receipt}\0cancel`);
  const batch = `urn:rezics:outbox:${eventHash}`;
  const event = `urn:rezics:event:${eventHash}`;
  const update = `PREFIX rv: <${RV}>
    DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }
    INSERT {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ;
        rv:requestDigest ${lit(admission.requestDigest)} ; rv:admissionId ${lit(admission.id)} ;
        rv:authorityEpoch ${lit(admission.authorityEpoch)} ; rv:admittedScope ${lit(admission.scope)} ;
        rv:outcome rv:Cancelled ; rv:datasetId ${iri(DATASET)} ;
        rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }
      GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch)} a rv:OutboxBatch ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:sequence ?next ; rv:eventCount 1 ; rv:event ${iri(event)} .
        ${iri(event)} a rv:AdmissionCancelledEvent ; rv:admissionId ${lit(admission.id)} . }
    }
    WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      BIND(?n + 1 AS ?next)
    }`;
  try { await env.fuseki.update(update); } catch { /* resolve the same receipt after a lost response */ }
  const terminal = await readWorkEditTerminalReceipt(env, admission.id);
  if (!terminal) throw new PendingActivation('Work edit cancellation outcome is unknown');
  if (terminal.admissionId !== admission.id || terminal.requestDigest !== admission.requestDigest
    || terminal.scope !== admission.scope || terminal.authorityEpoch !== admission.authorityEpoch) {
    throw new IdempotencyConflict('edit receipt differs from Access admission');
  }
  return terminal;
}

/** Internal guarded Work title edit; Access binding is the next boundary. */
export async function editMetadataWork(env: WorkActivationEnvironment, intent: EditMetadataWorkIntent): Promise<WorkEditReceipt> {
  if (intent.admission.action !== 'work.edit' || !/^[0-9a-f-]{36}$/.test(intent.admission.id)
    || !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(intent.work)
    || !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(intent.expectedHead)
    || !/^[0-9]+$/.test(intent.admission.authorityEpoch)) throw new Error('invalid Work edit admission');
  const digest = metadataWorkEditDigest(intent.work, intent.expectedHead, intent.title);
  if (digest !== intent.admission.requestDigest) throw new IdempotencyConflict('Work edit digest differs');
  const existing = await readWorkEditTerminalReceipt(env, intent.admission.id);
  if (existing) return checkedTerminal(existing, intent, digest);
  if (Date.parse(intent.admission.expiresAt) <= Date.now()) throw new PendingActivation('Work edit admission expired');
  const current = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?main ?head WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(intent.work)} rv:mainVersion ?main ; rv:head ?head . }
  }`);
  const rows = current.results?.bindings ?? [];
  if (rows.length !== 1 || !rows[0]?.main || !rows[0]?.head) throw new WorkEditUnavailable('Work is unavailable');
  if (rows[0].head.value !== intent.expectedHead) {
    const stale = await sealStaleHead(env, intent, digest);
    if (stale) return checkedTerminal(stale, intent, digest);
    throw new PendingActivation('stale Work edit outcome not sealed');
  }
  const main = rows[0].main.value;
  await validateCandidate(env, intent.work, main, intent.title);
  const manifest = prepareComponent(env.objectDirectory, intent.work, {
    mainVersion: main, continuityProfile: CONTINUITY, title: intent.title, language: 'en',
  });
  if (Date.parse(intent.admission.expiresAt) <= Date.now()) throw new PendingActivation('Work edit admission expired before update');
  const revision = ID + Bun.randomUUIDv7();
  const operation = ID + Bun.randomUUIDv7();
  const receipt = workEditReceiptIri(intent.admission.id);
  const batch = `urn:rezics:outbox:${hash(receipt)}`;
  const event = `urn:rezics:event:${hash(operation)}`;
  const update = `PREFIX rv: <${RV}> PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
    DELETE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n }
      GRAPH ${iri(GRAPHS.current)} { ${iri(intent.work)} rv:head ${iri(intent.expectedHead)} ; rdfs:label ?oldTitle . }
    }
    INSERT {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.current)} { ${iri(intent.work)} rv:head ${iri(revision)} ; rdfs:label ${lit(intent.title)}@en . }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} a rv:RevisionAnchor ; rv:component ${iri(intent.work)} ;
        rv:predecessor ${iri(intent.expectedHead)} ; rv:operation ${iri(operation)} ;
        rv:manifest ${iri(`urn:rezics:sha256:${manifest}`)} ; rv:modelRevision ${iri(PROFILE)} ;
        rv:shapeRevision ${iri(PROFILE)} ; rv:datasetId ${iri(DATASET)} ;
        rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ; rv:operation ${iri(operation)} ;
        rv:requestDigest ${lit(digest)} ; rv:admissionId ${lit(intent.admission.id)} ;
        rv:authorityEpoch ${lit(intent.admission.authorityEpoch)} ; rv:admittedScope ${lit(intent.admission.scope)} ;
        rv:outcome rv:Succeeded ; rv:work ${iri(intent.work)} ; rv:workRevision ${iri(revision)} ;
        rv:expectedHead ${iri(intent.expectedHead)} ; rv:datasetId ${iri(DATASET)} ;
        rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }
      GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch)} a rv:OutboxBatch ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:sequence ?next ; rv:eventCount 1 ; rv:event ${iri(event)} .
        ${iri(event)} rv:operation ${iri(operation)} ; rv:work ${iri(intent.work)} . }
    }
    WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n ;
        rv:modelHead ${iri(PROFILE)} ; rv:shapeHead ${iri(PROFILE)} . }
      GRAPH ${iri(GRAPHS.current)} { ${iri(intent.work)} rv:head ${iri(intent.expectedHead)} ;
        rv:mainVersion ${iri(main)} ; rdfs:label ?oldTitle . }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      BIND(?n + 1 AS ?next)
    }`;
  try { await env.fuseki.update(update); } catch { /* resolve by receipt after a lost response */ }
  const committed = await readWorkEditTerminalReceipt(env, intent.admission.id);
  if (committed) {
    const result = checkedTerminal(committed, intent, digest);
    return { ...result, replayed: committed.revision !== revision };
  }
  const stale = await sealStaleHead(env, intent, digest);
  if (stale) return checkedTerminal(stale, intent, digest);
  throw new PendingActivation('Work edit guard did not match');
}
