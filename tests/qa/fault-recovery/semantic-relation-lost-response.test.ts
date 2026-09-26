import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { authorCreditFixture, shortId } from '../fixtures/author-credit.ts';
import type { CommandEnvelope } from '../../../services/main/src/infrastructure/fuseki.ts';
import { readMainOutboxEnvelope, readNextMainOutboxBatch }
  from '../../../services/main/src/modules/outbox/relay.ts';

test('MODEL05/MODEL06: a lost relation graph acknowledgement retains one occurrence and exact definition', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated fault/recovery tier');
  const f = await authorCreditFixture(Bun.env as Record<string, string>,
    resolve('.temp', `relation-lost-response-${randomUUID()}`));
  const original = f.env.fuseki;
  try {
    await f.grant('semantic:create:root', 'semantic.change');
    const semantic = (state: object) => f.call('POST', '/v1/semantic/changes',
      { profile: 'semantic-change-v1', actingSubject: f.actor, expectedHead: null, state });
    const definition = await f.json<{ component: string; revision: string }>(await semantic({
      component: 'definition', kind: 'relation', lifecycle: 'active', successor: null,
      roles: [{ key: 'source', minParticipants: 1, maxParticipants: 1, ordered: false },
        { key: 'target', minParticipants: 1, maxParticipants: 1, ordered: false }],
    }), 201);
    const person = { component: 'resource', types: ['https://schema.org/Person'], properties: [] };
    const source = await f.json<{ component: string }>(await semantic(person), 201);
    const target = await f.json<{ component: string }>(await semantic(person), 201);
    await f.grant(`semantic:read:${source.component}`, 'semantic.read');
    await f.grant(`semantic:read:${target.component}`, 'semantic.read');
    await f.grant('relation:create:root', 'relation.change');
    let lost = false;
    f.env.fuseki = new Proxy(original, { get(client, property) {
      if (property === 'commandWithReceipt') return async (envelope: CommandEnvelope) => {
        const result = await client.commandWithReceipt(envelope);
        if (!lost && envelope.update.includes('rv:RelationChangedEvent')) {
          lost = true;
          throw new Error('lost relation graph acknowledgement');
        }
        return result;
      };
      const value = Reflect.get(client, property, client);
      return typeof value === 'function' ? value.bind(client) : value;
    } });
    const key = randomUUID();
    const body = { profile: 'relation-change-v1', actingSubject: f.actor, expectedHead: null,
      definition: definition.revision, participations: [
        { role: 'source', participant: { kind: 'resource', ref: source.component } },
        { role: 'target', participant: { kind: 'resource', ref: target.component } },
      ] };
    const write = () => f.call('POST', '/v1/relations/changes', body, key);
    const first = await f.json<{ occurrence: string; revision: string; receipt: string; replayed: boolean;
      sourcePosition: { sequence: string } }>(await write(), 201);
    expect(lost).toBe(true);
    expect(first.replayed).toBe(false);
    expect(await f.json<typeof first>(await write(), 201)).toMatchObject({
      occurrence: first.occurrence, revision: first.revision, receipt: first.receipt, replayed: true });
    const before = (BigInt(first.sourcePosition.sequence) - 1n).toString();
    const batch = await readNextMainOutboxBatch(original, f.env.lineage.dataEpoch, before);
    expect(batch?.eventIds).toHaveLength(1);
    const event = await readMainOutboxEnvelope(original, batch!, batch!.eventIds[0]!);
    expect(event.data.receipt).toMatchObject({ id: first.receipt, action: 'relation.change',
      outcome: 'succeeded', component: first.occurrence, revision: first.revision });
    await f.grant(`semantic:read:${first.occurrence}`, 'semantic.read');
    const exact = await f.json<{ occurrence: string; definition: { revision: string } }>(await f.call('GET',
      `/v1/relations/${shortId(first.occurrence)}/revisions/${shortId(first.revision)}`
      + `?actingSubject=${encodeURIComponent(f.actor)}`), 200);
    expect(exact).toMatchObject({ occurrence: first.occurrence,
      definition: { revision: definition.revision } });
  } finally {
    f.env.fuseki = original;
    await f.close();
  }
}, 180_000);
