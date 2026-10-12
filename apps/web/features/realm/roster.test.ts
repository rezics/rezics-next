import { expect, test } from 'bun:test';
import { rosterPeople } from './roster.ts';

test('members with a private name stay in the roster under the fallback name', () => {
  const people = rosterPeople(
    [
      { agent: 'a1', displayName: null, featured: false },
      { agent: 'a2', displayName: '北岛听风', featured: true },
    ],
    'Member',
    (agent) => `/a/${agent}`,
  );
  expect(people.map(({ id, name, href, featured }) => ({ id, name, href, featured }))).toEqual([
    { id: 'a1', name: 'Member', href: '/a/a1', featured: false },
    { id: 'a2', name: '北岛听风', href: '/a/a2', featured: true },
  ]);
});
