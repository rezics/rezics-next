import { expect, test } from 'bun:test';
import { observeSearchSpaceEntries } from '../../src/search/space-entry.ts';
import type { SpaceEntryCard } from '../../src/community/space-discovery-entry-contract.ts';
import type { DiscoveryPage } from '../../src/search/discovery.ts';

const id = '00000000-0000-4000-8000-000000000811';
const realm = '00000000-0000-4000-8000-000000000812';
const reader = '00000000-0000-4000-8000-000000000813';
function fixture(carried = true) {
  const card: SpaceEntryCard = {
    id,
    address: 'reading',
    title: 'Reading Space',
    description: 'Current purpose',
    realmId: carried ? realm : null,
    realmTitle: carried ? 'Community' : null,
    binding: 'source-1',
    presentation: {
      identity: { kind: carried ? 'realm' : 'space', id: carried ? realm : id, name: 'Current identity' },
      avatar: { state: 'none' },
    },
    destination: carried ? { kind: 'realm', realmId: realm } : { kind: 'space', spaceId: id, address: 'reading' },
    actions: {
      status: 'available',
      resourceType: carried ? 'community.realm' : 'community.space',
      resourceId: carried ? realm : id,
      viewerActions: [
        { action: carried ? 'realm:read' : 'space:read', operations: [carried ? 'realm.home' : 'space.get'] },
        { action: 'realm:join', operations: ['realm.join'] },
      ],
    },
  };
  const page: DiscoveryPage = {
    hits: [
      {
        key: { owner: 'community', kind: 'space', route: 0, id },
        summary: {
          kind: 'space',
          value: {
            id,
            address: card.address!,
            title: card.title,
            summary: card.description,
            realm: carried ? { id: realm, title: card.realmTitle } : null,
          },
        },
      },
    ],
    kinds: { values: [], next: null },
    next: 'continuation',
    as_of: '2026-11-04T00:00:00Z',
  };
  return { card, page, cards: new Map([[id, card]]) };
}
const actor = { kind: 'account' as const, accountId: reader };
test('one aggregate observes exact Space following separately from current Realm entry and fences its producer', async () => {
  const f = fixture();
  let seeks = 0,
    edges = 0,
    current = true;
  const observation = await observeSearchSpaceEntries({
    page: f.page,
    actor,
    deadline: Date.now() + 10000,
    read: async (ids) => {
      seeks++;
      expect(ids).toEqual([id]);
      return f.cards;
    },
    follow: async (input) => {
      edges++;
      expect(input.actor).toEqual(actor);
      expect(input.ids).toEqual([id]);
      return {
        rows: new Map([[id, { state: 'current', following: true, action: 'allowed' }]]),
        current: async () => current,
      };
    },
  });
  expect(observation.page.spaceEntries).toEqual({
    reader,
    rows: [
      {
        id,
        destination: { kind: 'realm', realmId: realm },
        entry: 'allowed',
        admission: 'allowed',
        follow: { state: 'current', following: true, action: 'allowed' },
      },
    ],
  });
  expect(observation.page.hits[0]!.summary).toMatchObject({ value: { presentation: f.card.presentation } });
  expect(observation.page.next).toBe('continuation');
  expect(await observation.finish()).toBe(true);
  current = false;
  expect(await observation.finish()).toBe(false);
  expect(edges).toBe(1);
  expect(seeks).toBe(3);
});
test('standalone, signed out and absent follow producer retain explicit independent advice', async () => {
  const f = fixture(false);
  for (const who of [actor, { kind: 'anonymous' as const }]) {
    const observed = await observeSearchSpaceEntries({
      page: f.page,
      actor: who,
      deadline: Date.now() + 10000,
      read: async () => f.cards,
    });
    expect(observed.page.spaceEntries?.rows[0]).toMatchObject({
      destination: { kind: 'space', spaceId: id, address: 'reading' },
      admission: 'disabled',
      follow: { state: who.kind === 'account' ? 'unavailable' : 'sign-in' },
    });
  }
});
test('final owner disclosure retires changed address, carrier, media, entry and removed or concealed carrier', async () => {
  for (const change of [
    (c: SpaceEntryCard) => ({ ...c, address: 'replaced' }),
    (c: SpaceEntryCard) => ({ ...c, realmId: null, realmTitle: null }),
    (c: SpaceEntryCard) => ({ ...c, presentation: { ...c.presentation, avatar: { state: 'withheld' as const } } }),
    (c: SpaceEntryCard) => ({
      ...c,
      destination: { kind: 'unavailable' as const },
      actions: { status: 'unavailable' as const },
    }),
    (_c: SpaceEntryCard) => undefined,
  ]) {
    const f = fixture();
    const observation = await observeSearchSpaceEntries({
      page: f.page,
      actor,
      deadline: Date.now() + 10000,
      read: async () => f.cards,
    });
    const changed = change(f.card);
    if (changed) f.cards.set(id, changed);
    else f.cards.clear();
    expect(await observation.finish()).toBe(false);
  }
});
test('stale indexed hints cannot authorize identity, association or a fallback', async () => {
  const f = fixture();
  f.cards.clear();
  await expect(
    observeSearchSpaceEntries({ page: f.page, actor, deadline: Date.now() + 10000, read: async () => f.cards }),
  ).rejects.toThrow();
  const other = fixture();
  other.cards.set(id, { ...other.card, realmId: null });
  await expect(
    observeSearchSpaceEntries({ page: other.page, actor, deadline: Date.now() + 10000, read: async () => other.cards }),
  ).rejects.toThrow();
});
