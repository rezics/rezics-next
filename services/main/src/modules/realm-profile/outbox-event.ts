import type { OwnerOutboxEventHandler } from '../outbox/event-handlers.ts';
import { GRAPHS, RV, iri, lit } from '../work/activate.ts';

function handler(action: 'realm.profile.publish' | 'realm.moderator.choose',
  kind: 'RealmPublicProfilePublishedEvent' | 'RealmModeratorPublicChoiceChangedEvent',
  type: string, revisionClass: string): OwnerOutboxEventHandler {
  return { action, kind: `${RV}${kind}`, type, read: async ({ fuseki, batch, eventId, value, ordinal }) => {
    const receipt = value('receipt');
    const realm = value('realm');
    const operation = value('operation');
    if (!receipt || !realm || !operation || value('eventRealm') !== realm
      || value('eventOperation') !== operation || value('outcome') !== `${RV}Succeeded`
      || !value('admissionId') || !value('digest') || !value('authorityEpoch') || !value('scope')
      || value('reason') || value('epoch') !== batch.dataEpoch
      || value('sequence') !== batch.sequence) {
      throw new Error('Realm profile event differs from terminal receipt');
    }
    const rows = (await fuseki.query(`PREFIX rv: <${RV}> SELECT ?revision ?component WHERE {
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} rv:realm ${iri(realm)} ;
        rv:profileRevision ?revision ; rv:operation ${iri(operation)} . }
      GRAPH ${iri(GRAPHS.outbox)} { ${iri(eventId)} a rv:${kind} ;
        rv:action ${lit(action)} ; rv:receipt ${iri(receipt)} ;
        rv:operation ${iri(operation)} ; rv:realm ${iri(realm)} . }
      GRAPH ${iri(GRAPHS.revisions)} { ?revision a rv:${revisionClass} ;
        rv:component ?component ; rv:operation ${iri(operation)} ;
        rv:dataEpoch ${lit(batch.dataEpoch)} ; rv:sequence ${batch.sequence} . }
      ${action === 'realm.profile.publish'
        ? `FILTER(?component = ${iri(realm)})`
        : `GRAPH ${iri(GRAPHS.current)} { ?component a rv:RealmModeratorPublicChoice ;
            rv:realm ${iri(realm)} . }`}
    } LIMIT 2`)).results?.bindings ?? [];
    if (rows.length !== 1 || !rows[0]?.revision || !rows[0].component) {
      throw new Error('Realm profile event revision is unavailable');
    }
    return { specversion: '1.0', id: eventId, source: 'https://rezics.com/services/main',
      type, datacontenttype: 'application/json', data: { batchId: batch.batchId,
        sourcePosition: { datasetId: 'product', dataEpoch: batch.dataEpoch,
          sequence: batch.sequence }, routingEpoch: batch.routingEpoch, ordinal,
        receipt: { id: receipt, action, outcome: 'succeeded',
          admissionId: value('admissionId')!, requestDigest: value('digest')!,
          authorityEpoch: value('authorityEpoch')!, scope: value('scope')!,
          realm, revision: rows[0].revision.value } } };
  } };
}

export const outboxEventHandlers = [
  handler('realm.profile.publish', 'RealmPublicProfilePublishedEvent',
    'com.rezics.realm.profile-published.v1', 'RealmPublicProfileRevision'),
  handler('realm.moderator.choose', 'RealmModeratorPublicChoiceChangedEvent',
    'com.rezics.realm.public-moderator-choice.v1', 'RealmModeratorChoiceRevision'),
];
