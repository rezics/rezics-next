import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SubjectOffer, SubjectOffersData } from '../src/checkout/subject-offers';
import { subjectOfferFixture } from '../src/kernel/fake/subject-offers';
import { m } from '../src/paraglide/messages.js';
import { getLocale, setLocale } from '../src/paraglide/runtime.js';

mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start', () => import('../.storybook/react-start'));
mock.module('@tanstack/react-start/server', () => import('../.storybook/react-start'));
const { SubjectOffersView } = await import('../src/checkout/subject-offers-region');

// UNRUN: composed assertions over the actual UI; native/browser/visual acceptance remains deferred.
test('Shared subject offer summaries retain captured terms price and exact localized review destination', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/fr/subjects/example' });
  const document = window.document;
  const previousLocale = getLocale();
  const locale = 'fr';
  // Supplied presentation inputs exercise encoding and historical absence, not native offer admission.
  const zero: SubjectOffer = {
    ...subjectOfferFixture,
    id: 'captured /+?=#版%',
    title: 'Captured <title> & commentary / '.repeat(12),
    currency: 'usd',
    unitAmountMinor: 0,
    moneyUnit: { system: 'stripe-api', exponent: 2, factsVersion: 'stripe-money-v1' },
    taxBehavior: 'exclusive',
    contentEdition: {
      ...subjectOfferFixture.contentEdition!,
      source: { licence: 'Captured licence for this fixed edition' },
    },
  };
  const unknown: SubjectOffer = {
    ...zero,
    id: 'unknown terms /二',
    title: 'Historical price unit and benefit unavailable',
    currency: 'jpy',
    unitAmountMinor: 123456,
    moneyUnit: null,
    contentEdition: null,
  };
  const whole: SubjectOffer = {
    ...zero,
    id: 'whole-unit offer',
    title: 'Supplied whole-unit price with mismatched terms',
    currency: 'jpy',
    unitAmountMinor: 1299,
    moneyUnit: { system: 'stripe-api', exponent: 0, factsVersion: 'stripe-money-v1' },
    taxBehavior: 'inclusive',
    contentEdition: {
      ...zero.contentEdition!,
      targetSubjectId: '0192f3a0-6c1e-7b2a-9d4e-000000000099',
    },
  };
  const page: SubjectOffersData = {
    kind: 'ready',
    offers: [zero, unknown, whole],
    next: null,
    projectionState: 'ready',
  };
  try {
    setLocale('en', { reload: false });
    document.body.innerHTML = renderToStaticMarkup(<SubjectOffersView page={page} locale={locale} />);
    expect(document.querySelector('h2')?.textContent).toBe(m.subject_purchase_heading({}, { locale }));
    const rows = [...document.querySelectorAll('ul > li')];
    expect(rows).toHaveLength(3);
    for (const [index, offer] of page.offers.entries()) {
      const row = rows[index]!;
      const heading = row.querySelector('h3')!;
      const links = [...row.querySelectorAll('a')];
      expect(row.getAttribute('data-slot')).toBe('list-row');
      expect(heading.getAttribute('data-content-item-slot')).toBe('title');
      expect(heading.textContent).toBe(offer.title);
      expect(heading.hidden || heading.classList.contains('sr-only') || heading.hasAttribute('aria-hidden')).toBe(
        false,
      );
      expect(heading.classList.contains('line-clamp-2')).toBe(true);
      expect(links).toHaveLength(1);
      expect(links[0]!.getAttribute('href')).toBe(`/fr/offers/${encodeURIComponent(offer.id)}`);
      expect(links[0]!.getAttribute('aria-label')).toBe(
        m.subject_purchase_review_offer({ title: offer.title }, { locale }),
      );
      expect(links[0]!.getAttribute('aria-label')).toContain(heading.textContent);
      expect(links[0]!.hasAttribute('role') || links[0]!.hasAttribute('tabindex')).toBe(false);
      expect(row.querySelector('li, img, a a, a button, a summary, a form')).toBeNull();
      expect(row.querySelector('[data-content-item-slot="state"]')?.textContent).toBe(
        m.creator_offers_active({}, { locale }),
      );
      expect(row.querySelector('[data-content-item-slot="preview"]')?.textContent).toBe(
        m.subject_purchase_review({}, { locale }),
      );
    }
    const facts = rows.map((row) =>
      [...row.querySelectorAll('[data-content-item-slot="metadata"] p')].map((p) => p.textContent),
    );
    const zeroPrice = new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(0);
    const wholePrice = new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: 'JPY',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(1299);
    expect(facts).toEqual([
      [
        `${zeroPrice} · ${m.commerce_before_tax({}, { locale })}`,
        m.benefit_fixed_version({}, { locale }),
        m.benefit_acquisition({}, { locale }),
        `${m.benefit_licence({}, { locale })}: ${zero.contentEdition!.source.licence}`,
      ],
      [m.subject_purchase_price_unknown({}, { locale }), m.benefit_terms_unavailable({}, { locale })],
      [wholePrice, m.benefit_terms_unavailable({}, { locale })],
    ]);
    expect(document.querySelector('a[href*="/editions/"], form, button')).toBeNull();
    const row = rows[0]!;
    const details = row.querySelector('details')!;
    const summary = details.querySelector('summary')!;
    const link = row.querySelector('a')!;
    const navigations: string[] = [];
    link.addEventListener('click', (event) => {
      event.preventDefault();
      navigations.push(link.href);
    });
    expect(summary.textContent).toBe(m.commerce_full_title({}, { locale }));
    expect(summary.closest('[data-content-item-slot="actions"][data-slot="list-row-control"]')).not.toBeNull();
    expect(summary.closest('a')).toBeNull();
    expect(summary.classList.contains('min-h-11')).toBe(true);
    expect(details.open).toBe(false);
    summary.click();
    expect(details.open).toBe(true);
    expect(details.querySelector('p')?.textContent).toBe(zero.title);
    expect(navigations).toEqual([]);
    summary.click();
    expect(details.open).toBe(false);
    link.click();
    expect(navigations).toEqual([`https://site.test/fr/offers/${encodeURIComponent(zero.id)}`]);
  } finally {
    setLocale(previousLocale, { reload: false });
    await window.happyDOM.close();
  }
});

