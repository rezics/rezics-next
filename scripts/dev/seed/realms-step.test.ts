import { expect, test } from 'bun:test';
import { SeedApiError } from './api.ts';
import { adoptZoneSpace, isIdempotencyConflict, isUnreadable, type SpaceRead } from './realms-step.ts';

const native = (suffix: string) => `https://rezics.com/id/00000000-0000-4000-a000-${suffix.padStart(12, '0')}`;
const zone = native('1');
const actor = native('9');

function reads(pages: Record<string, Record<string, unknown> | null>) {
  const seen: string[] = [];
  const get: SpaceRead = async path => { seen.push(path); return pages[path.split('?')[0]!] ?? null; };
  return { get, seen };
}

test('a Space made under an earlier body is found through its Zone and Realm, with two reads and no write', async () => {
  const { get, seen } = reads({
    [`/v1/zones/${zone.slice(-36)}/configuration`]: { configuration: { space: native('2'), defaultRealm: native('3') } },
    [`/v1/realms/${native('3').slice(-36)}`]: { id: native('3'), space: native('2') } });
  expect(await adoptZoneSpace(get, zone, actor)).toEqual({ space: native('2'), realm: native('3'), replayed: true });
  expect(seen).toHaveLength(2);
  expect(seen.every(path => path.endsWith(`?actingSubject=${encodeURIComponent(actor)}`))).toBe(true);
});

test('a missing or unconfigured Zone adopts nothing', async () => {
  expect(await adoptZoneSpace(reads({}).get, zone, actor)).toBeNull();
  const { get } = reads({ [`/v1/zones/${zone.slice(-36)}/configuration`]: { configuration: { space: native('2'), defaultRealm: null } } });
  expect(await adoptZoneSpace(get, zone, actor)).toBeNull();
});

test('a default Realm on another Space is not adopted', async () => {
  const { get } = reads({
    [`/v1/zones/${zone.slice(-36)}/configuration`]: { configuration: { space: native('2'), defaultRealm: native('3') } },
    [`/v1/realms/${native('3').slice(-36)}`]: { id: native('3'), space: native('8') } });
  expect(await adoptZoneSpace(get, zone, actor)).toBeNull();
});

test('only an idempotency conflict marks a Space as made under an earlier body', () => {
  expect(isIdempotencyConflict(new SeedApiError('Main /v1/spaces', 409, '{"code":"idempotency_conflict"}'))).toBe(true);
  expect(isIdempotencyConflict(new SeedApiError('Main /v1/spaces', 409, '{"code":"handle_taken"}'))).toBe(false);
  expect(isIdempotencyConflict(new SeedApiError('Main /v1/spaces', 400, '{"code":"idempotency_conflict"}'))).toBe(false);
  expect(isIdempotencyConflict(new Error('offline'))).toBe(false);
});

test('a Zone read the steward may not make is unreadable, not a failure', () => {
  for (const status of [401, 403, 404]) expect(isUnreadable(new SeedApiError('Main /v1/zones', status, '{}'))).toBe(true);
  expect(isUnreadable(new SeedApiError('Main /v1/zones', 500, '{}'))).toBe(false);
  expect(isUnreadable(new Error('offline'))).toBe(false);
});
