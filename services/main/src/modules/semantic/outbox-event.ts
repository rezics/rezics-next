import type { OwnerOutboxEventHandler } from '../outbox/event-handlers.ts';
import { DATASET, GRAPHS, RV, hash, iri, lit } from '../work/activate.ts';

type EventInput = Parameters<OwnerOutboxEventHandler['read']>[0];

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

export const outboxEventHandlers: OwnerOutboxEventHandler[] = [{
  kind: `${RV}SemanticChangedEvent`, action: 'semantic.change', type: 'com.rezics.semantic.changed.v1',
  read: input => readChangedEvent(input, 'semantic.change', 'semantic-change',
    ['SemanticRevision', 'DefinitionRevision'],
    'com.rezics.semantic.changed.v1'),
}];
