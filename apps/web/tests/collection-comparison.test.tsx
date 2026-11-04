import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CollectionMember } from '../src/library/reads';
import { collectionComparisonFacts, collectionComparisonHref } from '../src/library/collection-comparison/model';
import { subjectVisitReturn } from '../src/features/pages/subject-visit-navigation';

mock.module('cloudflare:workers', () => ({ env: { PUBLIC_ORIGIN: 'https://rezics.test' } }));
const { CollectionReadMembers } = await import('../src/library/collection-page');
const { CollectionMemberList } = await import('../src/library/collection-editor');
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const source = `/en/collections/${id(1)}?cursor=two&layout=grid&type=work&f.genre=fiction&l.genre=Fiction`;
const members: CollectionMember[] = [2, 3].map((n) => ({
  id: id(n),
  note: `Occurrence ${n}`,
  addedAt: '2026-10-01T00:00:00Z',
  subject: { id: id(4), type: 'work', types: ['work'], label: 'Identical title', cover: null },
  facts: {
    creator: [{ kind: 'item', id: id(n + 10), labels: { en: 'Same name', ja: '同名' } }],
    date: [{ kind: 'time', year: 2024, month: 2 }],
    code: [{ kind: 'code', value: 'A-17' }],
    quantity: [{ kind: 'quantity', amount: 95, unit: 'min' }],
    ignored: [{ kind: 'code', value: 'Unselected' }],
  },
}));
const listPresentations = {
  work: { imageAspect: 'portrait' as const, keyFacts: ['creator', 'date', 'code', 'quantity'] },
};
const comparisonDefinitions = {
  creator: { labels: { en: 'Creator', ja: '作成者' } },
  date: { labels: { en: 'Recorded date' } },
};

test('actual grid, list and editor compositions retain property meanings, supplied targets and independent occurrences', () => {
  for (const layout of ['grid', 'list'] as const) {
    const html = renderToStaticMarkup(
      createElement(CollectionReadMembers, {
        members,
        layout,
        listPresentations,
        comparisonDefinitions,
        currentHref: source,
        onCopy() {},
      }),
    );
    for (const text of ['Creator', 'Recorded date', 'February 2024', '95 min', 'A-17', 'Occurrence 2', 'Occurrence 3'])
      expect(html).toContain(text);
    expect(html).not.toContain('Unselected');
    expect(html).not.toContain('Your private Library');
    for (const member of members) {
      const target = member.facts!.creator![0]!;
      if (target.kind !== 'item') throw new Error('Expected item fixture');
      expect(html).toContain(`data-comparison-reference="${target.id}"`);
      const destination = new URL(
        collectionComparisonHref(target.id, 'Same name', 'en', source, member.id),
        'https://rezics.test',
      );
      expect(destination.pathname).toContain(target.id);
      expect(subjectVisitReturn(destination.searchParams.get('via'), 'en')).toBe(
        `${source}#collection-member-${member.id}`,
      );
    }
    expect(html).not.toContain('<a href="/en/subjects/undefined');
  }
  const editor = renderToStaticMarkup(
    createElement(CollectionMemberList, {
      members,
      editing: true,
      firstPage: false,
      selectedIds: new Set([id(3)]),
      onSelectionChange() {},
      listPresentations,
      comparisonDefinitions,
    }),
  );
  expect(editor).toContain('Creator');
  expect(editor).toContain('aria-checked="true"');
  expect(editor).not.toContain('data-comparison-reference');
});

test('missing, empty, unavailable and concealed context stays truthful without inventing destinations or precision', () => {
  const render = (
    member: CollectionMember,
    definitions = comparisonDefinitions as typeof comparisonDefinitions | undefined,
  ) =>
    renderToStaticMarkup(
      createElement(CollectionReadMembers, {
        members: [member],
        currentHref: source,
        comparisonDefinitions: definitions,
        onCopy() {},
      }),
    );
  const base = members[0]!;
  expect(render({ ...base, facts: undefined })).toContain('data-context-state="unknown"');
  expect(render({ ...base, facts: {} })).toContain('data-context-state="empty"');
  expect(
    renderToStaticMarkup(createElement(CollectionReadMembers, { members: [base], currentHref: source, onCopy() {} })),
  ).toContain('Context unavailable');
  const concealed = render({
    ...base,
    facts: { creator: [{ kind: 'item', id: '', labels: { en: 'Readable label' } }] },
  });
  expect(concealed).toContain('Readable label');
  expect(concealed).not.toContain('data-comparison-reference');
  const hidden = render({ ...base, subject: null });
  expect(hidden).not.toContain('Same name');
  expect(hidden).toContain(`id="collection-member-${base.id}"`);
  expect(render(base)).toContain('Property name unavailable');
  expect(
    collectionComparisonFacts({ ...base, facts: { date: [{ kind: 'time', year: 1943 }] } }, undefined, {}, 'en')[0]
      ?.text,
  ).toBe('1943');
  expect(collectionComparisonFacts(base, listPresentations, comparisonDefinitions, 'ja')[0]).toMatchObject({
    text: '同名',
    label: { text: '作成者' },
  });
  const filtered = new URL(
    collectionComparisonHref(id(12), 'Same name', 'en', source, undefined),
    'https://rezics.test',
  );
  expect(filtered.searchParams.get('via')).toBe(source);
});

test('mounted return focuses only the loaded occurrence, survives same-cursor recovery and cannot revive selection on replacement', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: `https://rezics.test${source}#collection-member-${id(3)}` });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const container = window.document.createElement('main');
  window.document.body.append(container);
  const root = createRoot(container);
  const render = async (rows: CollectionMember[]) =>
    act(async () =>
      root.render(
        createElement(CollectionReadMembers, {
          members: rows,
          currentHref: `${source}#collection-member-${id(3)}`,
          listPresentations,
          comparisonDefinitions,
          onCopy() {},
        }),
      ),
    );
  try {
    await render([]);
    await render(members);
    expect(window.document.activeElement?.id).toBe(`collection-member-${id(3)}`);
    const links = [...container.querySelectorAll<HTMLAnchorElement>('[data-comparison-reference]')];
    expect(links).toHaveLength(2);
    expect(links.every((link) => !link.parentElement?.closest('a'))).toBe(true);
    expect(new URL(links[1]!.href).searchParams.get('via')).toBe(`${source}#collection-member-${id(3)}`);
    await render([{ ...members[0]!, id: id(99), facts: {} }]);
    expect(container.querySelector('[data-comparison-reference]')).toBeNull();
    expect(container.querySelector('input,textarea,[role="checkbox"]')).toBeNull();
    expect(container.querySelector(`#collection-member-${id(3)}`)).toBeNull();
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
afterAll(() => mock.restore());
