import type { OwnerOutboxEventHandler } from '../outbox/event-handlers.ts';
import { GRAPHS, RV, iri } from '../work/activate.ts';
import type { OwnerCloudEvent } from '../outbox/event-handlers.ts';

const changed = 'https://rezics.com/vocab/EventTimeChangedEvent';
const stale = 'https://rezics.com/vocab/EventTimeStaleEvent';
const cancelled = 'https://rezics.com/vocab/EventTimeCancelledEvent';

function handler(kind: string, type: string): OwnerOutboxEventHandler {
  return { kind, action: 'event.observation.set', type,
    async read({ fuseki, batch, eventId, ordinal }) {
      const rows = (await fuseki.query(`PREFIX rv: <${RV}> SELECT ?storedKind ?storedOrdinal ?action ?receipt
        ?outcome ?admissionId ?digest ?authorityEpoch ?scope ?epoch ?sequence ?reason
        ?operation ?event ?eventTime ?status ?revision ?predecessor WHERE {
        GRAPH ${iri(GRAPHS.outbox)} { ${iri(eventId)} a ?storedKind ; rv:ordinal ?storedOrdinal ;
          rv:action ?action ; rv:receipt ?receipt .
          OPTIONAL { ${iri(eventId)} rv:operation ?operation }
          OPTIONAL { ${iri(eventId)} rv:event ?event }
          OPTIONAL { ${iri(eventId)} rv:eventTime ?eventTime }
        }
        GRAPH ${iri(GRAPHS.receipts)} { ?receipt a rv:OperationReceipt ; rv:outcome ?outcome ;
          rv:admissionId ?admissionId ; rv:requestDigest ?digest ; rv:authorityEpoch ?authorityEpoch ;
          rv:admittedScope ?scope ; rv:dataEpoch ?epoch ; rv:sequence ?sequence .
          OPTIONAL { ?receipt rv:reason ?reason }
          OPTIONAL { ?receipt rv:event ?event ; rv:eventTime ?eventTime ; rv:timeStatus ?status ;
            rv:observationRevision ?revision .
            OPTIONAL { ?receipt rv:expectedHead ?predecessor } }
        }
      }`)).results?.bindings ?? [];
      const row = rows[0];
      const get = (name: string) => row?.[name]?.value;
      const outcome = kind === changed ? 'succeeded' : 'cancelled';
      const expectedOutcome = outcome === 'succeeded' ? `${RV}Succeeded` : `${RV}Cancelled`;
      if (rows.length !== 1 || get('storedKind') !== kind || get('storedOrdinal') !== String(ordinal)
        || get('action') !== 'event.observation.set' || !get('receipt')
        || get('outcome') !== expectedOutcome || !get('admissionId') || !get('digest')
        || !/^[0-9a-f]{64}$/.test(get('digest')!) || !get('authorityEpoch') || !get('scope')
        || get('epoch') !== batch.dataEpoch || get('sequence') !== batch.sequence) {
        throw new Error('event-time outbox receipt differs from its source position');
      }
      if (outcome === 'succeeded' && (!get('operation') || !get('event') || !get('eventTime')
        || !get('status') || !get('revision') || get('reason') || get('scope') !== `event:observe:${get('event')}`)) {
        throw new Error('event-time success event is incomplete');
      }
      if (outcome === 'cancelled' && (get('operation') || get('event') || get('eventTime')
        || get('status') || get('revision') || (kind === stale) !== (get('reason') === `${RV}StaleHead`))) {
        throw new Error('event-time terminal event is inconsistent');
      }
      const receipt: OwnerCloudEvent['data']['receipt'] = { id: get('receipt')!, action: 'event.observation.set', outcome,
        admissionId: get('admissionId')!, requestDigest: get('digest')!, authorityEpoch: get('authorityEpoch')!,
        scope: get('scope')!, ...(outcome === 'succeeded' ? { operation: get('operation'), event: get('event'),
          eventTime: get('eventTime'), timeStatus: get('status') === `${RV}ActualTime` ? 'actual' : 'planned',
          observationRevision: get('revision'), predecessor: get('predecessor') ?? null } : {}),
        ...(kind === stale ? { reason: 'stale-head' } : {}) };
      return { specversion: '1.0', id: eventId, source: 'https://rezics.com/services/main',
        type, datacontenttype: 'application/json', data: { batchId: batch.batchId,
          sourcePosition: { datasetId: 'product', dataEpoch: batch.dataEpoch, sequence: batch.sequence },
          routingEpoch: batch.routingEpoch, ordinal, receipt } };
    } };
}

export const outboxEventHandlers = [
  handler(changed, 'com.rezics.event.time-changed.v1'),
  handler(stale, 'com.rezics.event.time-stale.v1'),
  handler(cancelled, 'com.rezics.event.time-cancelled.v1'),
] as const;
