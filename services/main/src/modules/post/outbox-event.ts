import type { OwnerOutboxEventHandler } from '../outbox/event-handlers.ts';
import { GRAPHS, RV, iri, lit } from '../work/activate.ts';
import { POST_BACKFILL_COST } from './backfill.ts';

export const outboxEventHandlers = [{ kind: `${RV}PostsMigratedEvent`, action: 'post.migrate',
  authority: 'system', type: 'com.rezics.post.migrated.v1',
  read: async ({ fuseki, batch, eventId, value, ordinal }) => {
    const receipt = value('receipt'), digest = value('digest');
    if (!receipt || !digest || !/^[0-9a-f]{64}$/.test(digest)
      || receipt !== `urn:rezics:receipt:chapter-post-backfill:${digest}`
      || eventId !== `urn:rezics:event:${digest}` || batch.batchId !== `urn:rezics:outbox:${digest}`
      || batch.eventIds.length !== 1 || batch.eventIds[0] !== eventId || ordinal !== 0
      || value('action') !== 'post.migrate' || value('outcome') !== `${RV}Succeeded`
      || value('epoch') !== batch.dataEpoch || value('sequence') !== batch.sequence) {
      throw new Error('Post migration event differs from its source');
    }
    const rows = (await fuseki.query(`PREFIX rv: <${RV}> SELECT ?post ?count WHERE {
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ;
        rv:requestDigest ${lit(digest)} ; rv:action "post.migrate" ; rv:outcome rv:Succeeded ;
        rv:dataEpoch ${lit(batch.dataEpoch)} ; rv:sequence ${batch.sequence} ;
        rv:migratedPost ?post ; rv:migratedPostCount ?count . }
    } LIMIT ${POST_BACKFILL_COST.batch + 1}`, 16 * 1024)).results?.bindings ?? [];
    if (!rows.length || rows.length > POST_BACKFILL_COST.batch
      || rows.some(row => !row.post || Number(row.count?.value) !== rows.length)
      || new Set(rows.map(row => row.post!.value)).size !== rows.length) {
      throw new Error('Post migration receipt inventory is invalid');
    }
    return { specversion: '1.0', id: eventId, source: 'https://rezics.com/services/main',
      type: 'com.rezics.post.migrated.v1', datacontenttype: 'application/json',
      data: { batchId: batch.batchId, routingEpoch: batch.routingEpoch, ordinal,
        sourcePosition: { datasetId: 'product', dataEpoch: batch.dataEpoch, sequence: batch.sequence },
        receipt: { id: receipt, action: 'post.migrate', outcome: 'succeeded', requestDigest: digest,
          systemProof: { kind: 'chapter-post-backfill-v1', posts: rows.map(row => row.post!.value) } } } };
  },
}] satisfies OwnerOutboxEventHandler[];
