import type { OwnerOutboxEventHandler } from '../outbox/event-handlers.ts';
import { RV } from '../work/activate.ts';
import { readCatalogueVerification } from './verification.ts';

export const outboxEventHandlers = [{
  kind: `${RV}CatalogueVerifiedEvent`, action: 'catalogue.verify', type: 'com.rezics.catalogue.verified.v1',
  read: async ({ fuseki, batch, eventId, value, ordinal }) => {
    const admissionId = value('admissionId');
    if (!admissionId) throw new Error('Verification event has no admission');
    const receipt = await readCatalogueVerification({ fuseki }, admissionId);
    if (!receipt || receipt.outcome !== 'succeeded' || receipt.receipt !== value('receipt')
      || receipt.requestDigest !== value('digest') || receipt.authorityEpoch !== value('authorityEpoch')
      || receipt.scope !== value('scope') || receipt.dataEpoch !== batch.dataEpoch
      || receipt.sequence !== batch.sequence) throw new Error('Verification event differs from its receipt');
    return { specversion: '1.0', id: eventId, source: 'https://rezics.com/services/main',
      type: 'com.rezics.catalogue.verified.v1', datacontenttype: 'application/json',
      data: { batchId: batch.batchId, routingEpoch: batch.routingEpoch, ordinal,
        sourcePosition: { datasetId: 'product', dataEpoch: batch.dataEpoch, sequence: batch.sequence },
        receipt: { id: receipt.receipt, action: 'catalogue.verify', outcome: 'succeeded', admissionId,
          requestDigest: receipt.requestDigest, authorityEpoch: receipt.authorityEpoch, scope: receipt.scope, work: receipt.work } } };
  },
}] satisfies OwnerOutboxEventHandler[];
