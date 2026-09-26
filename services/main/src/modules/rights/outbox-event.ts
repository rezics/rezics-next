import type { OwnerOutboxEventHandler } from '../outbox/event-handlers.ts';
import { GRAPHS, RV, iri } from '../work/activate.ts';

const kinds = [
  ['RightsOfferingCreatedEvent', 'rights.offer-create', 'com.rezics.rights.offering-created.v1'],
  ['RightsOfferingEndedEvent', 'rights.offer-end', 'com.rezics.rights.offering-ended.v1'],
  ['RightsOfferingRecognizedEvent', 'rights.offer-recognize', 'com.rezics.rights.offering-recognized.v1'],
  ['RightsOfferingInvalidatedEvent', 'rights.offer-invalidate', 'com.rezics.rights.offering-invalidated.v1'],
] as const;

/** The relay reads the owner receipt and event together; an event alone is not proof. */
export const outboxEventHandlers: readonly OwnerOutboxEventHandler[] = kinds.map(([kind, action, type]) => ({
  kind: `${RV}${kind}`, action, type,
  async read({ fuseki, batch, eventId, value, ordinal }) {
    const receipt = value('receipt') ?? '';
    const result = await fuseki.query(`PREFIX rv: <${RV}> SELECT ?offering ?revision WHERE {
      GRAPH ${iri(GRAPHS.outbox)} {
        ${iri(eventId)} a rv:${kind} ; rv:receipt ${iri(receipt)} ;
          rv:rightsOffering ?offering ; rv:rightsRevision ?revision .
      }
      GRAPH ${iri(GRAPHS.receipts)} {
        ${iri(receipt)} a rv:OperationReceipt ; rv:outcome rv:Succeeded ;
          rv:action ${JSON.stringify(action)} ; rv:rightsOffering ?offering ; rv:rightsRevision ?revision .
      }
    } LIMIT 2`);
    const rows = result.results?.bindings ?? [];
    if (rows.length !== 1 || !rows[0]?.offering?.value || !rows[0]?.revision?.value) {
      throw new Error('rights offering event has no matching terminal receipt');
    }
    return { specversion: '1.0' as const, id: eventId,
      source: 'https://rezics.com/services/main' as const, type,
      datacontenttype: 'application/json' as const,
      data: { batchId: batch.batchId,
        sourcePosition: { datasetId: 'product' as const, dataEpoch: batch.dataEpoch, sequence: batch.sequence },
        routingEpoch: batch.routingEpoch, ordinal,
        receipt: { id: receipt, action, outcome: 'succeeded' as const,
          admissionId: value('admissionId') ?? '', requestDigest: value('digest') ?? '',
          authorityEpoch: value('authorityEpoch') ?? '', scope: value('scope') ?? '',
          offering: rows[0]!.offering!.value, revision: rows[0]!.revision!.value } } };
  },
}));
