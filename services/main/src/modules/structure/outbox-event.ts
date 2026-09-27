import { receiptFamilyFor } from '../access/receipt-families.ts';
import { discoverStructureProfiles } from './profiles.ts';
import { GRAPHS, RV, hash, iri, lit } from '../work/activate.ts';
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
  { kind: `${RV}StructureCommandEvent`, action: 'structure.command',
    type: 'com.rezics.structure.command.v1',
    read: async ({ fuseki, batch, eventId, value, ordinal }) => {
      const receipt = value('receipt');
      const digest = value('digest');
      if (!receipt || !digest || batch.batchId !== `urn:rezics:outbox:${hash(receipt)}`
        || eventId !== `urn:rezics:event:${hash(`${receipt}\0structure`)}`
        || ordinal !== 0 || batch.eventIds.length !== 1) {
        throw new Error('Structure command event differs from its source position');
      }
      const proof = await fuseki.query(`PREFIX rv: <${RV}> SELECT ?action ?operation ?structure
        ?revision ?reason WHERE {
        GRAPH ${iri(GRAPHS.outbox)} { ${iri(eventId)} a rv:StructureCommandEvent ;
          rv:ordinal 0 ; rv:action "structure.command" ; rv:receipt ${iri(receipt)} . }
        GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ;
          rv:requestDigest ${lit(digest)} ; rv:action ?action ;
          rv:dataEpoch ${lit(batch.dataEpoch)} ; rv:sequence ${batch.sequence} ;
          rv:outcome ?outcome .
          OPTIONAL { ${iri(receipt)} rv:operation ?operation }
          OPTIONAL { ${iri(receipt)} rv:structure ?structure }
          OPTIONAL { ${iri(receipt)} rv:structureRevision ?revision }
          OPTIONAL { ${iri(receipt)} rv:reason ?reason }
        }
      } LIMIT 2`);
      const rows = proof.results?.bindings ?? [];
      const action = rows[0]?.action?.value;
      const admissionId = value('admissionId');
      const profiles = await discoverStructureProfiles();
      const matches = [...profiles.values()].filter(profile =>
        value('scope')?.startsWith(profile.editScopePrefix)
        && receipt === `urn:rezics:receipt:${hash(`${admissionId}\0${profile.receiptFamily}`)}`);
      if (rows.length !== 1 || !action || !admissionId || matches.length !== 1
        || (value('operation') && rows[0]?.operation?.value !== value('operation'))) {
        throw new Error('Structure command event has no matching terminal receipt');
      }
      const outcome = value('outcome') === `${RV}Succeeded` ? 'succeeded' : 'cancelled';
      return { specversion: '1.0' as const, id: eventId,
        source: 'https://rezics.com/services/main' as const, type: 'com.rezics.structure.command.v1',
        datacontenttype: 'application/json' as const, data: { batchId: batch.batchId,
          routingEpoch: batch.routingEpoch, ordinal,
          sourcePosition: { datasetId: 'product' as const, dataEpoch: batch.dataEpoch,
            sequence: batch.sequence },
          receipt: { id: receipt, action: 'structure.command', outcome,
            requestDigest: digest, admissionId, authorityEpoch: value('authorityEpoch')!,
            scope: value('scope')!, commandAction: action,
            ...(rows[0]?.operation ? { operation: rows[0].operation.value } : {}),
            ...(rows[0]?.structure ? { structure: rows[0].structure.value } : {}),
            ...(rows[0]?.revision ? { revision: rows[0].revision.value } : {}),
            ...(rows[0]?.reason ? { reason: rows[0].reason.value } : {}) } } };
    } },
  structureStageEvent('StructureProjectionEvent', 'structure.project',
    'com.rezics.structure.projected.v1'),
  structureStageEvent('StructureStageCancelledEvent', 'structure.stage-cancel',
    'com.rezics.structure.stage-cancelled.v1', 'system'),
] satisfies OwnerOutboxEventHandler[];
