import { expect, test } from 'bun:test';
import type { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { receiptFamilyFor } from '../src/modules/access/receipt-families.ts';
import { readMainOutboxEnvelope } from '../src/modules/outbox/relay.ts';
import { outboxEventHandlers as relationHandlers } from '../src/modules/relation/outbox-event.ts';
import { outboxEventHandlers as semanticHandlers } from '../src/modules/semantic/outbox-event.ts';
import { RV, hash } from '../src/modules/work/activate.ts';

const admissionId = '01990000-0000-7000-8000-000000000001';
const component = 'https://rezics.com/id/01990000-0000-7000-8000-000000000002';
const revision = 'https://rezics.com/id/01990000-0000-7000-8000-000000000003';
const batch = { batchId: 'urn:rezics:outbox:example', dataEpoch: 'epoch-1', sequence: '5',
  routingEpoch: 'routing-1', eventIds: ['urn:rezics:event:example'] };
const row = (expected?: string) => ({ component: { value: component }, revision: { value: revision },
  manifest: { value: `urn:rezics:sha256:${'a'.repeat(64)}` },
  generation: { value: `urn:rezics:model-generation:${'b'.repeat(64)}` },
  ...(expected ? { expected: { value: expected } } : {}) });

test('MODEL01/MODEL05: owner receipt families and outbox readers bind exact admitted revisions', async () => {
  for (const [handler, family, scope, expected] of [
    [semanticHandlers[0]!, 'semantic-change', 'semantic:create:root', undefined],
    [relationHandlers[0]!, 'relation-change', `relation:edit:${component}`, revision],
  ] as const) {
    expect(receiptFamilyFor(handler.action)).toBe(family);
    const receipt = `urn:rezics:receipt:${hash(`${admissionId}\0${family}`)}`;
    const values: Record<string, string | undefined> = {
      receipt, admissionId, digest: 'c'.repeat(64), authorityEpoch: '7', scope,
      outcome: `${RV}Succeeded`, epoch: batch.dataEpoch, sequence: batch.sequence,
      expectedHead: expected,
    };
    let query = '';
    const fuseki = { query: async (sparql: string) => {
      query = sparql;
      return { results: { bindings: [row(expected)] } };
    } } as unknown as FusekiClient;
    const input = { fuseki, batch, eventId: batch.eventIds[0]!, value: (key: string) => values[key], ordinal: 0 };
    const event = await handler.read(input);
    expect(event.data.receipt).toMatchObject({ id: receipt, action: handler.action, component, revision,
      admissionId, scope });
    expect(event.type).toBe(handler.type);
    expect(query).toContain(family === 'semantic-change' ? 'rv:DefinitionRevision' : 'rv:RelationOccurrenceRevision');
    let calls = 0;
    const term = (value: string) => ({ value });
    const relayFuseki = { query: async () => {
      calls++;
      return { results: { bindings: calls === 1 ? [{ kind: term(handler.kind), ordinal: term('0'),
        action: term(handler.action), receipt: term(receipt), outcome: term(`${RV}Succeeded`),
        admissionId: term(admissionId), digest: term('c'.repeat(64)), authorityEpoch: term('7'),
        scope: term(scope), epoch: term(batch.dataEpoch), sequence: term(batch.sequence),
        ...(expected ? { expectedHead: term(expected) } : {}) }] : [row(expected)] } };
    } } as unknown as FusekiClient;
    expect((await readMainOutboxEnvelope(relayFuseki, batch, batch.eventIds[0]!,
      kind => kind === handler.kind ? handler : undefined)).data.receipt.id).toBe(receipt);
    expect(calls).toBe(2);
    values.digest = 'wrong';
    expect(handler.read(input)).rejects.toThrow('exact admitted terminal');
    values.digest = 'c'.repeat(64);
    values.scope = 'semantic:read:other';
    expect(handler.read(input)).rejects.toThrow('revision differs');
  }
});
