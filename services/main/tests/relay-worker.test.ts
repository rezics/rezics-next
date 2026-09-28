import { expect, test } from 'bun:test';
import { RelayEventBlocked, isRelayTransientFailure } from '../src/modules/outbox/relay.ts';
import { runMainRelay } from '../src/modules/outbox/worker.ts';

test('relay retries timeouts and connection loss with bounded backoff, then resumes delivery', async () => {
  let calls = 0, running = true;
  const delays: number[] = [], logs: string[] = [];
  await runMainRelay(async () => {
    calls++;
    if (calls < 3) throw new Error(calls === 1 ? 'The operation timed out.' : 'connect ECONNRESET');
    return false;
  }, () => running, 100, {
    sleep: async delay => { delays.push(delay); if (calls === 3) running = false; },
    random: () => 0,
    log: line => { logs.push(line); },
  });
  expect(calls).toBe(3);
  expect(delays).toEqual([250, 500, 100]);
  expect(logs.map(line => JSON.parse(line).event)).toEqual(['main_relay_retry', 'main_relay_retry']);
  expect(isRelayTransientFailure(new Error('Fuseki query returned 503'))).toBe(true);
  expect(isRelayTransientFailure(new Error('The operation timed out.'))).toBe(true);
  expect(isRelayTransientFailure(new Error('invalid event receipt'))).toBe(false);
});

test('relay stops only for a blocked event', async () => {
  const blocked = new RelayEventBlocked({ batchId: 'batch', dataEpoch: 'epoch', sequence: '1',
    routingEpoch: 'routing', eventIds: ['event'] }, 'event', 'invalid receipt');
  const delays: number[] = [];
  await expect(runMainRelay(async () => { throw blocked; }, () => true, 100, {
    sleep: async delay => { delays.push(delay); }, random: () => 0, log: () => {},
  })).rejects.toBe(blocked);
  expect(delays).toEqual([]);
});

test('relay retry delay stays capped during an extended outage', async () => {
  let attempts = 0, running = true;
  const delays: number[] = [];
  await runMainRelay(async () => { attempts++; throw new Error('Fuseki query returned 503'); },
    () => running, 100, { random: () => 1, log: () => {}, sleep: async delay => {
      delays.push(delay);
      if (attempts === 10) running = false;
    } });
  expect(delays.at(-1)).toBe(30_000);
  expect(Math.max(...delays)).toBe(30_000);
});
