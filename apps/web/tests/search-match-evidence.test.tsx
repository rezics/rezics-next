import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { discoveryExample } from '../src/kernel/fake/search-discovery';
import { locales } from '../src/paraglide/runtime.js';
import { DiscoveryResults } from '../src/search/discovery-results';
import { parseDiscoveryPage, type DiscoveryPage } from '../src/search/discovery';

function pageWithEvidence(evidence: unknown): unknown {
  const page = structuredClone(discoveryExample) as DiscoveryPage;
  const subject = page.hits.find((hit) => hit.summary.kind === 'subject');
  if (!subject || subject.summary.kind !== 'subject') throw new Error('Expected a catalogue result');
  return { ...page, hits: page.hits.map((hit) => (hit === subject ? { ...hit, matchEvidence: evidence } : hit)) };
}

test('the live mixed result row shows current alias and description matches as safe text with actual languages', () => {
  const id = discoveryExample.hits[0]!.key.id;
  const page = parseDiscoveryPage(
    pageWithEvidence({
      state: 'current',
      source: { id, revision: 1 },
      query: 'a'.repeat(64),
      reasons: [
        { field: 'alias', language: 'zh-Hant', text: '<Harbor> & Silence', spans: [{ start: 1, end: 7 }] },
        { field: 'description', language: 'ja', text: 'A story at blue hour', spans: [{ start: 11, end: 14 }] },
      ],
    }),
  );
  expect(page).toBeDefined();
  const html = renderToStaticMarkup(
    createElement(DiscoveryResults, { state: { status: 'ready', page: page! }, locale: 'en' }),
  );
  expect(html).toContain('data-slot="search-match-primary"');
  expect(html).toContain('lang="zh-Hant"');
  expect(html).toContain('lang="ja"');
  expect(html).toContain('&lt;<mark');
  expect(html).toContain('Harbor</mark> &amp; Silence');
  expect(html).toContain('<details');
  expect(html).not.toContain('<Harbor> & Silence');
  for (const locale of locales) {
    const translated = renderToStaticMarkup(
      createElement(DiscoveryResults, { state: { status: 'ready', page: page! }, locale }),
    );
    expect(translated).toContain('data-slot="search-match-primary"');
    expect(translated).not.toContain('undefined');
  }
});

test('unavailable evidence retires an old excerpt, while unsupported owner evidence is explicit', () => {
  const page = parseDiscoveryPage(pageWithEvidence({ state: 'unavailable' }));
  expect(page).toBeDefined();
  const html = renderToStaticMarkup(
    createElement(DiscoveryResults, { state: { status: 'ready', page: page! }, locale: 'en' }),
  );
  expect(html).toContain('Match details are unavailable.');
  expect(html).toContain('Match details are not supported for this result.');
  expect(html).not.toContain('old excerpt');
});

test('malformed spans, overlong UTF-8 excerpts and a different source identity are refused', () => {
  const base = {
    state: 'current',
    source: { id: discoveryExample.hits[0]!.key.id, revision: 1 },
    query: 'a'.repeat(64),
    reasons: [{ field: 'alias', language: 'zh-Hant', text: 'Harbor', spans: [{ start: 0, end: 6 }] }],
  };
  for (const evidence of [
    { ...base, source: { id: discoveryExample.hits[1]!.key.id, revision: 1 } },
    { ...base, reasons: [{ ...base.reasons[0]!, spans: [{ start: 0, end: 7 }] }] },
    { ...base, reasons: [{ ...base.reasons[0]!, text: '海'.repeat(100), spans: [{ start: 0, end: 1 }] }] },
  ]) {
    expect(parseDiscoveryPage(pageWithEvidence(evidence))).toBeUndefined();
  }
});
