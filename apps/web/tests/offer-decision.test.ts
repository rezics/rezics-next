import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { OfferPageData } from '../src/checkout/offer';
import { fixedEditionTerms } from '../src/kernel/fake/entitlements';
import recorded from '../src/kernel/recorded/offer.json';
import longRecorded from '../src/kernel/recorded/offer-cjk.json';
import { m } from '../src/paraglide/messages.js';

mock.module('cloudflare:workers', () => ({ env: {} }));
const { OfferPage } = await import('../src/checkout/offer-page');

// The route's ordinary component and default dependencies: no replacement button, benefit renderer or hooks.
function render(offer: OfferPageData) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(OfferPage, { offer })));
  } finally {
    client.clear();
  }
}

test('Offer places the actionable purchase decision with its price', () => {
  const offer: OfferPageData = {
    ...recorded.offer,
    state: 'active',
    revision: 3,
    price: '$12.99',
    moneyUnit: { system: 'stripe-api', exponent: 2, factsVersion: 'stripe-money-v1' },
    taxBehavior: 'exclusive',
    idempotencyKey: '0192f3a0-6c1e-7b2a-9d4e-000000000080',
    subject: {
      subject: {
        id: recorded.offer.targetSubjectId,
        title: 'A long subject title '.repeat(30),
        types: recorded.offer.subject.types,
      },
      cover: null,
      href: null,
    },
    title: longRecorded.offer.title.repeat(10),
    benefit: { kind: 'mapped', terms: fixedEditionTerms },
    creatorName: 'Creator',
  };
  const html = render(offer);
  const decision = html.match(/<section\b[^>]*data-slot="offer-decision"[^>]*>[\s\S]*?<\/section>/)?.[0];
  expect(decision).toBeDefined();
  const block = decision!;
  const buy = block.match(/<button\b[^>]*>[\s\S]*?<\/button>/)?.[0];
  expect(buy).toBeDefined();
  expect(buy).toContain(`>${m.offer_buy()}</button>`);
  expect(html.match(/<button\b/g)).toHaveLength(1);
  for (const condition of [
    offer.price,
    'USD',
    m.commerce_before_tax(),
    m.benefit_acquisition(),
    m.benefit_fixed_version(),
    m.offer_terms_revision({ revision: '3' }),
  ]) {
    expect(block).toContain(condition);
    expect(block.indexOf(condition)).toBeLessThan(block.indexOf(buy!));
  }
  // The complete shared terms, including the licence, remain below this single action.
  const terms = html.indexOf('<h2');
  expect(terms).toBeGreaterThan(html.indexOf(block) + block.length);
  expect(html.slice(terms)).toContain(m.benefit_heading());
  expect(html.slice(terms)).toContain(fixedEditionTerms.source.licence);
  expect(html).not.toContain(m.benefit_open_reader());
  expect(html).toMatch(/<h1[^>]*class="[^"]*line-clamp-2[^"]*"/);
  expect(html).toContain(offer.subject.subject.title);
  expect(html).toContain(offer.title);
  expect(html).toMatch(new RegExp(`<summary[^>]*>${m.offer_full_titles()}</summary>`));

  // Default server composition waits for real hydration/session and exposure, even with known terms.
  // Delisting and unknown money/tax/benefit states retain a genuinely disabled native purchase control.
  for (const page of [
    offer,
    { ...offer, state: 'delisted' as const },
    { ...offer, moneyUnit: null },
    { ...offer, taxBehavior: null },
    { ...offer, benefit: { kind: 'unknown' as const } },
    { ...offer, benefit: { kind: 'unavailable' as const } },
  ]) {
    const markup = render(page);
    const button = markup.match(/<button\b[^>]*>/)?.[0];
    expect(button).toContain('disabled=""');
    expect(markup.match(/<button\b/g)).toHaveLength(1);
    if (page.state === 'delisted') expect(markup).toContain(m.offer_unavailable());
    if (page.taxBehavior === null) expect(markup).toContain(m.commerce_tax_unknown());
    if (page.benefit?.kind !== 'mapped') expect(markup).not.toContain(m.benefit_acquisition());
  }
});
