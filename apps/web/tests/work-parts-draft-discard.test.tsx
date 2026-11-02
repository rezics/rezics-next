import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act, createElement as h } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

mock.module('cloudflare:workers', () => ({ env: {} }));

test('Work Parts closes only the chosen unsent draft and preserves sealed command recovery', async () => {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.test/en/subjects/book/title' });
  const keys = ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'DocumentFragment', 'MutationObserver', 'ResizeObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'IS_REACT_ACT_ENVIRONMENT'];
  const saved = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of keys)
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: key === 'window' ? window : key === 'IS_REACT_ACT_ENVIRONMENT' ? true : window[key] });
  const { createRoot } = await import('react-dom/client');
  const { setLocale } = await import('../src/paraglide/runtime.js');
  setLocale('en', { reload: false });
  const host = window.document.createElement('main') as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const click = async (name: string, scope: ParentNode = host) => {
    const button = [...scope.querySelectorAll<HTMLButtonElement>('button')].filter((item) => item.textContent?.trim() === name).at(-1)!;
    await act(async () => button.click());
    return button;
  };
  const input = (element: HTMLInputElement, value: string) => act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  const until = async (predicate: () => boolean) => {
    for (let attempt = 0; attempt < 100 && !predicate(); attempt++) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(predicate()).toBe(true);
  };

  try {
    const [{ WorkPartsPage }, { workPartsFixture }, { m }] = await Promise.all([
      import('../src/features/catalogue/work-parts-page'), import('../src/kernel/fake/work-parts'), import('../src/paraglide/messages.js'),
    ]);
    const fixture = workPartsFixture('partial');
    const first = fixture.snapshot();
    if (!first.ok || !first.stream || !first.next) throw new Error('Expected the first native page');
    const next = await fixture.transport.read(first.stream.key, first.next, first.session);
    if (!next.ok) throw new Error('Expected a second native page');
    fixture.setScenario('uncertain');
    const initial = { ...first, rows: [...first.rows, ...next.rows], labels: { ...first.labels, ...next.labels }, next: null };
    await act(async () => root.render(h(QueryClientProvider, { client }, h(WorkPartsPage, {
      id: fixture.id, locale: 'en', initial, search: fixture.search, transport: fixture.transport,
    }))));

    const editors = () => [...host.querySelectorAll<HTMLElement>('section[aria-label]')].filter((item) => item.getAttribute('aria-label') === m.relation_title());
    const rows = [...host.querySelectorAll('ul > li')];
    expect(rows).toHaveLength(2);
    const source = [...rows[0]!.querySelectorAll('button')].find((item) => item.textContent?.trim() === m.work_parts_correct())!;
    for (const row of rows) await click(m.work_parts_correct(), row);
    const [firstEditor, sibling] = editors() as [HTMLElement, HTMLElement];
    for (const editor of [firstEditor, sibling]) {
      await click(m.relation_open(), editor);
      await until(() => !!editor.querySelector('input[id$="qualifier-0"]'));
    }
    const [firstPosition, siblingPosition] = [firstEditor, sibling].map((editor) => editor.querySelector<HTMLInputElement>('input[id$="qualifier-0"]')!);
    const admittedPosition = firstPosition!.value;
    await input(firstPosition!, '41');
    await input(siblingPosition!, '55');

    const close = await click(m.work_parts_draft_close(), firstEditor);
    await click(m.candidate_cancel(), firstEditor);
    expect(firstEditor.textContent).not.toContain(m.work_parts_draft_discard());
    expect(firstEditor.querySelector('input[id$="qualifier-0"]')).toBe(firstPosition);
    expect(firstPosition!.value).toBe('41');
    expect(host.ownerDocument.activeElement).toBe(close);
    await click(m.work_parts_draft_close(), firstEditor);
    await click(m.work_parts_draft_discard(), firstEditor);
    await until(() => editors().length === 1);
    expect(editors()[0]).toBe(sibling);
    expect(siblingPosition!.value).toBe('55');
    expect(host.ownerDocument.activeElement).toBe(source);

    await click(m.work_parts_correct(), rows[0]!);
    await until(() => editors().length === 2);
    const reopened = editors().find((item) => item !== sibling)!;
    expect(reopened).not.toBe(firstEditor);
    await click(m.relation_open(), reopened);
    await until(() => !!reopened.querySelector('input[id$="qualifier-0"]'));
    const freshPosition = reopened.querySelector<HTMLInputElement>('input[id$="qualifier-0"]')!;
    expect(freshPosition.value).toBe(admittedPosition);
    expect(siblingPosition!.value).toBe('55');

    await input(freshPosition, '72');
    await click(m.work_parts_draft_close(), reopened);
    await click(m.relation_propose(), reopened);
    await click(m.relation_propose(), reopened);
    await until(() => reopened.textContent!.includes(m.candidate_unavailable()));
    const discard = [...reopened.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === m.work_parts_draft_discard())!;
    expect(discard.disabled).toBe(true);
    const props = Object.keys(discard).find((key) => key.startsWith('__reactProps$'))!;
    await act(async () => Reflect.get(discard, props).onClick());
    expect(host.contains(reopened)).toBe(true);
    const posts = () => fixture.calls.filter((call) => call.method === 'POST');
    expect(posts()).toHaveLength(1);
    const sealed = posts()[0]!;
    expect(sealed.authorization).toBe('Bearer contributor');
    await click(m.relation_propose(), reopened);
    await until(() => posts().length === 2);
    expect(posts()[1]).toMatchObject({ authorization: sealed.authorization, key: sealed.key, body: sealed.body });
    expect(host.contains(reopened)).toBe(true);
    expect(editors()).toHaveLength(2);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    await window.happyDOM.abort();
    for (const [key, descriptor] of saved) descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key);
  }
});
