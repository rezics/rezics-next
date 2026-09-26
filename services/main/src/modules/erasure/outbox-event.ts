import type { OwnerOutboxEventHandler } from '../outbox/event-handlers.ts';
import { GRAPHS, RV, iri } from '../work/activate.ts';
import { graphErasureReceipt } from './graph.ts';

export const outboxEventHandlers: readonly OwnerOutboxEventHandler[] = [{
  kind: `${RV}GraphErasureEvent`, action: 'erasure.graph',
  type: 'com.rezics.erasure.graph-suppressed.v1', authority: 'system',
  async read({ fuseki, batch, eventId, value, ordinal }) {
    const receipt = value('receipt');
    if (!receipt || value('outcome') !== `${RV}Succeeded`
      || value('epoch') !== batch.dataEpoch || value('sequence') !== batch.sequence
      || !/^[0-9a-f]{64}$/.test(value('digest') ?? '')) {
      throw new Error('graph erasure event differs from its terminal receipt');
    }
    const facts = await fuseki.query(`PREFIX rv: <${RV}> SELECT ?erasure ?epoch ?eventErasure ?eventEpoch WHERE {
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ;
        rv:erasureId ?erasure ; rv:erasureEpoch ?epoch . }
      GRAPH ${iri(GRAPHS.outbox)} { ${iri(eventId)} rv:receipt ${iri(receipt)} ;
        rv:erasureId ?eventErasure ; rv:erasureEpoch ?eventEpoch . }
    }`, 8192);
    const rows = facts.results?.bindings ?? [];
    const erasureId = rows[0]?.erasure?.value;
    const erasureEpoch = rows[0]?.epoch?.value;
    if (rows.length !== 1 || !erasureId || !/^[0-9a-f-]{36}$/.test(erasureId)
      || receipt !== graphErasureReceipt(erasureId)
      || !/^[1-9][0-9]{0,18}$/.test(erasureEpoch ?? '')
      || rows[0]?.eventErasure?.value !== erasureId
      || rows[0]?.eventEpoch?.value !== erasureEpoch) {
      throw new Error('graph erasure event identity or epoch differs');
    }
    return { specversion: '1.0', id: eventId,
      source: 'https://rezics.com/services/main',
      type: 'com.rezics.erasure.graph-suppressed.v1',
      datacontenttype: 'application/json',
      data: { batchId: batch.batchId,
        sourcePosition: { datasetId: 'product', dataEpoch: batch.dataEpoch,
          sequence: batch.sequence }, routingEpoch: batch.routingEpoch, ordinal,
        receipt: { id: receipt, action: 'erasure.graph', outcome: 'succeeded',
          requestDigest: value('digest')!, systemProof: { kind: 'relay-erasure',
            erasureId, erasureEpoch } } },
    };
  },
}];
