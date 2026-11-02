// UNRUN under MINIMAL: mounted DOM/interaction regression, not browser or native evidence.
import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import * as start from '../.storybook/react-start';
import type { Figure, Ratings, RatingSources, RatingSource } from '../src/features/pages/subject-ratings';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/de/subjects/subject' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLButtonElement: window.HTMLButtonElement,
  Element: window.Element,
  Node: window.Node,
  Document: window.Document,
  DocumentFragment: window.DocumentFragment,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);

const { createRoot } = await import('react-dom/client');
const { RatingsView, RatingsRecoveryContext } = await import('../src/features/pages/subject-ratings-view');
const { RatingDistribution } = await import('../src/features/pages/rating-distribution');
const { GLOBAL, QUESTION, suppliedRatingSources } = await import('../src/features/pages/subject-ratings');
const { m } = await import('../src/paraglide/messages.js');

afterAll(async () => {
  mock.restore();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  await window.happyDOM.close();
});

test('Mounted Subject ratings keep accessible disclosures and move revision metadata into provenance', async () => {
  const questionLabel = `How much did you like this work? Übersetzungen・翻訳・ترجمات ${'長い質問'.repeat(30)}`;
  const realms = [
    { id: 'missing', name: 'Unavailable supplied figure' },
    { id: 'zero', name: 'No ratings yet' },
    { id: 'leading', name: `Übersetzungen・翻訳・ترجمات ${'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.repeat(5)}` },
    { id: 'updating', name: 'Updating publication' },
    { id: 'threshold', name: 'Below publication threshold' },
    { id: 'no-mean', name: 'Missing supplied mean' },
    { id: 'tie', name: 'Stable equal-count comparison' },
    { id: 'remaining', name: 'Last supplied comparison' },
  ];
  const global: Figure = {
    population: GLOBAL,
    count: 1203,
    mean: 16.8,
    histogram: Array.from({ length: 21 }, (_, index) => (index === 17 ? 1203 : 0)),
  };
  const data: Ratings = {
    question: {
      id: QUESTION,
      revision: 1203,
      label: questionLabel,
      grain: 'work',
      scale: { min: 0, max: 20, displayStep: 1 },
    },
    figure: {
      questionId: QUESTION,
      populationId: GLOBAL,
      scale: { min: 0, max: 20, displayStep: 1 },
      count: 1203,
      state: 'ready',
      mean: 8.4,
      score: 7.9,
    },
    figures: [
      global,
      { population: 'zero', count: 0 },
      { population: 'leading', count: 1203, mean: 16.8 },
      { population: 'updating', count: 40, mean: 20, freshness: { asOf: null, updating: true } },
      { population: 'threshold', count: 3, mean: 20, remaining: 2 },
      { population: 'no-mean', count: 9 },
      { population: 'tie', count: 9, mean: 12 },
      { population: 'remaining', count: 1, remaining: 4 },
    ],
    realms: [{ id: GLOBAL, name: 'Duplicate Global' }, ...realms, { id: 'leading', name: 'Duplicate Realm' }],
    statistics: [
      {
        source: 'vndb',
        mean: 84,
        scale: { min: 1, max: 100 },
        count: 50,
        asOf: '2025-01-01',
        licence: 'ODbL-1.0',
        attribution: `VNDB contributors・寄稿者 ${'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.repeat(4)}`,
      },
    ],
    own: null,
  };
  const host = window.document.createElement('main') as unknown as HTMLElement;
  host.style.width = '240px';
  window.document.body.append(host);
  const root = createRoot(host);
  const english = { locale: 'en' } as const;
  const recoveries: RatingSource[] = [];
  const recover = (source: RatingSource) => recoveries.push(source);
  const subject = 'subject / 中文';
  const paint = async (value: Ratings | RatingSources | null, locale = 'en') => {
    await act(async () => {
      root.render(
        <RatingsRecoveryContext.Provider value={recover}>
          <RatingsView key={locale} data={value} id="ratings" subject={subject} locale={locale} />
        </RatingsRecoveryContext.Provider>,
      );
    });
  };
  const target = (element: HTMLElement) => {
    for (const token of [
      'min-h-11',
      'min-w-11',
      'max-w-full',
      'whitespace-normal',
      'wrap-anywhere',
      'text-start',
      'focus-visible:outline-2',
      'focus-visible:outline-offset-2',
      'focus-visible:outline-ring',
    ])
      expect(element.classList.contains(token)).toBe(true);
    expect(element.classList.contains('truncate')).toBe(false);
    expect(element.classList.contains('overflow-hidden')).toBe(false);
    expect(element.getAttribute('dir')).toBeNull();
    expect(element.getAttribute('tabindex')).not.toBe('-1');
  };
  const disclosure = (slot: string, label: string) => {
    const details = host.querySelector<HTMLDetailsElement>(`[data-slot="${slot}"]`)!;
    expect(details.tagName).toBe('DETAILS');
    expect(details.open).toBe(false);
    const summary = details.firstElementChild as HTMLElement;
    expect(summary.tagName).toBe('SUMMARY');
    expect(summary.textContent).toBe(label);
    expect(details.querySelectorAll('summary')).toHaveLength(1);
    expect(summary.getAttribute('role')).toBeNull();
    expect(summary.getAttribute('aria-expanded')).toBeNull();
    expect(summary.querySelector('button, a, input, svg, [aria-hidden="true"]')).toBeNull();
    for (const token of ['list-item', 'list-inside']) expect(summary.classList.contains(token)).toBe(true);
    for (const token of ['flex', 'grid', 'list-none']) expect(summary.classList.contains(token)).toBe(false);
    target(summary);
    return details;
  };
  const titles = (parent: Element) =>
    Array.from(parent.querySelectorAll('[data-slot="rating-comparison"] h3'), (heading) => heading.textContent);
  const fetchBefore = globalThis.fetch;
  let reads = 0;
  globalThis.fetch = (() => {
    reads++;
    throw new Error('Supplied ratings disclosures must not fetch');
  }) as typeof fetch;
  try {
    // These assert DOM anatomy inside narrow/RTL fixtures. Actual 44px bounds, wrapping,
    // marker painting, :focus-visible and native Enter/Space/Tab behavior need a browser.
    for (const locale of ['en', 'de', 'es', 'fr', 'ja', 'ko', 'zh-Hans', 'zh-Hant'] as const) {
      host.dir = locale === 'de' || locale === 'ja' ? 'rtl' : 'ltr';
      const options = { locale };
      const number = (value: number, digits = 0) =>
        new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(value);
      await paint(data, locale);
      const question = host.querySelector<HTMLElement>('[data-slot="rating-question"]')!;
      expect(question.textContent).toBe(questionLabel);
      expect(question.getAttribute('data-revision')).toBe(String(data.question.revision));
      expect(question.closest('details')).toBeNull();
      const provenance = disclosure('rating-provenance', m.subject_ratings_provenance({}, options));
      const revision = host.querySelector('[data-slot="rating-question-revision"]')!;
      expect(revision.textContent).toBe(m.rating_question_revision({ revision: number(1203) }, options));
      expect(revision.closest('details')).toBe(provenance);
      expect(host.querySelectorAll('[data-slot="rating-question-revision"]')).toHaveLength(1);
      expect(provenance.textContent).toContain(m.rating_public_delay({}, options));
      expect(provenance.textContent).toContain(m.rating_public_ordering({}, options));
      const imported = provenance.querySelector('[data-slot="imported-score"]')!;
      const date = new Intl.DateTimeFormat(locale, {
        timeZone: 'UTC',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      }).format(new Date('2025-01-01T00:00:00.000Z'));
      for (const text of [
        'VNDB',
        `${number(84, 2)} (${number(1)}–${number(100)})`,
        m.subject_ratings_imported({ count: number(50), date }, options),
        m.rating_import_licence({ licence: data.statistics[0]!.licence! }, options),
        m.rating_import_attribution({ attribution: data.statistics[0]!.attribution! }, options),
      ])
        expect(imported.textContent).toContain(text);
      // Opening existing native details exposes the same revision and rights facts.
      provenance.open = true;
      expect(revision.textContent).toBe(m.rating_question_revision({ revision: number(1203) }, options));
      provenance.open = false;
      const distribution = disclosure('rating-distribution', m.subject_ratings_distribution({}, options));
      expect(distribution.querySelectorAll('ol[aria-label] > li')).toHaveLength(21);
      expect(distribution.querySelector('ol')?.getAttribute('aria-label')).toBe(
        m.subject_ratings_distribution({}, options),
      );
      const comparisons = disclosure('rating-comparisons', m.subject_ratings_comparisons({}, options));
      expect(comparisons.closest('[dir]')).toBe(host);
      expect(titles(comparisons)).toEqual([2, 3, 5, 6, 4].map((index) => realms[index]!.name));
      expect(host.textContent).not.toContain('Duplicate Global');
      expect(host.textContent).not.toContain('Duplicate Realm');
      for (const row of comparisons.querySelectorAll('[data-slot="rating-comparison"]')) {
        expect(row.tagName).toBe('LI');
        expect(row.parentElement?.tagName).toBe('UL');
        expect(row.querySelector('[data-slot="content-item-frame"]')).not.toBeNull();
        expect(row.querySelector('h3[data-content-item-slot="title"]')).not.toBeNull();
        expect(row.querySelector('[data-content-item-slot="preview"]')).not.toBeNull();
      }
      const more = comparisons.querySelector<HTMLButtonElement>('button')!;
      target(more);
      expect(more.type).toBe('button');
      expect(more.getAttribute('aria-expanded')).toBe('false');
      expect(more.textContent).toBe(m.subject_ratings_more_comparisons({ count: number(3) }, options));
      const remaining = window.document.getElementById(more.getAttribute('aria-controls')!)!;
      expect(remaining.tagName).toBe('UL');
      expect(remaining.hidden).toBe(true);
      expect(remaining.children).toHaveLength(0);
      comparisons.open = true;
      await act(async () => more.click());
      expect(more.getAttribute('aria-expanded')).toBe('true');
      expect(more.textContent).toBe(m.subject_ratings_fewer_comparisons({}, options));
      expect(remaining.hidden).toBe(false);
      expect(titles(remaining as unknown as Element)).toEqual([0, 1, 7].map((index) => realms[index]!.name));
      expect(comparisons.querySelectorAll('[data-slot="rating-comparison"]')).toHaveLength(8);
      const preview = (name: string) =>
        Array.from(comparisons.querySelectorAll('[data-slot="rating-comparison"]'))
          .find((row) => row.querySelector('h3')?.textContent === name)!
          .querySelector('[data-content-item-slot="preview"]')!;
      expect(preview(realms[0]!.name).textContent).toContain(m.subject_ratings_figure_unavailable({}, options));
      expect(preview(realms[1]!.name).textContent).toContain(m.subject_ratings_empty({}, options));
      expect(preview(realms[3]!.name).querySelector('[role="status"]')?.textContent).toBe(
        m.rating_public_updating({}, options),
      );
      expect(preview(realms[4]!.name).textContent).toContain(
        m.subject_ratings_remaining({ count: number(2) }, options),
      );
      await act(async () => more.click());
      expect(more.getAttribute('aria-expanded')).toBe('false');
      expect(remaining.hidden).toBe(true);
      expect(remaining.children).toHaveLength(0);
      expect(titles(comparisons)).toHaveLength(5);
      const reviews = host.querySelector<HTMLAnchorElement>('[data-slot="see-reviews"]')!;
      target(reviews);
      expect(reviews.getAttribute('href')).toBe(`/${locale}/subjects/subject%20%2F%20%E4%B8%AD%E6%96%87/reviews`);
      expect(reviews.textContent).toBe(m.subject_ratings_reviews({}, options));
      expect(reviews.closest('details')).toBeNull();
      expect(reads).toBe(0);
    }

    // The existing question-revision key still resets local comparison reveal state.
    await paint(data);
    const more = host.querySelector<HTMLButtonElement>('[data-slot="rating-comparisons"] button')!;
    await act(async () => more.click());
    await paint({ ...data, question: { ...data.question, revision: 1204 } });
    expect(host.querySelector('[data-slot="rating-question"]')?.getAttribute('data-revision')).toBe('1204');
    expect(host.querySelector('[data-slot="rating-question-revision"]')?.textContent).toBe('Revision 1,204');
    expect(host.querySelector('[data-slot="rating-comparisons"] button')?.getAttribute('aria-expanded')).toBe('false');
    expect(host.querySelectorAll('[data-slot="rating-comparison"]')).toHaveLength(5);

    const sources = suppliedRatingSources(data);
    for (const [kind, text] of [
      ['idle', m.rating_population_loading({}, english)],
      ['absent', m.rating_population_absent({}, english)],
      ['unavailable', m.rating_population_unavailable({}, english)],
      ['terminal', m.rating_population_terminal({}, english)],
      ['failed', m.rating_population_failed({}, english)],
    ] as const) {
      await paint({ ...sources, question: { kind } });
      expect(host.querySelector('[data-slot="rating-question"]')).toBeNull();
      expect(host.querySelector('[data-slot="rating-question-revision"]')).toBeNull();
      expect(host.textContent).not.toContain('Revision');
      expect(host.querySelector('[data-source="question"] [role="status"]')?.textContent).toBe(text);
      expect(host.querySelector('[data-slot="rating-distribution"]')).toBeNull();
      expect(host.querySelector('[data-slot="imported-score"]')?.textContent).toContain('VNDB contributors');
      const retry = host.querySelector<HTMLButtonElement>('[data-source="question"] button');
      expect(retry !== null).toBe(kind !== 'idle' && kind !== 'terminal');
      if (retry) {
        target(retry);
        await act(async () => retry.click());
        expect(recoveries.at(-1)).toBe('question');
      }
    }
    await paint({ ...sources, statistics: { kind: 'failed' } });
    const failedSource = host.querySelector('[data-source="statistics"]')!;
    expect(failedSource.closest('details')?.getAttribute('data-slot')).toBe('rating-provenance');
    await act(async () => failedSource.querySelector<HTMLButtonElement>('button')!.click());
    expect(recoveries.at(-1)).toBe('statistics');
    expect(host.querySelector('[data-slot="rating-distribution"]')).not.toBeNull();

    for (const [grain, count] of [
      ['work', 4],
      ['episode', 9],
      ['character', 9],
    ] as const) {
      await paint({
        ...sources,
        question: { kind: 'ready', value: { ...data.question, grain } },
        figure: { kind: 'ready', value: { ...data.figure, count, state: 'insufficient_data', mean: null } },
        global: { kind: 'ready', value: { ...global, count, remaining: 1 } },
      });
      expect(host.querySelector('[data-slot="rating-distribution"]')).toBeNull();
      expect(host.querySelector('[data-slot="rating-figures"]')?.textContent).toContain(
        m.subject_ratings_remaining({ count: '1' }, english),
      );
    }
    await paint({ ...sources, figure: { kind: 'ready', value: { ...data.figure, state: 'updating', mean: null } } });
    expect(host.querySelector('[data-slot="rating-distribution"]')).toBeNull();
    expect(host.querySelector('[data-slot="rating-figures"]')?.textContent).toContain(
      m.rating_public_updating({}, english),
    );
    await paint({ ...sources, global: { kind: 'unavailable' } });
    expect(host.querySelector('[data-slot="rating-distribution"]')).toBeNull();
    expect(host.querySelector('[data-source="global"] [role="status"]')?.textContent).toBe(
      m.rating_population_unavailable({}, english),
    );
    await paint({ ...sources, figure: { kind: 'failed' } });
    expect(host.querySelector('[data-slot="rating-distribution"]')).not.toBeNull();
    await paint({
      ...sources,
      figure: { kind: 'ready', value: { ...data.figure, count: 0, state: 'insufficient_data', mean: null } },
      global: { kind: 'ready', value: { population: GLOBAL, count: 0 } },
    });
    expect(host.querySelector('[data-slot="rating-distribution"]')).toBeNull();
    expect(host.querySelector('[data-slot="rating-figures"]')?.textContent).toContain(
      m.subject_ratings_empty({}, english),
    );

    await paint(null, 'de');
    const retry = host.querySelector<HTMLAnchorElement>('[data-slot="retry"]')!;
    const reviews = host.querySelector<HTMLAnchorElement>('[data-slot="see-reviews"]')!;
    expect(host.querySelector('[data-state="failed"] [role="status"]')?.textContent).toBe(
      m.subject_section_failed({}, { locale: 'de' }),
    );
    expect(retry.getAttribute('href')).toBe('/de/subjects/subject%20%2F%20%E4%B8%AD%E6%96%87');
    expect(reviews.getAttribute('href')).toBe('/de/subjects/subject%20%2F%20%E4%B8%AD%E6%96%87/reviews');
    expect(host.querySelectorAll('a')).toHaveLength(2);
    for (const action of [retry, reviews]) {
      target(action);
      action.focus();
      expect(window.document.activeElement).toBe(action);
      expect(action.closest('a')?.querySelector('button, a')).toBeNull();
    }

    // Mount the actual distribution independently too; never substitute a copied predicate.
    for (const figure of [
      undefined,
      { ...global, remaining: 1 },
      { ...global, freshness: { asOf: null, updating: true } },
    ]) {
      await act(async () =>
        root.render(<RatingDistribution figure={figure} headline={data.figure} question={data.question} locale="en" />),
      );
      expect(host.children).toHaveLength(0);
    }
    await act(async () =>
      root.render(
        <RatingDistribution
          figure={{ ...global, histogram: global.histogram!.map(() => 0) }}
          headline={data.figure}
          question={data.question}
          locale="en"
        />,
      ),
    );
    const distribution = disclosure('rating-distribution', m.subject_ratings_distribution({}, english));
    expect(distribution.querySelectorAll('ol > li')).toHaveLength(21);
    for (const bar of distribution.querySelectorAll<HTMLElement>('[aria-hidden="true"] > span'))
      expect(bar.style.width).toBe('0%');
    expect(reads).toBe(0);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    globalThis.fetch = fetchBefore;
  }
});
