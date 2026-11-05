import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SubjectOffer, SubjectOffersData } from '../src/checkout/subject-offers';
import { subjectOfferFixture as supplied } from '../src/kernel/fake/subject-offers';
import { m } from '../src/paraglide/messages.js';
import { getLocale, locales, setLocale } from '../src/paraglide/runtime.js';

mock.module('@tanstack/react-start', () => import('../.storybook/react-start'));
mock.module('@tanstack/react-start/server', () => import('../.storybook/react-start'));
mock.module('cloudflare:workers', () => ({ env: {} }));
const { SubjectOffersView } = await import('../src/checkout/subject-offers-region');
const { createRoot } = await import('react-dom/client');
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);

async function rendered(
  run: (ui: {
    window: InstanceType<typeof Window>;
    host: ReturnType<InstanceType<typeof Window>['document']['createElement']>;
    render: (page: SubjectOffersData, locale?: string, version?: number) => Promise<void>;
    click: (node: { click(): void } | null | undefined) => Promise<void>;
  }) => Promise<void>,
) {
  const window = new Window({ url: 'https://site.test/fr/subjects/example' });
  const globals = {
    window,
    document: window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    ShadowRoot: window.ShadowRoot,
    Document: window.Document,
    DocumentFragment: window.DocumentFragment,
    HTMLButtonElement: window.HTMLButtonElement,
    HTMLInputElement: window.HTMLInputElement,
    getComputedStyle: window.getComputedStyle.bind(window),
    navigator: window.navigator,
  };
  const previous = Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  try {
    await run({
      window,
      host,
      render: async (page, locale = 'fr', version = 0) => {
        await act(async () => root.render(<SubjectOffersView page={page} locale={locale} pageVersion={version} />));
      },
      click: async (node) => {
        expect(node).toBeDefined();
        expect(node).not.toBeNull();
        await act(async () => node!.click());
      },
    });
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await window.happyDOM.close();
  }
}
const ready = (offers: SubjectOffer[]): SubjectOffersData => ({
  kind: 'ready',
  offers,
  next: null,
  projectionState: 'ready',
});

