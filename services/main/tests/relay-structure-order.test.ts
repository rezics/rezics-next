import { expect, test } from 'bun:test';
import type { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { OutboxIncomplete, readNextMainOutboxBatch } from '../src/modules/outbox/relay.ts';

const chapter = 'urn:rezics:event:3463821910e74e3ae7525416da8b9ee67cda02bf615afdc060a4227abb89b76b';
const structure = 'urn:rezics:event:852df88c7f2542ab3fba3f27fdb097786ba5a01d03e739837eaa15bbdfd03a6e';
const batch = 'urn:rezics:outbox:83d9d2f585897b8bd9e8b5b0b7fe0d9855cfd8bc368795cda2b3bed83bc1f39c';
const epoch = '8c483e38-59e7-4d95-b27b-de9cd6742a3e';
const binding = (value: string) => ({ type: 'literal', value });

test('G-320: chapter batch 328 follows stored ordinals even when event IDs sort in reverse', async () => {
  const members = [
    { event: binding(chapter), ordinal: binding('1') },
    { event: binding(structure), ordinal: binding('0') },
  ];
  const queries: string[] = [];
  const fuseki = { query: async (query: string) => {
    queries.push(query);
    if (queries.length === 1) return { results: { bindings: [{ controlSequence: binding('328'), graphSequence: binding('1328'),
      routing: binding('route-1'), batch: binding(batch), eventCount: binding('2') }] } };
    if (queries.length === 2) return { results: { bindings: members } };
    return { boolean: true };
  } } as unknown as FusekiClient;
  const read = await readNextMainOutboxBatch(fuseki, epoch, '327');
  expect(read?.graphSequence).toBe('1328');
  expect(read?.sequence).toBe('328');
  expect(read?.eventIds).toEqual([structure, chapter]);
  expect(queries[1]).toContain('?event rv:ordinal ?ordinal');

  members[1]!.ordinal = binding('1');
  queries.length = 0;
  await expect(readNextMainOutboxBatch(fuseki, epoch, '327'))
    .rejects.toBeInstanceOf(OutboxIncomplete);
});
