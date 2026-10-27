import { expect, test } from 'bun:test';
import * as contract from '../services/kernel/src/library/shelf-contract.ts';

const owner = '00000000-0000-7000-8000-111100000001';
const other = '00000000-0000-7000-8000-111100000002';
const typeKey = '00000000-0000-7000-8000-111100000010';
const module = contract as unknown as Record<string, unknown>;
const query = { state: 'planned', typeKey, orderBy: 'lastActivity', direction: 'desc', limit: 48 };

test('shelf cursor binding carries route owner every effective filter and page size', () => {
  const bind = module.shelfCursorBinding as ((account: string, query: typeof query) => unknown) | undefined;
  expect(bind).toBeFunction();
  const actual = bind!(owner, query);
  expect(actual).toEqual({ route: 'GET /v1/libraryEntries', viewer: owner, query });
  expect(bind!(other, query)).not.toEqual(actual);
  expect(bind!(owner, { ...query, limit: 1 })).not.toEqual(actual);
  expect(bind!(owner, { ...query, typeKey: other })).not.toEqual(actual);
});

test('type facet binding is a different list with owner and page size', () => {
  const bind = module.shelfTypeCursorBinding as ((account: string, limit: number) => unknown) | undefined;
  expect(bind).toBeFunction();
  expect(bind!(owner, 20)).toEqual({ route: 'GET /v1/libraryShelfTypes', viewer: owner, query: { limit: 20 } });
  expect(bind!(owner, 100)).not.toEqual(bind!(owner, 20));
  expect(bind!(other, 20)).not.toEqual(bind!(owner, 20));
});

test('shelf helpers do not impose a source type identifier cap', () => {
  expect(module).not.toHaveProperty('MAX_SHELF_TYPE_LENGTH');
});
