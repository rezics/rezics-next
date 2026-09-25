import type { Pool } from 'pg';
import { profileValidations } from '../../infrastructure/profile.ts';
import { relayRetainedEventAt, RelayCheckpointConflict,
  type MainCloudEvent, type RelayCoverage } from '../outbox/relay.ts';
import { DATASET, GRAPHS, RV, hash, iri, lit, type WorkActivationEnvironment }
  from './activate.ts';
import { readWorkDerivationTerminal, readWorkDerivations, validateWorkDerivation,
  workDerivationDigest, workDerivationReceiptIri, type WorkDerivationInput }
  from './derivations.ts';
import { reconciledCursor, RetainedEffectConflict }
  from './reconcile-restored.ts';

const PROFILE = 'https://rezics.com/definition/work-derivation-v1';
const kinds = { adaptation: 'Adaptation', 'new-recording': 'NewRecording',
  'software-fork': 'SoftwareFork' } as const;
const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;

/** A retained event is an exact declaration, never a hint to infer continuity. */
export function parseRetainedWorkDerivation(eventId: string, envelope: MainCloudEvent,
  coverage: RelayCoverage, sequence: string): {
    input: WorkDerivationInput; derivation: string; batchId: string;
    receipt: MainCloudEvent['data']['receipt'];
  } {
  const data = envelope?.data;
  const receipt = data?.receipt;
  if (!data || !receipt || !data.sourcePosition
    || envelope.id !== eventId || envelope.specversion !== '1.0'
    || envelope.source !== 'https://rezics.com/services/main'
    || envelope.type !== 'com.rezics.work.derived.v1'
    || envelope.datacontenttype !== 'application/json'
    || data.ordinal !== 0 || data.sourcePosition.datasetId !== 'product'
    || data.sourcePosition.dataEpoch !== coverage.dataEpoch
    || data.sourcePosition.sequence !== sequence
    || typeof data.routingEpoch !== 'string' || !data.routingEpoch
    || receipt.outcome !== 'succeeded' || receipt.action !== 'work.derive'
    || !/^[0-9a-f-]{36}$/.test(receipt.admissionId)
    || !/^[0-9]+$/.test(receipt.authorityEpoch)
    || !/^[0-9a-f]{64}$/.test(receipt.requestDigest)
    || !receipt.workDerivation || !nativeId.test(receipt.workDerivation)
    || receipt.id !== workDerivationReceiptIri(receipt.admissionId)
    || eventId !== `urn:rezics:event:${hash(`${receipt.id}\0work-derived`)}`
    || data.batchId !== `urn:rezics:outbox:${hash(receipt.id)}`
    || !receipt.derivationKind || !Object.hasOwn(kinds, receipt.derivationKind)
    || receipt.scope !== `derivation:link:${receipt.targetWork}`) {
    throw new RetainedEffectConflict('retained Work derivation event is incomplete');
  }
  const input: WorkDerivationInput = {
    targetWork: receipt.targetWork ?? '',
    targetMainVersion: receipt.targetMainVersion ?? '',
    expectedTargetHead: receipt.targetMainRevision ?? '',
    sourceWork: receipt.sourceWork ?? '',
    sourceMainVersion: receipt.sourceMainVersion ?? '',
    sourceMainRevision: receipt.sourceMainRevision ?? '',
    kind: receipt.derivationKind,
    evidence: receipt.evidence ?? '',
    actingSubject: receipt.linkedBy ?? '',
  };
  try { validateWorkDerivation(input); }
  catch { throw new RetainedEffectConflict('retained Work derivation input is invalid'); }
  iri(eventId); iri(data.batchId); iri(receipt.id); iri(receipt.workDerivation);
  return { input, derivation: receipt.workDerivation, batchId: data.batchId, receipt };
}

