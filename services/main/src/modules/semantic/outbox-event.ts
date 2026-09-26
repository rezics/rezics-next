import type { OwnerOutboxEventHandler } from '../outbox/event-handlers.ts';
import { DATASET, GRAPHS, RV, hash, iri, lit } from '../work/activate.ts';
import { ACTIVE_GENERATION, MODEL_MANIFEST_SHA256 } from './command.ts';
import { MODEL_COMPONENT, PROFILES } from './schema.ts';

type EventInput = Parameters<OwnerOutboxEventHandler['read']>[0];

/** Prove the bootstrap system terminal against its deterministic identity and generation head. */
async function readModelGenerationEvent({ fuseki, batch, eventId, value, ordinal }: EventInput) {
  const receipt = `urn:rezics:receipt:${hash(`${ACTIVE_GENERATION}\0model-generation`)}`;
  const digest = hash(JSON.stringify({ family: 'model-generation-v1', manifest: MODEL_MANIFEST_SHA256 }));
  if (value('receipt') !== receipt || value('digest') !== digest
    || value('outcome') !== `${RV}Succeeded` || value('epoch') !== batch.dataEpoch
    || value('sequence') !== batch.sequence || value('admissionId') !== undefined
    || value('authorityEpoch') !== undefined || value('scope') !== undefined
    || eventId !== `urn:rezics:event:${hash(`${receipt}\0model-generation`)}`
    || batch.batchId !== `urn:rezics:outbox:${hash(receipt)}` || ordinal !== 0) {
    throw new Error('model generation event differs from its system terminal');
  }
  const result = await fuseki.query(`PREFIX rv: <${RV}> SELECT ?manifest ?operation ?number ?version ?predecessor WHERE {
    GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} rv:operation ?operation ;
      rv:datasetId ${iri(DATASET)} . }
    GRAPH ${iri(GRAPHS.revisions)} { ${iri(ACTIVE_GENERATION)} a rv:ModelGeneration, rv:RevisionAnchor ;
      rv:component ${iri(MODEL_COMPONENT)} ; rv:generationNumber ?number ; rv:manifest ?manifest ;
      rv:commandModuleVersion ?version ; rv:entailmentProfile rv:NoEntailment ;
      rv:identityInference rv:Excluded ; rv:validationPosture rv:RejectOnViolation ;
      rv:operation ?operation ; rv:modelRevision ${iri(PROFILES.generation)} ;
      rv:shapeRevision ${iri(PROFILES.generation)} ; rv:datasetId ${iri(DATASET)} ;
      rv:dataEpoch ${lit(batch.dataEpoch)} ; rv:sequence ${batch.sequence} .
      OPTIONAL { ${iri(ACTIVE_GENERATION)} rv:predecessor ?predecessor } }
    GRAPH ${iri(GRAPHS.current)} { ${iri(MODEL_COMPONENT)} a rv:ModelComponent ;
      rv:generationHead ${iri(ACTIVE_GENERATION)} . }
  } LIMIT 2`);
  const rows = result.results?.bindings ?? [];
  const row = rows[0];
  const manifest = row?.manifest?.value;
  const operation = row?.operation?.value;
  if (rows.length !== 1 || !manifest || !/^urn:rezics:sha256:[0-9a-f]{64}$/.test(manifest)
    || !operation || !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(operation)
    || row?.number?.value !== '1' || !row.version?.value || row.predecessor
    || value('operation') !== operation) {
    throw new Error('model generation event has no exact generation proof');
  }
  return { specversion: '1.0' as const, id: eventId, source: 'https://rezics.com/services/main' as const,
    type: 'com.rezics.model.generation-recorded.v1', datacontenttype: 'application/json' as const,
    data: { batchId: batch.batchId, sourcePosition: { datasetId: 'product' as const,
      dataEpoch: batch.dataEpoch, sequence: batch.sequence }, routingEpoch: batch.routingEpoch, ordinal,
    receipt: { id: receipt, action: 'model.generation.record', outcome: 'succeeded' as const,
      requestDigest: digest, systemProof: { kind: 'model-generation-v1', generation: ACTIVE_GENERATION,
        generationNumber: '1', manifest, modelManifestSha256: MODEL_MANIFEST_SHA256,
        commandModuleVersion: row.version.value, operation } } } };
}

