import type { Pool } from 'pg';
import { DATASET, GRAPHS, PROFILE, RV, hash, iri, lit, type WorkActivationEnvironment } from './activate.ts';
import { readWorkPayloadFromManifest } from './history.ts';
import { readWorkEditTerminalReceipt, workEditReceiptIri } from './edit.ts';
import { relayCoverage, type MainCloudEvent, type RelayCoverage } from '../outbox/relay.ts';

export class RetainedEffectConflict extends Error {}

interface AccessEffectRow {
  action: string;
  state: string;
  scope_id: string;
  request_digest: string;
  authority_epoch: string;
  graph_receipt: string | null;
  graph_outcome: string | null;
  graph_data_epoch: string | null;
  graph_sequence: string | null;
}

function exactCoverage(left: RelayCoverage, right: RelayCoverage): boolean {
  return left.consumer === right.consumer && left.dataEpoch === right.dataEpoch
    && left.sequence === right.sequence && left.eventCount === right.eventCount
    && left.eventDigest === right.eventDigest;
}

/** Reapply one previously committed Work edit while the restored graph remains held.
 * The current Access admission and immutable object bytes must have survived.
 */
export async function reconcileRetainedWorkEdit(
  env: WorkActivationEnvironment, accessPool: Pool, relayPool: Pool,
  coverage: RelayCoverage, sequence: string,
): Promise<{ receipt: string; revision: string; replayed: boolean }> {
  if (!/^[0-9]+$/.test(sequence) || BigInt(sequence) < 1n
    || !/^[0-9]+$/.test(coverage.sequence)
    || BigInt(sequence) > BigInt(coverage.sequence)) {
    throw new RetainedEffectConflict('invalid retained effect position');
  }
  const actualCoverage = await relayCoverage(relayPool, coverage.consumer);
  if (!exactCoverage(actualCoverage, coverage)) {
    throw new RetainedEffectConflict('retained relay coverage changed');
  }
  const entries = await relayPool.query<{ event_id: string; envelope: MainCloudEvent }>(
    `SELECT event_id, envelope FROM relay.delivered_event
     WHERE data_epoch = $1 AND sequence = $2 ORDER BY event_id LIMIT 2`,
    [coverage.dataEpoch, sequence]);
  if (entries.rows.length !== 1) throw new RetainedEffectConflict('one Work edit event is required');
  const { event_id: eventId, envelope } = entries.rows[0]!;
  const data = envelope?.data;
  const receipt = data?.receipt;
  if (envelope.id !== eventId || envelope.specversion !== '1.0'
    || envelope.source !== 'https://rezics.com/services/main'
    || envelope.type !== 'com.rezics.work.edited.v1'
    || data.ordinal !== 0 || data.sourcePosition.datasetId !== 'product'
    || data.sourcePosition.dataEpoch !== coverage.dataEpoch
    || data.sourcePosition.sequence !== sequence
    || receipt.action !== 'work.edit' || receipt.outcome !== 'succeeded'
    || !receipt.operation || !receipt.work || !receipt.workRevision
    || !receipt.expectedHead || !receipt.workManifest || receipt.reason
    || receipt.id !== workEditReceiptIri(receipt.admissionId)
    || eventId !== `urn:rezics:event:${hash(receipt.operation)}`
    || data.batchId !== `urn:rezics:outbox:${hash(receipt.id)}`) {
    throw new RetainedEffectConflict('retained Work edit envelope is incomplete');
  }
  for (const value of [eventId, data.batchId, receipt.id, receipt.operation,
    receipt.work, receipt.workRevision, receipt.expectedHead]) iri(value);
  if (!/^urn:rezics:sha256:[0-9a-f]{64}$/.test(receipt.workManifest)) {
    throw new RetainedEffectConflict('retained Work manifest reference is invalid');
  }
  const payload = readWorkPayloadFromManifest(env.objectDirectory, receipt.workManifest, receipt.work);
  const client = await accessPool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const fence = await client.query<{ open: boolean }>(
      'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE');
    if (fence.rows[0]?.open !== false) throw new RetainedEffectConflict('Access recovery fence is not held');
    const access = await client.query<AccessEffectRow>(
      `SELECT action, state, scope_id, request_digest, authority_epoch,
         graph_receipt, graph_outcome, graph_data_epoch, graph_sequence
       FROM access.admission WHERE id = $1`, [receipt.admissionId]);
    const admitted = access.rows[0];
    if (!admitted || admitted.action !== 'work.edit' || admitted.state !== 'sealed'
      || admitted.scope_id !== receipt.scope || admitted.request_digest !== receipt.requestDigest
      || admitted.authority_epoch !== receipt.authorityEpoch
      || admitted.graph_receipt !== receipt.id || admitted.graph_outcome !== 'succeeded'
      || admitted.graph_data_epoch !== coverage.dataEpoch || admitted.graph_sequence !== sequence) {
      throw new RetainedEffectConflict('current Access admission does not prove retained edit');
    }
    const marker = `urn:rezics:restore:${env.lineage.dataEpoch}`;
    const update = `PREFIX rv: <${RV}> PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
      DELETE {
        GRAPH ${iri(GRAPHS.control)} { ${iri(marker)} rv:reconciledPriorSequence ?last }
        GRAPH ${iri(GRAPHS.current)} { ${iri(receipt.work)} rv:head ${iri(receipt.expectedHead)} ;
          rdfs:label ?oldTitle . }
      }
      INSERT {
        GRAPH ${iri(GRAPHS.control)} { ${iri(marker)} rv:reconciledPriorSequence ${sequence} }
        GRAPH ${iri(GRAPHS.current)} { ${iri(receipt.work)} rv:head ${iri(receipt.workRevision)} ;
          rdfs:label ${lit(payload.title)}@en . }
        GRAPH ${iri(GRAPHS.revisions)} {
          ${iri(receipt.workRevision)} a rv:RevisionAnchor ; rv:component ${iri(receipt.work)} ;
            rv:predecessor ${iri(receipt.expectedHead)} ; rv:operation ${iri(receipt.operation)} ;
            rv:manifest ${iri(receipt.workManifest)} ; rv:modelRevision ${iri(PROFILE)} ;
            rv:shapeRevision ${iri(PROFILE)} ; rv:datasetId ${iri(DATASET)} ;
            rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} .
        }
        GRAPH ${iri(GRAPHS.receipts)} {
          ${iri(receipt.id)} a rv:OperationReceipt ; rv:operation ${iri(receipt.operation)} ;
            rv:requestDigest ${lit(receipt.requestDigest)} ; rv:admissionId ${lit(receipt.admissionId)} ;
            rv:authorityEpoch ${lit(receipt.authorityEpoch)} ; rv:admittedScope ${lit(receipt.scope)} ;
            rv:outcome rv:Succeeded ; rv:work ${iri(receipt.work)} ;
            rv:workRevision ${iri(receipt.workRevision)} ; rv:expectedHead ${iri(receipt.expectedHead)} ;
            rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(coverage.dataEpoch)} ;
            rv:sequence ${sequence} .
        }
        GRAPH ${iri(GRAPHS.outbox)} {
          ${iri(data.batchId)} a rv:OutboxBatch ; rv:dataEpoch ${lit(coverage.dataEpoch)} ;
            rv:sequence ${sequence} ; rv:eventCount 1 ; rv:event ${iri(eventId)} .
          ${iri(eventId)} a rv:WorkEditedEvent ; rv:ordinal 0 ; rv:action "work.edit" ;
            rv:receipt ${iri(receipt.id)} ; rv:operation ${iri(receipt.operation)} ;
            rv:work ${iri(receipt.work)} .
        }
      }
      WHERE {
        GRAPH ${iri(GRAPHS.control)} {
          ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
            rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence 0 ;
            rv:restoreCutover ${iri(marker)} ; rv:restoreHold true .
          ${iri(marker)} rv:priorDataEpoch ${lit(coverage.dataEpoch)} ;
            rv:priorSequence ?saved .
          OPTIONAL { ${iri(marker)} rv:reconciledPriorSequence ?last }
          BIND(COALESCE(?last, ?saved) AS ?previous)
          FILTER(?previous + 1 = ${sequence})
        }
        GRAPH ${iri(GRAPHS.current)} {
          ${iri(receipt.work)} rv:head ${iri(receipt.expectedHead)} ;
            rv:mainVersion ${iri(payload.mainVersion)} ; rdfs:label ?oldTitle .
        }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt.id)} ?p ?o } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(receipt.workRevision)} ?p ?o } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.outbox)} {
          ?otherBatch rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} . } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.outbox)} { ${iri(eventId)} ?p ?o } }
      }`;
    const existing = await readWorkEditTerminalReceipt(env, receipt.admissionId);
    let updateError: unknown;
    if (!existing) {
      try { await env.fuseki.update(update); }
      catch (error) { updateError = error; }
    }
    const terminal = await readWorkEditTerminalReceipt(env, receipt.admissionId);
    const markerCheck = await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
      GRAPH ${iri(GRAPHS.control)} { ${iri(marker)} rv:reconciledPriorSequence ${sequence} .
        ${iri(DATASET)} rv:restoreHold true . }
    }`);
    const graphCheck = await env.fuseki.query(`PREFIX rv: <${RV}>
      PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#> ASK {
      GRAPH ${iri(GRAPHS.current)} { ${iri(receipt.work)} rv:head ${iri(receipt.workRevision)} ;
        rv:mainVersion ${iri(payload.mainVersion)} ; rdfs:label ${lit(payload.title)}@en . }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(receipt.workRevision)} a rv:RevisionAnchor ;
        rv:component ${iri(receipt.work)} ; rv:predecessor ${iri(receipt.expectedHead)} ;
        rv:operation ${iri(receipt.operation)} ; rv:manifest ${iri(receipt.workManifest)} ;
        rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} . }
      GRAPH ${iri(GRAPHS.outbox)} { ${iri(data.batchId)} a rv:OutboxBatch ;
        rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} ;
        rv:eventCount 1 ; rv:event ${iri(eventId)} .
        ${iri(eventId)} a rv:WorkEditedEvent ; rv:receipt ${iri(receipt.id)} . }
    }`);
    if (!terminal || terminal.outcome !== 'succeeded' || terminal.receipt !== receipt.id
      || terminal.requestDigest !== receipt.requestDigest || terminal.admissionId !== receipt.admissionId
      || terminal.authorityEpoch !== receipt.authorityEpoch || terminal.scope !== receipt.scope
      || terminal.work !== receipt.work || terminal.revision !== receipt.workRevision
      || terminal.predecessor !== receipt.expectedHead || terminal.dataEpoch !== coverage.dataEpoch
      || terminal.sequence !== sequence || markerCheck.boolean !== true
      || graphCheck.boolean !== true) {
      throw new RetainedEffectConflict(updateError
        ? 'retained edit update outcome is unknown' : 'retained edit did not reconcile');
    }
    await client.query('COMMIT');
    return { receipt: receipt.id, revision: receipt.workRevision, replayed: !!existing };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* retain original error */ }
    throw error;
  } finally {
    client.release();
  }
}
