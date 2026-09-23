import type { Pool } from 'pg';
import { CONTINUITY, DATASET, GRAPHS, PROFILE, RV, hash, iri, lit,
  type WorkActivationEnvironment } from './activate.ts';
import { readComponentState, readMainPayloadFromManifest, readWorkPayloadFromManifest } from './history.ts';
import { readWorkEditTerminalReceipt, workEditReceiptIri } from './edit.ts';
import { readWorkTerminalReceipt, workReceiptIri } from './receipt.ts';
import { relayCoverage, type MainCloudEvent, type RelayCoverage } from '../outbox/relay.ts';
import { CONTRIBUTION_PROFILE, readTextContributionReceipt,
  textContributionDigest, textContributionReceiptIri } from '../contribution/draft.ts';
import { readTextContributionEditReceipt, textContributionEditDigest,
  textContributionEditReceiptIri } from '../contribution/edit.ts';

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
    && left.sequence === right.sequence && left.batchCount === right.batchCount
    && left.batchDigest === right.batchDigest && left.eventCount === right.eventCount
    && left.eventDigest === right.eventDigest;
}

async function loadRetainedEvent(
  relayPool: Pool, coverage: RelayCoverage, sequence: string,
): Promise<{ eventId: string; envelope: MainCloudEvent }> {
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
  if (entries.rows.length !== 1) throw new RetainedEffectConflict('one Work event is required');
  return { eventId: entries.rows[0]!.event_id, envelope: entries.rows[0]!.envelope };
}

async function reconciledCursor(env: WorkActivationEnvironment, marker: string): Promise<bigint | null> {
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?cursor WHERE {
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true .
      ${iri(marker)} rv:reconciledPriorSequence ?cursor . }
  }`);
  const rows = result.results?.bindings ?? [];
  if (rows.length !== 1 || !/^[0-9]+$/.test(rows[0]?.cursor?.value ?? '')) return null;
  return BigInt(rows[0]!.cursor!.value);
}

/** Rebuild a retained maintenance position with no event or Access admission. */
export async function reconcileRetainedEmptyBatch(
  env: WorkActivationEnvironment, accessPool: Pool, relayPool: Pool,
  coverage: RelayCoverage, sequence: string,
): Promise<{ batchId: string; replayed: boolean }> {
  if (!/^[0-9]+$/.test(sequence) || BigInt(sequence) < 1n
    || BigInt(sequence) > BigInt(coverage.sequence)) {
    throw new RetainedEffectConflict('invalid retained batch position');
  }
  const actualCoverage = await relayCoverage(relayPool, coverage.consumer);
  if (!exactCoverage(actualCoverage, coverage)) {
    throw new RetainedEffectConflict('retained relay coverage changed');
  }
  const retained = await relayPool.query<{ batch_id: string; routing_epoch: string; event_count: number }>(
    `SELECT batch_id, routing_epoch, event_count FROM relay.delivered_batch
     WHERE data_epoch = $1 AND sequence = $2`, [coverage.dataEpoch, sequence]);
  const batch = retained.rows[0];
  if (retained.rows.length !== 1 || !batch || batch.event_count !== 0 || !batch.routing_epoch) {
    throw new RetainedEffectConflict('retained zero-event header is unavailable');
  }
  iri(batch.batch_id);
  const client = await accessPool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const fence = await client.query<{ open: boolean }>(
      'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE');
    if (fence.rows[0]?.open !== false) throw new RetainedEffectConflict('Access recovery fence is not held');
    const marker = `urn:rezics:restore:${env.lineage.dataEpoch}`;
    const readBatch = async () => {
      const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?batch ?count ?event WHERE {
        GRAPH ${iri(GRAPHS.outbox)} {
          ?batch a rv:OutboxBatch ; rv:dataEpoch ${lit(coverage.dataEpoch)} ;
            rv:sequence ${sequence} ; rv:eventCount ?count .
          OPTIONAL { ?batch rv:event ?event }
        }
      }`);
      return result.results?.bindings ?? [];
    };
    const existing = await readBatch();
    let updateError: unknown;
    if (existing.length === 0) {
      try { await env.fuseki.update(`PREFIX rv: <${RV}>
        DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(marker)} rv:reconciledPriorSequence ?last } }
        INSERT {
          GRAPH ${iri(GRAPHS.control)} { ${iri(marker)} rv:reconciledPriorSequence ${sequence} }
          GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch.batch_id)} a rv:OutboxBatch ;
            rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} ; rv:eventCount 0 . }
        }
        WHERE {
          GRAPH ${iri(GRAPHS.control)} {
            ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
              rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence 0 ;
              rv:restoreCutover ${iri(marker)} ; rv:restoreHold true .
            ${iri(marker)} rv:priorDataEpoch ${lit(coverage.dataEpoch)} ; rv:priorSequence ?saved .
            OPTIONAL { ${iri(marker)} rv:reconciledPriorSequence ?last }
            BIND(COALESCE(?last, ?saved) AS ?previous)
            FILTER(?previous + 1 = ${sequence})
          }
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.outbox)} {
            ?otherBatch rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} . } }
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch.batch_id)} ?p ?o } }
        }`); }
      catch (error) { updateError = error; }
    }
    const final = await readBatch();
    const cursor = await reconciledCursor(env, marker);
    if (final.length !== 1 || final[0]?.batch?.value !== batch.batch_id
      || final[0]?.count?.value !== '0' || final[0]?.event
      || cursor === null || cursor < BigInt(sequence)) {
      throw new RetainedEffectConflict(updateError
        ? 'retained batch update outcome is unknown' : 'retained zero-event batch did not reconcile');
    }
    await client.query('COMMIT');
    return { batchId: batch.batch_id, replayed: existing.length === 1 };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* retain original error */ }
    throw error;
  } finally {
    client.release();
  }
}

