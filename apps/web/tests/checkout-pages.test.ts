import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { formatOfferPrice } from '../src/checkout/price.ts';
import { OfferPage } from '../src/checkout/offer-page.tsx';
import { OrderPage, type OrderPageData } from '../src/checkout/order-page.tsx';
import type { OfferPageData } from '../src/checkout/offer.ts';
import { subjectCover } from '../src/checkout/subject-cover.tsx';

const subjectId = '01a17a79-d88a-77aa-a166-81d2b657df87';
const offerId = '01a17a7a-477c-777f-9812-c7322f4814a8';
const orderId = '01a17a7a-4833-72f9-95e4-074c6aca9bb5';
const title = 'The Little Prince';
const subject = subjectCover('en', subjectId, 'Book edition', {
  id: subjectId,
  types: ['schema:Book'],
  label: { value: title, language: 'en' },
  cover: null,
});
const offer: OfferPageData = {
  id: offerId,
  title: 'Book edition',
  currency: 'usd',
  unitAmountMinor: 1299,
  state: 'active',
  price: formatOfferPrice('en', 'usd', 1299),
  idempotencyKey: 'checkout-key',
  subject,
};
const paidOrder: OrderPageData = {
  id: orderId,
  offerId,
  title: 'Book edition',
  settlement: 'paid',
  createdAt: '2026-10-26T23:09:56.659Z',
  subject,
};

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

test('an offer shows its subject cover and localized subject title, price, included item, and one buy action', () => {
  const html = renderToString(createElement(OfferPage, { offer }));
  expect(html).toContain('data-slot="cover"');
  expect(text(html)).toContain(title);
  expect(text(html)).toContain(formatOfferPrice('en', 'usd', 1299));
  expect(text(html)).toContain('You receive');
  expect(text(html)).toContain(offer.title);
  expect(html.match(/<h1\b/g)).toHaveLength(1);
  expect(html.match(/<button\b/g)).toHaveLength(1);
});

test('the displayed title and subject link use the label selected for the page locale', () => {
  const localizedSubject = subjectCover('zh-Hans', subjectId, offer.title, {
    id: subjectId,
    types: ['schema:Book'],
    label: { value: '小王子', language: 'zh-Hans' },
    cover: null,
  });
  const html = renderToString(createElement(OfferPage, { offer: { ...offer, subject: localizedSubject } }));
  expect(html).toContain('<h1');
  expect(text(html)).toContain('小王子');
  expect(html).toContain('/zh-Hans/subjects/');
  expect(html).not.toMatch(/<h1[^>]*>[^<]*註解/);
});

test('a paid order shows a linked receipt and next steps without an ISO timestamp', () => {
  const html = renderToString(createElement(OrderPage, { order: paidOrder, checkout: 'success' }));
  expect(html).toContain('data-slot="cover"');
  expect(html).toContain(`/en/subjects/${subjectId}/the-little-prince`);
  expect(html).toContain(`/en/offers/${offerId}`);
  expect(html).toContain('/en/library');
  expect(html).toContain('>Receipt</h2>');
  expect(html).toContain('>Order placed</dt>');
  expect(text(html)).toContain(
    new Intl.DateTimeFormat('en', { dateStyle: 'long', timeStyle: 'short' }).format(new Date(paidOrder.createdAt)),
  );
  expect(text(html)).toContain(orderId);
  expect(html.match(/<h1\b/g)).toHaveLength(1);
  expect(html).not.toMatch(/\d{4}-\d\d-\d\dT\d\d:\d\d/);
});

test('pending, failed, and canceled orders communicate their state and the failure states link to the offer', () => {
  const pending = renderToString(createElement(OrderPage, { order: { ...paidOrder, settlement: 'pending' } }));
  expect(text(pending)).toMatch(/confirm|payment|processing/i);
  for (const checkout of [undefined, 'canceled'] as const) {
    const html = renderToString(
      createElement(OrderPage, {
        order: { ...paidOrder, settlement: checkout ? 'pending' : 'failed' },
        ...(checkout ? { checkout } : {}),
      }),
    );
    expect(html).toContain(`/en/offers/${offerId}`);
    expect(text(html)).toMatch(/payment|cancel/i);
  }
});

test('page headings share the shell heading size and long CJK offer titles fit a narrow layout', () => {
  const long = '小王子（全新註解・雙語對照・電子書典藏版）——附作者手繪水彩插圖、譯者導讀與版本考證';
  const html = renderToString(createElement(OfferPage, { offer: { ...offer, title: long } }));
  expect(html).toContain('text-4xl');
  expect(html).toContain('text-balance');
  expect(html).toContain('min-w-0');
  expect(html).toContain('break-words');
});
