import { expect, mock, test } from 'bun:test';
import { act, createElement } from 'react';
import { dirname } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoot } from 'react-dom/client';
import { defaultReader } from '../src/subject/reader';
import type { Subject } from '../src/subject/types';
import { dateText } from '../src/features/pages/overview';
import {
  mangaReaderMeasures,
  mangaReaderRetired,
  mangaReaderRows,
  mangaReaderWindowStatus,
  type MangaReaderObservation,
} from '../src/features/catalogue/manga-reader/model';
import type { ProfileRelationWindow } from '../src/features/pages/views';
import type { RelationDefinition } from '../src/subject/relations';

mock.module('cloudflare:workers', () => ({ env: {} }));
const { MangaReader } = await import('../src/features/catalogue/manga-reader/view');

const seriesId = '0192f3a0-6c1e-7b2a-9d4e-000000000901';
const volumeTwoId = '0192f3a0-6c1e-7b2a-9d4e-000000000902';
const volumeOneId = '0192f3a0-6c1e-7b2a-9d4e-000000000903';
const chapterId = '0192f3a0-6c1e-7b2a-9d4e-000000000904';
const editionId = '0192f3a0-6c1e-7b2a-9d4e-000000000905';

const definitions: Record<string, RelationDefinition> = {
  'schema:isPartOf': { label: 'Volumes', forwardLabel: 'Part of', group: 'membership', symmetric: false },
  'bf:hasPart': { label: 'Chapters', forwardLabel: 'Part of', group: 'membership', symmetric: false },
  'schema:workExample': { label: 'Editions', forwardLabel: 'Edition', group: 'association', symmetric: false },
};

function assertion(id: string, property: string, target: string, position?: string) {
  return {
    id,
    rank: 'normal',
    property: { id: property, data_type: 'wikibase-item' },
    value: { type: 'value', content: target },
    qualifiers: position
      ? [{ property: { id: 'schema:position', data_type: 'string' }, value: { type: 'value', content: position } }]
      : [],
    references: [],
    rezics: { release: 'current-release', revision: 1 },
  };
}

function inverseRow(id: string, label: string, type: string, property: string, statementId: string, position?: string) {
  return {
    subject: id,
    property,
    statement: statementId,
    assertion: assertion(statementId, property, seriesId, position),
    related: {},
    type,
    label,
    summary: { id, type, types: [type], label: { value: label, language: 'en' }, creativeWork: true, cover: null },
  };
}

function forwardRow(target: string, label: string, type: string, property: string, statementId: string) {
  return {
    target,
    statement: assertion(statementId, property, target),
    related: {},
    type,
    label,
    summary: {
      id: target,
      type,
      types: [type],
      label: { value: label, language: 'en' },
      creativeWork: true,
      cover: null,
    },
  };
}

function window(
  node: string,
  property: string,
  direction: 'forward' | 'inverse',
  rows: readonly unknown[],
  options: { status?: number; valid?: boolean; next?: string; count?: ProfileRelationWindow['count'] } = {},
): ProfileRelationWindow {
  return {
    node,
    property,
    direction,
    rows,
    status: options.status ?? 200,
    valid: options.valid ?? true,
    complete: !options.next,
    ...(options.next ? { next: options.next } : {}),
    ...(options.count ? { count: options.count } : {}),
  };
}

function mangaSubject(id: string, type: 'schema:ComicSeries' | 'schema:PublicationVolume', label: string): Subject {
  return { id, type, labels: { en: label }, statements: {}, context: 'catalogue' } as unknown as Subject;
}

const observation = (overrides: Partial<MangaReaderObservation> = {}): MangaReaderObservation => ({
  source: {},
  release: definitions,
  subject: seriesId,
  context: 'catalogue',
  locale: 'en',
  viewer: null,
  view: 'overview',
  window: null,
  ...overrides,
});

