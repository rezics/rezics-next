import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  RealmDiscoverySection,
  type RealmDiscoveryCard,
  type RealmDiscoveryState,
} from '../src/community/realm-discovery';
import { m } from '../src/paraglide/messages.js';

const realm: RealmDiscoveryCard = {
  realmId: '0192f3a0-6c1e-7b2a-a005-000000000001',
  spaceId: '0192f3a0-6c1e-7b2a-a005-000000000002',
  name: 'Local Gardeners',
  description: 'Share nearby growing advice and seasonal harvests. '.repeat(2),
  avatar: {
    id: '0192f3a0-6c1e-7b2a-a005-000000000003',
    containerId: '0192f3a0-6c1e-7b2a-a005-000000000001',
    digest: 'c'.repeat(64),
    width: 240,
    height: 180,
    variants: [
      { format: 'avif', width: 96, height: 72 },
      { format: 'webp', width: 160, height: 120 },
    ],
    placeholder: { thumbhash: 'opaque-placeholder', color: '#aabbcc' },
    focalPoint: { x: 0.25, y: 0.75 },
    credit: {
      rightsHolder: 'Garden contributor',
      via: { name: 'Original photograph', url: 'https://commons.wikimedia.org/wiki/File:Garden.jpg' },
      license: 'CC BY-SA 4.0',
      obligations: ['cc:Attribution', 'cc:ShareAlike'],
    },
  },
};
const initialsRealm: RealmDiscoveryCard = {
  realmId: '0192f3a0-6c1e-7b2a-a005-000000000004',
  spaceId: '0192f3a0-6c1e-7b2a-a005-000000000005',
  name: 'Open Gardeners',
  description: '',
  avatar: null,
};

function render(state: RealmDiscoveryState, locale = 'en') {
  return renderToStaticMarkup(
    createElement(RealmDiscoverySection, {
      sort: 'popular',
      state,
      locale,
      onNext: () => {},
      onRetry: () => {},
    }),
  );
}

test('Realm discovery composes supplied cards as shared ContentItem rows with native destinations and attribution', () => {
  const markup = render({ kind: 'ready', realms: [realm, initialsRealm], next: 'next-page' }, 'unsupported-locale');
  const rows = [...markup.matchAll(/<li\b[^>]*data-slot="list-row"[^>]*>[\s\S]*?<\/li>/gu)].map((match) => match[0]);

  expect(rows).toHaveLength(2);
  expect(rows[0]).toContain(`<a `);
  expect(rows[0]).toContain(`href="/en/realms/${encodeURIComponent(realm.realmId)}"`);
  expect(rows[0]).not.toContain(`/spaces/${realm.spaceId}`);
  expect(rows[0]).toContain('<h3 ');
  expect(rows[0]).toContain('data-slot="realm-discovery-title"');
  expect(rows[0]).toContain('data-content-item-slot="preview"');
  expect(rows[0]).toContain('line-clamp-1');
  const titleId = rows[0].match(/<h3 id="([^"]+)"/u)?.[1];
  expect(titleId).toBeDefined();
  expect(rows[0]).toContain(`aria-labelledby="${titleId}"`);
  expect(rows.map((row) => (row.match(/<a\b/gu) ?? []).length)).toEqual([1, 1]);

  expect(rows[0]).toContain('width="240"');
  expect(rows[0]).toContain('height="180"');
  expect(rows[0]).toContain('sizes="44px"');
  expect(rows[0]).toContain('type="image/avif"');
  expect(rows[0]).toContain('type="image/webp"');
  expect(rows[0]).toContain('background-color:#aabbcc');
  expect(rows[0]).toContain('object-position:25% 75%');
  expect(rows[0]).toContain(`/media/${realm.avatar!.id}/webp-160`);
  expect(markup).toContain('Garden contributor');
  expect(markup).toContain('href="https://commons.wikimedia.org/wiki/File:Garden.jpg"');
  expect(markup).toContain('Original photograph');
  expect(markup).toContain('CC BY-SA 4.0');
  expect(markup).toContain('rel="noopener noreferrer nofollow"');

  expect(rows[1]).toContain(`href="/en/realms/${encodeURIComponent(initialsRealm.realmId)}"`);
  expect(rows[1]).toContain('data-slot="realm-discovery-initials"');
  expect(rows[1]).not.toContain('data-content-item-slot="preview"');
  expect(markup).toContain(m.realm_discovery_continue({}, { locale: 'en' }));
});

test('sparse and final empty pages, and unavailable state keep their distinct messages and controls', () => {
  const sparse = render({ kind: 'ready', realms: [], next: 'next-page' });
  expect(sparse).toContain(m.realm_discovery_page_empty({}, { locale: 'en' }));
  expect(sparse).toContain(m.realm_discovery_continue({}, { locale: 'en' }));
  expect(sparse).not.toContain(m.realm_discovery_empty({}, { locale: 'en' }));

  const empty = render({ kind: 'ready', realms: [], next: null });
  expect(empty).toContain(m.realm_discovery_empty({}, { locale: 'en' }));
  expect(empty).not.toContain(m.realm_discovery_continue({}, { locale: 'en' }));

  const unavailable = render({ kind: 'unavailable' });
  expect(unavailable).toContain(m.realm_discovery_unavailable({}, { locale: 'en' }));
  expect(unavailable).toContain(m.realm_discovery_retry({}, { locale: 'en' }));
});
