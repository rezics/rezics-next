import { expect, test } from 'bun:test';
import { RestoreDatabaseClones } from './restore-database-clones.ts';

test('clones keep the recovered cut immutable and dispose only their own databases', async () => {
  const sql: string[] = [];
  const owner = new RestoreDatabaseClones(async (port, statement) => {
    expect(port).toBe(5439);
    sql.push(statement);
  });
  const templates = { account: 'cut_account', access: 'cut_access' };
  const first = await owner.clone(5439, templates, 'first');
  const second = await owner.clone(5439, templates, 'second');
  expect(first).toEqual({ account: 'first_account', access: 'first_access' });
  expect(second).toEqual({ account: 'second_account', access: 'second_access' });
  expect(sql.slice(0, 4)).toEqual([
    'CREATE DATABASE first_account WITH TEMPLATE cut_account OWNER account',
    'CREATE DATABASE first_access WITH TEMPLATE cut_access OWNER access',
    'CREATE DATABASE second_account WITH TEMPLATE cut_account OWNER account',
    'CREATE DATABASE second_access WITH TEMPLATE cut_access OWNER access',
  ]);
  await owner.dispose(5439, first);
  await owner.dispose(5439, first);
  expect(owner.size).toBe(2);
  await owner.dispose(5440, second);
  expect(owner.size).toBe(2);
  for (const action of owner.cleanupActions()) await action.run();
  expect(owner.size).toBe(0);
  expect(sql.slice(4)).toEqual([
    'DROP DATABASE IF EXISTS first_account WITH (FORCE)',
    'DROP DATABASE IF EXISTS first_access WITH (FORCE)',
    'DROP DATABASE IF EXISTS second_access WITH (FORCE)',
    'DROP DATABASE IF EXISTS second_account WITH (FORCE)',
  ]);
  expect(templates).toEqual({ account: 'cut_account', access: 'cut_access' });
});

test('partial allocations and failed disposal remain owned until final cleanup succeeds', async () => {
  let fail = true;
  const owner = new RestoreDatabaseClones(async (_port, statement) => {
    if (fail && /second|DROP/.test(statement)) throw new Error('database unavailable');
  });
  await expect(owner.clone(5439, { account: 'cut_first', access: 'cut_second' }, 'copy'))
    .rejects.toThrow('database unavailable');
  expect(owner.size).toBe(2);
  await expect(owner.cleanupActions()[0]!.run()).rejects.toThrow('database unavailable');
  expect(owner.size).toBe(2);
  fail = false;
  for (const action of owner.cleanupActions()) await action.run();
  expect(owner.size).toBe(0);
});

test('rejects invalid or overlong identifiers before any database allocation', async () => {
  let calls = 0;
  const owner = new RestoreDatabaseClones(async () => { calls++; });
  for (const template of ['cut;drop', 'x'.repeat(64)]) {
    await expect(owner.clone(5439, { account: 'valid', access: template }, 'copy'))
      .rejects.toThrow('invalid restore database name');
  }
  expect(calls).toBe(0);
  expect(owner.size).toBe(0);
});
