import { expect, test } from 'bun:test';
import { discoveryChanges } from '../src/modules/discovery/changes.ts';
import type { WorkReadSession } from '../src/modules/work/read-session.ts';
import { FusekiQueryResponseTooLarge } from '../src/infrastructure/fuseki.ts';

const value = (text: string) => ({ type: 'literal', value: text });
const event = (sequence: number, action = 'work.edit', ordinal = 0, count = 1) => ({
  sequence: value(String(sequence)), batch: value(`batch-${sequence}`), event: value(`event-${sequence}-${ordinal}`),
  count: value(String(count)), ordinal: value(String(ordinal)), action: value(action),
  work: value('https://rezics.com/id/00000000-0000-4000-8000-000000000001'),
});
const session = (rows: ReturnType<typeof event>[], sequence = '12') => ({ position: { dataEpoch: 'epoch', sequence },
  query: async () => rows }) as unknown as WorkReadSession;

test('Discovery deltas require every batch, event, ordinal and a known Work-local action', async () => {
  expect(await discoveryChanges(session([event(11, 'work.create'), event(12)]), '10')).toEqual({
    works: [event(11).work.value], created: [event(11).work.value] });
  expect(await discoveryChanges(session([event(11)]), '10')).toBeNull();
  expect(await discoveryChanges(session([event(11), event(12, 'context.update')]), '10')).toBeNull();
  expect(await discoveryChanges(session([event(11), event(12), event(12)]), '10')).toBeNull();
  expect(await discoveryChanges(session([event(11), event(12, 'work.edit', 1)]), '10')).toBeNull();
  expect(await discoveryChanges(session([event(11), event(12, 'work.edit', 0, 2)]), '10')).toBeNull();
  expect(await discoveryChanges(session([], '1011'), '10')).toBeNull();
  expect(await discoveryChanges(session([], '9'), '10')).toBeNull();
  expect(await discoveryChanges(session([], '10'), '10')).toEqual({ works: [], created: [] });
  const large = session([]);
  large.query = async () => { throw new FusekiQueryResponseTooLarge('oversized interval'); };
  expect(await discoveryChanges(large, '10')).toBeNull();
  large.query = async () => { throw new Error('offline'); };
  await expect(discoveryChanges(large, '10')).rejects.toThrow('offline');
});