/** Prove that a change event names the exact admitted terminal and retained revision. */
export async function readChangedEvent(input: EventInput, action: 'semantic.change' | 'relation.change',
  family: 'semantic-change' | 'relation-change',
  revisionKinds: readonly ('SemanticRevision' | 'DefinitionRevision' | 'RelationOccurrenceRevision')[],
  type: string) {
  const { fuseki, batch, eventId, value, ordinal } = input;
  const receipt = value('receipt');
  const admissionId = value('admissionId');
  const digest = value('digest');
  const authorityEpoch = value('authorityEpoch');
  const scope = value('scope');
  if (!receipt || !admissionId || !digest || !authorityEpoch || !scope
    || !/^[0-9a-f-]{36}$/.test(admissionId) || !/^[0-9a-f]{64}$/.test(digest)
    || !/^[0-9]+$/.test(authorityEpoch) || !/^[1-9][0-9]{0,99}$/.test(batch.sequence)
    || receipt !== `urn:rezics:receipt:${hash(`${admissionId}\0${family}`)}`
    || value('outcome') !== `${RV}Succeeded`
    || value('epoch') !== batch.dataEpoch || value('sequence') !== batch.sequence) {
    throw new Error(`${action} event has no exact admitted terminal`);
  }
  const result = await fuseki.query(`PREFIX rv: <${RV}> SELECT ?component ?revision ?manifest ?generation ?expected WHERE {
    GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} rv:component ?component ; rv:revision ?revision .
      OPTIONAL { ${iri(receipt)} rv:expectedHead ?expected } }
    GRAPH ${iri(GRAPHS.revisions)} { ?revision a ?kind, rv:RevisionAnchor ;
      rv:component ?component ; rv:manifest ?manifest ; rv:modelGeneration ?generation ;
      rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(batch.dataEpoch)} ;
      rv:sequence ${batch.sequence} . }
    VALUES ?kind { ${revisionKinds.map(kind => `rv:${kind}`).join(' ')} }
  } LIMIT 2`);
  const rows = result.results?.bindings ?? [];
  const row = rows[0];
  const component = row?.component?.value;
  const revision = row?.revision?.value;
  const manifest = row?.manifest?.value;
  const generation = row?.generation?.value;
  const expected = row?.expected?.value;
  const native = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
  if (rows.length !== 1 || !component || !revision || !manifest || !generation
    || !native.test(component) || !native.test(revision)
    || !/^urn:rezics:sha256:[0-9a-f]{64}$/.test(manifest)
    || !/^urn:rezics:model-generation:[0-9a-f]{64}$/.test(generation)
    || (expected !== undefined && !native.test(expected))
    || value('expectedHead') !== expected
    || scope !== (expected ? `${family === 'semantic-change' ? 'semantic' : 'relation'}:edit:${component}`
      : `${family === 'semantic-change' ? 'semantic' : 'relation'}:create:root`)) {
    throw new Error(`${action} event revision differs from its admitted receipt`);
  }
  return { specversion: '1.0' as const, id: eventId, source: 'https://rezics.com/services/main' as const,
    type, datacontenttype: 'application/json' as const,
    data: { batchId: batch.batchId, sourcePosition: { datasetId: 'product' as const,
      dataEpoch: batch.dataEpoch, sequence: batch.sequence }, routingEpoch: batch.routingEpoch, ordinal,
    receipt: { id: receipt, action, outcome: 'succeeded' as const, admissionId,
      requestDigest: digest, authorityEpoch, scope, component, revision, manifest, modelGeneration: generation,
      ...(expected ? { expectedHead: expected } : {}) } } };
}