test('the composed Manga window separates volumes, generic parts and editions by exact native relation identity', () => {
  const windows = [
    window(
      'volumes',
      'schema:isPartOf',
      'inverse',
      [
        inverseRow(volumeTwoId, 'Volume 2', 'schema:PublicationVolume', 'schema:isPartOf', 'statement-volume-2', '2'),
        inverseRow(volumeOneId, 'Volume 1', 'schema:PublicationVolume', 'schema:isPartOf', 'statement-volume-1', '1'),
      ],
      { count: { value: 2, relation: 'exact' } },
    ),
    window(
      'chapters',
      'bf:hasPart',
      'inverse',
      [inverseRow(chapterId, 'Chapter 1: Harbour at Dawn', 'schema:CreativeWork', 'bf:hasPart', 'statement-chapter-1')],
      { count: { value: 3, relation: 'lower_bound' }, next: 'native:chapter-window' },
    ),
    window('editions', 'schema:workExample', 'forward', [
      forwardRow(editionId, 'First print', 'bf:Instance', 'schema:workExample', 'statement-edition'),
    ]),
  ];
  const html = renderToStaticMarkup(
    createElement(MangaReader, {
      subject: mangaSubject(seriesId, 'schema:ComicSeries', 'The Harbour Atlas'),
      locale: 'en',
      view: 'overview',
      windows,
      definitions,
      reader: defaultReader,
      observation: observation(),
      recoveryHref: `/en/subjects/${seriesId}/the-harbour-atlas#manga-reader`,
    }),
  );
  expect(html.indexOf('Volume 2')).toBeLessThan(html.indexOf('Volume 1'));
  expect(html).toContain('Order: 2');
  expect(html).toContain('Chapter 1: Harbour at Dawn');
  expect(html).toContain('Editions');
  expect(html).toContain(`/en/subjects/${volumeTwoId}/volume-2`);
  expect(html).toContain(`/en/subjects/${chapterId}/chapter-1-harbour-at-dawn`);
  expect(html).toContain(`/en/subjects/${editionId}/first-print`);
  for (const statementId of ['statement-volume-2', 'statement-volume-1', 'statement-chapter-1', 'statement-edition'])
    expect(html).toContain(`data-statement-id="${statementId}"`);
  expect(html).toContain('exact 2');
  expect(html).toContain('at least 3');
  expect(html).toContain('Public relation counts describe catalogue facts');
  expect(html).not.toContain('completed 2 chapters');
  expect(dateText('2024-04', 'en')).toBe('April 2024');
  expect(dateText(undefined, 'en')).toBeNull();
});

test('an exact volume retains its disclosed parent and edition identities without a guessed parent', () => {
  const parentId = '0192f3a0-6c1e-7b2a-9d4e-000000000906';
  const volumeId = volumeOneId;
  const html = renderToStaticMarkup(
    createElement(MangaReader, {
      subject: mangaSubject(volumeId, 'schema:PublicationVolume', 'Volume 1'),
      locale: 'en',
      view: 'overview',
      windows: [
        window('parent', 'schema:isPartOf', 'forward', [
          forwardRow(parentId, 'The Harbour Atlas', 'schema:ComicSeries', 'schema:isPartOf', 'statement-parent'),
        ]),
        window('editions', 'schema:workExample', 'forward', [
          forwardRow(editionId, 'First print', 'bf:Instance', 'schema:workExample', 'statement-volume-edition'),
        ]),
      ],
      definitions,
      reader: defaultReader,
      observation: observation({ subject: volumeId }),
      recoveryHref: `/en/subjects/${volumeId}/volume-1#manga-reader`,
    }),
  );
  expect(html).toContain(`/en/subjects/${parentId}/the-harbour-atlas`);
  expect(html).toContain(`/en/subjects/${editionId}/first-print`);
  expect(html).toContain('data-statement-id="statement-parent"');
  expect(html).toContain('data-statement-id="statement-volume-edition"');
  expect(html).not.toContain(`/en/subjects/${seriesId}/the-harbour-atlas`);
});

