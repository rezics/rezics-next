import type { OwnerOutboxEventHandler } from '../outbox/event-handlers.ts';
import { GRAPHS, RV, hash, iri, lit } from './activate.ts';
import { workEditReceiptIri } from './edit.ts';
import { readMetadataReceipt } from './metadata-command.ts';
import { checkedMetadataState, metadataComponent, METADATA_PROFILE } from './metadata-schema.ts';

export const outboxEventHandlers = [{ kind: `${RV}WorkMetadataChangedEvent`, action: 'work.edit',
  type: 'com.rezics.work.metadata-changed.v1',
  read: async ({ fuseki, batch, eventId, value, ordinal }) => {
    const admissionId = value('admissionId');
    if (!admissionId) throw new Error('Metadata event has no admission');
    const receipt = await readMetadataReceipt({ fuseki }, admissionId);
    if (!receipt || receipt.outcome !== 'succeeded' || value('receipt') !== receipt.receipt
      || receipt.receipt !== workEditReceiptIri(admissionId)
      || value('action') !== 'work.edit' || value('outcome') !== `${RV}Succeeded`
      || value('digest') !== receipt.requestDigest || value('authorityEpoch') !== receipt.authorityEpoch
      || value('scope') !== receipt.scope || receipt.dataEpoch !== batch.dataEpoch || receipt.sequence !== batch.sequence
      || batch.batchId !== `urn:rezics:outbox:${hash(receipt.receipt)}`
      || eventId !== `urn:rezics:event:${hash(receipt.receipt)}` || ordinal !== 0 || batch.eventIds.length !== 1) {
      throw new Error('Metadata event differs from its terminal receipt');
    }
    const rows = (await fuseki.query(`PREFIX rv: <${RV}> SELECT ?manifest ?state WHERE {
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt.receipt)} rv:commandFamily "work-metadata-details-v1" }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(receipt.revision!)} a rv:WorkMetadataRevision ;
        rv:component ${iri(receipt.component!)} ; rv:manifest ?manifest ; rv:metadataState ?state ;
        rv:modelRevision ${iri(METADATA_PROFILE)} ; rv:shapeRevision ${iri(METADATA_PROFILE)} ;
        rv:dataEpoch ${lit(batch.dataEpoch)} ; rv:sequence ${batch.sequence} }
      GRAPH ${iri(GRAPHS.outbox)} { ${iri(eventId)} a rv:WorkMetadataChangedEvent ;
        rv:ordinal 0 ; rv:action "work.edit" ; rv:receipt ${iri(receipt.receipt)} }
    } LIMIT 2`, 512 * 1024)).results?.bindings ?? [];
    if (rows.length !== 1 || !rows[0]?.manifest || !rows[0].state) throw new Error('Metadata event revision is incomplete');
    const state = checkedMetadataState(JSON.parse(rows[0].state.value));
    if (metadataComponent(receipt.work!, state) !== receipt.component
      || !/^urn:rezics:sha256:[0-9a-f]{64}$/.test(rows[0].manifest.value)) {
      throw new Error('Metadata event payload differs from its component');
    }
    return { specversion: '1.0', id: eventId, source: 'https://rezics.com/services/main',
      type: 'com.rezics.work.metadata-changed.v1', datacontenttype: 'application/json',
      data: { batchId: batch.batchId, routingEpoch: batch.routingEpoch, ordinal,
        sourcePosition: { datasetId: 'product', dataEpoch: batch.dataEpoch, sequence: batch.sequence },
        receipt: { id: receipt.receipt, action: 'work.edit', outcome: receipt.outcome,
          admissionId, requestDigest: receipt.requestDigest, authorityEpoch: receipt.authorityEpoch,
          scope: receipt.scope, metadata: { work: receipt.work, component: receipt.component,
            revision: receipt.revision, manifest: rows[0].manifest.value } } } };
  },
}] satisfies OwnerOutboxEventHandler[];
