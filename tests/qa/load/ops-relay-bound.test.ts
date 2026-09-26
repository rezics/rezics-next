import { expect, test } from 'bun:test';
import type { FusekiClient, SparqlResult } from '../../../services/main/src/infrastructure/fuseki.ts';
import { OutboxGap, OutboxIncomplete, OutboxRecoveryHold,
  readNextMainOutboxBatch } from '../../../services/main/src/modules/outbox/relay.ts';

const binding = (value: string) => ({ type: 'literal', value });
const epoch = '00000000-0000-4000-8000-000000000001';
const routing = '00000000-0000-4000-8000-000000000002';
const batch = 'urn:rezics:outbox:bounded';

function source(highWater: string, headers: Array<{ batch: string; count: string }>,
  hold = false) {
  const queries: string[] = [];
  const fuseki = { query: async (query: string): Promise<SparqlResult> => {
    queries.push(query);
    if (queries.length === 1) return { results: { bindings: (headers.length ? headers : [undefined])
      .map(header => ({ controlSequence: binding(highWater), routing: binding(routing),
        ...(hold ? { hold: binding('true') } : {}),
        ...(header ? { batch: binding(header.batch), eventCount: binding(header.count) } : {}),
      })) } } as SparqlResult;
    return { results: { bindings: [] } } as SparqlResult;
  } } as FusekiClient;
  return { fuseki, queries };
}

test('OPS05: next relay batch seeks one indexed sequence regardless of unrelated backlog', async () => {
  for (const highWater of ['1', '100', '100000']) {
    const { fuseki, queries } = source(highWater, [{ batch, count: '0' }]);
    const result = await readNextMainOutboxBatch(fuseki, epoch, '0');
    expect(result).toEqual({ batchId: batch, dataEpoch: epoch, sequence: '1',
      routingEpoch: routing, eventIds: [] });
    expect(queries).toHaveLength(2); // one snapshot, then zero-member read
    expect(queries[0]).toContain('LIMIT 2');
    expect(queries[0]).toContain('?batch rv:sequence 1');
    expect(queries[0]).not.toMatch(/ORDER BY|FILTER\s*\(\?sequence\s*>/);
  }
});

test('OPS05: relay preserves idle, missing, duplicate and recovery-hold outcomes', async () => {
  const idle = source('0', []);
  expect(await readNextMainOutboxBatch(idle.fuseki, epoch, '0')).toBeNull();
  expect(idle.queries).toHaveLength(1);
  await expect(readNextMainOutboxBatch(source('2', []).fuseki, epoch, '0'))
    .rejects.toBeInstanceOf(OutboxGap);
  await expect(readNextMainOutboxBatch(source('2', [{ batch, count: '0' },
    { batch: `${batch}-other`, count: '0' }]).fuseki, epoch, '0'))
    .rejects.toBeInstanceOf(OutboxIncomplete);
  const held = source('1', [{ batch, count: '0' }], true);
  await expect(readNextMainOutboxBatch(held.fuseki, epoch, '0'))
    .rejects.toBeInstanceOf(OutboxRecoveryHold);
  expect(held.queries).toHaveLength(1);
});
