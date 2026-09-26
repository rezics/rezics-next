import { DATASET, hash, iri, lit } from '../work/activate.ts';
import { profileValidations } from '../../infrastructure/profile.ts';
import type { FusekiClient } from '../../infrastructure/fuseki.ts';
import type { OpenLibraryConversion } from './open-library-conversion.ts';
import type { StagedSourceObservation } from './intake.ts';

const PROFILE = 'source-reification-v1';
const SHAPE = `https://rezics.com/definition/${PROFILE}/statement-shape`;
const SOURCE_ONLY_REASON = 'Source evidence requires separate explicit acceptance before native use.';

interface SourceFieldClaim {
  id: string;
  field: 'title' | 'description';
  predicate: 'sourceTitle' | 'sourceDescription';
  lexical: string;
}

export function sourceFieldClaims(conversion: OpenLibraryConversion,
  observation: StagedSourceObservation): SourceFieldClaim[] {
  const values: Array<Pick<SourceFieldClaim, 'field' | 'predicate' | 'lexical'>> = [
    { field: 'title', predicate: 'sourceTitle', lexical: conversion.projection.title },
    ...(conversion.projection.description === null ? [] : [{ field: 'description' as const,
      predicate: 'sourceDescription' as const, lexical: conversion.projection.description }]),
  ];
  return values.map(value => ({ ...value,
    id: `urn:rezics:source-statement:${hash(`${conversion.conversion}\0${value.field}\0${conversion.sourceDigest}`)}` }));
}

export function sourceStatementTriples(conversion: OpenLibraryConversion,
  observation: StagedSourceObservation): string {
  const claims = sourceFieldClaims(conversion, observation);
  const converted = iri(conversion.conversion);
  const observed = iri(observation.observation);
  const linked = claims.map(claim => iri(claim.id)).join(', ');
  const statements = claims.map(claim => `${iri(claim.id)} a rdf:Statement ;
      rdf:subject ${converted} ;
      rdf:predicate rv:${claim.predicate} ;
      rdf:object ${lit(claim.lexical)} ;
      prov:wasDerivedFrom ${observed} ;
      rv:sourceObservation ${observed} ;
      rv:sourceByteDigest ${lit(conversion.sourceDigest)} ;
      rv:sourceMappingRevision ${lit(conversion.mappingRevision)} ;
      rv:sourceField ${lit(claim.field)} ;
      rv:fieldDisposition ${lit('structured-source-only')} ;
      rv:dispositionReason ${lit(SOURCE_ONLY_REASON)} .`).join('\n');
  return `${converted} rv:sourceStatement ${linked} .\n${statements}`;
}

export async function sourceReificationValidations(fuseki: FusekiClient,
  conversion: OpenLibraryConversion, observation: StagedSourceObservation) {
  return profileValidations(fuseki, PROFILE, sourceFieldClaims(conversion, observation).map(claim => ({
    shape: SHAPE, focus: [claim.id], graphs: ['urn:rezics:graph:source'],
  })));
}

export const sourceReificationBounds = {
  maximumStatementsPerConversion: 2,
  maximumGeneratedTriples: 24,
  dataDataset: DATASET,
  sourceGraph: 'urn:rezics:graph:source',
  rdfType: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
  rdfStatement: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#Statement',
} as const;
