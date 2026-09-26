import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { authorCreditFixture, shortId } from '../fixtures/author-credit.ts';
import type { CommandEnvelope } from '../../../services/main/src/infrastructure/fuseki.ts';
import { readMainOutboxEnvelope, readNextMainOutboxBatch }
  from '../../../services/main/src/modules/outbox/relay.ts';

test('MODEL01/MODEL14: a lost semantic graph acknowledgement resolves one receipt and event', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated fault/recovery tier');
  const f = await authorCreditFixture(Bun.env as Record<string, string>,
    resolve('.temp', `semantic-lost-response-${randomUUID()}`));
  const original = f.env.fuseki;
  try {
    await f.grant('semantic:create:root', 'semantic.change');
    let lost = false;
    f.env.fuseki = new Proxy(original, { get(target, property) {
      if (property === 'commandWithReceipt') return async (envelope: CommandEnvelope) => {
        const result = await target.commandWithReceipt(envelope);
        if (!lost && envelope.update.includes('rv:SemanticChangedEvent')) {
          lost = true;
          throw new Error('lost semantic graph acknowledgement');
        }
        return result;
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const key = randomUUID();
    const body = { profile: 'semantic-change-v1', expectedHead: null, actingSubject: f.actor,
      state: { component: 'resource', types: ['https://schema.org/Person', 'https://schema.org/Patient'],
        properties: [] } };
    const first = await f.json<{ component: string; revision: string; receipt: string; replayed: boolean }>(
      await f.call('POST', '/v1/semantic/changes', body, key), 201);
    expect(lost).toBe(true);
    expect(first.replayed).toBe(false);
    const replay = await f.json<typeof first>(await f.call('POST', '/v1/semantic/changes', body, key), 201);
    expect(replay).toMatchObject({ component: first.component, revision: first.revision,
      receipt: first.receipt, replayed: true });
    const generation = await readNextMainOutboxBatch(original, f.env.lineage.dataEpoch, '0');
    expect(generation?.eventIds).toHaveLength(1);
    const change = await readNextMainOutboxBatch(original, f.env.lineage.dataEpoch, generation!.sequence);
    expect(change?.eventIds).toHaveLength(1);
    const event = await readMainOutboxEnvelope(original, change!, change!.eventIds[0]!);
    expect(event.data.receipt).toMatchObject({ id: first.receipt, action: 'semantic.change',
      outcome: 'succeeded', component: first.component, revision: first.revision });
    expect(await readNextMainOutboxBatch(original, f.env.lineage.dataEpoch, change!.sequence)).toBeNull();
    await f.grant(`semantic:read:${first.component}`, 'semantic.read');
    const exact = await f.json<{ component: string; revision: string }>(await f.call('GET',
      `/v1/semantic/resources/${shortId(first.component)}/revisions/${shortId(first.revision)}`
      + `?actingSubject=${encodeURIComponent(f.actor)}`), 200);
    expect(exact).toMatchObject({ component: first.component, revision: first.revision });
  } finally {
    f.env.fuseki = original;
    await f.close();
  }
}, 180_000);