test('unsupported, withheld, failed, empty and continued windows stay distinct and relation admission is bounded', () => {
  const statuses = (value: readonly ProfileRelationWindow[]) => mangaReaderWindowStatus(value, definitions);
  expect(statuses([])).toBe('unsupported');
  expect(statuses([window('withheld', 'schema:isPartOf', 'inverse', [], { status: 403, valid: false })])).toBe(
    'withheld',
  );
  expect(statuses([window('failed', 'schema:isPartOf', 'inverse', [], { status: 503, valid: false })])).toBe(
    'unavailable',
  );
  expect(statuses([window('empty', 'schema:isPartOf', 'inverse', [])])).toBe('empty-exhausted');
  expect(statuses([window('sparse', 'schema:isPartOf', 'inverse', [], { next: 'opaque-window' })])).toBe(
    'empty-continued',
  );

  const ordinary = inverseRow(
    volumeOneId,
    'Volume 1',
    'schema:PublicationVolume',
    'schema:isPartOf',
    'native-statement',
  );
  expect(
    mangaReaderRows(
      [window('unknown-order', 'schema:isPartOf', 'inverse', [ordinary])],
      definitions,
      'en',
      defaultReader,
    )[0]?.notes,
  ).toEqual([]);
  const mismatched = { ...ordinary, property: 'bf:hasPart' };
  expect(statuses([window('foreign', 'schema:isPartOf', 'inverse', [mismatched])])).toBe('unavailable');

  const rows = Array.from({ length: 20 }, (_, index) =>
    inverseRow(
      `0192f3a0-6c1e-7b2a-9d4e-${String(index + 1000).padStart(12, '0')}`,
      `Volume ${index + 1}`,
      'schema:PublicationVolume',
      'schema:isPartOf',
      `native-${index}`,
    ),
  );
  const admitted = window('bounded', 'schema:isPartOf', 'inverse', rows, { count: { value: 20, relation: 'exact' } });
  expect(statuses([admitted])).toBe('populated');
  expect(mangaReaderRows([admitted], definitions, 'en', defaultReader)).toHaveLength(20);
  expect(mangaReaderMeasures([window('unknown-count', 'schema:isPartOf', 'inverse', rows)], definitions)).toEqual([]);
  expect(statuses([window('oversize', 'schema:isPartOf', 'inverse', [...rows, ordinary])])).toBe('unavailable');
  expect(
    mangaReaderRows(
      [window('oversize', 'schema:isPartOf', 'inverse', [...rows, ordinary])],
      definitions,
      'en',
      defaultReader,
    ),
  ).toEqual([]);
});

test('replacement of the current source, release, viewer, context, locale, view or opaque window retires the visit', () => {
  const captured = observation();
  for (const replacement of [
    { source: {} },
    { release: {} },
    { subject: volumeOneId },
    { context: 'another-context' },
    { locale: 'ja' },
    { viewer: 'viewer-2' },
    { view: 'contents' },
    { window: 'parts\u0000opaque-next' },
    { realm: 'another-realm' },
    { admission: 'rotated-credential' },
    { reader: 'changed-reader' },
    { address: 'another-address' },
  ])
    expect(mangaReaderRetired(captured, { ...captured, ...replacement })).toBe(true);
  expect(mangaReaderRetired(captured, { ...captured })).toBe(false);
});

