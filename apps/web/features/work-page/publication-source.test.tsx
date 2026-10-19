import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WorkCredits } from './credits.tsx';
import { messages } from './messages.ts';
import { publicationSource } from './publication-source.tsx';

const source = { record: 'source-record', observation: 'source-observation', provider: 'gutenberg',
  externalId: '65061/quick-puff-paste', url: 'https://www.gutenberg.org/ebooks/65061' };

test('only the selected public-domain publication supplies a source link', () => {
  expect(publicationSource({ rights: { basis: 'public-domain', source } })).toEqual(source);
  for (const header of [null, {}, { rightsEvidence: { basis: 'public-domain', source } },
    { rights: { basis: 'unknown', source } }, { rights: { basis: 'public-domain', source: { ...source, url: 'javascript:alert(1)' } } }])
    expect(publicationSource(header)).toBeNull();
});

test('source author, importer as transcriber, director and artist stay distinct in all eight locales', () => {
  const credits = { ok: true as const, data: { nextCursor: null, items: [
    { id: 'source-author', role: 'author', agent: null, displayName: 'Fannie Merritt Farmer', provider: 'gutenberg' },
    { id: 'transcriber', role: 'transcriber', agent: 'https://rezics.com/id/00000000-0000-4000-8000-000000000001',
      displayName: 'Recipe importer', handle: null },
    { id: 'director', role: 'director', displayName: 'Animation director', agent: null },
    { id: 'artist', role: 'artist', displayName: 'Manga artist', agent: null },
  ] } };
  for (const locale of Object.keys(messages) as (keyof typeof messages)[]) {
    const html = renderToStaticMarkup(createElement(WorkCredits, { agentCredits: { ok: true, data: { items: [], nextCursor: null } },
      credits, source, locale, messages: messages[locale] }));
    expect(html).toContain(`role="region" aria-label="${messages[locale].credits}"`);
    expect(html).toContain(messages[locale].transcribedBy);
    expect(html).toContain(messages[locale].directedBy);
    expect(html).toContain(messages[locale].artworkBy);
    const authorLine = html.match(/<p[^>]*font-work-title[^>]*>(.*?)<\/p>/s)?.[1];
    expect(authorLine).toContain('Fannie Merritt Farmer');
    expect(authorLine).not.toContain('Recipe importer');
    expect(authorLine).not.toContain('Animation director');
    expect(authorLine).not.toContain('Manga artist');
    expect(html).toContain(source.url);
    expect(html).not.toContain('/authors/');
  }
});

test('credits expose actual participant roles and links without manufacturing an absent participant', () => {
  const html = renderToStaticMarkup(createElement(WorkCredits, { locale: 'en', messages: messages.en,
    agentCredits: { ok: true, data: { nextCursor: null, items: [
      { id: 'author-credit', role: 'author', displayName: 'Actual author', agent: 'https://rezics.com/id/00000000-0000-4000-8000-000000000001' },
      { id: 'translator-credit', role: 'translator', displayName: 'Actual translator', agent: 'https://rezics.com/id/00000000-0000-4000-8000-000000000002' },
    ] } }, credits: { ok: true, data: { nextCursor: null, items: [] } } }));
  expect(html).toContain('role="region" aria-label="Credits"');
  expect(html).toContain('Author: ');
  expect(html).toContain('Translated by');
  expect(html).toMatch(/<a[^>]*href="[^"]+"[^>]*><bdi[^>]*>Actual author<\/bdi><\/a>/);
  expect(html).toMatch(/<a[^>]*href="[^"]+"[^>]*><bdi[^>]*>Actual translator<\/bdi><\/a>/);
  expect(html).not.toContain('Performer');
});

test('an explicitly unknown source author remains unknown, without assigning authorship to the importer', () => {
  const html = renderToStaticMarkup(createElement(WorkCredits, { locale: 'en', messages: messages.en, source,
    agentCredits: { ok: true, data: { items: [], nextCursor: null } },
    credits: { ok: true, data: { nextCursor: null, items: [
      { id: 'unknown-source-author', role: 'author', displayName: null, provider: 'gutenberg', agent: null },
      { id: 'importer-credit', role: 'transcriber', displayName: 'Recipe importer', agent: null },
    ] } } }));
  expect(html).toContain(messages.en.unknownAuthor);
  expect(html).toContain(messages.en.transcribedBy);
  const authorLine = html.match(/<p[^>]*font-work-title[^>]*>(.*?)<\/p>/s)?.[1];
  expect(authorLine).not.toContain('Recipe importer');
});
