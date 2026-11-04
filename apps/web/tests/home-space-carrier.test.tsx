import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { HomeFeed } from '../src/features/pages/home-feed';
import { homeFeedDestination, homeFeedRealmDestination } from '../src/features/pages/home-feed-destination';
import type { FeedItem, FeedPage } from '../src/features/pages/home-feed-read';

type Carrier = { id: string; title: string | null } | null;
const spaceItem = (id: string, address: string, realm?: Carrier): FeedItem => ({
  id: `discovery:content:${id}`,
  source: 'discovery',
  occurredAt: null,
  key: { owner: 'content', kind: 'space', route: 0, id },
  summary: {
    id,
    title: 'Reading room',
    address,
    summary: '',
    ...(realm === undefined ? {} : { realm }),
  },
  destination: { kind: 'space', id, title: 'Reading room', address },
});

test('Home keeps exact Space and disclosed carrier destinations while preserving missing, null and empty facts', () => {
  const currentId = '00000000-0000-7000-8000-000000000011';
  const currentRealm = '00000000-0000-7000-8000-000000000021';
  const current = spaceItem(currentId, 'reading-room', { id: currentRealm, title: 'Atlas' });
  const items = [
    current,
    { ...current, id: 'duplicate-space-occurrence' },
    spaceItem('00000000-0000-7000-8000-000000000012', 'no-carrier'),
    spaceItem('00000000-0000-7000-8000-000000000013', 'explicit-none', null),
    spaceItem('00000000-0000-7000-8000-000000000014', 'title-unavailable', {
      id: '00000000-0000-7000-8000-000000000022',
      title: null,
    }),
    spaceItem('00000000-0000-7000-8000-000000000015', 'empty-title', {
      id: '00000000-0000-7000-8000-000000000023',
      title: '',
    }),
  ];
  const page: FeedPage = {
    feedItems: items,
    next: null,
    asOf: '2026-11-04T00:00:00Z',
    sources: { discovery: 'ready', following: 'not_requested', continue: 'not_requested' },
  };
  const html = renderToStaticMarkup(<HomeFeed result={{ state: 'ready', page }} locale="en" />);

  expect(homeFeedDestination(current, 'en')).toBe('/en/spaces/reading-room');
  expect(homeFeedRealmDestination(current, 'en')).toBe(`/en/realms/${currentRealm}`);
  expect(homeFeedDestination({ ...current, destination: { ...current.destination, address: 'changed' } }, 'en')).toBe(
    undefined,
  );
  expect(html.match(/data-home-public-owner-context="space"/gu)).toHaveLength(6);
  expect(html).toContain('data-home-space-address="reading-room"');
  expect(html).toContain(`href="/en/realms/${currentRealm}"`);
  expect(html).toContain('data-home-carrier-id="00000000-0000-7000-8000-000000000022"');
  expect(html).toContain('data-home-carrier-state="unavailable"');
  expect(html).toContain('data-home-carrier-state="none"');
  expect(html).toContain('data-home-carrier-state="title-unavailable"');
  expect(html).toContain('data-home-carrier-state="title-empty"');
  expect(html).toContain('No Realm is attached to this Space.');
  expect(html).toContain('Title unavailable.');
  expect(html).toContain('Title is empty.');
});
