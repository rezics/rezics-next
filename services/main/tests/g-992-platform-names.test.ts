import { expect, spyOn, test } from 'bun:test';
import type { Pool, PoolClient } from 'pg';
import { NameInvalid, NameRegistry } from '../src/modules/address/registry.ts';
import { platformNameAuthority } from '../src/modules/address/write.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { migrateGraphNames, NAME_IMPORT_COST } from '../src/modules/address/migrate.ts';

test('G992: platform authority opens only Space reservation gates and is separate from name input', async () => {
  let probes = 0;
  const client = {
    query: async () => {
      probes++;
      return { rowCount: 1 };
    },
  } as unknown as PoolClient;
  const registry = new NameRegistry({} as Pool);
  await expect(registry.assertNameAllowed('space', 'mods', client)).rejects.toBeInstanceOf(
    NameInvalid,
  );
  await registry.assertNameAllowed('space', 'mods', client, true);
  for (const scope of [
    'agent',
    'work',
    'zone:https://rezics.com/id/00000000-0000-4000-8000-000000000001',
  ] as const)
    await expect(registry.assertNameAllowed(scope, 'create', client, true)).rejects.toBeInstanceOf(
      NameInvalid,
    );
  expect(probes).toBe(4);
});

test('G992: Main proves official status for the exact Space holder in one bounded graph read', async () => {
  const holder = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
  let calls = 0;
  let official = false;
  const env = {
    fuseki: {
      query: async (query: string, bytes: number) => {
        calls++;
        expect(query).toContain(`<${holder}> a rv:Space`);
        expect(query).toContain(`rv:space <${holder}>`);
        expect(query).toContain('rv:official true');
        expect(bytes).toBe(1024);
        return { boolean: official };
      },
    },
  } as unknown as WorkActivationEnvironment;
  expect(await platformNameAuthority(env, 'agent', holder)).toBe(false);
  expect(await platformNameAuthority(env, 'space', holder)).toBe(false);
  official = true;
  expect(await platformNameAuthority(env, 'space', holder)).toBe(true);
  expect(calls).toBe(2);
});

test('G992: completed imports page every pending report once even when an entire page remains denied', async () => {
  const sources = Array.from(
    { length: NAME_IMPORT_COST.page + 1 },
    (_, index) =>
      `https://rezics.com/id/00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  );
  const binding = (value: string) => ({ type: 'literal', value });
  const attempted: string[] = [];
  const pages: number[] = [];
  const pool = {
    query: async (sql: string, args: string[]) => {
      if (sql.includes('SELECT cursor,completed_at'))
        return { rows: [{ completed_at: new Date() }] };
      if (sql.includes('recovery_fence')) return { rowCount: 1 };
      if (sql.includes('SELECT source,legacy_name')) {
        expect(sql).toContain(`LIMIT ${NAME_IMPORT_COST.page}`);
        const page = sources.filter((source) => source > args[1]!).slice(0, NAME_IMPORT_COST.page);
        pages.push(page.length);
        return {
          rows: page.map((source) => ({
            source,
            legacy_name: {
              source: binding(source),
              scope: binding('work'),
              kind: binding('work'),
              holder: binding(source),
              controller: binding(source),
              state: binding('current'),
              key: binding('1'.repeat(22)),
            },
          })),
        };
      }
      throw new Error(`Unexpected pool query: ${sql}`);
    },
    connect: async () => ({
      query: async (sql: string, args?: string[]) => {
        if (sql.includes('INSERT INTO access.name_graph_import_report')) attempted.push(args![1]!);
        return { rowCount: 1 };
      },
      release: () => {},
    }),
  } as unknown as Pool;
  const warning = spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const env = {
      addresses: new NameRegistry(pool),
      lineage: { dataEpoch: 'epoch' },
      fuseki: { query: async () => ({ boolean: false }) },
    } as unknown as WorkActivationEnvironment;
    expect(await migrateGraphNames(env)).toEqual({ status: 'complete' });
    expect(pages).toEqual([45, 1, 0]);
    expect(attempted).toEqual(sources);
  } finally {
    warning.mockRestore();
  }
});
