import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { SearchCoverage } from '../src/search/search-context/coverage';
import { resultFreshness } from '../src/search/search-context/observation';
import { searchUnavailablePage } from '../src/search/search-recovery';
import { discoverySearchHref } from '../src/search/search-params';

const state = { query: 'Executed', type: undefined, facets: { genre: ['fiction'] },
  languages: ['fr'], cursor: 'old-generation', sort: undefined };
const timestamp = '2026-01-01T00:00:00.000Z';
test('invalid or missing observations never acquire freshness from a timestamp or empty page', () => {
  for (const value of [undefined, {}, { state: 'complete' }, { state: 'current', behind: 1 }])
    expect(resultFreshness(value, timestamp).state).toBe('unavailable');
  for (const time of ['invalid', '2026-02-30T00:00:00Z', '2026-01-01', ''])
    expect(resultFreshness({ state: 'current' }, time).state).toBe('unavailable');
});
test('executed context and explicit first-page refresh preserve languages and predicates across locales', () => {
  const data = searchUnavailablePage(state);
  const href = discoverySearchHref('en', { ...state, cursor: undefined });
  for (const locale of ['en', 'de', 'es', 'fr', 'ja', 'ko', 'zh-Hans', 'zh-Hant']) {
    const html = renderToStaticMarkup(<SearchCoverage state={state} data={data} locale={locale}
      observation={{ as_of: timestamp, freshness: { state: 'catching-up' } }} refreshHref={href} />);
    expect(html).toContain('<details>');
    expect(html).toContain('Executed');
    expect(html).toContain('fiction');
    expect(html).not.toContain('old-generation');
    expect(html).not.toContain(timestamp);
    expect(html).toContain('role="status"');
  }
  expect(href).toContain('fr');
  expect(href).toContain('fiction');
  expect(href).not.toContain('cursor');
});
