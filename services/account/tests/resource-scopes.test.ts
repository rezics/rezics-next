import { expect, test } from 'bun:test';
import { reconcileResourceScopes } from '../src/resource-scopes.ts';

test('startup replaces a stale resource scope ceiling with the installed scopes', async () => {
  const calls: unknown[][] = [];
  const pool = { query: async (sql: string, params: unknown[]) => { calls.push([sql, params]); return { rowCount: 1 }; } };
  expect(await reconcileResourceScopes(pool as never, 'https://main.rezics.test', ['openid', 'follow:read'])).toBe(true);
  expect(calls[0]![1]).toEqual([JSON.stringify(['openid', 'follow:read']), 'https://main.rezics.test']);
  expect(String(calls[0]![0])).toContain('IS DISTINCT FROM');
});

test('an unchanged or not yet created resource row is left alone', async () => {
  const pool = { query: async () => ({ rowCount: 0 }) };
  expect(await reconcileResourceScopes(pool as never, 'https://main.rezics.test', ['openid'])).toBe(false);
});
