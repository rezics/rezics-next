import type { OwnerOutboxEventHandler } from '../outbox/event-handlers.ts';
import { GRAPHS, RV, hash, iri, lit } from '../work/activate.ts';

function ownerCreation(kind: string, action: 'zone.edit' | 'collection.edit',
  ownerKind: 'zone' | 'collection' | 'definition', operationKind: string,
  type: string): OwnerOutboxEventHandler {
  const operationProperty = ownerKind === 'definition' ? 'definitionOperation' : `${ownerKind}Operation`;
  const revisionType = ownerKind === 'definition' ? 'DynamicCollectionRevision'
    : ownerKind === 'collection' ? 'CollectionRevision' : 'ZoneRevision';
  return { kind: `${RV}${kind}`, action, type,
    read: async ({ fuseki, batch, eventId, value, ordinal }) => {
      const receipt = value('receipt');
      const operation = value('operation');
      const digest = value('digest');
      if (!receipt || !operation || !digest || value('outcome') !== `${RV}Succeeded`
        || batch.batchId !== `urn:rezics:outbox:${hash(receipt)}`
        || eventId !== `urn:rezics:event:${hash(operation)}`
        || ordinal !== 0 || batch.eventIds.length !== 1) {
        throw new Error('Owner creation event differs from its source position');
      }
      const result = await fuseki.query(`PREFIX rv: <${RV}> SELECT ?owner ?revision ?manifest WHERE {
        GRAPH ${iri(GRAPHS.outbox)} { ${iri(eventId)} a rv:${kind} ; rv:ordinal 0 ;
          rv:action ${lit(action)} ; rv:receipt ${iri(receipt)} ; rv:operation ${iri(operation)} . }
        GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ;
          rv:operation ${iri(operation)} ; rv:requestDigest ${lit(digest)} ;
          rv:outcome rv:Succeeded ; rv:structureOwner ?owner ; rv:structureRevision ?revision ;
          rv:dataEpoch ${lit(batch.dataEpoch)} ; rv:sequence ${batch.sequence} . }
        GRAPH ${iri(GRAPHS.revisions)} { ?revision a rv:${revisionType} ; rv:component ?owner ;
          rv:operation ${iri(operation)} ; rv:${operationProperty} rv:${operationKind} ;
          rv:manifest ?manifest ; rv:dataEpoch ${lit(batch.dataEpoch)} ;
          rv:sequence ${batch.sequence} . }
      } LIMIT 2`);
      const rows = result.results?.bindings ?? [];
      const owner = rows[0]?.owner?.value;
      const revision = rows[0]?.revision?.value;
      const manifest = rows[0]?.manifest?.value;
      if (rows.length !== 1 || !owner || !revision
        || !/^urn:rezics:sha256:[0-9a-f]{64}$/.test(manifest ?? '')) {
        throw new Error('Owner creation event has no unique terminal graph proof');
      }
      iri(owner); iri(revision);
      return { specversion: '1.0', id: eventId, source: 'https://rezics.com/services/main',
        type, datacontenttype: 'application/json', data: { batchId: batch.batchId,
          routingEpoch: batch.routingEpoch, ordinal,
          sourcePosition: { datasetId: 'product', dataEpoch: batch.dataEpoch,
            sequence: batch.sequence },
          receipt: { id: receipt, action, outcome: 'succeeded', requestDigest: digest,
            admissionId: value('admissionId')!, authorityEpoch: value('authorityEpoch')!,
            scope: value('scope')!, owner, revision, manifest, operation } } };
    } };
}

export const outboxEventHandlers: readonly OwnerOutboxEventHandler[] = [
  ownerCreation('ZoneCreateEvent', 'zone.edit', 'zone', 'ZoneCreate', 'com.rezics.zone.created.v1'),
  ownerCreation('ZoneConfigureEvent', 'zone.edit', 'zone', 'ZoneConfigure',
    'com.rezics.zone.configured.v1'),
  ownerCreation('ZoneRetireEvent', 'zone.edit', 'zone', 'ZoneRetire',
    'com.rezics.zone.retired.v1'),
  ownerCreation('ZoneRecoverEvent', 'zone.edit', 'zone', 'ZoneRecover',
    'com.rezics.zone.recovered.v1'),
  ownerCreation('CollectionCreateEvent', 'collection.edit', 'collection', 'CollectionCreate',
    'com.rezics.collection.created.v1'),
  ownerCreation('DynamicCollectionCreateEvent', 'collection.edit', 'definition',
    'DynamicCollectionCreate',
    'com.rezics.collection.definition-created.v1'),
  ownerCreation('DynamicCollectionReviseEvent', 'collection.edit', 'definition',
    'DynamicCollectionRevise', 'com.rezics.collection.definition-revised.v1'),
];
