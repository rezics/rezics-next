import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { repairJoiningFixtureConsent } from '../src/modules/access/join-fixture-consent.ts';

function fixture(
  options: {
    prior?: 'active' | 'revoked';
    controller?: boolean;
    gate?: boolean;
    recovery?: boolean;
  } = {},
) {
  const statements: string[] = [];
  let granted = !!options.prior,
    inserted = 0,
    released = 0;
  const client = {
    release() {
      released++;
    },
    query: async (sql: string, values?: unknown[]) => {
      statements.push(sql);
      if (sql.includes('access.recovery_fence'))
        return { rows: [], rowCount: options.recovery === false ? 0 : 1 };
      if (sql.includes('access.scope_gate'))
        return { rows: [], rowCount: options.gate === false ? 0 : 1 };
      if (sql.includes('FROM access.agent_provision'))
        return { rows: options.controller === false ? [] : [{ valid_until: 'infinity' }] };
      if (sql.includes('SELECT id FROM access.permission_grant')) {
        // An inactive grant is retained revocation evidence, not a missing grant.
        expect(sql).not.toMatch(/\bactive\b/);
        return { rows: granted ? [{ id: 'retained-grant' }] : [], rowCount: granted ? 1 : 0 };
      }
      if (sql.includes('INSERT INTO access.permission_grant')) {
        expect(values?.slice(1)).toEqual(['agent', 'infinity', 'principal']);
        granted = true;
        inserted++;
      }
      return { rows: [], rowCount: 1 };
    },
  };
  return {
    pool: { connect: async () => client } as unknown as Pool,
    statements,
    inserted: () => inserted,
    released: () => released,
  };
}

test('G-1005: fixture repair supplies a missing consent grant once, without replacing active or revoked grants', async () => {
  const missing = fixture();
  expect(await repairJoiningFixtureConsent(missing.pool, 'principal', 'agent')).toBe(true);
  expect(missing.statements.length).toBeLessThanOrEqual(9);
  expect(await repairJoiningFixtureConsent(missing.pool, 'principal', 'agent')).toBe(false);
  expect(missing.inserted()).toBe(1);
  expect(missing.released()).toBe(2);
  for (const prior of ['active', 'revoked'] as const) {
    const retained = fixture({ prior });
    expect(await repairJoiningFixtureConsent(retained.pool, 'principal', 'agent')).toBe(false);
    expect(retained.inserted()).toBe(0);
  }
});

test('G-1005: fixture repair cannot grant consent without its original live person controller or open recovery/root gates', async () => {
  const uncontrolled = fixture({ controller: false });
  expect(await repairJoiningFixtureConsent(uncontrolled.pool, 'principal', 'agent')).toBe(false);
  expect(uncontrolled.inserted()).toBe(0);
  for (const options of [{ gate: false }, { recovery: false }]) {
    const closed = fixture(options);
    await expect(repairJoiningFixtureConsent(closed.pool, 'principal', 'agent')).rejects.toThrow(
      'Local membership authority is unavailable',
    );
    expect(closed.inserted()).toBe(0);
    expect(closed.statements.at(-1)).toBe('ROLLBACK');
    expect(closed.released()).toBe(1);
  }
});