test('a changed viewer or source hides old links and returning to the prior observation does not revive them', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const browser = new Window({ url: 'https://rezics.test/' });
  const globals = {
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    HTMLElement: browser.HTMLElement,
    Element: browser.Element,
    Node: browser.Node,
    MutationObserver: browser.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const host = browser.document.createElement('div');
  browser.document.body.append(host);
  const root = createRoot(host);
  const props = {
    subject: mangaSubject(seriesId, 'schema:ComicSeries', 'The Harbour Atlas'),
    locale: 'en',
    view: 'overview',
    windows: [
      window('parts', 'schema:isPartOf', 'inverse', [
        inverseRow(volumeOneId, 'Volume 1', 'schema:PublicationVolume', 'schema:isPartOf', 'statement-retired'),
      ]),
    ],
    definitions,
    reader: defaultReader,
    observation: observation(),
    recoveryHref: `/en/subjects/${seriesId}/the-harbour-atlas#manga-reader`,
  };
  try {
    await act(async () => root.render(createElement(MangaReader, props)));
    expect(host.querySelector(`a[href*="${volumeOneId}"]`)).not.toBeNull();
    await act(async () =>
      root.render(
        createElement(MangaReader, {
          ...props,
          observation: observation({ source: {}, viewer: 'same-account-new-credential' }),
        }),
      ),
    );
    expect(host.querySelector('[data-state="stale"]')).not.toBeNull();
    expect(host.querySelector(`a[href*="${volumeOneId}"]`)).toBeNull();
    await act(async () => root.render(createElement(MangaReader, props)));
    expect(host.querySelector('[data-state="stale"]')).not.toBeNull();
    expect(host.querySelector(`a[href*="${volumeOneId}"]`)).toBeNull();
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of previous)
      descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key);
    await browser.happyDOM.close();
  }
});

