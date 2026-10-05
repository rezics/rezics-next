import { expect, test } from 'bun:test';
import { SeedApiError } from './api.ts';
import { adoptZoneSpace, isIdempotencyConflict, type SpaceRead } from './realms-step.ts';

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

test('a Realm whose Zone already names its Space keeps that Space, whatever key now creates one', async () => {
  const { realms } = await import('./plan.ts');
  const { seedRealms } = await import('./realms-step.ts');
  const { stableId } = await import('./state.ts');
  const spaces = new Map(realms.map((realm, index) => [stableId(`zone:${realm.id}`), { space: native(`a${index}`), realm: native(`b${index}`) }]));
  const posts: string[] = [];
  const state = { sessions: Array.from({ length: realms.length + 1 }, (_, index) => ({ id: `person-${index}`, accountId: `account-${index}`,
    cookie: '', token: `token-${index}`, issuedAt: 0, actingSubject: native(`c${index}`) })),
  created: new Map(), createdRealms: [], seededZones: [], operatorInput: null, operatorSession: null,
  endpoints: { writeCounts: { written: 0, replayed: 0, reconciled: 0, lookups: 0 } },
  optional: async <T>(_label: string, operation: () => Promise<T>) => operation(),
  api: { post: async (path: string) => { posts.push(path); throw new Error('Space created beside the Zone\'s'); },
    get: async (path: string) => {
      const zone = /\/v1\/zones\/([0-9a-f-]{36})\/configuration/.exec(path)?.[1];
      if (zone) return { configuration: { space: spaces.get(zone)!.space, defaultRealm: spaces.get(zone)!.realm } };
      const realm = [...spaces.values()].find(held => path.includes(held.realm.slice(-36)))!;
      return { id: realm.realm, space: realm.space };
    } } } as unknown as Parameters<typeof seedRealms>[0];
  await seedRealms(state);
  expect(posts).toEqual([]);
  expect(state.createdRealms.map(item => item.receipt.realm)).toEqual(realms.map((_, index) => native(`b${index}`)));
  expect(state.endpoints.writeCounts?.lookups).toBe(realms.length);
});