test('choice: exact received identities survive equal titles and shared Editions through inspect compare edit and canonical review', async () => {
  await retainedSummaryContract();
  const locale = 'fr';
  const originalLocale = getLocale();
  const first = {
    ...supplied,
    id: 'captured /+?=#版%',
    title: 'Captured <title> & commentary / '.repeat(12),
    revision: 7,
  };
  const second = { ...first, id: 'second-offer', revision: 11, unitAmountMinor: 1299 };
  const third: SubjectOffer = {
    ...first,
    id: 'third-offer',
    contentEdition: {
      ...first.contentEdition!,
      benefit: {
        ...first.contentEdition!.benefit,
        resource: { ...first.contentEdition!.benefit.resource, id: '0192f3a0-6c1e-7b2a-9d4e-000000000099' },
        version: { revisionId: '0192f3a0-6c1e-7b2a-9d4e-000000000098', sha256: 'b'.repeat(64) },
      },
      source: { licence: 'A separately supplied licence / '.repeat(6) },
    },
  };
  const page = ready([first, second, third]);
  try {
    setLocale('en', { reload: false });
    await rendered(async ({ window, host, render, click }) => {
      await render(page);
      const rows = [...host.querySelectorAll('ul[aria-label] > li')];
      expect(rows).toHaveLength(3);
      for (const [index, offer] of [first, second, third].entries()) {
        const row = rows[index]!;
        const heading = row.querySelector('h3')!;
        const links = row.querySelectorAll('a');
        expect(row.getAttribute('data-slot')).toBe('list-row');
        expect(heading.getAttribute('data-content-item-slot')).toBe('title');
        expect(heading.textContent).toBe(offer.title);
        expect(heading.classList.contains('line-clamp-2')).toBe(true);
        expect(links).toHaveLength(1);
        expect(links[0]!.getAttribute('href')).toBe(`/fr/offers/${encodeURIComponent(offer.id)}`);
        expect(links[0]!.getAttribute('aria-label')).toBe(
          m.subject_purchase_review_offer({ title: offer.title }, { locale }),
        );
        expect(row.querySelector('li, img, a a, a button, a summary, a form')).toBeNull();
        expect(row.querySelector('[data-content-item-slot="state"]')?.textContent).toBe(
          m.subject_choice_supplied({}, { locale }),
        );
        expect(row.textContent).toContain(m.subject_choice_revision({ revision: offer.revision }, { locale }));
        expect(row.textContent).toContain(m.benefit_acquisition({}, { locale }));
      }
      expect(rows[0]!.querySelector('[data-offer-capture-label]')?.textContent).toBe(
        rows[1]!.querySelector('[data-offer-capture-label]')?.textContent,
      );
      expect(rows[2]!.querySelector('[data-offer-capture-label]')?.textContent).not.toBe(
        rows[0]!.querySelector('[data-offer-capture-label]')?.textContent,
      );
      const inspect = rows[1]!.querySelector('button')!;
      await click(inspect);
      const inspection = host.querySelector('[data-offer-inspection]')!;
      expect(window.document.activeElement).toBe(inspection.querySelector('h2'));
      expect(inspection.textContent).toContain(second.id);
      expect(inspection.textContent).toContain(m.subject_choice_revision({ revision: 11 }, { locale }));
      const close = [...inspection.querySelectorAll('button')].find(
        (node) => node.textContent === m.subject_choice_close({}, { locale }),
      );
      await click(close);
      expect(window.document.activeElement).toBe(inspect);
      const toggles = rows.map((row) => row.querySelectorAll('button')[1]!);
      await click(toggles[1]);
      await click(toggles[0]);
      expect(toggles[2]!.disabled).toBe(true);
      const compare = [...host.querySelectorAll('button')].find(
        (node) => node.textContent === m.subject_choice_compare({}, { locale }),
      )!;
      await click(compare);
      const comparison = host.querySelector('[data-offer-comparison]')!;
      const operands = [...comparison.querySelectorAll('[data-offer-comparison-operand]')];
      expect(operands).toHaveLength(2);
      for (const [index, offer] of [second, first].entries()) {
        const operand = operands[index]!;
        expect(operand.textContent).toContain(offer.id);
        expect(operand.textContent).toContain(String(offer.revision));
        expect(operand.textContent).toContain(offer.contentEdition!.benefit.version.revisionId);
        expect(operand.textContent).toContain(offer.contentEdition!.benefit.version.sha256);
        expect(operand.textContent).toContain(offer.contentEdition!.source.licence);
        expect(operand.querySelector('a')?.getAttribute('href')).toBe(`/fr/offers/${encodeURIComponent(offer.id)}`);
      }
      expect(operands[0]!.querySelector('[data-offer-recorded-price]')?.textContent).toBe('12,99 $US');
      expect(comparison.textContent).toContain(m.subject_choice_same_edition({}, { locale }));
      await click(
        [...comparison.querySelectorAll('button')].find(
          (node) => node.textContent === m.subject_choice_edit({}, { locale }),
        ),
      );
      expect(window.document.activeElement).toBe(compare);
      expect(toggles[0]!.getAttribute('aria-pressed')).toBe('true');
      await click(toggles[0]);
      await click(toggles[2]);
      await click(compare);
      expect(host.querySelector('[data-offer-comparison]')?.textContent).toContain(
        m.subject_choice_different_editions({}, { locale }),
      );
      const navigations: string[] = [];
      host.addEventListener('click', (event) => {
        const target = event.target as unknown as HTMLElement;
        const link = target.closest('a');
        if (link) {
          event.preventDefault();
          navigations.push(link.getAttribute('href')!);
        }
      });
      await click(host.querySelector('[data-offer-comparison-operand="2"] a'));
      expect(navigations).toEqual([`/fr/offers/${encodeURIComponent(third.id)}`]);
      await click(
        [...host.querySelectorAll('[data-offer-comparison] button')].find(
          (node) => node.textContent === m.subject_choice_clear({}, { locale }),
        ),
      );
      expect(
        host.querySelector(
          '[data-offer-comparison], [data-offer-inspection], button[aria-pressed="true"], a[href*="/editions/"], form',
        ),
      ).toBeNull();
      expect(window.document.activeElement).toBe(compare);
    });
  } finally {
    setLocale(originalLocale, { reload: false });
  }
});