// Mount the public consumer; authored native-shaped rows are not a seeded/browser acceptance claim.
test('one selected occurrence keeps its original inverse holder, qualifiers and separate reference groups', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const browser = new Window({ url: 'https://rezics.test/' });
  const globals = {
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    HTMLElement: browser.HTMLElement,
    Element: browser.Element,
    Node: browser.Node,
    MutationObserver: browser.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const host = browser.document.createElement('div');
  browser.document.body.append(host);
  const root = createRoot(host);
  const part = (text: string) => ({
    property: { id: 'schema:description', data_type: 'string' },
    value: { type: 'value', content: text },
  });
  const first = inverseRow(volumeOneId, 'Repeated volume', 'schema:PublicationVolume', 'schema:isPartOf', 'first', '1');
  const second = inverseRow(
    volumeOneId,
    'Repeated volume',
    'schema:PublicationVolume',
    'schema:isPartOf',
    'second',
    '2',
  );
  const rows = [
    first,
    {
      ...second,
      assertion: {
        ...second.assertion,
        references: [
          { hash: 'source-a', parts: [part('First citation'), part('Same group detail')] },
          { hash: 'source-b', parts: [part('Second citation')] },
        ],
      },
    },
  ];
  const props = {
    subject: mangaSubject(seriesId, 'schema:ComicSeries', 'The Harbour Atlas'),
    locale: 'en',
    view: 'contents',
    windows: [
      window('parts', 'schema:isPartOf', 'inverse', rows),
      window('another-node', 'schema:isPartOf', 'inverse', [second]),
    ],
    definitions,
    reader: defaultReader,
    observation: observation({ view: 'contents' }),
    recoveryHref: `/en/subjects/${seriesId}/the-harbour-atlas/contents?node=parts&cursor=opaque#manga-reader`,
  };
  try {
    await act(async () => root.render(createElement(MangaReader, props)));
    expect(host.querySelector('[data-slot="manga-occurrence-evidence"]')).toBeNull();
    const buttons = [...host.querySelectorAll('button')];
    expect(buttons).toHaveLength(3);
    await act(async () => buttons[1]!.click());
    expect(buttons.map((button) => button.getAttribute('aria-expanded'))).toEqual(['false', 'true', 'false']);
    const evidence = host.querySelector('[data-slot="manga-occurrence-evidence"]')!;
    expect(evidence.textContent).toContain('Inverse to this subject');
    expect(evidence.textContent).toContain('Original holderRepeated volume');
    expect(evidence.querySelectorAll('[data-reference]')).toHaveLength(2);
    expect(evidence.querySelector('[data-reference="source-a"]')?.textContent).toContain('Same group detail');
    expect(evidence.querySelector('[data-reference="source-a"]')?.textContent).not.toContain('Second citation');
    const correction = [...evidence.querySelectorAll('a')].find(
      (anchor) => anchor.textContent === 'Propose correction',
    )!;
    const correctionUrl = new URL(correction.href);
    expect(correctionUrl.pathname).toBe(`/en/subjects/${volumeOneId}/repeated-volume/relation-edit`);
    const origin = new URL(correctionUrl.searchParams.get('via')!, 'https://rezics.test');
    expect(origin.searchParams.get('node')).toBe('parts');
    expect(origin.searchParams.get('cursor')).toBe('opaque');
    expect(origin.hash).toContain('statement=second');
    expect(origin.hash).toContain(`holder=${volumeOneId}`);
    expect([...correctionUrl.searchParams.keys()]).toEqual(['via']);
    await act(async () => buttons[2]!.click());
    expect(host.querySelectorAll('[data-slot="manga-occurrence-evidence"]')).toHaveLength(1);
    expect(host.textContent).not.toContain('First citation');
    await act(async () => buttons[2]!.click());
    expect(host.querySelector('[data-slot="manga-occurrence-evidence"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of previous)
      descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key);
    await browser.happyDOM.close();
  }
});

test('withheld assertions, malformed evidence and full-assertion spoiler admission preserve their distinctions', () => {
  const row = inverseRow(volumeOneId, 'Volume 1', 'schema:PublicationVolume', 'schema:isPartOf', 'original');
  const withheld = { ...row, assertion: undefined };
  const native = (rows: unknown[]) => [window('parts', 'schema:isPartOf', 'inverse', rows)];
  const disclosed = mangaReaderRows(native([withheld]), definitions, 'en', defaultReader);
  expect(disclosed).toHaveLength(1);
  expect(disclosed[0]?.assertion).toBeUndefined();
  expect(disclosed[0]?.notes).toEqual([]);
  const foreign = { ...row, assertion: { ...row.assertion, value: { type: 'value', content: editionId } } };
  expect(mangaReaderWindowStatus(native([foreign]), definitions, defaultReader, seriesId)).toBe('unavailable');
  expect(
    mangaReaderRows(
      native([foreign]),
      definitions,
      'en',
      defaultReader,
      mangaSubject(seriesId, 'schema:ComicSeries', 'The Harbour Atlas'),
    ),
  ).toEqual([]);
  for (const malformed of [
    { ...row.assertion, references: [{ hash: 'broken', parts: [null] }] },
    {
      ...row.assertion,
      qualifiers: Array.from({ length: 17 }, () => ({
        property: { id: 'x', data_type: 'string' },
        value: { type: 'novalue' },
      })),
    },
    { ...row.assertion, references: Array.from({ length: 17 }, () => ({ hash: 'too-many', parts: [] })) },
    {
      ...row.assertion,
      references: [
        {
          hash: 'too-wide',
          parts: Array.from({ length: 17 }, () => ({
            property: { id: 'x', data_type: 'string' },
            value: { type: 'novalue' },
          })),
        },
      ],
    },
    { ...row.assertion, id: 'different-association' },
  ]) {
    const page = native([{ ...row, assertion: malformed }]);
    expect(mangaReaderWindowStatus(page, definitions)).toBe('unavailable');
    expect(mangaReaderRows(page, definitions, 'en', defaultReader)).toEqual([]);
  }
  const spoiler = {
    ...row,
    assertion: {
      ...row.assertion,
      qualifiers: [
        {
          property: { id: 'rezics:spoilerLevel', data_type: 'quantity' },
          value: { type: 'value', content: { amount: '2', unit: '1' } },
        },
      ],
    },
  };
  expect(mangaReaderRows(native([spoiler]), definitions, 'en', defaultReader)).toEqual([]);
  expect(
    mangaReaderRows(native([spoiler]), definitions, 'en', { ...defaultReader, spoilerLevel: 2 })[0]?.assertion,
  ).toBe(spoiler.assertion);
});
