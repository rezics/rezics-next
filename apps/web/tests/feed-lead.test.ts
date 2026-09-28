import { expect, test } from 'bun:test';
import { people, post, realms } from '../features/feed/fixtures.ts';
import { followsPoster, metaLead } from '../features/feed/lead.ts';

const followed = (target: string, targetKind: 'agent' | 'realm' | 'work' = 'agent') =>
  ({ kind: 'followed', target, targetKind }) as const;
const stranger = { kind: 'recommended', basis: 'all' } as const;

test('a post leads with the person the reader follows, or with its Realm for a stranger', () => {
  expect(metaLead(post(1, { actor: people.leo, reason: followed(people.leo.id) }))).toBe('person');
  expect(metaLead(post(2, { actor: people.leo, reason: stranger }))).toBe('realm');
  expect(metaLead(post(3, { actor: people.leo, reason: followed(realms.fiction.id, 'realm') }))).toBe('realm');
  // Following the Work is not following its poster.
  expect(metaLead(post(4, { actor: people.leo, reason: followed(post(4).target.work!, 'work') }))).toBe('realm');
});

test('a grouped post leads with the person when the reader follows anyone in the group', () => {
  const item = post(5, { actor: people.leo, reason: followed(people.aria.id),
    group: { key: 'g', count: 2, actors: [people.leo, people.aria] } });
  expect(followsPoster(item)).toBe(true);
  expect(metaLead(item)).toBe('person');
});

test('a post with no Realm leads with the person; a Realm\'s act leads with the Realm, followed curator or not', () => {
  expect(metaLead(post(6, { realm: null, reason: stranger }))).toBe('person');
  const pick = { kind: 'realm-pick', realm: realms.classics.id, curator: people.daniel.id } as const;
  expect(metaLead(post(7, { kind: 'adoption', realm: realms.classics, actor: people.daniel,
    reason: followed(people.daniel.id) }))).toBe('realm');
  expect(metaLead(post(8, { realm: realms.classics, actor: people.daniel, reasons: [pick],
    reason: followed(people.daniel.id) }))).toBe('realm');
  expect(metaLead(post(9, { kind: 'decision', realm: realms.classics, actor: people.daniel,
    reason: followed(people.daniel.id) }))).toBe('realm');
});
