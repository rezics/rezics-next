import type { OwnerOutboxEventHandler } from '../outbox/event-handlers.ts';
import { DATASET, GRAPHS, RV, hash, iri, lit } from '../work/activate.ts';
import { replyReceiptIri, replySlotIri } from './graph.ts';

const profile = 'https://rezics.com/definition/realm-reply-placement-v1';
const native = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const digest = /^[0-9a-f]{64}$/;
const revisionPrefix = 'urn:rezics:content:revision:';
const reviewPrefix = 'urn:rezics:realm-review:';

/** One receipt-keyed immutable proof, at most two rows and 16 KiB. Historical
 * delivery must survive a newer placement, review revocation or body erasure;
 * the event records the accepted decision, not present reading authority. */
export const outboxEventHandlers: readonly OwnerOutboxEventHandler[] = [{
  kind: `${RV}RealmReplyPlacedEvent`, action: 'reply.place',
  type: 'com.rezics.realm.reply-placed.v1',
  read: async ({ fuseki, batch, eventId, value, ordinal }) => {
    const receipt = value('receipt');
    const admissionId = value('admissionId');
    const realm = value('realm');
    if (!receipt || !admissionId || !realm || !native.test(realm)
      || receipt !== replyReceiptIri({ id: admissionId, action: 'reply.place' })
      || value('outcome') !== `${RV}Succeeded` || value('reason')
      || value('scope') !== `reply:place:${realm}` || value('eventRealm') !== realm
      || value('epoch') !== batch.dataEpoch || value('sequence') !== batch.sequence
      || !/^[1-9][0-9]*$/.test(batch.sequence)
      || ordinal !== 0 || batch.eventIds.length !== 1 || batch.eventIds[0] !== eventId
      || batch.batchId !== `urn:rezics:outbox:${hash(receipt)}`) {
      throw new Error('Realm reply event differs from its terminal receipt');
    }
    const rows = (await fuseki.query(`PREFIX rv: <${RV}> SELECT
      ?placement ?slot ?reply ?root ?rootRevision ?author ?actor ?revision ?bytes
      ?preparation ?ownerEpoch ?ownerSequence ?review ?reviewDigest
      ?expectedHead ?previous ?parent ?parentRevision ?context WHERE {
      GRAPH ${iri(GRAPHS.outbox)} { ${iri(eventId)} a rv:RealmReplyPlacedEvent ;
        rv:ordinal 0 ; rv:action "reply.place" ; rv:receipt ${iri(receipt)} ;
        rv:realm ${iri(realm)} ; rv:reply ?reply . }
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ;
        rv:outcome rv:Succeeded ; rv:realm ${iri(realm)} ; rv:reply ?reply ;
        rv:placement ?placement ; rv:contentRevision ?revision ; rv:byteDigest ?bytes ;
        rv:contentPreparation ?preparation ; rv:ownerDataEpoch ?ownerEpoch ;
        rv:ownerSequence ?ownerSequence ; rv:datasetId ${iri(DATASET)} ;
        rv:dataEpoch ${lit(batch.dataEpoch)} ; rv:sequence ${batch.sequence} .
        OPTIONAL { ${iri(receipt)} rv:expectedHead ?expectedHead } }
      GRAPH ${iri(GRAPHS.revisions)} { ?placement a rv:RealmReplyPlacement ;
        rv:component ?slot ; rv:realm ${iri(realm)} ; rv:reply ?reply ;
        rv:rootTarget ?root ; rv:rootRevision ?rootRevision ; rv:author ?author ;
        rv:contentRevision ?revision ; rv:contentDigest ?bytes ; rv:byteDigest ?bytes ;
        rv:contentPreparation ?preparation ; rv:ownerDataEpoch ?ownerEpoch ;
        rv:ownerSequence ?ownerSequence ; rv:reviewDecision ?review ; rv:reviewDigest ?reviewDigest ;
        rv:placementOutcome rv:Accepted ; rv:decidedBy ?actor ;
        rv:modelRevision ${iri(profile)} ; rv:shapeRevision ${iri(profile)} ;
        rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(batch.dataEpoch)} ;
        rv:sequence ${batch.sequence} .
        OPTIONAL { ?placement rv:previousPlacement ?previous }
        OPTIONAL { ?placement rv:parentReply ?parent }
        OPTIONAL { ?placement rv:parentRevision ?parentRevision }
        OPTIONAL { ?placement rv:contextRevision ?context } }
    } LIMIT 2`, 16 * 1024)).results?.bindings ?? [];
    const row = rows[0];
    const field = (key: string) => row?.[key]?.value ?? '';
    if (rows.length !== 1 || !['placement', 'reply', 'root', 'author', 'actor']
      .every(key => native.test(field(key)))
      || !field('rootRevision') || field('rootRevision').length > 300
      || field('slot') !== replySlotIri(realm, field('reply'))
      || eventId !== `urn:rezics:event:${hash(field('placement'))}`
      || !field('revision').startsWith(revisionPrefix)
      || !uuid.test(field('revision').slice(revisionPrefix.length))
      || !field('review').startsWith(reviewPrefix)
      || !uuid.test(field('review').slice(reviewPrefix.length))
      || !digest.test(field('bytes')) || !digest.test(field('reviewDigest'))
      || field('preparation') !== admissionId || !uuid.test(field('ownerEpoch'))
      || !/^[1-9][0-9]*$/.test(field('ownerSequence'))
      || field('revision') !== value('contentRevision')
      || field('ownerEpoch') !== value('ownerDataEpoch')
      || field('ownerSequence') !== value('ownerSequence')
      || field('expectedHead') !== field('previous')
      || field('expectedHead') !== (value('expectedHead') ?? '')
      || (field('previous') !== '' && !native.test(field('previous')))
      || (!!field('parent') !== !!field('parentRevision'))
      || (field('parent') !== '' && (!native.test(field('parent')) || !uuid.test(field('parentRevision'))))
      || (field('context') !== '' && !native.test(field('context')))) {
      throw new Error('Realm reply event has no unique placement proof');
    }
    return { specversion: '1.0', id: eventId, source: 'https://rezics.com/services/main',
      type: 'com.rezics.realm.reply-placed.v1', datacontenttype: 'application/json',
      data: { batchId: batch.batchId, routingEpoch: batch.routingEpoch, ordinal,
        sourcePosition: { datasetId: 'product', dataEpoch: batch.dataEpoch, sequence: batch.sequence },
        receipt: { id: receipt, action: 'reply.place', outcome: 'succeeded', admissionId,
          requestDigest: value('digest')!, authorityEpoch: value('authorityEpoch')!, scope: value('scope')!,
          realm, reply: field('reply'), placement: field('placement'), slot: field('slot'),
          rootTarget: field('root'), rootRevision: field('rootRevision'), author: field('author'),
          decidedBy: field('actor'), contentRevision: field('revision'), byteDigest: field('bytes'),
          contentPreparation: field('preparation'), ownerDataEpoch: field('ownerEpoch'),
          ownerSequence: field('ownerSequence'), reviewDecision: field('review'), reviewDigest: field('reviewDigest'),
          ...(field('previous') ? { expectedHead: field('previous') } : {}),
          ...(field('parent') ? { parentReply: field('parent'), parentRevision: field('parentRevision') } : {}),
          ...(field('context') ? { contextRevision: field('context') } : {}) } } };
  },
}];
