import { expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement, type ComponentProps } from 'react';
import type { ConditionMetadata } from '../src/search/condition-editor-model';
import { SavedFilterReviewPanel } from '../src/library/saved-filter-review';
import type { SavedFilterReviewPage } from '../src/library/saved-filter-review/read';
import { m } from '../src/paraglide/messages.js';

type PanelProps = ComponentProps<typeof SavedFilterReviewPanel>;
type ReadyPage = Extract<SavedFilterReviewPage, { state: 'ready' }>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => (resolve = yes));
  return { promise, resolve };
}

const properties = Array.from({ length: 10 }, (_, index) => 'schema:topic' + index);
const ids = Array.from({ length: 10 }, (_, index) => 'exact-value-' + index);
const ruleFilter = {
  and: [
    { type: { in: ['schema:Book'] } },
    ...properties.map((property, index) => ({ statement: { property, in: [ids[index]!] } })),
  ],
} as const;
const acceptedMetadata: ConditionMetadata = {
  types: { 'schema:Book': { labels: { en: 'Book' }, bases: [], facets: properties } },
  properties: Object.fromEntries(properties.map((property, index) => [property, { datatype: 'wikibase-item', labels: { en: 'Accepted topic ' + index } }])),
  filters: {},
};
const currentMetadata: ConditionMetadata = {
  types: { 'schema:Book': { labels: { en: 'Book' }, bases: [], facets: [...properties.slice(0, 8), properties[9]!] } },
  properties: Object.fromEntries([
    ...properties.slice(0, 8).map((property, index) => [property, { datatype: 'wikibase-item', labels: { en: 'Current topic ' + index } }]),
    [properties[9]!, { datatype: 'wikibase-item', labels: {} }],
  ]),
  filters: {},
};
const page: ReadyPage = {
  state: 'ready',
  id: 'alpha',
  viewerId: 'alice',
  title: 'Private Collection',
  rule: { filter: ruleFilter, sort: 'id', revision: 4, collectionRevision: 8, releaseDigest: 'accepted-digest', sourceGeneration: '12' },
  accepted: { state: 'ready', digest: 'accepted-digest', metadata: acceptedMetadata },
  current: { state: 'ready', digest: 'current-digest', metadata: currentMetadata },
};

function owner(subject: string, generation: number) {
  return {
    subject,
    admitted: ['collection.get'],
    generation,
    lifetime: 'lifetime-' + generation,
    isOwnerCurrent: () => true,
  };
}

async function mount(initial: Partial<PanelProps> = {}) {
  const { Window } = await import(Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir))));
  const window = new Window({ url: 'https://site.test/en/collections/alpha' });
  const globals = {
    window,
    document: window.document,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const host = window.document.createElement('div') as unknown as HTMLDivElement;
  window.document.body.append(host);
  const root = createRoot(host);
  let props: PanelProps = {
    scope: { id: 'alpha', title: 'Private Collection', ownerId: 'alice', viewerId: 'alice' },
    authority: owner('alice', 1),
    read: async () => page,
    readValues: async () => ({ status: 'refused', code: 'collection_scope_refused' }),
    ...initial,
  };
  async function render(patch: Partial<PanelProps> = {}) {
    props = { ...props, ...patch };
    await act(async () => root.render(createElement(SavedFilterReviewPanel, props)));
  }
  await render();
  return {
    host,
    render,
    async click(text: string) {
      const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === text);
      expect(button).toBeDefined();
      await act(async () => button!.click());
    },
    async unmount() {
      await act(async () => root.unmount());
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
      await window.happyDOM.close();
    },
  };
}

test('owner review lists all retained operands, pins accepted labels, and keeps values visible after exact-Collection refusal', async () => {
  let reads = 0;
  const requests: unknown[] = [];
  const ui = await mount({
    read: async () => {
      reads += 1;
      return page;
    },
    readValues: async (request) => {
      requests.push(request);
      return { status: 'refused', code: 'collection_scope_refused' };
    },
  });
  try {
    expect(reads).toBe(0);
    expect(ui.host.textContent).not.toContain('accepted-digest');
    await ui.click(m.saved_filter_review_open());
    expect(reads).toBe(1);
    expect(ui.host.textContent).toContain('accepted-digest');
    expect(ui.host.textContent).toContain('Accepted topic 0');
    expect(ui.host.textContent).toContain(m.saved_filter_review_field_removed());
    expect(ui.host.textContent).toContain(m.saved_filter_review_label_missing());
    for (const id of ids) expect(ui.host.textContent).toContain(id);

    await ui.click(m.saved_filter_review_value_labels());
    expect(requests).toHaveLength(2);
    for (const value of requests) {
      const request = value as { resource: { kind: string; id: string }; facets: { property: string }[]; filter?: unknown };
      expect(request.resource).toEqual({ kind: 'collection', id: 'alpha' });
      expect(request.facets.length).toBeLessThanOrEqual(8);
      expect(request.filter).toBeUndefined();
    }
    expect(ui.host.textContent).toContain(m.saved_filter_review_value_labels_refused());
    for (const id of ids) expect(ui.host.textContent).toContain(id);

    const edit = [...ui.host.querySelectorAll('a')].find((link) => link.textContent?.trim() === m.library_rule_edit());
    expect(edit?.getAttribute('href')).toBe('/en/collections/alpha/rule');
    expect(edit?.getAttribute('href')).not.toContain('exact-value');
    await ui.click(m.saved_filter_review_return());
    expect(ui.host.textContent).toContain(m.saved_filter_review_returned());
    expect(ui.host.textContent).not.toContain('exact-value-0');
  } finally {
    await ui.unmount();
  }
});

test('a replaced owner reading retires its pending private response', async () => {
  const pending = deferred<SavedFilterReviewPage>();
  const ui = await mount({ read: () => pending.promise });
  try {
    await ui.click(m.saved_filter_review_open());
    expect(ui.host.textContent).toContain(m.saved_filter_review_loading());
    await ui.render({
      scope: { id: 'alpha', title: 'Other Collection', ownerId: 'bob', viewerId: 'bob' },
      authority: owner('bob', 2),
    });
    await act(async () => pending.resolve(page));
    expect(ui.host.textContent).not.toContain('accepted-digest');
    expect(ui.host.textContent).not.toContain('exact-value-0');
  } finally {
    await ui.unmount();
  }
});
