import type { OwnerOutboxEventHandler } from '../outbox/event-handlers.ts';
import { GRAPHS, RV, hash, iri } from '../work/activate.ts';

/** Retain every visibility transition as a typed event. Recovery must prove
 * this effect before releasing its hold; an empty batch cannot carry it. */
const realmPolicyEvent: OwnerOutboxEventHandler = {
  kind: `${RV}RealmPolicyChangedEvent`, action: 'realm.policy.publish',
  type: 'com.rezics.realm.policy-changed.v1', authority: 'system',
  async read({ fuseki, batch, eventId, value, ordinal }) {
    const receipt = value('receipt');
    const realm = value('realm');
    const space = value('space');
    if (!receipt || !/^urn:rezics:realm-policy:[0-9a-f-]{36}$/.test(receipt) || !realm || !space
      || value('eventRealm') !== realm || value('outcome') !== `${RV}Succeeded`
      || value('epoch') !== batch.dataEpoch || value('sequence') !== batch.sequence
      || eventId !== `urn:rezics:event:${hash(receipt)}` || !value('digest')) throw new Error('Realm policy event differs');
    const rows = (await fuseki.query(`PREFIX rv: <${RV}> SELECT ?visibility ?mode ?generation WHERE {
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} rv:visibility ?visibility ;
        rv:reviewMode ?mode ; rv:policyGeneration ?generation . }
    } LIMIT 2`, 2048)).results?.bindings ?? [];
    const row = rows[0];
    if (rows.length !== 1 || !['public','restricted','private'].includes(row?.visibility?.value ?? '')
      || !['mandatory','trusted-members','open'].includes(row?.mode?.value ?? '')
      || !/^\d+$/.test(row?.generation?.value ?? '')) throw new Error('Realm policy event is incomplete');
    return { specversion: '1.0', id: eventId, source: 'https://rezics.com/services/main',
      type: 'com.rezics.realm.policy-changed.v1', datacontenttype: 'application/json',
      data: { batchId: batch.batchId, routingEpoch: batch.routingEpoch, ordinal,
        sourcePosition: { datasetId: 'product', dataEpoch: batch.dataEpoch, sequence: batch.sequence },
        receipt: { id: receipt, action: 'realm.policy.publish', outcome: 'succeeded', requestDigest: value('digest')!,
          realm, space, visibility: row!.visibility!.value, reviewMode: row!.mode!.value,
          generation: row!.generation!.value, systemProof: { kind: 'realm-settings-receipt', receiptId: receipt.slice(-36) } } } };
  },
};

/** A site creation retains the same Space admission without inventing a Realm
 * for the legacy Realm-created event contract. */
export const zoneSpaceCreatedEvent: OwnerOutboxEventHandler = {
  kind: `${RV}ZoneSpaceCreatedEvent`, action: 'space.create', type: 'com.rezics.space.zone-created.v1',
  async read({ fuseki, batch, eventId, value, ordinal }) {
    const receipt = value('receipt'), operation = value('operation'), space = value('space');
    if (!receipt || !operation || !space || value('eventOperation') !== operation
      || value('eventSpace') !== space || value('outcome') !== `${RV}Succeeded`
      || eventId !== `urn:rezics:event:${hash(operation)}` || value('realm')
      || value('epoch') !== batch.dataEpoch || value('sequence') !== batch.sequence
      || !value('digest') || !value('admissionId') || !value('authorityEpoch') || !value('scope')) {
      throw new Error('Zone Space event differs from its receipt');
    }
    const rows = (await fuseki.query(`PREFIX rv: <${RV}>
      SELECT ?zone ?zoneRevision ?navigation ?navigationRevision ?spaceRevision ?owner WHERE {
        GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} rv:zone ?zone ; rv:zoneRevision ?zoneRevision ;
          rv:navigation ?navigation ; rv:navigationRevision ?navigationRevision ;
          rv:spaceRevision ?spaceRevision ; rv:owner ?owner . }
      } LIMIT 2`, 4096)).results?.bindings ?? [];
    const row = rows[0];
    if (rows.length !== 1 || !row?.zone || !row.zoneRevision || !row.navigation
      || !row.navigationRevision || !row.spaceRevision || !row.owner) {
      throw new Error('Zone Space event is incomplete');
    }
    return { specversion: '1.0', id: eventId, source: 'https://rezics.com/services/main',
      type: 'com.rezics.space.zone-created.v1', datacontenttype: 'application/json', data: {
        batchId: batch.batchId, routingEpoch: batch.routingEpoch, ordinal,
        sourcePosition: { datasetId: 'product', dataEpoch: batch.dataEpoch, sequence: batch.sequence },
        receipt: { id: receipt, action: 'space.create', outcome: 'succeeded', operation, space,
          capabilities: ['zone'], zone: row.zone.value, zoneRevision: row.zoneRevision.value,
          navigation: row.navigation.value, navigationRevision: row.navigationRevision.value,
          spaceRevision: row.spaceRevision.value, owner: row.owner.value,
          requestDigest: value('digest')!, admissionId: value('admissionId')!,
          authorityEpoch: value('authorityEpoch')!, scope: value('scope')!,
        },
      } };
  },
};
export const outboxEventHandlers: readonly OwnerOutboxEventHandler[] = [realmPolicyEvent, zoneSpaceCreatedEvent];