/** Reapply one previously committed Work edit while the restored graph remains held.
 * The current Access admission and immutable object bytes must have survived.
 */
export async function reconcileRetainedWorkEdit(
  env: WorkActivationEnvironment, accessPool: Pool, relayPool: Pool,
  coverage: RelayCoverage, sequence: string,
): Promise<{ receipt: string; revision: string; replayed: boolean }> {
  const { eventId, envelope } = await loadRetainedEvent(relayPool, coverage, sequence);
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
    const cursor = await reconciledCursor(env, marker);
    const graphCheck = await env.fuseki.query(`PREFIX rv: <${RV}>
      ASK {
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(receipt.workRevision)} a rv:RevisionAnchor ;
        rv:component ${iri(receipt.work)} ; rv:predecessor ${iri(receipt.expectedHead)} ;
        rv:operation ${iri(receipt.operation)} ; rv:manifest ${iri(receipt.workManifest)} ;
        rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} . }
      GRAPH ${iri(GRAPHS.outbox)} { ${iri(data.batchId)} a rv:OutboxBatch ;
        rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} ;
        rv:eventCount 1 ; rv:event ${iri(eventId)} .
        ${iri(eventId)} a rv:WorkEditedEvent ; rv:receipt ${iri(receipt.id)} . }
    }`);
    const currentCheck = cursor === BigInt(sequence)
      ? await env.fuseki.query(`PREFIX rv: <${RV}>
          PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#> ASK {
          GRAPH ${iri(GRAPHS.current)} { ${iri(receipt.work)} rv:head ${iri(receipt.workRevision)} ;
            rv:mainVersion ${iri(payload.mainVersion)} ; rdfs:label ${lit(payload.title)}@en . }
        }`)
      : { boolean: true };
    if (!terminal || terminal.outcome !== 'succeeded' || terminal.receipt !== receipt.id
      || terminal.requestDigest !== receipt.requestDigest || terminal.admissionId !== receipt.admissionId
      || terminal.authorityEpoch !== receipt.authorityEpoch || terminal.scope !== receipt.scope
      || terminal.work !== receipt.work || terminal.revision !== receipt.workRevision
      || terminal.predecessor !== receipt.expectedHead || terminal.dataEpoch !== coverage.dataEpoch
      || terminal.sequence !== sequence || cursor === null || cursor < BigInt(sequence)
      || graphCheck.boolean !== true || currentCheck.boolean !== true) {
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

/** Reapply one committed metadata Work creation with its original public IDs. */
export async function reconcileRetainedWorkCreate(
  env: WorkActivationEnvironment, accessPool: Pool, relayPool: Pool,
  coverage: RelayCoverage, sequence: string,
): Promise<{ receipt: string; work: string; workRevision: string; replayed: boolean }> {
  const { eventId, envelope } = await loadRetainedEvent(relayPool, coverage, sequence);
  const data = envelope?.data;
  const receipt = data?.receipt;
  if (envelope.id !== eventId || envelope.specversion !== '1.0'
    || envelope.source !== 'https://rezics.com/services/main'
    || envelope.type !== 'com.rezics.work.created.v1'
    || data.ordinal !== 0 || data.sourcePosition.datasetId !== 'product'
    || data.sourcePosition.dataEpoch !== coverage.dataEpoch
    || data.sourcePosition.sequence !== sequence
    || receipt.action !== 'work.create' || receipt.outcome !== 'succeeded'
    || receipt.scope !== 'work:create:root' || !receipt.operation || !receipt.work
    || !receipt.mainVersion || !receipt.workRevision || !receipt.mainRevision
    || !receipt.workManifest || !receipt.mainManifest || receipt.expectedHead || receipt.reason
    || receipt.id !== workReceiptIri(receipt.admissionId)
    || eventId !== `urn:rezics:event:${hash(receipt.operation)}`
    || data.batchId !== `urn:rezics:outbox:${hash(receipt.id)}`) {
    throw new RetainedEffectConflict('retained Work create envelope is incomplete');
  }
  for (const value of [eventId, data.batchId, receipt.id, receipt.operation, receipt.work,
    receipt.mainVersion, receipt.workRevision, receipt.mainRevision]) iri(value);
  if (!/^urn:rezics:sha256:[0-9a-f]{64}$/.test(receipt.workManifest)
    || !/^urn:rezics:sha256:[0-9a-f]{64}$/.test(receipt.mainManifest)) {
    throw new RetainedEffectConflict('retained Work create manifest reference is invalid');
  }
  const payload = readWorkPayloadFromManifest(env.objectDirectory, receipt.workManifest, receipt.work);
  readMainPayloadFromManifest(env.objectDirectory, receipt.mainManifest,
    receipt.mainVersion, receipt.work);
  if (payload.mainVersion !== receipt.mainVersion) {
    throw new RetainedEffectConflict('retained Work and MainVersion payloads differ');
  }
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
    if (!admitted || admitted.action !== 'work.create' || admitted.state !== 'sealed'
      || admitted.scope_id !== receipt.scope || admitted.request_digest !== receipt.requestDigest
      || admitted.authority_epoch !== receipt.authorityEpoch
      || admitted.graph_receipt !== receipt.id || admitted.graph_outcome !== 'succeeded'
      || admitted.graph_data_epoch !== coverage.dataEpoch || admitted.graph_sequence !== sequence) {
      throw new RetainedEffectConflict('current Access admission does not prove retained create');
    }
    const marker = `urn:rezics:restore:${env.lineage.dataEpoch}`;
    const update = `PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
      PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
      DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(marker)} rv:reconciledPriorSequence ?last } }
      INSERT {
        GRAPH ${iri(GRAPHS.control)} { ${iri(marker)} rv:reconciledPriorSequence ${sequence} }
        GRAPH ${iri(GRAPHS.current)} {
          ${iri(receipt.work)} a schema:CreativeWork ; rv:mainVersion ${iri(receipt.mainVersion)} ;
            rv:continuityProfile ${iri(CONTINUITY)} ; rdfs:label ${lit(payload.title)}@en ;
            rv:head ${iri(receipt.workRevision)} .
          ${iri(receipt.mainVersion)} a rv:MainVersion ; rv:work ${iri(receipt.work)} ;
            rv:hostingPolicy rv:MetadataOnly ; rv:head ${iri(receipt.mainRevision)} .
        }
        GRAPH ${iri(GRAPHS.revisions)} {
          ${iri(receipt.workRevision)} a rv:RevisionAnchor ; rv:component ${iri(receipt.work)} ;
            rv:operation ${iri(receipt.operation)} ; rv:manifest ${iri(receipt.workManifest)} ;
            rv:modelRevision ${iri(PROFILE)} ; rv:shapeRevision ${iri(PROFILE)} ;
            rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(coverage.dataEpoch)} ;
            rv:sequence ${sequence} .
          ${iri(receipt.mainRevision)} a rv:RevisionAnchor ; rv:component ${iri(receipt.mainVersion)} ;
            rv:operation ${iri(receipt.operation)} ; rv:manifest ${iri(receipt.mainManifest)} ;
            rv:modelRevision ${iri(PROFILE)} ; rv:shapeRevision ${iri(PROFILE)} ;
            rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(coverage.dataEpoch)} ;
            rv:sequence ${sequence} .
        }
        GRAPH ${iri(GRAPHS.receipts)} {
          ${iri(receipt.id)} a rv:OperationReceipt ; rv:operation ${iri(receipt.operation)} ;
            rv:requestDigest ${lit(receipt.requestDigest)} ; rv:admissionId ${lit(receipt.admissionId)} ;
            rv:authorityEpoch ${lit(receipt.authorityEpoch)} ; rv:admittedScope ${lit(receipt.scope)} ;
            rv:outcome rv:Succeeded ; rv:work ${iri(receipt.work)} ;
            rv:mainVersion ${iri(receipt.mainVersion)} ; rv:workRevision ${iri(receipt.workRevision)} ;
            rv:mainRevision ${iri(receipt.mainRevision)} ; rv:datasetId ${iri(DATASET)} ;
            rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} .
        }
        GRAPH ${iri(GRAPHS.outbox)} {
          ${iri(data.batchId)} a rv:OutboxBatch ; rv:dataEpoch ${lit(coverage.dataEpoch)} ;
            rv:sequence ${sequence} ; rv:eventCount 1 ; rv:event ${iri(eventId)} .
          ${iri(eventId)} a rv:WorkCreatedEvent ; rv:ordinal 0 ; rv:action "work.create" ;
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
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(receipt.work)} ?p ?o } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(receipt.mainVersion)} ?p ?o } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt.id)} ?p ?o } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(receipt.workRevision)} ?p ?o } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(receipt.mainRevision)} ?p ?o } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.outbox)} {
          ?otherBatch rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} . } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.outbox)} { ${iri(eventId)} ?p ?o } }
      }`;
    const existing = await readWorkTerminalReceipt(env.fuseki, receipt.admissionId);
    let updateError: unknown;
    if (!existing) {
      try { await env.fuseki.update(update); }
      catch (error) { updateError = error; }
    }
    const terminal = await readWorkTerminalReceipt(env.fuseki, receipt.admissionId);
    const cursor = await reconciledCursor(env, marker);
    const graphCheck = await env.fuseki.query(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
      ASK {
      GRAPH ${iri(GRAPHS.current)} {
        ${iri(receipt.work)} a schema:CreativeWork ; rv:mainVersion ${iri(receipt.mainVersion)} .
        ${iri(receipt.mainVersion)} a rv:MainVersion ; rv:work ${iri(receipt.work)} . }
      GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(receipt.workRevision)} rv:manifest ${iri(receipt.workManifest)} ;
          rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} .
        ${iri(receipt.mainRevision)} rv:manifest ${iri(receipt.mainManifest)} ;
          rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} . }
      GRAPH ${iri(GRAPHS.outbox)} { ${iri(data.batchId)} a rv:OutboxBatch ;
        rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} ;
        rv:eventCount 1 ; rv:event ${iri(eventId)} .
        ${iri(eventId)} a rv:WorkCreatedEvent ; rv:receipt ${iri(receipt.id)} . }
    }`);
    const currentCheck = cursor === BigInt(sequence)
      ? await env.fuseki.query(`PREFIX rv: <${RV}>
          PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#> ASK {
          GRAPH ${iri(GRAPHS.current)} {
            ${iri(receipt.work)} rdfs:label ${lit(payload.title)}@en ;
              rv:head ${iri(receipt.workRevision)} .
            ${iri(receipt.mainVersion)} rv:head ${iri(receipt.mainRevision)} . }
        }`)
      : { boolean: true };
    if (!terminal || terminal.outcome !== 'succeeded' || terminal.receipt !== receipt.id
      || terminal.requestDigest !== receipt.requestDigest || terminal.admissionId !== receipt.admissionId
      || terminal.authorityEpoch !== receipt.authorityEpoch || terminal.scope !== receipt.scope
      || terminal.work !== receipt.work || terminal.mainVersion !== receipt.mainVersion
      || terminal.workRevision !== receipt.workRevision || terminal.mainRevision !== receipt.mainRevision
      || terminal.dataEpoch !== coverage.dataEpoch || terminal.sequence !== sequence
      || cursor === null || cursor < BigInt(sequence)
      || graphCheck.boolean !== true || currentCheck.boolean !== true) {
      throw new RetainedEffectConflict(updateError
        ? 'retained create update outcome is unknown' : 'retained create did not reconcile');
    }
    await client.query('COMMIT');
    return { receipt: receipt.id, work: receipt.work, workRevision: receipt.workRevision,
      replayed: !!existing };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* retain original error */ }
    throw error;
  } finally {
    client.release();
  }
}

/** Reapply one retained private draft with its original identity and immutable bytes. */
export async function reconcileRetainedContributionDraftCreate(
  env: WorkActivationEnvironment, accessPool: Pool, relayPool: Pool,
  coverage: RelayCoverage, sequence: string,
): Promise<{ receipt: string; contribution: string; draftRevision: string; replayed: boolean }> {
  const { eventId, envelope } = await loadRetainedEvent(relayPool, coverage, sequence);
  const data = envelope?.data;
  const receipt = data?.receipt;
  if (envelope.id !== eventId || envelope.specversion !== '1.0'
    || envelope.source !== 'https://rezics.com/services/main'
    || envelope.type !== 'com.rezics.contribution.draft-created.v1'
    || data.ordinal !== 0 || data.sourcePosition.datasetId !== 'product'
    || data.sourcePosition.dataEpoch !== coverage.dataEpoch
    || data.sourcePosition.sequence !== sequence
    || receipt.action !== 'contribution.create' || receipt.outcome !== 'succeeded'
    || !receipt.operation || !receipt.work || !receipt.contribution
    || !receipt.draftRevision || !receipt.draftManifest || !receipt.author
    || !receipt.language || receipt.scope !== `contribution:create:${receipt.work}`
    || receipt.mainVersion || receipt.workRevision || receipt.mainRevision
    || receipt.expectedHead || receipt.reason
    || receipt.id !== textContributionReceiptIri(receipt.admissionId)
    || eventId !== `urn:rezics:event:${hash(receipt.operation)}`
    || data.batchId !== `urn:rezics:outbox:${hash(receipt.id)}`) {
    throw new RetainedEffectConflict('retained Contribution draft envelope is incomplete');
  }
  const work = receipt.work;
  const contribution = receipt.contribution;
  const draftRevision = receipt.draftRevision;
  const operation = receipt.operation;
  const author = receipt.author;
  const language = receipt.language;
  const draftManifest = receipt.draftManifest;
  for (const value of [eventId, data.batchId, receipt.id, work, contribution,
    draftRevision, operation, author]) iri(value);
  if (!/^urn:rezics:sha256:[0-9a-f]{64}$/.test(draftManifest)) {
    throw new RetainedEffectConflict('retained Contribution manifest reference is invalid');
  }
  const state = readComponentState(env.objectDirectory, draftManifest,
    contribution, CONTRIBUTION_PROFILE);
  if (state.work !== work || state.author !== author || state.language !== language
    || typeof state.body !== 'string' || state.publication !== 'draft'
    || textContributionDigest({ work, actingSubject: author, language,
      body: state.body }) !== receipt.requestDigest) {
    throw new RetainedEffectConflict('retained Contribution payload differs from receipt');
  }
  const client = await accessPool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const fence = await client.query<{ open: boolean }>(
      'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE');
    if (fence.rows[0]?.open !== false) throw new RetainedEffectConflict('Access recovery fence is not held');
    const access = await client.query<AccessEffectRow & { acting_subject: string }>(
      `SELECT action, state, scope_id, request_digest, authority_epoch, acting_subject,
         graph_receipt, graph_outcome, graph_data_epoch, graph_sequence
       FROM access.admission WHERE id = $1`, [receipt.admissionId]);
    const admitted = access.rows[0];
    if (!admitted || admitted.action !== 'contribution.create' || admitted.state !== 'sealed'
      || admitted.acting_subject !== author || admitted.scope_id !== receipt.scope
      || admitted.request_digest !== receipt.requestDigest
      || admitted.authority_epoch !== receipt.authorityEpoch
      || admitted.graph_receipt !== receipt.id || admitted.graph_outcome !== 'succeeded'
      || admitted.graph_data_epoch !== coverage.dataEpoch || admitted.graph_sequence !== sequence) {
      throw new RetainedEffectConflict('current Access admission does not prove retained draft');
    }
    const marker = `urn:rezics:restore:${env.lineage.dataEpoch}`;
    const update = `PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
      DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(marker)} rv:reconciledPriorSequence ?last } }
      INSERT {
        GRAPH ${iri(GRAPHS.control)} { ${iri(marker)} rv:reconciledPriorSequence ${sequence} }
        GRAPH ${iri(GRAPHS.current)} {
          ${iri(contribution)} a rv:TextContribution ; rv:work ${iri(work)} ;
            rv:author ${iri(author)} ; rv:language ${lit(language)} ;
            rv:draftHead ${iri(draftRevision)} .
        }
        GRAPH ${iri(GRAPHS.revisions)} {
          ${iri(draftRevision)} a rv:RevisionAnchor ; rv:component ${iri(contribution)} ;
            rv:operation ${iri(operation)} ; rv:manifest ${iri(draftManifest)} ;
            rv:modelRevision ${iri(CONTRIBUTION_PROFILE)} ;
            rv:shapeRevision ${iri(CONTRIBUTION_PROFILE)} ; rv:datasetId ${iri(DATASET)} ;
            rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} .
        }
        GRAPH ${iri(GRAPHS.receipts)} {
          ${iri(receipt.id)} a rv:OperationReceipt ; rv:operation ${iri(operation)} ;
            rv:requestDigest ${lit(receipt.requestDigest)} ;
            rv:admissionId ${lit(receipt.admissionId)} ;
            rv:authorityEpoch ${lit(receipt.authorityEpoch)} ;
            rv:admittedScope ${lit(receipt.scope)} ; rv:outcome rv:Succeeded ;
            rv:work ${iri(work)} ; rv:contribution ${iri(contribution)} ;
            rv:draftRevision ${iri(draftRevision)} ; rv:language ${lit(language)} ;
            rv:author ${iri(author)} ; rv:datasetId ${iri(DATASET)} ;
            rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} .
        }
        GRAPH ${iri(GRAPHS.outbox)} {
          ${iri(data.batchId)} a rv:OutboxBatch ; rv:dataEpoch ${lit(coverage.dataEpoch)} ;
            rv:sequence ${sequence} ; rv:eventCount 1 ; rv:event ${iri(eventId)} .
          ${iri(eventId)} a rv:ContributionDraftCreatedEvent ; rv:ordinal 0 ;
            rv:action "contribution.create" ; rv:receipt ${iri(receipt.id)} ;
            rv:operation ${iri(operation)} ; rv:work ${iri(work)} ;
            rv:contribution ${iri(contribution)} .
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
        GRAPH ${iri(GRAPHS.current)} { ${iri(work)} a schema:CreativeWork . }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(contribution)} ?p ?o } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt.id)} ?p ?o } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(draftRevision)} ?p ?o } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.outbox)} {
          ?otherBatch rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} . } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.outbox)} { ${iri(eventId)} ?p ?o } }
      }`;
    const existing = await readTextContributionReceipt(env, receipt.admissionId);
    let updateError: unknown;
    if (!existing) {
      try { await env.fuseki.update(update); }
      catch (error) { updateError = error; }
    }
    const terminal = await readTextContributionReceipt(env, receipt.admissionId);
    const cursor = await reconciledCursor(env, marker);
    const graphCheck = await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
      GRAPH ${iri(GRAPHS.current)} {
        ${iri(contribution)} a rv:TextContribution ; rv:work ${iri(work)} ;
          rv:author ${iri(author)} ; rv:language ${lit(language)} . }
      GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(draftRevision)} a rv:RevisionAnchor ; rv:component ${iri(contribution)} ;
          rv:manifest ${iri(draftManifest)} ; rv:dataEpoch ${lit(coverage.dataEpoch)} ;
          rv:sequence ${sequence} . }
      GRAPH ${iri(GRAPHS.outbox)} {
        ${iri(data.batchId)} a rv:OutboxBatch ; rv:dataEpoch ${lit(coverage.dataEpoch)} ;
          rv:sequence ${sequence} ; rv:eventCount 1 ; rv:event ${iri(eventId)} .
        ${iri(eventId)} a rv:ContributionDraftCreatedEvent ; rv:receipt ${iri(receipt.id)} . }
    }`);
    const headCheck = cursor === BigInt(sequence)
      ? await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
          GRAPH ${iri(GRAPHS.current)} {
            ${iri(contribution)} rv:draftHead ${iri(draftRevision)} . }
        }`)
      : { boolean: true };
    if (!terminal || terminal.outcome !== 'succeeded' || terminal.receipt !== receipt.id
      || terminal.requestDigest !== receipt.requestDigest
      || terminal.admissionId !== receipt.admissionId
      || terminal.authorityEpoch !== receipt.authorityEpoch || terminal.scope !== receipt.scope
      || terminal.work !== work || terminal.contribution !== contribution
      || terminal.draftRevision !== draftRevision || terminal.author !== author
      || terminal.language !== language || terminal.dataEpoch !== coverage.dataEpoch
      || terminal.sequence !== sequence || cursor === null || cursor < BigInt(sequence)
      || graphCheck.boolean !== true || headCheck.boolean !== true) {
      throw new RetainedEffectConflict(updateError
        ? 'retained draft update outcome is unknown' : 'retained draft did not reconcile');
    }
    await client.query('COMMIT');
    return { receipt: receipt.id, contribution, draftRevision, replayed: !!existing };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* retain original error */ }
    throw error;
  } finally {
    client.release();
  }
}

/** Reapply one retained private draft edit against its exact previous head. */
export async function reconcileRetainedContributionDraftEdit(
  env: WorkActivationEnvironment, accessPool: Pool, relayPool: Pool,
  coverage: RelayCoverage, sequence: string,
): Promise<{ receipt: string; draftRevision: string; replayed: boolean }> {
  const { eventId, envelope } = await loadRetainedEvent(relayPool, coverage, sequence);
  const data = envelope?.data;
  const receipt = data?.receipt;
  if (envelope.id !== eventId || envelope.specversion !== '1.0'
    || envelope.source !== 'https://rezics.com/services/main'
    || envelope.type !== 'com.rezics.contribution.draft-edited.v1'
    || data.ordinal !== 0 || data.sourcePosition.datasetId !== 'product'
    || data.sourcePosition.dataEpoch !== coverage.dataEpoch
    || data.sourcePosition.sequence !== sequence
    || receipt.action !== 'contribution.edit' || receipt.outcome !== 'succeeded'
    || !receipt.operation || !receipt.work || !receipt.contribution
    || !receipt.draftRevision || !receipt.draftManifest || !receipt.expectedHead
    || !receipt.author || !receipt.language
    || receipt.scope !== `contribution:edit:${receipt.contribution}`
    || receipt.mainVersion || receipt.workRevision || receipt.mainRevision || receipt.reason
    || receipt.id !== textContributionEditReceiptIri(receipt.admissionId)
    || eventId !== `urn:rezics:event:${hash(receipt.operation)}`
    || data.batchId !== `urn:rezics:outbox:${hash(receipt.id)}`) {
    throw new RetainedEffectConflict('retained Contribution draft edit envelope is incomplete');
  }
  const work = receipt.work;
  const contribution = receipt.contribution;
  const draftRevision = receipt.draftRevision;
  const draftManifest = receipt.draftManifest;
  const expectedHead = receipt.expectedHead;
  const operation = receipt.operation;
  const author = receipt.author;
  const language = receipt.language;
  for (const value of [eventId, data.batchId, receipt.id, work, contribution,
    draftRevision, expectedHead, operation, author]) iri(value);
  if (!/^urn:rezics:sha256:[0-9a-f]{64}$/.test(draftManifest)) {
    throw new RetainedEffectConflict('retained Contribution edit manifest is invalid');
  }
  const state = readComponentState(env.objectDirectory, draftManifest,
    contribution, CONTRIBUTION_PROFILE);
  if (state.work !== work || state.author !== author || state.language !== language
    || typeof state.body !== 'string' || state.publication !== 'draft') {
    throw new RetainedEffectConflict('retained Contribution edit payload differs');
  }
  const client = await accessPool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const fence = await client.query<{ open: boolean }>(
      'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE');
    if (fence.rows[0]?.open !== false) throw new RetainedEffectConflict('Access recovery fence is not held');
    const access = await client.query<AccessEffectRow & { acting_subject: string }>(
      `SELECT action, state, scope_id, request_digest, authority_epoch, acting_subject,
         graph_receipt, graph_outcome, graph_data_epoch, graph_sequence
       FROM access.admission WHERE id = $1`, [receipt.admissionId]);
    const admitted = access.rows[0];
    if (!admitted || admitted.action !== 'contribution.edit' || admitted.state !== 'sealed'
      || admitted.scope_id !== receipt.scope
      || admitted.request_digest !== receipt.requestDigest
      || admitted.authority_epoch !== receipt.authorityEpoch
      || admitted.graph_receipt !== receipt.id || admitted.graph_outcome !== 'succeeded'
      || admitted.graph_data_epoch !== coverage.dataEpoch || admitted.graph_sequence !== sequence
      || textContributionEditDigest({ contribution, expectedHead, body: state.body,
        actingSubject: admitted.acting_subject }) !== receipt.requestDigest) {
      throw new RetainedEffectConflict('current Access admission does not prove retained draft edit');
    }
    const marker = `urn:rezics:restore:${env.lineage.dataEpoch}`;
    const update = `PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
      DELETE {
        GRAPH ${iri(GRAPHS.control)} { ${iri(marker)} rv:reconciledPriorSequence ?last }
        GRAPH ${iri(GRAPHS.current)} { ${iri(contribution)} rv:draftHead ${iri(expectedHead)} }
      }
      INSERT {
        GRAPH ${iri(GRAPHS.control)} { ${iri(marker)} rv:reconciledPriorSequence ${sequence} }
        GRAPH ${iri(GRAPHS.current)} { ${iri(contribution)} rv:draftHead ${iri(draftRevision)} }
        GRAPH ${iri(GRAPHS.revisions)} {
          ${iri(draftRevision)} a rv:RevisionAnchor ; rv:component ${iri(contribution)} ;
            rv:predecessor ${iri(expectedHead)} ; rv:operation ${iri(operation)} ;
            rv:manifest ${iri(draftManifest)} ; rv:modelRevision ${iri(CONTRIBUTION_PROFILE)} ;
            rv:shapeRevision ${iri(CONTRIBUTION_PROFILE)} ; rv:datasetId ${iri(DATASET)} ;
            rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} .
        }
        GRAPH ${iri(GRAPHS.receipts)} {
          ${iri(receipt.id)} a rv:OperationReceipt ; rv:operation ${iri(operation)} ;
            rv:requestDigest ${lit(receipt.requestDigest)} ;
            rv:admissionId ${lit(receipt.admissionId)} ;
            rv:authorityEpoch ${lit(receipt.authorityEpoch)} ;
            rv:admittedScope ${lit(receipt.scope)} ; rv:outcome rv:Succeeded ;
            rv:work ${iri(work)} ; rv:contribution ${iri(contribution)} ;
            rv:draftRevision ${iri(draftRevision)} ; rv:expectedHead ${iri(expectedHead)} ;
            rv:author ${iri(author)} ; rv:language ${lit(language)} ;
            rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(coverage.dataEpoch)} ;
            rv:sequence ${sequence} .
        }
        GRAPH ${iri(GRAPHS.outbox)} {
          ${iri(data.batchId)} a rv:OutboxBatch ; rv:dataEpoch ${lit(coverage.dataEpoch)} ;
            rv:sequence ${sequence} ; rv:eventCount 1 ; rv:event ${iri(eventId)} .
          ${iri(eventId)} a rv:ContributionDraftEditedEvent ; rv:ordinal 0 ;
            rv:action "contribution.edit" ; rv:receipt ${iri(receipt.id)} ;
            rv:operation ${iri(operation)} ; rv:work ${iri(work)} ;
            rv:contribution ${iri(contribution)} .
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
          ${iri(contribution)} a rv:TextContribution ; rv:work ${iri(work)} ;
            rv:author ${iri(author)} ; rv:language ${lit(language)} ;
            rv:draftHead ${iri(expectedHead)} .
          ${iri(work)} a schema:CreativeWork .
        }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt.id)} ?p ?o } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(draftRevision)} ?p ?o } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.outbox)} {
          ?otherBatch rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} . } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.outbox)} { ${iri(eventId)} ?p ?o } }
      }`;
    const existing = await readTextContributionEditReceipt(env, receipt.admissionId);
    let updateError: unknown;
    if (!existing) {
      try { await env.fuseki.update(update); }
      catch (error) { updateError = error; }
    }
    const terminal = await readTextContributionEditReceipt(env, receipt.admissionId);
    const cursor = await reconciledCursor(env, marker);
    const graphCheck = await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
      GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(draftRevision)} a rv:RevisionAnchor ; rv:component ${iri(contribution)} ;
          rv:predecessor ${iri(expectedHead)} ; rv:operation ${iri(operation)} ;
          rv:manifest ${iri(draftManifest)} ; rv:dataEpoch ${lit(coverage.dataEpoch)} ;
          rv:sequence ${sequence} . }
      GRAPH ${iri(GRAPHS.outbox)} {
        ${iri(data.batchId)} a rv:OutboxBatch ; rv:dataEpoch ${lit(coverage.dataEpoch)} ;
          rv:sequence ${sequence} ; rv:eventCount 1 ; rv:event ${iri(eventId)} .
        ${iri(eventId)} a rv:ContributionDraftEditedEvent ; rv:receipt ${iri(receipt.id)} . }
    }`);
    const headCheck = cursor === BigInt(sequence)
      ? await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
          GRAPH ${iri(GRAPHS.current)} {
            ${iri(contribution)} rv:draftHead ${iri(draftRevision)} . }
        }`)
      : { boolean: true };
    if (!terminal || terminal.outcome !== 'succeeded' || terminal.receipt !== receipt.id
      || terminal.requestDigest !== receipt.requestDigest
      || terminal.admissionId !== receipt.admissionId
      || terminal.authorityEpoch !== receipt.authorityEpoch || terminal.scope !== receipt.scope
      || terminal.work !== work || terminal.contribution !== contribution
      || terminal.draftRevision !== draftRevision || terminal.expectedHead !== expectedHead
      || terminal.author !== author || terminal.language !== language
      || terminal.dataEpoch !== coverage.dataEpoch || terminal.sequence !== sequence
      || cursor === null || cursor < BigInt(sequence)
      || graphCheck.boolean !== true || headCheck.boolean !== true) {
      throw new RetainedEffectConflict(updateError
        ? 'retained draft edit update outcome is unknown' : 'retained draft edit did not reconcile');
    }
    await client.query('COMMIT');
    return { receipt: receipt.id, draftRevision, replayed: !!existing };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* retain original error */ }
    throw error;
  } finally {
    client.release();
  }
}

/** Restore one terminal cancellation/rejection without creating a domain effect. */
export async function reconcileRetainedAdmissionCancellation(
  env: WorkActivationEnvironment, accessPool: Pool, relayPool: Pool,
  coverage: RelayCoverage, sequence: string,
): Promise<{ receipt: string; reason?: 'stale-head'; replayed: boolean }> {
  const { eventId, envelope } = await loadRetainedEvent(relayPool, coverage, sequence);
  const data = envelope?.data;
  const receipt = data?.receipt;
  const workRejected = envelope.type === 'com.rezics.work.edit-rejected.v1';
  const contributionRejected = envelope.type === 'com.rezics.contribution.draft-edit-rejected.v1';
  const rejected = workRejected || contributionRejected;
  const cancelled = envelope.type === 'com.rezics.work.admission-cancelled.v1';
  const contributionCancelled = envelope.type === 'com.rezics.contribution.admission-cancelled.v1';
  const suffix = rejected ? 'stale' : 'cancel';
  const expectedEvent = receipt?.id && `urn:rezics:event:${hash(`${receipt.id}\0${suffix}`)}`;
  const expectedReceipt = receipt?.action === 'work.create'
    ? workReceiptIri(receipt.admissionId) : receipt?.action === 'work.edit'
      ? workEditReceiptIri(receipt.admissionId) : receipt?.action === 'contribution.create'
        ? textContributionReceiptIri(receipt.admissionId) : receipt?.action === 'contribution.edit'
          ? textContributionEditReceiptIri(receipt.admissionId) : null;
  if (envelope.id !== eventId || envelope.specversion !== '1.0'
    || envelope.source !== 'https://rezics.com/services/main'
    || (!rejected && !cancelled && !contributionCancelled)
    || data.ordinal !== 0 || data.sourcePosition.datasetId !== 'product'
    || data.sourcePosition.dataEpoch !== coverage.dataEpoch
    || data.sourcePosition.sequence !== sequence
    || receipt.outcome !== 'cancelled' || !expectedReceipt || receipt.id !== expectedReceipt
    || (workRejected && (receipt.action !== 'work.edit' || receipt.reason !== 'stale-head'))
    || (contributionRejected && (receipt.action !== 'contribution.edit'
      || receipt.reason !== 'stale-head'))
    || (cancelled && (!['work.create', 'work.edit'].includes(receipt.action) || receipt.reason))
    || (contributionCancelled && (!['contribution.create', 'contribution.edit'].includes(receipt.action)
      || receipt.reason))
    || receipt.operation || receipt.work || receipt.mainVersion || receipt.workRevision
    || receipt.mainRevision || receipt.workManifest || receipt.mainManifest || receipt.expectedHead
    || receipt.contribution || receipt.draftRevision || receipt.draftManifest
    || receipt.author || receipt.language
    || eventId !== expectedEvent || data.batchId !== expectedEvent?.replace(':event:', ':outbox:')) {
    throw new RetainedEffectConflict('retained terminal admission envelope is incomplete');
  }
  for (const value of [eventId, data.batchId, receipt.id]) iri(value);
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
    if (!admitted || admitted.action !== receipt.action || admitted.state !== 'sealed'
      || admitted.scope_id !== receipt.scope || admitted.request_digest !== receipt.requestDigest
      || admitted.authority_epoch !== receipt.authorityEpoch
      || admitted.graph_receipt !== receipt.id || admitted.graph_outcome !== 'cancelled'
      || admitted.graph_data_epoch !== coverage.dataEpoch || admitted.graph_sequence !== sequence) {
      throw new RetainedEffectConflict('current Access admission does not prove retained cancellation');
    }
    const marker = `urn:rezics:restore:${env.lineage.dataEpoch}`;
    const reasonTriple = rejected ? 'rv:reason rv:StaleHead ;' : '';
    const eventType = workRejected ? 'WorkEditRejectedEvent'
      : contributionRejected ? 'ContributionDraftEditRejectedEvent'
      : contributionCancelled ? 'ContributionAdmissionCancelledEvent' : 'AdmissionCancelledEvent';
    const admissionTriple = cancelled ? ` ; rv:admissionId ${lit(receipt.admissionId)}` : '';
    const update = `PREFIX rv: <${RV}>
      DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(marker)} rv:reconciledPriorSequence ?last } }
      INSERT {
        GRAPH ${iri(GRAPHS.control)} { ${iri(marker)} rv:reconciledPriorSequence ${sequence} }
        GRAPH ${iri(GRAPHS.receipts)} {
          ${iri(receipt.id)} a rv:OperationReceipt ; rv:requestDigest ${lit(receipt.requestDigest)} ;
            rv:admissionId ${lit(receipt.admissionId)} ; rv:authorityEpoch ${lit(receipt.authorityEpoch)} ;
            rv:admittedScope ${lit(receipt.scope)} ; rv:outcome rv:Cancelled ; ${reasonTriple}
            rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(coverage.dataEpoch)} ;
            rv:sequence ${sequence} .
        }
        GRAPH ${iri(GRAPHS.outbox)} {
          ${iri(data.batchId)} a rv:OutboxBatch ; rv:dataEpoch ${lit(coverage.dataEpoch)} ;
            rv:sequence ${sequence} ; rv:eventCount 1 ; rv:event ${iri(eventId)} .
          ${iri(eventId)} a rv:${eventType} ; rv:ordinal 0 ;
            rv:action ${lit(receipt.action)} ; rv:receipt ${iri(receipt.id)}${admissionTriple} .
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
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt.id)} ?p ?o } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.outbox)} {
          ?otherBatch rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} . } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.outbox)} { ${iri(eventId)} ?p ?o } }
      }`;
    const readTerminal = () => receipt.action === 'work.create'
      ? readWorkTerminalReceipt(env.fuseki, receipt.admissionId)
      : receipt.action === 'work.edit'
        ? readWorkEditTerminalReceipt(env, receipt.admissionId)
        : receipt.action === 'contribution.create'
          ? readTextContributionReceipt(env, receipt.admissionId)
          : readTextContributionEditReceipt(env, receipt.admissionId);
    const existing = await readTerminal();
    let updateError: unknown;
    if (!existing) {
      try { await env.fuseki.update(update); }
      catch (error) { updateError = error; }
    }
    const terminal = await readTerminal();
    const cursor = await reconciledCursor(env, marker);
    const graphCheck = await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
      GRAPH ${iri(GRAPHS.outbox)} { ${iri(data.batchId)} a rv:OutboxBatch ;
        rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} ;
        rv:eventCount 1 ; rv:event ${iri(eventId)} .
        ${iri(eventId)} a rv:${eventType} ; rv:receipt ${iri(receipt.id)} . }
    }`);
    if (!terminal || terminal.outcome !== 'cancelled' || terminal.receipt !== receipt.id
      || terminal.requestDigest !== receipt.requestDigest || terminal.admissionId !== receipt.admissionId
      || terminal.authorityEpoch !== receipt.authorityEpoch || terminal.scope !== receipt.scope
      || terminal.dataEpoch !== coverage.dataEpoch || terminal.sequence !== sequence
      || ('reason' in terminal ? terminal.reason : undefined) !== receipt.reason
      || cursor === null || cursor < BigInt(sequence) || graphCheck.boolean !== true) {
      throw new RetainedEffectConflict(updateError
        ? 'retained cancellation update outcome is unknown' : 'retained cancellation did not reconcile');
    }
    await client.query('COMMIT');
    return { receipt: receipt.id, ...(rejected ? { reason: 'stale-head' as const } : {}),
      replayed: !!existing };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* retain original error */ }
    throw error;
  } finally {
    client.release();
  }
}

export const reconcileRetainedWorkCancellation = reconcileRetainedAdmissionCancellation;
