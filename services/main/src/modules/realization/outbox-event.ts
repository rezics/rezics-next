import type { OwnerOutboxEventHandler } from '../outbox/event-handlers.ts';
import { RV } from '../work/activate.ts';
import { readRealizationReceipt } from './command.ts';

export const outboxEventHandlers = [{
  kind: `${RV}RealizationChangedEvent`, action: 'work.edit', type: 'com.rezics.realization.changed.v1',
  read: async ({ fuseki, batch, eventId, value, ordinal }) => {
    const admissionId = value('admissionId');
    if (!admissionId) throw new Error('Realization event has no admission');
    const receipt = await readRealizationReceipt({ fuseki }, admissionId);
    if (!receipt || receipt.outcome !== 'succeeded' || value('receipt') !== receipt.receipt
      || value('digest') !== receipt.requestDigest || value('scope') !== receipt.scope
      || value('authorityEpoch') !== receipt.authorityEpoch) throw new Error('Realization event differs from its receipt');
    return { specversion: '1.0', id: eventId, source: 'https://rezics.com/services/main',
      type: 'com.rezics.realization.changed.v1', datacontenttype: 'application/json',
      data: { batchId: batch.batchId, routingEpoch: batch.routingEpoch, ordinal,
        sourcePosition: { datasetId: 'product', dataEpoch: batch.dataEpoch, sequence: batch.sequence },
        receipt: { id: receipt.receipt, action: 'work.edit', outcome: 'succeeded', admissionId,
          requestDigest: receipt.requestDigest, authorityEpoch: receipt.authorityEpoch, scope: receipt.scope,
          work: receipt.work, realization: receipt.realization, revision: receipt.revision } } };
  },
}] satisfies OwnerOutboxEventHandler[];
