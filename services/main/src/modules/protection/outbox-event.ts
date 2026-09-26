import type { OwnerOutboxEventHandler } from '../outbox/event-handlers.ts';
import { RV } from '../work/activate.ts';
import { protectionReceiptIri, type WorkProtectionAdmissionAction } from './receipt-family.ts';
import { readWorkProtectionReceipt } from './work.ts';
import { captureWorkProtectionEffect } from './recovery-evidence.ts';

const SOURCE = 'https://rezics.com/services/main' as const;

function handler(action: WorkProtectionAdmissionAction, kind: string, type: string,
  outcome: 'succeeded' | 'cancelled'): OwnerOutboxEventHandler {
  return { kind: `${RV}${kind}`, action, type,
    async read({ fuseki, batch, eventId, value, ordinal }) {
      const admissionId = value('admissionId');
      const receipt = value('receipt');
      const digest = value('digest');
      const epoch = value('authorityEpoch');
      const scope = value('scope');
      const prefix = action.startsWith('work.protection.') ? 'work:protect:'
        : action === 'work.correction.propose' ? 'work:correct:' : 'work:review:';
      if (!admissionId || !/^[0-9a-f-]{36}$/.test(admissionId)
        || receipt !== protectionReceiptIri(admissionId, action)
        || !/^[0-9a-f]{64}$/.test(digest ?? '') || !/^[0-9]+$/.test(epoch ?? '')
        || !scope?.startsWith(prefix) || value('action') !== action
        || value('outcome') !== `${RV}${outcome === 'succeeded' ? 'Succeeded' : 'Cancelled'}`
        || value('epoch') !== batch.dataEpoch || value('sequence') !== batch.sequence) {
        throw new Error('Work protection event differs from its receipt');
      }
      const terminal = await readWorkProtectionReceipt({ fuseki }, admissionId, action);
      if (!terminal || terminal.outcome !== outcome || terminal.receipt !== receipt
        || terminal.requestDigest !== digest || terminal.authorityEpoch !== epoch
        || terminal.scope !== scope || terminal.dataEpoch !== batch.dataEpoch
        || terminal.sequence !== batch.sequence
        || (outcome === 'succeeded' && terminal.work !== scope.slice(prefix.length))) {
        throw new Error('Work protection event has no exact terminal receipt');
      }
      const recovery = outcome === 'succeeded' && terminal.operation
        ? await captureWorkProtectionEffect(fuseki, terminal.operation, receipt, batch.batchId, eventId)
        : undefined;
      return { specversion: '1.0', id: eventId, source: SOURCE, type,
        datacontenttype: 'application/json', data: { batchId: batch.batchId,
          sourcePosition: { datasetId: 'product', dataEpoch: batch.dataEpoch, sequence: batch.sequence },
          routingEpoch: batch.routingEpoch, ordinal,
          ...(recovery ? { recovery } : {}),
          receipt: { id: receipt, action, outcome, admissionId, requestDigest: digest,
            authorityEpoch: epoch!, scope, ...(terminal.work ? { work: terminal.work } : {}),
            ...(terminal.protectionRevision ? { protectionRevision: terminal.protectionRevision } : {}),
            ...(terminal.proposalRevision ? { proposalRevision: terminal.proposalRevision } : {}),
            ...(terminal.decision ? { decision: terminal.decision } : {}),
            ...(terminal.reviewOutcome ? { reviewOutcome: terminal.reviewOutcome } : {}),
            ...(terminal.workRevision ? { workRevision: terminal.workRevision } : {}),
            ...(terminal.control ? { control: terminal.control } : {}),
            ...(terminal.operation ? { operation: terminal.operation } : {}) } } };
    } };
}

export const outboxEventHandlers: readonly OwnerOutboxEventHandler[] = [
  handler('work.protection.tighten', 'WorkProtectionTightenedEvent', 'com.rezics.protection.work-tightened.v1', 'succeeded'),
  handler('work.protection.tighten', 'WorkProtectionTighteningCancelledEvent', 'com.rezics.protection.work-tightening-cancelled.v1', 'cancelled'),
  handler('work.protection.confirm', 'WorkProtectionConfirmedEvent', 'com.rezics.protection.work-confirmed.v1', 'succeeded'),
  handler('work.protection.confirm', 'WorkProtectionConfirmationCancelledEvent', 'com.rezics.protection.work-confirmation-cancelled.v1', 'cancelled'),
  handler('work.protection.relax', 'WorkProtectionRelaxedEvent', 'com.rezics.protection.work-relaxed.v1', 'succeeded'),
  handler('work.protection.relax', 'WorkProtectionRelaxationCancelledEvent', 'com.rezics.protection.work-relaxation-cancelled.v1', 'cancelled'),
  handler('work.correction.propose', 'WorkCorrectionProposedEvent', 'com.rezics.protection.work-correction-proposed.v1', 'succeeded'),
  handler('work.correction.propose', 'WorkCorrectionProposalCancelledEvent', 'com.rezics.protection.work-correction-proposal-cancelled.v1', 'cancelled'),
  handler('work.correction.review', 'WorkCorrectionReviewedEvent', 'com.rezics.protection.work-correction-reviewed.v1', 'succeeded'),
  handler('work.correction.review', 'WorkCorrectionReviewCancelledEvent', 'com.rezics.protection.work-correction-review-cancelled.v1', 'cancelled'),
];
