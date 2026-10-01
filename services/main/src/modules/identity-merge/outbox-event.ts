import type { OwnerOutboxEventHandler } from '../outbox/event-handlers.ts';
import { GRAPHS, RV, hash, iri } from '../work/activate.ts';
import { itemCommandKey } from './contract.ts';

/** Mechanical identity delivery is authorized by the retained ordered
 * editorial application, rather than an ordinary personal edit admission. */
export const outboxEventHandlers: readonly OwnerOutboxEventHandler[] = [{
  kind: `${RV}WorkIdentityChangedEvent`,action: 'identity.merge',
  type: 'com.rezics.work.identity-changed.v1',authority: 'system',
  async read({ fuseki,batch,eventId,value,ordinal }) {
    const receipt = value('receipt');
    if (!receipt || ordinal !== 0 || batch.eventIds.length !== 1
      || batch.batchId !== `urn:rezics:outbox:${hash(receipt)}` || eventId !== `urn:rezics:event:${hash(receipt)}`
      || value('action') !== 'identity.merge' || value('outcome') !== `${RV}Succeeded`
      || value('epoch') !== batch.dataEpoch || value('sequence') !== batch.sequence) throw new Error('Identity event differs');
    const rows = (await fuseki.query(`PREFIX rv: <${RV}> SELECT ?task ?application ?source ?survivor ?sourceHead ?survivorHead ?operation WHERE {
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} rv:mergeTask ?task ; rv:editorialApplication ?application ;
        rv:sourceWork ?source ; rv:survivorWork ?survivor ; rv:sourceRevision ?sourceHead ; rv:survivorRevision ?survivorHead ; rv:mergeOperation ?operation }
    } LIMIT 2`,8192)).results?.bindings ?? [];
    const row = rows[0], task = row?.task?.value,application = row?.application?.value;
    const native = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
    if (rows.length !== 1 || !task || !/^editorial:[0-9a-f-]{36}:[1-9][0-9]*$/.test(task)
      || !/^[0-9a-f-]{36}$/.test(application ?? '') || !['merge','unmerge'].includes(row?.operation?.value ?? '')
      || ![row?.source,row?.survivor,row?.sourceHead,row?.survivorHead].every(field => native.test(field?.value ?? ''))
      || receipt !== `urn:rezics:receipt:identity-merge:${itemCommandKey(task,'identity-merge','$stage').slice(6)}`
      || !/^[0-9a-f]{64}$/.test(value('digest') ?? '')) throw new Error('Identity receipt is incomplete');
    return { specversion: '1.0',id: eventId,source: 'https://rezics.com/services/main',
      type: 'com.rezics.work.identity-changed.v1',datacontenttype: 'application/json',
      data: { batchId: batch.batchId,routingEpoch: batch.routingEpoch,ordinal,
        sourcePosition: { datasetId: 'product',dataEpoch: batch.dataEpoch,sequence: batch.sequence },
        receipt: { id: receipt,action: 'identity.merge',outcome: 'succeeded',requestDigest: value('digest')!,
          work: row!.source!.value,survivor: row!.survivor!.value,operation: row!.operation!.value,
          sourceRevision: row!.sourceHead!.value,survivorRevision: row!.survivorHead!.value,
          systemProof: { kind: 'reviewed-identity-merge',application,task } } } };
  },
}];
