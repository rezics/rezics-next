import { createHash, createHmac } from 'node:crypto';
import { assertRoute, uuidBytes } from './contract.ts';

export { PARTITIONS, ROUTES, partitionOf, routeOf } from './contract.ts';

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function formatUuid(bytes: Uint8Array): string {
  const hex = Buffer.from(bytes).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function writeRoute(bytes: Uint8Array, route: number): void {
  bytes[10] = route >>> 8;
  bytes[11] = route & 0xff;
}

export function newId(route: number): string {
  assertRoute(route);
  const bytes = uuidBytes(Bun.randomUUIDv7());
  writeRoute(bytes, route);
  return formatUuid(bytes);
}

export function derivedId(namespace: string, name: string, route: number): string {
  assertRoute(route);
  if (!CANONICAL_UUID.test(namespace)) throw new RangeError('Namespace must be a lowercase canonical UUID');

  const hash = createHash('sha256').update(uuidBytes(namespace)).update(name, 'utf8').digest().subarray(0, 16);
  hash[6] = (hash[6]! & 0x0f) | 0x80;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  writeRoute(hash, route);
  return formatUuid(hash);
}

export function anchorRoute(key: Uint8Array, idempotencyKey: string): number {
  if (key.byteLength < 32) throw new RangeError('Route key must contain at least 32 bytes');
  const digest = createHmac('sha256', key).update(idempotencyKey, 'utf8').digest();
  return (digest[0]! << 8) | digest[1]!;
}
