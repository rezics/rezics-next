import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { repairPublicNameBatch, PUBLIC_NAME_REPAIR_COST } from '../src/modules/search/names.ts';
import { backfillPublicNameProjections } from '../src/modules/search/backfill.ts';

const binding = (value: string) => ({ type: 'uri', value });
function fixture() {
  let pending = true;
  let cursor = 'urn:dependent:one';
  const commands: { receipt: string; update: string }[] = [];
  const queries: string[] = [];
  const env = {
    lineage: { dataEpoch: 'epoch', routingEpoch: 'route' },
    fuseki: {
      query: async (query: string, bytes: number) => {
        queries.push(query);
        expect(query).toContain('LIMIT 1');
        expect(query).not.toContain('ORDER BY');
        expect(bytes).toBe(PUBLIC_NAME_REPAIR_COST.responseBytes);
        return {
          results: {
            bindings: pending
              ? [
                  {
                    parent: binding('https://rezics.com/id/00000000-0000-4000-8000-000000000001'),
                    cursor: binding(cursor),
                    generation: binding('urn:receipt:parent'),
                  },
                ]
              : [],
          },
        };
      },
      commandWithReceipt: async (command: { receipt: string; update: string }) => {
        commands.push(command);
        return { status: 'committed' };
      },
    },
  } as unknown as WorkActivationEnvironment;
  const pool = {
    query: async () => ({ rows: [{ after_resource: 'inventory-end', complete: true }] }),
  } as unknown as Pool;
  return {
    env,
    pool,
    commands,
    queries,
    advance: () => {
      cursor = 'urn:dependent:two';
    },
    finish: () => {
      pending = false;
    },
  };
}
test('Name repair uses one durable bounded cursor and replays the same maintenance receipt', async () => {
  const f = fixture();
  expect(await repairPublicNameBatch(f.env)).toEqual({ complete: false });
  expect(await repairPublicNameBatch(f.env)).toEqual({ complete: false });
  expect(f.commands[1]!.receipt).toBe(f.commands[0]!.receipt);
  expect(f.commands[0]!.update).toContain('repair-maintenance');
  expect(f.commands[0]!.update).not.toContain('rv:nameResource');
  f.advance();
  await repairPublicNameBatch(f.env);
  expect(f.commands[2]!.receipt).not.toBe(f.commands[0]!.receipt);
  f.finish();
  expect(await repairPublicNameBatch(f.env)).toEqual({ complete: true });
  expect(f.commands).toHaveLength(3);
});
test('Name repair still runs after inventory migration completes and obeys the operator turn budget', async () => {
  const f = fixture();
  expect(await backfillPublicNameProjections(f.env, f.pool, 2)).toEqual({
    complete: false,
    processed: 0,
  });
  expect(f.commands).toHaveLength(2);
  f.finish();
  expect(await backfillPublicNameProjections(f.env, f.pool, 2)).toEqual({
    complete: true,
    processed: 0,
    after: 'inventory-end',
  });
  expect(f.commands).toHaveLength(2);
});
test('Name repair reports unavailable writer results and withholds malformed continuation state', async () => {
  const f = fixture();
  const failed = {
    ...f.env,
    fuseki: { ...f.env.fuseki, commandWithReceipt: async () => ({ status: 'guard-unmatched' }) },
  } as unknown as WorkActivationEnvironment;
  await expect(repairPublicNameBatch(failed)).rejects.toThrow('guard-unmatched');
  const malformed = {
    ...f.env,
    fuseki: {
      ...f.env.fuseki,
      query: async () => ({ results: { bindings: [{ parent: binding('urn:parent') }] } }),
    },
  } as unknown as WorkActivationEnvironment;
  await expect(repairPublicNameBatch(malformed)).rejects.toThrow('cursor is incomplete');
  expect(f.commands).toHaveLength(0);
});

test('A completed legacy name inventory is traversed again to seed bounded dependency repair', async () => {
  const checkpoints = new Map([
    ['agent-name-policy-v2', { after_resource: '', complete: true }],
    ['public-names-v2', { after_resource: 'legacy-end', complete: true }],
  ]);
  const pool = {
    query: async (sql: string, params: unknown[]) => {
      if (sql.startsWith('SELECT after_resource'))
        return {
          rows: checkpoints.has(String(params[1])) ? [checkpoints.get(String(params[1]))] : [],
        };
      if (sql.startsWith('INSERT INTO access.public_name_backfill_checkpoint')) {
        checkpoints.set(String(params[1]), {
          after_resource: String(params[2]),
          complete: Boolean(params[3]),
        });
        return { rows: [] };
      }
      throw new Error('Unexpected checkpoint query');
    },
  } as unknown as Pool;
  const queries: string[] = [];
  let commands = 0;
  const env = {
    lineage: { dataEpoch: 'epoch', routingEpoch: 'route' },
    fuseki: {
      query: async (query: string) => {
        queries.push(query);
        return { results: { bindings: [] } };
      },
      commandWithReceipt: async () => {
        commands++;
        return { status: 'committed' };
      },
    },
  } as unknown as WorkActivationEnvironment;
  expect((await backfillPublicNameProjections(env, pool, 1)).complete).toBe(true);
  expect(queries[0]).toContain('LIMIT 65');
  expect(queries[0]).not.toContain('legacy-end');
  expect(checkpoints.get('public-names-v3')?.complete).toBe(true);
  expect(commands).toBe(1);
});
