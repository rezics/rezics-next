import { expect, spyOn, test } from 'bun:test';
import type { Pool } from 'pg';
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
      const f = relayHandoffFixture(3);
      if (boundary === 'incomplete-healing') (missing === 'header' ? f.state.missing : f.state.partial).add(3);
      if (boundary === 'gap-conflict') f.state.excess.add(3);
      expect((await classifyDeliveredRelayBatch(f.relay, { streamScope: MAIN_RELAY_STREAM_SCOPE,
        dataEpoch: 'epoch', sequence: '3' })).state).toBe(boundary);
      const errors: string[] = [];
      const error = spyOn(console, 'error').mockImplementation(line => { errors.push(String(line)); });
      try {
        if (caller.name === 'operator') {
          f.accessPosition.sequence = '2';
          expect(await reconcileRelayGap(f.relay, f.access, { consumer: 'reader', relayConsumer: 'relay',
            dataEpoch: 'epoch', afterSequence: '2', throughSequence: '3' }, 'boundary')).toMatchObject({
            state: boundary === 'complete' ? 'reconciled' : 'held',
            disposition: boundary === 'complete' ? 'rebuilt' : 'gap',
          });
          expect(f.ledger.state).not.toBe('running');
          expect(errors).toEqual([]);
          continue;
        }
        const projection = new ZoneBrowseProjection(f.access, f.relay, f.env, 'relay');
        const internal = projection as unknown as { usableCut: boolean; checkpoint: { streamScope: string; dataEpoch: string; sequence: string } };
        internal.checkpoint = { streamScope: MAIN_RELAY_STREAM_SCOPE, dataEpoch: 'epoch', sequence: '2' };
        internal.usableCut = caller.name === 'tick';
        if (boundary === 'gap-conflict') {
          await expect(projection.tick()).rejects.toBeInstanceOf(WorkReadUnavailable);
          expect(projection.recoveryStatus().checkpoint.sequence).toBe('2');
          continue;
        }
        await projection.tick();
        if (boundary === 'incomplete-healing') {
          expect(projection.recoveryStatus()).toMatchObject({ state: 'incomplete-healing',
            checkpoint: { sequence: '2' }, deferral: { code: 'main_relay_handoff_incomplete', retries: 1, intervalMs: 500 } });
          expect(await projection.current({ dataEpoch: 'epoch', sequence: '10' })).toBe(false);
          expect(await projection.batch('realm', 'newest', null)).toEqual([]);
          expect(errors).toEqual([]);
          f.state.missing.clear(); f.state.partial.clear();
        }
        for (let poll = 0; poll < 3; poll++) await projection.tick();
        expect(projection.recoveryStatus()).toMatchObject({ state: 'ready', checkpoint: { sequence: '3' } });
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

test('finding 3: a complete operator window is reconciled independently of a cold poll watermark', async () => {
  for (const history of [10, 1000]) {
    const f = relayHandoffFixture(history);
    f.accessPosition.sequence = String(history - 1);
    expect(await reconcileRelayGap(f.relay, f.access, { consumer: 'reader', relayConsumer: 'relay',
      dataEpoch: 'epoch', afterSequence: String(history - 1), throughSequence: String(history) }, 'cold-window'))
      .toMatchObject({ state: 'reconciled', disposition: 'rebuilt' });
    expect(f.accessPosition.sequence).toBe(String(history));
    expect(f.stats.headers).toBe(1);
  }
});

test('startup validates retained event envelopes as strictly as live range delivery', async () => {
  const f = relayHandoffFixture(1);
  f.state.completeEvents.add(1);
  const query = f.relay.query.bind(f.relay);
  const checkedQuery = async (sql: string, values: unknown[]) => {
    const result = await query<{ envelope: { data: { ordinal: number } } }>(sql, values);
    if (sql.includes('SELECT envelope FROM relay.delivered_event')) {
      for (const row of result.rows) row.envelope.data.ordinal = 9;
    }
    return result;
  };
  const relay = { query: checkedQuery, connect: async () => ({ query: checkedQuery, release() {} }) } as unknown as Pool;
  const projection = new ZoneBrowseProjection(f.access, relay, f.env, 'relay');
  const error = spyOn(console, 'error').mockImplementation(() => {});
  try {
    await expect(projection.tick()).rejects.toThrow('retained event envelope differs');
    expect(projection.recoveryStatus().checkpoint.sequence).toBe('0');
    expect(await projection.current({ dataEpoch: 'epoch', sequence: '10' })).toBe(false);
  } finally { error.mockRestore(); }
});

test('the no-consumer fallback selects only the current Main stream and recovery epoch', async () => {
  const f = relayHandoffFixture(2);
  const query = f.relay.query.bind(f.relay);
  const positions = [
    { stream_scope: MAIN_RELAY_STREAM_SCOPE, data_epoch: 'epoch', sequence: '2' },
    { stream_scope: 'urn:rezics:stream:other', data_epoch: 'epoch', sequence: '1000' },
    { stream_scope: MAIN_RELAY_STREAM_SCOPE, data_epoch: 'prior-epoch', sequence: '2000' },
  ];
  let probes = 0;
  const checkedQuery = async (sql: string, values: unknown[]) => {
    if (sql.includes('FROM relay.checkpoint')) {
      probes++;
      expect(sql).toContain('WHERE stream_scope = $1 AND data_epoch = $2');
      expect(values).toEqual([MAIN_RELAY_STREAM_SCOPE, 'epoch']);
      return { rows: positions.filter(position => position.stream_scope === values[0] && position.data_epoch === values[1]) };
    }
    return query(sql, values);
  };
  const relay = { query: checkedQuery, connect: async () => ({ query: checkedQuery, release() {} }) } as unknown as Pool;
  const projection = new ZoneBrowseProjection(f.access, relay, f.env);
  for (let poll = 0; poll < 3; poll++) await projection.tick();
  expect(projection.recoveryStatus()).toMatchObject({ state: 'ready', checkpoint: { sequence: '2' } });
  expect(probes).toBeGreaterThan(0);
});
