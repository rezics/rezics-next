import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { QueryClient } from '@tanstack/react-query';
import { act, createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { OwnedCollection } from '../src/settings/preferences';
import { CollectionPrivacyEditor } from '../src/settings/collection-privacy-recovery';
import { m } from '../src/paraglide/messages.js';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/settings' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLButtonElement: window.HTMLButtonElement,
  Element: window.Element,
  Node: window.Node,
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
const { createRoot } = await import('react-dom/client');

mock.module('../src/kernel/exposure', () => ({ useOperation: () => true }));
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('../src/session/query', () => ({
  sessionQuery: { queryKey: ['session'] },
  exposureQuery: { queryKey: ['exposure'] },
  sessionCsrfToken: () => 'test-token',
  useSession: () => ({ state: 'signed-in', csrfToken: 'test-token' }),
}));
const { CollectionRow, CollectionPrivacyView } = await import('../src/settings/collection-privacy');
const { SettingsSessionOwner } = await import('../src/settings/settings-session-owner');

afterAll(async () => {
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

async function mounted(content: ReactNode, run: (host: HTMLDivElement) => Promise<void> | void) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(content);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await run(host);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
}

const privateCurated: OwnedCollection = {
  id: 'private-curated',
  title: 'Private reading',
  kind: 'curated',
  membershipKind: 'curated',
  visibility: 'private',
  revision: 7,
  allowedVisibilityActions: ['unlisted'],
};
const builtin: OwnedCollection = {
  id: 'builtin-everything',
  title: 'Everything',
  kind: 'builtin',
  membershipKind: 'dynamic',
  builtinKind: 'everything',
  builtin: { kind: 'everything' },
  visibility: 'private',
  revision: null,
  allowedVisibilityActions: [],
};
const io = {
  save: async () => ({ ok: false as const, reason: 'unavailable' as const }),
  read: async () => ({ ok: false as const, reason: 'unavailable' as const }),
};

function markup(collection: OwnedCollection) {
  return renderToStaticMarkup(createElement(CollectionRow, { collection, io }));
}

test('visibility options follow native advice and logical built-ins remain read-only', () => {
  const curated = markup(privateCurated);
  expect(curated).toMatch(/<option[^>]*value="private" selected="">/);
  expect(curated).toMatch(/<option[^>]*value="unlisted">/);
  expect(curated).not.toMatch(/<option[^>]*value="public">/);

  const logical = markup(builtin);
  expect(logical).toContain('disabled=""');
  expect(logical).toMatch(/<option[^>]*value="private" selected="">/);
  expect(logical).not.toMatch(/<option[^>]*value="unlisted">/);
  expect(logical).not.toMatch(/<option[^>]*value="public">/);
});

test('current owner advice remains usable when the retry target already matches', () => {
  const current = {
    ...privateCurated,
    visibility: 'public' as const,
    allowedVisibilityActions: ['private', 'unlisted'] as const,
  };
  const editor = new CollectionPrivacyEditor(current, io);
  expect(editor.hasCurrentUpdateAdvice()).toBe(true);
  editor.receive({ ...current, allowedVisibilityActions: [] });
  expect(editor.hasCurrentUpdateAdvice()).toBe(false);
  editor.dispose();
});

test('a retired viewer cannot restore its old credential after A to B to A', () => {
  const client = new QueryClient();
  const queryKey = ['session'];
  const accountA = { state: 'signed-in', subject: 'account-a', csrfToken: 'test-token' };
  client.setQueryData(queryKey, accountA);
  const owner = new SettingsSessionOwner(client, 'test-token', 'account-a');
  expect(owner.credential()).toBe('test-token');

  client.setQueryData(queryKey, { state: 'signed-in', subject: 'account-b', csrfToken: 'other-token' });
  expect(owner.credential()).toBeNull();
  client.setQueryData(queryKey, accountA);
  expect(owner.credential()).toBeNull();
  client.clear();
});

test('review keeps a retained unsupported visibility labelled and offers Use current', async () => {
  const current = {
    ...privateCurated,
    visibility: 'public' as const,
    allowedVisibilityActions: ['private'] as const,
  };
  await mounted(
    createElement(CollectionRow, {
      collection: privateCurated,
      io: {
        save: async () => ({ ok: false as const, reason: 'conflict' as const }),
        read: async () => ({ ok: true as const, value: current }),
      },
    }),
    async (host) => {
      await act(async () => {
        const select = host.querySelector('select')!;
        select.value = 'unlisted';
        select.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await act(async () => {
        [...host.querySelectorAll('button')]
          .find((button) => button.textContent?.trim() === m.settings_privacy_reload_row())!
          .click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      const select = host.querySelector('select');
      expect(select?.value).toBe('unlisted');
      expect([...select!.querySelectorAll('option')].some((option) => option.value === 'unlisted')).toBe(true);
      expect(
        [...host.querySelectorAll('button')].find(
          (button) => button.textContent?.trim() === m.settings_privacy_save_choice(),
        )?.disabled,
      ).toBe(true);
      expect(
        [...host.querySelectorAll('button')].some(
          (button) => button.textContent?.trim() === m.settings_privacy_use_current(),
        ),
      ).toBe(true);
    },
  );
});

test('both rendered list recovery controls honor a failed continuation wait', async () => {
  const reads: (string | null)[] = [];
  await mounted(
    createElement(CollectionPrivacyView, {
      io,
      read: async (cursor) => {
        reads.push(cursor);
        return reads.length === 1
          ? { ok: true, value: { collections: [privateCurated], next: 'next' } }
          : { ok: false, reason: 'unavailable', failure: { status: 503, retryAfter: '60' } };
      },
    }),
    async (host) => {
      const button = (name: string) =>
        [...host.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === name);
      await act(async () => {
        button(m.settings_privacy_load_more())!.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(reads).toEqual([null, 'next']);
      expect(button(m.settings_retry())?.disabled).toBe(true);
      expect(button(m.settings_privacy_refresh_list())?.disabled).toBe(true);
    },
  );
});
