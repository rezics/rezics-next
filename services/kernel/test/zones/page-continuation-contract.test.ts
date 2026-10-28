import { expect, test } from 'bun:test';
import { Compile } from 'typebox/compile';
import { ZonePageRequestSchema } from '../../src/zones/contract.ts';
import { ZonePageQuerySchema, ZonePageReadProgressSchema } from '../../src/zones/page-continuation.ts';

test('Zone readPage progress is a separate closed 202 body and its cursor stays in query', () => {
  const query = Compile(ZonePageQuerySchema);
  expect(query.Check({})).toBe(true);
  expect(query.Check({ cursor: 'opaque-token' })).toBe(true);
  expect(query.Check({ cursor: 'x'.repeat(4864) })).toBe(true);
  expect(query.Check({ cursor: 'token=' })).toBe(false);
  expect(query.Check({ cursor: '' })).toBe(false);
  expect(query.Check({ cursor: ['a', 'b'] })).toBe(false);
  expect(query.Check({ cursor: 1 })).toBe(false);
  expect(query.Check({ cursor: 'x'.repeat(4865) })).toBe(false);
  expect(query.Check({ cursor: 'token', ownerId: 'private' })).toBe(false);
  const progress = Compile(ZonePageReadProgressSchema);
  expect(progress.Check({ next: 'opaque-token' })).toBe(true);
  expect(progress.Check({ next: 'x'.repeat(4864) })).toBe(true);
  expect(progress.Check({ next: 'token=' })).toBe(false);
  expect(progress.Check({ next: null })).toBe(false);
  expect(progress.Check({ next: '' })).toBe(false);
  expect(progress.Check({ next: 'x'.repeat(4865) })).toBe(false);
  expect(progress.Check({ next: 'token', originals: ['private-alias'] })).toBe(false);
  expect(progress.Check({ next: 'token', document: {} })).toBe(false);
  const body = Compile(ZonePageRequestSchema);
  expect(body.Check({ target: { route: '' }, cursor: 'token' })).toBe(false);
  expect(body.Check({ target: { route: '' } })).toBe(true);
});
