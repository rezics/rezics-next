import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemberListRow, MemberReadingItem } from '../src/components/list-presentation.tsx';
import type { CoverSummary } from '../src/components/cover.tsx';

const cover: CoverSummary = {
  media: 'member-cover',
  width: 1600,
  height: 900,
  placeholder: { thumbhash: '', color: '#465c72' },
  variants: [{ format: 'webp', width: 640 }],
  focalPoint: null,
  credit: null,
};

test('MemberListRow composes its supplied subject facts and trailing control through ContentItem', () => {
  const title = 'A translated member';
  const html = renderToStaticMarkup(
    createElement(
      'ul',
      null,
      createElement(
        MemberListRow,
        {
          href: '/subjects/member',
          subject: { id: 'member', title, types: ['schema:Book'] },
          cover,
          src: () => '/member.webp',
          title,
          titleLang: 'ja',
          listPresentation: { imageAspect: 'landscape', keyFacts: ['schema:genre'] },
          ratio: '2:3',
          storyOverlay: true,
          trailing: createElement('button', { type: 'button' }, 'More actions'),
        },
        createElement(
          'p',
          { 'data-slot': 'member-list-row-facts' },
          'Genre: ',
          createElement('a', { href: '/genres/fantasy' }, 'Fantasy'),
        ),
      ),
    ),
  );

  expect(html.match(/<li\b/g)?.length).toBe(1);
  expect(html.match(/<h[234]\b/g)?.length).toBe(1);
  expect(html).toContain('<h2');
  expect(html).toContain('data-content-item-slot="title"');
  expect(html).toMatch(/<h2\b[^>]*data-slot="member-list-row-title"/);
  expect(html).toContain('data-overlay="visible"');
  expect(html).toContain('lang="ja"');
  expect(html).toContain('data-slot="member-list-row-cover"');
  expect(html).toContain('w-32 sm:w-48');
  expect(html).toContain('data-ratio="16:9"');
  expect(html).toContain('alt=""');
  expect(html).toContain('data-content-item-slot="metadata"');
  expect(html).toContain('href="/genres/fantasy"');
  expect(html).toContain('data-content-item-slot="trailing"');
  expect(html).toContain('More actions');

  const titleId = html.match(/<h2 id="([^"]+)" lang="ja"/)?.[1];
  expect(titleId).toBeDefined();
  expect(html).toContain(`aria-labelledby="${titleId}"`);

  const primaryLink = html.match(/<a\b[^>]*data-slot="list-row-link"[^>]*>[\s\S]*?<\/a>/)?.[0];
  expect(primaryLink).toBeDefined();
  expect(primaryLink).not.toContain('href="/genres/fantasy"');
  expect(primaryLink).not.toMatch(/<(?:a|button|input)\b/);
  expect(html.match(/<a\b/g)?.length).toBe(2);
  expect(html).toContain('[&_button]:min-h-11');
});

test('MemberListRow keeps known Type defaults ahead of ratio and leaves unknown Type geometry to composition', () => {
  const known = renderToStaticMarkup(
    createElement(MemberListRow, {
      href: '/subjects/movie',
      subject: { id: 'movie', title: 'Movie', types: ['schema:Movie'] },
      cover: null,
      src: () => '',
      title: 'Movie',
      ratio: '2:3',
    }),
  );
  const unknown = renderToStaticMarkup(
    createElement(MemberListRow, {
      href: '/subjects/unknown',
      subject: { id: 'unknown', title: 'Unclassified item', types: ['type:Unreleased'] },
      cover: null,
      src: () => '',
      title: 'Unclassified item',
      ratio: '2:3',
    }),
  );

  expect(known).toContain('data-ratio="5:7"');
  expect(known).toContain('w-[72px] sm:w-24');
  expect(unknown).toContain('data-ratio="2:3"');
  expect(unknown).toContain('w-[72px] sm:w-24');
  expect(unknown).toContain('data-state="placeholder"');
});

test('MemberReadingItem keeps grid metadata, position, evidence and Inspect inside the complete item flow', () => {
  const covered = renderToStaticMarkup(
    createElement(MemberReadingItem, {
      layout: 'grid',
      href: '/subjects/member',
      title: 'A translated member title that wraps',
      cover: {
        subject: { id: 'member', title: 'A translated member title that wraps', types: ['schema:Book'] },
        cover,
        src: () => '/member.webp',
      },
      occurrenceId: 'member-occurrence',
      occurrenceLabel: 'A translated member title, item 2',
      position: 'Position 2 on this page',
      metadata: createElement('p', null, 'A supplied fact that wraps across the tile.'),
      evidence: createElement('a', { href: '/actions' }, 'Available action'),
      detailId: 'detail',
      expanded: false,
      inspectLabel: 'Inspect details',
      onInspect() {},
    }),
  );
  const card = /<article\b[^>]*data-slot="cover-card"[\s\S]*?<\/article>/u.exec(covered)?.[0];
  expect(card).toContain('A supplied fact that wraps across the tile.');
  expect(card).toContain('Position 2 on this page');
  expect(card).toContain('Available action');
  expect(card).toContain('data-collection-detail-opener');
  expect(covered).toContain('data-collection-member-id="member-occurrence"');

  const unavailable = renderToStaticMarkup(
    createElement(MemberReadingItem, {
      layout: 'grid',
      title: 'Unavailable member',
      occurrenceId: 'unavailable-occurrence',
      occurrenceLabel: 'Unavailable member, item 4',
      position: 'Position 4 on this page',
      metadata: createElement('p', null, 'No supplied summary.'),
      detailId: 'detail',
      expanded: false,
      inspectLabel: 'Inspect details',
      onInspect() {},
    }),
  );
  expect(unavailable).toContain('No supplied summary.');
  expect(unavailable).toContain('Position 4 on this page');
  expect(unavailable).toContain('data-collection-detail-opener');
});
