// UNRUN under MINIMAL: mounted presentation regression; native/browser verification follows integration.
import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import * as start from '../.storybook/react-start';
import type { Figure, Ratings } from '../src/features/pages/subject-ratings';
import type { PopulationItem } from '../src/features/pages/subject-rating-populations';
import type { PopulationTransport } from '../src/features/pages/subject-rating-populations-view';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/de/subjects/subject' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLInputElement: window.HTMLInputElement,
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
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { RatingsView, RatingPopulationsContext } = await import('../src/features/pages/subject-ratings-view');
const { SubjectRatingPopulations } = await import('../src/features/pages/subject-rating-populations-view');
const { GLOBAL, QUESTION } = await import('../src/features/pages/subject-ratings');
const { m } = await import('../src/paraglide/messages.js');

afterAll(async () => {
  mock.restore();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  await window.happyDOM.close();
});

test('supplied and selected Realm summaries share semantic headings, useful figures and independent removal without presentation reads', async () => {
  const locale = 'de';
  const options = { locale } as const;
  const number = (value: number) => new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value);
  const realms = [
    { id: 'missing', name: 'Readers awaiting a supplied figure' },
    { id: 'zero', name: 'Readers without ratings yet' },
    {
      id: 'mean',
      name: `Readers comparing translations across languages and editions ${'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.repeat(4)}`,
    },
    { id: 'updating', name: 'Night Shift Translators' },
    { id: 'threshold', name: 'The Quiet Novel Club' },
    { id: 'missing-mean', name: 'Small Press Discussion' },
    { id: 'tie', name: 'Archive Readers' },
    { id: 'remaining', name: 'Weekend Readers' },
  ];
  const asOf = '2026-11-01T12:30:00.000Z';
  const figures: Figure[] = [
    { population: GLOBAL, count: 500, mean: 16 },
    { population: 'zero', count: 0 },
    { population: 'mean', count: 1203, mean: 16.8, freshness: { asOf, updating: false } },
    { population: 'updating', count: 40, mean: 20, freshness: { asOf, updating: true } },
    { population: 'threshold', count: 3, mean: 20, remaining: 2 },
    { population: 'missing-mean', count: 9 },
    { population: 'tie', count: 9, mean: 12 },
    { population: 'remaining', count: 1, remaining: 4 },
  ];
  const data: Ratings = {
    question: {
      id: QUESTION,
      revision: 7,
      label: 'How much did you like this work?',
      grain: 'work',
      scale: { min: 0, max: 20, displayStep: 1 },
    },
    figure: {
      questionId: QUESTION,
      populationId: GLOBAL,
      scale: { min: 0, max: 20, displayStep: 1 },
      count: 500,
      state: 'ready',
      mean: 8,
      score: 7.9,
    },
    figures,
    realms: [
      { id: GLOBAL, name: 'Duplicate Global must be omitted' },
      ...realms,
      { id: 'mean', name: 'Duplicate Realm must be omitted' },
    ],
    statistics: [
      {
        source: 'Example',
        scale: { min: 1, max: 100 },
        mean: 84,
        count: 50,
        asOf: '2025-01-01',
        licence: 'ODbL-1.0',
        attribution: 'Example contributors',
      },
    ],
    own: null,
  };
  const requests: Parameters<PopulationTransport>[0][] = [];
  const session = { state: 'signed-in' as const, subject: 'summary-reader', csrfToken: null };
  const read: PopulationTransport = async (input) => {
    requests.push({ ...input, ...(input.selected ? { selected: [...input.selected] } : {}) });
    const items: PopulationItem[] = (
      input.selected ? realms.filter((realm) => input.selected!.includes(realm.id)) : realms
    ).map((realm) => {
      const figure = figures.find((figure) => figure.population === realm.id);
      return {
        ...realm,
        figure: !input.selected
          ? { kind: 'idle' }
          : figure
            ? { kind: 'ready', value: figure }
            : { kind: 'unavailable' },
      };
    });
    return {
      reader: session.subject,
      subject: input.id,
      question: input.question,
      result: { kind: 'ready', value: { items, incomplete: false, next: null } },
    };
  };
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  cache.setQueryData(['session'], session);
  const host = window.document.createElement('main') as unknown as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const fetchBefore = globalThis.fetch;
  let unexpectedReads = 0;
  globalThis.fetch = (() => {
    unexpectedReads++;
    throw new Error('Summary presentation must not fetch');
  }) as typeof fetch;
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  const until = async (predicate: () => boolean) => {
    for (let attempt = 0; attempt < 40 && !predicate(); attempt++) await act(tick);
    expect(predicate()).toBe(true);
  };
  const rows = (parent: Element) => Array.from(parent.querySelectorAll<HTMLElement>('[data-slot="rating-comparison"]'));
  const titles = (parent: Element) =>
    rows(parent).map((row) => row.querySelector('[data-content-item-slot="title"]')!.textContent);
  const summaryRow = (parent: Element, name: string, level: 3 | 4) => {
    const row = rows(parent).find((row) => row.querySelector(`h${level}`)?.textContent === name)!;
    expect(row).toBeDefined();
    expect(row.tagName).toBe('LI');
    expect(row.parentElement?.tagName).toBe('UL');
    expect(row.querySelectorAll('li')).toHaveLength(0);
    expect(row.querySelector('[data-slot="content-item-frame"]')).not.toBeNull();
    const heading = row.querySelector(`h${level}[data-content-item-slot="title"]`)!;
    expect(heading.textContent).toBe(name);
    expect(heading.getAttribute('aria-hidden')).toBeNull();
    expect(row.querySelector('a, .sr-only')).toBeNull();
    expect(row.querySelector('[data-content-item-slot="preview"]')).not.toBeNull();
    return row;
  };
  try {
    await act(async () => {
      root.render(
        <QueryClientProvider client={cache}>
          <RatingPopulationsContext.Provider
            value={
              <SubjectRatingPopulations
                subjectId="subject"
                question={data.question}
                locale={locale}
                session={session}
                read={read}
              />
            }
          >
            <RatingsView data={data} id="ratings" subject="subject" locale={locale} />
          </RatingPopulationsContext.Provider>
        </QueryClientProvider>,
      );
    });
    await until(() => host.querySelectorAll('input[type="checkbox"]').length === realms.length);
    expect(requests).toEqual([{ id: 'subject', question: QUESTION, locale, expectedReader: session.subject }]);
    const disclosure = host.querySelector<HTMLDetailsElement>('[data-slot="rating-comparisons"]')!;
    expect(disclosure.open).toBe(false);
    expect(disclosure.querySelector('summary')?.textContent).toBe(m.subject_ratings_comparisons({}, options));
    expect(titles(disclosure)).toEqual([
      realms[2]!.name,
      realms[3]!.name,
      realms[5]!.name,
      realms[6]!.name,
      realms[4]!.name,
    ]);
    expect(host.textContent).not.toContain('Duplicate Global');
    expect(host.textContent).not.toContain('Duplicate Realm');
    const mean = m.rating_public_mean({ mean: number(8.4), maximum: number(10) }, options);
    const count = m.subject_ratings_realm_count({ count: number(1203), population: realms[2]!.name }, options);
    const remaining = m.subject_ratings_remaining({ count: number(2) }, options);
    const suppliedMean = summaryRow(disclosure, realms[2]!.name, 3);
    expect(suppliedMean.textContent).toContain(mean);
    expect(suppliedMean.textContent).toContain(count);
    const updating = summaryRow(disclosure, realms[3]!.name, 3);
    expect(updating.querySelector('[role="status"]')?.textContent).toBe(m.rating_public_updating({}, options));
    expect(updating.textContent).not.toContain(
      m.rating_public_mean({ mean: number(10), maximum: number(10) }, options),
    );
    expect(summaryRow(disclosure, realms[4]!.name, 3).textContent).toContain(remaining);
    expect(summaryRow(disclosure, realms[5]!.name, 3).textContent).toContain(
      m.subject_ratings_figure_unavailable({}, options),
    );
    const more = disclosure.querySelector<HTMLButtonElement>('button')!;
    expect(more.textContent).toBe(m.subject_ratings_more_comparisons({ count: number(3) }, options));
    expect(more.getAttribute('aria-expanded')).toBe('false');
    const remainder = host.querySelector<HTMLElement>(`#${more.getAttribute('aria-controls')}`)!;
    expect(remainder.hidden).toBe(true);
    expect(remainder.children).toHaveLength(0);
    const beforeReveal = requests.length;
    await act(async () => {
      disclosure.open = true;
      more.click();
    });
    expect(more.getAttribute('aria-expanded')).toBe('true');
    expect(more.textContent).toBe(m.subject_ratings_fewer_comparisons({}, options));
    expect(remainder.hidden).toBe(false);
    expect(titles(remainder)).toEqual([realms[0]!.name, realms[1]!.name, realms[7]!.name]);
    expect(summaryRow(remainder, realms[0]!.name, 3).textContent).toContain(
      m.subject_ratings_figure_unavailable({}, options),
    );
    expect(summaryRow(remainder, realms[1]!.name, 3).textContent).toContain(m.subject_ratings_empty({}, options));
    expect(rows(disclosure)).toHaveLength(8);
    await act(async () => more.click());
    expect(remainder.hidden).toBe(true);
    expect(remainder.children).toHaveLength(0);
    expect(rows(disclosure)).toHaveLength(5);
    expect(requests).toHaveLength(beforeReveal);

    const selected = () => host.querySelector<HTMLElement>('[data-slot="rating-selected"]')!;
    const boxes = Array.from(host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
    for (const index of [2, 0, 1, 4, 3]) {
      await act(async () => boxes[index]!.click());
      await until(
        () =>
          selected()?.getAttribute('aria-busy') === 'false' &&
          rows(selected()).length === boxes.filter((box) => box.checked).length,
      );
    }
    expect(selected().querySelector('h3')?.textContent).toBe(m.subject_ratings_comparisons({}, options));
    const selectedMean = summaryRow(selected(), realms[2]!.name, 4);
    expect(selectedMean.textContent).toContain(mean);
    expect(selectedMean.textContent).toContain(count);
    expect(selectedMean.textContent).toContain(
      m.rating_population_as_of(
        { date: new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(asOf)) },
        options,
      ),
    );
    const unavailable = summaryRow(selected(), realms[0]!.name, 4);
    expect(unavailable.querySelector('[data-source="comparison"]')?.getAttribute('data-state')).toBe('unavailable');
    expect(unavailable.textContent).toContain(m.rating_population_unavailable({}, options));
    expect(unavailable.textContent).not.toContain(m.subject_ratings_empty({}, options));
    expect(summaryRow(selected(), realms[1]!.name, 4).textContent).toContain(m.subject_ratings_empty({}, options));
    expect(summaryRow(selected(), realms[4]!.name, 4).textContent).toContain(remaining);
    expect(summaryRow(selected(), realms[3]!.name, 4).textContent).toContain(m.rating_public_updating({}, options));
    const remove = selectedMean.querySelector<HTMLButtonElement>('[data-content-item-slot="actions"] button')!;
    expect(selectedMean.querySelectorAll('button')).toHaveLength(1);
    expect(remove.type).toBe('button');
    expect(remove.textContent).toBe(m.rating_population_remove({ name: realms[2]!.name }, options));
    expect(remove.closest('a')).toBeNull();
    for (const token of ['min-h-11', 'min-w-11', 'focus-visible:outline-2'])
      expect(remove.classList.contains(token)).toBe(true);
    const beforeRemove = requests.length;
    await act(async () => {
      remove.focus();
      remove.click();
    });
    const legend = host.querySelector('legend')!;
    expect(window.document.activeElement).toBe(legend);
    await until(() => rows(selected()).length === 4 && selected().getAttribute('aria-busy') === 'false');
    expect(window.document.activeElement).toBe(legend);
    expect(boxes[2]!.checked).toBe(false);
    expect(titles(selected())).not.toContain(realms[2]!.name);
    expect(requests.slice(beforeRemove)).toEqual([
      {
        id: 'subject',
        question: QUESTION,
        locale,
        expectedReader: session.subject,
        selected: ['missing', 'zero', 'threshold', 'updating'],
      },
    ]);
    expect(requests.filter((input) => input.selected === undefined)).toHaveLength(1);
    expect(rows(disclosure)).toHaveLength(5);
    expect(host.querySelector('[data-slot="rating-question"]')?.getAttribute('data-revision')).toBe('7');
    const provenance = host.querySelector<HTMLDetailsElement>('[data-slot="rating-provenance"]')!;
    expect(provenance.open).toBe(false);
    for (const text of ['Example', '84', '100', '50', '2025', 'ODbL-1.0', 'Example contributors'])
      expect(provenance.textContent).toContain(text);
    expect(unexpectedReads).toBe(0);
  } finally {
    await act(async () => root.unmount());
    cache.clear();
    host.remove();
    globalThis.fetch = fetchBefore;
  }
});
