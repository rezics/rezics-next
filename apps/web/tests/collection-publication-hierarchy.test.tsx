import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import type { PublicationInput, PublicationPage, PublicationResult } from '../src/library/collection-publication';

// UNRUN: supplied-data rendering and controlled command outcomes for controller integration.
// These cases establish neither native publication nor phone/browser layout evidence.
async function mount(locale: 'en' | 'de' = 'en') {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/collections/publication-example/publish' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    Document: window.Document,
    DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  mock.module('cloudflare:workers', () => ({ env: {} }));
  mock.module('@tanstack/react-start', () => import('../.storybook/react-start'));
  mock.module('@tanstack/react-start/server', () => import('../.storybook/react-start'));
  const { createRoot } = await import('react-dom/client');
  const { CollectionPublicationPageView } = await import('../src/library/collection-publication-page');
  const { publicationExample } = await import('../src/kernel/fake/collection-publication');
  const { m } = await import('../src/paraglide/messages.js');
  const { getLocale, overwriteGetLocale } = await import('../src/paraglide/runtime.js');
  const previousLocale = getLocale;
  overwriteGetLocale(() => locale);
  if (publicationExample.source.state !== 'ready') throw new Error('Expected recorded publication candidates');
  const source = publicationExample.source;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const calls: { input: PublicationInput; resolve: (result: PublicationResult) => void }[] = [];
  let reloads = 0;
  const submit = (input: PublicationInput) =>
    new Promise<PublicationResult>((resolve) => calls.push({ input, resolve }));
  const render = (page: PublicationPage = publicationExample) =>
    act(async () =>
      root.render(<CollectionPublicationPageView page={page} submit={submit} onReload={() => reloads++} />),
    );
  const click = (node: HTMLElement) => act(async () => node.click());
  const button = (label: string) => {
    const node = [...host.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent === label);
    expect(node).toBeDefined();
    return node!;
  };
  const confirmation = () => host.querySelector<HTMLInputElement>('[data-publication-confirmation] input')!;
  const selection = () => [...host.querySelectorAll<HTMLInputElement>('ul input[type="checkbox"]')];
  const decision = () => host.querySelector<HTMLElement>('[data-publication-confirmation]')!;
  const output = () => host.querySelector(`section[aria-label="${m.library_publication_output()}"]`);
  const settle = (index: number, outcome: PublicationResult) => act(async () => calls[index]!.resolve(outcome));
  return {
    window,
    host,
    m,
    source,
    page: publicationExample,
    calls,
    render,
    click,
    button,
    confirmation,
    selection,
    decision,
    output,
    settle,
    reloads: () => reloads,
    async close() {
      await act(async () => root.unmount());
      host.remove();
      overwriteGetLocale(previousLocale);
      mock.restore();
      await window.happyDOM.close();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

for (const locale of ['en', 'de'] as const) {
  test(`Publication selection and visible consequences precede optional native details with ${locale === 'en' ? 'normal' : 'phone-length'} copy`, async () => {
    const h = await mount(locale);
    try {
      const title =
        locale === 'en'
          ? h.source.page.title
          : 'Meine ausgewählten Bücher für die nächste gemeinsame Leserunde und weitere Empfehlungen';
      const first = h.source.page.members[0]!;
      const itemTitle =
        locale === 'en'
          ? typeof first.subject!.label === 'string'
            ? first.subject!.label
            : first.subject!.label.value
          : 'Eine ausführliche Empfehlung mit einem besonders langen Titel für die gemeinsame Leserunde';
      await h.render({
        ...h.page,
        source: {
          ...h.source,
          page: {
            ...h.source.page,
            title,
            members: [
              { ...first, subject: { ...first.subject!, label: itemTitle } },
              ...h.source.page.members.slice(1),
            ],
          },
        },
      });
      const { host, m } = h;
      expect(host.querySelector('header')!.textContent).toContain(title);
      expect(host.querySelector('h3')!.textContent).toBe(itemTitle);
      expect(h.selection()[0]!.getAttribute('aria-label')).toBe(m.library_publication_select({ title: itemTitle }));
      expect(h.output()).toBeNull();
      expect(host.querySelector('header p')!.compareDocumentPosition(host.querySelector('ul')!) & 4).toBeTruthy();
      const group = h.decision();
      expect(host.querySelector('ul')!.compareDocumentPosition(group) & 4).toBeTruthy();
      await h.click(h.selection()[0]!);
      expect(group.querySelector('[role="status"]')!.textContent).toBe(m.library_publication_count_one({ count: '1' }));
      for (const text of [
        m.library_publication_page_only(),
        m.library_publication_previous(),
        m.library_publication_privacy(),
      ]) {
        expect(group.textContent).toContain(text);
      }
      const button = h.button(m.library_publication_publish());
      expect(group.contains(button)).toBe(true);
      for (const control of [button, h.confirmation()]) {
        for (const id of control.getAttribute('aria-describedby')!.split(' ')) {
          const consequence = host.querySelector(`#${id}`)!;
          expect(group.contains(consequence)).toBe(true);
          expect(consequence.closest('details')).toBeNull();
        }
      }
      const details = host.querySelector<HTMLDetailsElement>('details')!;
      expect(details.open).toBe(false);
      expect(group.compareDocumentPosition(details) & 4).toBeTruthy();
      const summary = details.querySelector('summary')!;
      expect(summary.textContent).toBe(m.library_publication_details());
      expect(details.textContent).toContain(m.library_publication_description());
      expect(details.textContent).toContain(m.library_publication_canonical());
      expect(group.textContent).not.toContain(m.library_publication_canonical());
      // The browser supplies keyboard disclosure semantics for this summary/details pair.
      expect(summary.parentElement).toBe(details);
      expect(summary.getAttribute('role')).toBeNull();
      await h.click(summary);
      expect(details.open).toBe(true);
      expect(h.selection()[0]!.checked).toBe(true);
      expect(h.calls).toHaveLength(0);
    } finally {
      await h.close();
    }
  });
}

test('Deliberate empty replacement stays explicit beside confirmation and output appears only on completion', async () => {
  const h = await mount();
  try {
    await h.render({ ...h.page, source: { ...h.source, page: { ...h.source.page, members: [], next: null } } });
    const { m } = h;
    expect(h.host.textContent).toContain(m.library_publication_no_disclosed());
    expect(h.decision().textContent).toContain(m.library_publication_count({ count: '0' }));
    expect(h.confirmation().closest('label')!.textContent).toBe(m.library_publication_confirm_empty());
    expect(h.confirmation().closest('details')).toBeNull();
    expect(h.button(m.library_publication_publish()).disabled).toBe(true);
    await h.click(h.confirmation());
    await h.click(h.button(m.library_publication_publish()));
    expect(h.calls[0]!.input.subjectIds).toEqual([]);
    expect(h.decision().textContent).toContain(m.library_publication_pending());
    expect(h.output()).toBeNull();
    await h.settle(0, {
      ok: true,
      collection: { id: h.page.address.id, revision: 8 },
      publication: { generation: 'controlled-empty-complete', state: 'complete', itemCount: 0 },
    });
    expect(h.output()!.querySelector('[role="status"]')!.textContent).toBe(
      m.library_publication_complete({ count: '0' }),
    );
    expect(h.output()!.querySelector('a')!.getAttribute('href')).toBe('/en/collections/publication-example');
    expect(h.decision().compareDocumentPosition(h.output()!) & 4).toBeTruthy();
    expect(h.confirmation().checked).toBe(false);
    expect(h.host.textContent).not.toContain(m.library_publication_pending());
    // Another pending or refused request cannot erase the completed output.
    await h.click(h.confirmation());
    await h.click(h.button(m.library_publication_publish()));
    expect(h.output()!.textContent).toContain(m.library_publication_complete({ count: '0' }));
    await h.settle(1, { ok: false, reason: 'stale' });
    expect(h.decision().querySelector('[role="alert"]')!.textContent).toBe(m.library_publication_stale());
    expect(h.output()!.textContent).toContain(m.library_publication_complete({ count: '0' }));
  } finally {
    await h.close();
  }
});

test('Unknown original-intent recovery remains local and retries exact revision IDs and key after candidates disappear', async () => {
  const h = await mount();
  try {
    await h.render();
    const { m } = h;
    await h.click(h.selection()[0]!);
    await h.click(h.confirmation());
    const review = h.host.querySelector('[data-publication-review]')!.textContent;
    await h.click(h.button(m.library_publication_publish()));
    const original = structuredClone(h.calls[0]!.input);
    await h.settle(0, { ok: false, reason: 'unknown' });
    expect(h.decision().querySelector('[role="alert"]')!.textContent).toBe(m.library_publication_unknown());
    expect(h.decision().querySelector('[role="alert"]')!.closest('details')).toBeNull();
    expect(h.host.querySelector(`a[href*="cursor="]`)).toBeNull();
    expect(h.output()).toBeNull();
    await h.render({ ...h.page, source: { state: 'unavailable' } });
    expect(h.host.textContent).toContain(m.library_publication_unknown());
    expect(h.host.querySelector('[data-publication-review]')!.textContent).toBe(review);
    await h.click(h.button(m.library_collection_reload()));
    expect(h.reloads()).toBe(1);
    await h.render({
      ...h.page,
      source: { ...h.source, revision: 20, page: { ...h.source.page, revision: 20, members: [] } },
    });
    expect(h.decision().textContent).toContain(m.library_publication_count_one({ count: '1' }));
    expect(h.decision().textContent).not.toContain(m.library_publication_confirm_empty());
    expect(h.confirmation().disabled).toBe(true);
    expect(h.confirmation().checked).toBe(true);
    await h.click(h.button(m.library_publication_retry()));
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]!.input).toBe(h.calls[0]!.input);
    expect(h.calls[1]!.input).toEqual(original);
    expect(h.decision().textContent).toContain(m.library_publication_unknown());
    expect(h.decision().textContent).toContain(m.library_publication_pending());
    for (const reason of ['denied', 'stale', 'unavailable', 'closed'] as const) {
      await h.settle(h.calls.length - 1, { ok: false, reason });
      expect(h.decision().querySelector('[role="alert"]')!.textContent).toBe(m.library_publication_unknown());
      expect(h.confirmation().disabled).toBe(true);
      expect(h.output()).toBeNull();
      expect(h.host.querySelector('[data-publication-review]')!.textContent).toBe(review);
      await h.render({ ...h.page, source: { state: 'unavailable' } });
      await h.click(h.button(m.library_collection_reload()));
      await h.render({ ...h.page, source: { ...h.source, revision: 20, page: { ...h.source.page, members: [] } } });
      expect(h.confirmation().checked).toBe(true);
      await h.click(h.button(m.library_publication_retry()));
      expect(h.calls.at(-1)!.input).toEqual(original);
    }
    await h.settle(h.calls.length - 1, {
      ok: true,
      collection: { id: original.collectionId, revision: original.revision + 1 },
      publication: { generation: 'recovered', state: 'complete', itemCount: original.subjectIds.length },
    });
    expect(h.confirmation().checked).toBe(false);
    expect(h.host.textContent).not.toContain(m.library_publication_unknown());
    expect(h.output()).not.toBeNull();
  } finally {
    await h.close();
  }
});

test('Selection is bounded to disclosed current-page canonical IDs and changing the cursor clears confirmation', async () => {
  const h = await mount();
  try {
    const member = h.source.page.members[0]!;
    const members = Array.from({ length: 101 }, (_, index) => ({
      ...member,
      subjectId: `original-${index}`,
      subject: { ...member.subject!, id: `canonical-${index}`, label: `Item ${index}` },
    }));
    const page: PublicationPage = {
      ...h.page,
      source: {
        ...h.source,
        page: { ...h.source.page, members: [...members, members[0]!, { subjectId: 'undisclosed', subject: null }] },
      },
    };
    await h.render(page);
    expect(h.selection()).toHaveLength(101);
    for (const checkbox of h.selection().slice(0, 100)) await h.click(checkbox);
    expect(h.selection()[100]!.disabled).toBe(true);
    expect(h.decision().textContent).toContain(h.m.library_publication_count({ count: '100' }));
    await h.click(h.confirmation());
    const next = h.host.querySelector<HTMLAnchorElement>('a[href*="cursor="]')!;
    expect(next.getAttribute('href')).toBe('/en/collections/publication-example/publish?cursor=another-native-page');
    await h.render({ ...page, address: { ...page.address, cursor: 'another-native-page' } });
    expect(h.selection().every((checkbox) => !checkbox.checked && !checkbox.disabled)).toBe(true);
    expect(h.confirmation().checked).toBe(false);
    expect(h.button(h.m.library_publication_publish()).disabled).toBe(true);
    expect(h.calls).toHaveLength(0);
  } finally {
    await h.close();
  }
});
