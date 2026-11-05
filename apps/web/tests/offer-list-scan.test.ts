import { expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as start from '../.storybook/react-start';
import {
  creatorOffersStoryPage,
  delistedCreatorOfferFixture,
  setCreatorOffersStory,
} from '../src/kernel/fake/creator-offers';
import { subjectOfferFixture, subjectOffersStoryPage } from '../src/kernel/fake/subject-offers';
import { m } from '../src/paraglide/messages.js';
import { setLocale } from '../src/paraglide/runtime.js';

const csrfToken = 'current-session-csrf';
const session = {
  signedIn: async () => ({ signedIn: true, subject: 'current-creator', csrfToken }),
  credential: async () => ({
    status: 'active',
    accessToken: 'current-creator-token',
    subject: 'current-creator',
    csrfToken,
  }),
};
const request = new Request('https://site.test/en/creator/offers', {
  headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` },
});
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => ({ getRequest: () => request, setResponseHeader() {} }));
mock.module('cloudflare:workers', () => ({
  env: {
    KERNEL_ORIGIN: 'http://kernel.local',
    AUTH_ISSUER: 'https://auth.test',
    API_RESOURCE: 'https://kernel.test',
    WEBSITE_SCOPES: 'openid',
    WEBSITE_CLIENT_ID: 'web',
    WEBSITE_CLIENT_KEY: '{}',
    SESSIONS: { idFromName: (id: string) => id, get: () => session },
  },
}));
const { readCreatorOffers } = await import('../src/checkout/creator-offers');
const { CreatorOffersPage } = await import('../src/checkout/creator-offers-page');
const { readSubjectOffers } = await import('../src/checkout/subject-offers');
const { SubjectOffersView } = await import('../src/checkout/subject-offers-region');
const { createStoryRecordedKernelFetch } = await import('../src/kernel/fake');

test('Creator scans offer price and status before expanding long titles', async () => {
  // The served readers retain their default adapters and generated callers. Only the session/native
  // transport uses illustrative fixtures, through the same server-function seam as Storybook.
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/creator/offers' });
  const document = window.document;
  const calls: Request[] = [];
  const recorded = createStoryRecordedKernelFetch();
  const fetcher = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const call = new Request(input, init);
    calls.push(call);
    expect(call.method).toBe('GET');
    expect(call.headers.get('authorization')).toBe('Bearer current-creator-token');
    const url = new URL(call.url);
    if (url.pathname === '/v1/platform/exposure') return Response.json({ admitted: ['selling', 'purchases'] });
    if (url.pathname === `/v1/subjects/${subjectOfferFixture.targetSubjectId}/offers`) {
      const page = subjectOffersStoryPage('long-title');
      if (page.kind !== 'ready') throw new Error('Expected illustrative subject offers');
      const { kind, ...wire } = page;
      return Response.json(wire);
    }
    return recorded(input, init);
  });
  setLocale('en', { reload: false });
  setCreatorOffersStory('long-title');
  try {
    const data = await readCreatorOffers({ data: {} });
    const fixture = creatorOffersStoryPage('long-title');
    expect(data.page).toEqual(fixture);
    expect(data.selling).toBe(true);
    expect(data.csrfToken).toBe(csrfToken);
    expect(data.schema).toBeNull(); // The story transport makes no provider configuration claim.
    document.body.innerHTML = renderToStaticMarkup(createElement(CreatorOffersPage, { data, locale: 'en' }));
    const row = document.querySelector('[data-offer-state="active"]')!;
    if (fixture.kind !== 'ready') throw new Error('Expected illustrative creator offers');
    const offer = fixture.offers[0]!;
    const link = row.querySelector('a')!;
    expect(link.textContent).toBe(offer.title);
    expect(link.getAttribute('href')).toBe(`/en/offers/${offer.id}`);
    expect(link.hasAttribute('role')).toBe(false);
    expect(link.hasAttribute('tabindex')).toBe(false);
    expect(row.querySelector('h2')!.classList.contains('line-clamp-2')).toBe(true);
    const details = row.querySelector('details')!;
    const summary = details.querySelector('summary')!;
    expect(summary.textContent).toBe(m.commerce_full_title());
    expect(summary.closest('[data-slot="list-row-control"]')).not.toBeNull();
    expect(details.open).toBe(false);
    const initialScan = row.innerHTML.split('<details>')[0]!;
    expect(initialScan).toContain('$12.00');
    expect(initialScan).toContain(m.creator_offers_active());
    const controls = () => [...row.querySelectorAll('button')].map((button) => [button.textContent, button.disabled]);
    const eligibility = controls();
    expect(eligibility).toContainEqual([m.creator_delist(), false]);
    expect(eligibility).toContainEqual([m.creator_reprice(), true]);
    summary.click();
    expect(details.open).toBe(true);
    expect(details.querySelector('p')!.textContent).toBe(offer.title);
    expect(controls()).toEqual(eligibility);
    summary.click();
    expect(details.open).toBe(false);
    let destination: string | undefined;
    link.addEventListener('click', (event: Event) => {
      event.preventDefault();
      destination = link.href;
    });
    link.click();
    expect(destination).toBe(`https://site.test/en/offers/${offer.id}`);
    const history = document.querySelector('[data-offer-state="delisted"]')!;
    expect(history.textContent).toContain(m.creator_offers_delisted());
    expect(history.textContent).toContain(m.creator_offers_unknown());
    expect(history.querySelector('a')).toBeNull();
    expect(history.querySelector('details p')!.textContent).toBe(delistedCreatorOfferFixture.title);
    expect(history.querySelector('form')).toBeNull();
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      '/v1/platform/exposure',
      '/v1/offers',
      '/v1/commerceMoney',
    ]);
    expect(new URL(calls[1]!.url).searchParams.get('limit')).toBe('20');

    const restricted = renderToStaticMarkup(
      createElement(CreatorOffersPage, { data: { ...data, selling: false }, locale: 'en', offerPageAvailable: false }),
    );
    document.body.innerHTML = restricted;
    expect(document.querySelector('[data-slot="list-row-link"]')).toBeNull();
    expect([...document.querySelectorAll('form button')].every((button) => button.disabled)).toBe(true);

    const subjectPage = await readSubjectOffers({
      data: { subjectId: subjectOfferFixture.targetSubjectId, locale: 'en', credentialMode: 'session' },
    });
    expect(subjectPage).toEqual(subjectOffersStoryPage('long-title'));
    document.body.innerHTML = renderToStaticMarkup(
      createElement(SubjectOffersView, { page: subjectPage, locale: 'en' }),
    );
    const subjectRow = document.querySelector('li')!;
    expect(subjectRow.querySelector('h3')!.classList.contains('line-clamp-2')).toBe(true);
    const subjectScan = subjectRow.innerHTML.split('<details>')[0]!;
    expect(subjectScan).toContain('$12.99');
    expect(subjectScan).toContain(m.creator_offers_active());
    const review = subjectRow.querySelector('a')!;
    expect(review.getAttribute('href')).toBe(`/en/offers/${subjectOfferFixture.id}`);
    expect(review.textContent).toBe(subjectPage.kind === 'ready' ? subjectPage.offers[0]!.title : '');
    expect(review.getAttribute('aria-label')).toBe(
      m.subject_purchase_review_offer({ title: subjectPage.kind === 'ready' ? subjectPage.offers[0]!.title : '' }),
    );
    subjectRow.querySelector('summary')!.click();
    expect(subjectRow.querySelector('details')!.open).toBe(true);
    expect(subjectRow.querySelector('details p')!.textContent).toBe(
      subjectPage.kind === 'ready' ? subjectPage.offers[0]!.title : '',
    );
    expect(document.querySelector('button, form, a[href*="/entitlements"]')).toBeNull();
    expect(calls).toHaveLength(4); // Expansion/navigation add no reads or mutations.
    expect(new URL(calls[3]!.url).searchParams.get('limit')).toBe('10');
  } finally {
    fetcher.mockRestore();
    setCreatorOffersStory();
    await window.happyDOM.close();
  }
});
