import type { OwnerOutboxEventHandler, OwnerEventReceipt } from '../outbox/event-handlers.ts';
import { GRAPHS, RV, hash, iri } from '../work/activate.ts';

function nativeChildEvent(kind: 'NativeChildAdoptedEvent' | 'NativeChildRetiredEvent',
  type: 'com.rezics.work.native-child-adopted.v1' | 'com.rezics.work.native-child-retired.v1',
  suffix: 'native-child' | 'native-child-retired'): OwnerOutboxEventHandler {
  const retirement = kind === 'NativeChildRetiredEvent';
  return { kind: `${RV}${kind}`, action: 'work.edit', type,
    async read({ fuseki, batch, eventId, value, ordinal }) {
      const receipt = value('receipt'), work = value('work'), head = value('expectedHead');
      if (!receipt || !work || !head || value('action') !== 'work.edit'
        || value('outcome') !== `${RV}Succeeded` || !value('admissionId')
        || !value('digest') || !value('authorityEpoch')
        || value('scope') !== `work:edit:${work}` || value('workRevision') !== head
        || value('eventWork') !== work || value('epoch') !== batch.dataEpoch
        || value('sequence') !== batch.sequence
        || eventId !== `urn:rezics:event:${hash(`${receipt}\0${suffix}`)}`
        || batch.batchId !== `urn:rezics:outbox:${hash(receipt)}`) {
        throw new Error('native child event differs from its terminal receipt');
      }
      const proof = await fuseki.query(`PREFIX rv: <${RV}> SELECT ?child ?revision
        ${retirement ? '?reason' : '?intent'} WHERE {
        GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} rv:nativeChild ?child ;
          rv:nativeChildRevision ?revision ; ${retirement ? 'rv:retirementReason ?reason' : 'rv:sourceIntent ?intent'} . }
        GRAPH ${iri(GRAPHS.outbox)} { ${iri(eventId)} a rv:${kind} ; rv:ordinal ${ordinal} ;
          rv:action "work.edit" ; rv:work ${iri(work)} ; rv:receipt ${iri(receipt)} . }
        GRAPH ${iri(GRAPHS.current)} { ?child a rv:NativeChild ; rv:work ${iri(work)} ;
          rv:childRevision ?revision . ${retirement ? `?child rv:retiredBy ${iri(receipt)} .` : ''} }
        GRAPH ${iri(GRAPHS.revisions)} { ?revision a rv:NativeChildRevision ;
          rv:component ?child ; rv:work ${iri(work)} ; rv:workRevision ${iri(head)} . }
      } LIMIT 2`, 8192);
      const rows = proof.results?.bindings ?? [], row = rows[0];
      if (rows.length !== 1 || !row?.child || !row.revision
        || (retirement ? !row.reason : !row.intent)) {
        throw new Error('native child event effect is missing');
      }
      const graphReceipt: OwnerEventReceipt = { id: receipt, action: 'work.edit', outcome: 'succeeded',
        admissionId: value('admissionId')!, requestDigest: value('digest')!,
        authorityEpoch: value('authorityEpoch')!, scope: value('scope')!,
        work, workRevision: head, expectedHead: head, nativeChild: row.child.value,
        nativeChildRevision: row.revision.value,
        ...(retirement ? { retirementReason: row.reason!.value }
          : { sourceIntent: row.intent!.value }) };
      return { specversion: '1.0', id: eventId, source: 'https://rezics.com/services/main',
        type, datacontenttype: 'application/json', data: { batchId: batch.batchId,
          sourcePosition: { datasetId: 'product', dataEpoch: batch.dataEpoch,
            sequence: batch.sequence }, routingEpoch: batch.routingEpoch, ordinal,
          receipt: graphReceipt } };
    } };
}

/** One exact field-local revision, with the rights state kept distinct from edit control. */
export const outboxEventHandlers: readonly OwnerOutboxEventHandler[] = [{
  kind: `${RV}EditorialFieldControlEvent`, action: 'work.edit',
  type: 'com.rezics.work.editorial-field-controlled.v1',
  async read({ fuseki, batch, eventId, value, ordinal }) {
    const receipt = value('receipt');
    if (!receipt || value('action') !== 'work.edit'
      || value('admissionId') === undefined || value('digest') === undefined
      || value('authorityEpoch') === undefined || value('scope') === undefined
      || value('epoch') !== batch.dataEpoch || value('sequence') !== batch.sequence
      || value('outcome') !== `${RV}Succeeded`) {
      throw new Error('editorial field event differs from its terminal receipt');
    }
    const result = await fuseki.query(`PREFIX rv: <${RV}> SELECT ?work ?slot ?content ?control WHERE {
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} rv:work ?work ; rv:fieldSlot ?slot ;
        rv:fieldRevision ?content ; rv:fieldControl ?control . }
      GRAPH ${iri(GRAPHS.outbox)} { ${iri(eventId)} a rv:EditorialFieldControlEvent ;
        rv:action "work.edit" ; rv:work ?work ; rv:receipt ${iri(receipt)} . }
      GRAPH ${iri(GRAPHS.revisions)} { ?content a rv:EditorialFieldRevision ;
        rv:component ?slot ; rv:rightsStatus rv:Undetermined .
        ?control a rv:EditorialFieldControlRevision ; rv:component ?slot ; rv:fieldRevision ?content . }
    } LIMIT 2`, 8192);
    const rows = result.results?.bindings ?? [];
    if (rows.length !== 1 || !rows[0]?.work || !rows[0]?.slot
      || !rows[0]?.content || !rows[0]?.control) {
      throw new Error('editorial field event has no matching native revision');
    }
    const graphReceipt: OwnerEventReceipt = { id: receipt, action: 'work.edit', outcome: 'succeeded',
      admissionId: value('admissionId')!, requestDigest: value('digest')!,
      authorityEpoch: value('authorityEpoch')!, scope: value('scope')!,
      work: rows[0].work.value, fieldSlot: rows[0].slot.value,
      fieldRevision: rows[0].content.value, fieldControl: rows[0].control.value };
    return { specversion: '1.0', id: eventId, source: 'https://rezics.com/services/main',
      type: 'com.rezics.work.editorial-field-controlled.v1', datacontenttype: 'application/json',
      data: { batchId: batch.batchId,
        sourcePosition: { datasetId: 'product', dataEpoch: batch.dataEpoch,
          sequence: batch.sequence }, routingEpoch: batch.routingEpoch, ordinal,
        receipt: graphReceipt } };
  },
},
nativeChildEvent('NativeChildAdoptedEvent', 'com.rezics.work.native-child-adopted.v1', 'native-child'),
nativeChildEvent('NativeChildRetiredEvent', 'com.rezics.work.native-child-retired.v1', 'native-child-retired')];
