import { expect, spyOn, test } from 'bun:test';
import { reconcileRelayGap } from '../src/modules/owner/relay-gap.ts';
import { classifyDeliveredRelayBatch } from '../src/modules/outbox/relay.ts';
import { MAIN_RELAY_STREAM_SCOPE } from '../src/modules/outbox/relay-position.ts';
import { ZoneBrowseProjection } from '../src/modules/zone-browse/store.ts';
import { WorkReadUnavailable } from '../src/modules/work/read-session.ts';
import { relayHandoffFixture } from './relay-handoff-support.ts';

const callers = [{ name: 'tick', finding: 1 }, { name: 'startup', finding: 2 }, { name: 'operator', finding: 3 }] as const;
const states = ['complete', 'incomplete-healing', 'gap-conflict'] as const;
for (const caller of callers) for (const boundary of states) {
  test(`finding ${caller.finding}: ${caller.name} classifies ${boundary} at the same handoff boundary`, async () => {
    for (const missing of ['header', 'events']) {
      const f = relayHandoffFixture();
      if (boundary === 'incomplete-healing') (missing === 'header' ? f.state.missing : f.state.partial).add(1);
      if (boundary === 'gap-conflict') f.state.excess.add(1);
      expect((await classifyDeliveredRelayBatch(f.relay, { streamScope: MAIN_RELAY_STREAM_SCOPE,
        dataEpoch: 'epoch', sequence: '1' })).state).toBe(boundary);
      const errors: string[] = [];
      const error = spyOn(console, 'error').mockImplementation(line => { errors.push(String(line)); });
      try {
        if (caller.name === 'operator') {
          expect(await reconcileRelayGap(f.relay, f.access, { consumer: 'reader', relayConsumer: 'relay',
            dataEpoch: 'epoch', afterSequence: '0', throughSequence: '1' }, 'boundary')).toMatchObject({
            state: boundary === 'complete' ? 'reconciled' : 'held',
            disposition: boundary === 'complete' ? 'rebuilt' : 'gap',
          });
          expect(f.ledger.state).not.toBe('running');
          expect(errors).toEqual([]);
          continue;
        }
        const projection = new ZoneBrowseProjection(f.access, f.relay, f.env, 'relay');
        const internal = projection as unknown as { usableCut: boolean };
        internal.usableCut = caller.name === 'tick';
        if (boundary === 'gap-conflict') {
          await expect(projection.tick()).rejects.toBeInstanceOf(WorkReadUnavailable);
          expect(projection.recoveryStatus().checkpoint.sequence).toBe('0');
          continue;
        }
        await projection.tick();
        if (boundary === 'incomplete-healing') {
          expect(projection.recoveryStatus()).toMatchObject({ state: 'incomplete-healing',
            checkpoint: { sequence: '0' }, deferral: { code: 'main_relay_handoff_incomplete', retries: 1, intervalMs: 500 } });
          expect(await projection.current({ dataEpoch: 'epoch', sequence: '10' })).toBe(false);
          expect(await projection.batch('realm', 'newest', null)).toEqual([]);
          expect(errors).toEqual([]);
          f.state.missing.clear(); f.state.partial.clear();
        }
        for (let poll = 0; poll < 3; poll++) await projection.tick();
        expect(projection.recoveryStatus()).toMatchObject({ state: 'ready', checkpoint: { sequence: '1' } });
        expect(await projection.current({ dataEpoch: 'epoch', sequence: '10' })).toBe(true);
        expect(errors).toEqual([]);
      } finally { error.mockRestore(); }
    }
  });
}

test('finding 4: foreign consumer positions are validated before startup or tick uses their sequence', async () => {
  for (const caller of ['tick', 'startup']) for (const foreign of ['scope', 'epoch'] as const) {
    const f = relayHandoffFixture();
    f.state[foreign] = 'foreign';
    const projection = new ZoneBrowseProjection(f.access, f.relay, f.env, 'relay');
    (projection as unknown as { usableCut: boolean }).usableCut = caller === 'tick';
    await expect(projection.tick()).rejects.toBeInstanceOf(WorkReadUnavailable);
    expect(projection.recoveryStatus().checkpoint.sequence).toBe('0');
    expect(await projection.current({ dataEpoch: 'epoch', sequence: '10' })).toBe(false);
    expect(f.queries.some(sql => /WHERE stream_scope =.*relay.checkpoint/s.test(sql))).toBe(false);
  }
});

test('finding 2: startup retains its checkpoint behind an acknowledged partial second batch over repeated polls', async () => {
  const f = relayHandoffFixture(2);
  f.state.partial.add(2);
  const projection = new ZoneBrowseProjection(f.access, f.relay, f.env, 'relay');
  for (let poll = 0; poll < 3; poll++) {
    await projection.tick();
    expect(projection.recoveryStatus()).toMatchObject({ state: 'incomplete-healing',
      checkpoint: { sequence: '0' }, deferral: { retries: poll + 1 } });
    expect(await projection.current({ dataEpoch: 'epoch', sequence: '10' })).toBe(false);
  }
  f.state.partial.clear();
  await projection.tick(); await projection.tick();
  expect(projection.recoveryStatus()).toMatchObject({ state: 'ready', checkpoint: { sequence: '2' } });
});