test('disclosure: fixed captures unknown mapping money units missing labels and nonpositive states never imply access or payable totals', async () => {
  await retainedRecoveryContract();
  const unknown = {
    ...supplied,
    id: 'historical',
    title: 'Historical seller title',
    moneyUnit: null,
    taxBehavior: null,
    contentEdition: null,
  };
  const invalid: SubjectOffer = {
    ...supplied,
    id: 'mismatched',
    currency: 'jpy',
    unitAmountMinor: 1299,
    moneyUnit: { system: 'stripe-api', exponent: 0, factsVersion: 'stripe-money-v1' },
    taxBehavior: 'inclusive',
    contentEdition: { ...supplied.contentEdition!, targetSubjectId: '0192f3a0-6c1e-7b2a-9d4e-000000000099' },
  };
  for (const locale of locales) {
    const markup = renderToStaticMarkup(
      <SubjectOffersView page={ready([supplied, unknown, invalid])} locale={locale} />,
    );
    expect(markup).toContain(m.subject_choice_no_access({}, { locale }));
    expect(markup).toContain(m.subject_choice_capture_unknown({}, { locale }));
    expect(markup).toContain(m.subject_purchase_price_unknown({}, { locale }));
    expect(markup).not.toContain('subject_choice_');
  }
  await rendered(async ({ window, host, render, click }) => {
    await render(ready([supplied, unknown, invalid]));
    let rows = [...host.querySelectorAll('ul[aria-label] > li')];
    await click(rows[0]!.querySelector('button'));
    let inspection = host.querySelector('[data-offer-inspection]')!;
    const hash = [...inspection.querySelectorAll('code')].find(
      (node) => node.textContent === supplied.contentEdition!.benefit.version.sha256,
    )!;
    expect(hash.closest('details')!.open).toBe(false);
    expect(inspection.textContent).toContain(m.creator_inspect_hash_meaning({}, { locale: 'fr' }));
    expect(inspection.textContent).toContain(m.subject_choice_before_tax_meaning({}, { locale: 'fr' }));
    await click(
      [...inspection.querySelectorAll('button')].find(
        (node) => node.textContent === m.subject_choice_jump_references({}, { locale: 'fr' }),
      ),
    );
    expect(hash.closest('details')!.open).toBe(true);
    await click(rows[1]!.querySelector('button'));
    inspection = host.querySelector('[data-offer-inspection]')!;
    expect(inspection.textContent).toContain(m.subject_choice_unknown_meaning({}, { locale: 'fr' }));
    expect(inspection.textContent).toContain(m.subject_choice_money_unknown({}, { locale: 'fr' }));
    expect(inspection.textContent).toContain(m.creator_inspect_unknown_quantity({}, { locale: 'fr' }));
    expect(inspection.querySelector('a[href*="/editions/"], form')).toBeNull();
    expect(inspection.textContent).not.toContain(supplied.contentEdition!.source.licence);
    await click(rows[2]!.querySelector('button'));
    inspection = host.querySelector('[data-offer-inspection]')!;
    expect(inspection.querySelector('[data-offer-recorded-price]')?.textContent).toContain('1 299');
    expect(inspection.textContent).toContain(m.subject_choice_tax_unknown_meaning({}, { locale: 'fr' }));
    expect(inspection.textContent).not.toContain(m.benefit_acquisition({}, { locale: 'fr' }));
    await click(rows[0]!.querySelector('button[aria-pressed]'));
    await click(rows[1]!.querySelector('button[aria-pressed]'));
    await click(
      [...host.querySelectorAll('button')].find(
        (node) => node.textContent === m.subject_choice_compare({}, { locale: 'fr' }),
      ),
    );
    expect(host.querySelector('[data-offer-comparison]')?.textContent).toContain(
      m.subject_choice_unknown_difference({}, { locale: 'fr' }),
    );
    for (const page of [
      { kind: 'pending' },
      { kind: 'preparing' },
      { kind: 'denied', status: 403, code: null },
      { kind: 'unavailable' },
      { kind: 'cursor-error' },
      ready([]),
    ] as const) {
      // Existing outer discovery recovery remains owned by its composition; no choice UI is admitted here.
      const html = renderToStaticMarkup(<SubjectOffersView page={page} locale="fr" />);
      expect(html).not.toContain('data-subject-offer-choice');
      expect(html).not.toContain('data-offer-comparison');
    }
  });
});

