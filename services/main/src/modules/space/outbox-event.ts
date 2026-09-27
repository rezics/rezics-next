import type { OwnerOutboxEventHandler } from '../outbox/event-handlers.ts';
import { GRAPHS, RV, hash, iri } from '../work/activate.ts';

/** Retain every visibility transition as a typed event. Recovery must prove
 * this effect before releasing its hold; an empty batch cannot carry it. */
export const outboxEventHandlers: readonly OwnerOutboxEventHandler[] = [{
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
}];
