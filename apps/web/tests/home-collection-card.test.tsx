import { expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { FeedItem, FeedPage } from '../src/features/pages/home-feed-read';
import { setLocale } from '../src/paraglide/runtime.js';
import { m } from '../src/paraglide/messages.js';

mock.module('cloudflare:workers', () => ({ env: {} }));
const { HomeFeed } = await import('../src/features/pages/home-feed');

type CollectionCard = Extract<FeedItem['summary'], { card: unknown }>['card'];

const collectionId = '00000000-0000-7000-8000-0000000000c1';
const memberId = '00000000-0000-7000-8000-0000000000b1';
const subjectId = '00000000-0000-7000-8000-0000000000a1';
const coverMedia = '00000000-0000-7000-8000-0000000000d1';
const shared = {
  kind: 'collection' as const,
  id: collectionId,
  destination: `/collections/${collectionId}`,
  title: 'Curated books',
  description: 'A careful selection',
  visibility: 'public' as const,
  revision: 1,
  sourceGeneration: '1',
  presentationKind: 'schema:Book',
  presentationKindSource: 'owner' as const,
  cover: {
    media: coverMedia,
    width: 600,
    height: 900,
    placeholder: { thumbhash: 'AAAA', color: '#777777' },
    variants: [{ format: 'webp' as const, width: 300 }],
    focalPoint: null,
    credit: null,
  },
  coverSource: 'owner' as const,
  curator: { state: 'available' as const, id: subjectId, label: 'Ada', destination: '/@ada' },
  preview: {
    state: 'available' as const,
    members: [
      {
        id: memberId,
        subject: {
          id: subjectId,
          type: 'schema:Book',
          types: ['schema:Book'],
          label: { value: 'Dune', language: 'en' },
        },
      },
    ],
    partial: false,
    truncated: true,
  },
};
const curated = {
  ...shared,
  membershipKind: 'curated' as const,
  memberCount: 4,
  orderEpoch: 1,
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-02T00:00:00Z',
} satisfies CollectionCard;

function collectionItem(value: CollectionCard): FeedItem {
  return {
    id: `collection:${value.id}`,
    source: 'discovery',
    occurredAt: null,
    key: { owner: 'commerce', kind: 'collection', route: 0, id: value.id },
    summary: { id: value.id, title: value.title, description: value.description, card: value },
    destination: { kind: 'collection', id: value.id, title: value.title },
  };
}

function render(value: CollectionCard) {
  const page: FeedPage = {
    feedItems: [collectionItem(value)],
    next: null,
    asOf: '2026-11-04T00:00:00Z',
    sources: { discovery: 'ready', following: 'not_requested', continue: 'not_requested' },
  };
  return renderToStaticMarkup(<HomeFeed result={{ state: 'ready', page }} locale="en" />);
}

test('Home Collection cards show the installed curator, cover, owner presentation and occurrence-bound members', () => {
  setLocale('en', { reload: false });
  const html = render(curated);
  expect(html).toContain('data-home-curator-state="available"');
  expect(html).toContain(m.discovery_collection_curator({}, { locale: 'en' }));
  expect(html).toContain('href="/en/@ada"');
  expect(html).toContain('>Ada<');
  expect(html).toContain('data-collection-cover-source="owner"');
  expect(html).toContain(`data-collection-member-id="${memberId}"`);
  expect(html).toMatch(new RegExp(`href="/en/subjects/${subjectId}/[^"]*\\?via=[^"]*${memberId}[^"]*"`));
  expect(html).toContain('data-home-collection-kind="schema:Book"');
  expect(html).toContain(m.library_collection_item_count({ count: 4 }, { locale: 'en' }));
  expect(html).toContain(m.discovery_collection_truncated({}, { locale: 'en' }));
  expect(html).not.toContain(m.home_owner_curator_unavailable({}, { locale: 'en' }));
});

test('Home Collection preview states stay distinct and never reuse another state copy', () => {
  setLocale('en', { reload: false });
  const states = [
    {
      state: 'empty',
      copy: m.discovery_collection_empty,
      other: [m.discovery_collection_withheld, m.discovery_collection_preview_unavailable],
    },
    {
      state: 'withheld',
      copy: m.discovery_collection_withheld,
      other: [m.discovery_collection_empty, m.discovery_collection_preview_unavailable],
    },
    {
      state: 'unavailable',
      copy: m.discovery_collection_preview_unavailable,
      other: [m.discovery_collection_empty, m.discovery_collection_withheld],
    },
  ] as const;
  for (const { state, copy, other } of states) {
    const html = render({ ...curated, preview: { state } });
    expect(html).toContain(`data-home-collection-preview="${state}"`);
    expect(html).toContain(copy({}, { locale: 'en' }));
    for (const otherCopy of other) expect(html).not.toContain(otherCopy({}, { locale: 'en' }));
    expect(html).not.toContain('data-collection-member-id');
  }
});

test('an unavailable curator, an unnamed curator and a dynamic Collection keep their native facts without invented labels', () => {
  setLocale('en', { reload: false });
  const withheld = render({
    ...curated,
    presentationKind: null,
    presentationKindSource: 'mixed',
    curator: { state: 'unavailable', reason: 'withheld' },
  });
  expect(withheld).toContain('data-home-curator-state="unavailable"');
  expect(withheld).toContain('data-home-curator-reason="withheld"');
  expect(withheld).toContain(m.discovery_collection_curator_unavailable({}, { locale: 'en' }));
  expect(withheld).toContain('data-home-collection-kind="mixed"');
  expect(withheld).not.toContain('href="/en/@ada"');

  const unnamed = render({
    ...curated,
    curator: { state: 'available', id: subjectId, label: null, destination: null },
  });
  expect(unnamed).toContain(m.discovery_unnamed_account({}, { locale: 'en' }));
  expect(unnamed).not.toContain('href="/en/@');

  const dynamic = render({
    ...shared,
    membershipKind: 'dynamic',
    outputGeneration: '7',
    cover: null,
    coverSource: 'pending',
    preview: { state: 'empty' },
  } satisfies CollectionCard);
  expect(dynamic).toContain('data-home-collection-presentation="dynamic"');
  expect(dynamic).toContain('data-collection-cover-source="pending"');
  expect(dynamic).not.toContain('data-collection-member-id');
});
