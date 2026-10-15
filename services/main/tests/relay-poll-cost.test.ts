import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { RelayHandoffIncomplete, verifiedRetainedRelayRange } from '../src/modules/outbox/relay.ts';
import { relayHandoffFixture } from './relay-handoff-support.ts';

function restartedPool(pool: Pool): Pool {
  return { connect: pool.connect.bind(pool) } as Pool;
}

test('finding 6: caught-up polls and ahead-cursor retries read constant statements and rows at 10 and 1000 batches', async () => {
  const observations = [];
  for (const history of [10, 1000]) {
    const f = relayHandoffFixture(history);
    await expect(verifiedRetainedRelayRange(f.relay, 'relay', String(history + 1)))
      .rejects.toBeInstanceOf(RelayHandoffIncomplete);
    const coldAhead = { ...f.stats };
    expect(coldAhead).toEqual({ statements: 3, rows: 1, headers: 0 });
    let after = '0';
    while (Number(after) < history) {
      const page = await verifiedRetainedRelayRange(f.relay, 'relay', after);
      expect(page.batches.length).toBeLessThanOrEqual(100);
      after = page.batches.at(-1)!.sequence;
    }
    f.resetStats();
    expect((await verifiedRetainedRelayRange(f.relay, 'relay', after)).batches).toEqual([]);
    const idle = { ...f.stats };
    expect(idle).toEqual({ statements: 3, rows: 1, headers: 0 });
    f.resetStats();
    await expect(verifiedRetainedRelayRange(f.relay, 'relay', String(history + 1)))
      .rejects.toBeInstanceOf(RelayHandoffIncomplete);
    const ahead = { ...f.stats };
    expect(ahead.headers).toBe(0);
    observations.push({ coldAhead, idle, ahead });
    // A cold process and an epoch transition both seek from the durable
    // downstream cursor; neither replays already consumed history.
    for (const transition of ['cold', 'routing', 'data']) {
      if (transition === 'routing') f.state.routing = 'new-routing';
      if (transition === 'data') f.state.epoch = 'new-data-epoch';
      const coldPool = restartedPool(f.relay);
      f.resetStats();
      expect((await verifiedRetainedRelayRange(coldPool, 'relay', after)).batches).toEqual([]);
      expect(f.stats).toEqual({ statements: 3, rows: 1, headers: 0 });
    }
  }
  expect(observations[0]).toEqual(observations[1]);
});

test('restored downstream delivery seeks only its backlog, defers a partial boundary and delivers every event once', async () => {
  for (const history of [10, 1000]) {
    const f = relayHandoffFixture(history);
    const afterRestore = history - 5;
    let after = String(afterRestore);
    for (let sequence = afterRestore + 1; sequence <= history; sequence++) f.state.completeEvents.add(sequence);
    f.state.partial.add(afterRestore + 3);
    f.state.completeEvents.delete(afterRestore + 3);
    await expect(verifiedRetainedRelayRange(f.relay, 'relay', after, 2)).resolves.toMatchObject({
      batches: [{ sequence: String(afterRestore + 1) }, { sequence: String(afterRestore + 2) }],
    });
    after = String(afterRestore + 2);
    f.resetStats();
    await expect(verifiedRetainedRelayRange(f.relay, 'relay', after, 2))
      .rejects.toMatchObject({ name: 'RelayHandoffIncomplete', sequence: String(afterRestore + 3) });
    expect(f.stats.headers).toBe(1);
    f.state.partial.clear(); f.state.completeEvents.add(afterRestore + 3);
    const delivered = [`event-${afterRestore + 1}`, `event-${afterRestore + 2}`];
    while (Number(after) < history) {
      f.resetStats();
      // Restart the reader for each page, with only its restored cursor retained.
      const page = await verifiedRetainedRelayRange(restartedPool(f.relay), 'relay', after, 2);
      expect(f.stats.headers).toBeLessThanOrEqual(2);
      delivered.push(...page.batches.flatMap(batch => batch.events.map(event => event.id)));
      after = page.batches.at(-1)!.sequence;
    }
    expect(delivered).toEqual(Array.from({ length: 5 }, (_, index) => `event-${afterRestore + index + 1}`));
    expect(new Set(delivered).size).toBe(5);
    f.resetStats();
    expect((await verifiedRetainedRelayRange(restartedPool(f.relay), 'relay', after)).batches).toEqual([]);
    expect(f.stats).toEqual({ statements: 3, rows: 1, headers: 0 });
  }
});