// UNRUN: existing pending/refusal/recovery presentation, without query or session substitutions.
test('Subject offer pending preparing and denied regions keep their existing recovery and partial rows', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/fr/subjects/example' });
  const document = window.document;
  const locale = 'fr';
  try {
    document.body.innerHTML = renderToStaticMarkup(<SubjectOffersView page={{ kind: 'pending' }} locale={locale} />);
    expect(document.querySelector('[role="status"]')?.textContent).toBe(m.subject_purchase_pending({}, { locale }));
    expect(document.querySelector('ul, a, button, [role="alert"]')).toBeNull();

    document.body.innerHTML = renderToStaticMarkup(
      <SubjectOffersView page={{ kind: 'preparing' }} locale={locale} onRetry={() => {}} />,
    );
    expect(document.querySelector('[role="status"]')?.textContent).toBe(m.subject_purchase_preparing({}, { locale }));
    expect(document.querySelector('button')?.textContent).toBe(m.subject_purchase_retry({}, { locale }));
    expect(document.querySelector('ul, a, [role="alert"]')).toBeNull();

    document.body.innerHTML = renderToStaticMarkup(
      <SubjectOffersView
        page={{ kind: 'ready', offers: [subjectOfferFixture], projectionState: 'preparing', next: 'exact/+?=#cursor' }}
        locale={locale}
        onNext={() => {}}
        onRetry={() => {}}
        onRestart={() => {}}
      />,
    );
    expect(document.querySelector('[role="status"]')?.textContent).toBe(m.subject_purchase_preparing({}, { locale }));
    expect(document.querySelectorAll('ul > li')).toHaveLength(1);
    expect([...document.querySelectorAll('button')].map((button) => button.textContent)).toEqual([
      m.subject_purchase_next({}, { locale }),
      m.subject_purchase_restart({}, { locale }),
      m.subject_purchase_retry({}, { locale }),
    ]);

    document.body.innerHTML = renderToStaticMarkup(
      <SubjectOffersView page={{ kind: 'ready', offers: [], projectionState: 'preparing', next: null }} locale={locale} />,
    );
    expect(document.querySelector('[role="status"]')?.textContent).toBe(m.subject_purchase_preparing({}, { locale }));
    expect(document.body.textContent).not.toContain(m.subject_purchase_empty({}, { locale }));

    document.body.innerHTML = renderToStaticMarkup(
      <SubjectOffersView
        page={{ kind: 'denied', status: 403, code: 'insufficient_scope' }}
        locale={locale}
        onRetry={() => {}}
      />,
    );
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(m.subject_purchase_denied({}, { locale }));
    expect(document.querySelector('ul, a, button, [role="status"]')).toBeNull();
  } finally {
    await window.happyDOM.close();
  }
});
