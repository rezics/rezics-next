import { expect, test } from 'bun:test';
import { act, createElement, useState } from 'react';
import {
  identityBinding,
  identityIntentKey,
  type IdentityIntakeInput,
  type IdentityIntakePage,
} from '../src/features/catalogue/identity-intake';
import type { readIdentityIntake } from '../src/features/catalogue/identity-intake';

test('current intent replaces late matches and offers only deliberate navigation or continuation', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.test/en/catalogue/new' });
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
    ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

  const { createRoot } = await import('react-dom/client');
  const testing = require(require.resolve('storybook/test'));
  const { within, waitFor } = await import(testing.resolve('@testing-library/dom'));
  const { default: userEvent } = await import(testing.resolve('@testing-library/user-event'));
  const { IdentityIntakePanel } = await import('../src/features/catalogue/identity-intake-view');
  const { m } = await import('../src/paraglide/messages.js');
  const { getLocale, setLocale } = await import('../src/paraglide/runtime');
  const oldLocale = getLocale();
  setLocale('en', { reload: false });

  const initial: IdentityIntakeInput = {
    q: 'older query',
    language: 'en',
    typeId: 'schema:Book',
    releaseDigest: 'release-1',
    locale: 'en',
  };
  const current = { ...initial, q: 'current query' };
  const resultId = '65f28bc6-dc49-4a5b-bb3c-b5b116739aaf';
  const resultPage = (input: IdentityIntakeInput, generation: number): IdentityIntakePage => ({
    binding: identityBinding(input, generation),
    status: 'ready',
    viewer: { state: 'signed-in' },
    actions: {
      openExisting: true,
      continueWithResults: true,
      continueUnverified: false,
      retry: false,
      createAuthority: 'unknown',
    },
    results: [
      {
        id: resultId,
        type: 'schema:Book',
        typeLabel: 'Book',
        labels: [
          { language: 'en', value: 'Known Book' },
          { language: 'ja', value: '既知の本' },
        ],
        summary: { label: { language: 'en', value: 'A novel.' }, creativeWork: true, types: ['schema:Book'] },
      },
    ],
  });
  let resolveOld!: (page: IdentityIntakePage) => void;
  let calls = 0;
  const read: typeof readIdentityIntake = (input, generation) => {
    calls++;
    if (calls === 1) return new Promise((resolve) => (resolveOld = resolve));
    if (calls === 3)
      return Promise.resolve({
        ...resultPage(input, generation),
        status: 'unavailable',
        actions: {
          openExisting: false,
          continueWithResults: false,
          continueUnverified: true,
          retry: true,
          createAuthority: 'unknown',
        },
        results: [],
      });
    return Promise.resolve(resultPage(input, generation));
  };
  let updateIntent!: (input: IdentityIntakeInput) => void;
  const continues: { key: string; unverified: boolean }[] = [];
  const host = window.document.createElement('main') as unknown as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const user = userEvent.setup({ document: window.document, delay: null });
  function Harness() {
    const [intent, setIntent] = useState(initial);
    const [version, setVersion] = useState(0);
    updateIntent = (next) => {
      setIntent(next);
      setVersion((value) => value + 1);
    };
    return createElement(
      'div',
      {},
      createElement(IdentityIntakePanel, {
        locale: 'en',
        intent,
        version,
        viewerKey: 'alice',
        viewerState: 'signed-in',
        hasType: true,
        typeLabel: 'Book',
        typeCurrent: true,
        disabled: false,
        confirmed: false,
        confirmedUnverified: false,
        onContinue: (key, unverified) => continues.push({ key, unverified }),
        onClear: () => {},
        onRefreshType: () => {},
        inputId: 'intake-query',
        read,
      }),
      createElement('input', { id: 'intake-query' }),
      createElement('button', { id: 'create-subject-submit' }, 'Create'),
    );
  }
  const canvas = () => within(host);
  const render = async () => act(async () => root.render(createElement(Harness)));

  try {
    await render();
    await act(async () => user.click(canvas().getByRole('button', { name: m.identity_intake_search() })));
    await act(async () => updateIntent(current));
    await act(async () => resolveOld(resultPage(initial, 1)));
    await waitFor(() => expect(canvas().queryByRole('heading', { name: 'Known Book' })).toBeNull());

    await act(async () => user.click(canvas().getByRole('button', { name: m.identity_intake_search() })));
    await canvas().findByRole('heading', { name: 'Known Book' });
    const link = canvas().getByRole('link', { name: new RegExp(m.identity_intake_open()) });
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('href')).toContain(resultId);
    expect(canvas().getByText('既知の本')).toBeDefined();

    await act(async () => user.click(canvas().getByRole('button', { name: m.identity_intake_continue() })));
    expect(continues).toEqual([{ key: identityIntentKey(current, 1, 'alice'), unverified: false }]);

    await act(async () => user.click(canvas().getByRole('button', { name: m.identity_intake_return() })));
    expect(window.document.activeElement?.id).toBe('intake-query');
    await act(async () => user.click(canvas().getByRole('button', { name: m.identity_intake_search() })));
    await canvas().findByRole('alert');
    expect(canvas().getByRole('alert')).toHaveTextContent(m.identity_intake_unavailable());
    expect(canvas().queryByText(m.identity_intake_empty())).toBeNull();
    await act(async () => user.click(canvas().getByRole('button', { name: m.identity_intake_unverified() })));
    expect(continues[1]).toEqual({ key: identityIntentKey(current, 1, 'alice'), unverified: true });
  } finally {
    await act(async () => root.unmount());
    window.close();
    setLocale(oldLocale, { reload: false });
    for (const [key, descriptor] of saved)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
  }
});
