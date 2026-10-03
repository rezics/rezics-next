import type { OwnerOutboxEventHandler } from '../outbox/event-handlers.ts';
import { GRAPHS, RV, hash, iri } from '../work/activate.ts';

export const outboxEventHandlers: readonly OwnerOutboxEventHandler[] = [
  {
    kind: `${RV}NamesMigratedEvent`,
    action: 'address.migrate',
    type: 'com.rezics.address.registry-migrated.v1',
    authority: 'system',
    async read({ fuseki, batch, eventId, value, ordinal }) {
      const receipt = value('receipt');
      if (!receipt || !/^urn:rezics:name-migration:[0-9a-f]{64}$/.test(receipt))
        throw new Error('Alias migration receipt is invalid');
      const rows =
        (
          await fuseki.query(
            `PREFIX rv: <${RV}> SELECT ?first ?last WHERE { GRAPH ${iri(GRAPHS.receipts)} {
      ${iri(receipt)} rv:nameMigrationBegin ?first ; rv:nameMigrationEnd ?last } } LIMIT 2`,
            4096,
          )
        ).results?.bindings ?? [];
      if (rows.length !== 1 || !rows[0]?.first || !rows[0]?.last)
        throw new Error('Alias migration cursor is incomplete');
      const digest = hash(
        `name-registry-v1\0${batch.dataEpoch}\0${rows[0].first.value}\0${rows[0].last.value}`,
      );
      if (
        receipt !== `urn:rezics:name-migration:${digest}` ||
        value('digest') !== digest ||
        value('outcome') !== `${RV}Succeeded` ||
        value('epoch') !== batch.dataEpoch ||
        value('sequence') !== batch.sequence ||
        eventId !== `urn:rezics:event:${hash(receipt)}`
      )
        throw new Error('Alias migration receipt differs');
      return {
        specversion: '1.0',
        id: eventId,
        source: 'https://rezics.com/services/main',
        type: 'com.rezics.address.registry-migrated.v1',
        datacontenttype: 'application/json',
        data: {
          batchId: batch.batchId,
          routingEpoch: batch.routingEpoch,
          ordinal,
          sourcePosition: {
            datasetId: 'product',
            dataEpoch: batch.dataEpoch,
            sequence: batch.sequence,
          },
          receipt: {
            id: receipt,
            action: 'address.migrate',
            outcome: 'succeeded',
            requestDigest: digest,
            systemProof: { kind: 'alias-registry-migration', dataEpoch: batch.dataEpoch },
          },
        },
      };
    },
  },
];
