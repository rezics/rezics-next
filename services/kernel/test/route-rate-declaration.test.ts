import { expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import {
  defineRateLimit,
  rateLimitUnits,
  type RateLimitDeclaration,
  type RateLimitFamily,
} from '../src/http/rate-limit.ts';

test('trusted route metadata snapshots and freezes a serializable family and cost', () => {
  const input: { family: RateLimitFamily; units: 1 | 'commands' } = { family: 'write', units: 1 };
  const declaration = defineRateLimit(input);
  input.family = 'search';
  input.units = 'commands';
  expect(declaration).toEqual({ family: 'write', units: 1 });
  expect(Object.isFrozen(declaration)).toBe(true);
  expect(Reflect.set(declaration, 'units', 'commands')).toBe(false);
  expect(JSON.parse(JSON.stringify(declaration))).toEqual({ family: 'write', units: 1 });
  expect(rateLimitUnits(JSON.parse(JSON.stringify(declaration)), undefined)).toBe(1);

  const families: RateLimitFamily[] = ['write', 'upload', 'report', 'correspondence', 'search', 'provider', 'address'];
  for (const family of families) {
    for (const units of [1, 'commands'] as const) {
      const metadata = defineRateLimit({ family, units });
      expect(JSON.parse(JSON.stringify(metadata))).toEqual({ family, units });
    }
  }
});

test('unknown declarations, families and resolver modes fail without a default', () => {
  const invalid: unknown[] = [
    undefined,
    null,
    false,
    1,
    'write',
    [],
    Object.assign([], { family: 'write', units: 1 }),
    Object.assign(() => 1, { family: 'write', units: 1 }),
    {},
    { family: 'read', units: 1 },
    { family: 'write' },
    { units: 1 },
    { family: 'write', units: 0 },
    { family: 'write', units: 2 },
    { family: 'write', units: '1' },
    { family: 'write', units: 'body' },
    { family: 'write', units: () => 1 },
  ];
  for (const value of invalid) {
    expect(() => defineRateLimit(value as RateLimitDeclaration)).toThrow(TypeError);
    expect(() => rateLimitUnits(value as RateLimitDeclaration, { commands: [{}] })).toThrow(TypeError);
  }
});

test('ordinary writes cost one and bulk cost is exactly the validated command cardinality', () => {
  const ordinary = defineRateLimit({ family: 'write', units: 1 });
  const bulk = defineRateLimit({ family: 'write', units: 'commands' });
  expect(rateLimitUnits(ordinary, undefined)).toBe(1);
  expect(rateLimitUnits(ordinary, { commands: Array(100).fill({}) })).toBe(1);
  for (const count of [1, 37, 100]) {
    expect(rateLimitUnits(bulk, { commands: Array(count).fill({}) })).toBe(count);
  }
});

test('bulk rejects missing, malformed, empty and excessive command bodies', () => {
  const bulk = defineRateLimit({ family: 'write', units: 'commands' });
  for (const body of [
    undefined,
    null,
    false,
    1,
    'commands',
    [],
    {},
    { commands: null },
    { commands: 'one' },
    { commands: {} },
    { commands: { length: 1 } },
    { commands: { length: 1.5 } },
    { commands: { length: '1' } },
    { commands: [] },
    { commands: Array(101).fill({}) },
  ]) {
    expect(() => rateLimitUnits(bulk, body)).toThrow();
  }
});

test('request JSON cannot replace mounted metadata or declare a read-only POST policy', () => {
  const writeDetail = {
    operationId: 'thing.bulk',
    'x-rate-limit': defineRateLimit({ family: 'write', units: 'commands' }),
  };
  const readDetail = { operationId: 'thing.lookup', 'x-action': 'thing:read' };
  const app = new Elysia()
    .post('/bulk', { detail: writeDetail }, () => 'ok')
    .post('/lookup', { detail: readDetail }, () => 'ok');
  const body = JSON.parse(
    JSON.stringify({
      commands: [{}, {}],
      family: 'search',
      units: 1,
      'x-rate-limit': { family: 'address', units: 1 },
      detail: { 'x-rate-limit': { family: 'provider', units: 1 } },
      'x-action': 'thing:create',
    }),
  );
  const mounted = app.routes[0]!.hooks.detail!['x-rate-limit'] as RateLimitDeclaration;
  expect(rateLimitUnits(mounted, body)).toBe(2);
  expect(mounted).toEqual({ family: 'write', units: 'commands' });
  const readOnly = app.routes[1]!.hooks.detail!;
  expect(readOnly['x-action']).toBe('thing:read');
  expect(readOnly['x-rate-limit']).toBeUndefined();
  expect(() => rateLimitUnits(readOnly['x-rate-limit'] as RateLimitDeclaration, body)).toThrow(TypeError);
});
