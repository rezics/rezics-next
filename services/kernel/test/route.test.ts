import { expect, test } from 'bun:test';
import { anchorRoute, derivedId, newId, partitionOf, PARTITIONS, routeOf, ROUTES } from '../src/route/route.ts';

const v7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const namespace = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';

test('a route belongs to the partition named by its top 12 bits', () => {
  expect([ROUTES, PARTITIONS]).toEqual([65_536, 4_096]);
  expect([0, 15, 16, 0xbeef, 65_535].map(partitionOf)).toEqual([0, 0, 1, 0xbee, 4_095]);
  for (const route of [-1, 65_536, 1.5, Number.NaN]) expect(() => partitionOf(route)).toThrow(RangeError);
});

test('a new id is a UUIDv7 that carries its route and sorts by creation', () => {
  const ids = Array.from({ length: 200 }, (_, n) => newId((n * 331) % ROUTES));
  for (const [n, id] of ids.entries()) {
    expect(id).toMatch(v7);
    expect(routeOf(id)).toBe((n * 331) % ROUTES);
  }
  expect([...ids].sort()).toEqual(ids);
  expect(new Set(ids).size).toBe(ids.length);
  expect(() => newId(65_536)).toThrow(RangeError);
});

test('a derived id is a stable UUIDv8 of its namespace and name with the route in place', () => {
  expect(derivedId(namespace, 'schema:Book', 0xbeef)).toBe('454b3a86-79ab-8983-acfe-beeffee9d09c');
  expect(derivedId(namespace, '書', 0)).toBe('481b57b2-fca8-80e8-a0b0-0000f9b81925');
  expect(routeOf(derivedId(namespace, 'schema:Book', 0xbeef))).toBe(0xbeef);
  expect(() => derivedId('not-a-uuid', 'schema:Book', 0)).toThrow(RangeError);
  expect(() => derivedId(namespace, 'schema:Book', -1)).toThrow(RangeError);
});

test('routeOf reads only canonical version 7 and 8 ids', () => {
  for (const id of [
    '454B3A86-79AB-8983-ACFE-BEEFFEE9D09C',
    '454b3a86-79ab-4983-acfe-beeffee9d09c',
    '454b3a86-79ab-8983-cdfe-beeffee9d09c',
    '454b3a8679ab8983acfebeeffee9d09c',
    '{454b3a86-79ab-8983-acfe-beeffee9d09c}',
    '',
  ]) {
    expect(routeOf(id)).toBeNull();
  }
});

test('an idempotency key routes a create to a fixed partition under a route key', () => {
  const key = new Uint8Array(32).fill(7);
  expect(anchorRoute(key, 'order-1')).toBe(45_021);
  expect(anchorRoute(key, '注文-2')).toBe(57_208);
  expect(anchorRoute(new Uint8Array(32).fill(8), 'order-1')).not.toBe(45_021);
  expect(() => anchorRoute(new Uint8Array(31), 'order-1')).toThrow(RangeError);
});