/** Rebuild one original relation under a held, sequential graph restore. */
export async function reconcileRetainedWorkDerivation(
  env: WorkActivationEnvironment, accessPool: Pool, relayPool: Pool,
  coverage: RelayCoverage, sequence: string,
): Promise<{ receipt: string; derivation: string; replayed: boolean }> {
  let retained: Awaited<ReturnType<typeof relayRetainedEventAt>>;
  try { retained = await relayRetainedEventAt(relayPool, coverage, sequence); }
  catch (error) {
    if (error instanceof RelayCheckpointConflict) {
      throw new RetainedEffectConflict(error.message);
    }
    throw error;
  }
  const { eventId, envelope, batch } = retained;
  const { input, derivation, batchId, receipt } = parseRetainedWorkDerivation(
    eventId, envelope, coverage, sequence);
  if (batch.batchId !== batchId || batch.routingEpoch !== envelope.data.routingEpoch
    || batch.eventCount !== 1) {
    throw new RetainedEffectConflict('retained Work derivation batch header differs');
  }
  const client = await accessPool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const fence = await client.query<{ open: boolean }>(
      'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE');
    if (fence.rows[0]?.open !== false) throw new RetainedEffectConflict('Access recovery fence is not held');
    const admission = await client.query<{ action: string; state: string; scope_id: string;
      request_digest: string; authority_epoch: string; acting_subject: string;
      idempotency_key: string; graph_receipt: string | null; graph_outcome: string | null;
      graph_data_epoch: string | null; graph_sequence: string | null }>(
      `SELECT action, state, scope_id, request_digest, authority_epoch, acting_subject,
         idempotency_key, graph_receipt, graph_outcome, graph_data_epoch, graph_sequence
       FROM access.admission WHERE id = $1`, [receipt.admissionId]);
    const admitted = admission.rows[0];
    if (admission.rows.length !== 1 || !admitted || admitted.action !== 'work.derive'
      || admitted.state !== 'sealed' || admitted.acting_subject !== input.actingSubject
      || !/^[A-Za-z0-9:_./-]{1,128}$/.test(admitted.idempotency_key)
      || admitted.scope_id !== receipt.scope || admitted.request_digest !== receipt.requestDigest
      || workDerivationDigest({ ...input, idempotencyKey: admitted.idempotency_key })
        !== receipt.requestDigest
      || admitted.authority_epoch !== receipt.authorityEpoch
      || admitted.graph_receipt !== receipt.id || admitted.graph_outcome !== 'succeeded'
      || admitted.graph_data_epoch !== coverage.dataEpoch || admitted.graph_sequence !== sequence) {
      throw new RetainedEffectConflict('Access admission does not prove retained Work derivation');
    }
    const marker = `urn:rezics:restore:${env.lineage.dataEpoch}`;
    const update = `PREFIX rv: <${RV}>
      DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(marker)} rv:reconciledPriorSequence ?last } }
      INSERT {
        GRAPH ${iri(GRAPHS.control)} { ${iri(marker)} rv:reconciledPriorSequence ${sequence} }
        GRAPH ${iri(GRAPHS.revisions)} {
          ${iri(derivation)} a rv:WorkDerivation ; rv:targetWork ${iri(input.targetWork)} ;
            rv:targetMainVersion ${iri(input.targetMainVersion)} ;
            rv:targetMainRevision ${iri(input.expectedTargetHead)} ;
            rv:sourceWork ${iri(input.sourceWork)} ;
            rv:sourceMainVersion ${iri(input.sourceMainVersion)} ;
            rv:sourceMainRevision ${iri(input.sourceMainRevision)} ;
            rv:derivationKind rv:${kinds[input.kind]} ; rv:evidence ${lit(input.evidence)} ;
            rv:linkedBy ${iri(input.actingSubject)} ; rv:modelRevision ${iri(PROFILE)} ;
            rv:shapeRevision ${iri(PROFILE)} ; rv:datasetId ${iri(DATASET)} ;
            rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} .
        }
        GRAPH ${iri(GRAPHS.receipts)} {
          ${iri(receipt.id)} a rv:OperationReceipt ; rv:requestDigest ${lit(receipt.requestDigest)} ;
            rv:admissionId ${lit(receipt.admissionId)} ; rv:admittedScope ${lit(receipt.scope)} ;
            rv:authorityEpoch ${lit(receipt.authorityEpoch)} ; rv:outcome rv:Succeeded ;
            rv:workDerivation ${iri(derivation)} ; rv:datasetId ${iri(DATASET)} ;
            rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} .
        }
        GRAPH ${iri(GRAPHS.outbox)} {
          ${iri(batchId)} a rv:OutboxBatch ; rv:dataEpoch ${lit(coverage.dataEpoch)} ;
            rv:sequence ${sequence} ; rv:eventCount 1 ; rv:event ${iri(eventId)} .
          ${iri(eventId)} a rv:WorkDerivedEvent ; rv:ordinal 0 ;
            rv:action "work.derive" ; rv:receipt ${iri(receipt.id)} ;
            rv:workDerivation ${iri(derivation)} .
        }
      } WHERE {
        GRAPH ${iri(GRAPHS.control)} {
          ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
            rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence 0 ;
            rv:restoreCutover ${iri(marker)} ; rv:restoreHold true .
          ${iri(marker)} rv:priorDataEpoch ${lit(coverage.dataEpoch)} ; rv:priorSequence ?saved .
          OPTIONAL { ${iri(marker)} rv:reconciledPriorSequence ?last }
          BIND(COALESCE(?last, ?saved) AS ?previous)
          FILTER(?previous + 1 = ${sequence})
        }
        GRAPH ${iri(GRAPHS.current)} {
          ${iri(input.targetWork)} rv:mainVersion ${iri(input.targetMainVersion)} .
          ${iri(input.targetMainVersion)} a rv:MainVersion ; rv:work ${iri(input.targetWork)} ;
            rv:head ${iri(input.expectedTargetHead)} .
          ${iri(input.sourceWork)} rv:mainVersion ${iri(input.sourceMainVersion)} .
          ${iri(input.sourceMainVersion)} a rv:MainVersion ; rv:work ${iri(input.sourceWork)} .
        }
        GRAPH ${iri(GRAPHS.revisions)} {
          ${iri(input.expectedTargetHead)} a rv:RevisionAnchor ;
            rv:component ${iri(input.targetMainVersion)} .
          ${iri(input.sourceMainRevision)} a rv:RevisionAnchor ;
            rv:component ${iri(input.sourceMainVersion)} .
        }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} {
          ?prior a rv:WorkDerivation ; rv:targetMainRevision ${iri(input.expectedTargetHead)} . } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(derivation)} ?p ?o } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt.id)} ?p ?o } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.outbox)} {
          ?otherBatch rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} . } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.outbox)} { ${iri(eventId)} ?p ?o } }
      }`;
    const existing = await readWorkDerivationTerminal(env, receipt.admissionId);
    let updateError: unknown;
    if (!existing) {
      try {
        const validations = await profileValidations(env.fuseki, 'work-derivation-v1', [{
          shape: `${PROFILE}/derivation-shape`, focus: [derivation],
          graphs: [GRAPHS.current, GRAPHS.revisions, GRAPHS.receipts, GRAPHS.control],
        }], { derivation, 'target-work': input.targetWork,
          'target-main': input.targetMainVersion, 'target-revision': input.expectedTargetHead,
          'source-work': input.sourceWork, 'source-main': input.sourceMainVersion,
          'source-revision': input.sourceMainRevision, kind: input.kind,
          evidence: input.evidence, actor: input.actingSubject, receipt: receipt.id,
          scope: receipt.scope, epoch: receipt.authorityEpoch });
        const result = await env.fuseki.commandWithReceipt({ receipt: receipt.id,
          digest: receipt.requestDigest, update, validations, deadlineMs: 10_000 });
        if (result.status === 'invalid' || result.status === 'unknown-profile'
          || result.status === 'conflict') throw new Error(`retained derivation command ${result.status}`);
      } catch (error) { updateError = error; }
    }
    const terminal = await readWorkDerivationTerminal(env, receipt.admissionId);
    const cursor = await reconciledCursor(env, marker);
    const graphCheck = await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
      GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(derivation)} a rv:WorkDerivation ; rv:targetWork ${iri(input.targetWork)} ;
          rv:targetMainVersion ${iri(input.targetMainVersion)} ;
          rv:targetMainRevision ${iri(input.expectedTargetHead)} ;
          rv:sourceWork ${iri(input.sourceWork)} ;
          rv:sourceMainVersion ${iri(input.sourceMainVersion)} ;
          rv:sourceMainRevision ${iri(input.sourceMainRevision)} ;
          rv:derivationKind rv:${kinds[input.kind]} ; rv:evidence ${lit(input.evidence)} ;
          rv:linkedBy ${iri(input.actingSubject)} ; rv:modelRevision ${iri(PROFILE)} ;
          rv:shapeRevision ${iri(PROFILE)} ; rv:datasetId ${iri(DATASET)} ;
          rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} .
        FILTER NOT EXISTS { ?other a rv:WorkDerivation ;
          rv:targetMainRevision ${iri(input.expectedTargetHead)} .
          FILTER(?other != ${iri(derivation)}) }
      }
      GRAPH ${iri(GRAPHS.receipts)} {
        ${iri(receipt.id)} a rv:OperationReceipt ; rv:requestDigest ${lit(receipt.requestDigest)} ;
          rv:admissionId ${lit(receipt.admissionId)} ; rv:admittedScope ${lit(receipt.scope)} ;
          rv:authorityEpoch ${lit(receipt.authorityEpoch)} ; rv:outcome rv:Succeeded ;
          rv:workDerivation ${iri(derivation)} ; rv:datasetId ${iri(DATASET)} ;
          rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} .
      }
      GRAPH ${iri(GRAPHS.outbox)} {
        ${iri(batchId)} a rv:OutboxBatch ; rv:dataEpoch ${lit(coverage.dataEpoch)} ;
          rv:sequence ${sequence} ; rv:eventCount 1 ; rv:event ${iri(eventId)} .
        ${iri(eventId)} a rv:WorkDerivedEvent ; rv:ordinal 0 ;
          rv:action "work.derive" ; rv:receipt ${iri(receipt.id)} ;
          rv:workDerivation ${iri(derivation)} .
      }
    }`);
    const relations = await readWorkDerivations(env, input.targetMainVersion,
      input.expectedTargetHead);
    const relation = relations[0];
    if (!terminal || terminal.outcome !== 'succeeded' || terminal.derivation !== derivation
      || terminal.receipt !== receipt.id || terminal.requestDigest !== receipt.requestDigest
      || terminal.admissionId !== receipt.admissionId || terminal.scope !== receipt.scope
      || terminal.authorityEpoch !== receipt.authorityEpoch
      || terminal.dataEpoch !== coverage.dataEpoch || terminal.sequence !== sequence
      || cursor === null || cursor < BigInt(sequence) || graphCheck.boolean !== true
      || relations.length !== 1 || !relation || relation.derivation !== derivation
      || relation.targetWork !== input.targetWork
      || relation.targetMainVersion !== input.targetMainVersion
      || relation.targetMainRevision !== input.expectedTargetHead
      || relation.sourceWork !== input.sourceWork
      || relation.sourceMainVersion !== input.sourceMainVersion
      || relation.sourceMainRevision !== input.sourceMainRevision
      || relation.kind !== input.kind || relation.evidence !== input.evidence
      || relation.linkedBy !== input.actingSubject) {
      throw new RetainedEffectConflict(updateError
        ? 'retained derivation update outcome is unknown' : 'retained derivation did not reconcile');
    }
    await client.query('COMMIT');
    return { receipt: receipt.id, derivation, replayed: !!existing };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* retain original error */ }
    throw error;
  } finally {
    client.release();
  }
}
