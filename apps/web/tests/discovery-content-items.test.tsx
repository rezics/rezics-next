import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { discoveryExample } from '../src/kernel/fake/search-discovery';
import { DiscoveryResults, discoveryAccountHref } from '../src/search/discovery-results';
import type { DiscoveryPage } from '../src/search/discovery';
import { subjectHref } from '../src/subject/subject-href';

type AccountHit = Extract<DiscoveryPage['hits'][number], { summary: { kind: 'account' } }>;

function mixedPage(): DiscoveryPage {
  return {
    ...discoveryExample,
    hits: discoveryExample.hits.filter((hit) => hit.summary.kind === 'account' || hit.key.kind === 'schema:Book'),
  };
}

function rowMarkup(html: string, accountId: string): string {
  const row = html.match(
    new RegExp(`<li\\b(?=[^>]*data-discovery-account="${accountId}")[^>]*>[\\s\\S]*?<\\/li>`),
  )?.[0];
  if (!row) throw new Error(`Missing discovery account row ${accountId}.`);
  return row;
}

function rendered(page: DiscoveryPage): string {
  return renderToStaticMarkup(createElement(DiscoveryResults, { state: { status: 'ready', page }, locale: 'en' }));
}

test('mixed discovery composes account ContentItems with catalogue rows and preserves native destinations', () => {
  const page = mixedPage();
  const accountHits = page.hits.filter((hit): hit is AccountHit => hit.summary.kind === 'account');
  const account = accountHits.find((hit) => hit.summary.value.handle === 'mira');
  const handleless = accountHits.find((hit) => hit.summary.value.handle === null);
  if (!account || !handleless) throw new Error('Expected linked and handleless Account results.');
  const personId = discoveryExample.hits[0]!.key.id;
  const book = page.hits.find((hit) => hit.key.kind === 'schema:Book');
  if (!book || book.summary.kind !== 'subject') throw new Error('Expected a catalogue result.');
  const html = rendered(page);
  const accountRow = rowMarkup(html, account.key.id);
  const handlelessRow = rowMarkup(html, handleless.key.id);

  expect(html.match(/<li\b[^>]*data-slot="list-row"/g)).toHaveLength(3);
  expect(html.indexOf(`data-discovery-account="${account.key.id}"`)).toBeLessThan(
    html.indexOf(`data-discovery-account="${handleless.key.id}"`),
  );
  expect(html.indexOf(`data-discovery-account="${handleless.key.id}"`)).toBeLessThan(
    html.indexOf(`href="${subjectHref({ id: book.key.id, label: 'Mira’s Atlas' }, 'en').href}"`),
  );

  const headingId = accountRow.match(/<h2 id="([^"]+)"[^>]*>Mira<\/h2>/)?.[1];
  expect(headingId).toBeDefined();
  expect(accountRow).toContain('data-content-item-slot="title"');
  expect(accountRow).toContain(`href="/en/@mira"`);
  expect(accountRow).toContain(`aria-labelledby="${headingId}"`);
  expect(accountRow.match(/<a\b/g)).toHaveLength(2);
  const verifiedSubjectHref = `/en/subjects/${personId}/mira`;
  expect(accountRow).toContain(verifiedSubjectHref);
  expect(accountRow.indexOf(verifiedSubjectHref)).toBeGreaterThan(accountRow.indexOf('</a>'));
  expect(accountRow).toContain('data-slot="list-row-control"');
  expect(accountRow).toMatch(/class="[^"]*\brelative z-10\b[^"]*"[^>]*data-slot="list-row-control"/);
  expect(accountRow).toContain('data-content-item-slot="visual"');
  expect(accountRow).toContain('data-slot="cover"');

  expect(handlelessRow).toContain('>Mira Reading Room</h2>');
  expect(handlelessRow).not.toContain('<a');
  expect(html).toContain(`href="${subjectHref({ id: book.key.id, label: 'Mira’s Atlas' }, 'en').href}"`);
});

test('an invalid current account handle leaves a plain account heading and keeps verified Subject navigation separate', () => {
  const page = mixedPage();
  const account = page.hits.find(
    (hit): hit is AccountHit => hit.summary.kind === 'account' && hit.summary.value.handle === 'mira',
  );
  if (!account) throw new Error('Expected the linked Account discovery hit.');
  const invalidAccount = {
    ...account,
    summary: { ...account.summary, value: { ...account.summary.value, handle: 'mira / invalid' } },
  };
  const invalidPage: DiscoveryPage = {
    ...page,
    hits: page.hits.map((hit) => (hit.key.id === account.key.id ? invalidAccount : hit)),
  };
  expect(discoveryAccountHref(invalidAccount.summary.value, 'en')).toBeUndefined();

  const invalidRow = rowMarkup(rendered(invalidPage), account.key.id);
  expect(invalidRow).toContain('>Mira</h2>');
  expect(invalidRow).not.toContain('href="/en/@');
  expect(invalidRow).toContain('/en/subjects/00000000-0000-4000-8000-000000000811/mira');
});
