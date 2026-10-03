import { expect, test } from 'bun:test';
import { readMyContributions, readMyRatings } from '../src/modules/profiles/library.ts';
import { pageDiscoveryHeaders } from '../src/modules/space/visibility.ts';
import { WorkReadMoved, WorkReadSession } from '../src/modules/work/read-session.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';

const actor = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
test('G-964: contribution and rating inventories expose current listing, noindex and unlisted referrer policy, including empty pages', async () => {
  for (const listing of ['listed', 'unlisted'] as const) for (const read of [readMyContributions, readMyRatings]) {
    const principal = { issuer: 'test', subject: 'owner' };
    const work = { account: { verify: async () => principal },
      profiles: { listing: { read: async () => ({ listing, version: 1 }) },
        libraryFence: async () => ({ principalId: 'owner', stamp: '1' }), ratings: async () => [] } } as unknown as MainWorkDependencies;
    const session = new WorkReadSession(work, new Request('http://main.local/v1/me/contributions'),
      { actingSubject: actor }, { dataEpoch: 'epoch', sequence: '1' });
    session.principal = principal;
    session.query = async () => [];
    session.summaries = async () => [];
    const result = await read(session);
    expect(result).toMatchObject({ items: [], listing, discovery: { indexable: false, robots: 'noindex' } });
    expect(pageDiscoveryHeaders(result.discovery)).toEqual(listing === 'unlisted'
      ? { 'x-robots-tag': 'noindex', 'referrer-policy': 'no-referrer' } : { 'x-robots-tag': 'noindex' });
    let reads = 0;
    work.profiles!.listing.read = async () => ({ listing, version: ++reads, changedAt: null });
    await expect(read(session)).rejects.toBeInstanceOf(WorkReadMoved);
  }
});
