import type { OwnerOutboxEventHandler, OwnerEventReceipt } from '../outbox/event-handlers.ts';
import { GRAPHS, RV, iri, lit } from '../work/activate.ts';
import { receiptFamilies } from './receipt-family.ts';

const action = 'theme.approve';
const family = receiptFamilies[action];
const outcomes = [
  ['ThemeActivationEvent', 'com.rezics.theme.activated.v1', 'succeeded', undefined],
  ['ThemeActivationStaleEvent', 'com.rezics.theme.activation-stale.v1', 'cancelled', `${RV}StaleHead`],
  ['ThemeActivationCancelledEvent', 'com.rezics.theme.activation-cancelled.v1', 'cancelled', `${RV}Unavailable`],
] as const;

/** Relay an activation only when the event, exact command receipt and revision agree. */
export const outboxEventHandlers: readonly OwnerOutboxEventHandler[] = outcomes.map(
  ([kind, type, outcome, reason]) => ({
    kind: `${RV}${kind}`, action, type,
    async read({ fuseki, batch, eventId, value, ordinal }) {
      const receipt = value('receipt');
      if (!receipt || value('admissionId') === undefined || value('digest') === undefined
        || value('authorityEpoch') === undefined || value('scope') === undefined
        || value('epoch') !== batch.dataEpoch || value('sequence') !== batch.sequence
        || value('outcome') !== `${RV}${outcome === 'succeeded' ? 'Succeeded' : 'Cancelled'}`
        || (reason ? value('reason') !== reason : !!value('reason'))) {
        throw new Error('theme event differs from its terminal receipt');
      }
      const result = await fuseki.query(`PREFIX rv: <${RV}> SELECT ?theme ?revision ?owner ?dependencyDigest
        ?capabilityDigest ?expiry WHERE {
        GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} rv:commandFamily ${lit(family)} ; rv:action ${lit(action)} .
          ${outcome === 'succeeded' ? `${iri(receipt)} rv:component ?theme ; rv:revision ?revision .` : ''} }
        GRAPH ${iri(GRAPHS.outbox)} { ${iri(eventId)} a rv:${kind} ; rv:action ${lit(action)} ; rv:receipt ${iri(receipt)} .
          ${outcome === 'succeeded' ? `${iri(eventId)} rv:component ?theme ; rv:revision ?revision .` : ''} }
        ${outcome === 'succeeded' ? `GRAPH ${iri(GRAPHS.revisions)} { ?revision a rv:ThemeActivation ;
          rv:component ?theme ; rv:themeOwner ?owner ; rv:dependencyDigest ?dependencyDigest ;
          rv:capabilityDigest ?capabilityDigest ; rv:approvalExpiresAt ?expiry . }` : ''}
      } LIMIT 2`);
      const rows = result.results?.bindings ?? [];
      if (rows.length !== 1 || (outcome === 'succeeded' && (!rows[0]?.theme || !rows[0]?.revision
        || !rows[0]?.owner || !rows[0]?.dependencyDigest || !rows[0]?.capabilityDigest || !rows[0]?.expiry))) {
        throw new Error('theme event has no matching immutable activation');
      }
      const receiptData: OwnerEventReceipt = { id: receipt, action, outcome,
        admissionId: value('admissionId')!, requestDigest: value('digest')!,
        authorityEpoch: value('authorityEpoch')!, scope: value('scope')! } as OwnerEventReceipt;
      if (outcome === 'succeeded') Object.assign(receiptData, {
        theme: rows[0]!.theme!.value, revision: rows[0]!.revision!.value,
        owner: rows[0]!.owner!.value, dependencyDigest: rows[0]!.dependencyDigest!.value,
        capabilityDigest: rows[0]!.capabilityDigest!.value,
        approvalExpiresAt: rows[0]!.expiry!.value,
      });
      else receiptData.reason = reason === `${RV}StaleHead` ? 'stale-head' : 'unavailable';
      return { specversion: '1.0', id: eventId, source: 'https://rezics.com/services/main', type,
        datacontenttype: 'application/json', data: { batchId: batch.batchId,
          sourcePosition: { datasetId: 'product', dataEpoch: batch.dataEpoch, sequence: batch.sequence },
          routingEpoch: batch.routingEpoch, ordinal, receipt: receiptData } };
    },
  }),
);
