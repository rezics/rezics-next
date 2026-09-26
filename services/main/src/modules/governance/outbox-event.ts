import { GRAPHS, RV, hash, iri } from '../work/activate.ts';
import type { OwnerOutboxEventHandler } from '../outbox/event-handlers.ts';

export const outboxEventHandlers: readonly OwnerOutboxEventHandler[] = [{
  kind: `${RV}ModerationEffectAcceptedEvent`, action: 'governance.moderation.apply',
  type: 'com.rezics.governance.moderation-effect-accepted.v1', authority: 'system',
  async read({ fuseki, batch, eventId, value, ordinal }) {
    const receipt = value('receipt'), digest = value('digest'), target = value('work');
    const effect = value('application');
    if (!receipt || !digest || !target || !effect || !value('operation')
      || value('eventApplication') !== effect
      || eventId !== `urn:rezics:event:${hash(effect)}`
      || batch.batchId !== `urn:rezics:outbox:${hash(receipt)}`) {
      throw new Error('moderation effect event differs from its receipt');
    }
    const proof = await fuseki.query(`PREFIX rv: <${RV}> ASK {
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(effect)} a rv:ModerationEffect ;
        rv:moderationTarget ${iri(target)} ; rv:moderationOperation ?decisionOperation . }
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} rv:requestDigest ${JSON.stringify(digest)} ;
        rv:outcome rv:Succeeded ; rv:moderationTarget ${iri(target)} ;
        rv:application ${iri(effect)} ; rv:operation ${iri(value('operation')!)} . }
    }`);
    if (proof.boolean !== true) throw new Error('moderation effect owner proof differs');
    return { specversion: '1.0', id: eventId, source: 'https://rezics.com/services/main',
      type: 'com.rezics.governance.moderation-effect-accepted.v1',
      datacontenttype: 'application/json',
      data: { batchId: batch.batchId,
        sourcePosition: { datasetId: 'product', dataEpoch: batch.dataEpoch, sequence: batch.sequence },
        routingEpoch: batch.routingEpoch, ordinal,
        receipt: { id: receipt, action: 'governance.moderation.apply', outcome: 'succeeded',
          requestDigest: digest, systemProof: { kind: 'moderation-effect-v1', target, effect } } },
    };
  },
}];
