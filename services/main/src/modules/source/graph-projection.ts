import { CommandRejected, type FusekiClient } from '../../infrastructure/fuseki.ts';
import { profileValidations } from '../../infrastructure/profile.ts';
import { DATASET, GRAPHS, RV, hash, iri, lit,
  type GraphLineage } from '../work/activate.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { OpenLibraryConversionStore, type OpenLibraryConversion }
  from './open-library-conversion.ts';
import type { StagedSourceObservation } from './intake.ts';

const SOURCE = 'urn:rezics:graph:source';
const PROFILE = 'source-open-library-work-v1';
const SHAPE = `https://rezics.com/definition/${PROFILE}`;

export class SourceGraphUnavailable extends Error {}

export interface SourceGraphProjection {
  profile: 'open-library-work-source-graph-v1';
  state: 'staged';
  record: string;
  observation: string;
  conversion: string;
  sourceDigest: string;
  projection: OpenLibraryConversion['projection'];
  receipt: string;
  sourcePosition: { datasetId: 'product'; dataEpoch: string; sequence: string };
}

function identity(conversion: OpenLibraryConversion) {
  const receipt = `urn:rezics:receipt:source-projection:${hash(conversion.conversion)}`;
  const digest = hash(JSON.stringify({ family: 'source-open-library-work-v1',
    conversion: conversion.conversion, observation: conversion.observation,
    mappingRevision: conversion.mappingRevision, sourceDigest: conversion.sourceDigest,
    projection: conversion.projection, fieldInventory: conversion.fieldInventory }));
  return { receipt, digest };
}

function sourceTriples(conversion: OpenLibraryConversion,
  observation: StagedSourceObservation): string {
  const record = iri(observation.record);
  const observed = iri(observation.observation);
  const converted = iri(conversion.conversion);
  const value = conversion.projection;
  return `${record} a rv:SourceRecord ; rv:sourceProvider "open-library" ;
    rv:sourceNamespace "work" ; rv:sourceExternalId ${lit(observation.externalId)} .
    ${observed} a rv:SourceObservation ; rv:sourceRecord ${record} ;
      rv:sourceByteDigest ${lit(conversion.sourceDigest)} ;
      rv:sourceCoverage rv:CompleteWorkResponse ;
      rv:sourceRightsBasis ${lit(observation.rightsEvidence.basis)} ;
      rv:sourceRightsNote ${lit(observation.rightsEvidence.note)} ;
      rv:sourceSubmittedAt ${lit(observation.submittedAt)} ;
      rv:sourceFetchedAt ${lit(observation.capture!.fetchedAt)}
      ${observation.sourceRevision ? `; rv:sourceRevision ${lit(observation.sourceRevision)}` : ''} .
    ${converted} a rv:SourceConversion ; rv:sourceObservation ${observed} ;
      rv:sourceKey ${lit(value.sourceKey)} ; rv:sourceTitle ${lit(value.title)} ;
      rv:sourceByteDigest ${lit(conversion.sourceDigest)} ;
      rv:sourceMappingRevision ${lit(conversion.mappingRevision)} ;
      rv:sourceAuthorRefsJson ${lit(JSON.stringify(value.authorRefs))} ;
      rv:sourceSubjectsJson ${lit(JSON.stringify(value.subjects))}
      ${value.description !== null ? `; rv:sourceDescription ${lit(value.description)}` : ''} .`;
}

function update(lineage: GraphLineage, conversion: OpenLibraryConversion,
  observation: StagedSourceObservation, receipt: string, digest: string): string {
  const batch = `urn:rezics:outbox:${hash(receipt)}`;
  const event = `urn:rezics:event:${hash(`${receipt}\0source`)}`;
  return `PREFIX rv: <${RV}>
    DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }
    INSERT {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(SOURCE)} { ${sourceTriples(conversion, observation)} }
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ;
        rv:requestDigest ${lit(digest)} ; rv:outcome rv:Succeeded ;
        rv:sourceRecord ${iri(observation.record)} ;
        rv:sourceObservation ${iri(observation.observation)} ;
        rv:sourceConversion ${iri(conversion.conversion)} ;
        rv:sourceByteDigest ${lit(conversion.sourceDigest)} ;
        rv:sourceMappingRevision ${lit(conversion.mappingRevision)} ;
        rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(lineage.dataEpoch)} ;
        rv:sequence ?next . }
      GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch)} a rv:OutboxBatch ;
        rv:dataEpoch ${lit(lineage.dataEpoch)} ; rv:sequence ?next ;
        rv:eventCount 1 ; rv:event ${iri(event)} .
        ${iri(event)} a rv:SourceProjectedEvent ; rv:ordinal 0 ;
          rv:action "source.project" ; rv:receipt ${iri(receipt)} ;
          rv:sourceConversion ${iri(conversion.conversion)} . }
    } WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(lineage.routingEpoch)} ; rv:sequence ?n . }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      FILTER NOT EXISTS { GRAPH ${iri(SOURCE)} { ${iri(conversion.conversion)} ?p ?o } }
      BIND(?n + 1 AS ?next)
    }`;
}

