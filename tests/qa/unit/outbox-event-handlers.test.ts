import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { discoverOutboxEventHandlers } from '../../../services/main/src/modules/outbox/event-handlers.ts';
import { OutboxIncomplete, readMainOutboxEnvelope,
  type MainOutboxBatch } from '../../../services/main/src/modules/outbox/relay.ts';

const kind = 'https://rezics.com/vocab/SyntheticChangedEvent';
const eventId = 'urn:rezics:event:synthetic';
const receiptId = 'urn:rezics:receipt:synthetic';
const batch: MainOutboxBatch = { batchId: 'urn:rezics:outbox:synthetic', dataEpoch: 'epoch-1',
  sequence: '1', routingEpoch: 'route-1', eventIds: [eventId] };
const binding = (value: string) => ({ type: 'literal', value });

test('G-087: discovered owner event reads a validated receipt; mismatches hold the relay', async () => {
  await mkdir('.temp', { recursive: true });
  const root = await mkdtemp(join('.temp', 'outbox-handlers-'));
  try {
    await mkdir(join(root, 'synthetic'));
    await writeFile(join(root, 'synthetic', 'outbox-event.ts'), `
      export const outboxEventHandlers = [{
        kind: '${kind}', action: 'synthetic.change', type: 'com.rezics.synthetic.changed.v1',
        read: async ({ batch, eventId, value, ordinal }) => ({
          specversion: '1.0', id: eventId, source: 'https://rezics.com/services/main',
          type: 'com.rezics.synthetic.changed.v1', datacontenttype: 'application/json',
          data: { batchId: batch.batchId, sourcePosition: { datasetId: 'product',
            dataEpoch: batch.dataEpoch, sequence: batch.sequence }, routingEpoch: batch.routingEpoch,
            ordinal, receipt: { id: value('receipt'), action: value('action'),
              outcome: 'succeeded', admissionId: value('admissionId'),
              requestDigest: value('digest'), authorityEpoch: value('authorityEpoch'),
              scope: value('scope') } },
        }),
      }];\n`);
    const handlers = await discoverOutboxEventHandlers(root);
    const row = { kind: binding(kind), ordinal: binding('0'), action: binding('synthetic.change'),
      receipt: binding(receiptId), outcome: binding('https://rezics.com/vocab/Succeeded'),
      admissionId: binding('11111111-1111-4111-8111-111111111111'), digest: binding('a'.repeat(64)),
      authorityEpoch: binding('1'), scope: binding('synthetic:change:one'),
      epoch: binding(batch.dataEpoch), sequence: binding(batch.sequence) };
    const fuseki = { query: async () => ({ results: { bindings: [row] } }) } as unknown as FusekiClient;
    const select = (name: string) => handlers.get(name);
    const envelope = await readMainOutboxEnvelope(fuseki, batch, eventId, select);
    expect(envelope.type).toBe('com.rezics.synthetic.changed.v1');
    expect(envelope.data.receipt.action).toBe('synthetic.change');
    row.action = binding('synthetic.wrong');
    await expect(readMainOutboxEnvelope(fuseki, batch, eventId, select))
      .rejects.toBeInstanceOf(OutboxIncomplete);
    row.action = binding('synthetic.change');
    row.epoch = binding('wrong-epoch');
    await expect(readMainOutboxEnvelope(fuseki, batch, eventId, select))
      .rejects.toBeInstanceOf(OutboxIncomplete);
  } finally { await rm(root, { recursive: true, force: true }); }
});
