import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { dirname } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { OfferPageData } from '../src/checkout/offer';
import { fixedEditionTerms } from '../src/kernel/fake/entitlements';
import recorded from '../src/kernel/recorded/offer.json';
import longRecorded from '../src/kernel/recorded/offer-cjk.json';
import { m } from '../src/paraglide/messages.js';

mock.module('cloudflare:workers', () => ({ env: {} }));
const { OfferPage } = await import('../src/checkout/offer-page');

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
// The route's ordinary component and default dependencies: no replacement button, benefit renderer or hooks.
function render(offer: OfferPageData) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(OfferPage, { offer })));
  } finally {
    client.clear();
  }
}

test('Offer places the actionable purchase decision with its price', async () => {
  const offer: OfferPageData = {
    ...recorded.offer,
    state: 'active',
    revision: 3,
    price: m.money_formatted_recorded_minor({ display: '$12.99', amount: '1299', currency: 'USD', exponent: '2' }),
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
  const window = new Window();
  const document = window.document;
  document.body.innerHTML = render(offer);
  const decision = document.querySelector('[data-slot="offer-decision"]')!;
  expect(decision).not.toBeNull();
  const action = decision.querySelector('button')!;
  expect(action.textContent).toBe(m.offer_buy());
  for (const condition of ['USD', m.commerce_before_tax(), m.offer_terms_revision({ revision: '3' })]) {
    expect(decision.textContent).toContain(condition);
    expect(decision.textContent.indexOf(condition)).toBeLessThan(decision.textContent.indexOf(action.textContent));
  }
  const price = decision.querySelector('p > span')!.textContent;
  expect(price).toBe('$12.99');
  const evidence = decision.querySelector('details')!;
  expect(evidence.textContent).toContain(offer.price);
  const benefit = [...document.querySelectorAll('section')].find(
    (section) => section.querySelector('h2')?.textContent === m.benefit_heading(),
  )!;
  expect(benefit.textContent).toContain(m.benefit_acquisition());
  expect(benefit.textContent).toContain(m.benefit_fixed_version());
  expect(benefit.textContent).toContain(fixedEditionTerms.source.licence);
  expect(document.body.textContent).not.toContain(m.benefit_open_reader());
  const trigger = document.querySelector('button[aria-haspopup="dialog"]')!;
  const dialog = document.getElementById(trigger.getAttribute('aria-controls')!);
  expect(trigger.textContent).toBe(m.offer_full_titles());
  expect(dialog?.tagName).toBe('DIALOG');
  expect(dialog?.querySelector('button')?.textContent).toBe(m.wide_document_inspector_close());
  expect(dialog?.textContent).toContain(offer.subject.subject.title);
  expect(dialog?.textContent).toContain(offer.title);

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
    document.body.innerHTML = render(page);
    const actions = document.querySelectorAll('[data-slot="offer-decision"] button');
    expect(actions).toHaveLength(1);
    expect(actions[0]!.hasAttribute('disabled')).toBe(true);
    if (page.state === 'delisted') expect(document.body.textContent).toContain(m.offer_unavailable());
    if (page.taxBehavior === null) expect(document.body.textContent).toContain(m.commerce_tax_unknown());
    if (page.benefit?.kind !== 'mapped') expect(document.body.textContent).not.toContain(m.benefit_acquisition());
  }
  await window.happyDOM.close();
});
