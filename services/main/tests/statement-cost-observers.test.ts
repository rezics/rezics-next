import { expect, test } from 'bun:test';
import type { PoolClient } from 'pg';
import { measureStatements, observeStatementClient } from '../src/infrastructure/statement-cost.ts';

test('an observed pooled client retains driver hooks installed after its first checkout', async () => {
  let calls = 0, laterCalls = 0;
  class Client {
    async query(text: string) { calls++; return text; }
  }
  const client = new Client();
  observeStatementClient(client as unknown as PoolClient);
  const original = Client.prototype.query;
  Client.prototype.query = function (text) { laterCalls++; return original.call(this, text); };
  const measured = await measureStatements(() => client.query('SELECT 1'));
  expect(measured).toEqual({ result: 'SELECT 1', statements: 1 });
  expect(calls).toBe(1);
  expect(laterCalls).toBe(1);
});

test('an observed client preserves its own query override and counts forwarding once', async () => {
  const delegate = { query: async (text: string) => text };
  observeStatementClient(delegate as unknown as PoolClient);
  const client = { query: (text: string) => delegate.query(text) };
  observeStatementClient(client as unknown as PoolClient);
  expect(await measureStatements(() => client.query('SELECT 2')))
    .toEqual({ result: 'SELECT 2', statements: 1 });
});
