import { expect, test } from 'bun:test';
import type { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { outboxEventHandlers } from '../src/modules/agent/outbox-event.ts';
import { hash, RV } from '../src/modules/work/activate.ts';

test('G-300: profile event is bound to its exact graph receipt and revision', async () => {
  const receipt = `urn:rezics:receipt:agent-profile:${'a'.repeat(64)}`;
  const eventId = `urn:rezics:event:${hash(receipt)}`;
  const handler = outboxEventHandlers.find(item => item.kind === `${RV}AgentPublicProfileChangedEvent`)!;
  const batch = { batchId: `urn:rezics:outbox:${hash(receipt)}`, dataEpoch: 'epoch', sequence: '8',
    routingEpoch: 'route', eventIds: [eventId] };
  const agent = 'https://rezics.com/id/11111111-1111-4111-8111-111111111111';
  const revision = 'https://rezics.com/id/22222222-2222-4222-8222-222222222222';
  const fuseki = { query: async () => ({ results: { bindings: [{ agent: { type: 'uri', value: agent },
    revision: { type: 'uri', value: revision } }] } }) } as unknown as FusekiClient;
  const values = { receipt, digest: 'b'.repeat(64), outcome: `${RV}Succeeded` };
  const read = (value = values, graph = fuseki) => handler.read({ fuseki: graph, batch, eventId,
    value: name => value[name as keyof typeof value], ordinal: 0 });
  expect((await read()).data.receipt).toMatchObject({ action: 'agent.profile.change',
    systemProof: { kind: 'agent-profile-changed', agent, revision } });
  await expect(read({ ...values, outcome: `${RV}Cancelled` })).rejects.toThrow('source position');
  const missing = { query: async () => ({ results: { bindings: [] } }) } as unknown as FusekiClient;
  await expect(read(values, missing)).rejects.toThrow('graph proof');
});
