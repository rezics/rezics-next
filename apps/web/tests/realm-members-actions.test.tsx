import { expect, test } from 'bun:test';
import { boundedRealmMemberPage } from '../src/community/members/source';
import { RealmMembersVisit } from '../src/community/members/visit';

test('the installed unavailable seam grants no enumeration, identity or command', async () => {
  expect(await boundedRealmMemberPage.readPage({ realmId: 'realm', cursor: null })).toEqual({ kind: 'unavailable' });
  expect(
    await boundedRealmMemberPage.readSelected({ realmId: 'realm', accountId: 'a', episode: 'e', authority: 'g' }),
  ).toEqual({ kind: 'unavailable' });
  expect(Object.keys(boundedRealmMemberPage).sort()).toEqual(['pageBound', 'readPage', 'readSelected']);
});

test('1/10/20 rows need one page request, no hydration and one explicit selected request', async () => {
  for (const count of [1, 10, 20]) {
    let pages = 0;
    let selections = 0;
    const visit = new RealmMembersVisit('realm', {
      pageBound: 20,
      readPage: async () => {
        pages++;
        return {
          kind: 'ready',
          page: {
            realm: { id: 'realm', label: 'Realm' },
            authority: 'grant',
            next: null,
            rows: Array.from({ length: count }, (_, index) => ({
              kind: 'disclosed',
              identity: { accountId: `${index}`, reference: `${index}`, label: 'Current private fallback' },
              episode: 'episode',
              membership: 'pending',
            })),
          },
        };
      },
      readSelected: async (address) => {
        selections++;
        return {
          kind: 'ready',
          ...address,
          identity: { accountId: address.accountId, reference: address.accountId, label: 'Current private fallback' },
          membership: 'pending',
        };
      },
    });
    const stop = visit.connect();
    await Promise.resolve();
    expect([pages, selections]).toEqual([1, 0]);
    await visit.select(`${count - 1}`);
    expect([pages, selections]).toEqual([1, 1]);
    expect(visit.snapshot().selection?.read).toMatchObject({ membership: 'pending' });
    visit.closeSelection();
    expect([pages, selections]).toEqual([1, 1]);
    stop();
  }
});

test('sparse continuation and explicit failed-page retry preserve opaque cursor bytes', async () => {
  const addresses: unknown[] = [];
  const cursor = ' opaque/+==? &字 ';
  const visit = new RealmMembersVisit('realm', {
    pageBound: 20,
    readPage: async (address) => {
      addresses.push(address);
      return addresses.length === 2
        ? { kind: 'failed' }
        : {
            kind: 'ready',
            page: { realm: { id: 'realm', label: 'Realm' }, authority: 'grant', rows: [], next: cursor },
          };
    },
    readSelected: async () => {
      throw new Error('No hidden selected lookup');
    },
  });
  const stop = visit.connect();
  await Promise.resolve();
  await visit.more();
  expect(visit.snapshot().read.kind).toBe('failed');
  await visit.retryPage();
  expect(addresses).toEqual([
    { realmId: 'realm', cursor: null },
    { realmId: 'realm', cursor },
    { realmId: 'realm', cursor },
  ]);
  stop();
});
