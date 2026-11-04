import { expect, mock, test } from 'bun:test';
import { act, createElement as h } from 'react';
import { dirname } from 'node:path';
import type { Subject } from '../src/subject/types';
import type { OverviewValue } from '../src/features/pages/overview';
import type { ProfileRelationWindow } from '../src/features/pages/views';
import { workFranchiseGroups } from '../src/features/pages/showcase-work/model';
import { workFranchiseReturn } from '../src/features/catalogue/work-franchise-reading/navigation';
import { subjectVisitReturn } from '../src/features/pages/subject-visit-navigation';

mock.module('cloudflare:workers', () => ({ env: {} }));
const { WorkFranchiseOverview } = await import('../src/features/pages/showcase-work/overview');
const { OverviewContext } = await import('../src/features/pages/overview');
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const property = 'wdt:P155';
const definitions = Object.fromEntries(
  [property, 'wdt:P156', 'wdt:P144'].map((p) => [
    p,
    { label: `Inverse ${p}`, forwardLabel: `Forward ${p}`, group: 'order' as const, symmetric: false },
  ]),
);
const original = (n: number, inverse = false, spoiler = false) => ({
  id: id(n),
  rank: 'normal',
  property: { id: property, data_type: 'wikibase-item' },
  value: { type: 'value', content: id(inverse ? 1 : 2) },
  qualifiers: [
    { property: { id: 'schema:position', data_type: 'string' }, value: { type: 'value', content: 'Side story' } },
    {
      property: { id: 'schema:datePublished', data_type: 'time' },
      value: {
        type: 'value',
        content: { time: '+2001-00-00T', precision: 9, calendarmodel: 'http://www.wikidata.org/entity/Q1985727' },
      },
    },
    ...(spoiler
      ? [
          {
            property: { id: 'rezics:spoilerLevel', data_type: 'quantity' },
            value: { type: 'value', content: { amount: '+1', unit: '1' } },
          },
        ]
      : []),
  ],
  references: [
    {
      parts: [
        {
          property: { id: 'schema:url', data_type: 'url' },
          value: { type: 'value', content: `https://evidence.test/original-${n}` },
        },
      ],
    },
  ],
  rezics: { revision: 7, release: 'sha256:original-release' },
});
const row = (n: number, inverse = false, spoiler = false) => ({
  ...(inverse
    ? { subject: id(2), property, statement: id(n), assertion: original(n, true, spoiler) }
    : { target: id(2), statement: original(n, false, spoiler) }),
  summary: {
    id: id(2),
    type: 'schema:Book',
    types: ['schema:Book'],
    label: { value: spoiler ? 'Secret sequel' : '海の物語', language: 'ja' },
    cover: null,
  },
  related: {},
});
const windowFor = (node: string, rows: unknown[] = [], inverse = false): ProfileRelationWindow => ({
  node,
  property,
  direction: inverse ? 'inverse' : 'forward',
  rows,
  complete: true,
  status: 200,
  valid: true,
  limit: 8,
});

test('bounded preview shares twelve places across streams and never converts incomplete or missing windows to empty', () => {
  const windows = Array.from({ length: 8 }, (_, n) =>
    windowFor(String(n), [row(10 + n), row(30 + n), row(50 + n), row(70 + n)]),
  );
  const groups = workFranchiseGroups(id(1), windows, definitions);
  expect(groups.reduce((n, group) => n + group.preview.length, 0)).toBe(12);
  expect(groups.every((group) => group.preview.length > 0 && group.preview.length <= 3 && group.more)).toBe(true);
  expect(groups[0]!.preview[0]!.statement).toBe((windows[0]!.rows[0] as ReturnType<typeof row>).statement);
  const empty = windowFor('empty');
  const states = workFranchiseGroups(
    id(1),
    [
      empty,
      { ...empty, complete: false, next: 'opaque' },
      { ...empty, caughtUp: false },
      { ...empty, status: 503 },
      { ...empty, property: 'unknown' },
      windowFor('malformed', [{ ...row(99), summary: { ...row(99).summary, id: id(3) } }]),
    ],
    definitions,
  );
  expect(states.map((group) => group.state)).toEqual([
    'empty',
    'ready',
    'ready',
    'unavailable',
    'unsupported',
    'unavailable',
  ]);
  expect(states[1]!.more && states[2]!.more).toBe(true);
});

