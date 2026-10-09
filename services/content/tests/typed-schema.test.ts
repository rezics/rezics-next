import { expect, test } from 'bun:test';
import { getTableConfig } from 'drizzle-orm/pg-core';
import * as schema from '../src/typed-schema.ts';

test('Content typed queries declare only the owner-control row they read', () => {
  expect(Object.keys(schema)).toEqual(['ownerControl']);
  const config = getTableConfig(schema.ownerControl);
  expect(config.schema).toBe('content');
  expect(config.name).toBe('owner_control');
  expect(config.columns.map(column => column.name).sort()).toEqual(['data_epoch', 'sequence', 'singleton']);
  const byName = new Map(config.columns.map(column => [column.name, column]));
  expect(byName.get('singleton')?.getSQLType()).toBe('boolean');
  expect(byName.get('data_epoch')?.notNull).toBe(true);
  expect(byName.get('data_epoch')?.getSQLType()).toBe('uuid');
  expect(byName.get('sequence')?.notNull).toBe(true);
  expect(byName.get('sequence')?.getSQLType()).toBe('bigint');
  const key = config.primaryKeys[0]?.columns.map(column => column.name)
    ?? config.columns.filter(column => column.primary).map(column => column.name);
  expect(key).toEqual(['singleton']);
});
