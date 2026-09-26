import type { OwnerOutboxEventHandler } from '../outbox/event-handlers.ts';
import { receiptFamilyFor } from '../access/receipt-families.ts';
import { GRAPHS, RV, iri, lit } from '../work/activate.ts';

type Outcome = 'committed' | 'stale' | 'cancelled';

/** The relay supplies terminal receipt fields; the owner proves its own event and revision facts. */
export function ownerCommandEvent(action: string, kind: string, type: string,
  outcome: Outcome, revisionClass: string): OwnerOutboxEventHandler {
  const family = receiptFamilyFor(action);
  if (!family) throw new Error(`Context event action has no receipt family: ${action}`);
  return { action, kind: `${RV}${kind}`, type, read: async ({ fuseki, batch, eventId, value, ordinal }) => {
    const receipt = value('receipt');
    const succeeded = outcome === 'committed';
    const reason = outcome === 'stale' ? `${RV}StaleHead` : `${RV}Unavailable`;
    if (!receipt || !value('admissionId') || !value('digest') || !value('authorityEpoch')
      || !value('scope') || value('epoch') !== batch.dataEpoch || value('sequence') !== batch.sequence
      || value('outcome') !== `${RV}${succeeded ? 'Succeeded' : 'Cancelled'}`
      || (succeeded ? !!value('reason') : value('reason') !== reason)
      || (succeeded ? !value('operation') || value('eventOperation') !== value('operation')
        : !!value('operation') || !!value('eventOperation'))) {
      throw new Error('owner event differs from terminal receipt');
    }
    const rows = (await fuseki.query(`PREFIX rv: <${RV}> SELECT ?component ?revision
      ?eventComponent ?eventRevision WHERE {
      GRAPH ${iri(GRAPHS.receipts)} {
        ${iri(receipt)} rv:commandFamily ${lit(family)} .
        ${succeeded ? `${iri(receipt)} rv:component ?component ; rv:revision ?revision .` : ''}
      }
      GRAPH ${iri(GRAPHS.outbox)} {
        ${iri(eventId)} a rv:${kind} ; rv:action ${lit(action)} ; rv:receipt ${iri(receipt)} .
        OPTIONAL { ${iri(eventId)} rv:component ?eventComponent }
        OPTIONAL { ${iri(eventId)} rv:revision ?eventRevision }
      }
    }`)).results?.bindings ?? [];
    if (rows.length !== 1 || (succeeded && (!rows[0]?.component || !rows[0]?.revision
      || rows[0].component.value !== rows[0].eventComponent?.value
      || rows[0].revision.value !== rows[0].eventRevision?.value))
      || (!succeeded && (rows[0]?.component || rows[0]?.revision
        || rows[0]?.eventComponent || rows[0]?.eventRevision))) {
      throw new Error('owner event component or revision differs from receipt');
    }
    if (succeeded) {
      const component = rows[0]!.component!.value;
      const revision = rows[0]!.revision!.value;
      const valid = await fuseki.query(`PREFIX rv: <${RV}> ASK {
        GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} a rv:${revisionClass} ;
          rv:component ${iri(component)} ; rv:operation ${iri(value('operation')!)} ;
          rv:dataEpoch ${lit(batch.dataEpoch)} ; rv:sequence ${batch.sequence} . }
      }`);
      if (valid.boolean !== true) throw new Error('owner event revision is unavailable');
    }
    return { specversion: '1.0', id: eventId, source: 'https://rezics.com/services/main', type,
      datacontenttype: 'application/json', data: { batchId: batch.batchId,
        sourcePosition: { datasetId: 'product', dataEpoch: batch.dataEpoch, sequence: batch.sequence },
        routingEpoch: batch.routingEpoch, ordinal,
        receipt: { id: receipt, action, outcome: succeeded ? 'succeeded' : 'cancelled',
          admissionId: value('admissionId')!, requestDigest: value('digest')!,
          authorityEpoch: value('authorityEpoch')!, scope: value('scope')!,
          ...(succeeded ? { component: rows[0]!.component!.value, revision: rows[0]!.revision!.value }
            : { reason: outcome === 'stale' ? 'stale-head' : 'unavailable' }) } } };
  } };
}

export const outboxEventHandlers = [
  ownerCommandEvent('context.create', 'ContextCreatedEvent', 'com.rezics.context.created.v1',
    'committed', 'ContextSemanticRevision'),
  ownerCommandEvent('context.create', 'ContextCreateStaleEvent', 'com.rezics.context.create-stale.v1',
    'stale', 'ContextSemanticRevision'),
  ownerCommandEvent('context.create', 'ContextCreateCancelledEvent', 'com.rezics.context.create-cancelled.v1',
    'cancelled', 'ContextSemanticRevision'),
  ownerCommandEvent('context.change', 'ContextSemanticRevisedEvent', 'com.rezics.context.semantic-revised.v1',
    'committed', 'ContextSemanticRevision'),
  ownerCommandEvent('context.change', 'ContextChangeStaleEvent', 'com.rezics.context.change-stale.v1',
    'stale', 'ContextSemanticRevision'),
  ownerCommandEvent('context.change', 'ContextChangeCancelledEvent', 'com.rezics.context.change-cancelled.v1',
    'cancelled', 'ContextSemanticRevision'),
  ownerCommandEvent('context.select', 'ContextSelectionChangedEvent', 'com.rezics.context.selection-changed.v1',
    'committed', 'ContextSelectionRevision'),
  ownerCommandEvent('context.select', 'ContextSelectionStaleEvent', 'com.rezics.context.selection-stale.v1',
    'stale', 'ContextSelectionRevision'),
  ownerCommandEvent('context.select', 'ContextSelectionCancelledEvent', 'com.rezics.context.selection-cancelled.v1',
    'cancelled', 'ContextSelectionRevision'),
] satisfies OwnerOutboxEventHandler[];
