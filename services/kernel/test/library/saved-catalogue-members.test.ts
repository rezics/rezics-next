import { expect, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import { ProblemError } from '../../src/http/problem.ts';
import type { AccountActor } from '../../src/request/access.ts';
import { readSavedCatalogueMembers } from '../../src/search/service-saved-collection.ts';
import type { SearchService } from '../../src/search/service-scope.ts';

const actor: AccountActor = {
  kind: 'account', accountId: '019a1b2c-3d4e-7f00-8a00-5ab1ec700001',
  clientId: 'curator', scopes: ['collection:read', 'subject:read'],
  requestedBy: '019a1b2c-3d4e-7f00-8a00-5ab1ec700002', authnEpoch: 1,
};
const input: Parameters<typeof readSavedCatalogueMembers>[1] = {
  actor,
  collection: {
    id: '019a1b2c-3d4e-7f00-8a00-5ab1ec700003', revision: 3, ruleRevision: 2,
    sourceGeneration: '4', reader: { minimumAuthnEpoch: '1', operator: '' },
  },
  filter: { and: [
    { type: { in: ['schema:Book'] } },
    { statement: { property: 'schema:datePublished', range: { gte: 1990, lte: 1999 } } },
  ] },
  release: { digest: 'accepted-immutable-release', release: bundledRelease },
  limit: 2,
  scope: { actor, access: { authenticate: async () => actor, authorize: async () => true },
    routeKey: new Uint8Array(32), deadline: Date.now() + 60_000 },
  revalidate: async () => {},
};

test('saved catalogue delegates the exact property query, accepted meaning and native continuation without Library presence', async () => {
  let finalized = 0;
  const search: Pick<SearchService, 'search'> = {
    async search(principal, request, _time, release, context) {
      expect(principal).toBe(`account:${actor.accountId}`);
      expect(request).toEqual({ filter: input.filter, sort: 'id', limit: 2, cursor: 'native-continuation' });
      expect(release).toBe(input.release);
      expect(context?.savedCollection).toBe(input.collection);
      expect(context?.scope).toBe(input.scope);
      const page = { subjects: [], next: 'next-native-continuation', as_of: '2026-11-06T00:00:00Z' };
      await context!.complete(page);
      return page;
    },
  };
  expect(await readSavedCatalogueMembers(search, {
    ...input, cursor: 'native-continuation', revalidate: async () => { finalized++; },
  })).toEqual({ members: [], next: 'next-native-continuation' });
  expect(finalized).toBe(1);
});

test('native catalogue restart becomes a stale members cursor while preparation and unexpected errors keep their meaning', async () => {
  for (const failure of [new ProblemError('search_restart_required'), new ProblemError('index_not_ready'), new Error('native fault')]) {
    const search: Pick<SearchService, 'search'> = { async search() { throw failure; } };
    await expect(readSavedCatalogueMembers(search, { ...input, cursor: 'native-continuation' }))
      .rejects.toMatchObject(failure instanceof ProblemError && failure.code === 'search_restart_required'
        ? { code: 'stale_cursor' } : failure);
    await expect(readSavedCatalogueMembers(search, input)).rejects.toBe(failure);
  }
});
