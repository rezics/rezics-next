import type { Pool } from 'pg';
import { profileValidations } from '../../infrastructure/profile.ts';
import { DATASET, GRAPHS, RV, hash, iri, lit,
  type WorkActivationEnvironment } from '../work/activate.ts';
import { reconciledCursor, RetainedEffectConflict } from '../work/reconcile-restored.ts';
import { relayRetainedEventAt, RelayCheckpointConflict, type RelayCoverage,
  type SourceBoundaryCloudEvent } from '../outbox/relay.ts';
import { OpenLibraryConversionStore } from './open-library-conversion.ts';
import { SourceIntakeStore } from './intake.ts';
import { OpenLibrarySourceGraph, sourceProjectionIdentity, sourceTriples }
  from './graph-projection.ts';

const SOURCE = 'urn:rezics:graph:source';
const PROFILE = 'source-open-library-work-v1';
const SHAPE = `https://rezics.com/definition/${PROFILE}`;
const SOURCE_ID = /^https:\/\/rezics\.com\/id\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** Rebuild one retained source projection at its original position while graph admission is held. */
export async function reconcileRetainedSourceProjection(
  env: WorkActivationEnvironment, accessPool: Pool, relayPool: Pool, contentPool: Pool,
  coverage: RelayCoverage, sequence: string,
): Promise<{ receipt: string; conversion: string; replayed: boolean }> {
  let retained;
  try { retained = await relayRetainedEventAt(relayPool, coverage, sequence); }
  catch (error) {
    if (error instanceof RelayCheckpointConflict) throw new RetainedEffectConflict(error.message);
    throw error;
  }
  const { eventId, batch } = retained;
  const envelope = retained.envelope as unknown as SourceBoundaryCloudEvent;
  const data = envelope?.data;
  const receipt = data?.receipt;
  const conversionId = SOURCE_ID.exec(receipt?.conversion ?? '')?.[1];
  if (!envelope || !data || !receipt || envelope.id !== eventId
    || envelope.specversion !== '1.0'
    || envelope.source !== 'https://rezics.com/services/main'
    || envelope.type !== 'com.rezics.source.projected.v1'
    || data.ordinal !== 0 || data.sourcePosition.datasetId !== 'product'
    || data.sourcePosition.dataEpoch !== coverage.dataEpoch
    || data.sourcePosition.sequence !== sequence
    || data.batchId !== batch.batchId || data.routingEpoch !== batch.routingEpoch
    || batch.eventCount !== 1
    || receipt.action !== 'source.project' || receipt.outcome !== 'succeeded'
    || receipt.mappingRevision !== 'open-library-work-map-v1'
    || !conversionId || !SOURCE_ID.test(receipt.record)
    || !SOURCE_ID.test(receipt.observation)
    || eventId !== `urn:rezics:event:${hash(`${receipt.id}\0source`)}`
    || data.batchId !== `urn:rezics:outbox:${hash(receipt.id)}`) {
    throw new RetainedEffectConflict('retained source projection envelope is incomplete');
  }
  for (const value of [eventId, data.batchId, receipt.id, receipt.record,
    receipt.observation, receipt.conversion]) iri(value);
  const fence = await accessPool.query<{ open: boolean }>(
    'SELECT open FROM access.recovery_fence WHERE id = true');
  if (fence.rows[0]?.open !== false) {
    throw new RetainedEffectConflict('Access recovery fence is not held');
  }
  const owner = await contentPool.query<{ principal_id: string }>(
    'SELECT principal_id FROM source.conversion WHERE id = $1', [conversionId]);
  const principalId = owner.rows[0]?.principal_id;
  if (!principalId || owner.rows.length !== 1) {
    throw new RetainedEffectConflict('retained source conversion is unavailable');
  }
  const conversions = new OpenLibraryConversionStore(contentPool, new SourceIntakeStore(contentPool));
  const evidence = await conversions.verifiedRead(principalId, conversionId);
  if (!evidence) throw new RetainedEffectConflict('retained source evidence is unavailable');
  const { conversion, observation } = evidence;
  const expected = sourceProjectionIdentity(conversion);
  if (expected.receipt !== receipt.id || expected.digest !== receipt.requestDigest
    || observation.record !== receipt.record || observation.observation !== receipt.observation
    || conversion.conversion !== receipt.conversion
    || conversion.sourceDigest !== receipt.byteDigest
    || conversion.mappingRevision !== receipt.mappingRevision) {
    throw new RetainedEffectConflict('retained source event differs from immutable evidence');
  }
  const graph = new OpenLibrarySourceGraph(env.fuseki, env.lineage, conversions);
  const existing = await graph.read(principalId, conversionId);
  const marker = `urn:rezics:restore:${env.lineage.dataEpoch}`;
  if (!existing) {
    const validations = await profileValidations(env.fuseki, PROFILE, [
      { shape: `${SHAPE}/record-shape`, focus: [observation.record], graphs: [SOURCE] },
      { shape: `${SHAPE}/observation-shape`, focus: [observation.observation], graphs: [SOURCE] },
      { shape: `${SHAPE}/conversion-shape`, focus: [conversion.conversion], graphs: [SOURCE] },
    ]);
    const update = `PREFIX rv: <${RV}>
      DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(marker)} rv:reconciledPriorSequence ?last } }
      INSERT {
        GRAPH ${iri(GRAPHS.control)} { ${iri(marker)} rv:reconciledPriorSequence ${sequence} }
        GRAPH ${iri(SOURCE)} { ${sourceTriples(conversion, observation)} }
        GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt.id)} a rv:OperationReceipt ;
          rv:requestDigest ${lit(receipt.requestDigest)} ; rv:outcome rv:Succeeded ;
          rv:sourceRecord ${iri(observation.record)} ;
          rv:sourceObservation ${iri(observation.observation)} ;
          rv:sourceConversion ${iri(conversion.conversion)} ;
          rv:sourceByteDigest ${lit(conversion.sourceDigest)} ;
          rv:sourceMappingRevision ${lit(conversion.mappingRevision)} ;
          rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(coverage.dataEpoch)} ;
          rv:sequence ${sequence} . }
        GRAPH ${iri(GRAPHS.outbox)} { ${iri(data.batchId)} a rv:OutboxBatch ;
          rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} ;
          rv:eventCount 1 ; rv:event ${iri(eventId)} .
          ${iri(eventId)} a rv:SourceProjectedEvent ; rv:ordinal 0 ;
            rv:action "source.project" ; rv:receipt ${iri(receipt.id)} ;
            rv:sourceConversion ${iri(conversion.conversion)} . }
      } WHERE {
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
        FILTER NOT EXISTS { GRAPH ${iri(SOURCE)} { ${iri(conversion.conversion)} ?p ?o } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.outbox)} {
          ?otherBatch rv:dataEpoch ${lit(coverage.dataEpoch)} ; rv:sequence ${sequence} . } }
      }`;
    const result = await env.fuseki.commandWithReceipt({ receipt: receipt.id,
      digest: receipt.requestDigest, update, validations, deadlineMs: 10_000 });
    if (result.status !== 'committed') {
      throw new RetainedEffectConflict(`retained source command ${result.status}`);
    }
  }
  const restored = await graph.read(principalId, conversionId);
  const cursor = await reconciledCursor(env, marker);
  if (!restored || restored.receipt !== receipt.id
    || restored.sourcePosition.dataEpoch !== coverage.dataEpoch
    || restored.sourcePosition.sequence !== sequence
    || cursor === null || cursor < BigInt(sequence)) {
    throw new RetainedEffectConflict('retained source projection did not reconcile');
  }
  return { receipt: receipt.id, conversion: conversion.conversion, replayed: !!existing };
}
