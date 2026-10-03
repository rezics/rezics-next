import { expect, spyOn, test } from 'bun:test';
import type { Pool, PoolClient } from 'pg';
import { AliasInvalid, AliasRegistry } from '../src/modules/address/registry.ts';
import { platformAliasAuthority } from '../src/modules/address/write.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { migrateGraphAliases, ALIAS_IMPORT_COST } from '../src/modules/address/migrate.ts';

test('G992: platform authority opens only Space reservation gates and is separate from name input', async () => {
  let probes = 0;
  const client = {
    query: async () => {
      probes++;
      return { rowCount: 1 };
    },
  } as unknown as PoolClient;
  const registry = new AliasRegistry({} as Pool);
  await expect(registry.assertAliasAllowed('space', 'mods', client)).rejects.toBeInstanceOf(
    AliasInvalid,
  );
  await registry.assertAliasAllowed('space', 'mods', client, true);
  for (const scope of [
    'agent',
    'work',
    'zone:https://rezics.com/id/00000000-0000-4000-8000-000000000001',
  ] as const)
    await expect(registry.assertAliasAllowed(scope, 'create', client, true)).rejects.toBeInstanceOf(
      AliasInvalid,
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
  expect(await platformAliasAuthority(env, 'agent', holder)).toBe(false);
  expect(await platformAliasAuthority(env, 'space', holder)).toBe(false);
  official = true;
  expect(await platformAliasAuthority(env, 'space', holder)).toBe(true);
  expect(calls).toBe(2);
});

test('G992: completed imports page every pending report once even when an entire page remains denied', async () => {
  const sources = Array.from(
    { length: ALIAS_IMPORT_COST.page + 1 },
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
      if (sql.includes('SELECT source,legacy_alias')) {
        expect(sql).toContain(`LIMIT ${ALIAS_IMPORT_COST.page}`);
        const page = sources.filter((source) => source > args[1]!).slice(0, ALIAS_IMPORT_COST.page);
        pages.push(page.length);
        return {
          rows: page.map((source) => ({
            source,
            legacy_alias: {
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
        if (sql.includes('INSERT INTO access.alias_graph_import_report')) attempted.push(args![1]!);
        return { rowCount: 1 };
      },
      release: () => {},
    }),
  } as unknown as Pool;
  const warning = spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const env = {
      addresses: new AliasRegistry(pool),
      lineage: { dataEpoch: 'epoch' },
      fuseki: { query: async () => ({ boolean: false }) },
    } as unknown as WorkActivationEnvironment;
    expect(await migrateGraphAliases(env)).toEqual({ status: 'complete' });
    expect(pages).toEqual([45, 1, 0]);
    expect(attempted).toEqual(sources);
  } finally {
    warning.mockRestore();
  }
});