async function retainedSummaryContract() {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/fr/subjects/example' });
  const document = window.document;
  const previousLocale = getLocale();
  const locale = 'fr';
  // Supplied presentation inputs exercise encoding and historical absence, not native offer admission.
  const zero: SubjectOffer = {
    ...supplied,
    id: 'captured /+?=#版%',
    title: 'Captured <title> & commentary / '.repeat(12),
    currency: 'usd',
    unitAmountMinor: 0,
    moneyUnit: { system: 'stripe-api', exponent: 2, factsVersion: 'stripe-money-v1' },
    taxBehavior: 'exclusive',
    contentEdition: {
      ...supplied.contentEdition!,
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
      expect(links[0]!.textContent).toBe(offer.title);
      expect(links[0]!.getAttribute('href')).toBe(`/fr/offers/${encodeURIComponent(offer.id)}`);
      expect(links[0]!.getAttribute('aria-label')).toBe(
        m.subject_purchase_review_offer({ title: offer.title }, { locale }),
      );
      expect(links[0]!.getAttribute('aria-label')).toContain(heading.textContent);
      expect(links[0]!.hasAttribute('role') || links[0]!.hasAttribute('tabindex')).toBe(false);
      expect(row.querySelector('li, img, a a, a button, a summary, a form')).toBeNull();
      expect(row.querySelector('[data-content-item-slot="state"]')?.textContent).toBe(
        m.subject_choice_supplied({}, { locale }),
      );
      expect(row.querySelector('[data-content-item-slot="preview"]')?.textContent).toBe(
        m.subject_purchase_review({}, { locale }),
      );
    }
    const facts = rows.map((row) =>
      [...row.querySelectorAll('[data-content-item-slot="metadata"] p')]
        .filter((_, index) => index !== 1 && index !== 2)
        .map((p) => p.textContent),
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
    expect(document.querySelector('a[href*="/editions/"], form')).toBeNull();
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
}

async function retainedRecoveryContract() {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/fr/subjects/example' });
  const document = window.document;
  const locale = 'fr';
  try {
    document.body.innerHTML = renderToStaticMarkup(
      <SubjectOffersView page={{ kind: 'pending' }} locale={locale} onRetry={() => {}} />,
    );
    expect(document.querySelector('[role="status"]')?.textContent).toBe(m.subject_purchase_pending({}, { locale }));
    expect(document.querySelector('h2')).toBeNull();
    expect(document.querySelector('ul, a, [role="alert"]')).toBeNull();
    expect(document.querySelector('button')?.textContent).toBe(m.subject_purchase_retry({}, { locale }));

    document.body.innerHTML = renderToStaticMarkup(
      <SubjectOffersView page={{ kind: 'preparing' }} locale={locale} onRetry={() => {}} />,
    );
    expect(document.querySelector('[role="status"]')?.textContent).toBe(m.subject_purchase_preparing({}, { locale }));
    expect(document.querySelector('h2')).toBeNull();
    expect(document.querySelector('button')?.textContent).toBe(m.subject_purchase_retry({}, { locale }));
    expect(document.querySelector('ul, a, [role="alert"]')).toBeNull();

    document.body.innerHTML = renderToStaticMarkup(
      <SubjectOffersView
        page={{ kind: 'ready', offers: [supplied], projectionState: 'preparing', next: 'exact/+?=#cursor' }}
        locale={locale}
        onNext={() => {}}
        onRetry={() => {}}
        onRestart={() => {}}
      />,
    );
    expect(document.querySelector('[role="status"]')?.textContent).toBe(m.subject_purchase_preparing({}, { locale }));
    expect(document.querySelector('h2')).toBeNull();
    expect(document.querySelectorAll('ul > li')).toHaveLength(0);
    expect(
      [...document.querySelectorAll('button')]
        .filter((button) => !button.closest('[data-subject-offer-choice]'))
        .map((button) => button.textContent),
    ).toEqual([
      m.subject_purchase_restart({}, { locale }),
      m.subject_purchase_retry({}, { locale }),
    ]);

    document.body.innerHTML = renderToStaticMarkup(
      <SubjectOffersView
        page={{ kind: 'ready', offers: [], projectionState: 'preparing', next: null }}
        locale={locale}
      />,
    );
    expect(document.querySelector('[role="status"]')?.textContent).toBe(m.subject_purchase_preparing({}, { locale }));
    expect(document.querySelector('h2')).toBeNull();
    expect(document.body.textContent).not.toContain(m.subject_purchase_empty({}, { locale }));

    document.body.innerHTML = renderToStaticMarkup(
      <SubjectOffersView
        page={{ kind: 'denied', status: 403, code: 'insufficient_scope' }}
        locale={locale}
        onRetry={() => {}}
      />,
    );
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(m.subject_purchase_denied({}, { locale }));
    expect(document.querySelector('h2')).toBeNull();
    expect(document.querySelector('ul, a, button, [role="status"]')).toBeNull();

    document.body.innerHTML = renderToStaticMarkup(
      <SubjectOffersView page={{ kind: 'unavailable' }} locale={locale} onRetry={() => {}} />,
    );
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(m.subject_purchase_unavailable({}, { locale }));
    expect(document.querySelector('h2')).toBeNull();
    expect(document.querySelector('button')?.textContent).toBe(m.subject_purchase_retry({}, { locale }));
  } finally {
    await window.happyDOM.close();
  }
}
