import type { OwnerOutboxEventHandler } from '../outbox/event-handlers.ts';
import { GRAPHS, RV, hash, iri, lit } from '../work/activate.ts';

const rebuildPhases = ['quarantine', 'clear', 'cleared', 'activate'] as const;

export const outboxEventHandlers: readonly OwnerOutboxEventHandler[] = [
  { kind: `${RV}ContentPrivateProjectionEvent`, action: 'content.private-project',
    type: 'com.rezics.content.private-projected.v1', authority: 'system',
    read: async ({ fuseki, batch, eventId, value, ordinal }) => {
      const receipt = value('receipt');
      const identity = receipt?.match(/^urn:rezics:receipt:content-private-projection:([0-9a-f]{64})$/)?.[1];
      const digest = value('digest');
      if (!receipt || !identity || !digest || value('outcome') !== `${RV}Succeeded`
        || batch.batchId !== `urn:rezics:outbox:${hash(`${identity}\0batch`)}`
        || eventId !== `urn:rezics:event:${hash(`${identity}\0event`)}`
        || ordinal !== 0 || batch.eventIds.length !== 1) {
        throw new Error('Private Content projection event differs from source position');
      }
      const result = await fuseki.query(`PREFIX rv: <${RV}> SELECT ?resource ?variant
        ?revision ?projection ?unit ?ownerEpoch ?ownerSequence WHERE {
        GRAPH ${iri(GRAPHS.outbox)} { ${iri(eventId)} a rv:ContentPrivateProjectionEvent ;
          rv:ordinal 0 ; rv:action "content.private-project" ; rv:receipt ${iri(receipt)} ;
          rv:variant ?variant ; rv:contentRevision ?revision . }
        GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ;
          rv:requestDigest ${lit(digest)} ; rv:outcome rv:Succeeded ;
          rv:resource ?resource ; rv:variant ?variant ; rv:contentRevision ?revision ;
          rv:projection ?projection ; rv:matchUnit ?unit ;
          rv:ownerDataEpoch ?ownerEpoch ; rv:ownerSequence ?ownerSequence ;
          rv:dataEpoch ${lit(batch.dataEpoch)} ; rv:sequence ${batch.sequence} . }
        GRAPH ${iri(GRAPHS.revisions)} { ?projection a rv:ContentPrivateProjection ;
          rv:resource ?resource ; rv:variant ?variant ; rv:contentRevision ?revision ;
          rv:matchUnit ?unit ; rv:ownerDataEpoch ?ownerEpoch ;
          rv:ownerSequence ?ownerSequence . }
      } LIMIT 2`);
      const rows = result.results?.bindings ?? [];
      const row = rows[0];
      if (rows.length !== 1 || !row?.resource || !row.variant || !row.revision
        || !row.projection || !row.unit || !row.ownerEpoch || !row.ownerSequence
        || value('variant') !== row.variant.value
        || value('contentRevision') !== row.revision.value) {
        throw new Error('Private Content projection has no unique graph proof');
      }
      return { specversion: '1.0', id: eventId, source: 'https://rezics.com/services/main',
        type: 'com.rezics.content.private-projected.v1', datacontenttype: 'application/json',
        data: { batchId: batch.batchId, routingEpoch: batch.routingEpoch, ordinal,
          sourcePosition: { datasetId: 'product', dataEpoch: batch.dataEpoch,
            sequence: batch.sequence },
          receipt: { id: receipt, action: 'content.private-project', outcome: 'succeeded',
            requestDigest: digest, systemProof: { kind: 'content-private-projected',
              resource: row.resource.value, variant: row.variant.value,
              contentRevision: row.revision.value, projection: row.projection.value,
              matchUnit: row.unit.value, ownerDataEpoch: row.ownerEpoch.value,
              ownerSequence: row.ownerSequence.value } } } };
    } },
  { kind: `${RV}ContentRebuildEvent`,
    action: 'content.rebuild.quarantine',
    actions: rebuildPhases.slice(1).map(phase => `content.rebuild.${phase}`),
    type: 'com.rezics.content.rebuild.v1', authority: 'system',
    read: async ({ fuseki, batch, eventId, value, ordinal }) => {
      const receipt = value('receipt');
      const action = value('action');
      const phase = action?.replace(/^content\.rebuild\./, '');
      const digest = value('digest');
      if (!receipt || !phase || !rebuildPhases.includes(phase as typeof rebuildPhases[number])
        || !new RegExp(`^urn:rezics:receipt:content-rebuild:${phase}:[0-9a-f]{64}$`).test(receipt)
        || !digest || value('outcome') !== `${RV}Succeeded`
        || batch.batchId !== `urn:rezics:outbox:${hash(`${receipt}\0batch`)}`
        || eventId !== `urn:rezics:event:${hash(`${receipt}\0event`)}`
        || ordinal !== 0 || batch.eventIds.length !== 1) {
        throw new Error('Content rebuild event differs from source position');
      }
      const proof = await fuseki.query(`PREFIX rv: <${RV}> ASK {
        GRAPH ${iri(GRAPHS.outbox)} { ${iri(eventId)} a rv:ContentRebuildEvent ;
          rv:ordinal 0 ; rv:action ${lit(action!)} ; rv:receipt ${iri(receipt)} . }
        GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ;
          rv:requestDigest ${lit(digest)} ; rv:outcome rv:Succeeded ;
          rv:dataEpoch ${lit(batch.dataEpoch)} ; rv:sequence ${batch.sequence} . }
      }`);
      if (proof.boolean !== true) throw new Error('Content rebuild event has no terminal receipt');
      return { specversion: '1.0', id: eventId, source: 'https://rezics.com/services/main',
        type: 'com.rezics.content.rebuild.v1', datacontenttype: 'application/json',
        data: { batchId: batch.batchId, routingEpoch: batch.routingEpoch, ordinal,
          sourcePosition: { datasetId: 'product', dataEpoch: batch.dataEpoch,
            sequence: batch.sequence },
          receipt: { id: receipt, action: action!, outcome: 'succeeded', requestDigest: digest,
            systemProof: { kind: 'content-rebuild', phase } } } };
    } },
];