/** Prove the one bulk receipt, pinned generation and every item revision in its atomic event. */
async function readSemanticBulkChangedEvent(input: EventInput) {
  const { fuseki, batch, eventId, value, ordinal } = input;
  const receipt = value('receipt');
  const admissionId = value('admissionId');
  const digest = value('digest');
  const authorityEpoch = value('authorityEpoch');
  const scope = value('scope');
  if (!receipt || !admissionId || !digest || !authorityEpoch || !scope
    || !/^[0-9a-f-]{36}$/.test(admissionId) || !/^[0-9a-f]{64}$/.test(digest)
    || !/^[0-9]+$/.test(authorityEpoch) || !/^[1-9][0-9]{0,99}$/.test(batch.sequence)
    || receipt !== `urn:rezics:receipt:${hash(`${admissionId}\0semantic-change-bulk`)}`
    || value('action') !== 'semantic.change.bulk' || value('outcome') !== `${RV}Succeeded`
    || value('epoch') !== batch.dataEpoch || value('sequence') !== batch.sequence
    || scope !== 'semantic:create:root' || ordinal !== 0
    || eventId !== `urn:rezics:event:${hash(`${receipt}\0semantic-bulk`)}`
    || batch.batchId !== `urn:rezics:outbox:${hash(receipt)}`) {
    throw new Error('semantic bulk event has no exact admitted terminal');
  }
  const result = await fuseki.query(`PREFIX rv: <${RV}> SELECT ?generation ?count ?manifestDigest
    ?ordinal ?component ?revision ?manifest ?profile WHERE {
    GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ; rv:requestDigest ${lit(digest)} ;
      rv:admissionId ${lit(admissionId)} ; rv:authorityEpoch ${lit(authorityEpoch)} ;
      rv:admittedScope ${lit(scope)} ; rv:outcome rv:Succeeded ; rv:bulkGeneration ?generation ;
      rv:bulkCount ?count ; rv:bulkManifestDigest ?manifestDigest ; rv:bulkItem ?item . }
    GRAPH ${iri(GRAPHS.revisions)} { ?item a rv:SemanticBulkItem ; rv:ordinal ?ordinal ;
      rv:component ?component ; rv:revision ?revision .
      ?revision a ?kind, rv:RevisionAnchor ; rv:component ?component ;
      rv:manifest ?manifest ; rv:modelGeneration ?generation ; rv:modelRevision ?profile ;
      rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(batch.dataEpoch)} ; rv:sequence ${batch.sequence} . }
    VALUES ?kind { rv:SemanticRevision rv:DefinitionRevision }
  } ORDER BY ?ordinal`);
  const rows = result.results?.bindings ?? [];
  const first = rows[0];
  const generation = first?.generation?.value;
  const countLexical = first?.count?.value;
  const manifestDigest = first?.manifestDigest?.value;
  const count = Number(countLexical);
  if (!generation || !/^urn:rezics:model-generation:[0-9a-f]{64}$/.test(generation)
    || !countLexical || !Number.isInteger(count) || count < 1 || count > 128 || rows.length !== count
    || !manifestDigest || !/^[0-9a-f]{64}$/.test(manifestDigest)) {
    throw new Error('semantic bulk receipt manifest is incomplete');
  }
  const items = rows.map((row, expectedOrdinal) => {
    const component = row.component?.value;
    const revision = row.revision?.value;
    const manifest = row.manifest?.value;
    const profile = row.profile?.value;
    if (row.ordinal?.value !== String(expectedOrdinal) || !component || !revision || !manifest || !profile
      || !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(component)
      || !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(revision)
      || !/^urn:rezics:sha256:[0-9a-f]{64}$/.test(manifest)
      || (profile !== PROFILES.resource && profile !== PROFILES.definition)) {
      throw new Error('semantic bulk item revision differs from its receipt');
    }
    return { ordinal: expectedOrdinal, component, revision, manifest, modelGeneration: generation };
  });
  return { specversion: '1.0' as const, id: eventId, source: 'https://rezics.com/services/main' as const,
    type: 'com.rezics.semantic.bulk-changed.v1', datacontenttype: 'application/json' as const,
    data: { batchId: batch.batchId, sourcePosition: { datasetId: 'product' as const,
      dataEpoch: batch.dataEpoch, sequence: batch.sequence }, routingEpoch: batch.routingEpoch, ordinal,
    receipt: { id: receipt, action: 'semantic.change.bulk', outcome: 'succeeded' as const, admissionId,
      requestDigest: digest, authorityEpoch, scope, modelGeneration: generation, manifestDigest, items } } };
}

export const outboxEventHandlers: OwnerOutboxEventHandler[] = [{
  kind: `${RV}SemanticChangedEvent`, action: 'semantic.change', type: 'com.rezics.semantic.changed.v1',
  read: input => readChangedEvent(input, 'semantic.change', 'semantic-change',
    ['SemanticRevision', 'DefinitionRevision'],
    'com.rezics.semantic.changed.v1'),
}, {
  kind: `${RV}SemanticBulkChangedEvent`, action: 'semantic.change.bulk',
  type: 'com.rezics.semantic.bulk-changed.v1', read: readSemanticBulkChangedEvent,
}, {
  kind: `${RV}ModelGenerationRecordedEvent`, action: 'model.generation.record',
  type: 'com.rezics.model.generation-recorded.v1', authority: 'system', read: readModelGenerationEvent,
}];