function projectionResult(conversion: OpenLibraryConversion,
  observation: StagedSourceObservation, receipt: string,
  position: { datasetId: string; dataEpoch: string; sequence: string }): SourceGraphProjection {
  if (position.datasetId !== DATASET || !/^(0|[1-9][0-9]*)$/.test(position.sequence)) {
    throw new SourceGraphUnavailable('source projection position differs');
  }
  return { profile: 'open-library-work-source-graph-v1', state: 'staged',
    record: observation.record, observation: observation.observation,
    conversion: conversion.conversion, sourceDigest: conversion.sourceDigest,
    projection: conversion.projection, receipt,
    sourcePosition: { datasetId: 'product', dataEpoch: position.dataEpoch,
      sequence: position.sequence } };
}

export class OpenLibrarySourceGraph {
  constructor(private readonly fuseki: FusekiClient, private readonly lineage: GraphLineage,
    private readonly conversions: OpenLibraryConversionStore) {}

  async project(principalId: string, conversionId: string): Promise<SourceGraphProjection | null> {
    const evidence = await this.conversions.verifiedRead(principalId, conversionId);
    if (!evidence) return null;
    const { conversion, observation } = evidence;
    const { receipt, digest } = identity(conversion);
    await assertGraphAdmissionOpen(this.fuseki, this.lineage);
    const validations = await profileValidations(this.fuseki, PROFILE, [
      { shape: `${SHAPE}/record-shape`, focus: [observation.record], graphs: [SOURCE] },
      { shape: `${SHAPE}/observation-shape`, focus: [observation.observation], graphs: [SOURCE] },
      { shape: `${SHAPE}/conversion-shape`, focus: [conversion.conversion], graphs: [SOURCE] },
    ]);
    const result = await this.fuseki.commandWithReceipt({ receipt, digest,
      update: update(this.lineage, conversion, observation, receipt, digest),
      validations, deadlineMs: 10_000 });
    if (result.status !== 'committed') throw new CommandRejected(result);
    const retained = await this.readVerified(conversion, observation);
    if (!retained || retained.sourcePosition.dataEpoch !== result.position.dataEpoch
      || retained.sourcePosition.sequence !== result.position.sequence) {
      throw new SourceGraphUnavailable('committed source projection cannot be read exactly');
    }
    return retained;
  }

  async read(principalId: string, conversionId: string): Promise<SourceGraphProjection | null> {
    const evidence = await this.conversions.verifiedRead(principalId, conversionId);
    if (!evidence) return null;
    return this.readVerified(evidence.conversion, evidence.observation);
  }

  private async readVerified(conversion: OpenLibraryConversion,
    observation: StagedSourceObservation): Promise<SourceGraphProjection | null> {
    const { receipt, digest } = identity(conversion);
    const answer = await this.fuseki.query(`PREFIX rv: <${RV}>
      SELECT ?digest ?epoch ?sequence WHERE { GRAPH ${iri(GRAPHS.receipts)} {
        ${iri(receipt)} a rv:OperationReceipt ; rv:requestDigest ?digest ;
          rv:outcome rv:Succeeded ; rv:datasetId ${iri(DATASET)} ;
          rv:sourceRecord ${iri(observation.record)} ;
          rv:sourceObservation ${iri(observation.observation)} ;
          rv:sourceConversion ${iri(conversion.conversion)} ;
          rv:sourceByteDigest ${lit(conversion.sourceDigest)} ;
          rv:sourceMappingRevision ${lit(conversion.mappingRevision)} ;
          rv:dataEpoch ?epoch ; rv:sequence ?sequence .
      } } LIMIT 2`, 16_384);
    const rows = answer.results?.bindings ?? [];
    if (!rows.length) {
      const exists = await this.fuseki.query(`ASK { GRAPH ${iri(GRAPHS.receipts)} {
        ${iri(receipt)} ?p ?o . } }`, 4096);
      if (exists.boolean === true) throw new SourceGraphUnavailable('source projection receipt is incomplete');
      return null;
    }
    if (rows.length !== 1 || rows[0]?.digest?.value !== digest
      || !rows[0].epoch?.value || !rows[0].sequence?.value) {
      throw new SourceGraphUnavailable('source projection receipt differs');
    }
    const graph = await this.fuseki.query(`PREFIX rv: <${RV}> ASK {
      GRAPH ${iri(SOURCE)} { ${sourceTriples(conversion, observation)} }
    }`, 4096);
    if (graph.boolean !== true) throw new SourceGraphUnavailable('source graph differs from retained conversion');
    return projectionResult(conversion, observation, receipt, {
      datasetId: DATASET, dataEpoch: rows[0].epoch.value,
      sequence: rows[0].sequence.value });
  }
}
