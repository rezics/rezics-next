import type { OwnerOutboxEventHandler } from '../outbox/event-handlers.ts';
import { GRAPHS, RV, hash, iri, lit } from '../work/activate.ts';
import { workEditReceiptIri } from '../work/edit.ts';

/** The relay discovers this handler; the existing work.edit admission sealer
 * remains responsible for the shared receipt family and strong revocation. */
export const outboxEventHandlers: readonly OwnerOutboxEventHandler[] = [{
  kind: `${RV}NativeAgentCreditCreatedEvent`, action: 'work.edit', type: 'com.rezics.agent.credit-created.v1',
  async read({ fuseki, batch, eventId, value, ordinal }) {
    const admissionId = value('admissionId');
    const receipt = value('receipt');
    const digest = value('digest');
    const authorityEpoch = value('authorityEpoch');
    const scope = value('scope');
    if (!admissionId || !/^[0-9a-f-]{36}$/.test(admissionId) || receipt !== workEditReceiptIri(admissionId)
      || !digest || !/^[0-9a-f]{64}$/.test(digest) || !authorityEpoch || !/^\d+$/.test(authorityEpoch)
      || !scope || value('outcome') !== `${RV}Succeeded` || value('epoch') !== batch.dataEpoch
      || value('sequence') !== batch.sequence || value('action') !== 'work.edit'
      || batch.batchId !== `urn:rezics:outbox:${hash(receipt)}`
      || eventId !== `urn:rezics:event:${hash(`${receipt}\0native-credit`)}` || ordinal !== 0) {
      throw new Error('Native credit event differs from its admission receipt');
    }
    const rows = (await fuseki.query(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
      SELECT ?credit ?revision ?work ?agent ?role ?head WHERE {
        GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} rv:nativeCredit ?credit ; rv:creditRevision ?revision ;
          rv:work ?work ; rv:workRevision ?head ; rv:expectedHead ?head . }
        GRAPH ${iri(GRAPHS.revisions)} { ?revision a rv:NativeAgentCreditRevision, rv:RevisionAnchor ;
          rv:component ?credit ; rv:work ?work ; rv:agent ?agent ; schema:roleName ?role ;
          rv:workRevision ?head ; rv:dataEpoch ${lit(batch.dataEpoch)} ; rv:sequence ${batch.sequence} . }
      } LIMIT 2`, 8192)).results?.bindings ?? [];
    const row = rows[0];
    if (rows.length !== 1 || !row?.credit || !row.revision || !row.work || !row.agent || !row.role || !row.head
      || scope !== `work:edit:${row.work.value}`) throw new Error('Native credit event has no retained attribution');
    return { specversion: '1.0', id: eventId, source: 'https://rezics.com/services/main',
      type: 'com.rezics.agent.credit-created.v1', datacontenttype: 'application/json',
      data: { batchId: batch.batchId, sourcePosition: { datasetId: 'product', dataEpoch: batch.dataEpoch,
        sequence: batch.sequence }, routingEpoch: batch.routingEpoch, ordinal,
      receipt: { id: receipt, action: 'work.edit', outcome: 'succeeded', admissionId, requestDigest: digest,
        authorityEpoch, scope, work: row.work.value, expectedHead: row.head.value, credit: row.credit.value,
        revision: row.revision.value, agent: row.agent.value, role: row.role.value } } };
  },
}];
