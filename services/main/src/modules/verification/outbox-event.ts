import { RV } from '../work/activate.ts';
import type { OwnerOutboxEventHandler } from '../outbox/event-handlers.ts';
import { ADMISSIONS, readReceipt, receiptIri, type Family } from './graph.ts';

const SOURCE = 'https://rezics.com/services/main' as const;
const RESULTS: Record<Family, readonly string[]> = {
  'claim-create': ['claim', 'claimRevision'],
  'reliability-assess': ['reliabilityScope', 'reliabilityRevision'],
  'claim-assess': ['assessment'],
};

function handler(family: Family, event: string, type: string,
  outcome: 'succeeded' | 'cancelled'): OwnerOutboxEventHandler {
  const action = ADMISSIONS[family].action;
  return {
    kind: `${RV}${event}`, action, type,
    async read({ fuseki, batch, eventId, value, ordinal }) {
      const admissionId = value('admissionId');
      const receiptId = value('receipt');
      const requestDigest = value('digest');
      const authorityEpoch = value('authorityEpoch');
      const scope = value('scope');
      const operation = value('operation');
      if (!admissionId || !/^[0-9a-f-]{36}$/.test(admissionId)
        || receiptId !== receiptIri(admissionId, family)
        || !/^[0-9a-f]{64}$/.test(requestDigest ?? '')
        || !/^[0-9]+$/.test(authorityEpoch ?? '')
        || scope !== ADMISSIONS[family].scope
        || value('epoch') !== batch.dataEpoch || value('sequence') !== batch.sequence
        || value('outcome') !== `${RV}${outcome === 'succeeded' ? 'Succeeded' : 'Cancelled'}`
        || (outcome === 'succeeded' && (!operation || value('eventOperation') !== operation))
        || (outcome === 'cancelled' && (operation || value('eventOperation')))) {
        throw new Error('verification event differs from its terminal receipt');
      }
      const terminal = await readReceipt({ fuseki }, admissionId, family, RESULTS[family]);
      if (!terminal || terminal.outcome !== outcome || terminal.receipt !== receiptId
        || terminal.requestDigest !== requestDigest || terminal.authorityEpoch !== authorityEpoch
        || terminal.scope !== scope || terminal.dataEpoch !== batch.dataEpoch
        || terminal.sequence !== batch.sequence) {
        throw new Error('verification event has no matching terminal receipt');
      }
      return { specversion: '1.0', id: eventId, source: SOURCE, type,
        datacontenttype: 'application/json',
        data: { batchId: batch.batchId, sourcePosition: { datasetId: 'product',
          dataEpoch: batch.dataEpoch, sequence: batch.sequence },
        routingEpoch: batch.routingEpoch, ordinal,
        receipt: { id: receiptId, action, outcome, admissionId, requestDigest,
          authorityEpoch, scope, ...terminal.result } } };
    },
  };
}

export const outboxEventHandlers: readonly OwnerOutboxEventHandler[] = [
  handler('claim-create', 'ClaimCreatedEvent', 'com.rezics.verification.claim-created.v1', 'succeeded'),
  handler('claim-create', 'ClaimCreationCancelledEvent', 'com.rezics.verification.claim-cancelled.v1', 'cancelled'),
  handler('reliability-assess', 'SourceReliabilityAssessedEvent',
    'com.rezics.verification.reliability-assessed.v1', 'succeeded'),
  handler('reliability-assess', 'SourceReliabilityAssessmentCancelledEvent',
    'com.rezics.verification.reliability-cancelled.v1', 'cancelled'),
  handler('claim-assess', 'ClaimAssessedEvent', 'com.rezics.verification.claim-assessed.v1', 'succeeded'),
  handler('claim-assess', 'ClaimAssessmentCancelledEvent',
    'com.rezics.verification.assessment-cancelled.v1', 'cancelled'),
];
