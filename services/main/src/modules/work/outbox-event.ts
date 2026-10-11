import type { OwnerCloudEvent, OwnerOutboxEventHandler } from '../outbox/event-handlers.ts';
import { GRAPHS, RV, hash, iri, lit } from './activate.ts';
import { workEditReceiptIri } from './edit.ts';
import { readMetadataReceipt } from './metadata-command.ts';
import { checkedMetadataState, metadataComponent, METADATA_PROFILE } from './metadata-schema.ts';
import { readWorkStructurePublicationReceipt, workStructurePublicationReceiptIri,
  type WorkStructurePublicationAction } from './structured-publication.ts';
import { structureIri } from '../structure/graph.ts';

const publicationNativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const publicationRoot = /^urn:rezics:sha256:[0-9a-f]{64}$/;

function workPublicationEvent(action: WorkStructurePublicationAction, kind: string, type: string): OwnerOutboxEventHandler {
  return { kind: `${RV}${kind}`, action, type,
    read: async ({ fuseki, batch, eventId, value, ordinal }) => {
      const id = value('receipt');
      const work = value('eventWork');
      const decision = value('eventPublicationDecision');
      if (!id || !work || !publicationNativeId.test(work) || value('action') !== action
        || eventId !== `urn:rezics:event:${hash(id)}`
        || batch.batchId !== `urn:rezics:outbox:${hash(id)}`
        || batch.eventIds.length !== 1 || ordinal !== 0 || batch.eventIds[0] !== eventId) {
        throw new Error('Work publication event identity differs from its batch');
      }
      const admissionRows = (await fuseki.query(`PREFIX rv: <${RV}> SELECT ?admission WHERE {
        GRAPH ${iri(GRAPHS.receipts)} { ${iri(id)} rv:commandFamily ${lit(action === 'work.publish'
          ? 'work-structure-publication-v1' : 'work-structure-withdrawal-v1')} ;
          rv:action ${lit(action)} ; rv:admissionId ?admission ; rv:dataEpoch ${lit(batch.dataEpoch)} ;
          rv:sequence ${batch.sequence} . }
        GRAPH ${iri(GRAPHS.outbox)} { ${iri(eventId)} a rv:${kind} ; rv:ordinal 0 ;
          rv:action ${lit(action)} ; rv:receipt ${iri(id)} ; rv:work ${iri(work)} .
          OPTIONAL { ${iri(eventId)} rv:publicationDecision ?eventDecision }
          OPTIONAL { ${iri(eventId)} rv:predecessor ?eventPredecessor }
        }
      } LIMIT 2`)).results?.bindings ?? [];
      if (admissionRows.length !== 1 || !admissionRows[0]?.admission?.value) {
        throw new Error('Work publication event has no unique terminal receipt');
      }
      const admissionId = admissionRows[0].admission.value;
      if (!/^[0-9a-f-]{36}$/.test(admissionId)) throw new Error('Work publication event admission is invalid');
      const receipt = await readWorkStructurePublicationReceipt({ fuseki }, admissionId, action);
      if (!receipt || receipt.receipt !== id || receipt.admissionId !== admissionId
        || receipt.action !== action || receipt.work !== work
        || receipt.dataEpoch !== batch.dataEpoch || receipt.sequence !== batch.sequence
        || receipt.receipt !== workStructurePublicationReceiptIri(admissionId, action)) {
        throw new Error('Work publication event differs from its terminal receipt');
      }
      const row = admissionRows[0]!;
      const eventDecision = row.eventDecision?.value;
      const eventPredecessor = row.eventPredecessor?.value;
      if (receipt.outcome === 'cancelled') {
        if (decision || eventDecision || eventPredecessor) {
          throw new Error('Cancelled Work publication event carries a public decision');
        }
      } else {
        if (!receipt.publicationDecision || !publicationNativeId.test(receipt.publicationDecision)
          || decision !== receipt.publicationDecision || eventDecision !== receipt.publicationDecision
          || (eventPredecessor ?? null) !== receipt.predecessor) {
          throw new Error('Work publication event differs from its decision');
        }
        const decisionProof = action === 'work.publish'
          ? `GRAPH ${iri(GRAPHS.revisions)} {
              ${iri(receipt.publicationDecision)} a rv:WorkStructurePublicationDecision ;
                rv:component ${iri(work)} ; rv:publicationOutcome rv:Published ; rv:publicSource ?source .
              ?source a rv:WorkStructurePublicSource ; rv:work ${iri(work)} ;
                rv:structureProfile ${structureIri(receipt.structureProfile!)} ; rv:structure ${iri(receipt.structure!)} ;
                rv:component ${iri(receipt.mainVersion!)} ; rv:structureRevision ${iri(receipt.structureRevision!)} ;
                rv:selectedGeneration ${iri(receipt.selectedGeneration!)} ; rv:sourceRoot ${iri(receipt.sourceRoot!)} .
            }`
          : `GRAPH ${iri(GRAPHS.revisions)} {
              ${iri(receipt.publicationDecision)} a rv:WorkStructurePublicationDecision ;
                rv:component ${iri(work)} ; rv:publicationOutcome rv:Withdrawn ;
                rv:predecessor ${iri(receipt.predecessor!)} .
              FILTER NOT EXISTS { ${iri(receipt.publicationDecision)} rv:publicSource ?source }
            }`;
        if (action === 'work.publish' && (!receipt.mainVersion || !receipt.structure
          || !receipt.structureProfile || !receipt.structureRevision || !receipt.selectedGeneration
          || !receipt.sourceRoot || !publicationNativeId.test(receipt.mainVersion)
          || !publicationNativeId.test(receipt.structure) || !publicationNativeId.test(receipt.structureRevision)
          || !publicationNativeId.test(receipt.selectedGeneration) || !publicationRoot.test(receipt.sourceRoot))) {
          throw new Error('Work publication receipt has no exact source');
        }
        const proof = await fuseki.query(`PREFIX rv: <${RV}> ASK { ${decisionProof} }`, 16_384);
        if (proof.boolean !== true) throw new Error('Work publication decision graph proof is missing');
      }
      const eventReceipt: OwnerCloudEvent['data']['receipt'] = {
        id, action, outcome: receipt.outcome, admissionId, requestDigest: receipt.requestDigest,
        authorityEpoch: receipt.authorityEpoch, scope: receipt.scope, work,
        ...(receipt.publicationDecision ? { publicationDecision: receipt.publicationDecision } : {}),
        ...(receipt.mainVersion ? { mainVersion: receipt.mainVersion } : {}),
        ...(receipt.structure ? { structure: receipt.structure } : {}),
        ...(receipt.structureProfile ? { structureProfile: receipt.structureProfile } : {}),
        ...(receipt.structureRevision ? { structureRevision: receipt.structureRevision } : {}),
        ...(receipt.selectedGeneration ? { selectedGeneration: receipt.selectedGeneration } : {}),
        ...(receipt.sourceRoot ? { sourceRoot: receipt.sourceRoot } : {}),
        ...(receipt.predecessor ? { predecessor: receipt.predecessor } : {}),
      };
      return { specversion: '1.0', id: eventId, source: 'https://rezics.com/services/main', type,
        datacontenttype: 'application/json', data: { batchId: batch.batchId, routingEpoch: batch.routingEpoch,
          ordinal, sourcePosition: { datasetId: 'product', dataEpoch: batch.dataEpoch, sequence: batch.sequence },
          receipt: eventReceipt } };
    } };
}

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
},
  workPublicationEvent('work.publish', 'WorkStructurePublicationEvent',
    'com.rezics.work.structure-publication.v1'),
  workPublicationEvent('work.withdraw-publication', 'WorkStructureWithdrawalEvent',
    'com.rezics.work.structure-withdrawal.v1'),
] satisfies OwnerOutboxEventHandler[];
