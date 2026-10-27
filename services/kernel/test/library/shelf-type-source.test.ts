import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { newId, partitionOf } from '../../src/route/route.ts';
import { observeShelfType } from '../../src/library/shelf-type-source.ts';
function harness() {
  const sql: string[] = [];
  const client = {
    query: async (text: string) => {
      sql.push(text);
      return { rows: [] };
    },
    release: () => sql.push('release'),
  };
  const pool = { connect: async () => client } as unknown as Pool;
  return { sql, client, pool };
}
test('source stamp type and one hop binding share the authoritative RR client', async () => {
  const h = harness(),
    id = newId(0x6a10),
    target = newId(0x7b20),
    position = 9007199254740993n;
  let partitionRead = false;
  const source = {
    readPartition: async (client: unknown, partition: number) => {
      expect(client).toBe(h.client);
      expect(partition).toBe(partitionOf(0x6a10));
      partitionRead = true;
      return {
        partitionNo: partition,
        node: 'local',
        writeState: 'active' as const,
        movedTo: null,
        epoch: 7,
        position,
      };
    },
    readItemTypes: async (client: unknown, ids: readonly string[]) => {
      expect(client).toBe(h.client);
      expect(partitionRead).toBe(true);
      expect(ids).toEqual([id]);
      return new Map([[id, 'schema:' + 'A'.repeat(8192)]]);
    },
    readSurvivor: async (client: unknown, subject: string) => {
      expect(client).toBe(h.client);
      expect(subject).toBe(id);
      return target;
    },
  };
  const got = await observeShelfType({ pool: h.pool, source }, id);
  expect(got.binding).toEqual({ sourceId: id, stamp: { partition: partitionOf(0x6a10), epoch: 7, position } });
  expect(got.source?.type).toBe('schema:' + 'A'.repeat(8192));
  expect(got.survivorId).toBe(target);
  expect(h.sql.some((s) => /BEGIN.*REPEATABLE READ.*READ ONLY/i.test(s))).toBe(true);
  expect(h.sql).toContain('COMMIT');
  expect(h.sql.at(-1)).toBe('release');
});
test('moved source rejects before semantic probes and rolls back', async () => {
  const h = harness(),
    id = newId(0x6a10);
  const source = {
    readPartition: async () => ({
      partitionNo: partitionOf(0x6a10),
      node: 'old',
      writeState: 'moved' as const,
      movedTo: 'new',
      epoch: 1,
      position: 4n,
    }),
    readItemTypes: async () => {
      throw new Error('must not read stale owner');
    },
    readSurvivor: async () => {
      throw new Error('must not read stale owner');
    },
  };
  await expect(observeShelfType({ pool: h.pool, source }, id)).rejects.toMatchObject({
    reason: 'moved',
    movedTo: 'new',
  });
  expect(h.sql).toContain('ROLLBACK');
  expect(h.sql.at(-1)).toBe('release');
});
