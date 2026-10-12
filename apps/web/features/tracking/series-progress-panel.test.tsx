import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { editions as fixture, iri, saoOne } from './fixtures.ts';
import { createMemoryMain, memoryTracking } from './memory.ts';
import { copyOf } from './messages.ts';
import { PreferenceForm } from './series-progress-panel.tsx';
import type { EditionPreference, Editions } from './types.ts';

const preference: EditionPreference = { work: saoOne, language: 'pl', version: 7,
  edition: { kind: 'release', resource: iri('21'), revision: iri('219') } };
const firstPage: Editions = { realizations: [], releases: Array.from({ length: 20 }, (_, index) => ({
  ...fixture.releases[0]!, id: iri(String(index + 1)), revision: iri(String(index + 101)),
})), releasesCursor: 'page-two', more: true };

function render(editions: Editions | null) {
  return renderToStaticMarkup(<PreferenceForm work={saoOne} preference={preference} language="pl"
    editions={editions} api={memoryTracking(createMemoryMain())} locale="en" t={copyOf('en')}
    onSaved={() => {}} onLanguage={() => {}} />);
}

test('a saved edition outside the first page remains visible beside its content language', () => {
  const html = render(firstPage);
  expect(html).toContain('Polish');
  expect(html).toContain('Selected edition');
  expect(html).toContain('Show more editions');
});

test('an unavailable edition list keeps the saved edition visible and offers recovery', () => {
  const html = render(null);
  expect(html).toContain('Polish');
  expect(html).toContain('Selected edition');
  expect(html).toContain('Try again');
});
