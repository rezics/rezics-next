import { GRAPHS, RV, hash, iri } from '../work/activate.ts';
import type { OwnerOutboxEventHandler } from '../outbox/event-handlers.ts';
import { proposalReceiptIri } from './access.ts';

export const outboxEventHandlers: readonly OwnerOutboxEventHandler[] = [{
  kind: `${RV}ProposalExecutedEvent`, action: 'governance.proposal.execute',
  type: 'com.rezics.governance.proposal-executed.v1',
  async read({ fuseki, batch, eventId, value, ordinal }) {
    const admissionId = value('admissionId'), receipt = value('receipt');
    const operation = value('operation'), execution = value('application');
    const proposal = value('work'), digest = value('digest');
    if (!admissionId || !receipt || !operation || !execution || !proposal || !digest
      || receipt !== proposalReceiptIri(admissionId)
      || value('eventOperation') !== operation || value('eventApplication') !== execution
      || eventId !== `urn:rezics:event:${hash(operation)}`
      || batch.batchId !== `urn:rezics:outbox:${hash(receipt)}`
      || value('outcome') !== `${RV}Succeeded` || !value('authorityEpoch') || !value('scope')) {
      throw new Error('proposal execution event differs from its admission receipt');
    }
    const proof = await fuseki.query(`PREFIX rv: <${RV}> ASK {
      GRAPH ${iri(GRAPHS.current)} { ${iri(proposal)} rv:proposalState rv:ProposalExecuted ;
        rv:proposalExecution ${iri(execution)} . }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(execution)} a rv:ProposalExecution ;
        rv:operation ${iri(operation)} . }
    }`);
    if (proof.boolean !== true) throw new Error('proposal execution graph proof differs');
    return { specversion: '1.0', id: eventId, source: 'https://rezics.com/services/main',
      type: 'com.rezics.governance.proposal-executed.v1', datacontenttype: 'application/json',
      data: { batchId: batch.batchId,
        sourcePosition: { datasetId: 'product', dataEpoch: batch.dataEpoch, sequence: batch.sequence },
        routingEpoch: batch.routingEpoch, ordinal,
        receipt: { id: receipt, action: 'governance.proposal.execute', outcome: 'succeeded',
          admissionId, requestDigest: digest, authorityEpoch: value('authorityEpoch')!,
          scope: value('scope')!, proposal, execution, operation } },
    };
  },
}];
