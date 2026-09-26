import { receiptFamilyFor } from '../access/receipt-families.ts';
import { GRAPHS, RV, iri, lit } from '../work/activate.ts';
import type { OwnerCloudEvent, OwnerOutboxEventHandler } from '../outbox/event-handlers.ts';

function structureStageEvent(kind: string, action: string, type: string,
  authority?: 'system'): OwnerOutboxEventHandler {
  const family = receiptFamilyFor(action);
  if (!family) throw new Error(`Structure event action has no receipt family: ${action}`);
  return { kind: `${RV}${kind}`, action, type, ...(authority ? { authority } : {}),
    read: async ({ fuseki, batch, eventId, value, ordinal }) => {
      const receipt = value('receipt');
      const outcome: 'succeeded' | 'cancelled' | null = value('outcome') === `${RV}Succeeded` ? 'succeeded'
        : value('outcome') === `${RV}Cancelled` ? 'cancelled' : null;
      const digest = value('digest');
      const epoch = value('epoch');
      const sequence = value('sequence');
      const stageId = value('stageId');
      if (!receipt || value('action') !== action || !outcome || !digest
        || epoch !== batch.dataEpoch || sequence !== batch.sequence || !stageId
        || (authority === 'system'
          ? value('admissionId') !== undefined || value('authorityEpoch') !== undefined
            || value('scope') !== undefined
          : !value('admissionId') || !value('authorityEpoch') || !value('scope'))) {
        throw new Error('Structure stage event differs from its terminal receipt');
      }
      const proof = await fuseki.query(`PREFIX rv: <${RV}> SELECT ?structure ?generation ?batchIndex
        ?eventAction ?eventStage ?eventStructure ?eventGeneration ?eventBatch WHERE {
        GRAPH ${iri(GRAPHS.receipts)} {
          ${iri(receipt)} rv:commandFamily ${lit(family)} ; rv:action ${lit(action)} ;
            rv:stageId ${lit(stageId)} ; rv:dataEpoch ${lit(batch.dataEpoch)} ;
            rv:sequence ${batch.sequence} ; rv:outcome rv:${outcome === 'succeeded' ? 'Succeeded' : 'Cancelled'} ;
            rv:structure ?structure ; rv:generation ?generation .
          ${action === 'structure.project' ? `${iri(receipt)} rv:projectionBatch ?batchIndex .` : ''}
        }
        GRAPH ${iri(GRAPHS.outbox)} {
          ${iri(eventId)} a rv:${kind} ; rv:ordinal ${ordinal} ; rv:action ?eventAction ;
            rv:receipt ${iri(receipt)} ; rv:stageId ?eventStage ; rv:structure ?eventStructure ;
            rv:generation ?eventGeneration .
          ${action === 'structure.project' ? `${iri(eventId)} rv:projectionBatch ?eventBatch .` : ''}
        }
        BIND(${lit(action)} AS ?eventAction)
      } LIMIT 2`);
      const rows = proof.results?.bindings ?? [];
      const row = rows[0];
      const structure = row?.structure?.value;
      const generation = row?.generation?.value;
      const projectionBatch = row?.batchIndex?.value;
      if (rows.length !== 1 || !structure || !generation
        || row?.eventAction?.value !== action || row?.eventStage?.value !== stageId
        || row?.eventStructure?.value !== structure || row?.eventGeneration?.value !== generation
        || (action === 'structure.project'
          && (!projectionBatch || row?.eventBatch?.value !== projectionBatch))) {
        throw new Error('Structure stage event differs from its graph proof');
      }
      const eventReceipt: OwnerCloudEvent['data']['receipt'] = authority === 'system'
        ? { id: receipt, action, outcome, requestDigest: digest,
          systemProof: { kind: 'structure-stage-cancelled', stageId, structure, generation } }
        : { id: receipt, action, outcome, requestDigest: digest,
          admissionId: value('admissionId')!, authorityEpoch: value('authorityEpoch')!,
          scope: value('scope')!, stageId, structure, generation,
          ...(projectionBatch ? { projectionBatch } : {}) };
      return { specversion: '1.0', id: eventId, source: 'https://rezics.com/services/main', type,
        datacontenttype: 'application/json', data: { batchId: batch.batchId,
          sourcePosition: { datasetId: 'product', dataEpoch: batch.dataEpoch, sequence: batch.sequence },
          routingEpoch: batch.routingEpoch, ordinal, receipt: eventReceipt } };
    } };
}

export const outboxEventHandlers = [
  structureStageEvent('StructureProjectionEvent', 'structure.project',
    'com.rezics.structure.projected.v1'),
  structureStageEvent('StructureStageCancelledEvent', 'structure.stage-cancel',
    'com.rezics.structure.stage-cancelled.v1', 'system'),
] satisfies OwnerOutboxEventHandler[];