test('mounted groups preserve originals, gated evidence, human labels and exact row return across reader replacements', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const browser = new Window({ url: `https://site.test/en/subjects/${id(1)}/source` });
  const globals = {
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    HTMLElement: browser.HTMLElement,
    Element: browser.Element,
    Node: browser.Node,
    MutationObserver: browser.MutationObserver,
    getComputedStyle: browser.getComputedStyle.bind(browser),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const subject = { id: id(1), context: id(4), release: 'sha256:page-release', revision: 2, statements: {} } as Subject;
  const windows = [
    windowFor('forward', [row(10), row(11), row(12, false, true)]),
    windowFor('inverse', [row(20, true)], true),
    { ...windowFor('empty'), property: 'wdt:P156' },
    { ...windowFor('failed'), property: 'wdt:P144', status: 503 },
    { ...windowFor('unsupported'), property: 'unknown' },
  ];
  const value = {
    locale: 'en',
    subject: id(1),
    subjectLabel: 'Original work',
    context: { id: id(4), population: { kind: 'global' } },
    link: (props: any) => h('a', props),
    reader: { spoilerLevel: 0, suitability: 'show' },
    labels: { cover: {}, spoilerHide: 'Hide' },
    unlabelled: 'Unlabelled',
    spoilerShow: 'Reveal',
    candidatePropertyLabel: (p: string) =>
      ({
        'schema:position': 'Position',
        'schema:datePublished': 'Publication date',
        'schema:url': 'URL',
        'rezics:spoilerLevel': 'Spoiler level',
      })[p] ?? 'Unlabelled',
    relations: definitions,
    sections: new Map(),
  } as unknown as OverviewValue;
  const draw = (current = windows, reading = value, source = subject) =>
    act(async () =>
      root.render(
        h(
          OverviewContext.Provider,
          { value: reading },
          h(WorkFranchiseOverview, {
            subject: source,
            related: {},
            definitions,
            windows: current,
            locale: 'en',
            readerSpoiler: reading.reader.spoilerLevel,
            returnTo: `/en/subjects/${id(1)}/source`,
          }),
        ),
      ),
    );
  try {
    await draw();
    expect(host.querySelectorAll('[data-work-stream]')).toHaveLength(5);
    expect(host.querySelectorAll('[data-work-statement]')).toHaveLength(3);
    expect(host.textContent).toContain('Forward wdt:P155');
    expect(host.textContent).toContain('Inverse wdt:P155');
    expect(host.textContent).toContain('No visible entries');
    expect(host.textContent).toContain('This relation is unavailable');
    expect(host.textContent).toContain('not supported');
    expect(host.textContent).toContain('Position');
    expect(host.textContent).toContain('Publication date');
    expect(host.textContent).toContain('2001');
    expect(host.textContent).not.toContain('2001-01-01');
    expect(host.querySelector('[lang="ja"]')?.textContent).toContain('海の物語');
    expect(host.textContent).not.toContain('Secret sequel');
    expect(host.innerHTML).not.toContain('original-12');
    const inverse = host.querySelector<HTMLElement>(`[data-work-statement="${id(20)}"]`)!;
    expect(inverse.dataset.workHolder).toBe(id(2));
    expect(inverse.textContent).toContain('original-20');
    expect(inverse.textContent).not.toContain('original-10');
    expect(inverse.textContent).toContain('sha256:original-release');
    const explanation = inverse.querySelector<HTMLDetailsElement>('details')!;
    explanation.open = true;
    await act(async () =>
      explanation.dispatchEvent(new browser.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    );
    expect(explanation.open).toBe(false);
    expect(document.activeElement).toBe(explanation.querySelector('summary'));
    const links = [...inverse.querySelectorAll<HTMLAnchorElement>('a')];
    const sources = links.find((a) => new URL(a.href).pathname.endsWith('/sources'))!;
    const why = links.find((a) => new URL(a.href).pathname.endsWith('/value'))!;
    expect(new URL(sources.href).pathname).toContain(id(2));
    expect(new URL(why.href).searchParams.get('statement')).toBe(id(20));
    expect(new URL(why.href).searchParams.get('context')).toBe(id(4));
    for (const link of [sources, why, links.find((a) => a.lang === 'ja')!]) {
      const via = new URL(link.href).searchParams.get('via')!;
      expect(subjectVisitReturn(via, 'en')).toBe(via);
      expect(workFranchiseReturn(new URL(via, 'https://site.test').hash)).toMatchObject({
        stream: `in:${property}`,
        statement: id(20),
        holder: id(2),
      });
    }
    browser.location.href = `https://site.test${new URL(sources.href).searchParams.get('via')}`;
    await draw(structuredClone(windows));
    expect(document.activeElement?.closest('[data-work-statement]')?.getAttribute('data-work-statement')).toBe(id(20));
    const continuation = host.querySelector<HTMLAnchorElement>('[data-work-stream="in:wdt:P155"] > a')!;
    expect(new URL(continuation.href).hash).toBe('#connections?stream=in%3Awdt%3AP155');
    const reveal = host.querySelector<HTMLButtonElement>('button')!;
    await act(async () => reveal.click());
    expect(host.textContent).toContain('Secret sequel');
    await draw(windows, { ...value, releaseDigest: 'sha256:changed-definitions' });
    expect(host.textContent).not.toContain('Secret sequel');
    await draw(
      structuredClone(windows),
      { ...value, cacheReader: 'replacement', context: { ...value.context!, id: id(5) } },
      { ...subject, revision: 3, release: 'sha256:replacement' },
    );
    expect(host.textContent).not.toContain('Secret sequel');
    expect(host.querySelectorAll('button[type="submit"]')).toHaveLength(0);
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await browser.happyDOM.close();
  }
});
