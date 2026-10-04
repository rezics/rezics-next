import type { OwnerOutboxEventHandler } from '../outbox/event-handlers.ts';
import { compositionReceiptIri } from '../structure/change.ts';
import { GRAPHS, RV, hash, iri, lit } from '../work/activate.ts';

export const outboxEventHandlers = [{ kind: `${RV}StudioChapterCreatedEvent`,
  action: 'studio.chapter.create', type: 'com.rezics.studio.chapter-created.v1',
  read: async ({ fuseki, batch, eventId, value, ordinal }) => {
    const receipt = value('receipt'), admissionId = value('admissionId'), digest = value('digest');
    const eventWork = value('eventWork'), scope = value('scope');
    if (!receipt || !admissionId || !digest || !eventWork || !scope
      || receipt !== compositionReceiptIri(admissionId)
      || value('action') !== 'studio.chapter.create' || value('outcome') !== `${RV}Succeeded`
      || value('epoch') !== batch.dataEpoch || value('sequence') !== batch.sequence
      || !value('authorityEpoch') || !scope.startsWith('work:edit:')
      || batch.batchId !== `urn:rezics:outbox:${hash(receipt)}`
      || eventId !== `urn:rezics:event:${hash(`${receipt}\0chapter`)}`
      || ordinal !== 1 || batch.eventIds.length !== 2
      || batch.eventIds[0] !== `urn:rezics:event:${hash(`${receipt}\0structure`)}`
      || batch.eventIds[1] !== eventId) throw new Error('Chapter event differs from its source position');
    const book = scope.slice('work:edit:'.length);
    const rows = (await fuseki.query(`PREFIX rv: <${RV}>
      SELECT ?structure ?revision ?post ?postRevision WHERE {
      GRAPH ${iri(GRAPHS.outbox)} { ${iri(eventId)} a rv:StudioChapterCreatedEvent ;
        rv:ordinal 1 ; rv:action "studio.chapter.create" ; rv:receipt ${iri(receipt)} ;
        rv:work ${iri(eventWork)} .
        OPTIONAL { ${iri(eventId)} rv:post ?eventPost }
      }
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ;
        rv:action "composition.change" ; rv:outcome rv:Succeeded ;
        rv:admissionId ${lit(admissionId)} ; rv:requestDigest ${lit(digest)} ;
        rv:authorityEpoch ${lit(value('authorityEpoch')!)} ; rv:admittedScope ${lit(scope)} ;
        rv:dataEpoch ${lit(batch.dataEpoch)} ; rv:sequence ${batch.sequence} ;
        rv:structure ?structure ; rv:structureRevision ?revision ;
        (rv:post|rv:chapterWork) ?post ; (rv:postRevision|rv:chapterWorkRevision) ?postRevision ;
        rv:operation ?operation . }
      FILTER(IF(BOUND(?eventPost), ?eventPost = ?post && ${iri(eventWork)} = ${iri(book)},
        ?post = ${iri(eventWork)}))
      GRAPH ${iri(GRAPHS.revisions)} {
        ?postRevision a rv:RevisionAnchor ; rv:component ?post ; rv:operation ?operation .
      }
    } LIMIT 2`)).results?.bindings ?? [];
    const row = rows[0];
    if (rows.length !== 1 || !row?.structure || !row.revision || !row.post || !row.postRevision) {
      throw new Error('Chapter event has no exact graph proof');
    }
    return { specversion: '1.0', id: eventId, source: 'https://rezics.com/services/main',
      type: 'com.rezics.studio.chapter-created.v1', datacontenttype: 'application/json',
      data: { batchId: batch.batchId, routingEpoch: batch.routingEpoch, ordinal,
        sourcePosition: { datasetId: 'product', dataEpoch: batch.dataEpoch, sequence: batch.sequence },
        receipt: { id: receipt, action: 'studio.chapter.create', outcome: 'succeeded',
          requestDigest: digest, admissionId, authorityEpoch: value('authorityEpoch')!, scope,
          chapter: { post: row.post.value, revision: row.postRevision.value, book,
            structure: row.structure.value, compositionRevision: row.revision.value } } } };
  },
}] satisfies OwnerOutboxEventHandler[];
