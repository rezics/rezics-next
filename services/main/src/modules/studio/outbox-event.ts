import type { OwnerOutboxEventHandler } from '../outbox/event-handlers.ts';
import { compositionReceiptIri } from '../structure/change.ts';
import { GRAPHS, RV, hash, iri, lit } from '../work/activate.ts';

export const outboxEventHandlers = [{ kind: `${RV}StudioChapterCreatedEvent`,
  action: 'studio.chapter.create', type: 'com.rezics.studio.chapter-created.v1',
  read: async ({ fuseki, batch, eventId, value, ordinal }) => {
    const receipt = value('receipt');
    const admissionId = value('admissionId');
    const digest = value('digest');
    const work = value('eventWork');
    if (!receipt || !admissionId || !digest || !work
      || receipt !== compositionReceiptIri(admissionId)
      || value('action') !== 'studio.chapter.create'
      || value('outcome') !== `${RV}Succeeded`
      || value('epoch') !== batch.dataEpoch || value('sequence') !== batch.sequence
      || !value('authorityEpoch') || !value('scope')
      || batch.batchId !== `urn:rezics:outbox:${hash(receipt)}`
      || eventId !== `urn:rezics:event:${hash(`${receipt}\0chapter`)}`
      || ordinal !== 1 || batch.eventIds.length !== 2
      || batch.eventIds[0] !== `urn:rezics:event:${hash(`${receipt}\0structure`)}`
      || batch.eventIds[1] !== eventId) {
      throw new Error('Chapter event differs from its source position');
    }
    const rows = (await fuseki.query(`PREFIX rv: <${RV}>
      PREFIX schema: <https://schema.org/> SELECT ?structure ?revision ?main ?workRevision
        ?mainRevision WHERE {
      GRAPH ${iri(GRAPHS.outbox)} { ${iri(eventId)} a rv:StudioChapterCreatedEvent ;
        rv:ordinal 1 ; rv:action "studio.chapter.create" ; rv:receipt ${iri(receipt)} ;
        rv:work ${iri(work)} . }
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ;
        rv:action "composition.change" ; rv:outcome rv:Succeeded ;
        rv:admissionId ${lit(admissionId)} ; rv:requestDigest ${lit(digest)} ;
        rv:authorityEpoch ${lit(value('authorityEpoch')!)} ;
        rv:admittedScope ${lit(value('scope')!)} ;
        rv:dataEpoch ${lit(batch.dataEpoch)} ; rv:sequence ${batch.sequence} ;
        rv:structure ?structure ; rv:structureRevision ?revision ;
        rv:chapterWork ${iri(work)} ; rv:chapterMainVersion ?main ;
        rv:chapterWorkRevision ?workRevision ; rv:chapterMainRevision ?mainRevision ;
        rv:operation ?operation . }
      GRAPH ${iri(GRAPHS.current)} { ${iri(work)} a schema:CreativeWork ;
        rv:mainVersion ?main . ?main a rv:MainVersion ; rv:work ${iri(work)} . }
      GRAPH ${iri(GRAPHS.revisions)} {
        ?workRevision a rv:RevisionAnchor ; rv:component ${iri(work)} ; rv:operation ?operation .
        ?mainRevision a rv:RevisionAnchor ; rv:component ?main ; rv:operation ?operation .
      }
    } LIMIT 2`)).results?.bindings ?? [];
    const row = rows[0];
    if (rows.length !== 1 || !row?.structure || !row.revision || !row.main
      || !row.workRevision || !row.mainRevision) {
      throw new Error('Chapter event has no exact graph proof');
    }
    return { specversion: '1.0', id: eventId,
      source: 'https://rezics.com/services/main', type: 'com.rezics.studio.chapter-created.v1',
      datacontenttype: 'application/json', data: { batchId: batch.batchId,
        routingEpoch: batch.routingEpoch, ordinal,
        sourcePosition: { datasetId: 'product', dataEpoch: batch.dataEpoch,
          sequence: batch.sequence },
        receipt: { id: receipt, action: 'studio.chapter.create', outcome: 'succeeded',
          requestDigest: digest, admissionId, authorityEpoch: value('authorityEpoch')!,
          scope: value('scope')!, chapter: { work, mainVersion: row.main.value,
            workRevision: row.workRevision.value, mainRevision: row.mainRevision.value,
            structure: row.structure.value, compositionRevision: row.revision.value } } } };
  },
}] satisfies OwnerOutboxEventHandler[];
