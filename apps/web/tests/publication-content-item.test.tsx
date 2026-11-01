import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import type { PublicationInput, PublicationPage, PublicationResult } from '../src/library/collection-publication';

// UNRUN: composed shared-item assertions for integration. Controlled submit results are not native proof.
test('Publication uses shared candidate items while preserving exact selected IDs independent controls and uncertain submission', async () => {
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
  const { subjectHref } = await import('../src/subject/subject-href');
  const { m } = await import('../src/paraglide/messages.js');
  const { getLocale, overwriteGetLocale } = await import('../src/paraglide/runtime.js');
  const previousLocale = getLocale;
  overwriteGetLocale(() => 'en');
  if (publicationExample.source.state !== 'ready') throw new Error('Expected recorded publication candidates');
  const source = publicationExample.source;
  const first = source.page.members[0]!;
  const second = source.page.members[1]!;
  const members: typeof source.page.members = [
    {
      ...first,
      subjectId: 'original-before-canonicalization',
      subject: { ...first.subject!, label: { value: '雪国', language: 'ja' }, typeLabel: 'Book' },
      facts: {
        'schema:datePublished': [{ kind: 'time', year: 1935 }],
        'schema:author': [{ kind: 'item', id: 'kawabata', labels: { ja: '川端康成' } }],
        'schema:isbn': [{ kind: 'code', value: 'UNSELECTED-FACT' }],
      },
    },
    second,
  ];
  const page: PublicationPage = {
    ...publicationExample,
    source: {
      ...source,
      page: {
        ...source.page,
        members,
        listPresentations: {
          'schema:Book': { imageAspect: 'portrait', keyFacts: ['schema:author', 'schema:datePublished'] },
        },
      },
    },
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const calls: { input: PublicationInput; resolve: (result: PublicationResult) => void }[] = [];
  const submit = (input: PublicationInput) =>
    new Promise<PublicationResult>((resolve) => calls.push({ input, resolve }));
  const render = (value: PublicationPage) =>
    act(async () => root.render(<CollectionPublicationPageView page={value} submit={submit} />));
  const click = (node: HTMLElement) => act(async () => node.click());
  const checkboxes = () => [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
  const button = (label: string) => {
    const node = [...host.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent === label);
    expect(node).toBeDefined();
    return node!;
  };
  const navigations: string[] = [];
  host.addEventListener('click', (event) => {
    const anchor = (event.target as Element).closest('a');
    if (anchor) {
      event.preventDefault();
      navigations.push(anchor.getAttribute('href')!);
    }
  });
  try {
    await render(page);
    const selection = host.querySelector('section[aria-labelledby="publication-selection"]')!;
    expect(selection.querySelector('h2')?.textContent).toBe(m.library_publication_choose());
    const rows = [...selection.querySelectorAll<HTMLLIElement>('ul > li')];
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.querySelector('h3')?.textContent)).toEqual(['雪国', 'The Tale of Genji']);
    const heading = rows[0]!.querySelector('h3')!;
    expect(heading.getAttribute('lang')).toBe('ja');
    const link = rows[0]!.querySelector<HTMLAnchorElement>('a')!;
    const href = subjectHref({ id: first.subject!.id, label: '雪国' }, 'en').href;
    expect(link.getAttribute('href')).toBe(href);
    expect(link.getAttribute('aria-labelledby')).toBe(heading.id);
    expect(rows[0]!.querySelectorAll('a')).toHaveLength(1);
    expect(link.querySelector('input, button, a')).toBeNull();
    const metadata = rows[0]!.querySelector('[data-content-item-slot="metadata"]')!;
    expect([...metadata.querySelectorAll('p')].map((node) => node.textContent)).toEqual([
      'Book',
      '川端康成 ·\u00a01935',
    ]);
    expect(metadata.querySelector('[lang="ja"]')?.textContent).toBe('川端康成');
    expect(host.textContent).not.toContain('UNSELECTED-FACT');
    const checkbox = rows[0]!.querySelector<HTMLInputElement>('input')!;
    expect(checkbox.closest('[data-content-item-slot="trailing"]')).not.toBeNull();
    expect(checkbox.closest('a')).toBeNull();
    expect(checkbox.getAttribute('aria-label')).toBe(m.library_publication_select({ title: '雪国' }));

    // Navigation and selection have separate focus targets and activation paths.
    link.focus();
    await click(link);
    expect(navigations).toEqual([href]);
    expect(checkbox.checked).toBe(false);
    checkbox.focus();
    expect(document.activeElement).toBe(checkbox);
    await click(checkboxes()[1]!);
    await click(checkbox);
    expect(
      checkboxes()
        .slice(0, 2)
        .every((node) => node.checked),
    ).toBe(true);
    expect(navigations).toEqual([href]);
    expect(calls).toHaveLength(0);
    expect(button(m.library_publication_publish()).disabled).toBe(true);
    await click(checkboxes().at(-1)!);
    await click(button(m.library_publication_publish()));
    expect(calls).toHaveLength(1);
    const captured = structuredClone(calls[0]!.input);
    expect(captured).toEqual({
      collectionId: page.address.id,
      revision: source.revision,
      subjectIds: [second.subject!.id, first.subject!.id],
      idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/i),
    });
    await act(async () => calls[0]!.resolve({ ok: false, reason: 'unknown' }));
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(m.library_publication_unknown());
    expect(host.textContent).not.toContain(m.library_publication_complete({ count: '2' }));

    await render({
      ...page,
      source: {
        ...source,
        revision: 20,
        page: { ...source.page, revision: 20, members: source.page.members.slice(2) },
      },
    });
    expect([...host.querySelectorAll('h3')].map((node) => node.textContent)).toEqual(['The Little Prince', 'Kokoro']);
    expect(checkboxes().every((node) => node.disabled)).toBe(true);
    expect(calls).toHaveLength(1);
    await click(button(m.library_publication_retry()));
    expect(calls).toHaveLength(2);
    expect(calls[1]!.input).toBe(calls[0]!.input);
    expect(calls[1]!.input).toEqual(captured);
    await act(async () =>
      calls[1]!.resolve({
        ok: true,
        collection: { id: captured.collectionId, revision: captured.revision + 1 },
        publication: { generation: 'controlled-complete', state: 'complete', itemCount: 2 },
      }),
    );
    expect(host.textContent).toContain(m.library_publication_complete({ count: '2' }));
    expect(
      checkboxes()
        .slice(0, 2)
        .every((node) => !node.checked),
    ).toBe(true);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    overwriteGetLocale(previousLocale);
    mock.restore();
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
