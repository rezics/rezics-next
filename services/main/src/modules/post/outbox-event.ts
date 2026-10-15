import type { OwnerOutboxEventHandler } from '../outbox/event-handlers.ts';
import { GRAPHS, RV, hash, iri, lit } from '../work/activate.ts';
import { workReceiptIri } from '../work/receipt.ts';
import { derivedId } from '../structure/graph.ts';
import { POST_BACKFILL_COST } from './backfill.ts';

export const outboxEventHandlers = [{ kind: `${RV}PostCreatedEvent`, action: 'work.create',
  type: 'com.rezics.post.created.v1',
  read: async ({ fuseki, batch, eventId, value, ordinal }) => {
    const receipt = value('receipt'), admissionId = value('admissionId'), digest = value('digest');
    const authorityEpoch = value('authorityEpoch'), scope = value('scope');
    if (!receipt || !admissionId || !digest || !authorityEpoch || scope !== 'work:create:root'
      || receipt !== workReceiptIri(admissionId)
      || value('action') !== 'work.create' || value('outcome') !== `${RV}Succeeded`
      || value('epoch') !== batch.dataEpoch || value('sequence') !== batch.sequence
      || batch.batchId !== `urn:rezics:outbox:${hash(receipt)}`
      || eventId !== `urn:rezics:event:${hash(`${receipt}\0post`)}`
      || ordinal !== 0 || batch.eventIds.length !== 1 || batch.eventIds[0] !== eventId)
      throw new Error('Post creation event differs from its source position');
    const post = derivedId(`${admissionId}\0post`), revision = derivedId(`${admissionId}\0post-head`);
    const rows = (await fuseki.query(`PREFIX rv: <${RV}> SELECT ?publisher WHERE {
      GRAPH ${iri(GRAPHS.outbox)} { ${iri(eventId)} a rv:PostCreatedEvent ; rv:ordinal 0 ;
        rv:action "work.create" ; rv:receipt ${iri(receipt)} ; rv:post ${iri(post)} . }
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ;
        rv:action "work.create" ; rv:outcome rv:Succeeded ; rv:admissionId ${lit(admissionId)} ;
        rv:requestDigest ${lit(digest)} ; rv:authorityEpoch ${lit(authorityEpoch)} ;
        rv:admittedScope ${lit(scope)} ; rv:dataEpoch ${lit(batch.dataEpoch)} ; rv:sequence ${batch.sequence} ;
        rv:work ${iri(post)} ; rv:workRevision ${iri(revision)} ; rv:author ?publisher ; rv:operation ?operation . }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} a rv:RevisionAnchor ;
        rv:component ${iri(post)} ; rv:operation ?operation ; rv:dataEpoch ${lit(batch.dataEpoch)} ;
        rv:sequence ${batch.sequence} . }
    } LIMIT 2`)).results?.bindings ?? [];
    if (rows.length !== 1 || rows[0]?.publisher?.type !== 'uri')
      throw new Error('Post creation event has no exact graph proof');
    return { specversion: '1.0', id: eventId, source: 'https://rezics.com/services/main',
      type: 'com.rezics.post.created.v1', datacontenttype: 'application/json',
      data: { batchId: batch.batchId, routingEpoch: batch.routingEpoch, ordinal,
        sourcePosition: { datasetId: 'product', dataEpoch: batch.dataEpoch, sequence: batch.sequence },
        receipt: { id: receipt, action: 'work.create', outcome: 'succeeded', requestDigest: digest,
          admissionId, authorityEpoch, scope, post: { id: post, revision, publisher: rows[0].publisher.value } } } };
  },
}, { kind: `${RV}PostsMigratedEvent`, action: 'post.migrate',
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
