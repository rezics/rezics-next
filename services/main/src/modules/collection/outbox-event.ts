import type { OwnerOutboxEventHandler } from '../outbox/event-handlers.ts';
import { GRAPHS, RV, hash, iri, lit } from '../work/activate.ts';

export const outboxEventHandlers: readonly OwnerOutboxEventHandler[] = [{
  kind: `${RV}CollectionNamePublishedEvent`, action: 'collection.edit',
  type: 'com.rezics.collection.name-published.v1',
  read: async ({ fuseki, batch, eventId, value, ordinal }) => {
    const receipt = value('receipt');
    const operation = value('operation');
    const digest = value('digest');
    if (!receipt || !operation || !digest || value('outcome') !== `${RV}Succeeded`
      || batch.batchId !== `urn:rezics:outbox:${hash(receipt)}`
      || eventId !== `urn:rezics:event:${hash(operation)}`
      || ordinal !== 0 || batch.eventIds.length !== 1) {
      throw new Error('Collection name event differs from its source position');
    }
    const rows = (await fuseki.query(`PREFIX rv: <${RV}> SELECT ?collection ?revision ?payload WHERE {
      GRAPH ${iri(GRAPHS.outbox)} { ${iri(eventId)} a rv:CollectionNamePublishedEvent ;
        rv:ordinal 0 ; rv:action "collection.edit" ; rv:receipt ${iri(receipt)} ;
        rv:operation ${iri(operation)} . }
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ;
        rv:operation ${iri(operation)} ; rv:requestDigest ${lit(digest)} ;
        rv:outcome rv:Succeeded ; rv:structureOwner ?collection ; rv:structureRevision ?revision ;
        rv:dataEpoch ${lit(batch.dataEpoch)} ; rv:sequence ${batch.sequence} . }
      GRAPH ${iri(GRAPHS.revisions)} { ?revision a rv:CollectionNameRevision ;
        rv:component ?collection ; rv:operation ${iri(operation)} ; rv:profilePayload ?payload ;
        rv:dataEpoch ${lit(batch.dataEpoch)} ; rv:sequence ${batch.sequence} . }
    } LIMIT 2`)).results?.bindings ?? [];
    if (rows.length !== 1 || !rows[0]?.collection || !rows[0]?.revision || !rows[0]?.payload) {
      throw new Error('Collection name event has no unique terminal graph proof');
    }
    const collection = rows[0].collection.value;
    const revision = rows[0].revision.value;
    iri(collection); iri(revision);
    return { specversion: '1.0', id: eventId, source: 'https://rezics.com/services/main',
      type: 'com.rezics.collection.name-published.v1', datacontenttype: 'application/json',
      data: { batchId: batch.batchId, routingEpoch: batch.routingEpoch, ordinal,
        sourcePosition: { datasetId: 'product', dataEpoch: batch.dataEpoch, sequence: batch.sequence },
        receipt: { id: receipt, action: 'collection.edit', outcome: 'succeeded',
          requestDigest: digest, admissionId: value('admissionId')!,
          authorityEpoch: value('authorityEpoch')!, scope: value('scope')!,
          collection, revision, operation } } };
  },
}];
