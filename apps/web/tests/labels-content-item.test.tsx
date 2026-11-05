import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import { renderToString } from 'react-dom/server';
import type { LabelsPage } from '../src/library/labels-read';
import { m } from '../src/paraglide/messages.js';

// UNRUN: composed assertions over the installed family; browser/native/visual proof remains deferred.
const unexpectedIO = () => {
  throw new Error('Label presentation must use the supplied page');
};
mock.module('../src/library/labels-actions', () => ({ manageLabel: unexpectedIO }));
mock.module('../src/library/labels-read-route', () => ({ readLabelsPage: unexpectedIO }));
afterAll(() => mock.restore());

test('Shared label items preserve shelf navigation progressive phone forms and independent hydrated controls', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/fr/library/labels', width: 390, height: 844 });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLButtonElement: window.HTMLButtonElement,
    Element: window.Element,
    Node: window.Node,
    NodeFilter: window.NodeFilter,
    Document: window.Document,
    ShadowRoot: window.ShadowRoot,
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
  const { LabelsPageView } = await import('../src/library/labels-page');
  const { hydrateRoot } = await import('react-dom/client');
  const label = {
    id: '00000000-0000-4000-8000-000000000001',
    name: '<Travel> & 旅行',
    revision: 9,
    renameKey: '00000000-0000-4000-8000-000000000002',
    deleteKey: '00000000-0000-4000-8000-000000000003',
  };
  const page: LabelsPage = {
    signedIn: true,
    state: 'loaded',
    operations: ['library_label.list', 'library_label.create', 'library_label.rename', 'library_label.delete'],
    csrfToken: 'rendered-csrf',
    createKey: '00000000-0000-4000-8000-000000000004',
    undoKey: '00000000-0000-4000-8000-000000000005',
    labels: [label],
    next: null,
  };
  const host = window.document.createElement('div');
  window.document.body.append(host);
  let root: ReturnType<typeof hydrateRoot> | undefined;
  try {
    host.innerHTML = renderToString(<LabelsPageView page={page} locale="fr" />);
    const row = host.querySelector('ul > li[data-slot="list-row"]')!;
    const heading = row.querySelector('h2[data-content-item-slot="title"]')!;
    const primary = row.querySelector('a[data-library-label-link]')!;
    expect(heading.textContent).toBe(label.name);
    expect(heading.closest('[aria-hidden="true"], .sr-only')).toBeNull();
    expect(primary.getAttribute('href')).toBe(`/fr/library?label=${label.id}`);
    expect(heading.querySelector('a')).toBe(primary);
    expect(primary.textContent).toBe(label.name);
    expect(primary.querySelector('.sr-only')).toBeNull();
    expect(row.querySelectorAll('[data-library-label-link]')).toHaveLength(1);
    expect(primary.querySelector('form, button, input, summary, a')).toBeNull();
    expect(
      row.querySelector('li, img, [data-content-item-slot="metadata"], [data-content-item-slot="preview"]'),
    ).toBeNull();

    const controls = [...row.querySelectorAll('[data-slot="list-row-control"]')];
    expect(controls).toHaveLength(2);
    expect(row.querySelectorAll('form')).toHaveLength(2);
    for (const [index, operation] of (['rename', 'delete'] as const).entries()) {
      const control = controls[index]!;
      const form = control.querySelector('form')!;
      const fields = Object.fromEntries([...form.querySelectorAll('input')].map((input) => [input.name, input.value]));
      expect(fields).toMatchObject({
        operation,
        id: label.id,
        name: label.name,
        library_label_revision: String(label.revision),
        csrf_token: page.csrfToken,
        idempotencyKey: operation === 'rename' ? label.renameKey : label.deleteKey,
      });
      expect([form.getAttribute('method'), form.getAttribute('action')]).toEqual(['post', '/fr/library/labels']);
      expect(control.classList.contains('relative') && control.classList.contains('z-10')).toBe(true);
      expect(control.classList.contains('has-[details[open]]:basis-full')).toBe(true);
      expect(control.querySelector('details')?.classList.contains('open:basis-full')).toBe(true);
      for (const action of control.querySelectorAll('summary, button, a'))
        expect(
          [
            'h-auto',
            'min-h-11',
            'min-w-11',
            'max-w-full',
            'whitespace-normal',
            '[overflow-wrap:anywhere]',
            'focus-visible:outline-2',
            'focus-visible:outline-offset-2',
            'focus-visible:outline-ring',
          ].every((token) => action.classList.contains(token)),
        ).toBe(true);
    }
    expect(controls[1]!.textContent).toContain(m.library_label_delete_confirmation({ name: label.name }));

    const refused = window.document.createElement('div');
    refused.innerHTML = renderToString(
      <LabelsPageView
        page={{
          ...page,
          feedback: { ok: false, operation: 'rename', id: label.id, name: 'Retained draft', reason: 'conflict' },
        }}
        locale="fr"
      />,
    );
    const retained = refused.querySelector('details[open]')!;
    expect(refused.querySelectorAll('details[open]')).toHaveLength(1);
    expect(retained.querySelector('input[name="name"]')?.getAttribute('value')).toBe('Retained draft');
    expect(retained.querySelector('input[name="name"]')?.getAttribute('aria-describedby')).toBe(
      `rename-error-${label.id}`,
    );
    expect(retained.querySelector('[role="alert"]')).not.toBeNull();

    const hydrationErrors: unknown[] = [];
    await act(async () => {
      root = hydrateRoot(host, <LabelsPageView page={page} locale="fr" />, {
        onRecoverableError: (error) => hydrationErrors.push(error),
      });
    });
    expect(hydrationErrors).toEqual([]);
    const hydratedRow = host.querySelector('ul > li[data-slot="list-row"]')!;
    const trigger = hydratedRow.querySelector('button')!;
    expect(trigger.getAttribute('aria-label')).toBe(m.library_label_actions({ name: label.name }));
    expect(trigger.closest('[data-slot="list-row-control"]')).not.toBeNull();
    expect(trigger.closest('a')).toBeNull();
    expect(trigger.classList.contains('min-h-11') && trigger.classList.contains('min-w-11')).toBe(true);
    expect(trigger.disabled).toBe(false);
    expect(hydratedRow.querySelector('details, form, a button, a input')).toBeNull();
    expect(hydratedRow.querySelector('[data-library-label-link]')?.getAttribute('href')).toBe(
      `/fr/library?label=${label.id}`,
    );
  } finally {
    if (root) await act(async () => root!.unmount());
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await window.happyDOM.close();
  }
});
