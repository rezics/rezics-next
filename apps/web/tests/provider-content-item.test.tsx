import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ProviderReviewActions,
  type ProviderReviewTransport,
} from '../src/features/import-review/provider-review-actions-view';
import type { ProviderQueuePage } from '../src/features/import-review/provider-queue';
import { providerReviewFixture } from '../src/kernel/fake/provider-review-actions';
import { m } from '../src/paraglide/messages.js';

function render(page: ProviderQueuePage, transport: ProviderReviewTransport) {
  return renderToStaticMarkup(
    createElement(ProviderReviewActions, {
      page,
      locale: 'en',
      transport,
      onRefresh: () => {},
    }),
  );
}

function expectNoNestedAnchors(markup: string) {
  let depth = 0;
  for (const match of markup.matchAll(/<\/?a\b[^>]*>/g)) {
    if (match[0]!.startsWith('</')) {
      depth -= 1;
      expect(depth).toBeGreaterThanOrEqual(0);
    } else {
      expect(depth).toBe(0);
      depth += 1;
    }
  }
  expect(depth).toBe(0);
}

test('Provider review uses shared content rows with named native links and independent controls', () => {
  const fixture = providerReviewFixture('ready', 'en');
  const html = render(fixture.page, fixture.transport);
  const row = fixture.page.rows[0]!;
  const primaryLink = [...html.matchAll(/<a\b[^>]*>/g)].find((match) => match[0]!.includes(`href="${row.href}"`));
  const title = [...html.matchAll(/<h2\b(?=[^>]*data-content-item-slot="title")([^>]*)>([\s\S]*?)<\/h2>/g)].find(
    (match) => match[2] === row.label,
  );

  expect(html).toContain('data-slot="list-row"');
  expect(html).toContain('data-content-item-slot="title"');
  expect(title?.[2]).toBe(row.label);
  expect(primaryLink?.[0]).toContain('aria-labelledby=');
  const labelledBy = primaryLink?.[0].match(/aria-labelledby="([^"]+)"/)?.[1];
  expect(labelledBy).toBe(title?.[1].match(/\bid="([^"]+)"/)?.[1]);
  const metadataIndex = html.indexOf('data-content-item-slot="metadata"');
  const sourceLink = [...html.matchAll(/<a\b[^>]*>/g)].find((match) =>
    match[0]!.includes('href="https://www.wikidata.org/wiki/Q25338"'),
  );
  expect(sourceLink).toBeDefined();
  expect(html.indexOf(sourceLink![0])).toBeGreaterThan(metadataIndex);
  expect(html).toContain('data-content-item-slot="metadata"');
  expect(html).toContain('data-content-item-slot="actions"');
  expect(html).toContain('role="checkbox"');
  const actionIndex = html.indexOf('data-content-item-slot="actions"');
  expect(metadataIndex).toBeLessThan(actionIndex);
  expect(html.indexOf(sourceLink![0])).toBeLessThan(actionIndex);
  expect(actionIndex).toBeLessThan(html.indexOf('role="checkbox"'));
  expectNoNestedAnchors(html);
});

test('Provider comparison keeps complete evidence and current Context values reachable in the row details', () => {
  const fixture = providerReviewFixture('ready', 'en');
  const page = structuredClone(fixture.page);
  for (const row of page.rows) {
    const qualifier = row.reading?.ok ? row.reading.current.subject.statements['schema:author']?.[0] : undefined;
    if (qualifier) row.candidate.statement.qualifiers = [structuredClone(qualifier)];
  }
  const html = render(page, fixture.transport);

  expect(html).toContain('<details');
  expect(html).toContain(`${m.context_selected_values()} · ${m.candidate_proposed()}`);
  for (const value of [
    m.context_selected_values(),
    m.candidate_proposed(),
    '1943',
    '1946',
    m.subject_qualifiers(),
    m.subject_sources(),
    m.candidate_rank(),
    m.candidate_rank_normal(),
    fixture.page.rows[0]!.subject,
    fixture.page.rows[0]!.candidate.id,
    fixture.page.rows[0]!.candidate.statement.id,
    fixture.page.rows[0]!.candidate.statement.property.id,
    '2026-10-30',
    'wikidata-1',
  ])
    expect(html).toContain(value);
  expect(html).toContain('data-content-item-slot="metadata"');
  expect(html).toContain('https://www.wikidata.org/wiki/Q25338');
  expectNoNestedAnchors(html);
});

test('Rows without a valid destination remain unlinked and invent no internal target', () => {
  const fixture = providerReviewFixture('ready', 'en');
  const page = {
    ...fixture.page,
    rows: fixture.page.rows.map((row, index) => ({ ...row, href: index ? 'javascript:alert(1)' : '' })),
  };
  const html = render(page, fixture.transport);

  expect(html).not.toContain('href=""');
  expect(html).not.toContain('javascript:');
  expect(html).not.toContain(fixture.page.rows[0]!.href);
  for (const row of page.rows) expect(html).not.toContain(`href="${row.href}"`);
  expect(html).toContain('data-content-item-slot="title"');
  expect(html).toContain(page.rows[0]!.label);
  expect(html).toContain(page.rows[0]!.propertyLabel);
  expectNoNestedAnchors(html);
});

test('Withheld candidates conceal identifiers while an unavailable comparison keeps the supplied identity', () => {
  const fixture = providerReviewFixture('ready', 'en');
  const deniedPage = {
    ...fixture.page,
    rows: fixture.page.rows.map((row) => ({ ...row, reading: { ok: false as const, reason: 'denied' as const } })),
  };
  const denied = render(deniedPage, fixture.transport);
  expect(denied).toContain(m.provider_missing());
  expect(denied).not.toContain(fixture.page.rows[0]!.label);
  expect(denied).not.toContain(fixture.page.rows[0]!.candidate.id);
  expect(denied).not.toContain('role="checkbox"');
  expectNoNestedAnchors(denied);

  const unavailablePage = {
    ...fixture.page,
    rows: fixture.page.rows.map((row) => ({ ...row, reading: { ok: false as const, reason: 'unavailable' as const } })),
  };
  const unavailable = render(unavailablePage, fixture.transport);
  expect(unavailable).toContain(fixture.page.rows[0]!.label);
  expect(unavailable).toContain(fixture.page.rows[0]!.candidate.id);
  expect(unavailable).toContain(m.prq_comparison_unavailable());
  expect(unavailable).toContain('data-content-item-slot="title"');
  expectNoNestedAnchors(unavailable);
});
