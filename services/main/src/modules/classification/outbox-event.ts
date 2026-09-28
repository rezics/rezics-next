import type { OwnerOutboxEventHandler } from '../outbox/event-handlers.ts';
import { DATASET, GRAPHS, RV, iri, lit } from '../work/activate.ts';
import { GLOBAL_CLASSIFICATION_PROFILE, GLOBAL_CLASSIFICATION_CONTEXT,
  globalClassificationTerminal } from './global.ts';

export const outboxEventHandlers: readonly OwnerOutboxEventHandler[] = [{
  kind: `${RV}GlobalClassificationContextCreatedEvent`, action: 'classification.global.bootstrap',
  type: 'com.rezics.classification.global-bootstrapped.v1', authority: 'system',
  read: async ({ fuseki, batch, eventId, value, ordinal }) => {
    const terminal = globalClassificationTerminal(batch.dataEpoch);
    if (value('receipt') !== terminal.receipt || value('digest') !== terminal.digest
      || value('action') !== 'classification.global.bootstrap' || value('outcome') !== `${RV}Succeeded`
      || value('epoch') !== batch.dataEpoch || value('sequence') !== batch.sequence
      || value('admissionId') !== undefined || value('authorityEpoch') !== undefined || value('scope') !== undefined
      || eventId !== terminal.event || batch.batchId !== terminal.batch || ordinal !== 0) {
      throw new Error('Global classification event differs from its system terminal');
    }
    const result = await fuseki.query(`PREFIX rv: <${RV}> SELECT ?revision ?manifest ?operation WHERE {
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(terminal.receipt)} rv:datasetId ${iri(DATASET)} ;
        rv:classificationContext ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} ; rv:contextRevision ?revision ;
        rv:operation ?operation . }
      GRAPH ${iri(GRAPHS.revisions)} { ?revision a rv:RevisionAnchor ;
        rv:component ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} ; rv:manifest ?manifest ; rv:operation ?operation ;
        rv:modelRevision ${iri(GLOBAL_CLASSIFICATION_PROFILE)} ; rv:shapeRevision ${iri(GLOBAL_CLASSIFICATION_PROFILE)} ;
        rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(batch.dataEpoch)} ; rv:sequence ${batch.sequence} . }
    } LIMIT 2`);
    const rows = result.results?.bindings ?? [], row = rows[0];
    if (rows.length !== 1 || !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(row?.revision?.value ?? '')
      || !/^urn:rezics:sha256:[0-9a-f]{64}$/.test(row?.manifest?.value ?? '')
      || !row?.operation || row.operation.value !== value('operation')) {
      throw new Error('Global classification event has no exact retained revision');
    }
    return { specversion: '1.0', id: eventId, source: 'https://rezics.com/services/main',
      type: 'com.rezics.classification.global-bootstrapped.v1', datacontenttype: 'application/json',
      data: { batchId: batch.batchId, sourcePosition: { datasetId: 'product',
        dataEpoch: batch.dataEpoch, sequence: batch.sequence }, routingEpoch: batch.routingEpoch, ordinal,
      receipt: { id: terminal.receipt, action: 'classification.global.bootstrap', outcome: 'succeeded',
        requestDigest: terminal.digest, systemProof: { kind: 'classification-global-bootstrap-v1',
          context: GLOBAL_CLASSIFICATION_CONTEXT, revision: row!.revision!.value,
          manifest: row!.manifest!.value, operation: row.operation.value } } } };
  },
}];
