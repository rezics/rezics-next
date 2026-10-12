import { expect, test } from 'bun:test';
import { RelayHandoffIncomplete, verifiedRetainedRelayRange } from '../src/modules/outbox/relay.ts';
import { relayHandoffFixture } from './relay-handoff-support.ts';

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
    f.state.routing = 'new-routing';
    f.resetStats();
    if (history > 100) await expect(verifiedRetainedRelayRange(f.relay, 'relay', after))
      .rejects.toMatchObject({ sequence: '101' });
    else await verifiedRetainedRelayRange(f.relay, 'relay', after);
    expect(f.stats.headers).toBe(Math.min(history, 100));
    expect(f.stats.rows).toBeLessThanOrEqual(101);
    f.state.epoch = 'new-data-epoch';
    f.resetStats();
    if (history > 100) await expect(verifiedRetainedRelayRange(f.relay, 'relay', after))
      .rejects.toMatchObject({ dataEpoch: 'new-data-epoch', sequence: '101' });
    else await verifiedRetainedRelayRange(f.relay, 'relay', after);
    expect(f.stats.headers).toBe(Math.min(history, 100));
  }
  expect(observations[0]).toEqual(observations[1]);
});
