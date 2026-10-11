import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { RealmView } from '../realm/realm-page.tsx';

void mock.module('./about-discussion-entry.tsx', () => ({
  ZoneAboutDiscussion: () => <aside data-zone-discussion-entry />,
}));

const { ZoneSiteHome } = await import('./site-home.tsx');

test('a package-rendered Zone home has no attached Realm discussion entry', async () => {
  function Home() {
    return createElement('main', null, 'Zone home');
  }

  const view = {
    realm: { zone: { id: '00000000-0000-4000-8000-000000000001' } },
    context: { locale: 'en', ref: 'fiction' },
    zone: {},
    pkg: { slots: { home: Home } },
    mounts: [],
    zoneMessages: {},
    reader: { avatarQuery: '' },
  } as unknown as RealmView;

  const html = renderToStaticMarkup(await ZoneSiteHome({ view, search: {} }));
  expect(html).toContain('Zone home');
  expect(html).not.toContain('data-zone-discussion-entry');
});
