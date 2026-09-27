import { expect, test } from 'bun:test';
import { treaty } from '@elysia/eden';
import type { MainApp } from '@rezics/main/app';
import { discoveryRecentOrder } from '../src/modules/discovery/source.ts';
import { WorkReadLimit } from '../src/modules/work/read-session.ts';
import { discoveryScopeKey } from '../src/modules/discovery/store.ts';

test('Discovery recency orders retained epochs before sequence and preserves integers beyond Number precision', () => {
  const last = ((1n << 63n) - 1n).toString();
  expect(BigInt(discoveryRecentOrder(0, '0'))).toBeLessThan(BigInt(discoveryRecentOrder(1, last)));
  expect(BigInt(discoveryRecentOrder(0, '9007199254740993')))
    .toBeLessThan(BigInt(discoveryRecentOrder(0, '9007199254740992')));
  expect(() => discoveryRecentOrder(33, '1')).toThrow(WorkReadLimit);
  expect(() => discoveryRecentOrder(0, (1n << 63n).toString())).toThrow(WorkReadLimit);
});

test('Discovery population identity separates standing Contexts, Realms and private principals', () => {
  const global = { scope: 'global' as const, realm: null, context: 'question-a', owner: null };
  const identities = [global, { ...global, context: 'question-b' },
    { ...global, scope: 'realm' as const, realm: 'realm-a' },
    { ...global, scope: 'mine' as const, owner: 'principal-a' },
    { ...global, scope: 'mine' as const, owner: 'principal-b' }].map(discoveryScopeKey);
  expect(new Set(identities).size).toBe(5);
  expect(discoveryScopeKey({ context: global.context, owner: null, realm: null, scope: 'global' })).toBe(identities[0]!);
});

test('Discovery GET and generation APIs expose concrete types to a web-style treaty MainApp consumer', () => {
  const client = treaty<MainApp>('http://main.invalid');
  const id = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
  const consume = async () => {
    const page = await client.v1.works.get({ query: { sort: 'top-rated', type: 'https://schema.org/Book',
      scope: 'realm', realm: id, context: id, term: id, limit: 10 } });
    const count: number | undefined = page.data?.matches.value;
    const source: 'local' | 'global' | undefined = page.data?.items[0]?.match.classification?.source;
    const mean: number | undefined = page.data?.items[0]?.rating?.mean;
    const build = await client.v1.discovery['generation-builds'].post({ profile: 'discovery-generation-build-v1',
      actingSubject: id, basis: { scope: 'global', context: null, realm: null } });
    const generation: string | undefined = build.data?.generation;
    return { count, source, mean, generation };
  };
  expect(consume).toBeFunction();
});
