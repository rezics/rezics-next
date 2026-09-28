import { expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import { feedReason } from '../src/modules/feed/contract.ts';
import { followIdentities } from '../src/modules/feed/presentation.ts';
import { externalAuthorFollow, externalAuthorKey, followCommand, followedAuthorsPage,
  followTargetMatches } from '../src/modules/follows/contract.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const command = { profile: 'follow-command-v1', actingSubject: id(9), following: true, expectedRevision: null };

test('G-397 an Open Library author is followed by provider and key, and only under their own kind', () => {
  expect(externalAuthorKey('open-library:OL21594A')).toBe('/authors/OL21594A');
  expect(externalAuthorFollow('/authors/OL21594A')).toBe('open-library:OL21594A');
  for (const target of [id(1), 'open-library:OL0A', 'open-library:OL1W', 'wikidata:OL1A', 'open-library:/authors/OL1A']) {
    expect(externalAuthorKey(target)).toBeNull();
  }
  expect(Value.Check(followCommand, { ...command, target: 'open-library:OL21594A', kind: 'external-author' })).toBe(true);
  expect(Value.Check(followCommand, { ...command, target: 'open-library:OL0A', kind: 'external-author' })).toBe(false);
  expect(Value.Check(followCommand, { ...command, target: 'OL21594A', kind: 'external-author' })).toBe(false);
  // The schema admits either shape for either kind; the store and a CHECK refuse a mismatch.
  expect(followTargetMatches('open-library:OL21594A', 'external-author')).toBe(true);
  expect(followTargetMatches('open-library:OL21594A', 'agent')).toBe(false);
  expect(followTargetMatches(id(1), 'external-author')).toBe(false);
  expect(followTargetMatches(id(1), 'agent')).toBe(true);
  expect(Value.Check(feedReason, { kind: 'followed', target: 'open-library:OL21594A', targetKind: 'external-author' }))
    .toBe(true);
  expect(Value.Check(followedAuthorsPage.properties.items.items, { id: 'open-library:OL21594A', kind: 'external-author',
    available: false, revision: '00000000-0000-4000-8000-000000000001', name: null, icon: null, realm: null, href: null,
    newestWork: null })).toBe(true);
});

test('G-397 an author\'s news answers first to the authors its card credits, in credit order', () => {
  const source = { kind: 'work' as const, realm: id(1), zone: id(2), work: id(3), actor: id(4) };
  const authors = [{ agent: id(5), key: null }, { agent: null, key: '/authors/OL21594A' },
    { agent: id(4), key: null }, { agent: id(6), key: null }];
  // Three credits at most, the poster once, then Realm, Zone and Work: seven identities.
  expect(followIdentities(source, authors)).toEqual([id(5), 'open-library:OL21594A', id(4), id(1), id(2), id(3)]);
  expect(followIdentities({ ...source, kind: 'contribution' }, authors)[1]).toBe('open-library:OL21594A');
  expect(followIdentities({ ...source, kind: 'added' }, authors)[0]).toBe(id(5));
  expect(followIdentities({ ...source, kind: 'work' }, authors.slice(0, 2)))
    .toEqual([id(5), 'open-library:OL21594A', id(4), id(1), id(2), id(3)]);
  // Talk about a Work or a review is not its author's news; a followed poster outranks a followed Realm.
  for (const kind of ['discussion', 'reply', 'review'] as const) {
    expect(followIdentities({ ...source, kind }, authors)).toEqual([id(4), id(1), id(2), id(3)]);
  }
  // A pick or a decision is the Realm's act, so its Realm comes before whoever carried it out.
  for (const kind of ['adoption', 'decision'] as const) {
    expect(followIdentities({ ...source, kind }, authors)).toEqual([id(1), id(2), id(3), id(4)]);
  }
  expect(followIdentities({ kind: 'collection', realm: null, zone: null, work: null, actor: id(4) })).toEqual([id(4)]);
});
