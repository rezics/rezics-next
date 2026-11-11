import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CollectionMember } from '../src/library/reads';
import { collectionComparisonFacts, collectionComparisonHref } from '../src/library/collection-comparison/model';
import { subjectVisitReturn } from '../src/features/pages/subject-visit-navigation';

mock.module('cloudflare:workers', () => ({ env: { PUBLIC_ORIGIN: 'https://rezics.test' } }));
const { CollectionReadMembers } = await import('../src/library/collection-page');
const { CollectionMemberOccurrenceDetails } = await import('../src/library/collection-member-details');
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

test('compact layouts defer complete evidence to the same occurrence detail and retain independent identities', () => {
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
    expect(html).toContain('Same name');
    expect(html).toContain('February 2024');
    expect(html).not.toContain('Occurrence 2');
    expect(html).not.toContain('data-comparison-reference');
    expect(html).not.toContain('Your private Library');
    expect(html.match(/data-collection-detail-opener/g)).toHaveLength(2);
    for (const member of members) {
      expect(html).toContain(`id="collection-member-${member.id}"`);
      const detail = renderToStaticMarkup(
        createElement(CollectionMemberOccurrenceDetails, {
          member,
          listPresentations,
          comparisonDefinitions,
          currentHref: source,
          onCopy() {},
        }),
      );
      for (const text of ['Creator', 'Recorded date', 'February 2024', '95 min', 'A-17', member.note!])
        expect(detail).toContain(text);
      expect(detail).not.toContain('Unselected');
      const target = member.facts!.creator![0]!;
      if (target.kind !== 'item') throw new Error('Expected item fixture');
      expect(detail).toContain(`data-comparison-reference="${target.id}"`);
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
  expect(
    renderToStaticMarkup(
      createElement(CollectionMemberOccurrenceDetails, { member: base, currentHref: source, onCopy() {} }),
    ),
  ).toContain('Property name unavailable');
  expect(
    collectionComparisonFacts({ ...base, facts: { date: [{ kind: 'time', year: 1943 }] } }, undefined, {}, 'en')[0]
      ?.text,
  ).toBe('1943');
  expect(collectionComparisonFacts(base, listPresentations, comparisonDefinitions, 'ja')[0]).toMatchObject({
    text: '同名',
    label: { text: '作成者' },
  });
  const filtered = new URL(
    collectionComparisonHref(id(12), 'Same name', 'en', `${source}#collection-member-${id(4)}`, undefined),
    'https://rezics.test',
  );
  expect(filtered.searchParams.get('via')).toBe(source);
  const projection = renderToStaticMarkup(
    createElement(CollectionReadMembers, {
      members: [{ subject: base.subject, facts: base.facts }],
      currentHref: source,
      comparisonDefinitions,
      onCopy() {},
    }),
  );
  expect(projection).not.toContain('id="collection-member-');
  expect(projection).not.toContain('#collection-member-');
});

test('mounted reference returns repeat on the retained page and retire on replacement without taking focus', async () => {
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
  const render = async (rows: CollectionMember[], href = source, returnSource?: object, readerChanged = false) =>
    act(async () =>
      root.render(
        createElement(CollectionReadMembers, {
          key: readerChanged ? 'next-reader' : 'reader',
          members: rows,
          currentHref: href,
          returnSource,
          admitInitialReturn: !readerChanged,
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
    const links = [...container.querySelectorAll<HTMLAnchorElement>('a[href*="/subjects/"]')];
    expect(links).toHaveLength(2);
    expect(links.every((link) => !link.parentElement?.closest('a'))).toBe(true);
    expect(new URL(links[1]!.href).searchParams.get('via')).toBe(`${source}#collection-member-${id(3)}`);
    const target = window.document.getElementById(`collection-member-${id(3)}`)!;
    const returnEvent = () => window.dispatchEvent(new window.PageTransitionEvent('pageshow', { persisted: true }));
    const depart = () => {
      links[1]!.focus();
      links[1]!.addEventListener('click', (event) => event.preventDefault(), { once: true });
      links[1]!.click();
    };
    for (let visit = 0; visit < 2; visit++) {
      depart();
      await act(async () => returnEvent());
      expect(window.document.activeElement).toBe(target);
    }
    const away = window.document.createElement('button');
    container.prepend(away);
    depart();
    away.focus();
    await act(async () => returnEvent());
    expect(window.document.activeElement).toBe(away);
    away.blur();
    await act(async () => returnEvent());
    expect(window.document.activeElement).toBe(window.document.body);
    // A new fragment navigation admits another return, including the same occurrence later.
    window.history.replaceState(null, '', source);
    await act(async () => window.dispatchEvent(new window.HashChangeEvent('hashchange')));
    window.history.replaceState(null, '', `${source}#collection-member-${id(3)}`);
    await act(async () => window.dispatchEvent(new window.HashChangeEvent('hashchange')));
    expect(window.document.activeElement).toBe(target);
    // A native response replacement retires an admitted departure, even with identical IDs.
    depart();
    const replacement = members.map((member) => ({ ...member }));
    await render(replacement);
    links[1]!.blur();
    await act(async () => returnEvent());
    expect(window.document.activeElement).toBe(window.document.body);
    depart();
    await render(replacement, source, {});
    links[1]!.blur();
    await act(async () => returnEvent());
    expect(window.document.activeElement).toBe(window.document.body);
    // Reused occurrence fragments cannot replay a departure into another address.
    for (const next of [source.replace(id(1), id(8)), source.replace('cursor=two', 'cursor=three')]) {
      await render(members);
      depart();
      window.history.replaceState(null, '', `${next}#collection-member-${id(3)}`);
      await render(members, next);
      links[1]!.blur();
      await act(async () => returnEvent());
      expect(window.document.activeElement).toBe(window.document.body);
    }
    window.history.replaceState(null, '', `${source}#collection-member-${id(3)}`);
    await render(members);
    depart();
    await render([{ ...members[0]!, id: id(99), facts: {} }]);
    await act(async () => returnEvent());
    expect(window.document.activeElement).toBe(window.document.body);
    window.history.replaceState(null, '', `${source}#collection-member-${id(3)}`);
    await render(members, source, undefined, true);
    await act(async () => returnEvent());
    expect(window.document.activeElement).toBe(window.document.body);
    await render([{ ...members[0]!, id: id(99), facts: {} }], source, undefined, true);
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
}, 30_000);
afterAll(() => mock.restore());
